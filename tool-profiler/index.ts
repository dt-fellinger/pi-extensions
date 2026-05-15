/**
 * Tool Profiler — Pi extension
 *
 * Profiles every tool call to show which ones drive context growth and model cost.
 * Emits live warnings when a single tool result is unusually expensive, and exposes
 * a /tool-stats command so the user can inspect the full picture at any time.
 *
 * Architecture:
 *  - Event collector  (tool_execution_start, tool_result, message_end)
 *  - Scoring engine   (scorer.ts)
 *  - Storage layer    (storage.ts — cross-session JSON aggregate)
 *  - UI layer         (reporter.ts for /tool-stats, warnings.ts for live alerts)
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { homedir } from "node:os";
import { join } from "node:path";

import { buildRecord, estimateTokens, summarizeArgs } from "./scorer.ts";
import { loadAggregate, mergeRecord, saveAggregate } from "./storage.ts";
import type { StatsFilter } from "./reporter.ts";
import { renderStats } from "./reporter.ts";
import { buildWarning, resetWarningDedup } from "./warnings.ts";
import type { Aggregate, ToolCallRecord, ToolCallStart } from "./types.ts";

// ─── Constants ─────────────────────────────────────────────────────────────

const ENTRY_TYPE = "tool-profiler-record" as const;
const AGGREGATE_PATH = join(homedir(), ".pi", "agent", "extensions", "tool-profiler", "aggregate.json");

// ─── Extension factory ─────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  // In-memory state
  let sessionRecords: ToolCallRecord[] = [];
  let aggregate: Aggregate = { version: 1, byTool: {}, lastUpdated: Date.now() };

  /**
   * Pending starts keyed by toolCallId.
   * Populated in tool_execution_start, consumed in tool_result.
   */
  const pendingStarts = new Map<string, ToolCallStart>();

  /**
   * Records that have been scored but whose cost hasn't been refined yet.
   * Refined when the next assistant message's usage data becomes available.
   */
  let unrefinedIds: string[] = [];

  // ─── Helpers ─────────────────────────────────────────────────────────────

  /** Severities of prior session records for a given tool name (used for repeat-penalty). */
  function priorSeverities(toolName: string): number[] {
    return sessionRecords.filter((r) => r.toolName === toolName).map((r) => r.combinedSeverity);
  }

  /** Find a session record by toolCallId. */
  function findRecord(toolCallId: string): ToolCallRecord | undefined {
    return sessionRecords.find((r) => r.toolCallId === toolCallId);
  }

  /**
   * Rebuild in-memory sessionRecords from the current branch entries.
   * Must use getBranch() (not getEntries()) so dead branches are excluded and
   * tree navigation leaves the state consistent with the active branch.
   */
  function reconstructFromBranch(ctx: { sessionManager: { getBranch(): Array<{ type: string; customType?: string; data?: unknown }> } }): void {
    sessionRecords = [];
    unrefinedIds = [];
    pendingStarts.clear();
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type === "custom" && entry.customType === ENTRY_TYPE && entry.data) {
        sessionRecords.push(entry.data as ToolCallRecord);
      }
    }
  }

  // ─── Session lifecycle ────────────────────────────────────────────────────

  pi.on("session_start", async (_event, ctx) => {
    reconstructFromBranch(ctx);
    resetWarningDedup();
    // Load cross-session aggregate from disk.
    aggregate = await loadAggregate(AGGREGATE_PATH);
  });

  // Rebuild state when the user navigates to a different point in the session tree.
  pi.on("session_tree", async (_event, ctx) => {
    reconstructFromBranch(ctx);
  });

  pi.on("session_shutdown", async () => {
    // Merge this session's records into the aggregate and persist.
    for (const record of sessionRecords) {
      mergeRecord(aggregate, record);
    }
    try {
      await saveAggregate(AGGREGATE_PATH, aggregate);
    } catch (err) {
      // Non-fatal: losing aggregate data is acceptable.
      console.error("[tool-profiler] Failed to save aggregate:", err);
    }
  });

  // ─── Tool execution lifecycle ─────────────────────────────────────────────

  pi.on("tool_execution_start", async (event, ctx) => {
    const usage = ctx.getContextUsage();
    const contextTokensBefore = usage?.tokens ?? 0;
    const contextWindow = usage?.contextWindow ?? 128_000;

    const argsSummary = summarizeArgs(
      event.toolName,
      event.args as Record<string, unknown>,
    );

    pendingStarts.set(event.toolCallId, {
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      timestamp: Date.now(),
      argsSummary,
      contextTokensBefore,
      contextWindow,
    });
  });

  pi.on("tool_result", async (event, ctx) => {
    const start = pendingStarts.get(event.toolCallId);
    if (!start) return; // Should not happen, but guard defensively.
    pendingStarts.delete(event.toolCallId);

    const record = buildRecord(
      start,
      event.content as Array<{ type: string; text?: string }>,
      event.input as Record<string, unknown>,
      priorSeverities(start.toolName),
    );

    sessionRecords.push(record);
    unrefinedIds.push(record.toolCallId);

    // Persist to session entries so state survives /reload.
    pi.appendEntry(ENTRY_TYPE, record);

    // Emit a live warning if this call was expensive.
    if (record.warningLevel !== "normal") {
      const lines = buildWarning(record);
      if (lines) {
        const message = lines.join("\n");
        const level = record.warningLevel === "critical" ? "error" : "warning";
        ctx.ui.notify(message, level);
      }
    }
  });

  // ─── Cost refinement ──────────────────────────────────────────────────────

  pi.on("message_end", async (event) => {
    // Only act on assistant messages that carry usage data.
    const msg = event.message as {
      role: string;
      usage?: { cost?: { total?: number }; inputTokens?: number };
    };
    if (msg.role !== "assistant") return;
    if (!msg.usage?.cost?.total && !msg.usage?.inputTokens) return;
    if (unrefinedIds.length === 0) return;

    // Gather the unrefined records that fed this request.
    const toRefine = unrefinedIds
      .map((id) => findRecord(id))
      .filter((r): r is ToolCallRecord => r !== undefined);

    if (toRefine.length === 0) {
      unrefinedIds = [];
      return;
    }

    // Attribute a share of the input-side cost proportionally by token contribution.
    // Use total cost as a proxy for input-side cost. Exact per-tool billing isn't
    // available, so this is an approximation — sufficient for ranking and diagnostics.
    const totalCost = msg.usage.cost?.total ?? 0;
    const totalTokens = toRefine.reduce((sum, r) => sum + r.estimatedResultTokens, 0);

    if (totalCost > 0 && totalTokens > 0) {
      for (const record of toRefine) {
        const share = record.estimatedResultTokens / totalTokens;
        record.refinedCostEstimate = totalCost * share;
      }
    }

    unrefinedIds = [];
  });

  // ─── /tool-stats command ──────────────────────────────────────────────────

  pi.registerCommand("tool-stats", {
    description: "Show tool call profiling stats. Args: [session|overall|tool <name>]",
    getArgumentCompletions: (prefix: string) => {
      const options = [
        { value: "session", label: "session" },
        { value: "overall", label: "overall" },
        { value: "tool ", label: "tool <name>" },
      ];
      return options.filter((o) => o.value.startsWith(prefix));
    },
    handler: async (args, ctx) => {
      const filter = parseFilter(args?.trim() ?? "");
      const lines = renderStats(sessionRecords, aggregate, filter);
      const text = lines.join("\n");

      if (ctx.hasUI) {
        // In interactive mode, show as a scrollable text overlay.
        await showTextOverlay(text, ctx);
      } else {
        // Non-interactive: write to stdout.
        console.log(text);
      }
    },
  });
}

// ─── Argument parsing ─────────────────────────────────────────────────────

function parseFilter(args: string): StatsFilter {
  if (args === "overall") return "overall";
  if (args.startsWith("tool ")) return { tool: args.slice(5).trim() };
  // "session" and empty both show current-session detail.
  return "session";
}

// ─── Text overlay component ───────────────────────────────────────────────

interface TuiCallbacks {
  done: () => void;
}

/** Simple scrollable text display used in interactive mode. */
class TextOverlay {
  private lines: string[];
  private scrollOffset = 0;
  private cachedWidth?: number;
  private cachedRendered?: string[];

  constructor(text: string) {
    this.lines = text.split("\n");
  }

  handleInput(data: string): void {
    if (data === "\x1b" || data === "q" || data === "Q") {
      // Escape or q — closed by the caller via done().
      return;
    }
    const isDown = data === "\x1b[B" || data === "j";
    const isUp = data === "\x1b[A" || data === "k";
    if (isDown) {
      this.scrollOffset = Math.min(this.scrollOffset + 1, Math.max(0, this.lines.length - 10));
      this.cachedRendered = undefined;
    } else if (isUp) {
      this.scrollOffset = Math.max(0, this.scrollOffset - 1);
      this.cachedRendered = undefined;
    }
  }

  render(width: number): string[] {
    if (this.cachedRendered && this.cachedWidth === width) return this.cachedRendered;

    const visibleHeight = 30;
    const visible = this.lines.slice(this.scrollOffset, this.scrollOffset + visibleHeight);
    const nav = `  ↑/↓ j/k scroll  •  Esc or q to close  (${this.scrollOffset + 1}–${Math.min(this.scrollOffset + visibleHeight, this.lines.length)} / ${this.lines.length})`;

    const out = ["", ...visible.map((l) => (l.length > width ? l.slice(0, width - 1) : l)), "", nav, ""];
    this.cachedWidth = width;
    this.cachedRendered = out;
    return out;
  }

  invalidate(): void {
    this.cachedRendered = undefined;
  }
}

async function showTextOverlay(
  text: string,
  ctx: { hasUI: boolean; ui: { custom: <T>(factory: (tui: unknown, theme: unknown, kb: unknown, done: (v?: T) => void) => TextOverlay) => Promise<T | undefined> } },
): Promise<void> {
  await ctx.ui.custom<void>((_tui, _theme, _kb, done) => {
    const overlay = new TextOverlay(text);
    // Wrap the component so its handleInput can trigger done.
    const wrapped = {
      handleInput(data: string) {
        if (data === "\x1b" || data === "q" || data === "Q") {
          done();
          return;
        }
        overlay.handleInput(data);
      },
      render(width: number) {
        return overlay.render(width);
      },
      invalidate() {
        overlay.invalidate();
      },
    };
    return wrapped as unknown as TextOverlay;
  });
}

/**
 * Query Tree module — wires reconstruction, event handling, and commands.
 *
 * Registered commands:
 *   /inv tree  (alias: /inv t)   — open tree overlay
 *   /inv mark  (alias: /inv m)   — add a manual marker
 *   /inv cleanup                  — remove orphaned cache files
 *
 * Keyboard shortcut: Ctrl+T → queued /inv tree via sendUserMessage.
 */

import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Pull the most recent user message text from the session branch. */
function extractLastUserMessage(ctx: ExtensionContext): string | undefined {
  const branch = ctx.sessionManager.getBranch();
  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i]!;
    if (entry.type !== "message") continue;
    const msg = entry.message;
    if (msg.role !== "user") continue;
    const text = msg.content
      .filter((c: { type: string }) => c.type === "text")
      .map((c: { type: string; text?: string }) => c.text ?? "")
      .join(" ")
      .trim();
    if (text) return text.slice(0, 200);
  }
  return undefined;
}
import { isToolCallEventType, isBashToolResult } from "@earendil-works/pi-coding-agent";
import type {
  InvestigateConfig,
  InvestigateEventBus,
  InvestigationState,
} from "../../core/types.js";
import { addNode, resetState } from "../../core/state.js";
import { resolveCacheDir } from "../../core/config.js";
import { QueryTreeTracker } from "./tracker.js";
import { TreeOverlay } from "./tree-overlay.js";
import { TableViewer } from "./table-viewer.js";
import { cleanupOrphanedCache } from "./result-store.js";

const ENTRY_TYPE = "investigate:query-tree:node";

// ---------------------------------------------------------------------------
// Reconstruction
// ---------------------------------------------------------------------------

interface PersistedNodeEntry {
  schemaVersion: 1;
  nodeId: string;
  parentNodeId: string | null;
  branchHint?: string;
  timestamp: number;
  label: string;
  data: unknown;
}

/**
 * Rebuild the session-global node map from saved session entries.
 * Uses last-write-wins per nodeId.
 */
export function reconstructQueryTree(
  state: InvestigationState,
  ctx: ExtensionContext,
): void {
  state.nodes.clear();

  const entries = ctx.sessionManager.getEntries();
  // last-write-wins: process in order, overwrite with later entries.
  for (const entry of entries) {
    if (entry.type !== "custom") continue;
    if (entry.customType !== ENTRY_TYPE) continue;

    const data = entry.data as PersistedNodeEntry | undefined;
    if (!data || data.schemaVersion !== 1) continue;

    addNode(state, {
      id: data.nodeId,
      sessionEntryId: entry.id,
      module: "query-tree",
      type: (data.data as { nodeType?: string })?.nodeType ?? "dql",
      label: data.label,
      timestamp: data.timestamp,
      parentNodeId: data.parentNodeId,
      branchHint: data.branchHint,
      data: data.data as never,
    });
  }
}

// ---------------------------------------------------------------------------
// Module initializer
// ---------------------------------------------------------------------------

export function initQueryTreeModule(
  pi: ExtensionAPI,
  state: InvestigationState,
  events: InvestigateEventBus,
  config: InvestigateConfig,
): QueryTreeTracker {
  const tracker = new QueryTreeTracker(
    state,
    events,
    config,
    (customType, data) => { pi.appendEntry(customType, data); },
    (nodeId, label, labelState) => {
      // Persist the updated label via a new entry (last-write-wins on reconstruction).
      const existing = state.nodes.get(nodeId);
      if (!existing) return;
      const updated = { ...existing, label, data: { ...existing.data, labelState } };
      state.nodes.set(nodeId, updated as typeof existing);
      pi.appendEntry(ENTRY_TYPE, {
        schemaVersion: 1,
        nodeId,
        parentNodeId: existing.parentNodeId,
        branchHint: existing.branchHint,
        timestamp: existing.timestamp,
        label,
        data: { ...existing.data, labelState },
      });
      events.emit("node:updated", updated as typeof existing);
    },
  );

  // Listen for bash tool calls and results.
  pi.on("tool_call", async (event, ctx) => {
    if (!isToolCallEventType("bash", event)) return;
    const contextHint = extractLastUserMessage(ctx);
    // Resolve the Anthropic API key from pi's own credential store so the
    // label generator works without ANTHROPIC_API_KEY in the environment.
    const apiKey = await ctx.modelRegistry
      .getApiKeyForProvider("anthropic")
      .catch(() => process.env.ANTHROPIC_API_KEY);
    tracker.onToolCall(event.toolCallId, event.input.command ?? "", contextHint, apiKey);
  });

  pi.on("tool_result", async (event) => {
    if (!isBashToolResult(event)) return;
    const stdout = event.content.map((c) => (c.type === "text" ? c.text : "")).join("");
    tracker.onToolResult(event.toolCallId, stdout, event.isError ?? false);
  });

  return tracker;
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

export function registerQueryTreeCommands(
  pi: ExtensionAPI,
  state: InvestigationState,
  events: InvestigateEventBus,
  config: InvestigateConfig,
  tracker: QueryTreeTracker,
): void {
  pi.registerCommand("inv", {
    description: "Investigation workbench — /inv tree | mark | cleanup",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const sub = (args ?? "").trim().split(/\s+/);
      const cmd = sub[0] ?? "";
      const rest = sub.slice(1).join(" ");

      switch (cmd) {
        case "tree":
        case "t":
          await openTreeOverlay(ctx, state, events, config, tracker);
          break;

        case "mark":
        case "m": {
          const label = rest || `marked · ${new Date().toLocaleTimeString()}`;
          const node = tracker.addManualMarker(label);
          if (node) {
            ctx.ui.notify(`Marker added: "${node.label}"`, "info");
          }
          break;
        }

        case "cleanup": {
          const knownIds = new Set(state.nodes.keys());
          const cacheDir = resolveCacheDir(config);
          const removed = cleanupOrphanedCache(cacheDir, state.sessionId, knownIds);
          ctx.ui.notify(`Removed ${removed} orphaned cache file${removed === 1 ? "" : "s"}`, "info");
          break;
        }

        default:
          ctx.ui.notify(
            "Usage: /inv tree | /inv mark [label] | /inv cleanup",
            "info",
          );
      }
    },
  });

  // ctrl+i — open investigation tree (ctrl+t is reserved by pi for thinking toggle).
  pi.registerShortcut("ctrl+i", {
    description: "Open investigation query tree",
    handler: async (ctx) => {
      if (ctx.isIdle()) {
        pi.sendUserMessage("/inv tree", { deliverAs: "followUp" });
      }
    },
  });
}

// ---------------------------------------------------------------------------
// Session entry ID resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the real session entry ID for a node.
 *
 * After reconstruction, sessionEntryId is correctly set to the entry's ID.
 * For nodes created in the current session (not yet reconstructed), we scan
 * the session manager to find the matching entry.
 */
function resolveSessionEntryId(
  ctx: ExtensionCommandContext,
  nodeId: string,
  placeholderOrReal: string,
): string | null {
  // If sessionEntryId is different from nodeId, reconstruction already set it.
  if (placeholderOrReal !== nodeId) return placeholderOrReal;

  // Scan session entries to find the matching custom entry.
  const entries = ctx.sessionManager.getEntries();
  for (const entry of entries) {
    if (
      entry.type === "custom" &&
      entry.customType === ENTRY_TYPE &&
      (entry.data as PersistedNodeEntry | undefined)?.nodeId === nodeId
    ) {
      return entry.id;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Tree overlay
// ---------------------------------------------------------------------------

async function openTreeOverlay(
  ctx: ExtensionCommandContext,
  state: InvestigationState,
  events: InvestigateEventBus,
  config: InvestigateConfig,
  tracker: QueryTreeTracker,
): Promise<void> {
  if (!ctx.hasUI) {
    ctx.ui.notify("Tree overlay requires interactive mode", "error");
    return;
  }

  const selectedId = await ctx.ui.custom<string | null>(
    (_tui, theme, _kb, done) =>
      new TreeOverlay(state, theme, tracker.getSelectedNodeId(), done),
    { overlay: true },
  );

  if (!selectedId) return;

  // Update the investigation cursor.
  tracker.setSelectedNode(selectedId);

  const node = state.nodes.get(selectedId);
  if (!node) return;

  // Ask: navigate to that session entry or open table viewer?
  const choice = await ctx.ui.select(
    `Node: "${node.label}"`,
    ["Jump to session entry", "Open table viewer", "Cancel"],
  );

  if (choice === "Jump to session entry") {
    // Look up the real session entry ID (reconstruction sets it, but in case
    // the node was just created this session, scan for it).
    const entryId = resolveSessionEntryId(ctx, node.id, node.sessionEntryId);
    if (entryId) {
      await ctx.navigateTree(entryId, { summarize: true });
    }
  } else if (choice === "Open table viewer") {
    await ctx.ui.custom<void>(
      (_tui, theme, _kb, done) =>
        new TableViewer(node, theme, config, state.sessionId, done),
    );
  }
}

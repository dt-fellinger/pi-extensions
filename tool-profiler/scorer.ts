/**
 * Scoring engine for the tool-profiler extension.
 *
 * Takes a finalized tool result and produces contextImpactScore, costImpactScore,
 * combinedSeverity, warningLevel, and factorTags. No external deps — pure functions.
 */

import type { FactorTag, ToolCallRecord, ToolCallStart, WarningLevel } from "./types.ts";

// ─── Thresholds ────────────────────────────────────────────────────────────

const LARGE_RESULT_TOKENS = 8_000;
const HIGH_CONTEXT_SHARE = 0.08;        // 8% of context window
const DOWNSTREAM_COST_TOKENS = 4_000;   // above this → likely-high-downstream-cost
const NOISY_BASH_LINES = 100;
const TRUNCATED_EXPENSIVE_TOKENS = 3_000;
const BROAD_READ_TOKENS = 2_000;        // unguarded large read heuristic
const REPEAT_SEVERITY_THRESHOLD = 0.35; // prior calls above this trigger repeat-penalty

// Severity normalisation denominators
const CONTEXT_NORMALISE_AT = 0.15;      // 15 % of window → context score 1.0
const COST_NORMALISE_AT = 12_000;       // 12 k tokens → cost score 1.0

// Warning bands
const WARNING_THRESHOLD = 0.50;
const CRITICAL_THRESHOLD = 0.75;

// Chars per token (conservative, works for both prose and code)
const CHARS_PER_TOKEN = 3.5;

// ─── Token estimation ──────────────────────────────────────────────────────

/**
 * Estimate token count from raw content text.
 * Uses a simple chars-per-token ratio — good enough for ranking.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

// ─── Arg summary sanitization ─────────────────────────────────────────────

/**
 * Produce a short, human-readable summary of a tool's arguments.
 * Never includes values that look like secrets or large blobs.
 */
export function summarizeArgs(toolName: string, args: Record<string, unknown>): string {
  switch (toolName) {
    case "read": {
      const path = String(args.path ?? "");
      const parts = [JSON.stringify(path)];
      if (args.offset !== undefined) parts.push(`offset=${args.offset}`);
      if (args.limit !== undefined) parts.push(`limit=${args.limit}`);
      return parts.join(" ");
    }
    case "bash": {
      const cmd = String(args.command ?? "");
      return cmd.length > 80 ? cmd.slice(0, 77) + "..." : cmd;
    }
    case "write": {
      return JSON.stringify(String(args.path ?? ""));
    }
    case "edit": {
      const path = String(args.path ?? "");
      const edits = Array.isArray(args.edits) ? args.edits.length : "?";
      return `${JSON.stringify(path)} (${edits} edits)`;
    }
    case "grep": {
      const pattern = String(args.pattern ?? "");
      const path = String(args.path ?? "");
      return `${JSON.stringify(pattern)} in ${JSON.stringify(path)}`;
    }
    default: {
      try {
        const s = JSON.stringify(args);
        return s.length > 80 ? s.slice(0, 77) + "..." : s;
      } catch {
        return "(non-serializable args)";
      }
    }
  }
}

// ─── Result content extraction ────────────────────────────────────────────

interface ContentBlock {
  type: string;
  text?: string;
}

/**
 * Extract plain text from tool result content blocks and return combined text + metrics.
 */
export function extractResultText(content: ContentBlock[]): {
  text: string;
  bytes: number;
  lines: number;
  wasTruncated: boolean;
} {
  const parts: string[] = [];
  let wasTruncated = false;

  for (const block of content) {
    if (block.type === "text" && typeof block.text === "string") {
      parts.push(block.text);
      // Heuristic: the last line of the final block often says "truncated"
      if (/truncated|output truncated|results truncated/i.test(block.text)) {
        wasTruncated = true;
      }
    }
  }

  const text = parts.join("\n");
  const bytes = Buffer.byteLength(text, "utf8");
  const lines = text ? text.split("\n").length : 0;

  return { text, bytes, lines, wasTruncated };
}

// ─── Factor tag assignment ────────────────────────────────────────────────

/**
 * Determine which factor tags apply to this tool call.
 */
export function assignFactorTags(opts: {
  toolName: string;
  args: Record<string, unknown>;
  estimatedTokens: number;
  resultLines: number;
  contextWindow: number;
  wasTruncated: boolean;
  priorRecordSeverities: number[]; // severities of previous calls for same tool
}): FactorTag[] {
  const { toolName, args, estimatedTokens, resultLines, contextWindow, wasTruncated, priorRecordSeverities } = opts;
  const tags: FactorTag[] = [];

  if (estimatedTokens > LARGE_RESULT_TOKENS) {
    tags.push("large-result");
  }

  if (contextWindow > 0 && estimatedTokens / contextWindow > HIGH_CONTEXT_SHARE) {
    tags.push("high-context-share");
  }

  if (estimatedTokens > DOWNSTREAM_COST_TOKENS) {
    tags.push("likely-high-downstream-cost");
  }

  if (wasTruncated && estimatedTokens > TRUNCATED_EXPENSIVE_TOKENS) {
    tags.push("truncated-but-expensive");
  }

  // Tool-specific heuristics
  if (toolName === "read") {
    const hasOffset = args.offset !== undefined;
    const hasLimit = args.limit !== undefined;
    if (!hasOffset && !hasLimit && estimatedTokens > BROAD_READ_TOKENS) {
      tags.push("broad-read-range");
    }
  }

  if (toolName === "bash" && resultLines > NOISY_BASH_LINES) {
    tags.push("noisy-bash-output");
  }

  // Repeat penalty: same tool called at least twice before with medium severity
  const mediumPrior = priorRecordSeverities.filter((s) => s > REPEAT_SEVERITY_THRESHOLD);
  if (mediumPrior.length >= 2) {
    tags.push("repeated-medium-cost");
  }

  return tags;
}

// ─── Score computation ────────────────────────────────────────────────────

function clamp(val: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, val));
}

/**
 * Compute normalised scores from token count, context info, and factor tags.
 */
export function computeScores(
  estimatedTokens: number,
  contextWindow: number,
  factorTags: FactorTag[],
): {
  contextImpactScore: number;
  costImpactScore: number;
  combinedSeverity: number;
  warningLevel: WarningLevel;
} {
  const contextShare = contextWindow > 0 ? estimatedTokens / contextWindow : 0;
  const contextImpactScore = clamp(contextShare / CONTEXT_NORMALISE_AT, 0, 1);
  const costImpactScore = clamp(estimatedTokens / COST_NORMALISE_AT, 0, 1);

  let penalty = 0;
  if (factorTags.includes("noisy-bash-output")) penalty += 0.08;
  if (factorTags.includes("truncated-but-expensive")) penalty += 0.08;
  if (factorTags.includes("repeated-medium-cost")) penalty += 0.08;
  if (factorTags.includes("broad-read-range")) penalty += 0.05;

  const combinedSeverity = clamp(0.5 * contextImpactScore + 0.5 * costImpactScore + penalty, 0, 1);

  let warningLevel: WarningLevel = "normal";
  if (combinedSeverity >= CRITICAL_THRESHOLD) warningLevel = "critical";
  else if (combinedSeverity >= WARNING_THRESHOLD) warningLevel = "warning";

  return { contextImpactScore, costImpactScore, combinedSeverity, warningLevel };
}

// ─── Record builder ───────────────────────────────────────────────────────

/**
 * Build a complete ToolCallRecord from start info, result content, and session context.
 */
export function buildRecord(
  start: ToolCallStart,
  content: ContentBlock[],
  args: Record<string, unknown>,
  priorSeveritiesForTool: number[],
): ToolCallRecord {
  const { text, bytes, lines, wasTruncated } = extractResultText(content);
  const estimatedResultTokens = estimateTokens(text);

  const factorTags = assignFactorTags({
    toolName: start.toolName,
    args,
    estimatedTokens: estimatedResultTokens,
    resultLines: lines,
    contextWindow: start.contextWindow,
    wasTruncated,
    priorRecordSeverities: priorSeveritiesForTool,
  });

  const { contextImpactScore, costImpactScore, combinedSeverity, warningLevel } = computeScores(
    estimatedResultTokens,
    start.contextWindow,
    factorTags,
  );

  return {
    toolCallId: start.toolCallId,
    toolName: start.toolName,
    timestamp: start.timestamp,
    argsSummary: start.argsSummary,
    resultBytes: bytes,
    resultLines: lines,
    estimatedResultTokens,
    wasTruncated,
    contextTokensBefore: start.contextTokensBefore,
    contextWindow: start.contextWindow,
    contextImpactScore,
    costImpactScore,
    combinedSeverity,
    warningLevel,
    factorTags,
  };
}

/**
 * Warning deduplication and formatting for the tool-profiler extension.
 *
 * Emits a short notification after a bad tool result. Suppresses repeated
 * warnings for the same pattern within a rolling window to avoid noise.
 */

import type { FactorTag, ToolCallRecord, WarningLevel } from "./types.ts";

// Suppress duplicate warnings for the same tool+tag combo within this window.
const DEDUP_WINDOW_MS = 5 * 60 * 1000; // 5 minutes

/** Tracks the last time a specific warning pattern was emitted. */
const recentWarnings = new Map<string, number>();

/** Clear the dedup map on session start. */
export function resetWarningDedup(): void {
  recentWarnings.clear();
}

/** One-line remediation hints keyed by factor tag. */
const hints: Partial<Record<FactorTag, string>> = {
  "large-result": "Consider narrowing the query or using offset/limit.",
  "high-context-share": "This result consumed a large share of the context window.",
  "likely-high-downstream-cost": "Large results inflate the next model request cost.",
  "truncated-but-expensive": "Output was truncated but still large — filter at the source.",
  "broad-read-range": "Add offset and limit to avoid reading the whole file.",
  "noisy-bash-output": "Pipe through grep, head, or tail to reduce output volume.",
  "repeated-medium-cost": "The same tool is called repeatedly with medium cost — consider caching.",
};

function severityBadge(level: WarningLevel): string {
  if (level === "critical") return "[critical]";
  if (level === "warning") return "[warning]";
  return "[normal]";
}

/**
 * Produce the text lines for a warning notification.
 * Returns null if the warning should be suppressed (dedup window active).
 */
export function buildWarning(record: ToolCallRecord): string[] | null {
  if (record.warningLevel === "normal") return null;

  // Use the worst factor tag as the dedup key.
  const dedupTag = record.factorTags[0] ?? "unknown";
  const key = `${record.toolName}:${dedupTag}`;
  const lastSeen = recentWarnings.get(key);
  if (lastSeen !== undefined && Date.now() - lastSeen < DEDUP_WINDOW_MS) {
    return null; // Still within the dedup window.
  }
  recentWarnings.set(key, Date.now());

  const tokenStr = formatTokens(record.estimatedResultTokens);
  const tags = record.factorTags.slice(0, 2).join(", ");
  const badge = severityBadge(record.warningLevel);
  const hint = record.factorTags.map((t) => hints[t]).find(Boolean);

  const lines = [
    `High-impact tool call: ${record.toolName} added ~${tokenStr} tokens  ${badge}`,
    `  factors: ${tags || "(none)"}`,
    ...(hint ? [`  → ${hint}`] : []),
  ];

  return lines;
}

function formatTokens(n: number): string {
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

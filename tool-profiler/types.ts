/**
 * Shared types for the tool-profiler extension.
 * All persisted data uses these types; raw tool output is never stored.
 */

export type FactorTag =
  | "large-result"
  | "high-context-share"
  | "likely-high-downstream-cost"
  | "truncated-but-expensive"
  | "broad-read-range"
  | "noisy-bash-output"
  | "repeated-medium-cost";

export type WarningLevel = "normal" | "warning" | "critical";

/** Full detail record for one tool call in the current session. */
export interface ToolCallRecord {
  toolCallId: string;
  toolName: string;
  timestamp: number;
  argsSummary: string;
  resultBytes: number;
  resultLines: number;
  estimatedResultTokens: number;
  wasTruncated: boolean;
  contextTokensBefore: number;
  contextWindow: number;
  contextImpactScore: number;
  costImpactScore: number;
  combinedSeverity: number;
  warningLevel: WarningLevel;
  factorTags: FactorTag[];
  /** Refined cost estimate in USD once the next assistant turn's usage is known. */
  refinedCostEstimate?: number;
}

/** Transient state captured at tool_execution_start. */
export interface ToolCallStart {
  toolCallId: string;
  toolName: string;
  timestamp: number;
  argsSummary: string;
  contextTokensBefore: number;
  contextWindow: number;
}

/** Per-tool entry in the cross-session aggregate. */
export interface AggregateEntry {
  totalCalls: number;
  totalEstimatedTokens: number;
  totalEstimatedCost: number;
  totalSeverity: number;
  maxSeverity: number;
  factorTagCounts: Partial<Record<FactorTag, number>>;
  warningLevelCounts: Record<WarningLevel, number>;
}

/** Root structure of the cross-session aggregate JSON file. */
export interface Aggregate {
  version: number;
  byTool: Record<string, AggregateEntry>;
  lastUpdated: number;
}

/**
 * Cross-session aggregate persistence.
 *
 * Reads and writes a compact JSON file that accumulates per-tool statistics
 * across sessions. Raw tool output is never written here — only metrics and tags.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Aggregate, AggregateEntry, FactorTag, ToolCallRecord, WarningLevel } from "./types.ts";

const AGGREGATE_VERSION = 1;

function emptyEntry(): AggregateEntry {
  return {
    totalCalls: 0,
    totalEstimatedTokens: 0,
    totalEstimatedCost: 0,
    totalSeverity: 0,
    maxSeverity: 0,
    factorTagCounts: {},
    warningLevelCounts: { normal: 0, warning: 0, critical: 0 },
  };
}

function emptyAggregate(): Aggregate {
  return { version: AGGREGATE_VERSION, byTool: {}, lastUpdated: Date.now() };
}

/** Load aggregate from disk. Returns an empty aggregate if the file doesn't exist or is corrupt. */
export async function loadAggregate(path: string): Promise<Aggregate> {
  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw) as Aggregate;
    if (parsed.version !== AGGREGATE_VERSION) {
      // Version mismatch — start fresh rather than fail.
      return emptyAggregate();
    }
    return parsed;
  } catch {
    return emptyAggregate();
  }
}

/** Atomically write the aggregate to disk. */
export async function saveAggregate(path: string, aggregate: Aggregate): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  aggregate.lastUpdated = Date.now();
  const tmp = path + ".tmp";
  await writeFile(tmp, JSON.stringify(aggregate, null, 2), "utf8");
  // Rename is atomic on Linux / macOS.
  await (await import("node:fs/promises")).rename(tmp, path);
}

/**
 * Merge a finalized session record into the aggregate.
 * Call this once per record at session shutdown.
 */
export function mergeRecord(aggregate: Aggregate, record: ToolCallRecord): void {
  const key = record.toolName;
  if (!aggregate.byTool[key]) {
    aggregate.byTool[key] = emptyEntry();
  }
  const entry = aggregate.byTool[key];

  entry.totalCalls += 1;
  entry.totalEstimatedTokens += record.estimatedResultTokens;
  entry.totalEstimatedCost += record.refinedCostEstimate ?? 0;
  entry.totalSeverity += record.combinedSeverity;
  entry.maxSeverity = Math.max(entry.maxSeverity, record.combinedSeverity);

  for (const tag of record.factorTags as FactorTag[]) {
    entry.factorTagCounts[tag] = (entry.factorTagCounts[tag] ?? 0) + 1;
  }

  const level = record.warningLevel as WarningLevel;
  entry.warningLevelCounts[level] = (entry.warningLevelCounts[level] ?? 0) + 1;
}

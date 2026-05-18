/**
 * Result store — write and read cached full query results to disk.
 *
 * Full results are written to:
 *   ~/.pi/agent/investigate-cache/<sessionId>/query-tree/<nodeId>.json
 *
 * Write failures are non-fatal. The inline preview in the session entry
 * always remains usable as a fallback.
 */

import { mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { CachedResult } from "../../core/types.js";

/**
 * Write a full result cache file. Returns the path on success, null on failure.
 */
export function writeCachedResult(
  cacheDir: string,
  sessionId: string,
  nodeId: string,
  data: CachedResult,
): string | null {
  const filePath = resultPath(cacheDir, sessionId, nodeId);
  try {
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, JSON.stringify(data), "utf8");
    return filePath;
  } catch {
    // Non-fatal — inline preview is still available.
    return null;
  }
}

/**
 * Read a full result cache file. Returns null if missing or corrupt.
 */
export function readCachedResult(
  cacheDir: string,
  sessionId: string,
  nodeId: string,
): CachedResult | null {
  const filePath = resultPath(cacheDir, sessionId, nodeId);
  try {
    const raw = readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw) as CachedResult;
    if (parsed.schemaVersion !== 1) return null;
    return parsed;
  } catch {
    return null;
  }
}

/** Resolve the path for a cached result file. */
export function resultPath(cacheDir: string, sessionId: string, nodeId: string): string {
  return join(cacheDir, sessionId, "query-tree", `${nodeId}.json`);
}

/**
 * Remove orphaned cache files that don't correspond to any known node.
 * Returns the number of files removed.
 */
export function cleanupOrphanedCache(
  cacheDir: string,
  sessionId: string,
  knownNodeIds: Set<string>,
): number {
  const sessionDir = join(cacheDir, sessionId, "query-tree");
  let removed = 0;
  try {
    const files = readdirSync(sessionDir);
    for (const file of files) {
      const nodeId = file.replace(/\.json$/, "");
      if (!knownNodeIds.has(nodeId)) {
        try {
          unlinkSync(join(sessionDir, file));
          removed++;
        } catch {
          // Ignore individual removal failures.
        }
      }
    }
  } catch {
    // Directory may not exist — nothing to clean up.
  }
  return removed;
}

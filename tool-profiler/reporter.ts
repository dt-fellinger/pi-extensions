/**
 * Text formatting for the /tool-stats command.
 *
 * Produces three sections: top offending calls, biggest factors, and per-tool rollup.
 * All output is plain text — no TUI colours — so it's easy to copy and read anywhere.
 */

import type { Aggregate, FactorTag, ToolCallRecord } from "./types.ts";

// ─── Utilities ─────────────────────────────────────────────────────────────

function formatTokens(n: number): string {
  if (n >= 1_000) return `~${(n / 1_000).toFixed(1)}k`;
  return `~${n}`;
}

function formatCost(usd: number): string {
  if (usd === 0) return "$0.000";
  if (usd < 0.001) return `<$0.001`;
  return `$${usd.toFixed(3)}`;
}

function pad(s: string, width: number): string {
  return s.length >= width ? s : s + " ".repeat(width - s.length);
}

function rpad(s: string, width: number): string {
  return s.length >= width ? s : " ".repeat(width - s.length) + s;
}

function severityStr(s: number): string {
  return s.toFixed(2);
}

function warningBadge(level: string): string {
  if (level === "critical") return "⚠⚠";
  if (level === "warning") return "⚠ ";
  return "  ";
}

const FACTOR_HINTS: Partial<Record<FactorTag, string>> = {
  "large-result": "Use offset/limit or grep to reduce result size.",
  "high-context-share": "This tool is consuming a large fraction of the context window.",
  "likely-high-downstream-cost": "Large results inflate the cost of the next model request.",
  "truncated-but-expensive": "Output was truncated but is still large — filter at the source.",
  "broad-read-range": "Add offset and limit to avoid reading entire large files.",
  "noisy-bash-output": "Pipe through grep, head, or tail to reduce output volume.",
  "repeated-medium-cost": "The same tool is called repeatedly with medium cost — consider caching results.",
};

// ─── Section 1: Top offending calls ────────────────────────────────────────

function renderTopCalls(records: ToolCallRecord[], limit = 10): string[] {
  const sorted = [...records].sort((a, b) => b.combinedSeverity - a.combinedSeverity).slice(0, limit);

  if (sorted.length === 0) return ["  (no tool calls recorded)"];

  const lines: string[] = [];
  sorted.forEach((r, i) => {
    const rank = `${i + 1}.`;
    const badge = warningBadge(r.warningLevel);
    const tokens = formatTokens(r.estimatedResultTokens);
    const sev = severityStr(r.combinedSeverity);
    const tags = r.factorTags.length ? r.factorTags.join(", ") : "—";
    const cost = r.refinedCostEstimate !== undefined ? ` cost:${formatCost(r.refinedCostEstimate)}` : "";

    lines.push(`  ${badge} ${rpad(rank, 3)} ${pad(r.toolName, 12)} ${pad(r.argsSummary, 38)} ${rpad(tokens, 8)} sev:${sev}${cost}`);
    lines.push(`              factors: ${tags}`);
  });

  return lines;
}

// ─── Section 2: Biggest factors ────────────────────────────────────────────

function renderFactors(records: ToolCallRecord[]): string[] {
  if (records.length === 0) return ["  (no data)"];

  // Accumulate: tag → { totalSeverity, callCount }
  const acc: Map<FactorTag, { totalSeverity: number; count: number }> = new Map();

  for (const r of records) {
    for (const tag of r.factorTags as FactorTag[]) {
      const prev = acc.get(tag) ?? { totalSeverity: 0, count: 0 };
      acc.set(tag, { totalSeverity: prev.totalSeverity + r.combinedSeverity, count: prev.count + 1 });
    }
  }

  if (acc.size === 0) return ["  (no factor tags — all calls were within normal bounds)"];

  const sorted = [...acc.entries()].sort((a, b) => b[1].totalSeverity - a[1].totalSeverity);

  const lines: string[] = [];
  for (const [tag, { totalSeverity, count }] of sorted) {
    const hint = FACTOR_HINTS[tag] ?? "";
    lines.push(`  ${pad(tag, 32)} calls:${rpad(String(count), 4)}  total-sev:${totalSeverity.toFixed(2)}`);
    if (hint) lines.push(`    → ${hint}`);
  }

  return lines;
}

// ─── Section 3: By-tool rollup ─────────────────────────────────────────────

function renderByTool(records: ToolCallRecord[]): string[] {
  if (records.length === 0) return ["  (no data)"];

  const acc: Map<string, { calls: number; tokens: number; cost: number; totalSeverity: number; maxSeverity: number }> =
    new Map();

  for (const r of records) {
    const prev = acc.get(r.toolName) ?? { calls: 0, tokens: 0, cost: 0, totalSeverity: 0, maxSeverity: 0 };
    acc.set(r.toolName, {
      calls: prev.calls + 1,
      tokens: prev.tokens + r.estimatedResultTokens,
      cost: prev.cost + (r.refinedCostEstimate ?? 0),
      totalSeverity: prev.totalSeverity + r.combinedSeverity,
      maxSeverity: Math.max(prev.maxSeverity, r.combinedSeverity),
    });
  }

  const header = `  ${pad("tool", 14)}${rpad("calls", 7)}  ${rpad("tokens", 10)}  ${rpad("est.cost", 10)}  ${rpad("avg.sev", 8)}  ${rpad("max.sev", 8)}`;
  const divider = "  " + "-".repeat(header.length - 2);
  const lines: string[] = [header, divider];

  const sorted = [...acc.entries()].sort((a, b) => b[1].totalSeverity - a[1].totalSeverity);

  for (const [toolName, d] of sorted) {
    const avgSev = (d.totalSeverity / d.calls).toFixed(2);
    const maxSev = d.maxSeverity.toFixed(2);
    lines.push(
      `  ${pad(toolName, 14)}${rpad(String(d.calls), 7)}  ${rpad(formatTokens(d.tokens), 10)}  ${rpad(formatCost(d.cost), 10)}  ${rpad(avgSev, 8)}  ${rpad(maxSev, 8)}`,
    );
  }

  return lines;
}

// ─── Aggregate rendering ───────────────────────────────────────────────────

function renderAggregateByTool(aggregate: Aggregate): string[] {
  const entries = Object.entries(aggregate.byTool);
  if (entries.length === 0) return ["  (no cross-session data yet)"];

  const sorted = entries.sort((a, b) => b[1].totalSeverity - a[1].totalSeverity);
  const header = `  ${pad("tool", 14)}${rpad("calls", 7)}  ${rpad("tokens", 10)}  ${rpad("est.cost", 10)}  ${rpad("avg.sev", 8)}  ${rpad("max.sev", 8)}`;
  const divider = "  " + "-".repeat(header.length - 2);
  const lines: string[] = [header, divider];

  for (const [toolName, e] of sorted) {
    const avgSev = e.totalCalls > 0 ? (e.totalSeverity / e.totalCalls).toFixed(2) : "0.00";
    const maxSev = e.maxSeverity.toFixed(2);
    lines.push(
      `  ${pad(toolName, 14)}${rpad(String(e.totalCalls), 7)}  ${rpad(formatTokens(e.totalEstimatedTokens), 10)}  ${rpad(formatCost(e.totalEstimatedCost), 10)}  ${rpad(avgSev, 8)}  ${rpad(maxSev, 8)}`,
    );
  }

  return lines;
}

function renderAggregateFactors(aggregate: Aggregate): string[] {
  const acc: Map<string, { totalSeverity: number; count: number }> = new Map();

  for (const e of Object.values(aggregate.byTool)) {
    for (const [tag, count] of Object.entries(e.factorTagCounts) as [FactorTag, number][]) {
      // Approximate severity contribution from aggregate only (no per-record granularity).
      const prev = acc.get(tag) ?? { totalSeverity: 0, count: 0 };
      acc.set(tag, { totalSeverity: prev.totalSeverity + (count ?? 0), count: prev.count + (count ?? 0) });
    }
  }

  if (acc.size === 0) return ["  (no factor data)"];

  const sorted = [...acc.entries()].sort((a, b) => b[1].count - a[1].count);
  const lines: string[] = [];
  for (const [tag, { count }] of sorted) {
    const hint = FACTOR_HINTS[tag as FactorTag] ?? "";
    lines.push(`  ${pad(tag, 32)} occurrences:${rpad(String(count), 5)}`);
    if (hint) lines.push(`    → ${hint}`);
  }
  return lines;
}

// ─── Public render entry point ─────────────────────────────────────────────

export type StatsFilter = "session" | "overall" | { tool: string };

/**
 * Render the /tool-stats output as an array of lines.
 *
 * @param sessionRecords  Finalized records for the current session.
 * @param aggregate       Cross-session aggregate data.
 * @param filter          Which view to show.
 */
export function renderStats(
  sessionRecords: ToolCallRecord[],
  aggregate: Aggregate,
  filter: StatsFilter,
): string[] {
  const lines: string[] = [];

  if (filter === "overall") {
    lines.push("=== Tool Stats: Cross-Session Overview ===", "");
    lines.push("── By Tool ─────────────────────────────────────────────────────");
    lines.push(...renderAggregateByTool(aggregate));
    lines.push("");
    lines.push("── Biggest Factors ──────────────────────────────────────────────");
    lines.push(...renderAggregateFactors(aggregate));
    lines.push("");
    lines.push(`Last updated: ${new Date(aggregate.lastUpdated).toLocaleString()}`);
    return lines;
  }

  // Determine which records to show.
  let records = sessionRecords;
  if (typeof filter === "object" && "tool" in filter) {
    const name = filter.tool.toLowerCase();
    records = sessionRecords.filter((r) => r.toolName.toLowerCase() === name);
    lines.push(`=== Tool Stats: "${filter.tool}" — Current Session ===`, "");
  } else {
    lines.push("=== Tool Stats: Current Session ===", "");
  }

  lines.push("── Top Offending Calls ──────────────────────────────────────────");
  lines.push(...renderTopCalls(records));
  lines.push("");
  lines.push("── Biggest Factors ──────────────────────────────────────────────");
  lines.push(...renderFactors(records));
  lines.push("");
  lines.push("── By Tool ──────────────────────────────────────────────────────");
  lines.push(...renderByTool(records));

  return lines;
}

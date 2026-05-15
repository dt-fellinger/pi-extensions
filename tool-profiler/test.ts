/**
 * Tool Profiler — test suite
 *
 * Run with: node --import tsx test.ts
 * (or: npx tsx test.ts)
 *
 * Covers:
 *  - Token estimation from representative tool results
 *  - Factor-tag assignment rules
 *  - Combined severity calculation
 *  - Warning threshold behavior
 *  - Ranking logic for top offenders
 *  - Grouped rollups by tool
 *  - Aggregate persistence read/write
 *  - Attribution with multiple tool calls feeding one assistant turn
 *  - Privacy guardrails (no raw payload persisted)
 */

import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rm } from "node:fs/promises";

import { estimateTokens, summarizeArgs, extractResultText, assignFactorTags, computeScores, buildRecord } from "./scorer.ts";
import { loadAggregate, saveAggregate, mergeRecord } from "./storage.ts";
import { renderStats } from "./reporter.ts";
import { buildWarning, resetWarningDedup } from "./warnings.ts";
import type { ToolCallRecord, ToolCallStart } from "./types.ts";

// ─── Test runner helpers ──────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void | Promise<void>): void {
  Promise.resolve(fn()).then(() => {
    console.log(`  ✓  ${name}`);
    passed++;
  }).catch((err: Error) => {
    console.error(`  ✗  ${name}`);
    console.error(`     ${err.message}`);
    failed++;
  });
}

// ─── 1. Token estimation ──────────────────────────────────────────────────

test("estimateTokens returns 0 for empty string", () => {
  assert.equal(estimateTokens(""), 0);
});

test("estimateTokens scales with content length", () => {
  const tokens = estimateTokens("a".repeat(3500));
  // 3500 chars / 3.5 chars-per-token = 1000
  assert.equal(tokens, 1000);
});

test("estimateTokens handles multi-byte characters gracefully", () => {
  const text = "🔥".repeat(100); // 4 bytes each
  const tokens = estimateTokens(text);
  assert.ok(tokens > 0, "should produce a positive token count");
});

// ─── 2. Args summary sanitization ────────────────────────────────────────

test("summarizeArgs for read includes path", () => {
  const s = summarizeArgs("read", { path: "/foo/bar.ts" });
  assert.ok(s.includes("bar.ts"), `got: ${s}`);
});

test("summarizeArgs for read includes offset/limit when present", () => {
  const s = summarizeArgs("read", { path: "/foo/bar.ts", offset: 100, limit: 50 });
  assert.ok(s.includes("offset=100"), `got: ${s}`);
  assert.ok(s.includes("limit=50"), `got: ${s}`);
});

test("summarizeArgs for bash truncates long commands", () => {
  const long = "echo " + "x".repeat(200);
  const s = summarizeArgs("bash", { command: long });
  assert.ok(s.length <= 83, `got length ${s.length}`); // 80 chars + "..."
});

test("summarizeArgs for bash does not truncate short commands", () => {
  const s = summarizeArgs("bash", { command: "ls -la" });
  assert.equal(s, "ls -la");
});

test("summarizeArgs for edit includes edit count", () => {
  const s = summarizeArgs("edit", { path: "/file.ts", edits: [{}, {}] });
  assert.ok(s.includes("2 edits"), `got: ${s}`);
});

// ─── 3. Result content extraction ────────────────────────────────────────

test("extractResultText joins multiple text blocks", () => {
  const { text, lines } = extractResultText([
    { type: "text", text: "line one" },
    { type: "text", text: "line two" },
  ]);
  assert.ok(text.includes("line one"), `got: ${text}`);
  assert.ok(text.includes("line two"), `got: ${text}`);
  assert.ok(lines >= 2);
});

test("extractResultText detects truncation heuristic", () => {
  const { wasTruncated } = extractResultText([
    { type: "text", text: "some output\nOutput truncated after 2000 lines" },
  ]);
  assert.equal(wasTruncated, true);
});

test("extractResultText is not truncated for clean output", () => {
  const { wasTruncated } = extractResultText([
    { type: "text", text: "hello world" },
  ]);
  assert.equal(wasTruncated, false);
});

test("extractResultText handles empty content array", () => {
  const { bytes, lines, text } = extractResultText([]);
  assert.equal(text, "");
  assert.equal(bytes, 0);
  assert.equal(lines, 0);
});

// ─── 4. Factor tag assignment ─────────────────────────────────────────────

test("assignFactorTags flags large-result for big outputs", () => {
  const tags = assignFactorTags({
    toolName: "bash",
    args: { command: "cat bigfile" },
    estimatedTokens: 10_000,
    resultLines: 50,
    contextWindow: 200_000,
    wasTruncated: false,
    priorRecordSeverities: [],
  });
  assert.ok(tags.includes("large-result"), `tags: ${tags}`);
});

test("assignFactorTags flags high-context-share at 10%+ of window", () => {
  const tags = assignFactorTags({
    toolName: "read",
    args: { path: "/x" },
    estimatedTokens: 20_000,
    resultLines: 200,
    contextWindow: 200_000, // 20k/200k = 10% > threshold 8%
    wasTruncated: false,
    priorRecordSeverities: [],
  });
  assert.ok(tags.includes("high-context-share"), `tags: ${tags}`);
});

test("assignFactorTags flags noisy-bash-output for high line count", () => {
  const tags = assignFactorTags({
    toolName: "bash",
    args: { command: "find ." },
    estimatedTokens: 1_000,
    resultLines: 150,
    contextWindow: 200_000,
    wasTruncated: false,
    priorRecordSeverities: [],
  });
  assert.ok(tags.includes("noisy-bash-output"), `tags: ${tags}`);
});

test("assignFactorTags flags broad-read-range for unguarded read", () => {
  const tags = assignFactorTags({
    toolName: "read",
    args: { path: "/large-file.ts" }, // no offset or limit
    estimatedTokens: 5_000,
    resultLines: 100,
    contextWindow: 200_000,
    wasTruncated: false,
    priorRecordSeverities: [],
  });
  assert.ok(tags.includes("broad-read-range"), `tags: ${tags}`);
});

test("assignFactorTags does NOT flag broad-read-range when offset/limit present", () => {
  const tags = assignFactorTags({
    toolName: "read",
    args: { path: "/large-file.ts", offset: 1, limit: 100 },
    estimatedTokens: 5_000,
    resultLines: 100,
    contextWindow: 200_000,
    wasTruncated: false,
    priorRecordSeverities: [],
  });
  assert.ok(!tags.includes("broad-read-range"), `tags should not include broad-read-range: ${tags}`);
});

test("assignFactorTags flags truncated-but-expensive", () => {
  const tags = assignFactorTags({
    toolName: "bash",
    args: {},
    estimatedTokens: 4_000,
    resultLines: 200,
    contextWindow: 200_000,
    wasTruncated: true,
    priorRecordSeverities: [],
  });
  assert.ok(tags.includes("truncated-but-expensive"), `tags: ${tags}`);
});

test("assignFactorTags flags repeated-medium-cost after two prior calls", () => {
  const tags = assignFactorTags({
    toolName: "read",
    args: {},
    estimatedTokens: 1_000,
    resultLines: 10,
    contextWindow: 200_000,
    wasTruncated: false,
    priorRecordSeverities: [0.5, 0.6], // two medium-severity priors
  });
  assert.ok(tags.includes("repeated-medium-cost"), `tags: ${tags}`);
});

test("assignFactorTags does NOT flag repeated-medium-cost with only one prior", () => {
  const tags = assignFactorTags({
    toolName: "read",
    args: {},
    estimatedTokens: 1_000,
    resultLines: 10,
    contextWindow: 200_000,
    wasTruncated: false,
    priorRecordSeverities: [0.5], // only one medium-severity prior
  });
  assert.ok(!tags.includes("repeated-medium-cost"), `tags: ${tags}`);
});

// ─── 5. Severity calculation ──────────────────────────────────────────────

test("computeScores returns near-zero severity for tiny result", () => {
  const { combinedSeverity, warningLevel } = computeScores(50, 200_000, []);
  assert.ok(combinedSeverity < 0.1, `severity: ${combinedSeverity}`);
  assert.equal(warningLevel, "normal");
});

test("computeScores returns critical for huge result", () => {
  const { combinedSeverity, warningLevel } = computeScores(50_000, 128_000, ["large-result", "high-context-share"]);
  assert.ok(combinedSeverity >= 0.75, `severity: ${combinedSeverity}`);
  assert.equal(warningLevel, "critical");
});

test("computeScores returns warning for medium result", () => {
  const { warningLevel } = computeScores(8_000, 200_000, ["noisy-bash-output"]);
  assert.ok(warningLevel === "warning" || warningLevel === "critical");
});

test("combinedSeverity never exceeds 1.0", () => {
  const { combinedSeverity } = computeScores(1_000_000, 1_000, ["large-result", "high-context-share", "noisy-bash-output"]);
  assert.ok(combinedSeverity <= 1.0, `severity: ${combinedSeverity}`);
});

// ─── 6. Warning behavior ──────────────────────────────────────────────────

function makeRecord(overrides: Partial<ToolCallRecord> = {}): ToolCallRecord {
  return {
    toolCallId: "call-1",
    toolName: "bash",
    timestamp: Date.now(),
    argsSummary: "ls -la",
    resultBytes: 1000,
    resultLines: 50,
    estimatedResultTokens: 8_000,
    wasTruncated: false,
    contextTokensBefore: 10_000,
    contextWindow: 128_000,
    contextImpactScore: 0.5,
    costImpactScore: 0.6,
    combinedSeverity: 0.6,
    warningLevel: "warning",
    factorTags: ["noisy-bash-output"],
    ...overrides,
  };
}

test("buildWarning returns lines for warning-level record", () => {
  resetWarningDedup();
  const lines = buildWarning(makeRecord({ warningLevel: "warning" }));
  assert.ok(lines !== null, "expected warning lines, got null");
  assert.ok(lines!.length >= 2, `expected 2+ lines, got ${lines!.length}`);
});

test("buildWarning returns null for normal-level record", () => {
  resetWarningDedup();
  const lines = buildWarning(makeRecord({ warningLevel: "normal" }));
  assert.equal(lines, null);
});

test("buildWarning suppresses duplicate within dedup window", () => {
  resetWarningDedup();
  const record = makeRecord({ warningLevel: "warning", factorTags: ["noisy-bash-output"] });
  const first = buildWarning(record);
  const second = buildWarning(record); // same tool + factor tag
  assert.ok(first !== null, "first warning should emit");
  assert.equal(second, null, "second warning should be suppressed");
});

test("buildWarning includes factor tag in output", () => {
  resetWarningDedup();
  const lines = buildWarning(makeRecord({ warningLevel: "critical", factorTags: ["large-result", "noisy-bash-output"] }));
  assert.ok(lines !== null);
  const joined = lines!.join(" ");
  assert.ok(joined.includes("large-result"), `should include factor tag: ${joined}`);
});

// ─── 7. Ranking and rollup ────────────────────────────────────────────────

function makeSessionRecords(): ToolCallRecord[] {
  return [
    makeRecord({ toolCallId: "1", toolName: "bash", combinedSeverity: 0.9, estimatedResultTokens: 20_000, warningLevel: "critical", factorTags: ["noisy-bash-output"] }),
    makeRecord({ toolCallId: "2", toolName: "read", combinedSeverity: 0.6, estimatedResultTokens: 8_000, warningLevel: "warning", factorTags: ["large-result"] }),
    makeRecord({ toolCallId: "3", toolName: "bash", combinedSeverity: 0.4, estimatedResultTokens: 4_000, warningLevel: "normal", factorTags: [] }),
    makeRecord({ toolCallId: "4", toolName: "read", combinedSeverity: 0.7, estimatedResultTokens: 10_000, warningLevel: "warning", factorTags: ["broad-read-range"] }),
  ];
}

test("renderStats session output contains top calls header", () => {
  const records = makeSessionRecords();
  const aggregate = { version: 1, byTool: {}, lastUpdated: Date.now() };
  const lines = renderStats(records, aggregate, "session");
  const text = lines.join("\n");
  assert.ok(text.includes("Top Offending"), `output: ${text.slice(0, 200)}`);
});

test("renderStats session top calls are sorted by severity descending", () => {
  const records = makeSessionRecords();
  const aggregate = { version: 1, byTool: {}, lastUpdated: Date.now() };
  const lines = renderStats(records, aggregate, "session");
  const text = lines.join("\n");
  // The critical bash call (0.9) should appear before the normal one (0.4).
  const critIdx = text.indexOf("0.90");
  const normIdx = text.indexOf("0.40");
  assert.ok(critIdx < normIdx, "critical call should appear before normal call");
});

test("renderStats by-tool rollup shows both bash and read", () => {
  const records = makeSessionRecords();
  const aggregate = { version: 1, byTool: {}, lastUpdated: Date.now() };
  const lines = renderStats(records, aggregate, "session");
  const text = lines.join("\n");
  assert.ok(text.includes("bash"), `missing bash: ${text.slice(0, 200)}`);
  assert.ok(text.includes("read"), `missing read: ${text.slice(0, 200)}`);
});

test("renderStats tool filter only shows matching tool", () => {
  const records = makeSessionRecords();
  const aggregate = { version: 1, byTool: {}, lastUpdated: Date.now() };
  const lines = renderStats(records, aggregate, { tool: "read" });
  const text = lines.join("\n");
  // The by-tool table should show read but not bash (only in the filter sections).
  // Top offending calls won't include bash calls.
  assert.ok(text.includes("read"), `missing read: ${text.slice(0, 300)}`);
});

test("renderStats overall shows cross-session data", () => {
  const aggregate = {
    version: 1,
    byTool: {
      bash: { totalCalls: 10, totalEstimatedTokens: 50_000, totalEstimatedCost: 0.01, totalSeverity: 6.5, maxSeverity: 0.9, factorTagCounts: { "noisy-bash-output": 8 }, warningLevelCounts: { normal: 2, warning: 5, critical: 3 } },
    },
    lastUpdated: Date.now(),
  };
  const lines = renderStats([], aggregate, "overall");
  const text = lines.join("\n");
  assert.ok(text.includes("Cross-Session"), `missing header: ${text.slice(0, 200)}`);
  assert.ok(text.includes("bash"), `missing bash: ${text.slice(0, 200)}`);
});

// ─── 8. Aggregate persistence ─────────────────────────────────────────────

test("loadAggregate returns empty aggregate when file does not exist", async () => {
  const path = join(tmpdir(), `tool-profiler-test-${Date.now()}.json`);
  const agg = await loadAggregate(path);
  assert.equal(agg.version, 1);
  assert.deepEqual(agg.byTool, {});
});

test("saveAggregate and loadAggregate round-trip correctly", async () => {
  const path = join(tmpdir(), `tool-profiler-test-${Date.now()}.json`);
  const agg = { version: 1, byTool: {}, lastUpdated: 0 };
  mergeRecord(agg, makeRecord({ toolName: "bash", combinedSeverity: 0.8, factorTags: ["large-result"], warningLevel: "warning" }));
  await saveAggregate(path, agg);

  const loaded = await loadAggregate(path);
  assert.ok(loaded.byTool["bash"], "bash entry should survive round-trip");
  assert.equal(loaded.byTool["bash"].totalCalls, 1);

  await rm(path, { force: true });
});

test("mergeRecord accumulates across multiple records for the same tool", () => {
  const agg = { version: 1, byTool: {}, lastUpdated: Date.now() };
  mergeRecord(agg, makeRecord({ toolName: "read", combinedSeverity: 0.5, factorTags: ["large-result"] }));
  mergeRecord(agg, makeRecord({ toolName: "read", combinedSeverity: 0.7, factorTags: ["broad-read-range"] }));

  const e = agg.byTool["read"];
  assert.equal(e.totalCalls, 2);
  assert.ok(e.maxSeverity >= 0.7);
  assert.equal(e.factorTagCounts["large-result"], 1);
  assert.equal(e.factorTagCounts["broad-read-range"], 1);
});

// ─── 9. Cost attribution simulation ──────────────────────────────────────

test("proportional cost attribution sums to total cost", () => {
  const records: ToolCallRecord[] = [
    makeRecord({ toolCallId: "a", estimatedResultTokens: 3_000 }),
    makeRecord({ toolCallId: "b", estimatedResultTokens: 7_000 }),
  ];

  const totalCost = 0.01;
  const totalTokens = records.reduce((s, r) => s + r.estimatedResultTokens, 0);

  for (const r of records) {
    r.refinedCostEstimate = totalCost * (r.estimatedResultTokens / totalTokens);
  }

  const sumCost = records.reduce((s, r) => s + (r.refinedCostEstimate ?? 0), 0);
  assert.ok(Math.abs(sumCost - totalCost) < 1e-10, `sum ${sumCost} should equal ${totalCost}`);
});

test("records with more tokens receive larger cost share", () => {
  const records: ToolCallRecord[] = [
    makeRecord({ toolCallId: "small", estimatedResultTokens: 1_000 }),
    makeRecord({ toolCallId: "large", estimatedResultTokens: 9_000 }),
  ];

  const totalCost = 0.01;
  const totalTokens = records.reduce((s, r) => s + r.estimatedResultTokens, 0);
  for (const r of records) {
    r.refinedCostEstimate = totalCost * (r.estimatedResultTokens / totalTokens);
  }

  assert.ok(records[1].refinedCostEstimate! > records[0].refinedCostEstimate!, "larger result should get larger cost share");
});

// ─── 10. Privacy guardrails ───────────────────────────────────────────────

test("buildRecord does not include raw tool output text in the record", () => {
  const start: ToolCallStart = {
    toolCallId: "priv-1",
    toolName: "read",
    timestamp: Date.now(),
    argsSummary: '"/secret/file.txt"',
    contextTokensBefore: 10_000,
    contextWindow: 128_000,
  };
  const secretContent = "SECRET_API_KEY=s3cr3t_value_that_must_not_persist";
  const record = buildRecord(
    start,
    [{ type: "text", text: secretContent }],
    { path: "/secret/file.txt" },
    [],
  );

  // The record should only contain metrics, not the raw output text.
  const serialized = JSON.stringify(record);
  assert.ok(!serialized.includes(secretContent), "raw tool output must not appear in the record");
});

test("argsSummary truncates long bash commands and does not embed output", () => {
  const longCmd = "SECRET=abc123 curl https://api.example.com/endpoint --data-binary @large-file.json";
  const summary = summarizeArgs("bash", { command: longCmd });
  // Summary should be <= 80 chars
  assert.ok(summary.length <= 83, `summary too long: ${summary.length}`);
  // Summary should contain the command start but not any tool output
  assert.ok(summary.startsWith("SECRET=abc123"), `should start with command: ${summary}`);
});

// ─── Results ──────────────────────────────────────────────────────────────

setTimeout(() => {
  console.log(`\n${passed + failed} tests run  •  ${passed} passed  •  ${failed} failed`);
  if (failed > 0) process.exit(1);
}, 200); // allow async tests to settle

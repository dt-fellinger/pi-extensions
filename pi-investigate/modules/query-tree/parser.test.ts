/**
 * Parser tests — fixture-based tests for detectDtctlQuery and parseQueryOutput.
 *
 * Run with: node --test modules/query-tree/parser.test.ts
 * (Uses Node.js built-in test runner; no external deps needed.)
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { detectDtctlQuery, parseQueryOutput } from "./parser.js";
import { fallbackLabel } from "./label-generator.js";

// ---------------------------------------------------------------------------
// Command detection
// ---------------------------------------------------------------------------

describe("detectDtctlQuery", () => {
  it("detects inline query", () => {
    const result = detectDtctlQuery('dtctl query "fetch logs | limit 10" -o json --plain');
    assert.ok(result);
    assert.equal(result.fileQuery, false);
    assert.equal(result.query, "fetch logs | limit 10");
  });

  it("detects dtctl wait query", () => {
    const result = detectDtctlQuery('dtctl wait query "fetch spans" -o json');
    assert.ok(result);
    assert.equal(result.query, "fetch spans");
  });

  it("detects file-based query", () => {
    const result = detectDtctlQuery("dtctl query -f query.dql -o json --plain");
    assert.ok(result);
    assert.equal(result.fileQuery, true);
    assert.equal(result.queryFile, "query.dql");
  });

  it("returns null for dtctl verify query", () => {
    assert.equal(detectDtctlQuery("dtctl verify query something"), null);
  });

  it("returns null for non-dtctl commands", () => {
    assert.equal(detectDtctlQuery("echo hello"), null);
    assert.equal(detectDtctlQuery("dtctl get workflow"), null);
    assert.equal(detectDtctlQuery("dtctl describe notebook foo"), null);
  });

  it("skips -e flag value and extracts quoted query", () => {
    const result = detectDtctlQuery('dtctl query -e zyn "fetch bizevents | filter namespace==\"prod\"" -o json --plain');
    assert.ok(result);
    assert.equal(result.fileQuery, false);
    assert.ok(result.query?.startsWith("fetch bizevents"), `got: ${result.query}`);
  });

  it("skips --env flag value and extracts quoted query", () => {
    const result = detectDtctlQuery('dtctl query --env zyn "fetch logs | limit 10" -o json');
    assert.ok(result);
    assert.ok(result.query?.startsWith("fetch logs"), `got: ${result.query}`);
  });

  it("handles single-quoted query", () => {
    const result = detectDtctlQuery("dtctl query 'fetch logs | filter severity==\"ERROR\"'");
    assert.ok(result);
    assert.equal(result.query, 'fetch logs | filter severity=="ERROR"');
  });

  it("returns null for dtctl apply", () => {
    assert.equal(detectDtctlQuery("dtctl apply -f workflow.json"), null);
  });
});

// ---------------------------------------------------------------------------
// JSON output parsing
// ---------------------------------------------------------------------------

describe("parseQueryOutput — JSON", () => {
  it("parses empty JSON array", () => {
    const r = parseQueryOutput("[]");
    assert.equal(r.recordCount, 0);
    assert.equal(r.confidence, "high");
    assert.deepEqual(r.columns, []);
  });

  it("parses object array", () => {
    const input = JSON.stringify([
      { service: "checkout", count: 42 },
      { service: "auth", count: 7 },
    ]);
    const r = parseQueryOutput(input);
    assert.equal(r.recordCount, 2);
    assert.equal(r.confidence, "high");
    assert.deepEqual(r.columns, ["service", "count"]);
    assert.deepEqual(r.rows[0], ["checkout", 42]);
    assert.deepEqual(r.rows[1], ["auth", 7]);
  });

  it("parses single-object JSON", () => {
    const r = parseQueryOutput(JSON.stringify({ total: 100 }));
    assert.equal(r.recordCount, 1);
    assert.deepEqual(r.columns, ["total"]);
    assert.deepEqual(r.rows[0], [100]);
  });

  it("handles missing fields across rows", () => {
    const input = JSON.stringify([
      { a: 1, b: 2 },
      { a: 3 },
    ]);
    const r = parseQueryOutput(input);
    assert.equal(r.columns.length, 2);
    assert.equal(r.rows[1]![1], null);
  });
});

// ---------------------------------------------------------------------------
// Text table parsing
// ---------------------------------------------------------------------------

describe("parseQueryOutput — text table", () => {
  it("parses simple fixed-width table", () => {
    const table = [
      "service    count",
      "---------- -----",
      "checkout   42   ",
      "auth       7    ",
    ].join("\n");
    const r = parseQueryOutput(table);
    assert.equal(r.confidence, "medium");
    assert.equal(r.recordCount, 2);
    assert.ok(r.columns.includes("service"));
    assert.ok(r.columns.includes("count"));
  });
});

// ---------------------------------------------------------------------------
// Unsupported / edge cases
// ---------------------------------------------------------------------------

describe("parseQueryOutput — edge cases", () => {
  it("returns empty high-confidence result for empty stdout", () => {
    const r = parseQueryOutput("");
    assert.equal(r.recordCount, 0);
    assert.equal(r.confidence, "high");
  });

  it("returns low-confidence for unrecognized format", () => {
    const r = parseQueryOutput("some random non-JSON non-table text\nthat spans lines");
    assert.equal(r.confidence, "low");
    assert.equal(r.recordCount, 0);
  });
});

// ---------------------------------------------------------------------------
// Fallback label generation
// ---------------------------------------------------------------------------

describe("fallbackLabel", () => {
  it("produces fetch type + filter values", () => {
    const label = fallbackLabel('fetch logs | filter loglevel=="ERROR" | filter service=="checkout"');
    assert.ok(label.includes("logs"), `got: ${label}`);
    assert.ok(label.includes("ERROR"), `got: ${label}`);
    assert.ok(label.includes("checkout"), `got: ${label}`);
  });

  it("includes count when present", () => {
    const label = fallbackLabel('fetch bizevents | filter namespace=="prod" | count()');
    assert.ok(label.includes("bizevents"), `got: ${label}`);
    assert.ok(label.includes("prod"), `got: ${label}`);
    assert.ok(label.includes("count"), `got: ${label}`);
  });

  it("includes by-column for summarize queries", () => {
    const label = fallbackLabel("fetch spans | summarize count() by serviceName");
    assert.ok(label.includes("spans"), `got: ${label}`);
    assert.ok(label.includes("serviceName"), `got: ${label}`);
  });

  it("uses context hint when DQL is generic", () => {
    // Query has no filters, so hint words fill in the gap
    const label = fallbackLabel(
      "fetch bizevents | count()",
      "How many findings are there for namespace kube-system?",
    );
    assert.ok(label.includes("bizevents"), `got: ${label}`);
    assert.ok(
      label.includes("findings") || label.includes("kube-system") || label.includes("namespace"),
      `expected hint words in label, got: ${label}`,
    );
  });

  it("does not use hint when DQL already has specific filter values", () => {
    const label = fallbackLabel(
      'fetch bizevents | filter namespace=="security" | count()',
      "How many findings are there for namespace security?",
    );
    // DQL-derived parts should be enough; label should be compact
    assert.ok(label.includes("security"), `got: ${label}`);
    assert.ok(label.length <= 30, `too long: ${label}`);
  });

  it("never returns just the tenant name from a -e flag", () => {
    // parser fix ensures 'zyn' is never passed as the query,
    // but guard against it anyway
    const label = fallbackLabel("fetch bizevents | filter namespace==\"production\"");
    assert.notEqual(label, "zyn");
    assert.ok(label.length > 3, `got: ${label}`);
  });

  it("truncates gracefully at 30 chars", () => {
    const label = fallbackLabel("fetch logs | filter service==".padEnd(80, "x"));
    assert.ok(label.length <= 30, `got length ${label.length}: ${label}`);
  });
});


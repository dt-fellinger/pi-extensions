/**
 * DQL query command detection and output parsing for the Query Tree module.
 *
 * Two responsibilities:
 *  1. Detect whether a bash command is a capturable `dtctl query` invocation.
 *  2. Parse stdout into structured columns/rows.
 */

import type { CaptureConfidence } from "../../core/types.js";

// ---------------------------------------------------------------------------
// Command detection
// ---------------------------------------------------------------------------

export interface DetectedQuery {
  /** The DQL query string, if recoverable from the command. */
  query: string | null;
  /** Whether this is a file-based query (-f flag). */
  fileQuery: boolean;
  /** File path for -f queries. */
  queryFile?: string;
}

/**
 * Returns a DetectedQuery if the command is a supported `dtctl query` or
 * `dtctl wait query` invocation, or null if it should not be captured.
 *
 * Explicitly excluded:
 *   - `dtctl verify query ...`
 *   - any other dtctl subcommand
 *   - failed commands (caller must check exit code)
 */
export function detectDtctlQuery(command: string): DetectedQuery | null {
  // Strip leading whitespace / env var assignments (simple cases only).
  const trimmed = command.trim();

  // Exclude `dtctl verify query`.
  if (/\bdtctl\s+verify\s+query\b/.test(trimmed)) {
    return null;
  }

  // Match `dtctl [wait] query ...`
  // Supports optional `wait` subcommand before `query`.
  const match = trimmed.match(
    /\bdtctl(?:\s+wait)?\s+query\b(.*)/s,
  );
  if (!match) return null;

  const rest = match[1] ?? "";

  // File-based query: -f <path>
  const fileMatch = rest.match(/(?:^|\s)-f\s+(['"]?)(\S+)\1/);
  if (fileMatch) {
    return { query: null, fileQuery: true, queryFile: fileMatch[2] };
  }

  // Strip known flag-value pairs so we don't mistake option values for the query.
  const stripped = rest.replace(
    /\s+(?:-e|--env|-o|--output|-p|--profile|--timeout)(?:=\S+|\s+\S+)/g,
    "",
  );

  // Find the first quoted string (the DQL query is always quoted in practice).
  // Scan left-to-right so an outer single-quote isn't confused with double-quotes inside it.
  const firstQuoteIdx = stripped.search(/["']/);
  if (firstQuoteIdx !== -1) {
    const quoteChar = stripped[firstQuoteIdx];
    const re = quoteChar === '"'
      ? /"((?:[^"\\]|\\[\s\S])*)"/
      : /'((?:[^'\\]|\\[\s\S])*)'/;
    const m = stripped.slice(firstQuoteIdx).match(re);
    if (m) return { query: m[1] ?? null, fileQuery: false };
  }

  // No quoted string — take the first remaining non-flag word.
  const wordMatch = stripped.trimStart().match(/^([^-\s]\S*)/);
  if (wordMatch) return { query: wordMatch[1] ?? null, fileQuery: false };

  // Command present but query text not recoverable.
  return { query: null, fileQuery: false };

  // Command present but query text not recoverable.
  return { query: null, fileQuery: false };
}

// ---------------------------------------------------------------------------
// Output parsing
// ---------------------------------------------------------------------------

export interface ParsedOutput {
  columns: string[];
  rows: unknown[][];
  recordCount: number;
  confidence: CaptureConfidence;
}

/**
 * Parse the stdout of a dtctl query command.
 *
 * Tries JSON first (high confidence), falls back to text table (medium),
 * and returns an empty result for anything else (low).
 */
export function parseQueryOutput(stdout: string): ParsedOutput {
  const trimmed = stdout.trim();

  if (!trimmed) {
    return { columns: [], rows: [], recordCount: 0, confidence: "high" };
  }

  // JSON array output (-o json --plain)
  if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
    const json = tryParseJson(trimmed);
    if (json !== null) {
      return parseJsonOutput(json);
    }
  }

  // Text table fallback
  const table = tryParseTextTable(trimmed);
  if (table) {
    return { ...table, confidence: "medium" };
  }

  // Unknown format — metadata-only node
  return { columns: [], rows: [], recordCount: 0, confidence: "low" };
}

// ---------------------------------------------------------------------------
// JSON output parsing
// ---------------------------------------------------------------------------

function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function parseJsonOutput(parsed: unknown): ParsedOutput {
  // Unwrap common DQL API wrapper shapes:
  //   { records: [...] }  — standard Grail DQL response
  //   { results: [...] }  — some API variants
  //   { data: [...] }     — generic wrapper
  let arr: unknown[];
  if (Array.isArray(parsed)) {
    arr = parsed;
  } else if (parsed !== null && typeof parsed === "object") {
    const obj = parsed as Record<string, unknown>;
    const unwrapped =
      (Array.isArray(obj["records"]) && obj["records"]) ||
      (Array.isArray(obj["results"]) && obj["results"]) ||
      (Array.isArray(obj["data"]) && obj["data"]);
    if (unwrapped) {
      arr = unwrapped as unknown[];
    } else {
      // Single object — treat as one row.
      arr = [parsed];
    }
  } else {
    arr = [parsed];
  }
  if (arr.length === 0) {
    return { columns: [], rows: [], recordCount: 0, confidence: "high" };
  }

  const first = arr[0];
  if (first === null || typeof first !== "object") {
    // Array of primitives — single column "value"
    return {
      columns: ["value"],
      rows: arr.map((v) => [v]),
      recordCount: arr.length,
      confidence: "high",
    };
  }

  // Derive columns from the union of all object keys (order from first object).
  const keySet = new Set<string>();
  for (const row of arr) {
    if (row !== null && typeof row === "object" && !Array.isArray(row)) {
      for (const k of Object.keys(row as Record<string, unknown>)) {
        keySet.add(k);
      }
    }
  }
  const columns = [...keySet];

  const rows = arr.map((row) => {
    if (row !== null && typeof row === "object" && !Array.isArray(row)) {
      return columns.map((col) => (row as Record<string, unknown>)[col] ?? null);
    }
    return columns.map(() => null);
  });

  return { columns, rows, recordCount: arr.length, confidence: "high" };
}

// ---------------------------------------------------------------------------
// Text table parsing
// ---------------------------------------------------------------------------

function tryParseTextTable(text: string): Omit<ParsedOutput, "confidence"> | null {
  const lines = text.split("\n");
  // Find the separator line (all dashes / pipes / plus signs).
  const sepIdx = lines.findIndex((l) => /^[\s|+\-─]+$/.test(l) && l.includes("-"));
  if (sepIdx < 1) return null;

  const headerLine = lines[sepIdx - 1];
  if (!headerLine) return null;

  // Detect column boundaries from the separator line.
  const cols = extractTableColumns(headerLine, lines[sepIdx]!);
  if (!cols || cols.length === 0) return null;

  const dataLines = lines.slice(sepIdx + 1).filter(
    (l) => l.trim() && !/^[\s|+\-─]+$/.test(l),
  );

  const rows = dataLines.map((line) =>
    cols.map(([start, end]) => line.slice(start, end).trim()),
  );

  return { columns: cols.map(([s, e]) => headerLine.slice(s, e).trim()), rows, recordCount: rows.length };
}

/**
 * Derive column [start, end] pairs from the header and separator lines.
 * Works for both pipe-separated and fixed-width tables.
 */
function extractTableColumns(
  header: string,
  separator: string,
): [number, number][] | null {
  // Pipe-separated: split on | 
  if (header.includes("|") || separator.includes("|")) {
    const parts = header.split("|");
    let offset = 0;
    const cols: [number, number][] = [];
    for (const part of parts) {
      if (part.trim()) {
        cols.push([offset, offset + part.length]);
      }
      offset += part.length + 1; // +1 for the pipe
    }
    return cols.length > 0 ? cols : null;
  }

  // Fixed-width: find run boundaries in the separator line.
  const cols: [number, number][] = [];
  let inCol = false;
  let colStart = 0;
  for (let i = 0; i <= separator.length; i++) {
    const ch = separator[i] ?? " ";
    const isDash = ch === "-" || ch === "─";
    if (isDash && !inCol) {
      inCol = true;
      colStart = i;
    } else if (!isDash && inCol) {
      cols.push([colStart, i]);
      inCol = false;
    }
  }
  return cols.length > 0 ? cols : null;
}

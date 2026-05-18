/**
 * Label generator for Query Tree nodes.
 *
 * Tries to call claude-haiku via the Anthropic API for a readable
 * action-oriented label. Falls back to a deterministic extractor when
 * no API key is available or the call fails.
 *
 * Concurrency limits:
 *   - max 3 concurrent label jobs
 *   - max 25 pending jobs in queue
 *   - 8 second timeout per job (real API calls need more breathing room)
 *   - queue overflow → immediate fallback label
 */

const MAX_CONCURRENT = 3;
const MAX_QUEUED = 25;
const TIMEOUT_MS = 8000;

export type LabelCallback = (label: string, state: "ready" | "fallback") => void;

interface LabelJob {
  currentQuery: string;
  previousQuery: string | null;
  contextHint: string | undefined;
  apiKey: string | undefined;
  callback: LabelCallback;
}

let activeCount = 0;
const queue: LabelJob[] = [];

/**
 * Request a label for a query node.
 *
 * contextHint is the text of the user's message that prompted the query.
 * The callback receives the final label and whether it came from a model
 * ("ready") or the deterministic fallback ("fallback").
 */
export function requestLabel(
  currentQuery: string,
  previousQuery: string | null,
  contextHint: string | undefined,
  apiKey: string | undefined,
  callback: LabelCallback,
): void {
  const job: LabelJob = { currentQuery, previousQuery, contextHint, apiKey, callback };

  if (activeCount < MAX_CONCURRENT) {
    runJob(job);
  } else if (queue.length < MAX_QUEUED) {
    queue.push(job);
  } else {
    // Queue full — use fallback immediately.
    callback(fallbackLabel(currentQuery, contextHint), "fallback");
  }
}

async function runJob(job: LabelJob): Promise<void> {
  activeCount++;
  try {
    const label = await withTimeout(generateLabel(job), TIMEOUT_MS);
    job.callback(label, "ready");
  } catch {
    job.callback(fallbackLabel(job.currentQuery, job.contextHint), "fallback");
  } finally {
    activeCount--;
    const next = queue.shift();
    if (next) runJob(next);
  }
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout")), ms);
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

// ---------------------------------------------------------------------------
// Model call
// ---------------------------------------------------------------------------

/**
 * Call the Anthropic API to generate a concise action-oriented label.
 *
 * Model preference: claude-haiku-4-5 → claude-3-5-haiku-20241022
 * Reads ANTHROPIC_API_KEY from the environment.
 * Throws on failure so the caller falls back to the deterministic label.
 */
async function generateLabel(job: LabelJob): Promise<string> {
  const apiKey = job.apiKey ?? process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("no Anthropic API key available");

  const prompt = buildPrompt(job);

  for (const model of ["claude-haiku-4-5", "claude-3-5-haiku-20241022"]) {
    try {
      const text = await callAnthropic(apiKey, model, prompt);
      if (text) return sanitizeLabel(text);
    } catch {
      // Try next model.
    }
  }

  throw new Error("all models failed");
}

async function callAnthropic(apiKey: string, model: string, prompt: string): Promise<string> {
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model,
      max_tokens: 30,
      messages: [{ role: "user", content: prompt }],
    }),
  });

  if (!response.ok) throw new Error(`HTTP ${response.status}`);

  const data = await response.json() as {
    content?: Array<{ type: string; text?: string }>;
  };
  const text = data.content?.find((c) => c.type === "text")?.text?.trim();
  if (!text) throw new Error("empty response");
  return text;
}

/**
 * Build the label generation prompt.
 *
 * The prompt is designed to produce short, action-oriented labels that
 * match what a human analyst would write — "Get all detection findings",
 * "Count ERROR logs by service", "Show span latency for checkout".
 */
function buildPrompt(job: LabelJob): string {
  const lines: string[] = [
    "You are writing a short label for one step in a Dynatrace investigation.",
    "",
    "Rules:",
    "- 3 to 5 words maximum",
    "- Start with an action verb: Get, Find, Count, List, Show, Fetch",
    "- Name the data entity being queried (findings, logs, spans, events, etc.)",
    "- Include the most important qualifier if there is one (a status, a namespace, a service)",
    "- Do NOT mention: time ranges, hours, days, tenant names, the word DQL, or conversational words like 'again' or 'now'",
    "- Reply with ONLY the label — no explanation, no quotes, no punctuation",
    "",
    "Examples of good labels:",
    "  Get detection findings",
    "  Count ERROR logs by service",
    "  List security violations prod",
    "  Show span duration checkout",
    "  Fetch host CPU metrics",
    "",
  ];

  if (job.contextHint) {
    lines.push(`What the user asked: "${job.contextHint.slice(0, 300)}"`);
  }

  const shortQuery = job.currentQuery.length > 200
    ? job.currentQuery.slice(0, 200) + "..."
    : job.currentQuery;
  lines.push(`DQL query: "${shortQuery}"`);

  if (job.previousQuery) {
    const shortPrev = job.previousQuery.length > 150
      ? job.previousQuery.slice(0, 150) + "..."
      : job.previousQuery;
    lines.push(`Previous query: "${shortPrev}"`);
    lines.push("Focus on what is new or different compared to the previous query.");
  }

  lines.push("", "Label:");

  return lines.join("\n");
}

/** Strip quotes, trailing punctuation, and enforce max length. */
function sanitizeLabel(raw: string): string {
  return raw
    .replace(/^["'`]+|["'`]+$/g, "")
    .replace(/[.!?]+$/, "")
    .trim()
    .slice(0, 40);
}

// ---------------------------------------------------------------------------
// Deterministic fallback
// ---------------------------------------------------------------------------

/**
 * Deterministic fallback label used when the model call is unavailable or fails.
 *
 * Priority:
 *   1. User's question (contextHint) — reconstruct a readable phrase.
 *   2. DQL content — fetch type, filter values, aggregation.
 */
export function fallbackLabel(query: string, contextHint?: string): string {
  const q = query.trim();

  // Fetch type — handle dotted names like dt.entity.generic.detection
  // by taking the last meaningful segment.
  const fetchMatch = q.match(/^fetch\s+([\w.]+)/i);
  const rawFetchType = fetchMatch ? fetchMatch[1]! : null;
  const fetchType = rawFetchType
    ? rawFetchType.split(".").filter((s) => !["dt", "entity"].includes(s)).pop() ?? rawFetchType
    : null;

  // Aggregation keyword
  const aggregation =
    /\bcount\s*\(/i.test(q) ? "count" :
    /\btimeseries\b/i.test(q) ? "timeseries" :
    /\bsummarize\b/i.test(q) ? "summarize" :
    null;

  if (contextHint) {
    const hintWords = extractHintKeywords(contextHint);
    const parts: string[] = [];
    if (fetchType && !hintWords.includes(fetchType)) parts.push(fetchType);
    for (const word of hintWords) {
      if (!parts.includes(word)) parts.push(word);
      if (parts.length >= 4) break;
    }
    if (aggregation && !parts.includes(aggregation)) parts.push(aggregation);
    if (parts.length > 0) {
      const label = parts.join(" ");
      return label.length <= 30 ? label : label.slice(0, 27) + "...";
    }
  }

  // No context hint — DQL-only extraction.
  const parts: string[] = [];
  if (fetchType) parts.push(fetchType);

  const filterRe = /\bfilter\b[^|]*?==\s*["']?([A-Za-z0-9_:./\-]+)["']?/gi;
  let m: RegExpExecArray | null;
  // biome-ignore lint: iterating regex matches
  while ((m = filterRe.exec(q)) !== null && parts.length < 4) {
    const val = m[1]!.trim();
    if (val && !parts.includes(val)) parts.push(val);
  }

  if (aggregation) parts.push(aggregation);

  const byMatch = q.match(/\bby\s+([\w.]+)/i);
  if (byMatch && parts.length < 5) parts.push(`by ${byMatch[1]}`);

  if (parts.length > 0) {
    const label = parts.join(" ");
    return label.length <= 30 ? label : label.slice(0, 27) + "...";
  }

  // Last resort: first clause before |, truncated.
  const beforePipe = q.split("|")[0]?.trim() ?? q;
  if (beforePipe.length <= 30) return beforePipe;
  const truncated = beforePipe.slice(0, 30);
  const lastSpace = truncated.lastIndexOf(" ");
  return lastSpace > 10 ? truncated.slice(0, lastSpace) : truncated;
}

/**
 * Extract the most meaningful words from a user's question.
 * Strips stopwords, short words, and noise tokens.
 */
function extractHintKeywords(hint: string): string[] {
  const STOPWORDS = new Set([
    "a", "an", "the", "and", "or", "for", "in", "of", "to", "is", "are",
    "how", "many", "what", "which", "where", "when", "show", "get", "find",
    "list", "give", "me", "us", "can", "do", "does", "there", "by", "with",
    "from", "that", "this", "all", "any", "have", "has", "been", "be", "on",
    "query", "fetch", "run", "execute", "using", "check", "look", "please",
    "use", "dql", "now", "also", "then", "just", "some", "see", "i", "my",
    "its", "their", "our", "want", "would", "like", "need", "try", "let",
    "last", "past", "next", "over", "ago", "again", "same", "more", "too",
    "tenant", "environment", "env",
  ]);

  return hint
    .toLowerCase()
    .replace(/[^a-z0-9\s\-_.]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOPWORDS.has(w) && !/^\d+$/.test(w))
    .slice(0, 5);
}

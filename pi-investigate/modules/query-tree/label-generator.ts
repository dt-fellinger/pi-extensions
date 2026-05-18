/**
 * Label generator for Query Tree nodes.
 *
 * Generates short (≤6-word) labels describing what changed between
 * consecutive queries. Uses a model call when possible, falls back to
 * a deterministic label derived from the query text.
 *
 * Concurrency limits:
 *   - max 3 concurrent label jobs
 *   - max 25 pending jobs in queue
 *   - 3 second timeout per job
 *   - queue overflow → immediate fallback label
 */

const MAX_CONCURRENT = 3;
const MAX_QUEUED = 25;
const TIMEOUT_MS = 3000;

export type LabelCallback = (label: string, state: "ready" | "fallback") => void;

interface LabelJob {
  currentQuery: string;
  previousQuery: string | null;
  contextHint: string | undefined;
  callback: LabelCallback;
}

let activeCount = 0;
const queue: LabelJob[] = [];

/**
 * Request a label for a query node.
 *
 * contextHint is the text of the user's message that prompted the query.
 * It is incorporated into the fallback label when the DQL alone is ambiguous.
 */
export function requestLabel(
  currentQuery: string,
  previousQuery: string | null,
  contextHint: string | undefined,
  callback: LabelCallback,
): void {
  const job: LabelJob = { currentQuery, previousQuery, contextHint, callback };

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

/**
 * Attempt to generate a label using a model. If the model isn't available
 * or the call fails, throws so the caller can use the fallback.
 *
 * Model preference order per spec:
 *   1. claude-haiku-4-5
 *   2. claude-3-5-haiku-20241022
 *   3. any available model (stub — not yet wired to a live provider)
 *
 * NOTE: Pi extensions don't expose a direct "call a model" API. This is
 * implemented as a stub that always throws, causing the fallback label to
 * be used. A future enhancement can wire this to fetch() against the
 * provider's base URL using the API key from ctx.modelRegistry.
 */
async function generateLabel(_job: LabelJob): Promise<string> {
  // Stub: always fall through to fallback.
  throw new Error("model label generation not yet implemented");
}

/**
 * Deterministic fallback label for a query node.
 *
 * Priority:
 *   1. User's question (contextHint) — most readable, always preferred.
 *      Key nouns are extracted from the question and joined with the
 *      fetch type and any aggregation keyword from the DQL.
 *   2. DQL content — used only when no context hint is available.
 *      Extracts fetch type, filter comparison values, and aggregation.
 */
export function fallbackLabel(query: string, contextHint?: string): string {
  const q = query.trim();

  // Fetch type from DQL ("logs", "bizevents", "spans", etc.)
  const fetchMatch = q.match(/^fetch\s+(\w+)/i);
  const fetchType = fetchMatch ? fetchMatch[1]! : null;

  // Aggregation keyword from DQL
  const aggregation =
    /\bcount\s*\(/i.test(q) ? "count" :
    /\btimeseries\b/i.test(q) ? "timeseries" :
    /\bsummarize\b/i.test(q) ? "summarize" :
    null;

  if (contextHint) {
    // Build label from the user's question first.
    const hintWords = extractHintKeywords(contextHint);
    const parts: string[] = [];
    if (fetchType) parts.push(fetchType);
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

  // No context hint — fall back to DQL-derived content.
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
 * Extract meaningful keywords from a user's question for use in labels.
 * Strips stopwords and short words.
 */
function extractHintKeywords(hint: string): string[] {
  const STOPWORDS = new Set([
    "a", "an", "the", "and", "or", "for", "in", "of", "to", "is", "are",
    "how", "many", "what", "which", "where", "when", "show", "get", "find",
    "list", "give", "me", "us", "can", "do", "does", "there", "by", "with",
    "from", "that", "this", "all", "any", "have", "has", "been", "be", "on",
    "query", "fetch", "run", "execute", "using", "check", "look", "please",
  ]);

  return hint
    .toLowerCase()
    .replace(/[^a-z0-9\s\-_.]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOPWORDS.has(w))
    .slice(0, 5);
}

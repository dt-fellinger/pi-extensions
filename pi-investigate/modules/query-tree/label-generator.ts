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
  callback: LabelCallback;
}

let activeCount = 0;
const queue: LabelJob[] = [];

/**
 * Request a label for a query node. The callback is called asynchronously
 * with either an AI-generated label ("ready") or a fallback ("fallback").
 *
 * The caller should initially set labelState to "pending" and update the
 * node when the callback fires.
 */
export function requestLabel(
  currentQuery: string,
  previousQuery: string | null,
  callback: LabelCallback,
): void {
  const job: LabelJob = { currentQuery, previousQuery, callback };

  if (activeCount < MAX_CONCURRENT) {
    runJob(job);
  } else if (queue.length < MAX_QUEUED) {
    queue.push(job);
  } else {
    // Queue full — use fallback immediately.
    callback(fallbackLabel(currentQuery), "fallback");
  }
}

async function runJob(job: LabelJob): Promise<void> {
  activeCount++;
  try {
    const label = await withTimeout(generateLabel(job), TIMEOUT_MS);
    job.callback(label, "ready");
  } catch {
    job.callback(fallbackLabel(job.currentQuery), "fallback");
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
 * Deterministic fallback label.
 *
 * Extracts the first meaningful segment after `fetch` in the query and
 * truncates to 30 characters.
 *
 * Examples:
 *   "fetch logs | filter ..."     → "fetch logs"
 *   "fetch spans | ..."           → "fetch spans"
 *   "timeseries avg(...)"         → "timeseries avg(..."
 */
export function fallbackLabel(query: string): string {
  const q = query.trim();

  // Try to grab the first meaningful clause up to the first pipe.
  const beforePipe = q.split("|")[0]?.trim() ?? q;

  // Truncate to 30 chars, avoiding mid-word cuts where possible.
  if (beforePipe.length <= 30) return beforePipe;

  const truncated = beforePipe.slice(0, 30);
  const lastSpace = truncated.lastIndexOf(" ");
  return lastSpace > 10 ? truncated.slice(0, lastSpace) : truncated;
}

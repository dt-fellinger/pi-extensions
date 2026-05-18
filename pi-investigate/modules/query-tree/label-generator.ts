/**
 * Label generator for Query Tree nodes.
 *
 * Picks the cheapest available model from pi's own model registry,
 * verifies auth is configured, and calls it with a tight prompt.
 * Falls back to a deterministic label if no model is available or the
 * call fails.
 *
 * Concurrency limits:
 *   - max 3 concurrent label jobs
 *   - max 25 pending jobs in queue
 *   - 8 second timeout per job
 *   - queue overflow → immediate fallback
 */

import type { ModelRegistry } from "@earendil-works/pi-coding-agent";

const MAX_CONCURRENT = 3;
const MAX_QUEUED = 25;
const TIMEOUT_MS = 8000;

export type LabelCallback = (label: string, state: "ready" | "fallback") => void;

// ---------------------------------------------------------------------------
// Model info — resolved once per query at tool_call time
// ---------------------------------------------------------------------------

export interface LabelModelInfo {
  modelId: string;
  api: string;
  baseUrl: string;
  apiKey: string | undefined;
  headers: Record<string, string> | undefined;
}

/**
 * Resolve the cheapest available non-reasoning model from pi's registry.
 * Returns null if nothing is configured.
 */
export async function resolveLabelModel(
  registry: ModelRegistry,
): Promise<LabelModelInfo | null> {
  const available = registry.getAvailable();

  // Only models that accept text and don't require heavy reasoning budgets.
  const candidates = available
    .filter((m) => m.input.includes("text") && !m.reasoning)
    .sort((a, b) => a.cost.input - b.cost.input);

  for (const model of candidates) {
    const auth = await registry.getApiKeyAndHeaders(model).catch(() => null);
    if (!auth || !auth.ok) continue;

    return {
      modelId: model.id,
      api: model.api,
      baseUrl: model.baseUrl,
      apiKey: auth.apiKey,
      headers: auth.headers,
    };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Queue
// ---------------------------------------------------------------------------

interface LabelJob {
  currentQuery: string;
  previousQuery: string | null;
  contextHint: string | undefined;
  modelInfo: LabelModelInfo | null;
  callback: LabelCallback;
}

let activeCount = 0;
const queue: LabelJob[] = [];

export function requestLabel(
  currentQuery: string,
  previousQuery: string | null,
  contextHint: string | undefined,
  modelInfo: LabelModelInfo | null,
  callback: LabelCallback,
): void {
  const job: LabelJob = { currentQuery, previousQuery, contextHint, modelInfo, callback };

  if (activeCount < MAX_CONCURRENT) {
    runJob(job);
  } else if (queue.length < MAX_QUEUED) {
    queue.push(job);
  } else {
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
// Model call — dispatches based on API type
// ---------------------------------------------------------------------------

async function generateLabel(job: LabelJob): Promise<string> {
  if (!job.modelInfo) throw new Error("no model available");

  const prompt = buildPrompt(job);
  const { api } = job.modelInfo;

  if (api === "anthropic-messages") {
    return callAnthropic(job.modelInfo, prompt);
  }
  if (
    api === "openai-completions" ||
    api === "openai-responses" ||
    api === "azure-openai-responses" ||
    api === "mistral-conversations"
  ) {
    return callOpenAI(job.modelInfo, prompt);
  }
  if (api === "google-generative-ai" || api === "google-vertex") {
    return callGoogle(job.modelInfo, prompt);
  }

  throw new Error(`unsupported API type: ${api}`);
}

// ---------------------------------------------------------------------------
// Anthropic messages API
// ---------------------------------------------------------------------------

async function callAnthropic(info: LabelModelInfo, prompt: string): Promise<string> {
  // pi's built-in baseUrl for Anthropic is "https://api.anthropic.com" (no /v1).
  // The messages endpoint lives at /v1/messages.
  const url = `${info.baseUrl}/v1/messages`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "anthropic-version": "2023-06-01",
      ...(info.apiKey ? { "x-api-key": info.apiKey } : {}),
      ...(info.headers ?? {}),
    },
    body: JSON.stringify({
      model: info.modelId,
      max_tokens: 30,
      messages: [{ role: "user", content: prompt }],
    }),
  });

  if (!response.ok) throw new Error(`Anthropic HTTP ${response.status}`);
  const data = await response.json() as { content?: Array<{ type: string; text?: string }> };
  const text = data.content?.find((c) => c.type === "text")?.text?.trim();
  if (!text) throw new Error("empty response");
  return sanitizeLabel(text);
}

// ---------------------------------------------------------------------------
// OpenAI-compatible API
// ---------------------------------------------------------------------------

async function callOpenAI(info: LabelModelInfo, prompt: string): Promise<string> {
  const response = await fetch(`${info.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(info.apiKey ? { "authorization": `Bearer ${info.apiKey}` } : {}),
      ...(info.headers ?? {}),
    },
    body: JSON.stringify({
      model: info.modelId,
      max_tokens: 30,
      messages: [{ role: "user", content: prompt }],
    }),
  });

  if (!response.ok) throw new Error(`OpenAI HTTP ${response.status}`);
  const data = await response.json() as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const text = data.choices?.[0]?.message?.content?.trim();
  if (!text) throw new Error("empty response");
  return sanitizeLabel(text);
}

// ---------------------------------------------------------------------------
// Google Generative AI
// ---------------------------------------------------------------------------

async function callGoogle(info: LabelModelInfo, prompt: string): Promise<string> {
  const url = `${info.baseUrl}/models/${info.modelId}:generateContent${info.apiKey ? `?key=${info.apiKey}` : ""}`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(info.headers ?? {}),
    },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: { maxOutputTokens: 30 },
    }),
  });

  if (!response.ok) throw new Error(`Google HTTP ${response.status}`);
  const data = await response.json() as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  };
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
  if (!text) throw new Error("empty response");
  return sanitizeLabel(text);
}

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

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

function sanitizeLabel(raw: string): string {
  return raw
    .replace(/^["'`*\-]+|["'`*\-]+$/g, "")
    .replace(/[.!?]+$/, "")
    .trim()
    .slice(0, 40);
}

// ---------------------------------------------------------------------------
// Deterministic fallback
// ---------------------------------------------------------------------------

export function fallbackLabel(query: string, contextHint?: string): string {
  const q = query.trim();

  // Fetch type — handle dotted names like dt.entity.generic.detection
  const fetchMatch = q.match(/^fetch\s+([\w.]+)/i);
  const rawFetchType = fetchMatch ? fetchMatch[1]! : null;
  const fetchType = rawFetchType
    ? rawFetchType.split(".").filter((s) => !["dt", "entity"].includes(s)).pop() ?? rawFetchType
    : null;

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

  // DQL-only fallback
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

  const beforePipe = q.split("|")[0]?.trim() ?? q;
  if (beforePipe.length <= 30) return beforePipe;
  const truncated = beforePipe.slice(0, 30);
  const lastSpace = truncated.lastIndexOf(" ");
  return lastSpace > 10 ? truncated.slice(0, lastSpace) : truncated;
}

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

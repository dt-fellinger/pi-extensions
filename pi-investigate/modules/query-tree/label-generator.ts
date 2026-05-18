/**
 * Label generator for Query Tree nodes.
 *
 * Uses @earendil-works/pi-ai's completeSimple() which handles all provider
 * formats (Anthropic, OpenAI, Google, Copilot, Bedrock, etc.) internally.
 * Auth is resolved from pi's model registry and passed via StreamOptions.
 *
 * Concurrency limits:
 *   - max 3 concurrent label jobs
 *   - max 25 pending jobs in queue
 *   - 8 second timeout per job
 *   - queue overflow → immediate fallback
 */

import { completeSimple } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
export { fallbackLabel } from "./label-fallback.js";

const MAX_CONCURRENT = 3;
const MAX_QUEUED = 25;
const TIMEOUT_MS = 8000;

export type LabelCallback = (label: string, state: "ready" | "fallback") => void;

// ---------------------------------------------------------------------------
// Model resolution — once per session
// ---------------------------------------------------------------------------

export interface LabelModelInfo {
  model: import("@earendil-works/pi-ai").Model<import("@earendil-works/pi-ai").Api>;
  apiKey: string | undefined;
  headers: Record<string, string> | undefined;
}

/**
 * Score a model for label generation suitability. Lower is better.
 * Prefers small/fast models over large/reasoning ones.
 */
function labelModelScore(model: { id: string; cost: { input: number } }): number {
  const id = model.id.toLowerCase();
  if (/\b(haiku|flash|mini|small|nano|lite|tiny)\b/.test(id)) return 0;
  if (/\b(sonnet|medium)\b/.test(id)) return 2;
  if (/\b(pro|ultra|large|max|opus|plus|\d{2,3}b)\b/.test(id)) return 10;
  return 1;
}

/**
 * Resolve the best available model for label generation.
 * Prefers small/fast models regardless of cost (handles subscription pricing).
 * Returns null if nothing with working auth is found.
 */
export async function resolveLabelModel(
  registry: ModelRegistry,
): Promise<LabelModelInfo | null> {
  const available = registry.getAvailable();

  const candidates = available
    .filter((m) => m.input.includes("text") && !m.reasoning)
    .sort((a, b) => {
      const scoreDiff = labelModelScore(a) - labelModelScore(b);
      return scoreDiff !== 0 ? scoreDiff : a.cost.input - b.cost.input;
    });

  for (const model of candidates) {
    const auth = await registry.getApiKeyAndHeaders(model).catch(() => null);
    if (!auth || !auth.ok) continue;
    return { model, apiKey: auth.apiKey, headers: auth.headers };
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
// Model call — delegates entirely to @earendil-works/pi-ai
// ---------------------------------------------------------------------------

async function generateLabel(job: LabelJob): Promise<string> {
  if (!job.modelInfo) throw new Error("no model available");

  const { model, apiKey, headers } = job.modelInfo;
  const prompt = buildPrompt(job);

  const result = await completeSimple(
    model,
    {
      messages: [{ role: "user", content: prompt, timestamp: Date.now() }],
    },
    {
      maxTokens: 50,
      ...(apiKey ? { apiKey } : {}),
      ...(headers ? { headers } : {}),
    },
  );

  const text = result.content
    .filter((c) => c.type === "text")
    .map((c) => (c as { type: "text"; text: string }).text)
    .join("")
    .trim();

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
// Debug helper
// ---------------------------------------------------------------------------

/** Run a live label generation test and return the result or error message. */
export async function testLabelCall(
  modelInfo: LabelModelInfo,
  testQuery = "fetch events | filter event.type == \"SECURITY_FINDING\" | limit 10",
  testHint = "show me security findings",
): Promise<{ label: string; source: "model" | "error"; error?: string }> {
  const job: LabelJob = {
    currentQuery: testQuery,
    previousQuery: null,
    contextHint: testHint,
    modelInfo,
    callback: () => {},
  };
  try {
    const label = await generateLabel(job);
    return { label, source: "model" };
  } catch (e) {
    return { label: fallbackLabel(testQuery, testHint), source: "error", error: String(e) };
  }
}

// ---------------------------------------------------------------------------
// Deterministic fallback
// ---------------------------------------------------------------------------

import { fallbackLabel } from "./label-fallback.js";


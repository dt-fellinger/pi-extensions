/**
 * Deterministic fallback label logic — no external dependencies.
 *
 * Kept in a separate file so it can be imported by tests without
 * pulling in @earendil-works/pi-ai (which is only available inside pi).
 */

export function fallbackLabel(query: string, contextHint?: string): string {
  const q = query.trim();

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

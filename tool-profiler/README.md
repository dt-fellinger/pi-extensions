# tool-profiler

A Pi extension that profiles every tool call so you can see which ones are driving context growth and model cost — and get an immediate warning when a single call is unusually expensive.

## What it does

Every time the LLM calls a tool, the extension:

1. Records the call with sanitized metadata (no raw output stored).
2. Scores it on context impact (what fraction of the context window did this result consume?) and estimated downstream cost.
3. Emits a live notification if the severity is high enough.
4. Refines the cost estimate once the next assistant response arrives with actual usage data.

At any point you can run `/tool-stats` to see a ranked breakdown of the worst individual calls, the recurring patterns that explain the most waste, and a per-tool rollup.

Cross-session data is accumulated in a compact JSON aggregate so trends are visible across many sessions, not just the current one.

## Commands

```
/tool-stats               Current-session summary (default)
/tool-stats session       Same as above
/tool-stats overall       Cross-session aggregate view
/tool-stats tool <name>   Filter session stats to one tool (e.g. tool bash)
```

### Example output

```
=== Tool Stats: Current Session ===

── Top Offending Calls ──────────────────────────────────────────
  ⚠⚠ 1.  bash         grep -r "TODO" . --include="*.ts"      ~18.4k   sev:0.91  cost:$0.004
              factors: noisy-bash-output, large-result
     2.  read         "/src/mega-file.ts"                     ~9.1k    sev:0.72
              factors: large-result, broad-read-range
  ⚠  3.  bash         npm test 2>&1                           ~5.8k    sev:0.55
              factors: noisy-bash-output

── Biggest Factors ──────────────────────────────────────────────
  noisy-bash-output                calls:   3  total-sev:2.17
    → Pipe through grep, head, or tail to reduce output volume.
  large-result                     calls:   4  total-sev:1.88
    → Use offset/limit or grep to reduce result size.
  broad-read-range                 calls:   2  total-sev:0.95
    → Add offset and limit to avoid reading entire large files.

── By Tool ──────────────────────────────────────────────────────
  tool          calls    tokens       est.cost    avg.sev   max.sev
  ---------------------------------------------------------------
  bash              5     ~34.5k       $0.007        0.63      0.91
  read              4     ~18.2k       $0.003        0.47      0.72
```

In interactive mode the output renders in a scrollable overlay. Press `j`/`k` or arrow keys to scroll, `Esc` or `q` to close.

## Live warnings

After each tool result, if the combined severity score crosses 0.50 the extension emits a notification:

```
High-impact tool call: bash added ~18.4k tokens  [critical]
  factors: noisy-bash-output, large-result
  → Pipe through grep, head, or tail to reduce output volume.
```

Two bands:

| Band | Threshold | Notification level |
|---|---|---|
| warning | ≥ 0.50 | warning |
| critical | ≥ 0.75 | error |

Normal calls (< 0.50) are tracked silently with no notification.

Identical warnings for the same tool + factor combination are suppressed for 5 minutes to avoid noise.

## Scoring

Each tool call is assigned two normalised scores (0–1):

- **Context impact** — how large a fraction of the context window does the result consume? Scores 1.0 at 15% or more of the window.
- **Cost impact** — how many tokens did the result add? Scores 1.0 at 12 000 tokens or more.

Combined severity is a 50/50 blend of those two scores, plus small penalties for tool-specific bad patterns:

| Penalty | Condition |
|---|---|
| +0.08 | `noisy-bash-output` |
| +0.08 | `truncated-but-expensive` |
| +0.08 | `repeated-medium-cost` |
| +0.05 | `broad-read-range` |

## Factor tags

Each scored call is tagged with the specific causes of its severity:

| Tag | Meaning |
|---|---|
| `large-result` | Result exceeded ~8 000 tokens |
| `high-context-share` | Result consumed more than 8% of the context window |
| `likely-high-downstream-cost` | Result exceeded ~4 000 tokens, inflating the next request |
| `truncated-but-expensive` | Output was truncated but still larger than ~3 000 tokens |
| `broad-read-range` | `read` called without `offset`/`limit` on a large file |
| `noisy-bash-output` | `bash` output exceeded 100 lines |
| `repeated-medium-cost` | Same tool called at least twice previously with severity > 0.35 |

## Cost attribution

Exact per-tool billing is not exposed by providers, so attribution is heuristic. When an assistant response arrives with usage data, the input-side cost is distributed proportionally across the tool results that fed that request, weighted by estimated token contribution.

Cost figures in `/tool-stats` are estimates sufficient for ranking, not billing.

## Privacy

The extension never stores raw tool output. Persisted data contains only:

- Tool name
- Short sanitized argument summary (command truncated to 80 chars, path only for reads)
- Token and byte counts
- Severity scores
- Factor tags

The cross-session aggregate at `aggregate.json` follows the same rules.

## Installation

The extension is auto-discovered from `~/.pi/agent/extensions/`. No further setup is needed. To activate it in a running session, run `/reload`.

## Files

| File | Purpose |
|---|---|
| `index.ts` | Entry point — event hooks and `/tool-stats` command |
| `scorer.ts` | Token estimation, factor-tag assignment, severity calculation |
| `storage.ts` | Cross-session aggregate persistence |
| `reporter.ts` | `/tool-stats` text formatting |
| `warnings.ts` | Live warning formatting and dedup |
| `types.ts` | Shared types |
| `test.ts` | 40-test suite |
| `aggregate.json` | Runtime-generated cross-session aggregate (not committed) |

## Running tests

```bash
cd ~/.pi/agent/extensions/tool-profiler
npx tsx test.ts
```

All 40 tests should pass with no dependencies beyond tsx.

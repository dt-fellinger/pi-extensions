# tool-profiler — agent context

This is a Pi extension. Read this before making any changes.

## Test command

```bash
cd ~/.pi/agent/extensions/tool-profiler
npx tsx test.ts
```

All 40 tests must pass before committing. The test file has no build step — tsx runs it directly.

## Architecture

| File | Role |
|---|---|
| `index.ts` | Extension entry point. Wires Pi events to the other modules. Contains no scoring or formatting logic. |
| `scorer.ts` | Pure functions only. No I/O, no Pi API calls. Token estimation, factor-tag assignment, severity scoring. |
| `storage.ts` | Cross-session JSON aggregate. Reads/writes `aggregate.json` at the extension root. |
| `reporter.ts` | Plain-text formatting for `/tool-stats`. No Pi API calls — returns `string[]`. |
| `warnings.ts` | Live warning formatting plus in-memory dedup map. Stateful (the dedup map) but reset on `session_start`. |
| `types.ts` | Shared types only. No logic. |

Keep scoring logic in `scorer.ts`, persistence in `storage.ts`, and formatting in `reporter.ts`. `index.ts` should stay thin.

## TypeScript import style

Imports between files in this directory must use the `.ts` extension:

```typescript
import { buildRecord } from "./scorer.ts";   // correct
import { buildRecord } from "./scorer";       // wrong — breaks jiti resolution
```

Pi loads extensions via jiti, which resolves TypeScript files natively. Extensionless imports will fail at runtime.

## Scoring thresholds (scorer.ts)

These constants are deliberate and calibrated. Change them only with a concrete reason and updated tests:

| Constant | Value | Meaning |
|---|---|---|
| `CHARS_PER_TOKEN` | 3.5 | chars-per-token estimate (conservative for code + prose mix) |
| `LARGE_RESULT_TOKENS` | 8 000 | above this → `large-result` tag |
| `HIGH_CONTEXT_SHARE` | 0.08 | 8% of window → `high-context-share` tag |
| `DOWNSTREAM_COST_TOKENS` | 4 000 | above this → `likely-high-downstream-cost` tag |
| `NOISY_BASH_LINES` | 100 | bash output lines above this → `noisy-bash-output` tag |
| `CONTEXT_NORMALISE_AT` | 0.15 | 15% of window → context score 1.0 |
| `COST_NORMALISE_AT` | 12 000 | 12 k tokens → cost score 1.0 |
| `WARNING_THRESHOLD` | 0.50 | combined severity above this → warning band |
| `CRITICAL_THRESHOLD` | 0.75 | combined severity above this → critical band |
| `DEDUP_WINDOW_MS` | 5 min | identical warnings suppressed within this window |

## Hard privacy invariant

Raw tool output must never appear in any persisted data. This applies to:

- `pi.appendEntry()` calls in `index.ts`
- anything written to `aggregate.json`

`buildRecord` in `scorer.ts` is the boundary — it takes content blocks as input and emits only numeric metrics and tags. Tests cover this explicitly (`buildRecord does not include raw tool output text in the record`). If you change what gets persisted, add a test.

## Session state reconstruction

The extension uses `ctx.sessionManager.getBranch()` (not `getEntries()`) when reconstructing state on `session_start` and `session_tree`. `getBranch()` returns only entries on the active branch; `getEntries()` includes dead branches and would produce wrong results after tree navigation or forking.

## aggregate.json

Generated at runtime on `session_shutdown`. Not committed (see `.gitignore`). The file is written atomically via a `.tmp` rename. Schema is versioned — a version mismatch causes the aggregate to reset cleanly rather than fail.

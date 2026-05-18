# pi-investigate Implementation Task Breakdown

**Date:** 2026-05-18
**Based on:** `docs/2026-05-13-dql-query-tree-design.md`

## 1. Core skeleton

Files, in order:
- `package.json` - extension package metadata and runtime dependencies
- `core/types.ts` - shared types for nodes, config, events, and cache payloads
- `core/config.ts` - load and validate `~/.pi/config/pi-investigate.json`
- `core/events.ts` - typed internal event bus
- `core/state.ts` - shared investigation state and state helpers
- `index.ts` - extension entry point, module wiring, event registration

Done when:
- the extension loads without errors
- config loads with sane defaults when no file exists
- session and tool hooks register successfully

## 2. Query capture

Files, in order:
- `modules/query-tree/parser.ts` - parse supported `dtctl query` command shapes and outputs
- `modules/query-tree/tracker.ts` - create pending-query records and resolve them on tool results
- `modules/query-tree/parser.test.ts` - fixtures for supported, best-effort, and unsupported command shapes

Done when:
- supported `dtctl query` commands create pending records
- failed or unsupported commands do not create nodes
- parser tests cover JSON, text table, and unsupported shell cases

## 3. Persistence and reconstruction

Files, in order:
- `modules/query-tree/result-store.ts` - write and read cached full results
- `modules/query-tree/index.ts` - persist nodes, rebuild session-global tree, register reconstruction hooks
- `modules/query-tree/reconstruction.test.ts` - replay tests for startup rebuild and orphan handling

Done when:
- successful queries append `investigate:query-tree:node` entries
- full results are cached with `schemaVersion: 1`
- restart or `session_tree` rebuild restores the same tree shape

## 4. Label generation

Files, in order:
- `modules/query-tree/label-generator.ts` - model selection, queueing, timeout, and fallback labeling

Done when:
- max concurrency is capped at 3
- pending labels render as pending state
- timeout or queue overflow produces deterministic fallback labels

## 5. Tree overlay

Files, in order:
- `modules/query-tree/tree-state.ts` - build ordered parent-child view state from reconstructed nodes
- `modules/query-tree/tree-overlay.ts` - render tree, manage selection, search, preview, and branch filter

Done when:
- the overlay renders the full session-global tree
- label and query search work
- branch-local filtering works without changing stored state
- selecting a node returns its ID for navigation

## 6. Table viewer

Files, in order:
- `modules/query-tree/table-viewer.ts` - full-screen result viewer with lazy loading and export

Done when:
- rows and columns scroll correctly
- sort and search work on loaded data
- cache-backed results load first and inline preview is used as fallback
- CSV, JSON, and TSV export complete without crashing the viewer

## 7. Commands and integration

Files, in order:
- `modules/query-tree/index.ts` - register `/inv tree`, `/inv mark`, `/inv cleanup`, and `Ctrl+T`
- `ui/status.ts` - aggregate and display investigation status in the footer

Done when:
- `/inv tree` opens the overlay
- `/inv mark` adds a manual node at the current investigation cursor
- `/inv cleanup` removes orphaned cache data
- `Ctrl+T` triggers the overlay through the queued command workaround
- footer status updates as nodes are added

## 8. Polish and verification

Files, in order:
- `modules/query-tree/integration.test.ts` - late-result, parent-assignment, and branch-filter scenarios
- `modules/query-tree/perf.test.ts` or equivalent benchmark harness - reconstruction and overlay timing checks

Done when:
- rename persistence is verified through reconstruction
- degraded behavior is covered for missing cache, corrupt cache, parse failure, and label failure
- late-arriving results attach to the recorded parent
- cold reconstruction and overlay open meet the stated performance targets

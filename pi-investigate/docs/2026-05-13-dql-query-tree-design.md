# pi-investigate - Investigation Workbench for Pi

**Date:** 2026-05-13  
**Status:** Draft, revised 2026-05-18

## Problem

Security analysts investigate incidents by hopping between DQL queries, logs, tickets, and response tooling. The work is non-linear. You run a query, branch into a hypothesis, check something else, come back, and continue from an earlier point.

Pi already stores session history as a tree, but that tree is not visible or usable as an investigation artifact. There is no structured way to see where the investigation split, what each branch answered, or what still needs follow-up.

`pi-investigate` adds that missing layer. The first feature is a Query Tree for DQL work done through `dtctl`.

## Scope

### In scope for v1

- modular extension skeleton for `pi-investigate`
- Query Tree module only
- automatic capture of successful `dtctl query` executions
- session-persistent tree state and disk-backed result cache
- tree overlay, preview pane, and full-screen table viewer
- manual marker nodes via `/inv mark`
- short labels, with deterministic fallback when model labeling fails
- session-global tree with branch-local filtering
- defined degraded behavior for parse, cache, and label failures

### Out of scope for v1

- case management integrations
- workflow or SOAR integrations
- cross-session investigation history
- result diffing, Notebook export, or LLM context injection

## Solution

`pi-investigate` is a Pi extension with a small shared core and pluggable modules. V1 implements only the Query Tree module.

### Roadmap

| Module | Status |
|--------|--------|
| Query Tree | v1 |
| Other investigation modules | later |

## Architecture

### Extension Structure

```text
~/.pi/agent/extensions/pi-investigate/
├── index.ts
├── package.json
├── core/
│   ├── types.ts
│   ├── state.ts
│   ├── events.ts
│   └── config.ts
├── modules/
│   └── query-tree/
│       ├── index.ts
│       ├── tracker.ts
│       ├── label-generator.ts
│       ├── result-store.ts
│       ├── tree-state.ts
│       ├── tree-overlay.ts
│       ├── table-viewer.ts
│       └── parser.ts
└── ui/
    ├── status.ts
    └── theme.ts
```

### Module Interface

```typescript
interface InvestigateModule {
  name: string;
  description: string;
  init(core: InvestigateCore): void;
  reconstruct(ctx: ExtensionContext): void;
  teardown(): void;
}

interface InvestigateCore {
  pi: ExtensionAPI;
  events: InvestigateEventBus;
  config: InvestigateConfig;
  state: InvestigationState;
}
```

### Shared State

```typescript
interface InvestigationState {
  schemaVersion: 1;
  sessionId: string;
  nodes: Map<string, InvestigationNode>;
  activeModules: string[];
}

type InvestigationNodeData = QueryTreeNodeData;

interface InvestigationNode {
  id: string;
  sessionEntryId: string;
  module: "query-tree" | string;
  type: string;
  label: string;
  timestamp: number;
  parentNodeId: string | null;
  branchHint?: string;
  data: InvestigationNodeData;
}
```

### Internal Event Bus

```typescript
type InvestigateEvents = {
  "node:created": [node: InvestigationNode];
  "node:updated": [node: InvestigationNode];
  "node:selected": [nodeId: string];
  "tree:rebuilt": [];
};

interface InvestigateEventBus {
  emit<K extends keyof InvestigateEvents>(event: K, ...args: InvestigateEvents[K]): void;
  on<K extends keyof InvestigateEvents>(event: K, handler: (...args: InvestigateEvents[K]) => void): void;
}
```

### Persistence

- session entries use `pi.appendEntry("investigate:<module>:<type>", data)`
- disk cache lives at `~/.pi/agent/investigate-cache/<session-id>/<module>/`
- every persisted payload includes `schemaVersion: 1`

### Configuration

```typescript
interface InvestigateConfig {
  modules: {
    "query-tree": { enabled: boolean };
    "case-mgmt": { enabled: boolean; provider: "jira" | "snow" };
  };
  labelModel?: string;
  cacheDir?: string;
  maxTreeNodes?: number;
  maxPreviewRows?: number;
}
```

Stored in `~/.pi/config/pi-investigate.json`.

## Design Decisions

### Investigation scope

The canonical tree is session-global. Branching in the conversation does not erase earlier investigation nodes. The overlay can filter to the active branch, but that is a view, not the source of truth.

### Parent assignment

Parentage is captured when the query starts, not inferred when the result arrives. The tracker records the active node and branch hint in a pending-query record, then attaches the finished result to that stored parent.

### Schema versioning

All session entries and cache files written by `pi-investigate` include `schemaVersion: 1`. Future versions must migrate old payloads or skip them with a visible warning.

### Capture confidence

`dtctl query -o json --plain` is the supported capture mode. Each node stores `captureConfidence` as `high`, `medium`, or `low` so approximate captures stay visible without pretending to be exact.

## Module: Query Tree

### Purpose

Track `dtctl` DQL queries as a navigable tree with cached results and compact labels.

### Node Data Model

```typescript
interface QueryTreeNodeData {
  schemaVersion: 1;
  nodeType: "dql" | "manual";
  captureConfidence?: "high" | "medium" | "low";
  query?: string;
  content?: string;
  resultMeta: {
    recordCount: number;
    columns?: string[];
    durationMs?: number;
  };
  resultPreview?: {
    columns: string[];
    rows: any[][];
    truncated: boolean;
  };
  resultPath?: string;
  labelState?: "ready" | "pending" | "fallback";
}
```

### Query Capture

The module listens for `bash` tool activity, detects candidate `dtctl query` commands, records a pending query tied to the current investigation cursor, and resolves it when the matching tool result arrives.

A node is created only for successful query execution. These commands must not create nodes:

- `dtctl verify query ...`
- failed `dtctl query` commands
- non-query `dtctl` commands such as `get`, `apply`, or `describe`

### Supported and Unsupported Patterns

**Supported**

- `dtctl query "fetch logs | ..." -o json --plain`
- `dtctl wait query "fetch spans | ..." -o json --plain`
- `dtctl query -f query.dql -o json --plain`
- single-line command forms that are directly visible in `event.input.command`

**Best-effort**

- text table output instead of JSON
- file-based queries where the file is readable
- simple wrappers where the raw `dtctl query` call still appears in command text

**Unsupported in v1**

- heredocs
- variable-expanded query assembly
- subshell or command-substitution wrappers
- aliases that hide `dtctl`
- complex pipelines where the original query command is no longer recoverable

If automatic capture fails, the user can still add a manual marker with `/inv mark`.

### Entry ID Design

`sessionEntryId` stores the ID returned by `pi.appendEntry()` for the investigation node itself, not the original `tool_result` ID.

```text
... -> [tool_result] -> [investigate:query-tree:node] -> [next user msg] -> ...
```

That makes the investigation node the navigable anchor while keeping the original tool result adjacent in history.

### Parent Assignment

- if a node is selected when the query starts, it becomes the parent
- otherwise the current investigation cursor becomes the parent
- if no prior node exists, the new node is a root
- late results still attach to the originally recorded parent

### AI Label Generation

Labels summarize the delta between consecutive queries in about six words.

```text
Previous query: {previousQuery or "none (first query)"}
Current query: {currentQuery}
Summarize what changed in <=6 words. Be specific about the action.
Examples: "filter to ERROR only", "group by service name", "switch to spans for checkout"
If first query, describe what it fetches.
```

Model order:

1. `claude-haiku-4-5`
2. `claude-3-5-haiku-20241022`
3. current active model with `maxTokens: 30`

Lifecycle rules:

- max 3 concurrent label jobs
- queue up to 25 pending jobs
- if the queue is full, use fallback label immediately
- pending labels render as `...`
- timeout is 3 seconds, then fallback

Fallback label: first meaningful segment after `fetch`, truncated to 30 characters.

### Result Storage

The first 20 rows are stored inline in the session entry. Full results are written to `~/.pi/agent/investigate-cache/<session-id>/query-tree/<node-id>.json`.

```typescript
interface CachedResult {
  schemaVersion: 1;
  columns: string[];
  columnTypes?: string[];
  rows: any[][];
  totalRows: number;
  query: string;
  timestamp: number;
}
```

Write failures are non-fatal. Inline preview remains usable.

### Output Parsing

**Supported mode: JSON output**

- parse stdout as a JSON array of objects
- derive columns from object keys
- derive rows from values
- record count from array length

**Best-effort fallback: text tables**

- detect header and separator rows
- infer column widths
- extract rows below the separator
- downgrade `captureConfidence`

**Other cases**

- `-o chart`: metadata-only node, no row preview
- failed query: no node
- empty result: valid node with `recordCount: 0`

### Tree Overlay

TUI component rendered through `ctx.ui.custom({ overlay: true })`.

```text
pi-investigate - Query Tree - 5 nodes
│
├─ ① narrow to ERROR logs                    142 rec · 3m ago
│  ├─ ② break down by service                  8 grp · 2m ago
│  │  └─ ③ drill into checkout spans          56 spans · 1m ago
│  └─ ④ healthcheck endpoint [manual]          marked · 2m ago
└─ ⑤ host metrics for HOST-123               23 ser · 30s ago  ◀

↑↓ navigate · / search · q preview · t table · Enter jump · Esc close
```

| Key | Action |
|-----|--------|
| ↑/↓ | Move selection |
| Enter | Select node and return node ID to command handler |
| / | Search labels and query text |
| q | Toggle preview pane |
| t | Open table viewer |
| r | Rename node |
| c | Copy query text |
| m | Add manual marker |
| f | Toggle branch-local filter |
| Esc | Close overlay |

Navigation is two-step: the overlay returns a node ID, then the `/inv tree` command calls `navigateTree(node.sessionEntryId, { summarize: true })`.

### Table Viewer

Full-screen result viewer with:

- row and column scrolling
- column sorting
- search with `/`
- row yank with `y`
- export with `e` as CSV, JSON, or TSV

Data loads from disk cache first, then falls back to inline preview.

### Rename Persistence

Renaming appends a new `investigate:query-tree:node` entry with the same node ID and the new label. Reconstruction uses last-write-wins per node ID.

### Reconstruction

On `session_start` and `session_tree`:

1. read session entries
2. select `investigate:query-tree:*`
3. rebuild the full session-global node map
4. apply last-write-wins updates
5. rebuild parent-child links from `parentNodeId`
6. preserve `branchHint` for branch-local filtering

If a parent is missing, keep the node as a root-level orphan and mark it as degraded.

## Commands and Shortcuts

### `/inv tree`

Open the Query Tree overlay. Alias: `/inv t`.

### `/inv mark [label]`

Add a manual node at the current investigation cursor. If a tree node is selected, attach there. Alias: `/inv m`.

### `/inv cleanup`

Remove orphaned cache files and directories.

### `Ctrl+T`

V1 uses a queued command because shortcuts receive `ExtensionContext`, not command context.

```typescript
pi.registerShortcut("ctrl+t", {
  description: "Open investigation query tree",
  handler: async (ctx) => {
    if (ctx.isIdle()) {
      pi.sendUserMessage("/inv tree", { deliverAs: "followUp" });
    }
  },
});
```

This is a workaround. It adds synthetic session traffic and should be replaced if Pi later exposes direct command invocation from shortcuts.

### Status Indicator

`ctx.ui.setStatus("investigate", "inv: 5 queries")`

## Event Hooks

| Event | Handler |
|-------|---------|
| `session_start` | Load config, init modules, reconstruct state |
| `tool_result` | Capture and resolve query nodes |
| `session_tree` | Rebuild state and refresh branch filter |
| `session_shutdown` | Teardown and optional cleanup |

## Testing Strategy

Required tests:

- command parsing fixtures for supported and unsupported shell patterns
- JSON output parsing fixtures
- text table parsing fixtures
- reconstruction replay tests from saved session entry sequences
- rename replay tests with last-write-wins behavior
- branch navigation tests for session-global reconstruction and branch-local filtering
- cache-missing tests for inline preview fallback
- late-result tests proving parent assignment uses query-start context

## Error and Degradation Handling

- missing disk cache: use inline preview only
- corrupt cache: show warning in table viewer, never crash reconstruction
- missing parent: keep node as root-level orphan with warning marker
- parse failure with known query: create metadata-only low-confidence node
- label failure or timeout: use deterministic fallback label

## Limits and Retention

Defaults:

- max 500 nodes in memory per session
- max 20 preview rows per node
- max 25 pending label jobs
- max 25 MB cache file per node

Retention and performance:

- cache path: `~/.pi/agent/investigate-cache/<session-id>/`
- `/inv cleanup` removes orphaned cache data
- cold reconstruction of a 200-node session should complete in under 500 ms
- opening the overlay must not load full cached result rows into memory
- large result sets should load lazily in the table viewer where possible

## Implementation Plan

### 1. Core skeleton

- [ ] Create the extension entry point and module registration flow
- [ ] Implement config loading from `~/.pi/config/pi-investigate.json`
- [ ] Implement shared investigation state with versioned node storage
- [ ] Implement the typed internal event bus
- [ ] Implement module lifecycle hooks for init, reconstruct, and teardown
- [ ] Register session and tool event hooks needed by Query Tree

### 2. Query capture

- [ ] Implement command detection for supported `dtctl query` and `dtctl wait query` shapes
- [ ] Record pending-query state at command start with parent node and branch hint
- [ ] Resolve pending queries on `tool_result` and reject unsupported or failed commands
- [ ] Implement JSON output parsing for `-o json --plain`
- [ ] Implement best-effort text table parsing with downgraded capture confidence
- [ ] Add fixture tests for supported, best-effort, and unsupported command shapes

### 3. Persistence and reconstruction

- [ ] Persist Query Tree nodes with `pi.appendEntry("investigate:query-tree:node", ...)`
- [ ] Write full query results to the disk cache with schema versioning
- [ ] Rebuild the session-global node map from saved entries
- [ ] Reconstruct parent-child links and preserve branch hints for filtering
- [ ] Surface orphaned nodes as degraded roots instead of dropping them
- [ ] Add replay tests for reconstruction, restart behavior, and orphan handling

### 4. Label generation

- [ ] Implement model selection for short label generation
- [ ] Implement a queue with max 3 concurrent jobs and 25 pending jobs
- [ ] Set `labelState: "pending"` while generation is in flight
- [ ] Apply timeout handling and deterministic fallback labels on failure
- [ ] Persist updated labels through last-write-wins node updates

### 5. Tree overlay

- [ ] Build tree state for ordered parent-child rendering
- [ ] Implement the overlay renderer and selection state
- [ ] Implement key bindings for navigation, search, preview, rename, copy, mark, and branch filter
- [ ] Implement label and query search inside the overlay
- [ ] Implement branch-local filtering on top of the session-global tree
- [ ] Wire overlay selection return to `navigateTree(node.sessionEntryId, { summarize: true })`

### 6. Table viewer

- [ ] Implement the full-screen table viewer component
- [ ] Add row and column scrolling controls
- [ ] Add column sorting and text search
- [ ] Load full results lazily from disk cache where possible
- [ ] Fall back to inline preview when cache data is missing
- [ ] Implement CSV, JSON, and TSV export actions

### 7. Commands and integration

- [ ] Implement `/inv tree` and `/inv t`
- [ ] Implement `/inv mark` at the current investigation cursor
- [ ] Implement `/inv cleanup` for orphaned cache data
- [ ] Implement the `Ctrl+T` shortcut workaround via queued command dispatch
- [ ] Implement footer status updates for investigation activity

### 8. Polish and verification

- [ ] Implement rename persistence with last-write-wins reconstruction
- [ ] Verify degraded behavior for missing cache, corrupt cache, parse failure, and label failure
- [ ] Add integration tests for late-arriving results and parent assignment correctness
- [ ] Add integration tests for branch filtering and session-global reconstruction
- [ ] Verify cold reconstruction and overlay open performance against the stated targets

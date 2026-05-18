# pi-investigate

An investigation workbench for Pi. When you're chasing an incident through DQL queries, logs, and hypotheses, the work doesn't move in a straight line — you branch, backtrack, and pick up threads you left earlier. `pi-investigate` makes that structure visible and navigable.

The first module is the **Query Tree**: every successful `dtctl query` you run gets captured automatically and shown as a navigable tree, preserving the branching shape of the investigation.

## What it does

Every time the LLM runs a `dtctl query` command:

1. The extension detects the command before it executes and records the current investigation context (which node is active, what the parent is).
2. On success, it parses the output (JSON or text table), stores a full result cache on disk, and saves a 20-row inline preview to the session.
3. It generates a short label — a few words describing what this query does differently from its parent — and updates the node when the label is ready.
4. The footer shows a live count: `inv: N queries`.

At any point you can open the tree overlay with `/inv tree` (or `Ctrl+T`) to see the full investigation shape, navigate to any node, preview results, and jump back to that point in the session history.

## Getting started

### Step 1: Reload the extension

Run `/reload` inside a running pi session. You should see `inv: idle` appear in the footer status bar.

### Step 2: Run a DQL query through the agent

Ask the agent to run a query — for example:

> Fetch the last 100 error logs from the checkout service

The agent will call `dtctl query "fetch logs | filter loglevel==\"ERROR\" | filter service==\"checkout\" | limit 100" -o json --plain`. The moment that succeeds, the footer updates to `inv: 1 query`.

### Step 3: Run a follow-up query

Continue the investigation:

> Now break that down by pod name

The agent runs another query. The footer shows `inv: 2 queries`. The second query is automatically attached as a child of the first in the tree.

### Step 4: Open the tree overlay

Type `/inv tree` (or press `Ctrl+T` when the agent is idle). You'll see something like:

```
╭──────────────────────────────────────────────────────────────────────────╮
│ pi-investigate — Query Tree — 3 nodes                                    │
│                                                                           │
│ ├─ ① fetch error logs checkout                  100 rec · 4m ago         │
│ │  └─ ② break down by pod name                   12 grp · 2m ago  ◀      │
│ └─ ③ span duration for checkout checkout         56 rec · 1m ago         │
│                                                                           │
│  ↑↓ navigate · / search · q preview · f branch · Enter jump · Esc close  │
╰──────────────────────────────────────────────────────────────────────────╯
```

Navigate with arrow keys. Press `q` to toggle the preview pane. Press `Enter` to select a node and choose what to do with it.

### Step 5: Add a manual marker

When you want to bookmark a moment in the investigation without running a query, use:

```
/inv mark "starting auth hypothesis"
```

The marker appears in the tree as a sibling of the currently selected node.

### Step 6: Open the table viewer

Select a node in the tree overlay and choose **Open table viewer**. This opens a full-screen view of the query results:

```
 ▶ fetch error logs checkout  100/100 rows
─────────────────────────────────────────
 timestamp          |service   |message
─────────────────────────────────────────
 2026-05-18T14:23.. |checkout  |timeout...
 2026-05-18T14:22.. |checkout  |timeout...
...
─────────────────────────────────────────
 ↑↓ scroll · s sort · / search · e csv · j json · t tsv · q close
```

Press `e`, `j`, or `t` to export to CSV, JSON, or TSV. The file is written to `~/Downloads/`.

### Step 7: Navigate to a session entry

Select a node in the tree overlay and choose **Jump to session entry**. Pi navigates its session tree to the point where that query result was captured — useful for picking up a branch of the investigation you abandoned earlier.

## Commands

| Command | Description |
|---------|-------------|
| `/inv tree` or `/inv t` | Open the Query Tree overlay |
| `/inv mark [label]` | Add a manual marker at the current investigation cursor |
| `/inv cleanup` | Remove orphaned cache files from disk |

**Shortcut:** `Ctrl+T` — opens the tree when the agent is idle. Because pi doesn't yet expose direct command invocation from shortcuts, this works by sending `/inv tree` as a queued user message.

## Tree overlay keys

| Key | Action |
|-----|--------|
| `↑` / `↓` | Move selection |
| `Enter` | Select node (jump to session or open table viewer) |
| `/` | Search labels and query text |
| `q` | Toggle preview pane |
| `f` | Toggle branch-local filter (show only the active branch) |
| `Esc` | Close overlay |

## Table viewer keys

| Key | Action |
|-----|--------|
| `↑` / `↓` | Scroll rows |
| `←` / `→` | Scroll columns |
| `s` | Cycle sort column |
| `/` | Search rows |
| `e` | Export CSV |
| `j` | Export JSON |
| `t` | Export TSV |
| `q` / `Esc` | Close |

## What gets captured automatically

The extension listens for bash tool calls and captures:

**Supported (high confidence)**
- `dtctl query "fetch ..." -o json --plain`
- `dtctl wait query "fetch ..." -o json --plain`
- `dtctl query -f query.dql -o json --plain`

**Best-effort (medium confidence — text table output)**
- Queries run without `-o json --plain`

**Not captured**
- `dtctl verify query ...` (deliberately excluded)
- Failed queries
- Non-query `dtctl` subcommands (`get`, `apply`, `describe`, etc.)

If capture fails for an unsupported pattern, use `/inv mark` to add a node manually.

## Configuration

Optional config at `~/.pi/config/pi-investigate.json`:

```json
{
  "modules": {
    "query-tree": { "enabled": true }
  },
  "maxTreeNodes": 500,
  "maxPreviewRows": 20,
  "cacheDir": "~/.pi/agent/investigate-cache"
}
```

All fields are optional — defaults are used when the file is absent.

## Cache and cleanup

Full query results are cached at `~/.pi/agent/investigate-cache/<session-id>/query-tree/<node-id>.json`. Each file carries `schemaVersion: 1`.

Run `/inv cleanup` to remove cache files that no longer correspond to any node in the current session.

## Persistence and restarts

Investigation nodes are stored in the session file via `pi.appendEntry()`. When you resume a session or navigate the session tree, the full investigation tree is rebuilt automatically. Branch navigation (via `/tree` in pi) triggers a reconstruction so the tree always reflects the active branch.

Rename a node by selecting it in the overlay and pressing `r` — the new label is persisted via a last-write-wins update to the session.

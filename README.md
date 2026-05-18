# pi extensions

Personal [pi](https://github.com/mariozechner/pi-coding-agent) extensions. Auto-discovered from `~/.pi/agent/extensions/` and hot-reloadable inside a running session with `/reload`.

## Extensions

### `lid-inhibit`

Prevents the laptop from sleeping when the lid is closed while an agent task is running. The moment the agent goes idle, normal sleep behavior resumes.

- **Linux** — `systemd-inhibit` (crash-safe)
- **macOS** — `caffeinate` (crash-safe)
- **Windows** — `powercfg` save/restore (not crash-safe; see the extension README)

Commands: `/lid-inhibit`, `/lid-inhibit on`, `/lid-inhibit off`

See [`lid-inhibit/README.md`](lid-inhibit/README.md) for full details.

---

### `wezterm-agents`

Registers a `spawn_agent` tool (callable by the LLM) and a `/spawn` command (callable by the user) that run sub-agents in dedicated WezTerm tabs. Each agent gets its own branch; a diff is captured and returned to the parent when the agent finishes.

Requires WezTerm.

---

### `tool-profiler`

Profiles every tool call to show which ones are driving context growth and model cost. Emits a live warning when a single call crosses a severity threshold, and exposes `/tool-stats` for a full breakdown.

- **Scoring** — context impact (fraction of context window consumed) and estimated downstream cost, blended into a 0–1 severity score
- **Factor tags** — `large-result`, `noisy-bash-output`, `broad-read-range`, and more
- **Cross-session aggregate** — compact JSON that accumulates trends across sessions

Commands: `/tool-stats`, `/tool-stats session`, `/tool-stats overall`, `/tool-stats tool <name>`

See [`tool-profiler/README.md`](tool-profiler/README.md) for full details.

---

### `pi-investigate`

An investigation workbench that tracks every `dtctl` DQL query the agent runs as a navigable tree. Captures query results automatically, stores a full result cache on disk, and generates short labels summarising what changed between queries.

- **Query Tree** — session-persistent tree of all DQL queries with parent-child branching
- **Tree overlay** — `/inv tree` or `Ctrl+T` to open; navigate, search, filter to active branch
- **Table viewer** — full-screen result view with sort, search, and CSV/JSON/TSV export
- **Manual markers** — `/inv mark [label]` to bookmark moments without running a query
- **Auto-reconstruction** — tree rebuilds on session resume and branch navigation

Commands: `/inv tree`, `/inv mark`, `/inv cleanup`

See [`pi-investigate/README.md`](pi-investigate/README.md) for a step-by-step getting started guide.

---

## Adding a new extension

Drop a `.ts` file in this directory (or a subdirectory with an `index.ts`) and run `/reload` in pi. See the [pi extensions docs](https://github.com/mariozechner/pi-coding-agent/blob/main/docs/extensions.md) for the full API.

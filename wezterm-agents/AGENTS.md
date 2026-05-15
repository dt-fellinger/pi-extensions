# wezterm-agents — agent context

Read this before editing the extension.

## Files

| File | Role |
|---|---|
| `index.ts` | Entry point. Registers the `spawn_agent` tool and `/spawn` command. Contains the core `spawnAgentTab()` function and `generateAiCommitMessage()` helper. |
| `agents.ts` | Agent profile discovery. Reads YAML frontmatter from `.md` files in user and/or project agent directories. No side effects. |
| `worktree.ts` | Git worktree lifecycle: create, diff, cleanup. Also exposes `isGitRepo`, `isCleanWorkingTree`, `getRepoRoot`. No I/O outside of git and fs operations. |
| `formatter.py` | Python script that runs inside the WezTerm display pane. Reads pi's JSON event stream from a temp file and renders it with Catppuccin Mocha colours. No external Python dependencies — stdlib only. |

## Import style

Local imports use `.js` extensions (e.g., `from "./agents.js"`). The package imports are `@earendil-works/pi-coding-agent` and `@earendil-works/pi-ai`. If you see `@mariozechner/*` anywhere, that is the old name — update it.

## Core architecture: pi as a child process

The most non-obvious design decision: the sub-agent runs as a **child `pi` process** spawned by the extension, not via any pi API. This means:

- The child inherits the parent's full authenticated environment (API keys, etc.) without needing separate credential setup.
- The child's stdout is piped to a temp JSON file. `formatter.py` tails that file and renders it live in the WezTerm pane.
- The child uses `--mode json -p --no-session` so it produces a structured event stream and exits when done.

The `PI_CODING_AGENT` environment variable is deleted from the child's environment before spawning. When that variable is set, pi detects it's running inside another pi instance and switches to a credential-from-env mode — deleting it lets the child initialise normally from `auth.json`.

## Worktree lifecycle

```
createWorktree()
  git worktree add /tmp/pi-worktree-<uuid> -b pi-agent-<name>-<uuid> HEAD
  symlink node_modules from main tree (best-effort, not critical)

→ agent runs in worktree

captureWorktreeDiff()
  remove node_modules symlink (avoids false diff entries)
  git add -A
  git diff --cached <baseCommit>   → .patch file in /tmp
  git diff --cached --stat         → summary string

cleanupWorktree()
  git worktree remove --force
  git branch -D
  git worktree prune
```

The patch file is intentionally kept after cleanup — its path is returned to the parent LLM so the user can inspect and apply it. Temp prompt/output files are deleted.

## WezTerm pane layout

`spawnAgentTab()` always places the new pane to the right of the current pane the first time (40% width split). If a right pane already exists, it walks down to the bottom-most pane in the right column and splits below it. This keeps all agent panes stacked on the right side without touching the user's main pane.

After splitting, the extension immediately re-activates the original pane (`wezterm cli activate-pane`) so focus returns to the user.

## formatter.py

A self-contained Python 3 script. It:

1. Waits for the output file to appear (the child process may not have written anything yet).
2. Reads the JSON event stream line by line via `readline()` with a 0.5 s sleep on empty reads.
3. Renders `tool_execution_start`, `message_update` (streaming text), `message_end` (usage), and `agent_end`/`wezterm_agent_done` (completion).
4. Gives up after 60 empty reads (~30 s) and prints a timeout error — this handles the case where the child crashes before emitting any events.

The `wezterm_agent_done` custom event is written by `index.ts` to the output file after the child exits. This guarantees `formatter.py` always sees a terminal event even if the child crashes mid-stream.

Do not add external Python dependencies here. The script must run with whatever `python3` is on the user's PATH.

## AI commit message generation

`generateAiCommitMessage()` spawns another pi child process with a plain text prompt, parses its JSON output for the final assistant message, and returns the first line (≤ 72 chars). It has a 15-second timeout and fails silently — if it returns an empty string, the `/spawn` command falls back to a plain text input dialog.

## Tests

There are no automated tests. The worktree and WezTerm operations require a live git repo and WezTerm session. When changing `worktree.ts`, test the create/diff/cleanup cycle manually by spawning a real agent. When changing `formatter.py`, test by watching a real agent tab — check that tool calls, streaming text, and the completion summary all render correctly.

## Adding a new agent profile field

1. Add the field to the frontmatter of the `.md` file.
2. Read it in `loadAgentsFromDir()` in `agents.ts` — the frontmatter is already parsed into a plain record, so it's a one-liner.
3. Thread it through `AgentConfig` and `spawnAgentTab()` as needed.
4. Update the frontmatter field table in `README.md`.

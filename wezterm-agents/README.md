# wezterm-agents

A Pi extension that spawns sub-agents in dedicated WezTerm tabs, each with its own isolated git branch. When the agent finishes, its file changes are captured as a diff and returned to the parent LLM.

## Requirements

- Running inside [WezTerm](https://wezfurlong.org/wezterm/) (the `WEZTERM_PANE` environment variable must be set).
- A git repository as the working directory.
- A clean working tree — no uncommitted changes. If your tree is dirty, the `/spawn` command will offer to commit or stash first.

## Agent profiles

Agents are defined as Markdown files with YAML frontmatter in `~/.pi/agent/agents/` (user scope) or `<project>/.pi/agents/` (project scope).

```markdown
---
name: worker
description: General-purpose implementation agent
model: claude-sonnet-4-5
tools: read,bash,write,edit,grep,find,ls
---

You are a focused implementation agent. Read context files before making changes.
Follow existing code style and linting rules. Write tests alongside new code.
```

Frontmatter fields:

| Field | Required | Description |
|---|---|---|
| `name` | Yes | Agent identifier used in tool/command invocations |
| `description` | Yes | Shown in the agent selector |
| `model` | No | Model override (e.g. `claude-haiku-4-5`). Falls back to the parent session's default. |
| `tools` | No | Comma-separated tool list. Falls back to the parent session's active tools. |

The Markdown body (everything after the frontmatter) becomes the agent's system prompt.

## Usage

### Tool: `spawn_agent`

The LLM can call this tool to delegate a task to a named agent:

```
spawn_agent(
  agent: "worker",
  task: "Refactor the auth module to use the new token format",
  model: "claude-haiku-4-5",   // optional override
  tools: "read,bash",          // optional override
  cwd: "/path/to/repo",        // optional, defaults to session cwd
  agentScope: "user"           // "user" | "project" | "both"
)
```

### Command: `/spawn`

User-callable. Two forms:

```
/spawn                         Interactive: pick agent, enter task
/spawn worker Fix the auth bug Inline: agent name + task in one line
```

If the working tree is dirty, `/spawn` pauses to let you commit or stash before proceeding.

## What happens when an agent runs

1. A new git branch is created from `HEAD` in an isolated worktree under `/tmp`.
2. A WezTerm tab opens alongside the current pane showing live formatted output — tool calls, streaming text, and a summary line when the agent finishes.
3. The agent's `pi` process runs as a child of the extension, inheriting the authenticated environment.
4. When the agent exits, the diff against the base commit is captured and saved as a `.patch` file in `/tmp`.
5. The worktree and branch are cleaned up.
6. The diff summary (and patch path) is returned to the parent LLM.

## Applying agent changes

The diff summary includes the patch file path:

```
=== Worktree Changes: worker ===

 src/auth/token.ts | 42 +++++++++++++---------
 src/auth/index.ts |  8 +++--

2 files changed, +38 -18
Patch saved to: /tmp/pi-agent-abc12345.patch
Apply with:     git apply /tmp/pi-agent-abc12345.patch
```

Review the patch, then apply it with `git apply`. The tab closes automatically 60 seconds after the agent finishes.

## Scope: user vs project agents

| Scope | Directory |
|---|---|
| `user` (default) | `~/.pi/agent/agents/*.md` |
| `project` | `<nearest ancestor>/.pi/agents/*.md` |
| `both` | Both dirs; project overrides user by name |

The `spawn_agent` tool and `/spawn` command both accept `agentScope`. Project-scoped agents let a repo define specialized agents without cluttering the global list.

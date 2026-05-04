# lid-inhibit

A pi extension that prevents your laptop from sleeping when the lid is closed while an agent task is running. The moment the agent goes idle, normal sleep behavior resumes.

## How it works

When `agent_start` fires, the extension acquires a system-level inhibitor lock. When `agent_end` fires, the lock is released. On Linux and macOS the lock is process-based — if pi crashes, the OS drops it automatically. Nothing ever gets stuck.

Idle pi sessions (waiting for user input) do not hold the lock.

## Platform support

| Platform | Mechanism | Crash-safe |
|---|---|---|
| Linux | `systemd-inhibit --what=handle-lid-switch` | Yes — lock dies with the process |
| macOS | `caffeinate -ids` | Yes — assertion dies with the process |
| Windows | `powercfg` (save/restore power plan lid action) | No — see [Windows caveat](#windows-caveat) |

## Status indicator

A footer indicator shows the current state:

| Indicator | Meaning |
|---|---|
| `⏸ lid locked` | Agent is running, lid-close sleep is blocked |
| `lid-inhibit: off` | Extension disabled by user |
| *(nothing)* | Enabled, agent is idle — lid-close suspends normally |

## Commands

```
/lid-inhibit          Toggle on/off
/lid-inhibit on       Enable
/lid-inhibit off      Disable and release any active lock immediately
```

## Sub-agent behavior

Each pi process (including sub-agents spawned via `spawn_agent`) manages its own inhibitor independently. The OS stacks multiple inhibitor locks, so the laptop stays awake as long as any agent is running. When all agents finish, all locks are released.

## Installation

The extension is auto-discovered from `~/.pi/agent/extensions/`. No further setup needed. Activate it in a running pi session with `/reload`, or just restart pi.

## Windows caveat

Windows has no lock-based equivalent to `systemd-inhibit`. The Windows implementation reads the current lid-close action from the active power plan, sets it to "do nothing" on acquire, and restores it on release. If pi crashes between those two steps, the lid-close action stays disabled until the next pi session runs and calls release (which happens on startup of the next session via `session_shutdown` cleanup), or until you restore it manually via Settings → Power & battery → Screen and sleep.

Administrator privileges may be required for `powercfg` to modify the power plan.

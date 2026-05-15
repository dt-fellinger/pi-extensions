# lid-inhibit — agent context

Read this before editing the extension.

## Structure

| File | Role |
|---|---|
| `index.ts` | Entry point. Registers the `/lid-inhibit` command and the `agent_start`/`agent_end`/`session_shutdown` hooks. All platform-specific logic is delegated to the concrete `Inhibitor` instance. |
| `types.ts` | `Inhibitor` interface: `acquire(): Promise<void>` and `release(): Promise<void>`. Any new platform must implement this. |
| `linux.ts` | Spawns `systemd-inhibit` holding `handle-lid-switch`. Crash-safe: the OS drops the lock when the process dies. |
| `macos.ts` | Spawns `caffeinate -ids`. Crash-safe for the same reason. |
| `windows.ts` | Reads the current lid-close action via `powercfg`, sets it to "do nothing" on acquire, and restores on release. Not crash-safe — a crash between acquire and release leaves the lid-close disabled until the next pi session. |

## Import style

This extension uses `.js` local import extensions (e.g., `from "./types.js"`), not `.ts`. Both work under jiti, which loads TypeScript natively — `.ts` is what tool-profiler uses. Do not change the extension format mid-file; pick one and stay consistent. If you add a new file, use `.js` to match the existing imports.

The package import is `@earendil-works/pi-coding-agent`. If you see `@mariozechner/pi-coding-agent` anywhere, that is the old name — update it.

## activeCount ref-counting

`index.ts` maintains `activeCount` rather than a simple boolean flag. This handles the case where two agent tasks run concurrently (e.g. a sub-agent spawned before the parent finishes):

- `agent_start` increments `activeCount` and calls `acquire()` only when it goes from 0 → 1.
- `agent_end` decrements `activeCount` and calls `release()` only when it reaches 0.
- The count is clamped to 0 with `Math.max` to guard against mismatched events.

Do not replace this with a boolean without thinking through concurrent agents.

## session_shutdown always releases

The `session_shutdown` handler calls `inhibitor.release()` unconditionally — regardless of the `enabled` flag and regardless of `activeCount`. This is a safety net for crashes or abrupt exits. The `setStatus` call is intentionally skipped there because the UI may already be tearing down.

## Adding a new platform

1. Create `<platform>.ts` implementing `Inhibitor` from `./types.js`.
2. Add a `case` in the `createInhibitor()` switch in `index.ts`.
3. Update the platform table in `README.md`.

## Tests

There are no automated tests. Platform inhibitor behaviour requires a live OS environment to verify. If you change the acquire/release logic, test it manually: start pi, run a long agent task, close the lid (or check `systemctl status systemd-inhibit` / `pmset -g`), confirm the inhibitor is active, let the task finish, and confirm the inhibitor is gone.

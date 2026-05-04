/**
 * Linux inhibitor using systemd-inhibit.
 *
 * Spawns a background `sleep infinity` process holding a
 * `handle-lid-switch` inhibitor lock. The lock is automatically
 * released by systemd if the process dies (crash-safe - no stuck state).
 */
import { spawn, type ChildProcess } from "node:child_process";
import type { Inhibitor } from "./types.js";

export class LinuxInhibitor implements Inhibitor {
  private proc: ChildProcess | null = null;

  async acquire(): Promise<void> {
    if (this.proc) return;

    this.proc = spawn(
      "systemd-inhibit",
      [
        "--what=handle-lid-switch",
        "--who=pi",
        "--why=Agent task running",
        "--mode=block",
        "sleep",
        "infinity",
      ],
      { stdio: "ignore", detached: false }
    );

    this.proc.on("exit", () => {
      this.proc = null;
    });
  }

  async release(): Promise<void> {
    if (!this.proc) return;
    this.proc.kill("SIGTERM");
    this.proc = null;
  }
}

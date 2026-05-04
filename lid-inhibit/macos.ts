/**
 * macOS inhibitor using caffeinate.
 *
 * Spawns a `caffeinate` process with:
 *   -i  prevent idle system sleep
 *   -d  prevent display sleep (keeps the session visible in clamshell mode)
 *   -s  prevent system sleep while on AC power
 *
 * Like systemd-inhibit, the assertion is automatically released when the
 * process exits, so crashes leave no stuck state.
 */
import { spawn, type ChildProcess } from "node:child_process";
import type { Inhibitor } from "./types.js";

export class MacOSInhibitor implements Inhibitor {
  private proc: ChildProcess | null = null;

  async acquire(): Promise<void> {
    if (this.proc) return;

    this.proc = spawn("caffeinate", ["-ids"], {
      stdio: "ignore",
      detached: false,
    });

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

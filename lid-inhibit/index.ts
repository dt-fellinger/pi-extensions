/**
 * lid-inhibit extension
 *
 * Prevents the laptop from sleeping when the lid is closed while a pi agent
 * task is actively running. The inhibitor is held for exactly as long as the
 * agent is working - idle pi sessions (waiting for user input) do not block sleep.
 *
 * Platform support:
 *   Linux  - systemd-inhibit (crash-safe: lock released automatically on process death)
 *   macOS  - caffeinate      (crash-safe: assertion released automatically on process death)
 *   Windows - powercfg       (NOT crash-safe: save/restore approach, see windows.ts)
 *
 * Commands:
 *   /lid-inhibit        - toggle on/off
 *   /lid-inhibit on     - enable
 *   /lid-inhibit off    - disable (releases any active hold immediately)
 *
 * Status indicator (footer):
 *   "⏸ lid locked"     - inhibitor is active (agent is running)
 *   "lid-inhibit: off"  - user has disabled the extension
 *   (nothing)           - enabled but no agent is active
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { platform } from "node:os";
import type { Inhibitor } from "./types.js";
import { LinuxInhibitor } from "./linux.js";
import { MacOSInhibitor } from "./macos.js";
import { WindowsInhibitor } from "./windows.js";

const STATUS_KEY = "lid-inhibit";

function createInhibitor(): Inhibitor | null {
  switch (platform()) {
    case "linux":
      return new LinuxInhibitor();
    case "darwin":
      return new MacOSInhibitor();
    case "win32":
      return new WindowsInhibitor();
    default:
      return null;
  }
}

export default function (pi: ExtensionAPI) {
  const inhibitor = createInhibitor();
  let enabled = true;
  let activeCount = 0; // ref-count of concurrent agent_start calls without matching agent_end

  if (!inhibitor) {
    // Unsupported platform - register the command anyway so users see a clear message
    pi.registerCommand("lid-inhibit", {
      description: "Lid-close inhibitor (unsupported on this platform)",
      handler: async (_args, ctx) => {
        ctx.ui.notify(`Lid-close inhibitor is not supported on ${platform()}`, "error");
      },
    });
    return;
  }

  function updateStatus(ctx: ExtensionContext): void {
    if (!enabled) {
      ctx.ui.setStatus(STATUS_KEY, "lid-inhibit: off");
    } else if (activeCount > 0) {
      ctx.ui.setStatus(STATUS_KEY, "⏸ lid locked");
    } else {
      ctx.ui.setStatus(STATUS_KEY, "");
    }
  }

  pi.on("agent_start", async (_event, ctx) => {
    activeCount++;
    // Only call acquire on the first active turn to avoid redundant spawns
    if (enabled && activeCount === 1) {
      await inhibitor.acquire();
    }
    updateStatus(ctx);
  });

  pi.on("agent_end", async (_event, ctx) => {
    activeCount = Math.max(0, activeCount - 1);
    if (activeCount === 0) {
      await inhibitor.release();
    }
    updateStatus(ctx);
  });

  pi.on("session_shutdown", async (_event, _ctx) => {
    // Always release on shutdown regardless of enabled state or ref-count.
    // The UI may already be tearing down, so skip setStatus.
    activeCount = 0;
    await inhibitor.release();
  });

  pi.registerCommand("lid-inhibit", {
    description: "Toggle lid-close inhibitor. Usage: /lid-inhibit [on|off]",
    handler: async (args, ctx) => {
      const arg = args?.trim().toLowerCase();
      const wantEnable =
        arg === "on" ? true : arg === "off" ? false : !enabled; // toggle if no arg

      if (wantEnable === enabled) {
        ctx.ui.notify(
          `Lid-close inhibitor is already ${enabled ? "enabled" : "disabled"}`,
          "info"
        );
        return;
      }

      enabled = wantEnable;

      if (enabled) {
        // Re-acquire immediately if an agent turn is currently active
        if (activeCount > 0) {
          await inhibitor.acquire();
        }
        ctx.ui.notify("Lid-close inhibitor enabled", "success");
      } else {
        // Release immediately even if agent turns are still running
        await inhibitor.release();
        ctx.ui.notify(
          "Lid-close inhibitor disabled — closing the lid will suspend normally",
          "info"
        );
      }

      updateStatus(ctx);
    },
  });
}

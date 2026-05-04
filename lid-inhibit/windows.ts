/**
 * Windows inhibitor using powercfg to modify the active power plan's
 * lid-close action.
 *
 * ⚠ CRASH-SAFETY LIMITATION: Unlike the Linux and macOS implementations,
 * this approach is NOT lock-based. It saves the current lid-close values,
 * sets them to "do nothing" on acquire, and restores them on release.
 * If the process crashes between acquire and release, the lid-close action
 * stays disabled until the next pi session runs and calls release(), or
 * until the user manually restores their power settings.
 *
 * ⚠ PERMISSIONS: powercfg changes require administrator privileges on most
 * Windows configurations.
 *
 * Values: 0 = do nothing, 1 = sleep, 2 = hibernate, 3 = shut down
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Inhibitor } from "./types.js";

const exec = promisify(execFile);

// powercfg GUIDs for lid close actions
const SCHEME_CURRENT = "SCHEME_CURRENT";
const SUB_BUTTONS = "SUB_BUTTONS";
const LIDACTION = "LIDACTION";

async function getLidAction(dcOrAc: "dc" | "ac"): Promise<string> {
  const flag = dcOrAc === "dc" ? "/setdcvalueindex" : "/setacvalueindex";
  // Query current value: powercfg /query SCHEME_CURRENT SUB_BUTTONS LIDACTION
  const { stdout } = await exec("powercfg", [
    "/query",
    SCHEME_CURRENT,
    SUB_BUTTONS,
    LIDACTION,
  ]);
  // Output contains lines like: "Current AC Power Setting Index: 0x00000001"
  const pattern =
    dcOrAc === "ac"
      ? /Current AC Power Setting Index:\s*(0x[\da-fA-F]+)/
      : /Current DC Power Setting Index:\s*(0x[\da-fA-F]+)/;
  const match = stdout.match(pattern);
  return match ? parseInt(match[1], 16).toString() : "1"; // default: sleep
}

async function setLidAction(value: string): Promise<void> {
  await exec("powercfg", ["/setacvalueindex", SCHEME_CURRENT, SUB_BUTTONS, LIDACTION, value]);
  await exec("powercfg", ["/setdcvalueindex", SCHEME_CURRENT, SUB_BUTTONS, LIDACTION, value]);
  await exec("powercfg", ["/setactive", SCHEME_CURRENT]);
}

export class WindowsInhibitor implements Inhibitor {
  private savedAc: string | null = null;
  private savedDc: string | null = null;

  async acquire(): Promise<void> {
    if (this.savedAc !== null) return; // already acquired
    this.savedAc = await getLidAction("ac");
    this.savedDc = await getLidAction("dc");
    await setLidAction("0"); // 0 = do nothing
  }

  async release(): Promise<void> {
    if (this.savedAc === null) return;
    // Restore both AC and DC values independently
    await exec("powercfg", ["/setacvalueindex", SCHEME_CURRENT, SUB_BUTTONS, LIDACTION, this.savedAc]);
    await exec("powercfg", ["/setdcvalueindex", SCHEME_CURRENT, SUB_BUTTONS, LIDACTION, this.savedDc!]);
    await exec("powercfg", ["/setactive", SCHEME_CURRENT]);
    this.savedAc = null;
    this.savedDc = null;
  }
}

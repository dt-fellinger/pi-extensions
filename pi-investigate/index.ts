/**
 * pi-investigate — Investigation Workbench for Pi
 *
 * Extension entry point. Initialises the core and wires up the Query Tree module.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "./core/config.js";
import { createEventBus } from "./core/events.js";
import { createState, resetState } from "./core/state.js";
import type { InvestigationState } from "./core/types.js";
import {
  initQueryTreeModule,
  reconstructQueryTree,
  registerQueryTreeCommands,
} from "./modules/query-tree/index.js";
import { initStatus } from "./ui/status.js";

export default function (pi: ExtensionAPI) {
  const config = loadConfig();
  const events = createEventBus();

  // State is mutated in-place on session_start so the tracker always has a valid reference.
  const state: InvestigationState = createState("__init__");

  // Keep a reference to the latest ctx for status updates.
  let latestCtx: ExtensionContext | null = null;
  const getCtx = () => latestCtx;

  // ---------------------------------------------------------------------------
  // Session lifecycle
  // ---------------------------------------------------------------------------

  pi.on("session_start", async (_event, ctx) => {
    latestCtx = ctx;

    // Derive a stable session ID from the session file path, or fall back to Date.
    const sessionFile = ctx.sessionManager.getSessionFile();
    const sessionId = sessionFile
      ? sessionFile.replace(/.*\//, "").replace(/\.jsonl$/, "")
      : `session-${Date.now()}`;

    resetState(state, sessionId);

    if (config.modules["query-tree"].enabled) {
      state.activeModules.push("query-tree");
    }

    // Reconstruct existing nodes from saved entries.
    reconstructQueryTree(state, ctx);
    events.emit("tree:rebuilt");
  });

  pi.on("session_tree", async (_event, ctx) => {
    latestCtx = ctx;
    reconstructQueryTree(state, ctx);
    events.emit("tree:rebuilt");
  });

  pi.on("session_shutdown", async () => {
    latestCtx = null;
  });

  // ---------------------------------------------------------------------------
  // Module init
  // ---------------------------------------------------------------------------

  if (config.modules["query-tree"].enabled) {
    const { tracker, resetLabelModel } = initQueryTreeModule(pi, state, events, config);
    registerQueryTreeCommands(pi, state, events, config, tracker);
    // Reset cached model selection at the start of each session so credential
    // changes are picked up without requiring a full restart.
    pi.on("session_start", async () => resetLabelModel());
  }

  // Status display — wire once. Uses getCtx() so it always has a live ctx.
  initStatus(state, events, getCtx);

  // ---------------------------------------------------------------------------
  // Update latestCtx on every turn_start so status calls have a live ctx.
  // ---------------------------------------------------------------------------
  pi.on("turn_start", async (_event, ctx) => {
    latestCtx = ctx;
  });
}

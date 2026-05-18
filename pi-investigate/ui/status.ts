/**
 * Footer status — aggregates investigation activity into a status bar item.
 *
 * Shows: "inv: N queries" where N is the number of query-tree nodes.
 * Updated whenever a node is created or the tree is rebuilt.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { InvestigateEventBus, InvestigationState } from "../core/types.js";

export function initStatus(
  state: InvestigationState,
  events: InvestigateEventBus,
  getCtx: () => ExtensionContext | null,
): void {
  const update = () => {
    const ctx = getCtx();
    if (!ctx) return;
    const count = state.nodes.size;
    const th = ctx.ui.theme;
    const text = count > 0
      ? th.fg("accent", `inv: ${count} quer${count === 1 ? "y" : "ies"}`)
      : th.fg("dim", "inv: idle");
    ctx.ui.setStatus("investigate", text);
  };

  events.on("node:created", () => update());
  events.on("node:updated", () => update());
  events.on("tree:rebuilt", () => update());
}

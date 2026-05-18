/**
 * Tree overlay — TUI component that renders the Query Tree.
 *
 * Returned from ctx.ui.custom({ overlay: true }). Done callback
 * receives the selected nodeId (string) or null on dismiss.
 */

import { matchesKey, truncateToWidth, type Focusable } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { InvestigationNode, InvestigationState } from "../../core/types.js";
import { buildTreeRows, type TreeRow } from "./tree-state.js";

const NUMBERED = ["①", "②", "③", "④", "⑤", "⑥", "⑦", "⑧", "⑨", "⑩"];

export class TreeOverlay implements Focusable {
  focused = false;

  private rows: TreeRow[] = [];
  private selectedIdx = 0;
  private searchText = "";
  private searchMode = false;
  private branchFilter = false;
  private showPreview = false;

  constructor(
    private state: InvestigationState,
    private theme: Theme,
    private currentNodeId: string | null,
    private done: (result: string | null) => void,
  ) {
    this.refresh();
    // Position cursor on currently selected node.
    if (currentNodeId) {
      const idx = this.rows.findIndex((r) => r.node.id === currentNodeId);
      if (idx >= 0) this.selectedIdx = idx;
    }
  }

  private refresh(): void {
    this.rows = buildTreeRows(this.state, {
      searchText: this.searchText || undefined,
      branchFilter: this.branchFilter ? (this.currentNodeId ?? undefined) : undefined,
    });
  }

  // ---------------------------------------------------------------------------
  // Keyboard handling
  // ---------------------------------------------------------------------------

  handleInput(data: string): void {
    if (this.searchMode) {
      this.handleSearchInput(data);
      return;
    }

    if (matchesKey(data, "escape")) {
      this.done(null);
      return;
    }
    if (matchesKey(data, "return")) {
      const row = this.rows[this.selectedIdx];
      if (row) this.done(row.node.id);
      return;
    }
    if (matchesKey(data, "up")) {
      this.selectedIdx = Math.max(0, this.selectedIdx - 1);
      return;
    }
    if (matchesKey(data, "down")) {
      this.selectedIdx = Math.min(this.rows.length - 1, this.selectedIdx + 1);
      return;
    }
    if (data === "/") {
      this.searchMode = true;
      return;
    }
    if (data === "q" || data === "Q") {
      this.showPreview = !this.showPreview;
      return;
    }
    if (data === "f" || data === "F") {
      this.branchFilter = !this.branchFilter;
      this.refresh();
      this.selectedIdx = Math.min(this.selectedIdx, Math.max(0, this.rows.length - 1));
      return;
    }
    // 't' and other actions are dispatched by the command handler, not the overlay.
  }

  private handleSearchInput(data: string): void {
    if (matchesKey(data, "escape") || matchesKey(data, "return")) {
      this.searchMode = false;
      this.refresh();
      this.selectedIdx = Math.min(this.selectedIdx, Math.max(0, this.rows.length - 1));
      return;
    }
    if (matchesKey(data, "backspace")) {
      this.searchText = this.searchText.slice(0, -1);
      this.refresh();
      return;
    }
    if (data.length === 1 && data.charCodeAt(0) >= 32) {
      this.searchText += data;
      this.refresh();
    }
  }

  // ---------------------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------------------

  render(width: number): string[] {
    const th = this.theme;
    const W = Math.min(width, 90);
    const inner = W - 2;
    const lines: string[] = [];

    const pad = (s: string, len: number): string => {
      const vis = visibleLen(s);
      return s + " ".repeat(Math.max(0, len - vis));
    };
    const row = (content: string) =>
      th.fg("border", "│") + truncateToWidth(pad(content, inner), inner) + th.fg("border", "│");

    const nodeCount = this.state.nodes.size;
    const title = th.fg("accent", " pi-investigate") +
      th.fg("dim", ` — Query Tree — ${nodeCount} node${nodeCount === 1 ? "" : "s"}`);
    if (this.branchFilter) {
      lines.push(th.fg("border", `╭${"─".repeat(inner)}╮`));
    } else {
      lines.push(th.fg("border", `╭${"─".repeat(inner)}╮`));
    }
    lines.push(row(title));

    if (this.searchMode) {
      lines.push(row(th.fg("accent", " / ") + th.fg("text", this.searchText) + th.fg("dim", "_")));
    } else if (this.branchFilter) {
      lines.push(row(th.fg("warning", " [branch filter on]")));
    } else {
      lines.push(row(""));
    }

    if (this.rows.length === 0) {
      lines.push(row(th.fg("dim", "  No queries captured yet.")));
    } else {
      const visible = this.visibleRange(this.rows.length, inner);
      for (let i = visible.start; i < visible.end; i++) {
        const treeRow = this.rows[i]!;
        lines.push(row(this.renderRow(treeRow, i, inner)));
      }
    }

    // Preview pane
    if (this.showPreview) {
      const selected = this.rows[this.selectedIdx];
      if (selected) {
        lines.push(row(th.fg("dim", "─".repeat(inner))));
        for (const l of this.renderPreview(selected.node, inner)) {
          lines.push(row(l));
        }
      }
    }

    lines.push(row(""));
    const hint = th.fg("dim", " ↑↓ navigate · / search · q preview · f branch · Enter jump · Esc close");
    lines.push(row(hint));
    lines.push(th.fg("border", `╰${"─".repeat(inner)}╯`));

    return lines;
  }

  private visibleRange(total: number, innerW: number): { start: number; end: number } {
    const maxVisible = Math.max(5, innerW > 60 ? 20 : 12);
    let start = Math.max(0, this.selectedIdx - Math.floor(maxVisible / 2));
    const end = Math.min(total, start + maxVisible);
    start = Math.max(0, end - maxVisible);
    return { start, end };
  }

  private renderRow(treeRow: TreeRow, idx: number, _innerW: number): string {
    const th = this.theme;
    const { node, isLast, prefixParts } = treeRow;
    const isSelected = idx === this.selectedIdx;

    // Tree branch prefix
    let prefix = "";
    for (const part of prefixParts) {
      prefix += th.fg("dim", part === "│" ? "│  " : "   ");
    }
    prefix += th.fg("dim", isLast ? "└─ " : "├─ ");

    // Circle number for first 10
    const num = NUMBERED[idx] ? th.fg("dim", NUMBERED[idx]!) + " " : "";

    // Label
    const label = node.label === "..." ? th.fg("dim", "...") : isSelected
      ? th.fg("accent", node.label)
      : th.fg("text", node.label);

    // Meta (record count, age)
    const recCount = node.data.resultMeta?.recordCount ?? 0;
    const age = formatAge(node.timestamp);
    const meta = th.fg("dim", `  ${recCount} rec · ${age}`);

    // Selected indicator
    const cursor = isSelected ? " " + th.fg("accent", "◀") : "";

    return `${prefix}${num}${label}${meta}${cursor}`;
  }

  private renderPreview(node: InvestigationNode, innerW: number): string[] {
    const th = this.theme;
    const lines: string[] = [];

    if ("query" in node.data && node.data.query) {
      lines.push(th.fg("dim", " Query: ") + th.fg("text", String(node.data.query).slice(0, innerW - 10)));
    }

    const preview = node.data.resultPreview;
    if (preview && preview.columns.length > 0) {
      lines.push(th.fg("dim", " Cols: ") + th.fg("muted", preview.columns.slice(0, 6).join(", ")));
      lines.push(th.fg("dim", ` Rows: ${node.data.resultMeta.recordCount}`));
    }

    if (lines.length === 0) {
      lines.push(th.fg("dim", " (no preview available)"));
    }
    return lines;
  }

  invalidate(): void {}
  dispose(): void {}
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Approximate visible length (strip ANSI escapes). */
function visibleLen(s: string): number {
  // biome-ignore lint: simple regex for ANSI strip
  return s.replace(/\x1b\[[0-9;]*m/g, "").length;
}

function formatAge(timestamp: number): string {
  const seconds = Math.floor((Date.now() - timestamp) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ago`;
}

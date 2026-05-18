/**
 * Table viewer — full-screen result viewer for Query Tree nodes.
 *
 * Loads full results from disk cache (lazy), falls back to inline preview.
 * Supports row/column scrolling, sorting, search, and CSV/JSON/TSV export.
 */

import { matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { CachedResult, InvestigationNode, InvestigateConfig } from "../../core/types.js";
import { readCachedResult } from "./result-store.js";
import { resolveCacheDir } from "../../core/config.js";

type ExportFormat = "csv" | "json" | "tsv";

export class TableViewer {
  private columns: string[] = [];
  private rows: unknown[][] = [];
  private totalRows = 0;
  private loaded = false;

  private scrollRow = 0;
  private scrollCol = 0;
  private sortCol: number | null = null;
  private sortAsc = true;
  private searchText = "";
  private searchMode = false;
  private statusMsg = "";

  constructor(
    private node: InvestigationNode,
    private theme: Theme,
    private config: InvestigateConfig,
    private sessionId: string,
    private done: () => void,
  ) {
    this.loadData();
  }

  private loadData(): void {
    // Try disk cache first.
    const cacheDir = resolveCacheDir(this.config);
    const cached = readCachedResult(cacheDir, this.sessionId, this.node.id);
    if (cached) {
      this.columns = cached.columns;
      this.rows = cached.rows;
      this.totalRows = cached.totalRows;
      this.loaded = true;
      return;
    }

    // Fall back to inline preview.
    const preview = this.node.data.resultPreview;
    if (preview) {
      this.columns = preview.columns;
      this.rows = preview.rows;
      this.totalRows = this.node.data.resultMeta.recordCount;
      this.statusMsg = preview.truncated
        ? `Showing first ${this.rows.length} of ${this.totalRows} rows (cache missing)`
        : "";
      this.loaded = true;
    }
  }

  handleInput(data: string): void {
    if (this.searchMode) {
      this.handleSearchInput(data);
      return;
    }

    if (matchesKey(data, "escape") || data === "q" || data === "Q") {
      this.done();
      return;
    }
    if (matchesKey(data, "up")) { this.scrollRow = Math.max(0, this.scrollRow - 1); return; }
    if (matchesKey(data, "down")) { this.scrollRow = Math.min(Math.max(0, this.filteredRows().length - 1), this.scrollRow + 1); return; }
    if (matchesKey(data, "left")) { this.scrollCol = Math.max(0, this.scrollCol - 1); return; }
    if (matchesKey(data, "right")) { this.scrollCol = Math.min(Math.max(0, this.columns.length - 1), this.scrollCol + 1); return; }
    if (data === "/") { this.searchMode = true; return; }
    if (data === "s" || data === "S") { this.cycleSortCol(); return; }
    if (data === "e" || data === "E") { this.exportCsv(); return; }
    if (data === "j" || data === "J") { this.exportJson(); return; }
    if (data === "t" || data === "T") { this.exportTsv(); return; }
  }

  private handleSearchInput(data: string): void {
    if (matchesKey(data, "escape") || matchesKey(data, "return")) {
      this.searchMode = false;
      this.scrollRow = 0;
      return;
    }
    if (matchesKey(data, "backspace")) {
      this.searchText = this.searchText.slice(0, -1);
      return;
    }
    if (data.length === 1 && data.charCodeAt(0) >= 32) {
      this.searchText += data;
    }
  }

  private cycleSortCol(): void {
    if (this.sortCol === null) {
      this.sortCol = 0;
      this.sortAsc = true;
    } else if (this.sortAsc) {
      this.sortAsc = false;
    } else {
      this.sortCol = (this.sortCol + 1) % Math.max(1, this.columns.length);
      this.sortAsc = true;
    }
  }

  private filteredRows(): unknown[][] {
    let result = [...this.rows];
    if (this.searchText) {
      const q = this.searchText.toLowerCase();
      result = result.filter((r) => r.some((v) => formatCell(v).toLowerCase().includes(q)));
    }
    if (this.sortCol !== null) {
      const col = this.sortCol;
      const asc = this.sortAsc;
      result.sort((a, b) => {
        const av = formatCell(a[col]);
        const bv = formatCell(b[col]);
        return asc ? av.localeCompare(bv) : bv.localeCompare(av);
      });
    }
    return result;
  }

  render(width: number): string[] {
    const th = this.theme;
    const lines: string[] = [];
    const filtered = this.filteredRows();

    // Header bar
    const label = this.node.label.slice(0, 40);
    lines.push(
      th.fg("accent", ` ▶ ${label}`) +
      th.fg("dim", `  ${filtered.length}/${this.totalRows} rows`),
    );
    lines.push(th.fg("borderMuted", "─".repeat(width)));

    if (!this.loaded || this.columns.length === 0) {
      lines.push(th.fg("dim", "  No data available."));
      lines.push("");
      lines.push(th.fg("dim", "  q/Esc close"));
      return lines;
    }

    // Column headers
    const colWidth = Math.max(12, Math.floor((width - 2) / Math.max(1, this.columns.length)));
    const visibleCols = this.columns.slice(this.scrollCol, this.scrollCol + Math.floor(width / colWidth));

    const headerParts = visibleCols.map((col, i) => {
      const absIdx = i + this.scrollCol;
      const sortMark = this.sortCol === absIdx ? (this.sortAsc ? "▲" : "▼") : "";
      return truncateToWidth(
        th.fg("accent", (col + sortMark).padEnd(colWidth - 1)),
        colWidth - 1,
      );
    });
    lines.push(" " + headerParts.join(th.fg("borderMuted", "|")));
    lines.push(th.fg("borderMuted", "─".repeat(width)));

    // Data rows
    const maxDataRows = 30;
    const dataRows = filtered.slice(this.scrollRow, this.scrollRow + maxDataRows);
    for (const row of dataRows) {
      const cells = visibleCols.map((_, i) => {
        const absIdx = i + this.scrollCol;
        const val = formatCell(row[absIdx]);
        return truncateToWidth(val.padEnd(colWidth - 1), colWidth - 1);
      });
      lines.push(" " + cells.join(th.fg("borderMuted", "|")));
    }

    // Footer
    lines.push(th.fg("borderMuted", "─".repeat(width)));
    const searchHint = this.searchMode
      ? th.fg("accent", "/ ") + th.fg("text", this.searchText) + th.fg("dim", "_")
      : th.fg("dim", "↑↓ scroll · s sort · / search · e csv · j json · t tsv · q close");
    lines.push(" " + searchHint);
    if (this.statusMsg) {
      lines.push(th.fg("warning", " " + this.statusMsg));
    }

    return lines;
  }

  private exportData(format: ExportFormat): void {
    const rows = this.filteredRows();
    const ts = new Date().toISOString().slice(0, 19).replace(/:/g, "-");
    const filename = join(homedir(), "Downloads", `inv-export-${ts}.${format}`);

    let content: string;
    if (format === "json") {
      const objects = rows.map((r) =>
        Object.fromEntries(this.columns.map((col, i) => [col, r[i]])),
      );
      content = JSON.stringify(objects, null, 2);
    } else {
      const sep = format === "tsv" ? "\t" : ",";
      const escape = (v: string) =>
        format === "csv" ? `"${v.replace(/"/g, '""')}"` : v;
      const header = this.columns.map(escape).join(sep);
      const body = rows.map((r) => r.map((v) => escape(String(v ?? ""))).join(sep));
      content = [header, ...body].join("\n");
    }

    try {
      writeFileSync(filename, content, "utf8");
      this.statusMsg = `Exported to ${filename}`;
    } catch {
      this.statusMsg = "Export failed — check Downloads directory permissions";
    }
  }

  private exportCsv() { this.exportData("csv"); }
  private exportJson() { this.exportData("json"); }
  private exportTsv() { this.exportData("tsv"); }

  invalidate(): void {}
  dispose(): void {}
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Format a cell value for display.
 * Nested objects and arrays are compactly JSON-stringified rather than
 * producing the useless "[object Object]" default.
 */
function formatCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "object") {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

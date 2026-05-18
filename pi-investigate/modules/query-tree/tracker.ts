/**
 * Query Tree tracker — detects dtctl query commands and creates investigation nodes.
 *
 * Flow:
 *   tool_call (bash)  → detectDtctlQuery → record PendingQuery keyed by toolCallId
 *   tool_result (bash) → match toolCallId → parse output → create InvestigationNode
 *
 * Parent assignment uses the investigation cursor at the time the command
 * starts, not when the result arrives.
 */

import { randomUUID } from "node:crypto";
import type { InvestigateConfig, InvestigateEventBus, InvestigationNode, InvestigationState } from "../../core/types.js";
import { addNode, getNode } from "../../core/state.js";
import { resolveCacheDir } from "../../core/config.js";
import { detectDtctlQuery, parseQueryOutput } from "./parser.js";
import { fallbackLabel, requestLabel } from "./label-generator.js";
import { writeCachedResult } from "./result-store.js";

// ---------------------------------------------------------------------------
// Pending query record
// ---------------------------------------------------------------------------

interface PendingQuery {
  toolCallId: string;
  query: string | null;
  fileQuery: boolean;
  queryFile?: string;
  parentNodeId: string | null;
  contextHint: string | undefined;
  startedAt: number;
}

// ---------------------------------------------------------------------------
// Tracker
// ---------------------------------------------------------------------------

export class QueryTreeTracker {
  /** toolCallId → pending query */
  private pending = new Map<string, PendingQuery>();
  /** The node the user last explicitly selected (investigation cursor). */
  private selectedNodeId: string | null = null;

  constructor(
    private state: InvestigationState,
    private events: InvestigateEventBus,
    private config: InvestigateConfig,
    private appendEntry: (customType: string, data: unknown) => void,
    private updateNodeLabel: (nodeId: string, label: string, state: "ready" | "fallback") => void,
  ) {}

  /**
   * Called from tool_call. Records a pending query if the bash command is
   * a supported dtctl query invocation.
   */
  onToolCall(toolCallId: string, command: string, contextHint?: string): void {
    const detected = detectDtctlQuery(command);
    if (!detected) return;

    this.pending.set(toolCallId, {
      toolCallId,
      query: detected.query,
      fileQuery: detected.fileQuery,
      queryFile: detected.queryFile,
      parentNodeId: this.selectedNodeId,
      contextHint,
      startedAt: Date.now(),
    });
  }

  /**
   * Called from tool_result. Resolves the pending query and creates a node
   * if the command succeeded.
   */
  onToolResult(
    toolCallId: string,
    stdout: string,
    isError: boolean,
    exitCode?: number,
  ): void {
    const pending = this.pending.get(toolCallId);
    if (!pending) return;
    this.pending.delete(toolCallId);

    // Failed commands do not create nodes.
    if (isError || (exitCode !== undefined && exitCode !== 0)) return;

    this.createNode(pending, stdout);
  }

  /** Update the investigation cursor when the user selects a node. */
  setSelectedNode(nodeId: string | null): void {
    this.selectedNodeId = nodeId;
    if (nodeId) this.events.emit("node:selected", nodeId);
  }

  getSelectedNodeId(): string | null {
    return this.selectedNodeId;
  }

  // ---------------------------------------------------------------------------
  // Node creation
  // ---------------------------------------------------------------------------

  private createNode(pending: PendingQuery, stdout: string): void {
    const maxNodes = this.config.maxTreeNodes ?? 500;
    if (this.state.nodes.size >= maxNodes) return;

    const parsed = parseQueryOutput(stdout);
    const maxPreview = this.config.maxPreviewRows ?? 20;
    const durationMs = Date.now() - pending.startedAt;

    const nodeId = randomUUID();
    const query = pending.query ?? "";

    const resultPreview =
      parsed.columns.length > 0
        ? {
            columns: parsed.columns,
            rows: parsed.rows.slice(0, maxPreview),
            truncated: parsed.rows.length > maxPreview,
          }
        : undefined;

    // Persist to session. The entry ID (assigned by pi) is not returned by
    // appendEntry(). We use nodeId as the sessionEntryId placeholder — reconstruction
    // sets it to the real entry ID by scanning sessionManager.getEntries().
    const nodeData = {
      schemaVersion: 1 as const,
      nodeType: "dql" as const,
      captureConfidence: parsed.confidence,
      query,
      resultMeta: {
        recordCount: parsed.recordCount,
        columns: parsed.columns.length > 0 ? parsed.columns : undefined,
        durationMs,
      },
      resultPreview,
      labelState: "pending" as const,
    };

    this.appendEntry("investigate:query-tree:node", {
      schemaVersion: 1,
      nodeId,
      parentNodeId: pending.parentNodeId,
      branchHint: pending.branchHint,
      timestamp: Date.now(),
      label: "...",
      data: nodeData,
    });

    const node: InvestigationNode = {
      id: nodeId,
      sessionEntryId: nodeId, // placeholder; reconstruction updates this
      module: "query-tree",
      type: "dql",
      label: "...",
      timestamp: Date.now(),
      parentNodeId: pending.parentNodeId,
      branchHint: pending.branchHint,
      data: nodeData,
    };

    addNode(this.state, node);
    this.events.emit("node:created", node);

    // Wire the new node as the selected cursor so subsequent queries attach.
    this.selectedNodeId = nodeId;

    // Write full result cache asynchronously (non-fatal).
    if (parsed.columns.length > 0 && parsed.rows.length > 0) {
      const cacheDir = resolveCacheDir(this.config);
      const path = writeCachedResult(cacheDir, this.state.sessionId, nodeId, {
        schemaVersion: 1,
        columns: parsed.columns,
        rows: parsed.rows,
        totalRows: parsed.recordCount,
        query,
        timestamp: Date.now(),
      });

      if (path) {
        const existing = getNode(this.state, nodeId);
        if (existing) {
          existing.data = { ...existing.data, resultPath: path } as typeof existing.data;
        }
      }
    }

    // Request a label asynchronously.
    const previousQuery = this.findPreviousQuery(pending.parentNodeId);
    requestLabel(query || "manual marker", previousQuery, pending.contextHint, (label, labelState) => {
      this.updateNodeLabel(nodeId, label, labelState);
    });
  }

  /** Add a manual marker node at the current investigation cursor. */
  addManualMarker(label: string): InvestigationNode | null {
    const maxNodes = this.config.maxTreeNodes ?? 500;
    if (this.state.nodes.size >= maxNodes) return null;

    const nodeId = randomUUID();
    const nodeData = {
      schemaVersion: 1 as const,
      nodeType: "manual" as const,
      resultMeta: { recordCount: 0 },
      labelState: "ready" as const,
    };

    const sessionEntryId = this.appendEntry("investigate:query-tree:node", {
      schemaVersion: 1,
      nodeId,
      parentNodeId: this.selectedNodeId,
      timestamp: Date.now(),
      label,
      data: nodeData,
    });

    const node: InvestigationNode = {
      id: nodeId,
      sessionEntryId,
      module: "query-tree",
      type: "manual",
      label,
      timestamp: Date.now(),
      parentNodeId: this.selectedNodeId,
      data: nodeData,
    };

    addNode(this.state, node);
    this.events.emit("node:created", node);
    this.selectedNodeId = nodeId;
    return node;
  }

  /** Find the query text of the most recent ancestor node. */
  private findPreviousQuery(parentNodeId: string | null): string | null {
    if (!parentNodeId) return null;
    const parent = getNode(this.state, parentNodeId);
    if (!parent) return null;
    if ("query" in parent.data && parent.data.query) return parent.data.query as string;
    return this.findPreviousQuery(parent.parentNodeId);
  }
}

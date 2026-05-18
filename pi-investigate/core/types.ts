/**
 * Core shared types for pi-investigate.
 *
 * All persisted payloads carry schemaVersion: 1 so future migrations can
 * detect and upgrade old data.
 */

// ---------------------------------------------------------------------------
// Node model
// ---------------------------------------------------------------------------

export type CaptureConfidence = "high" | "medium" | "low";
export type LabelState = "ready" | "pending" | "fallback";
export type NodeType = "dql" | "manual";

export interface QueryTreeNodeData {
  schemaVersion: 1;
  nodeType: NodeType;
  captureConfidence?: CaptureConfidence;
  query?: string;
  content?: string;
  resultMeta: {
    recordCount: number;
    columns?: string[];
    durationMs?: number;
  };
  resultPreview?: {
    columns: string[];
    rows: unknown[][];
    truncated: boolean;
  };
  /** Absolute path to the full cached result file on disk. */
  resultPath?: string;
  labelState?: LabelState;
}

export type InvestigationNodeData = QueryTreeNodeData;

export interface InvestigationNode {
  id: string;
  /** ID returned by pi.appendEntry() for this investigation entry. */
  sessionEntryId: string;
  module: "query-tree" | string;
  type: string;
  label: string;
  timestamp: number;
  parentNodeId: string | null;
  branchHint?: string;
  data: InvestigationNodeData;
}

// ---------------------------------------------------------------------------
// Session state
// ---------------------------------------------------------------------------

export interface InvestigationState {
  schemaVersion: 1;
  sessionId: string;
  nodes: Map<string, InvestigationNode>;
  activeModules: string[];
}

// ---------------------------------------------------------------------------
// Disk cache payload
// ---------------------------------------------------------------------------

export interface CachedResult {
  schemaVersion: 1;
  columns: string[];
  columnTypes?: string[];
  rows: unknown[][];
  totalRows: number;
  query: string;
  timestamp: number;
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface InvestigateConfig {
  modules: {
    "query-tree": { enabled: boolean };
    "case-mgmt": { enabled: boolean; provider: "jira" | "snow" };
  };
  labelModel?: string;
  cacheDir?: string;
  maxTreeNodes?: number;
  maxPreviewRows?: number;
}

export const DEFAULT_CONFIG: InvestigateConfig = {
  modules: {
    "query-tree": { enabled: true },
    "case-mgmt": { enabled: false, provider: "jira" },
  },
  maxTreeNodes: 500,
  maxPreviewRows: 20,
};

// ---------------------------------------------------------------------------
// Internal event bus types
// ---------------------------------------------------------------------------

export type InvestigateEvents = {
  "node:created": [node: InvestigationNode];
  "node:updated": [node: InvestigationNode];
  "node:selected": [nodeId: string];
  "tree:rebuilt": [];
};

export interface InvestigateEventBus {
  emit<K extends keyof InvestigateEvents>(event: K, ...args: InvestigateEvents[K]): void;
  on<K extends keyof InvestigateEvents>(
    event: K,
    handler: (...args: InvestigateEvents[K]) => void,
  ): void;
  off<K extends keyof InvestigateEvents>(
    event: K,
    handler: (...args: InvestigateEvents[K]) => void,
  ): void;
}

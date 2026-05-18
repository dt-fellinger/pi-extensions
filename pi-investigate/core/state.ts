/**
 * Shared investigation state.
 *
 * Holds the session-global node map and exposes helper methods for adding,
 * updating, and querying nodes. The state is rebuilt from session entries on
 * session_start and session_tree events.
 */

import type { InvestigationNode, InvestigationState } from "./types.js";

export function createState(sessionId: string): InvestigationState {
  return {
    schemaVersion: 1,
    sessionId,
    nodes: new Map<string, InvestigationNode>(),
    activeModules: [],
  };
}

/** Add or replace a node in the map. */
export function addNode(state: InvestigationState, node: InvestigationNode): void {
  state.nodes.set(node.id, node);
}

/**
 * Update a node with partial fields (last-write-wins).
 * If the node doesn't exist yet, does nothing.
 */
export function updateNode(
  state: InvestigationState,
  id: string,
  patch: Partial<Omit<InvestigationNode, "id">>,
): boolean {
  const existing = state.nodes.get(id);
  if (!existing) return false;
  state.nodes.set(id, { ...existing, ...patch });
  return true;
}

/** Retrieve a node by ID. */
export function getNode(state: InvestigationState, id: string): InvestigationNode | undefined {
  return state.nodes.get(id);
}

/** Return all nodes whose parentNodeId matches the given id. */
export function getChildren(state: InvestigationState, parentId: string): InvestigationNode[] {
  const result: InvestigationNode[] = [];
  for (const node of state.nodes.values()) {
    if (node.parentNodeId === parentId) {
      result.push(node);
    }
  }
  return result.sort((a, b) => a.timestamp - b.timestamp);
}

/** Return all nodes without a parent (roots). */
export function getRoots(state: InvestigationState): InvestigationNode[] {
  const result: InvestigationNode[] = [];
  for (const node of state.nodes.values()) {
    if (node.parentNodeId === null) {
      result.push(node);
    }
  }
  return result.sort((a, b) => a.timestamp - b.timestamp);
}

/** Return nodes in insertion order (all modules). */
export function getAllNodes(state: InvestigationState): InvestigationNode[] {
  return [...state.nodes.values()].sort((a, b) => a.timestamp - b.timestamp);
}

/** Reset state in-place for a new session (preserves object reference). */
export function resetState(state: InvestigationState, sessionId: string): void {
  state.sessionId = sessionId;
  state.nodes.clear();
  state.activeModules = [];
}

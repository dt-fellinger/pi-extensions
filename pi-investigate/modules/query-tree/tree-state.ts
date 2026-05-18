/**
 * Tree state — ordered parent-child view for rendering.
 *
 * Builds a depth-first pre-order list of nodes suitable for the overlay,
 * supporting branch-local filtering and search.
 */

import type { InvestigationNode, InvestigationState } from "../../core/types.js";
import { getChildren, getRoots } from "../../core/state.js";

export interface TreeRow {
  node: InvestigationNode;
  depth: number;
  isLast: boolean;
  /** Prefix characters for drawing tree branches, one per ancestor level. */
  prefixParts: ("│" | " ")[];
}

/**
 * Build the full session-global tree in depth-first pre-order.
 *
 * If branchFilter is set, only nodes in that branch path (and their
 * subtrees) are included; orphans are appended at depth 0.
 */
export function buildTreeRows(
  state: InvestigationState,
  options: { branchFilter?: string; searchText?: string } = {},
): TreeRow[] {
  const roots = getRoots(state);
  const rows: TreeRow[] = [];

  for (let i = 0; i < roots.length; i++) {
    const isLast = i === roots.length - 1;
    walk(state, roots[i]!, 0, [], isLast, rows, options);
  }

  // Append orphan nodes (parentNodeId set but parent missing) at root level.
  for (const node of state.nodes.values()) {
    if (
      node.parentNodeId !== null &&
      !state.nodes.has(node.parentNodeId) &&
      !rows.some((r) => r.node.id === node.id)
    ) {
      rows.push({ node, depth: 0, isLast: true, prefixParts: [] });
    }
  }

  if (!options.searchText) return rows;

  // Apply search filter — keep rows that match label or query.
  const q = options.searchText.toLowerCase();
  return rows.filter(
    (r) =>
      r.node.label.toLowerCase().includes(q) ||
      ("query" in r.node.data && typeof r.node.data.query === "string" &&
        r.node.data.query.toLowerCase().includes(q)),
  );
}

function walk(
  state: InvestigationState,
  node: InvestigationNode,
  depth: number,
  prefixParts: ("│" | " ")[],
  isLast: boolean,
  out: TreeRow[],
  options: { branchFilter?: string; searchText?: string },
): void {
  out.push({ node, depth, isLast, prefixParts: [...prefixParts] });

  const children = getChildren(state, node.id);
  const childPrefixParts: ("│" | " ")[] = [...prefixParts, isLast ? " " : "│"];

  for (let i = 0; i < children.length; i++) {
    const child = children[i]!;
    const childIsLast = i === children.length - 1;
    walk(state, child, depth + 1, childPrefixParts, childIsLast, out, options);
  }
}

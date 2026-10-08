import type { PluginSidebarThread } from "@bb/plugin-sdk";

/**
 * A family keeps every descendant in one flat list, which is what bulk
 * guards, status, and counts want. Drawing that list flat, though, puts a
 * grandchild on the same level as its parent, unlike bb's own sidebar. This
 * turns the flat list back into tree order with a depth per row, without
 * changing the family model the rest of the inbox relies on.
 */
export interface FamilyTreeRow {
  thread: PluginSidebarThread;
  /** 1 for a direct child of the root, 2 for a grandchild, and so on. */
  depth: number;
  /** Everything drawn under this row, in tree order; empty for a leaf. */
  descendants: readonly PluginSidebarThread[];
}

/**
 * Indentation stops growing past this depth. The sidebar is narrow, and a
 * deep chain should stay readable rather than walk off the edge; the true
 * depth is still reported on the row.
 */
export const MAX_INDENTED_DEPTH = 4;

/**
 * Orders a family's descendants depth-first under `rootId`, siblings oldest
 * first — the same order the family already uses — and reports each one's
 * depth.
 *
 * Only threads in `children` are trusted as parents. A child whose parent is
 * not in the list (hidden by search, parked, or unknown) is drawn as a direct
 * child of the root rather than dropped. Threads caught in a parent cycle never
 * hang off the root, so they are appended at depth 1 instead of disappearing.
 */
export function familyTreeRows(
  rootId: string,
  children: readonly PluginSidebarThread[],
): FamilyTreeRow[] {
  const listed = new Set(children.map((child) => child.id));
  const kidsByParent = new Map<string, PluginSidebarThread[]>();
  for (const child of children) {
    const parentId =
      child.parentThreadId !== null &&
      child.parentThreadId !== child.id &&
      listed.has(child.parentThreadId)
        ? child.parentThreadId
        : rootId;
    const kids = kidsByParent.get(parentId) ?? [];
    kids.push(child);
    kidsByParent.set(parentId, kids);
  }
  for (const kids of kidsByParent.values()) {
    kids.sort(
      (left, right) =>
        left.createdAt - right.createdAt || left.id.localeCompare(right.id),
    );
  }

  const rows: FamilyTreeRow[] = [];
  const placed = new Set<string>();
  // Returns what it drew, so each row can carry its own descendants.
  const place = (kid: PluginSidebarThread, depth: number): PluginSidebarThread[] => {
    placed.add(kid.id);
    const row: FamilyTreeRow = { thread: kid, depth, descendants: [] };
    rows.push(row);
    const descendants = visit(kid.id, depth + 1);
    row.descendants = descendants;
    return [kid, ...descendants];
  };
  const visit = (parentId: string, depth: number): PluginSidebarThread[] => {
    const drawn: PluginSidebarThread[] = [];
    for (const kid of kidsByParent.get(parentId) ?? []) {
      if (placed.has(kid.id)) continue;
      drawn.push(...place(kid, depth));
    }
    return drawn;
  };
  visit(rootId, 1);

  for (const child of children) {
    if (!placed.has(child.id)) place(child, 1);
  }
  return rows;
}

/**
 * Drops the rows hidden under folded subtrees. Rows arrive in tree order,
 * so everything deeper than a folded row, up to the next row at its depth
 * or shallower, is that row's subtree.
 */
export function foldTreeRows(
  rows: readonly FamilyTreeRow[],
  isExpanded: (row: FamilyTreeRow) => boolean,
): FamilyTreeRow[] {
  const shown: FamilyTreeRow[] = [];
  let foldedAt: number | null = null;
  for (const row of rows) {
    if (foldedAt !== null && row.depth > foldedAt) continue;
    foldedAt = null;
    shown.push(row);
    if (row.descendants.length > 0 && !isExpanded(row)) foldedAt = row.depth;
  }
  return shown;
}

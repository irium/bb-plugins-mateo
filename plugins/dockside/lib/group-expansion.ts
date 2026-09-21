/**
 * Which sidebar groups the user folded away, kept across reloads and across the
 * filter preset switch that unmounts one set of groups to render the other.
 *
 * Only collapsed ids are stored. Expanded is the default, so a project the user
 * never touched — and every project that appears later — opens without needing a
 * write, and the stored list stays short for the way people actually work.
 */
export const GROUP_EXPANSION_STORAGE_KEY = "bb.dockside.group-expansion.v1";
export const MAX_COLLAPSED_GROUPS = 200;
const MAX_ID_LENGTH = 200;
const SAFE_ID = /^[^\u0000-\u001F\u007F]+$/;

/** Project groups are keyed by project id, status groups by status kind. */
export type GroupKind = "project" | "status";

export interface GroupExpansionStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface CollapsedGroups {
  readonly project: readonly string[];
  readonly status: readonly string[];
}

export const NO_COLLAPSED_GROUPS: CollapsedGroups = { project: [], status: [] };

export function decodeCollapsedGroups(raw: string | null): CollapsedGroups {
  if (raw === null || raw.length > 32_000) return NO_COLLAPSED_GROUPS;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return NO_COLLAPSED_GROUPS;
    }
    const record = parsed as Record<string, unknown>;
    const project = readIds(record.project);
    const status = readIds(record.status);
    // One malformed half must not discard the other.
    return { project, status };
  } catch {
    return NO_COLLAPSED_GROUPS;
  }
}

export function readCollapsedGroups(
  storage: GroupExpansionStorage | null = browserStorage(),
): CollapsedGroups {
  if (storage === null) return NO_COLLAPSED_GROUPS;
  try {
    return decodeCollapsedGroups(storage.getItem(GROUP_EXPANSION_STORAGE_KEY));
  } catch {
    return NO_COLLAPSED_GROUPS;
  }
}

export function writeCollapsedGroups(
  collapsed: CollapsedGroups,
  storage: GroupExpansionStorage | null = browserStorage(),
): boolean {
  if (storage === null || !validIds(collapsed.project) || !validIds(collapsed.status)) {
    return false;
  }
  try {
    storage.setItem(
      GROUP_EXPANSION_STORAGE_KEY,
      JSON.stringify({ project: collapsed.project, status: collapsed.status }),
    );
    return true;
  } catch {
    return false;
  }
}

export function isGroupCollapsed(
  collapsed: CollapsedGroups,
  kind: GroupKind,
  id: string,
): boolean {
  return collapsed[kind].includes(id);
}

/**
 * Returns the same object when nothing changes, so callers can skip a write and
 * a render for a click that asks for the state a group is already in.
 */
export function setGroupCollapsed(
  collapsed: CollapsedGroups,
  kind: GroupKind,
  id: string,
  next: boolean,
): CollapsedGroups {
  if (!validId(id)) return collapsed;
  const current = collapsed[kind];
  if (current.includes(id) === next) return collapsed;
  const updated = next
    ? [...current, id].slice(-MAX_COLLAPSED_GROUPS)
    : current.filter((entry) => entry !== id);
  return { ...collapsed, [kind]: updated };
}

/**
 * Drops collapsed ids for projects that no longer exist. Without this they
 * accumulate forever, and once the list reaches its cap a new collapse evicts
 * the oldest entry instead — quietly re-expanding a project the user had
 * folded on purpose.
 *
 * The caller owns the definition of "live" and must pass a list it trusts:
 * pruning against a project list that has not loaded yet, or one that omits
 * projects whose threads are all parked, would forget them all at once.
 * Status ids are a fixed set and never go stale, so they are left alone.
 */
export function pruneCollapsedGroups(
  collapsed: CollapsedGroups,
  liveProjectIds: Iterable<string>,
): CollapsedGroups {
  const live = new Set(liveProjectIds);
  const project = collapsed.project.filter((id) => live.has(id));
  if (project.length === collapsed.project.length) return collapsed;
  return { ...collapsed, project };
}

function readIds(value: unknown): readonly string[] {
  if (!Array.isArray(value) || !validIds(value)) return [];
  return [...value];
}

function validIds(value: readonly unknown[]): value is readonly string[] {
  return (
    value.length <= MAX_COLLAPSED_GROUPS &&
    value.every((id): id is string => typeof id === "string" && validId(id)) &&
    new Set(value).size === value.length
  );
}

function validId(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= MAX_ID_LENGTH &&
    value.trim() === value &&
    SAFE_ID.test(value)
  );
}

function browserStorage(): GroupExpansionStorage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

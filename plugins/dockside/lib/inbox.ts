import type {
  PluginSidebarProject,
  PluginSidebarThread,
} from "@get-bb/plugin-sdk";

export interface ThreadFamily {
  root: PluginSidebarThread;
  /**
   * Every visible descendant, oldest first, flattened for the compact tree.
   * A descendant may belong to a different project than the root; it is drawn
   * here regardless, under the root's group.
   */
  children: PluginSidebarThread[];
}

export interface ProjectThreadGroup {
  project: PluginSidebarProject;
  families: ThreadFamily[];
}

/**
 * The sort that defines this sidebar: newest thread on top, and NOTHING moves
 * it afterwards. Activity never re-orders the list, so a row holds its place
 * from creation until you park it and the screen only changes when you act.
 * Status is carried by the card, not by position.
 *
 * Ties break on id so the order is total and stable across renders.
 */
export function sortByCreatedAtDescending<
  T extends { readonly id: string; readonly createdAt: number },
>(threads: readonly T[]): T[] {
  return [...threads].sort(
    (left, right) =>
      right.createdAt - left.createdAt || left.id.localeCompare(right.id),
  );
}

export function threadDisplayTitle(thread: PluginSidebarThread): string {
  const title = thread.title?.trim();
  if (title) return title;
  const fallback = thread.titleFallback?.trim();
  return fallback ? fallback : "Untitled thread";
}

/** Every live-work signal bb exposes for a sidebar row. */
export function threadIsWorking(thread: PluginSidebarThread): boolean {
  const { activity } = thread;
  return (
    activity.workflows > 0 ||
    activity.backgroundAgents > 0 ||
    activity.backgroundCommands > 0 ||
    activity.planMode > 0 ||
    activity.goals > 0 ||
    thread.indicator === "runtime" ||
    thread.indicator === "working-draft"
  );
}

/** Substring match on the visible title only, preserving the incoming order. */
export function searchThreadsByTitle(
  threads: readonly PluginSidebarThread[],
  query: string,
): PluginSidebarThread[] {
  const normalized = query.trim().toLowerCase();
  if (normalized.length === 0) return [...threads];
  return threads.filter((thread) =>
    threadDisplayTitle(thread).toLowerCase().includes(normalized),
  );
}

export interface ProjectScope {
  /** Project id, or null for "all projects". */
  id: string | null;
  name: string;
}

/** Threads in the chosen scope; every thread when the scope is null. */
export function filterByProject(
  threads: readonly PluginSidebarThread[],
  projectId: string | null,
): PluginSidebarThread[] {
  if (projectId === null) return [...threads];
  return threads.filter((thread) => thread.projectId === projectId);
}

/**
 * Turn a flat sidebar result into the two stable levels people navigate by:
 * project, then root thread. Descendants stay attached to their oldest visible
 * ancestor and are flattened into one compact agent list.
 *
 * A thread is filed under the project of its ROOT ANCESTOR, not its own. One
 * ticket is routinely a parent thread in an umbrella project plus a child per
 * service repository, each child living in that repository's own bb project;
 * filing every child by its own project scatters that single family across a
 * dozen sidebar groups. This is bb's own rule — `createSidebarProjectIdResolver`
 * in `@bb/client-core` — and matching it is not only about where a row is drawn:
 * the family built here is what the card's status badge, the child count, and
 * the bulk-delete guards all read, so a family missing its cross-project
 * children under-reports to every one of them.
 *
 * A parent that is not in `threads` (parked, archived, filtered, or deleted)
 * cannot own a visible row, so its child becomes a root instead of vanishing —
 * and a root is filed under its OWN project. Parking a parent therefore hands
 * its children back to their own groups rather than stranding them.
 *
 * Project order comes from bb; roots keep the inbox's static creation order,
 * with the user's pinned roots first.
 */
export function groupThreadsByProject(
  threads: readonly PluginSidebarThread[],
  projects: readonly PluginSidebarProject[],
): ProjectThreadGroup[] {
  const projectById = new Map(projects.map((project) => [project.id, project]));
  const projectOrder = new Map(
    projects.map((project, index) => [project.id, index]),
  );

  // One index over the WHOLE list, before anything is split by project: a
  // parent in another project has to be reachable, and an index per bucket
  // cannot see it.
  const threadById = new Map(threads.map((thread) => [thread.id, thread]));
  const rootOf = createVisibleRootResolver(threadById);

  const familyByRootId = new Map<string, ThreadFamily>();
  for (const thread of threads) {
    const root = rootOf(thread);
    let family = familyByRootId.get(root.id);
    if (family === undefined) {
      family = { root, children: [] };
      familyByRootId.set(root.id, family);
    }
    if (thread.id !== root.id) family.children.push(thread);
  }

  // Families are whole before they are bucketed, and the bucket is the root's
  // project. Doing it the other way — bucket first, resolve inside — is what
  // used to break a cross-project family apart.
  const familiesByProject = new Map<string, ThreadFamily[]>();
  for (const family of familyByRootId.values()) {
    const bucket = familiesByProject.get(family.root.projectId) ?? [];
    bucket.push(family);
    familiesByProject.set(family.root.projectId, bucket);
  }

  const groups: ProjectThreadGroup[] = [];
  for (const [projectId, families] of familiesByProject) {
    for (const family of families) {
      family.children.sort(
        (left, right) =>
          left.createdAt - right.createdAt || left.id.localeCompare(right.id),
      );
    }
    families.sort((left, right) => {
      const pinOrder = Number(right.root.isPinned) - Number(left.root.isPinned);
      if (pinOrder !== 0) return pinOrder;
      return (
        right.root.createdAt - left.root.createdAt ||
        left.root.id.localeCompare(right.root.id)
      );
    });

    groups.push({
      project:
        projectById.get(projectId) ??
        ({
          id: projectId,
          name: "Other project",
          isPersonal: false,
        } satisfies PluginSidebarProject),
      families,
    });
  }

  // A project is a place work happens, not only a container for work that
  // already exists. Emitting every project keeps a project with no threads
  // reachable and startable from the sidebar, instead of hiding it until its
  // first thread arrives. Its header still renders the family count and the
  // "New thread in ..." action, so an empty group is a launcher, not a stub.
  // Only a project with no threads of its own is listed empty. A project
  // whose threads all hang off another project's root stays out: listing
  // it would bring back the group-per-service sprawl that filing children
  // under their root exists to remove.
  const projectsWithThreads = new Set(threads.map((thread) => thread.projectId));
  for (const project of projects) {
    if (projectsWithThreads.has(project.id)) continue;
    groups.push({ project, families: [] });
  }

  return groups.sort((left, right) => {
    const leftOrder = projectOrder.get(left.project.id);
    const rightOrder = projectOrder.get(right.project.id);
    if (leftOrder !== undefined || rightOrder !== undefined) {
      return (
        (leftOrder ?? Number.MAX_SAFE_INTEGER) -
        (rightOrder ?? Number.MAX_SAFE_INTEGER)
      );
    }
    return left.project.name.localeCompare(right.project.name);
  });
}

/**
 * Search without throwing away hierarchy. A matching child keeps its parent
 * visible as context; a matching parent keeps all of its children visible.
 */
export function searchProjectThreadGroups(
  groups: readonly ProjectThreadGroup[],
  query: string,
): ProjectThreadGroup[] {
  const normalized = query.trim().toLowerCase();
  if (normalized.length === 0) {
    return groups.filter((group) => group.families.length > 0);
  }

  return groups.flatMap((group) => {
    const projectMatches = group.project.name.toLowerCase().includes(normalized);
    const families = group.families.flatMap((family) => {
      const rootMatches = threadDisplayTitle(family.root)
        .toLowerCase()
        .includes(normalized);
      if (projectMatches || rootMatches) return [family];
      const children = family.children.filter((thread) =>
        threadDisplayTitle(thread).toLowerCase().includes(normalized),
      );
      return children.length > 0 ? [{ ...family, children }] : [];
    });
    return families.length > 0 ? [{ ...group, families }] : [];
  });
}

/**
 * The oldest ancestor of a thread that the list still shows, memoized across
 * the whole grouping pass.
 *
 * The walk stops at the first parent the index cannot resolve — parked,
 * archived, filtered, or deleted — and the thread standing there is the root.
 * It does NOT stop at a project boundary: crossing one is the normal case for
 * a child spawned into a service repository, and stopping there is what used
 * to strand it in a group of its own.
 *
 * Every thread on the chain is recorded, not just the one asked for, so a
 * family of a dozen siblings walks its shared ancestry once rather than once
 * per sibling. That is bb's own approach (`createSidebarProjectIdResolver`)
 * and it is here for the same reason: at this size it buys predictability
 * rather than speed.
 *
 * A cycle in `parentThreadId` resolves to the last thread reached before the
 * loop closes, so which member becomes the root depends on which one is asked
 * about first. bb behaves the same way. The guarantee is only that the walk
 * terminates and that one input list always yields one answer — the caller
 * asks in list order.
 */
function createVisibleRootResolver(
  threadById: ReadonlyMap<string, PluginSidebarThread>,
): (thread: PluginSidebarThread) => PluginSidebarThread {
  const rootByThreadId = new Map<string, PluginSidebarThread>();
  return (thread) => {
    const cached = rootByThreadId.get(thread.id);
    if (cached !== undefined) return cached;

    const chain: PluginSidebarThread[] = [thread];
    const visited = new Set([thread.id]);
    let current = thread;
    let resolved: PluginSidebarThread | undefined;
    while (current.parentThreadId !== null) {
      const parent = threadById.get(current.parentThreadId);
      if (parent === undefined || visited.has(parent.id)) break;
      const parentRoot = rootByThreadId.get(parent.id);
      if (parentRoot !== undefined) {
        resolved = parentRoot;
        break;
      }
      visited.add(parent.id);
      chain.push(parent);
      current = parent;
    }

    const root = resolved ?? current;
    for (const member of chain) rootByThreadId.set(member.id, root);
    return root;
  };
}

/**
 * Archived threads never belong in the inbox — except the ones this plugin
 * parked, which it archives itself.
 *
 * Settling a thread archives it in bb, so leaving the flag alone to decide
 * visibility would empty the settled shelf the instant anything landed on it.
 * A parked row is the plugin saying "I put it there", and that outranks the
 * archive it set.
 */
export function visibleInboxThreads(
  threads: readonly PluginSidebarThread[],
  parkedThreadIds: ReadonlySet<string>,
): PluginSidebarThread[] {
  return threads.filter(
    (thread) => !thread.isArchived || parkedThreadIds.has(thread.id),
  );
}

/** Pinned first (they are the user's own ordering), then the static sort. */
export function partitionPinned(threads: readonly PluginSidebarThread[]): {
  pinned: PluginSidebarThread[];
  inbox: PluginSidebarThread[];
} {
  const pinned: PluginSidebarThread[] = [];
  const inbox: PluginSidebarThread[] = [];
  for (const thread of threads) {
    (thread.isPinned ? pinned : inbox).push(thread);
  }
  return { pinned, inbox };
}

/**
 * Child threads leave the flat list and live in their parent's header chip
 * instead — a flat inbox has nowhere to nest them.
 *
 * A child is only hidden when its parent is actually on screen. An orphan
 * (parent archived, deleted, or filtered out by the project scope) stays in
 * the list, because hiding it would make it unreachable everywhere.
 */
export function hideChildrenOfVisibleParents(
  threads: readonly PluginSidebarThread[],
): PluginSidebarThread[] {
  const visibleIds = new Set(threads.map((thread) => thread.id));
  return threads.filter(
    (thread) =>
      thread.parentThreadId === null || !visibleIds.has(thread.parentThreadId),
  );
}

/**
 * The parent of one thread, or null when the thread is a root, when the id is
 * unknown, or when the parent row is gone (deleted). The parent may be
 * archived or in another project: the flat list hides those, but the child
 * still needs a way back to them.
 */
export function parentOf(
  threads: readonly PluginSidebarThread[],
  threadId: string,
): PluginSidebarThread | null {
  const thread = threads.find((candidate) => candidate.id === threadId);
  const parentThreadId = thread?.parentThreadId;
  if (!parentThreadId) return null;
  return threads.find((candidate) => candidate.id === parentThreadId) ?? null;
}

/** The children of one thread, oldest first (the order they were spawned). */
export function childrenOf(
  threads: readonly PluginSidebarThread[],
  parentThreadId: string,
): PluginSidebarThread[] {
  return threads
    .filter((thread) => thread.parentThreadId === parentThreadId)
    .sort((left, right) => left.createdAt - right.createdAt);
}

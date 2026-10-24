import type { PluginSidebarThread } from "@get-bb/plugin-sdk";
import type { ThreadFamily } from "./inbox.ts";
import { familyIsPinned, type ThreadSection } from "./status-groups.ts";

/** IDs keep same-named worktrees on different machines separate. */
export function environmentSectionKey(thread: PluginSidebarThread): string {
  const { environment, host, projectId } = thread;
  return JSON.stringify([projectId, host?.id, environment?.id ?? environment?.name]);
}

/**
 * Machine names only tell rows apart when the threads span more than one host;
 * on a single machine every row would repeat the same name.
 */
export function threadsSpanSeveralHosts(
  threads: readonly PluginSidebarThread[],
): boolean {
  let firstHostId: string | undefined;
  for (const { host } of threads) {
    if (!host) continue;
    if (firstHostId === undefined) firstHostId = host.id;
    else if (host.id !== firstHostId) return true;
  }
  return false;
}

export function groupSidebarFamilies(
  families: readonly ThreadFamily[],
  showHostNames = true,
): ThreadSection[] {
  const pinned = families.filter(familyIsPinned);
  const remaining = families.filter((family) => !familyIsPinned(family));
  const sections: ThreadSection[] = pinned.length
    ? [{ kind: "pinned", label: "Pinned", families: pinned }]
    : [];
  const environments = new Map<string, ThreadSection>();
  for (const family of remaining) {
    const { environment, host } = family.root;
    const key = environmentSectionKey(family.root);
    let section = environments.get(key);
    if (!section) {
      const name = environment?.name || environment?.branchName || "No environment";
      section = {
        kind: key,
        label: showHostNames && host?.name ? `${name} · ${host.name}` : name,
        families: [],
      };
      environments.set(key, section);
    }
    section.families.push(family);
  }
  return [...sections, ...environments.values()];
}

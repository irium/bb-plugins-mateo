import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import type { PluginSidebarProject, PluginSidebarThread } from "@get-bb/plugin-sdk";
import { groupThreadsByProject } from "../lib/inbox.ts";
import { DAY_MS } from "../lib/thread-management.ts";
import {
  groupFamiliesByStatus,
  projectGroupsBesidePinned,
} from "../lib/status-groups.ts";
import {
  environmentSectionKey,
  groupSidebarFamilies,
} from "../lib/sidebar-sections.ts";

function thread(overrides: Partial<PluginSidebarThread>): PluginSidebarThread {
  return {
    id: "thread",
    projectId: "project",
    title: "Thread",
    titleFallback: null,
    parentThreadId: null,
    sectionId: null,
    originKind: null,
    originPluginId: null,
    providerId: "codex",
    hasPendingInteraction: false,
    activity: { workflows: 0, backgroundAgents: 0, backgroundCommands: 0, planMode: 0, goals: 0 },
    indicator: "none",
    indicatorLabel: null,
    isUnread: false,
    isPinned: false,
    isArchived: false,
    environment: null,
    host: null,
    createdAt: 1,
    updatedAt: 1,
    lastReadAt: 1,
    latestAttentionAt: 1,
    ...overrides,
  };
}

const projects: PluginSidebarProject[] = [
  { id: "project", name: "Project", isPersonal: false },
];

describe("groupFamiliesByStatus", () => {
  it("orders semantic sections, omits empty sections, and includes each family once", () => {
    const now = 10 * DAY_MS;
    const families = groupThreadsByProject(
      [
        thread({ id: "inactive", updatedAt: now }),
        thread({ id: "working", indicator: "runtime", updatedAt: now }),
        thread({ id: "needs", hasPendingInteraction: true, updatedAt: now }),
        thread({ id: "stale", updatedAt: now - 7 * DAY_MS }),
        thread({ id: "pinned", isPinned: true, indicator: "runtime", updatedAt: now }),
        thread({ id: "failed", indicator: "unread-error", updatedAt: now }),
        thread({ id: "unread", isUnread: true, updatedAt: now }),
      ],
      projects,
    )[0]!.families;

    const groups = groupFamiliesByStatus(families, now);
    assert.deepEqual(groups.map((group) => group.kind), [
      "pinned",
      "needs-you",
      "failed",
      "working",
      "unread",
      "idle",
    ]);
    assert.deepEqual(
      groups.flatMap((group) => group.families.map((family) => family.root.id)),
      ["pinned", "needs", "failed", "working", "unread", "inactive", "stale"],
    );
    assert.deepEqual(groups.map((group) => group.label), [
      "Pinned", "Needs your input", "Failed", "Working", "Unread", "Idle",
    ]);
  });

  it("keeps a child with its root and uses child attention for status", () => {
    const families = groupThreadsByProject([
      thread({ id: "root" }),
      thread({ id: "child", parentThreadId: "root", hasPendingInteraction: true }),
    ], projects)[0]!.families;
    const groups = groupFamiliesByStatus(families, DAY_MS);
    assert.deepEqual(groups.map((group) => group.kind), ["needs-you"]);
    assert.equal(groups[0]?.families[0]?.children[0]?.id, "child");
    assert.deepEqual(groupFamiliesByStatus([], DAY_MS), []);
  });

  it("groups environments by identity and machine, not project selection", () => {
    const environment = { id: "env", name: "main", branchName: "main", workspaceDisplayKind: null };
    const families = [
      { root: thread({ id: "mac", environment: { ...environment, workspaceDisplayKind: "managed-worktree" }, host: { id: "mac", name: "Mac" } }), children: [] },
      { root: thread({ id: "mac2", environment: { ...environment, workspaceDisplayKind: "managed-worktree" }, host: { id: "mac", name: "Mac" } }), children: [] },
      { root: thread({ id: "jupiter", environment: { ...environment, workspaceDisplayKind: "managed-worktree" }, host: { id: "jupiter", name: "Jupiter" } }), children: [] },
      { root: thread({ id: "none" }), children: [] },
    ];
    const groups = groupSidebarFamilies(families);
    assert.deepEqual(groups.map((group) => group.label), ["main · Mac", "main · Jupiter", "No environment"]);
    assert.deepEqual(groups.map((group) => group.families.map((family) => family.root.id)), [["mac", "mac2"], ["jupiter"], ["none"]]);
    assert.deepEqual(groupSidebarFamilies([]), []);
    // The collapse memory prunes by this key, so it must be the section kind.
    assert.deepEqual(
      groups.map((group) => group.kind),
      [families[0]!.root, families[2]!.root, families[3]!.root].map(environmentSectionKey),
    );
  });
});

describe("projectGroupsBesidePinned", () => {
  it("drops a project its pinned families emptied but keeps an empty launcher", () => {
    const groups = groupThreadsByProject(
      [
        thread({ id: "pinned-only", projectId: "pinned", isPinned: true }),
        thread({ id: "mixed-pinned", projectId: "mixed", isPinned: true }),
        thread({ id: "mixed-loose", projectId: "mixed" }),
      ],
      [
        { id: "pinned", name: "Pinned", isPersonal: false },
        { id: "mixed", name: "Mixed", isPersonal: false },
        { id: "launcher", name: "Launcher", isPersonal: false },
      ],
    );
    assert.equal(groups.find((group) => group.project.id === "launcher")?.families.length, 0);

    const beside = projectGroupsBesidePinned(groups);
    // Pinned families are drawn in the Pinned section, never twice.
    assert.deepEqual(
      new Map(beside.map((group) => [group.project.id, group.families.map((family) => family.root.id)])),
      new Map([["mixed", ["mixed-loose"]], ["launcher", []]]),
    );
  });

  it("is what the inbox draws its project list from", async () => {
    const inbox = await readFile(
      new URL("../components/inbox/thread-inbox.tsx", import.meta.url),
      "utf8",
    );
    // Dropping every empty group here would hide empty project launchers.
    assert.match(inbox, /showProjectGroups \? projectGroupsBesidePinned\(projectGroups\)/);
    assert.doesNotMatch(inbox, /\.filter\(\(group\) => group\.families\.length > 0\)/);
  });
});

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type {
  PluginSidebarProject,
  PluginSidebarThread,
} from "@get-bb/plugin-sdk";
import {
  childrenOf,
  filterByProject,
  groupThreadsByProject,
  hideChildrenOfVisibleParents,
  parentOf,
  partitionPinned,
  searchProjectThreadGroups,
  searchThreadsByTitle,
  sortByCreatedAtDescending,
  threadDisplayTitle,
  threadIsWorking,
  visibleInboxThreads,
} from "../lib/inbox.ts";

function thread(
  overrides: Partial<PluginSidebarThread> = {},
): PluginSidebarThread {
  return {
    id: "thr_1",
    projectId: "proj_1",
    title: "A thread",
    titleFallback: null,
    parentThreadId: null,
    sectionId: null,
    originKind: null,
    originPluginId: null,
    providerId: "codex",
    hasPendingInteraction: false,
    activity: {
      workflows: 0,
      backgroundAgents: 0,
      backgroundCommands: 0,
      planMode: 0,
      goals: 0,
    },
    indicator: "none",
    indicatorLabel: null,
    isUnread: false,
    isPinned: false,
    isArchived: false,
    environment: null,
    host: null,
    createdAt: 100,
    updatedAt: 100,
    lastReadAt: 100,
    latestAttentionAt: 100,
    ...overrides,
  };
}

function project(
  id: string,
  name: string,
  isPersonal = false,
): PluginSidebarProject {
  return { id, name, isPersonal };
}

describe("sortByCreatedAtDescending", () => {
  it("puts the newest thread first", () => {
    const ordered = sortByCreatedAtDescending([
      thread({ id: "a", createdAt: 1 }),
      thread({ id: "b", createdAt: 3 }),
      thread({ id: "c", createdAt: 2 }),
    ]);
    assert.deepEqual(
      ordered.map((t) => t.id),
      ["b", "c", "a"],
    );
  });

  // The whole premise: activity must never move a row. Only createdAt is read,
  // so a thread that just did work keeps its place.
  it("ignores activity and update time", () => {
    const before = [
      thread({ id: "a", createdAt: 2, updatedAt: 1 }),
      thread({ id: "b", createdAt: 1, updatedAt: 999, indicator: "runtime" }),
    ];
    assert.deepEqual(
      sortByCreatedAtDescending(before).map((t) => t.id),
      ["a", "b"],
    );
  });

  it("breaks ties on id so the order is stable", () => {
    const ordered = sortByCreatedAtDescending([
      thread({ id: "b", createdAt: 5 }),
      thread({ id: "a", createdAt: 5 }),
    ]);
    assert.deepEqual(
      ordered.map((t) => t.id),
      ["a", "b"],
    );
  });

  it("does not mutate its input", () => {
    const input = [
      thread({ id: "a", createdAt: 1 }),
      thread({ id: "b", createdAt: 2 }),
    ];
    sortByCreatedAtDescending(input);
    assert.deepEqual(
      input.map((t) => t.id),
      ["a", "b"],
    );
  });
});

describe("threadDisplayTitle", () => {
  it("prefers the title, then the fallback, then a placeholder", () => {
    assert.equal(threadDisplayTitle(thread({ title: "Real" })), "Real");
    assert.equal(
      threadDisplayTitle(thread({ title: null, titleFallback: "Fallback" })),
      "Fallback",
    );
    assert.equal(
      threadDisplayTitle(thread({ title: null, titleFallback: null })),
      "Untitled thread",
    );
  });

  it("treats a whitespace-only title as absent", () => {
    assert.equal(
      threadDisplayTitle(thread({ title: "   ", titleFallback: "Fallback" })),
      "Fallback",
    );
  });
});

describe("searchThreadsByTitle", () => {
  it("matches case-insensitively on the visible title", () => {
    const threads = [
      thread({ id: "a", title: "Sidebar work" }),
      thread({ id: "b", title: "Something else" }),
      thread({ id: "c", title: null, titleFallback: "sidebar fallback" }),
    ];
    assert.deepEqual(
      searchThreadsByTitle(threads, "SIDEBAR").map((t) => t.id),
      ["a", "c"],
    );
  });

  it("returns everything for a blank query", () => {
    const threads = [thread({ id: "a" }), thread({ id: "b" })];
    assert.equal(searchThreadsByTitle(threads, "   ").length, 2);
  });
});

describe("filtering", () => {
  it("scopes to one project, or to all", () => {
    const threads = [
      thread({ id: "a", projectId: "p1" }),
      thread({ id: "b", projectId: "p2" }),
    ];
    assert.deepEqual(
      filterByProject(threads, "p1").map((t) => t.id),
      ["a"],
    );
    assert.equal(filterByProject(threads, null).length, 2);
  });

  it("drops archived threads", () => {
    const threads = [
      thread({ id: "a" }),
      thread({ id: "b", isArchived: true }),
    ];
    assert.deepEqual(
      visibleInboxThreads(threads, new Set()).map((t) => t.id),
      ["a"],
    );
  });

  // Settling archives the thread in bb, so the archive flag alone would empty
  // the settled shelf the moment anything landed on it.
  it("keeps an archived thread the plugin parked", () => {
    const threads = [
      thread({ id: "a", isArchived: true }),
      thread({ id: "b", isArchived: true }),
    ];
    assert.deepEqual(
      visibleInboxThreads(threads, new Set(["a"])).map((t) => t.id),
      ["a"],
    );
  });

  it("splits pinned from the rest, keeping order", () => {
    const { pinned, inbox } = partitionPinned([
      thread({ id: "a" }),
      thread({ id: "b", isPinned: true }),
      thread({ id: "c" }),
    ]);
    assert.deepEqual(
      pinned.map((t) => t.id),
      ["b"],
    );
    assert.deepEqual(
      inbox.map((t) => t.id),
      ["a", "c"],
    );
  });
});

describe("project thread groups", () => {
  it("keeps bb's project order, pins roots within a project, and flattens descendants", () => {
    const groups = groupThreadsByProject(
      [
        thread({ id: "root", projectId: "p1", createdAt: 10 }),
        thread({
          id: "child",
          projectId: "p1",
          parentThreadId: "root",
          createdAt: 20,
        }),
        thread({
          id: "grandchild",
          projectId: "p1",
          parentThreadId: "child",
          createdAt: 30,
        }),
        thread({
          id: "pinned",
          projectId: "p1",
          isPinned: true,
          createdAt: 5,
        }),
        thread({ id: "other", projectId: "p2", createdAt: 40 }),
      ],
      [project("p2", "Second"), project("p1", "First")],
    );

    assert.deepEqual(
      groups.map((group) => group.project.id),
      ["p2", "p1"],
    );
    assert.deepEqual(
      groups[1]?.families.map((family) => family.root.id),
      ["pinned", "root"],
    );
    assert.deepEqual(
      groups[1]?.families[1]?.children.map((child) => child.id),
      ["child", "grandchild"],
    );
  });

  // A root is filed under its OWN project, so promotion also decides where the
  // group is drawn — this is the fallback that hands a service child back to
  // its own repository's group when the umbrella parent is parked.
  it("promotes a child when its parent is not visible, into its own project", () => {
    const groups = groupThreadsByProject(
      [thread({ id: "child", projectId: "svc", parentThreadId: "parked" })],
      [project("proj_1", "Project"), project("svc", "Service")],
    );
    // proj_1 holds no threads at all, so it is listed as an empty launcher.
    const filed = groups.filter((group) => group.families.length > 0);
    assert.equal(filed.length, 1);
    assert.equal(filed[0]?.project.id, "svc");
    assert.equal(filed[0]?.families[0]?.root.id, "child");
    assert.deepEqual(
      groups.filter((group) => group.families.length === 0).map((group) => group.project.id),
      ["proj_1"],
    );
  });

  it("emits a project with no threads so it stays reachable and startable", () => {
    const groups = groupThreadsByProject(
      [thread({ id: "root", projectId: "p1" })],
      [project("p1", "First"), project("p2", "Second")],
    );
    assert.deepEqual(
      groups.map((group) => group.project.id),
      ["p1", "p2"],
    );
    assert.deepEqual(
      groups[1]?.families,
      [],
    );
  });

  it("emits every project when no thread exists at all", () => {
    const groups = groupThreadsByProject(
      [],
      [project("p1", "First"), project("p2", "Second")],
    );
    assert.deepEqual(
      groups.map((group) => group.project.id),
      ["p1", "p2"],
    );
    assert.ok(
      groups.every((group) => group.families.length === 0),
    );
  });

  it("keeps a thread's unknown project alongside the known empty ones", () => {
    const groups = groupThreadsByProject(
      [thread({ id: "root", projectId: "gone" })],
      [project("p1", "First")],
    );
    assert.deepEqual(
      groups.map((group) => group.project.id),
      ["p1", "gone"],
    );
    assert.equal(groups[1]?.project.name, "Other project");
  });

  it("keeps a parent as context when only its child matches search", () => {
    const groups = groupThreadsByProject(
      [
        thread({ id: "root", title: "Parent" }),
        thread({
          id: "match",
          title: "Fix checkout",
          parentThreadId: "root",
        }),
        thread({
          id: "other",
          title: "Review taxes",
          parentThreadId: "root",
        }),
      ],
      [project("proj_1", "Storefront")],
    );
    const result = searchProjectThreadGroups(groups, "checkout");
    assert.equal(result[0]?.families[0]?.root.id, "root");
    assert.deepEqual(
      result[0]?.families[0]?.children.map((child) => child.id),
      ["match"],
    );
  });

  it("matches a project name and keeps the whole project", () => {
    const groups = groupThreadsByProject(
      [thread({ id: "root" })],
      [project("proj_1", "Storefront")],
    );
    assert.equal(searchProjectThreadGroups(groups, "store").length, 1);
  });

  it("preserves matching empty project launchers in search", () => {
    const groups = [
      { project: project("empty", "Empty Storefront"), families: [] },
      { project: project("other", "Other"), families: [] },
    ];
    assert.deepEqual(searchProjectThreadGroups(groups, " STORE "), [groups[0]]);
    assert.deepEqual(searchProjectThreadGroups(groups, "missing"), []);
    assert.deepEqual(searchProjectThreadGroups(groups, "   "), groups);
  });
});

/**
 * The working shape these cover: one ticket is a parent thread in an umbrella
 * project plus a child per service repository, each child in that repository's
 * own bb project. bb files them all under the root's project
 * (`createSidebarProjectIdResolver`), and these mirror its tests.
 */
describe("cross-project families", () => {
  it("files a child from another project under its root ancestor's project", () => {
    const groups = groupThreadsByProject(
      [
        thread({ id: "root", projectId: "umbrella", createdAt: 10 }),
        thread({
          id: "child",
          projectId: "svc_a",
          parentThreadId: "root",
          createdAt: 20,
        }),
        thread({
          id: "grandchild",
          projectId: "svc_b",
          parentThreadId: "child",
          createdAt: 30,
        }),
      ],
      [
        project("umbrella", "Umbrella"),
        project("svc_a", "Gateway"),
        project("svc_b", "Billing"),
      ],
    );

    assert.deepEqual(
      groups.map((group) => group.project.id),
      ["umbrella"],
    );
    assert.equal(groups[0]?.families.length, 1);
    assert.equal(groups[0]?.families[0]?.root.id, "root");
    assert.deepEqual(
      groups[0]?.families[0]?.children.map((child) => child.id),
      ["child", "grandchild"],
    );
  });

  // The shape that made this worth fixing: a dozen service children used to
  // become a dozen sidebar groups.
  it("keeps a fan of service children in one family", () => {
    const groups = groupThreadsByProject(
      [
        thread({ id: "root", projectId: "umbrella", createdAt: 10 }),
        thread({
          id: "gateway",
          projectId: "svc_a",
          parentThreadId: "root",
          createdAt: 20,
        }),
        thread({
          id: "billing",
          projectId: "svc_b",
          parentThreadId: "root",
          createdAt: 30,
        }),
      ],
      [
        project("umbrella", "Umbrella"),
        project("svc_a", "Gateway"),
        project("svc_b", "Billing"),
      ],
    );

    assert.equal(groups.length, 1);
    assert.equal(groups[0]?.families.length, 1);
    assert.deepEqual(
      groups[0]?.families[0]?.children.map((child) => child.id),
      ["gateway", "billing"],
    );
  });

  // A service project earns a group only through its own root threads. This is
  // the effect that makes the sidebar stop listing a repository per ticket.
  it("draws no group for a project that only holds children", () => {
    const groups = groupThreadsByProject(
      [
        thread({ id: "root", projectId: "umbrella" }),
        thread({ id: "child", projectId: "svc_a", parentThreadId: "root" }),
        thread({ id: "standalone", projectId: "svc_b" }),
      ],
      [
        project("umbrella", "Umbrella"),
        project("svc_a", "Gateway"),
        project("svc_b", "Billing"),
      ],
    );

    assert.deepEqual(
      groups.map((group) => group.project.id),
      ["umbrella", "svc_b"],
    );
  });

  // The whole family rides along, not just the thread that was looked up.
  it("files the family under Other project when the root's project is unknown", () => {
    const groups = groupThreadsByProject(
      [
        thread({ id: "root", projectId: "gone" }),
        thread({ id: "child", projectId: "svc_a", parentThreadId: "root" }),
      ],
      [project("svc_a", "Gateway")],
    );

    assert.equal(groups.length, 1);
    assert.equal(groups[0]?.project.name, "Other project");
    assert.deepEqual(
      groups[0]?.families[0]?.children.map((child) => child.id),
      ["child"],
    );
  });

  it("stops at a cycle instead of looping", () => {
    const groups = groupThreadsByProject(
      [
        thread({ id: "left", projectId: "proj_a", parentThreadId: "right" }),
        thread({ id: "right", projectId: "proj_b", parentThreadId: "left" }),
      ],
      [project("proj_a", "A"), project("proj_b", "B")],
    );

    // bb resolves a cycle to the last thread reached before the loop closes,
    // and the walk starts at the first thread in the list. The contract is
    // termination and a single answer per input, not which member wins.
    assert.deepEqual(
      groups.map((group) => group.project.id),
      ["proj_b"],
    );
    assert.equal(groups[0]?.families[0]?.root.id, "right");
    assert.deepEqual(
      groups[0]?.families[0]?.children.map((child) => child.id),
      ["left"],
    );
  });

  // Siblings share one ancestor walk. Nothing observable depends on the cache
  // except that a deep chain does not re-walk per member, so this stands in
  // for it: every member of a long chain lands in the same family.
  it("resolves a long chain consistently for every member", () => {
    const chain = Array.from({ length: 30 }, (_, index) =>
      thread({
        id: `thr_${index}`,
        projectId: index === 0 ? "umbrella" : `svc_${index}`,
        parentThreadId: index === 0 ? null : `thr_${index - 1}`,
        createdAt: index,
      }),
    );
    const groups = groupThreadsByProject(chain, [
      project("umbrella", "Umbrella"),
    ]);

    assert.equal(groups.length, 1);
    assert.equal(groups[0]?.project.id, "umbrella");
    assert.equal(groups[0]?.families.length, 1);
    assert.equal(groups[0]?.families[0]?.children.length, 29);
  });
});

describe("threadIsWorking", () => {
  it("includes activity counts and resolved runtime states", () => {
    assert.equal(
      threadIsWorking(
        thread({ activity: { workflows: 0, backgroundAgents: 1, backgroundCommands: 0, planMode: 0, goals: 0 } }),
      ),
      true,
    );
    assert.equal(threadIsWorking(thread({ indicator: "runtime" })), true);
    assert.equal(threadIsWorking(thread()), false);
  });
});

describe("child threads", () => {
  it("hides a child whose parent is on screen", () => {
    const visible = hideChildrenOfVisibleParents([
      thread({ id: "parent" }),
      thread({ id: "child", parentThreadId: "parent" }),
    ]);
    assert.deepEqual(
      visible.map((t) => t.id),
      ["parent"],
    );
  });

  // An orphan must stay visible: hidden here AND absent from any header chip
  // would make it unreachable everywhere.
  it("keeps a child whose parent is not on screen", () => {
    const visible = hideChildrenOfVisibleParents([
      thread({ id: "child", parentThreadId: "archived-parent" }),
    ]);
    assert.deepEqual(
      visible.map((t) => t.id),
      ["child"],
    );
  });

  it("lists a thread's children oldest first", () => {
    const children = childrenOf(
      [
        thread({ id: "parent" }),
        thread({ id: "b", parentThreadId: "parent", createdAt: 20 }),
        thread({ id: "a", parentThreadId: "parent", createdAt: 10 }),
        thread({ id: "other", parentThreadId: "elsewhere" }),
      ],
      "parent",
    );
    assert.deepEqual(
      children.map((t) => t.id),
      ["a", "b"],
    );
  });
});

describe("parentOf", () => {
  // The list hides an archived parent, but the child's header must still get
  // it back — otherwise the child is a dead end.
  it("finds a parent the inbox filters out", () => {
    const parent = parentOf(
      [
        thread({ id: "parent", isArchived: true, projectId: "other" }),
        thread({ id: "child", parentThreadId: "parent" }),
      ],
      "child",
    );
    assert.equal(parent?.id, "parent");
  });

  it("returns null for a root thread", () => {
    assert.equal(parentOf([thread({ id: "root" })], "root"), null);
  });

  it("returns null when the parent row is gone", () => {
    const threads = [thread({ id: "child", parentThreadId: "deleted" })];
    assert.equal(parentOf(threads, "child"), null);
  });
});

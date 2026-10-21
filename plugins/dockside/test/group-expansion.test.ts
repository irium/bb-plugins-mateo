import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import {
  decodeCollapsedGroups,
  GROUP_EXPANSION_STORAGE_KEY,
  isGroupCollapsed,
  MAX_COLLAPSED_GROUPS,
  NO_COLLAPSED_GROUPS,
  pruneCollapsedGroups,
  readCollapsedGroups,
  setGroupCollapsed,
  writeCollapsedGroups,
  type GroupExpansionStorage,
} from "../lib/group-expansion.ts";

class MemoryStorage implements GroupExpansionStorage {
  value: string | null = null;
  getItem(key: string) {
    assert.equal(key, GROUP_EXPANSION_STORAGE_KEY);
    return this.value;
  }
  setItem(key: string, value: string) {
    assert.equal(key, GROUP_EXPANSION_STORAGE_KEY);
    this.value = value;
  }
}

describe("group expansion", () => {
  it("round-trips collapsed project, status and environment groups", () => {
    const storage = new MemoryStorage();
    const collapsed = {
      project: ["proj-a"],
      status: ["stale"],
      environment: ['["proj-a","mac","env"]'],
    };
    assert.equal(writeCollapsedGroups(collapsed, storage), true);
    assert.deepEqual(readCollapsedGroups(storage), collapsed);
  });

  it("treats anything it has never seen as expanded", () => {
    const storage = new MemoryStorage();
    assert.deepEqual(readCollapsedGroups(storage), NO_COLLAPSED_GROUPS);
    assert.equal(isGroupCollapsed(NO_COLLAPSED_GROUPS, "project", "fresh"), false);
    // A project collapsed in one preset must not fold a status of the same name.
    const collapsed = setGroupCollapsed(
      NO_COLLAPSED_GROUPS,
      "project",
      "stale",
      true,
    );
    assert.equal(isGroupCollapsed(collapsed, "project", "stale"), true);
    assert.equal(isGroupCollapsed(collapsed, "status", "stale"), false);
    assert.equal(isGroupCollapsed(collapsed, "environment", "stale"), false);
  });

  it("collapses, expands again, and keeps identity when nothing changes", () => {
    const collapsed = setGroupCollapsed(NO_COLLAPSED_GROUPS, "status", "working", true);
    assert.deepEqual(collapsed.status, ["working"]);

    // Same request twice must not churn state or trigger a redundant write.
    assert.equal(
      setGroupCollapsed(collapsed, "status", "working", true),
      collapsed,
    );
    assert.equal(
      setGroupCollapsed(NO_COLLAPSED_GROUPS, "status", "working", false),
      NO_COLLAPSED_GROUPS,
    );

    const expanded = setGroupCollapsed(collapsed, "status", "working", false);
    assert.deepEqual(expanded.status, []);
  });

  it("refuses ids it could not have written itself", () => {
    assert.equal(
      setGroupCollapsed(NO_COLLAPSED_GROUPS, "project", "", true),
      NO_COLLAPSED_GROUPS,
    );
    assert.equal(
      setGroupCollapsed(NO_COLLAPSED_GROUPS, "project", "bad\nid", true),
      NO_COLLAPSED_GROUPS,
    );
    assert.equal(
      setGroupCollapsed(NO_COLLAPSED_GROUPS, "project", " untrimmed", true),
      NO_COLLAPSED_GROUPS,
    );
    assert.equal(
      setGroupCollapsed(NO_COLLAPSED_GROUPS, "project", "x".repeat(201), true),
      NO_COLLAPSED_GROUPS,
    );
  });

  it("fails closed on malformed storage without losing the sound half", () => {
    assert.deepEqual(decodeCollapsedGroups(null), NO_COLLAPSED_GROUPS);
    assert.deepEqual(decodeCollapsedGroups("nope"), NO_COLLAPSED_GROUPS);
    assert.deepEqual(decodeCollapsedGroups(JSON.stringify(["a"])), NO_COLLAPSED_GROUPS);
    assert.deepEqual(
      decodeCollapsedGroups(JSON.stringify({ project: ["a", "a"], status: ["stale"] })),
      { project: [], status: ["stale"], environment: [] },
    );
    assert.deepEqual(
      decodeCollapsedGroups(JSON.stringify({ project: ["ok"], status: "stale" })),
      { project: ["ok"], status: [], environment: [] },
    );
    // Storage written before environment sections existed still reads.
    assert.deepEqual(
      decodeCollapsedGroups(JSON.stringify({ project: ["ok"], status: ["idle"] })),
      { project: ["ok"], status: ["idle"], environment: [] },
    );
    assert.deepEqual(
      decodeCollapsedGroups(JSON.stringify({ project: [1, 2] })),
      NO_COLLAPSED_GROUPS,
    );
  });

  it("caps what it stores and never reads an oversized blob", () => {
    const tooMany = Array.from(
      { length: MAX_COLLAPSED_GROUPS + 1 },
      (_value, index) => `p${index}`,
    );
    assert.equal(
      writeCollapsedGroups(
        { project: tooMany, status: [], environment: [] },
        new MemoryStorage(),
      ),
      false,
    );
    assert.deepEqual(
      decodeCollapsedGroups(JSON.stringify({ project: tooMany, status: [] })),
      NO_COLLAPSED_GROUPS,
    );

    // Growth past the cap drops the oldest rather than rejecting the click.
    const full = {
      project: tooMany.slice(0, MAX_COLLAPSED_GROUPS),
      status: [],
      environment: [],
    };
    const grown = setGroupCollapsed(full, "project", "newest", true);
    assert.equal(grown.project.length, MAX_COLLAPSED_GROUPS);
    assert.equal(grown.project.includes("newest"), true);
    assert.equal(grown.project.includes("p0"), false);
  });

  it("forgets projects that are gone and keeps the ones that are not", () => {
    const collapsed = {
      project: ["live", "deleted"],
      status: ["stale"],
      environment: ["env-live", "env-removed"],
    };
    const pruned = pruneCollapsedGroups(
      collapsed,
      ["live", "untouched"],
      ["env-live", "env-untouched"],
    );
    assert.deepEqual(pruned.project, ["live"]);
    assert.deepEqual(pruned.environment, ["env-live"]);
    // Status ids are a fixed set, so pruning must never touch them.
    assert.deepEqual(pruned.status, ["stale"]);

    // Nothing to drop means no write and no render.
    assert.equal(pruneCollapsedGroups(pruned, ["live"], ["env-live"]), pruned);
    assert.equal(
      pruneCollapsedGroups(NO_COLLAPSED_GROUPS, [], []),
      NO_COLLAPSED_GROUPS,
    );

    // A removed environment alone is enough to prune.
    assert.deepEqual(
      pruneCollapsedGroups(pruned, ["live"], []).environment,
      [],
    );

    // An empty live list is a real instruction here; refusing to act on a
    // list that has not loaded is the caller's job, and is asserted below.
    assert.deepEqual(pruneCollapsedGroups(collapsed, [], []).project, []);
  });

  it("degrades quietly when there is no storage at all", () => {
    assert.deepEqual(readCollapsedGroups(null), NO_COLLAPSED_GROUPS);
    assert.equal(writeCollapsedGroups(NO_COLLAPSED_GROUPS, null), false);
  });
});

describe("group expansion wiring", () => {
  it("keeps the collapsed state above the groups that unmount", async () => {
    const inbox = await readFile(
      new URL("../components/inbox/thread-inbox.tsx", import.meta.url),
      "utf8",
    );
    const project = await readFile(
      new URL("../components/inbox/project-group.tsx", import.meta.url),
      "utf8",
    );
    const status = await readFile(
      new URL("../components/inbox/status-group.tsx", import.meta.url),
      "utf8",
    );

    // Switching the filter preset unmounts every group of the other kind, so
    // the state has to live in the inbox or a collapse would not survive it.
    assert.match(inbox, /useState\(readCollapsedGroups\)/);
    assert.match(inbox, /writeCollapsedGroups\(next\)/);
    assert.match(inbox, /changeGroupCollapsed\("project", group\.project\.id, collapsed\)/);
    assert.match(
      inbox,
      /changeGroupCollapsed\(\s*sectionGroupKind\(group\.kind\),\s*group\.kind,\s*collapsed,?\s*\)/,
    );
    // Environment sections remember too; Pinned keeps one memory across presets.
    assert.match(
      inbox,
      /activePreset === "environment" && kind !== "pinned" \? "environment" : "status"/,
    );
    assert.match(inbox, /threads\.map\(environmentSectionKey\)/);

    for (const source of [project, status]) {
      assert.doesNotMatch(source, /useState\(true\)/);
    }
    // A search force-expands, and collapsing during one still records intent.
    // That only holds if the click reports what is on screen: recording the
    // stored state instead would un-collapse a group the user just closed.
    assert.match(project, /const expanded = forceExpanded \|\| !collapsed;/);
    assert.match(project, /onSetCollapsed\(expanded\)/);
    assert.match(status, /const effectiveExpanded = forceExpanded \|\| expanded;/);
    assert.match(status, /onSetCollapsed\(effectiveExpanded\)/);
    assert.doesNotMatch(status, /onSetCollapsed\(expanded\)/);

    // Pruning against a list that has not loaded would forget everything, and
    // the host list alone omits a thread whose project the host does not know.
    assert.match(inbox, /status === "ready"\s*\?\s*pruneCollapsedGroups\(/);
    assert.match(inbox, /projects\.map\(\(project\) => project\.id\)/);
    assert.match(
      inbox,
      /unfilteredProjectGroups\.map\(\(group\) => group\.project\.id\)/,
    );
  });
});

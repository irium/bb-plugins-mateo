import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import type { PluginSidebarThread } from "@bb/plugin-sdk";
import { familyTreeRows, MAX_INDENTED_DEPTH } from "../lib/family-tree.ts";

function thread(
  id: string,
  parentThreadId: string | null,
  createdAt: number,
): PluginSidebarThread {
  return { id, parentThreadId, createdAt, projectId: "p" } as unknown as PluginSidebarThread;
}

const rows = (rootId: string, children: PluginSidebarThread[]) =>
  familyTreeRows(rootId, children).map(({ thread: row, depth }) => `${row.id}@${depth}`);

describe("family tree rows", () => {
  it("leaves a family of direct children exactly as it was", () => {
    assert.deepEqual(
      rows("root", [thread("b", "root", 2), thread("a", "root", 1)]),
      ["a@1", "b@1"],
    );
  });

  it("puts a grandchild one level below its parent", () => {
    assert.deepEqual(
      rows("root", [thread("child", "root", 1), thread("grandchild", "child", 2)]),
      ["child@1", "grandchild@2"],
    );
  });

  it("draws a grandchild under its own parent, not after every child", () => {
    // Oldest-first alone would give a, b, a1 and park a1 under the wrong row.
    assert.deepEqual(
      rows("root", [
        thread("a", "root", 1),
        thread("b", "root", 2),
        thread("a1", "a", 3),
      ]),
      ["a@1", "a1@2", "b@1"],
    );
  });

  it("reports the true depth of a long chain", () => {
    const chain = [thread("c1", "root", 1)];
    for (let level = 2; level <= MAX_INDENTED_DEPTH + 2; level += 1) {
      chain.push(thread(`c${level}`, `c${level - 1}`, level));
    }
    const result = familyTreeRows("root", chain);
    assert.equal(result.at(-1)?.depth, MAX_INDENTED_DEPTH + 2);
  });

  it("hangs a child whose parent is not listed directly off the root", () => {
    // Search can hide the parent while keeping a matching grandchild.
    assert.deepEqual(
      rows("root", [thread("grandchild", "hidden", 2), thread("child", "root", 1)]),
      ["child@1", "grandchild@1"],
    );
  });

  it("keeps every thread once and terminates on a parent cycle", () => {
    const result = rows("root", [
      thread("x", "y", 1),
      thread("y", "x", 2),
      thread("z", "x", 3),
      thread("self", "self", 4),
    ]);
    assert.equal(result.length, 4);
    assert.equal(new Set(result.map((row) => row.split("@")[0])).size, 4);
  });
});

describe("family tree wiring", () => {
  it("draws child rows in tree order with a capped indent", async () => {
    const card = await readFile(
      new URL("../components/inbox/thread-card.tsx", import.meta.url),
      "utf8",
    );
    assert.match(card, /familyTreeRows\(thread\.id, childThreads\)/);
    assert.match(card, /data-dockside-child-depth=\{depth\}/);
    assert.match(card, /Math\.min\(depth, MAX_INDENTED_DEPTH\) - 1\) \* 12/);
    // The family model stays flat: counts, status and bulk guards still read
    // childThreads directly.
    assert.match(card, /familyStatus\(\[thread, \.\.\.childThreads\], now\)/);
  });
});

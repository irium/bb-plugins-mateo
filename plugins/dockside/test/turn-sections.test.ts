import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import Database from "better-sqlite3";
import type { PluginSidebarThread } from "@get-bb/plugin-sdk";
import {
  buildTurnSections,
  readCollapsedTurnSections,
  resolveTurnSectionSettings,
  TURN_SECTIONS_STORAGE_KEY,
  writeCollapsedTurnSections,
  type TurnSectionStorage,
  type TurnTimes,
} from "../lib/turn-sections.ts";
import { createTurnStore, TURN_MIGRATION } from "../lib/turn-store.ts";

const idle = { workflows: 0, backgroundAgents: 0, backgroundCommands: 0, planMode: 0, goals: 0 };

function thread(
  id: string,
  overrides: Partial<Record<string, unknown>> = {},
): PluginSidebarThread {
  return {
    id,
    projectId: "p",
    parentThreadId: null,
    activity: idle,
    indicator: "none",
    hasPendingInteraction: false,
    isArchived: false,
    isUnread: false,
    updatedAt: 100,
    latestAttentionAt: 100,
    ...overrides,
  } as unknown as PluginSidebarThread;
}
const running = { indicator: "runtime" };
const turns = (...list: TurnTimes[]) =>
  new Map(list.map((turn) => [turn.threadId, turn]));
const ids = (entries: { thread: PluginSidebarThread }[]) =>
  entries.map((entry) => entry.thread.id);

describe("turn sections", () => {
  it("splits running threads from finished ones, newest turn first", () => {
    const lists = buildTurnSections({
      threads: [thread("a"), thread("b"), thread("run1", running), thread("run2", running)],
      turns: turns(
        { threadId: "a", startedAt: 1, endedAt: 50 },
        { threadId: "b", startedAt: 1, endedAt: 90 },
        { threadId: "run1", startedAt: 20, endedAt: null },
        { threadId: "run2", startedAt: 70, endedAt: null },
      ),
      includeChildThreads: true,
      limit: 5,
    });
    assert.deepEqual(ids(lists.inbox), ["b", "a"]);
    assert.deepEqual(ids(lists.working), ["run2", "run1"]);
  });

  it("puts a thread waiting on the user in Inbox even mid-run", () => {
    const lists = buildTurnSections({
      threads: [thread("asks", { ...running, hasPendingInteraction: true, latestAttentionAt: 300 })],
      turns: turns({ threadId: "asks", startedAt: 10, endedAt: 20 }),
      includeChildThreads: true,
      limit: 5,
    });
    assert.deepEqual(ids(lists.working), []);
    assert.deepEqual(lists.inbox.map((entry) => entry.at), [300]);
  });

  it("falls back to bb's timestamps for a thread with no recorded turn", () => {
    const lists = buildTurnSections({
      threads: [thread("old", { latestAttentionAt: 40 }), thread("busy", { ...running, updatedAt: 60 })],
      turns: new Map(),
      includeChildThreads: true,
      limit: 5,
    });
    assert.deepEqual(lists.inbox.map((entry) => entry.at), [40]);
    assert.deepEqual(lists.working.map((entry) => entry.at), [60]);
  });

  it("caps each list and honours the child and archive filters", () => {
    const many = Array.from({ length: 7 }, (_value, index) =>
      thread(`t${index}`, { latestAttentionAt: index }),
    );
    const lists = buildTurnSections({
      threads: [
        ...many,
        thread("child", { parentThreadId: "t0", latestAttentionAt: 999 }),
        thread("gone", { isArchived: true, latestAttentionAt: 1000 }),
      ],
      turns: new Map(),
      includeChildThreads: false,
      limit: 3,
    });
    assert.deepEqual(ids(lists.inbox), ["t6", "t5", "t4"]);
  });

  it("reads its settings with safe defaults", () => {
    assert.deepEqual(resolveTurnSectionSettings(undefined), {
      shown: true,
      limit: 5,
      includeChildThreads: true,
    });
    assert.deepEqual(
      resolveTurnSectionSettings({
        turnSections: "Hidden",
        turnSectionLimit: "8",
        turnSectionChildren: false,
      }),
      { shown: false, limit: 8, includeChildThreads: false },
    );
    assert.equal(resolveTurnSectionSettings({ turnSectionLimit: "999" }).limit, 5);
  });

  it("remembers folded sections and ignores anything else in storage", () => {
    let value: string | null = null;
    const storage: TurnSectionStorage = {
      getItem: (key) => (assert.equal(key, TURN_SECTIONS_STORAGE_KEY), value),
      setItem: (key, next) => {
        assert.equal(key, TURN_SECTIONS_STORAGE_KEY);
        value = next;
      },
    };
    assert.deepEqual([...readCollapsedTurnSections(storage)], []);
    assert.equal(writeCollapsedTurnSections(new Set(["working"]), storage), true);
    assert.deepEqual([...readCollapsedTurnSections(storage)], ["working"]);
    value = JSON.stringify(["inbox", "bogus", 7]);
    assert.deepEqual([...readCollapsedTurnSections(storage)], ["inbox"]);
    value = "not json";
    assert.deepEqual([...readCollapsedTurnSections(storage)], []);
    assert.deepEqual([...readCollapsedTurnSections(null)], []);
  });
});

describe("turn store", () => {
  it("records turn edges per thread and forgets deleted threads", () => {
    const db = new Database(":memory:");
    db.exec(TURN_MIGRATION);
    const store = createTurnStore(db);
    assert.deepEqual(store.record("t", "start", 10), { threadId: "t", startedAt: 10, endedAt: null });
    assert.deepEqual(store.record("t", "end", 20), { threadId: "t", startedAt: 10, endedAt: 20 });
    // A new turn moves the start and keeps the last end until it finishes.
    assert.deepEqual(store.record("t", "start", 30), { threadId: "t", startedAt: 30, endedAt: 20 });
    assert.deepEqual(store.list(), [{ threadId: "t", startedAt: 30, endedAt: 20 }]);
    assert.equal(store.remove("t"), true);
    assert.equal(store.remove("t"), false);
    assert.deepEqual(store.list(), []);
    db.close();
  });
});

describe("turn sections wiring", () => {
  it("records turns on the server and draws the sections above the Chats header", async () => {
    const server = await readFile(new URL("../server.ts", import.meta.url), "utf8");
    const inbox = await readFile(
      new URL("../components/inbox/thread-inbox.tsx", import.meta.url),
      "utf8",
    );
    assert.match(server, /TURN_MIGRATION,\r?\n\];/);
    assert.match(server, /listTurns:/);
    assert.match(server, /bb\.events\.on\("thread\.active", \(\{ thread \}\) => recordTurn\(thread\.id, "start"\)\)/);
    assert.match(server, /bb\.events\.on\("thread\.idle", \(\{ thread \}\) => recordTurn\(thread\.id, "end"\)\)/);
    assert.match(server, /bb\.events\.on\("thread\.failed", \(\{ thread \}\) => recordTurn\(thread\.id, "end"\)\)/);
    assert.match(server, /bb\.realtime\.publish\(TURN_CHANNEL/);
    for (const key of ["turnSections:", "turnSectionLimit:", "turnSectionChildren:"]) {
      assert.match(server, new RegExp(key));
    }

    // Parked threads stay off the lists, and the sections sit before the header.
    assert.match(inbox, /lifecycle\.shelfFor\(thread\) === "active"/);
    const sections = inbox.indexOf("<TurnSections");
    const header = inbox.search(/>\s*Chats\s*</);
    assert.ok(sections > 0 && header > sections, "TurnSections renders above the Chats header");
  });
});

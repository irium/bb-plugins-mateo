import type { PluginSidebarThread } from "@get-bb/plugin-sdk";
import { threadIsWorking } from "./inbox.ts";

/**
 * Inbox and Working: two short lists above the workspaces, for the threads
 * that just finished and the ones running right now, newest first. They
 * cut across projects, which the workspace tree cannot, and they live inside
 * Dockside's own thread list so they show in every navigation mode.
 */

/** When a thread's latest turn started and finished (epoch ms). */
export interface TurnTimes {
  threadId: string;
  startedAt: number | null;
  endedAt: number | null;
}

/** Realtime channel: one TurnTimes per change, or `{ threadId, deleted }`. */
export const TURN_CHANNEL = "thread-turns";

export type TurnSectionId = "inbox" | "working";
export const TURN_SECTION_IDS: readonly TurnSectionId[] = ["inbox", "working"];

export const TURN_SECTION_VISIBILITY_OPTIONS = ["Shown", "Hidden"] as const;
export const TURN_SECTION_LIMIT_OPTIONS = ["3", "5", "8", "10"] as const;
const DEFAULT_LIMIT = 5;

export interface TurnSectionSettings {
  shown: boolean;
  limit: number;
  includeChildThreads: boolean;
}

export function resolveTurnSectionSettings(
  values: Readonly<Record<string, string | boolean>> | undefined,
): TurnSectionSettings {
  const limit = Number(values?.turnSectionLimit);
  return {
    shown: values?.turnSections !== "Hidden",
    limit:
      TURN_SECTION_LIMIT_OPTIONS.includes(
        String(values?.turnSectionLimit) as (typeof TURN_SECTION_LIMIT_OPTIONS)[number],
      )
        ? limit
        : DEFAULT_LIMIT,
    includeChildThreads: values?.turnSectionChildren !== false,
  };
}

export interface TurnEntry {
  thread: PluginSidebarThread;
  /** The moment the row is ranked by, newest first. */
  at: number;
}

export interface TurnSectionLists {
  inbox: TurnEntry[];
  working: TurnEntry[];
}

/**
 * Splits threads into the two lists and keeps the newest of each.
 *
 * Working is a thread with a run in flight, ranked by when that turn began.
 * Inbox is everything else, ranked by when its turn ended. A thread waiting
 * on the user is mid-turn, but it is the user's move, so it belongs in Inbox,
 * ranked by whichever is later: the turn's end or bb's latest attention.
 * Without a recorded turn the ranking falls back to bb's own timestamps.
 */
export function buildTurnSections({
  threads,
  turns,
  includeChildThreads,
  limit,
}: {
  threads: readonly PluginSidebarThread[];
  turns: ReadonlyMap<string, TurnTimes>;
  includeChildThreads: boolean;
  limit: number;
}): TurnSectionLists {
  const inbox: TurnEntry[] = [];
  const working: TurnEntry[] = [];
  for (const thread of threads) {
    if (thread.isArchived) continue;
    if (!includeChildThreads && thread.parentThreadId !== null) continue;
    const turn = turns.get(thread.id);
    if (threadIsWorking(thread) && !thread.hasPendingInteraction) {
      working.push({ thread, at: turn?.startedAt ?? thread.updatedAt });
      continue;
    }
    const endedAt = turn?.endedAt ?? thread.latestAttentionAt;
    inbox.push({
      thread,
      at: thread.hasPendingInteraction
        ? Math.max(endedAt, thread.latestAttentionAt)
        : endedAt,
    });
  }
  const newestFirst = (left: TurnEntry, right: TurnEntry) =>
    right.at - left.at || left.thread.id.localeCompare(right.thread.id);
  return {
    inbox: inbox.sort(newestFirst).slice(0, limit),
    working: working.sort(newestFirst).slice(0, limit),
  };
}

export const TURN_SECTIONS_STORAGE_KEY = "bb.dockside.turn-sections.v1";

export interface TurnSectionStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** The sections the user folded away; both start open. */
export function readCollapsedTurnSections(
  storage: TurnSectionStorage | null = browserStorage(),
): ReadonlySet<TurnSectionId> {
  try {
    const raw = storage?.getItem(TURN_SECTIONS_STORAGE_KEY) ?? null;
    if (raw === null || raw.length > 200) return new Set();
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(
      parsed.filter((id): id is TurnSectionId =>
        TURN_SECTION_IDS.includes(id as TurnSectionId),
      ),
    );
  } catch {
    return new Set();
  }
}

export function writeCollapsedTurnSections(
  collapsed: ReadonlySet<TurnSectionId>,
  storage: TurnSectionStorage | null = browserStorage(),
): boolean {
  if (storage === null) return false;
  try {
    storage.setItem(
      TURN_SECTIONS_STORAGE_KEY,
      JSON.stringify(TURN_SECTION_IDS.filter((id) => collapsed.has(id))),
    );
    return true;
  } catch {
    return false;
  }
}

function browserStorage(): TurnSectionStorage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

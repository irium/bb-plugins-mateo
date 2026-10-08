import type Database from "better-sqlite3";
import type { TurnTimes } from "./turn-sections.ts";

/**
 * When each thread's latest turn started and finished.
 *
 * bb's sidebar payload carries no turn timestamps, so they are taken from the
 * lifecycle events as they happen: `thread.active` starts a turn,
 * `thread.idle` and `thread.failed` end it. A thread that has not had a turn
 * since this table appeared has no row; the sections fall back to the
 * timestamps bb does report.
 */
export const TURN_MIGRATION = `CREATE TABLE IF NOT EXISTS thread_turns (
  thread_id  TEXT PRIMARY KEY,
  started_at INTEGER,
  ended_at   INTEGER
)`;

interface TurnRow {
  thread_id: string;
  started_at: number | null;
  ended_at: number | null;
}

const toTimes = (row: TurnRow): TurnTimes => ({
  threadId: row.thread_id,
  startedAt: row.started_at,
  endedAt: row.ended_at,
});

export function createTurnStore(db: Database.Database) {
  const upsert = {
    start: db.prepare(
      `INSERT INTO thread_turns (thread_id, started_at) VALUES (?, ?)
       ON CONFLICT(thread_id) DO UPDATE SET started_at = excluded.started_at
       RETURNING thread_id, started_at, ended_at`,
    ),
    end: db.prepare(
      `INSERT INTO thread_turns (thread_id, ended_at) VALUES (?, ?)
       ON CONFLICT(thread_id) DO UPDATE SET ended_at = excluded.ended_at
       RETURNING thread_id, started_at, ended_at`,
    ),
  };
  const selectAll = db.prepare(
    "SELECT thread_id, started_at, ended_at FROM thread_turns",
  );
  const deleteOne = db.prepare("DELETE FROM thread_turns WHERE thread_id = ?");

  return {
    record(threadId: string, edge: "start" | "end", at: number): TurnTimes {
      return toTimes(upsert[edge].get(threadId, at) as TurnRow);
    },
    list(): TurnTimes[] {
      return (selectAll.all() as TurnRow[]).map(toTimes);
    },
    remove(threadId: string): boolean {
      return deleteOne.run(threadId).changes > 0;
    },
  };
}

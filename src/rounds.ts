// Advisor rounds: one per consultation (the per-message round, then any
// mid-task check-ins). The MoA thread embeds each as a live panel
// (`::moa-advisors{id="…"}`, rendered by app.tsx); the data lives here, in
// this plugin's own database, because a directive only carries an id.
import type { Database } from "better-sqlite3";
import { z } from "zod";
import { ADVISOR_PANEL_DIRECTIVE } from "./constants.js";

export const advisorStatusSchema = z.enum([
  "running",
  "answered",
  "failed",
  "timed-out",
  "stopped",
]);
export type AdvisorStatus = z.infer<typeof advisorStatusSchema>;

export const advisorEntrySchema = z.object({
  label: z.string(),
  providerId: z.string(),
  model: z.string(),
  reasoningLevel: z.string(),
  status: advisorStatusSchema,
  startedAt: z.number(),
  finishedAt: z.number().nullable(),
  /** The answer, streaming while `running`; partial when cut off. */
  answer: z.string().nullable(),
  /** What a running advisor is doing: "Thinking: …", "Reading src/app.ts". */
  activity: z.string().nullable().optional(),
  error: z.string().nullable(),
  workerThreadId: z.string().nullable(),
});
export type AdvisorEntry = z.infer<typeof advisorEntrySchema>;

export const advisorRoundSchema = z.object({
  id: z.string(),
  moaThreadId: z.string(),
  /** 0 for the per-message round, then 1, 2, … for mid-task check-ins. */
  round: z.number().int().nonnegative(),
  /** The aggregator's question for a check-in; null for the first round. */
  question: z.string().nullable(),
  startedAt: z.number(),
  finishedAt: z.number().nullable(),
  advisors: z.array(advisorEntrySchema),
});
export type AdvisorRound = z.infer<typeof advisorRoundSchema>;

export function roundId(runId: string, round: number): string {
  return `${runId}:${round}`;
}

/** The assistant-message text that embeds a round's panel. */
export function roundDirective(id: string): string {
  return `::${ADVISOR_PANEL_DIRECTIVE}{id="${id}"}`;
}

export interface RoundStore {
  save(round: AdvisorRound): void;
  get(id: string): AdvisorRound | null;
  deleteThread(moaThreadId: string): void;
}

/** Rounds in the plugin's SQLite database, one JSON row each. */
export function sqliteRoundStore(
  db: Database,
  migrate: (db: Database, statements: string[]) => void,
): RoundStore {
  migrate(db, [
    `CREATE TABLE IF NOT EXISTS advisor_rounds (
      id TEXT PRIMARY KEY,
      moa_thread_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      data TEXT NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS advisor_rounds_thread ON advisor_rounds (moa_thread_id)`,
  ]);
  const upsert = db.prepare(
    `INSERT INTO advisor_rounds (id, moa_thread_id, created_at, data) VALUES (?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET data = excluded.data`,
  );
  const select = db.prepare(`SELECT data FROM advisor_rounds WHERE id = ?`);
  const remove = db.prepare(`DELETE FROM advisor_rounds WHERE moa_thread_id = ?`);
  return {
    save(round) {
      upsert.run(round.id, round.moaThreadId, round.startedAt, JSON.stringify(round));
    },
    get(id) {
      const row = select.get(id) as { data: string } | undefined;
      if (row === undefined) return null;
      const parsed = advisorRoundSchema.safeParse(JSON.parse(row.data));
      return parsed.success ? parsed.data : null;
    },
    deleteThread(moaThreadId) {
      remove.run(moaThreadId);
    },
  };
}

/** For tests and as a fallback: rounds kept in memory. */
export function memoryRoundStore(): RoundStore & { rounds: Map<string, AdvisorRound> } {
  const rounds = new Map<string, AdvisorRound>();
  return {
    rounds,
    save(round) {
      rounds.set(round.id, structuredClone(round));
    },
    get(id) {
      const round = rounds.get(id);
      return round === undefined ? null : structuredClone(round);
    },
    deleteThread(moaThreadId) {
      for (const [id, round] of rounds) {
        if (round.moaThreadId === moaThreadId) rounds.delete(id);
      }
    },
  };
}

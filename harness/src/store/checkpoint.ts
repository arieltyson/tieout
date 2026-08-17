/**
 * Durable runs and the approval gate.
 *
 * A close stops to ask a human something and then waits. That wait might be
 * thirty seconds or it might be until tomorrow morning, so it cannot be
 * held in memory, in a timer, or in an open handle. The run is written down
 * at every state transition and picked up again from disk.
 *
 * Applying a decision is keyed on the proposal's idempotency key rather
 * than on anything about the request. Somebody will double tap approve.
 * That is planned for here rather than discovered during a demo.
 */
import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { RunState } from '../domain/close-run.js';
import type { Proposal } from '../domain/proposal.js';
import { transition, type RunEvent } from './run-state.js';

export type DecisionKind = 'approved' | 'rejected' | 'deferred';

export interface Decision {
  readonly idempotencyKey: string;
  readonly proposalId: string;
  readonly kind: DecisionKind;
  readonly decidedAt: string;
  readonly decidedBy: string;
}

export interface Checkpoint {
  readonly runId: string;
  readonly period: string;
  readonly state: RunState;
  readonly proposals: readonly Proposal[];
  readonly updatedAt: string;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS runs (
  run_id     TEXT PRIMARY KEY,
  period     TEXT NOT NULL,
  state      TEXT NOT NULL,
  proposals  TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS run_history (
  run_id  TEXT NOT NULL,
  seq     INTEGER NOT NULL,
  state   TEXT NOT NULL,
  event   TEXT NOT NULL,
  at      TEXT NOT NULL,
  PRIMARY KEY (run_id, seq)
);

CREATE TABLE IF NOT EXISTS decisions (
  idempotency_key TEXT PRIMARY KEY,
  run_id          TEXT NOT NULL,
  proposal_id     TEXT NOT NULL,
  kind            TEXT NOT NULL,
  decided_at      TEXT NOT NULL,
  decided_by      TEXT NOT NULL
);
`;

export class UnknownRun extends Error {
  constructor(runId: string) {
    super(`No checkpoint for run ${runId}.`);
    this.name = 'UnknownRun';
  }
}

export class CheckpointStore {
  private readonly db: Database.Database;

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.exec(SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  create(runId: string, period: string): Checkpoint {
    const at = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO runs (run_id, period, state, proposals, updated_at)
         VALUES (?, ?, 'planning', '[]', ?)`,
      )
      .run(runId, period, at);
    this.db
      .prepare(`INSERT INTO run_history (run_id, seq, state, event, at) VALUES (?, 0, 'planning', 'created', ?)`)
      .run(runId, at);
    return { runId, period, state: 'planning', proposals: [], updatedAt: at };
  }

  load(runId: string): Checkpoint {
    const row = this.db.prepare(`SELECT * FROM runs WHERE run_id = ?`).get(runId) as
      | Record<string, unknown>
      | undefined;
    if (row === undefined) throw new UnknownRun(runId);
    return {
      runId: row['run_id'] as string,
      period: row['period'] as string,
      state: row['state'] as RunState,
      proposals: JSON.parse(row['proposals'] as string) as Proposal[],
      updatedAt: row['updated_at'] as string,
    };
  }

  exists(runId: string): boolean {
    return this.db.prepare(`SELECT 1 FROM runs WHERE run_id = ?`).get(runId) !== undefined;
  }

  /** Stores proposals without moving the run. Used mid dispatch. */
  saveProposals(runId: string, proposals: readonly Proposal[]): void {
    const changed = this.db
      .prepare(`UPDATE runs SET proposals = ?, updated_at = ? WHERE run_id = ?`)
      .run(JSON.stringify(proposals), new Date().toISOString(), runId);
    if (changed.changes === 0) throw new UnknownRun(runId);
  }

  /**
   * Moves the run and writes it down in the same breath.
   *
   * The transition is validated first, so an illegal move never reaches
   * disk. A checkpoint that records an impossible state is worse than no
   * checkpoint, because it will be trusted on resume.
   */
  advance(runId: string, event: RunEvent): Checkpoint {
    const current = this.load(runId);
    const next = transition(current.state, event);
    const at = new Date().toISOString();

    const write = this.db.transaction(() => {
      this.db.prepare(`UPDATE runs SET state = ?, updated_at = ? WHERE run_id = ?`).run(next, at, runId);
      const seq =
        ((this.db.prepare(`SELECT MAX(seq) AS m FROM run_history WHERE run_id = ?`).get(runId) as
          { m: number | null }).m ?? 0) + 1;
      this.db
        .prepare(`INSERT INTO run_history (run_id, seq, state, event, at) VALUES (?, ?, ?, ?, ?)`)
        .run(runId, seq, next, event.type, at);
    });
    write();

    return { ...current, state: next, updatedAt: at };
  }

  history(runId: string): readonly { seq: number; state: RunState; event: string; at: string }[] {
    return this.db
      .prepare(`SELECT seq, state, event, at FROM run_history WHERE run_id = ? ORDER BY seq ASC`)
      .all(runId) as { seq: number; state: RunState; event: string; at: string }[];
  }

  /** Runs parked waiting on a person, so a restart can pick them up. */
  awaitingApproval(): readonly Checkpoint[] {
    const rows = this.db
      .prepare(`SELECT run_id FROM runs WHERE state = 'awaitingApproval'`)
      .all() as { run_id: string }[];
    return rows.map((r) => this.load(r.run_id));
  }

  /**
   * Applies a decision exactly once.
   *
   * Returns whether this call was the one that took effect. A second
   * identical call is not an error and is not a second effect; it is the
   * same decision arriving twice, which is what happens when a person taps
   * a button twice or a network retries.
   */
  applyDecision(runId: string, decision: Omit<Decision, 'decidedAt'> & { decidedAt?: string }): boolean {
    const result = this.db
      .prepare(
        `INSERT OR IGNORE INTO decisions
           (idempotency_key, run_id, proposal_id, kind, decided_at, decided_by)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        decision.idempotencyKey,
        runId,
        decision.proposalId,
        decision.kind,
        decision.decidedAt ?? new Date().toISOString(),
        decision.decidedBy,
      );
    return result.changes === 1;
  }

  decisions(runId: string): readonly Decision[] {
    const rows = this.db
      .prepare(`SELECT * FROM decisions WHERE run_id = ? ORDER BY decided_at ASC`)
      .all(runId) as Record<string, unknown>[];
    return rows.map((r) => ({
      idempotencyKey: r['idempotency_key'] as string,
      proposalId: r['proposal_id'] as string,
      kind: r['kind'] as DecisionKind,
      decidedAt: r['decided_at'] as string,
      decidedBy: r['decided_by'] as string,
    }));
  }

  /** Proposals with no decision yet. What a resumed run still needs. */
  undecided(runId: string): readonly Proposal[] {
    const decided = new Set(this.decisions(runId).map((d) => d.idempotencyKey));
    return this.load(runId).proposals.filter((p) => !decided.has(p.idempotencyKey));
  }
}

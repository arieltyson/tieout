/**
 * The append only audit log.
 *
 * Every tool call a run makes, with its arguments, its result, how long it
 * took, and what it cost. This is what makes a finding traceable: a
 * proposal carries evidence pointing at a sequence number, and this is the
 * table that number resolves against.
 *
 * Append only is enforced rather than intended. There is no update and no
 * delete, and a run that has been sealed rejects further writes. An audit
 * trail that can be edited after the fact is a story, not a record.
 *
 * Written by the dispatcher rather than by individual tools, so a tool
 * cannot forget to log itself and cannot choose what to log.
 */
import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export interface AuditRecord {
  readonly runId: string;
  readonly seq: number;
  readonly agent: string;
  readonly tool: string;
  readonly args: unknown;
  readonly result: unknown;
  readonly durationMs: number;
  readonly isError: boolean;
  readonly tokensIn: number;
  readonly tokensOut: number;
  readonly at: string;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS audit (
  run_id      TEXT NOT NULL,
  seq         INTEGER NOT NULL,
  agent       TEXT NOT NULL,
  tool        TEXT NOT NULL,
  args_json   TEXT NOT NULL,
  result_json TEXT NOT NULL,
  duration_ms INTEGER NOT NULL,
  is_error    INTEGER NOT NULL,
  tokens_in   INTEGER NOT NULL DEFAULT 0,
  tokens_out  INTEGER NOT NULL DEFAULT 0,
  at          TEXT NOT NULL,
  PRIMARY KEY (run_id, seq)
);

CREATE TABLE IF NOT EXISTS sealed_runs (
  run_id   TEXT PRIMARY KEY,
  sealed_at TEXT NOT NULL
);
`;

export class RunSealed extends Error {
  constructor(readonly runId: string) {
    super(`Run ${runId} is sealed. An audit trail that accepts late writes is not one.`);
    this.name = 'RunSealed';
  }
}

export class AuditLog {
  private readonly db: Database.Database;

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.exec(SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  append(record: Omit<AuditRecord, 'at'> & { at?: string }): void {
    if (this.isSealed(record.runId)) throw new RunSealed(record.runId);
    this.db
      .prepare(
        `INSERT INTO audit
           (run_id, seq, agent, tool, args_json, result_json, duration_ms, is_error, tokens_in, tokens_out, at)
         VALUES (@runId, @seq, @agent, @tool, @args, @result, @durationMs, @isError, @tokensIn, @tokensOut, @at)`,
      )
      .run({
        runId: record.runId,
        seq: record.seq,
        agent: record.agent,
        tool: record.tool,
        args: JSON.stringify(record.args ?? null),
        result: JSON.stringify(record.result ?? null),
        durationMs: record.durationMs,
        isError: record.isError ? 1 : 0,
        tokensIn: record.tokensIn,
        tokensOut: record.tokensOut,
        at: record.at ?? new Date().toISOString(),
      });
  }

  /** The full sequence for a run, in order. This is what replay reads. */
  replay(runId: string): readonly AuditRecord[] {
    const rows = this.db
      .prepare(`SELECT * FROM audit WHERE run_id = ? ORDER BY seq ASC`)
      .all(runId) as Record<string, unknown>[];
    return rows.map((r) => ({
      runId: r['run_id'] as string,
      seq: r['seq'] as number,
      agent: r['agent'] as string,
      tool: r['tool'] as string,
      args: JSON.parse(r['args_json'] as string),
      result: JSON.parse(r['result_json'] as string),
      durationMs: r['duration_ms'] as number,
      isError: (r['is_error'] as number) === 1,
      tokensIn: r['tokens_in'] as number,
      tokensOut: r['tokens_out'] as number,
      at: r['at'] as string,
    }));
  }

  /** The entries a proposal's evidence points at. This backs `why`. */
  evidenceFor(runId: string, seqs: readonly number[]): readonly AuditRecord[] {
    const wanted = new Set(seqs);
    return this.replay(runId).filter((r) => wanted.has(r.seq));
  }

  seal(runId: string): void {
    this.db
      .prepare(`INSERT OR IGNORE INTO sealed_runs (run_id, sealed_at) VALUES (?, ?)`)
      .run(runId, new Date().toISOString());
  }

  isSealed(runId: string): boolean {
    return (
      this.db.prepare(`SELECT 1 FROM sealed_runs WHERE run_id = ?`).get(runId) !== undefined
    );
  }

  stats(runId: string): { entries: number; errors: number; totalMs: number } {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS entries,
                SUM(is_error) AS errors,
                SUM(duration_ms) AS totalMs
         FROM audit WHERE run_id = ?`,
      )
      .get(runId) as { entries: number; errors: number | null; totalMs: number | null };
    return { entries: row.entries, errors: row.errors ?? 0, totalMs: row.totalMs ?? 0 };
  }
}

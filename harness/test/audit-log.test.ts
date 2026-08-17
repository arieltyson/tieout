import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { AuditLog, RunSealed } from '../src/store/audit-log.js';

let log: AuditLog;
const entry = (seq: number, over: Partial<Parameters<AuditLog['append']>[0]> = {}) => ({
  runId: 'run_1', seq, agent: 'categorizer', tool: 'propose_categorizations',
  args: { n: seq }, result: { recorded: seq }, durationMs: 5, isError: false,
  tokensIn: 100, tokensOut: 50, ...over,
});

beforeEach(() => { log = new AuditLog(':memory:'); });
afterEach(() => { log.close(); });

describe('append and replay', () => {
  test('replays in sequence order regardless of write order', () => {
    log.append(entry(3)); log.append(entry(1)); log.append(entry(2));
    expect(log.replay('run_1').map((r) => r.seq)).toEqual([1, 2, 3]);
  });

  test('round trips arguments and results through JSON', () => {
    log.append(entry(1, { args: { nested: { a: [1, 2] } }, result: { ok: true } }));
    const [row] = log.replay('run_1');
    expect(row!.args).toEqual({ nested: { a: [1, 2] } });
    expect(row!.result).toEqual({ ok: true });
  });

  test('keeps runs separate', () => {
    log.append(entry(1));
    log.append(entry(1, { runId: 'run_2' }));
    expect(log.replay('run_1')).toHaveLength(1);
    expect(log.replay('run_2')).toHaveLength(1);
  });

  test('an unknown run replays as empty rather than throwing', () => {
    expect(log.replay('nope')).toEqual([]);
  });

  test('rejects a duplicate sequence number', () => {
    log.append(entry(1));
    expect(() => log.append(entry(1))).toThrow();
  });
});

describe('evidence lookup, which is what backs the why command', () => {
  test('resolves the entries a proposal points at', () => {
    log.append(entry(1)); log.append(entry(2)); log.append(entry(3));
    const found = log.evidenceFor('run_1', [1, 3]);
    expect(found.map((r) => r.seq)).toEqual([1, 3]);
  });

  test('a proposal citing evidence that does not exist resolves to nothing', () => {
    // Better an empty answer than a fabricated one. The verifier bank is
    // what should have caught this before a human ever asked.
    log.append(entry(1));
    expect(log.evidenceFor('run_1', [99])).toEqual([]);
  });
});

describe('append only is enforced, not merely intended', () => {
  test('a sealed run rejects further writes', () => {
    log.append(entry(1));
    log.seal('run_1');
    expect(() => log.append(entry(2))).toThrow(RunSealed);
  });

  test('sealing one run does not seal another', () => {
    log.seal('run_1');
    expect(() => log.append(entry(1, { runId: 'run_2' }))).not.toThrow();
  });

  test('the log exposes no update or delete at all', () => {
    // The class surface is the enforcement. If someone adds a mutator, this
    // is where the argument for it has to happen.
    const surface = Object.getOwnPropertyNames(AuditLog.prototype);
    expect(surface).not.toContain('update');
    expect(surface).not.toContain('delete');
    expect(surface).not.toContain('clear');
  });

  test('sealing is idempotent', () => {
    log.seal('run_1'); log.seal('run_1');
    expect(log.isSealed('run_1')).toBe(true);
  });
});

describe('stats', () => {
  test('counts entries, errors, and time', () => {
    log.append(entry(1));
    log.append(entry(2, { isError: true, durationMs: 20 }));
    expect(log.stats('run_1')).toEqual({ entries: 2, errors: 1, totalMs: 25 });
  });

  test('an empty run reports zeroes rather than nulls', () => {
    expect(log.stats('nothing')).toEqual({ entries: 0, errors: 0, totalMs: 0 });
  });
});

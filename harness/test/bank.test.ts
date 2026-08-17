import { beforeEach, describe, expect, test, vi } from 'vitest';
import { runBank } from '../src/domain/bank.js';
import { fail, pass, type Verifier } from '../src/domain/verifier.js';
import * as f from './support/proposals.js';

beforeEach(() => {
  f.resetProposalIds();
});

const led = () => f.smallLedger();

/** An inferential verifier that always warns about the first proposal it sees. */
const alwaysWarns = (spy?: () => void): Verifier => ({
  name: 'always_warns',
  kind: 'inferential',
  check(proposals) {
    spy?.();
    const first = proposals[0];
    return first ? fail(this.name, 'looks odd', [first.id]) : pass(this.name);
  },
});

const neverFires: Verifier = {
  name: 'never_fires',
  kind: 'inferential',
  check() {
    return pass(this.name);
  },
};

describe('runBank — clean input', () => {
  test('passes everything and blocks nothing', () => {
    const result = runBank(f.validCategorizations(), led());
    expect(result.hasBlockingFailure).toBe(false);
    expect(result.passed).toHaveLength(3);
    expect(result.blocked).toEqual([]);
    expect(result.warned).toEqual([]);
  });

  test('runs every deterministic verifier and records each result', () => {
    const result = runBank(f.validCategorizations(), led());
    expect(result.results).toHaveLength(6);
    expect(result.results.every((r) => r.passed)).toBe(true);
  });
});

describe('runBank — blocking', () => {
  test('blocks the offending proposal on a bad GL code', () => {
    const result = runBank(f.nonexistentGlCode(), led());
    expect(result.hasBlockingFailure).toBe(true);
    expect(result.blocked).toHaveLength(1);
    expect(result.passed).toHaveLength(2);
  });

  test('carries the reason, so the agent can be told what to fix', () => {
    const result = runBank(f.nonexistentGlCode(), led());
    expect(result.blockingReasons.join(' ')).toContain('9999');
  });

  test('reports every defect at once rather than stopping at the first', () => {
    // An agent told only its first mistake burns a repair attempt per
    // defect against a budget that allows two.
    const result = runBank(f.multiplyInvalid(), led());
    const failed = result.results.filter((r) => !r.passed).map((r) => r.verifier);
    expect(failed.length).toBeGreaterThanOrEqual(5);
    expect(result.blockingReasons.length).toBeGreaterThanOrEqual(5);
  });

  test('blocks both halves of a double categorization', () => {
    const result = runBank(f.doubleCategorization(), led());
    expect(result.blocked.length).toBeGreaterThanOrEqual(2);
  });
});

// The case that motivates hasBlockingFailure existing as its own field.
describe('runBank — batch-level failure with no named offender', () => {
  test('sums_tie failing sets hasBlockingFailure even though blocked is empty', () => {
    const result = runBank(f.missingOneCategorization(), led());
    expect(result.hasBlockingFailure).toBe(true);
    expect(result.blocked).toEqual([]);
  });

  test('a caller gating on blocked.length alone would wrongly let this through', () => {
    const result = runBank(f.missingOneCategorization(), led());
    // Documents precisely why the flag is not derived from the array.
    expect(result.blocked.length === 0).toBe(true);
    expect(result.hasBlockingFailure).toBe(true);
  });
});

describe('runBank — inferential tier', () => {
  test('warns without blocking', () => {
    const result = runBank(f.validCategorizations(), led(), {
      inferential: [alwaysWarns()],
    });
    expect(result.hasBlockingFailure).toBe(false);
    expect(result.warned).toHaveLength(1);
    expect(result.passed).toHaveLength(2);
    expect(result.blocked).toEqual([]);
  });

  test('a passing inferential verifier leaves everything passed', () => {
    const result = runBank(f.validCategorizations(), led(), { inferential: [neverFires] });
    expect(result.passed).toHaveLength(3);
    expect(result.warned).toEqual([]);
  });

  test('does not see proposals the deterministic tier already blocked', () => {
    const seen: string[][] = [];
    const recorder: Verifier = {
      name: 'recorder',
      kind: 'inferential',
      check(proposals) {
        seen.push(proposals.map((p) => p.id));
        return pass(this.name);
      },
    };
    const proposals = f.nonexistentGlCode();
    const result = runBank(proposals, led(), { inferential: [recorder] });
    const blockedId = result.blocked[0]!.id;
    expect(seen[0]).not.toContain(blockedId);
    expect(seen[0]).toHaveLength(2);
  });

  test('a deterministic block outranks a warning on the same proposal', () => {
    // alwaysWarns targets the first survivor, which must not also appear
    // in blocked — a proposal reported twice reads as two problems.
    const result = runBank(f.nonexistentGlCode(), led(), { inferential: [alwaysWarns()] });
    const blockedIds = result.blocked.map((p) => p.id);
    const warnedIds = result.warned.map((p) => p.id);
    expect(blockedIds.some((id) => warnedIds.includes(id))).toBe(false);
  });

  // The above cannot actually exercise the precedence guard: inferential
  // verifiers only ever receive survivors, so under normal flow they have
  // no blocked id to name. But `offending` is an unvalidated string array,
  // and a verifier that reasons about related proposals — or is simply
  // buggy — can return an id it was never handed. Found by mutating the
  // guard away and watching zero tests fail.
  test('a verifier naming a proposal it was never given cannot un-block it', () => {
    const proposals = f.nonexistentGlCode();
    const firstRun = runBank(proposals, led());
    const blockedId = firstRun.blocked[0]!.id;

    const namesTheBlockedOne: Verifier = {
      name: 'names_out_of_scope',
      kind: 'inferential',
      check() {
        return fail(this.name, 'reaches outside its input', [blockedId]);
      },
    };

    const result = runBank(proposals, led(), { inferential: [namesTheBlockedOne] });
    expect(result.blocked.map((p) => p.id)).toContain(blockedId);
    expect(result.warned.map((p) => p.id)).not.toContain(blockedId);
    expect(result.passed.map((p) => p.id)).not.toContain(blockedId);
  });

  test('the three partitions are disjoint and cover every proposal', () => {
    const proposals = f.multiplyInvalid();
    const result = runBank(proposals, led(), { inferential: [alwaysWarns()] });
    const all = [...result.passed, ...result.blocked, ...result.warned].map((p) => p.id);
    expect(new Set(all).size).toBe(all.length);
    expect(new Set(all)).toEqual(new Set(proposals.map((p) => p.id)));
  });
});

describe('runBank — short-circuiting is real, not decorative', () => {
  test('skips the inferential tier entirely when nothing survives', () => {
    const spy = vi.fn();
    // Every proposal is evidence-free, so all are blocked.
    const proposals = f.validCategorizations().map((p) => ({ ...p, evidence: [] }));
    const result = runBank(proposals, led(), { inferential: [alwaysWarns(spy)] });
    expect(result.blocked).toHaveLength(3);
    expect(spy).not.toHaveBeenCalled();
  });

  test('still runs the inferential tier when some proposals survive', () => {
    const spy = vi.fn();
    runBank(f.nonexistentGlCode(), led(), { inferential: [alwaysWarns(spy)] });
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

describe('runBank — edge cases', () => {
  test('an empty proposal set against an empty ledger is clean', () => {
    const result = runBank([], f.ledger([]));
    expect(result.hasBlockingFailure).toBe(false);
    expect(result.passed).toEqual([]);
  });

  test('an empty proposal set against a non-empty ledger fails sums_tie', () => {
    // Nothing categorized is not the same as nothing to do.
    const result = runBank([], led());
    expect(result.hasBlockingFailure).toBe(true);
  });

  test('the bank is pure — the same input twice gives the same verdict', () => {
    const a = runBank(f.multiplyInvalid(), led());
    f.resetProposalIds();
    const b = runBank(f.multiplyInvalid(), led());
    expect(a.results.map((r) => [r.verifier, r.passed])).toEqual(
      b.results.map((r) => [r.verifier, r.passed]),
    );
  });

  test('does not mutate the proposals it is given', () => {
    const proposals = f.multiplyInvalid();
    const before = JSON.stringify(proposals);
    runBank(proposals, led());
    expect(JSON.stringify(proposals)).toBe(before);
  });
});

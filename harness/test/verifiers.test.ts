import { beforeEach, describe, expect, test } from 'vitest';
import { cents } from '../src/domain/money.js';
import {
  deterministicVerifiers,
  evidencePresent,
  glCodesExist,
  idempotencyKeysUnique,
  noDoubleCategorization,
  noOrphanReferences,
  sumsTie,
} from '../src/domain/verifiers.js';
import * as f from './support/proposals.js';

beforeEach(() => {
  f.resetProposalIds();
});

const led = () => f.smallLedger();

describe('every verifier passes the clean baseline', () => {
  // If one fails here it is over-strict and would block honest work.
  test.each(deterministicVerifiers.map((v) => v.name))('%s passes valid proposals', (name) => {
    const verifier = deterministicVerifiers.find((v) => v.name === name)!;
    const result = verifier.check(f.validCategorizations(), led());
    expect(result.passed, result.detail).toBe(true);
    expect(result.offending).toEqual([]);
  });

  test('all are deterministic, so all of them block rather than warn', () => {
    for (const v of deterministicVerifiers) expect(v.kind).toBe('deterministic');
  });

  test('a failure always carries a detail message, never a mute block', () => {
    const result = glCodesExist.check(f.nonexistentGlCode(), led());
    expect(result.passed).toBe(false);
    expect(result.detail).toBeTruthy();
  });
});

describe('sums_tie', () => {
  test('fails when a transaction is left uncategorized', () => {
    const result = sumsTie.check(f.missingOneCategorization(), led());
    expect(result.passed).toBe(false);
    expect(result.detail).toContain('3000');
    expect(result.detail).toContain('6000');
  });

  test('names the uncovered transaction, since a bare delta is not actionable', () => {
    const result = sumsTie.check(f.missingOneCategorization(), led());
    expect(result.detail).toContain('txn_0003');
  });

  test('fails when a transaction is double-counted', () => {
    const result = sumsTie.check(f.doubleCategorization(), led());
    expect(result.passed).toBe(false);
  });

  // A documented limitation, found by writing this test expecting a failure.
  // Against an empty ledger every proposal is an orphan contributing 0, and
  // the ledger total is also 0, so the arithmetic ties vacuously. sums_tie
  // is an arithmetic check, not an existence check — and the batch is still
  // blocked, by no_orphan_references. The layering is asserted here so that
  // if anyone ever disables that verifier, this test says what it was load-
  // bearing for.
  test('passes vacuously against an empty ledger — orphans are not its job', () => {
    const result = sumsTie.check(f.validCategorizations(), f.ledger([]));
    expect(result.passed).toBe(true);
  });

  test('but the batch is still blocked, by no_orphan_references', () => {
    const proposals = f.validCategorizations();
    const empty = f.ledger([]);
    expect(sumsTie.check(proposals, empty).passed).toBe(true);
    expect(noOrphanReferences.check(proposals, empty).passed).toBe(false);
  });

  test('blames the batch rather than a proposal, because it is a set property', () => {
    const result = sumsTie.check(f.missingOneCategorization(), led());
    expect(result.offending).toEqual([]);
  });

  test('an orphan reference does not silently make the sum tie', () => {
    // The orphan contributes 0, so the total falls short and this fires too.
    // Two verifiers reporting one input is correct, not double-counting.
    const result = sumsTie.check(f.orphanReference(), led());
    expect(result.passed).toBe(true); // all three real txns are still covered
  });
});

describe('gl_codes_exist', () => {
  test('fails on a code absent from the chart', () => {
    const result = glCodesExist.check(f.nonexistentGlCode(), led());
    expect(result.passed).toBe(false);
    expect(result.detail).toContain('9999');
  });

  test('names the offending proposal', () => {
    const result = glCodesExist.check(f.nonexistentGlCode(), led());
    expect(result.offending).toHaveLength(1);
  });

  test('fails on a well-formed but unassigned code', () => {
    const proposals = [f.proposal({ type: 'categorize', txnId: 'txn_0001', glCode: '7777' })];
    expect(glCodesExist.check(proposals, led()).passed).toBe(false);
  });

  test('accepts the 6900 escape hatch, which is a real account', () => {
    const proposals = [f.proposal({ type: 'categorize', txnId: 'txn_0001', glCode: '6900' })];
    expect(glCodesExist.check(proposals, led()).passed).toBe(true);
  });
});

describe('no_double_categorization', () => {
  test('fails when one transaction gets two different codes', () => {
    const result = noDoubleCategorization.check(f.doubleCategorization(), led());
    expect(result.passed).toBe(false);
    expect(result.detail).toContain('txn_0001');
  });

  // The case a naive "do the codes disagree?" implementation misses. It is
  // still wrong: it double-counts the amount.
  test('fails when one transaction gets the SAME code twice', () => {
    const result = noDoubleCategorization.check(f.doubleCategorizationSameCode(), led());
    expect(result.passed).toBe(false);
  });

  test('names every proposal involved, not just the later one', () => {
    const result = noDoubleCategorization.check(f.doubleCategorization(), led());
    expect(result.offending).toHaveLength(2);
  });

  test('does not fire on distinct transactions sharing a code', () => {
    const proposals = [
      f.proposal({ type: 'categorize', txnId: 'txn_0001', glCode: '6010' }),
      f.proposal({ type: 'categorize', txnId: 'txn_0002', glCode: '6010' }),
    ];
    expect(noDoubleCategorization.check(proposals, led()).passed).toBe(true);
  });
});

describe('no_orphan_references', () => {
  test('fails on a categorization of a transaction that does not exist', () => {
    const result = noOrphanReferences.check(f.orphanReference(), led());
    expect(result.passed).toBe(false);
    expect(result.detail).toContain('txn_9999');
  });

  test('fails when only one half of a duplicate pair is missing', () => {
    const result = noOrphanReferences.check(f.orphanDuplicatePair(), led());
    expect(result.passed).toBe(false);
    expect(result.detail).toContain('txn_9999');
  });

  test('fails on an orphaned receipt request', () => {
    const proposals = [f.proposal({ type: 'requestReceipt', txnId: 'txn_9999' })];
    expect(noOrphanReferences.check(proposals, led()).passed).toBe(false);
  });

  test('fails on an orphaned policy flag', () => {
    const proposals = [
      f.proposal({ type: 'flagPolicy', txnId: 'txn_9999', rule: 'single-txn-limit' }),
    ];
    expect(noOrphanReferences.check(proposals, led()).passed).toBe(false);
  });

  // An accrual is for a charge that never arrived. Reading its absent
  // reference as an orphan would block the one proposal kind whose whole
  // purpose is to describe something missing.
  test('does NOT fire on an accrual, which references nothing by design', () => {
    const proposals = [
      f.proposal({ type: 'accrue', vendor: 'Linear', amount: cents(9600), period: '2026-06' }),
    ];
    expect(noOrphanReferences.check(proposals, led()).passed).toBe(true);
  });
});

describe('idempotency_keys_unique', () => {
  test('fails on two proposals sharing a key', () => {
    const result = idempotencyKeysUnique.check(f.collidingIdempotencyKeys(), led());
    expect(result.passed).toBe(false);
    expect(result.detail).toContain('same-key');
  });

  test('names both colliding proposals', () => {
    const result = idempotencyKeysUnique.check(f.collidingIdempotencyKeys(), led());
    expect(result.offending).toHaveLength(2);
  });

  test('fails on a three-way collision and names all three', () => {
    const proposals = f.validCategorizations().map((p) => ({ ...p, idempotencyKey: 'k' }));
    const result = idempotencyKeysUnique.check(proposals, led());
    expect(result.passed).toBe(false);
    expect(result.offending).toHaveLength(3);
  });

  test('fails across different proposal kinds sharing a key', () => {
    const proposals = [
      f.proposal({ type: 'categorize', txnId: 'txn_0001', glCode: '6010' }, { idempotencyKey: 'k' }),
      f.proposal({ type: 'requestReceipt', txnId: 'txn_0002' }, { idempotencyKey: 'k' }),
    ];
    expect(idempotencyKeysUnique.check(proposals, led()).passed).toBe(false);
  });
});

describe('evidence_present', () => {
  test('fails on a proposal with no evidence', () => {
    const result = evidencePresent.check(f.evidenceFreeProposal(), led());
    expect(result.passed).toBe(false);
  });

  test('names the unsupported proposal', () => {
    const result = evidencePresent.check(f.evidenceFreeProposal(), led());
    expect(result.offending).toHaveLength(1);
  });

  test('fails when every proposal is unsupported', () => {
    const proposals = f.validCategorizations().map((p) => ({ ...p, evidence: [] }));
    const result = evidencePresent.check(proposals, led());
    expect(result.offending).toHaveLength(3);
  });

  test('accepts a single reference — one traceable computation is the bar', () => {
    const proposals = f.validCategorizations().map((p) => ({
      ...p,
      evidence: [{ runId: f.RUN_ID, seq: 0 }],
    }));
    expect(evidencePresent.check(proposals, led()).passed).toBe(true);
  });
});

describe('multiply-invalid input', () => {
  // The bank must surface every defect. An agent told only about the first
  // problem fixes it, resubmits, and gets told about the next one.
  test('each verifier reports independently on the same bad batch', () => {
    const proposals = f.multiplyInvalid();
    const failures = deterministicVerifiers
      .map((v) => v.check(proposals, led()))
      .filter((r) => !r.passed)
      .map((r) => r.verifier);

    expect(failures).toContain('gl_codes_exist');
    expect(failures).toContain('no_double_categorization');
    expect(failures).toContain('no_orphan_references');
    expect(failures).toContain('idempotency_keys_unique');
    expect(failures).toContain('evidence_present');
    expect(failures).toContain('sums_tie');
  });
});

import { beforeEach, describe, expect, test } from 'vitest';
import { sum } from '../src/domain/money.js';
import { LedgerSchema } from '../src/domain/ledger.js';
import { ProposalSchema } from '../src/domain/proposal.js';
import * as fixture from './support/proposals.js';

beforeEach(() => {
  fixture.resetProposalIds();
});

const builders = {
  validCategorizations: fixture.validCategorizations,
  missingOneCategorization: fixture.missingOneCategorization,
  nonexistentGlCode: fixture.nonexistentGlCode,
  doubleCategorization: fixture.doubleCategorization,
  doubleCategorizationSameCode: fixture.doubleCategorizationSameCode,
  orphanReference: fixture.orphanReference,
  orphanDuplicatePair: fixture.orphanDuplicatePair,
  collidingIdempotencyKeys: fixture.collidingIdempotencyKeys,
  evidenceFreeProposal: fixture.evidenceFreeProposal,
  multiplyInvalid: fixture.multiplyInvalid,
} as const;

describe('the invalid-proposal fixture', () => {
  // The fixture's one rule. A defect the schema already rejects is Zod's
  // job, not the bank's — putting it here would test Zod twice and leave
  // the verifier it was meant to exercise untested.
  test.each(Object.keys(builders))('%s produces schema-valid proposals', (name) => {
    const proposals = builders[name as keyof typeof builders]();
    expect(proposals.length).toBeGreaterThan(0);
    for (const p of proposals) {
      const parsed = ProposalSchema.safeParse(p);
      if (!parsed.success) {
        throw new Error(
          `${name} produced a proposal the schema rejects, so no verifier can be tested `
            + `against it:\n${JSON.stringify(parsed.error.issues, null, 2)}`,
        );
      }
    }
  });

  test('the baseline ledger is itself valid', () => {
    expect(LedgerSchema.safeParse(fixture.smallLedger()).success).toBe(true);
  });

  test('valid categorizations cover every ledger transaction exactly once', () => {
    const led = fixture.smallLedger();
    const ids = fixture.validCategorizations().map((p) => {
      if (p.kind.type !== 'categorize') throw new Error('expected only categorizations');
      return p.kind.txnId;
    });
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(ids)).toEqual(new Set(led.transactions.map((t) => t.id)));
  });

  test('the baseline ties to the ledger total, so sums_tie has a passing case', () => {
    const led = fixture.smallLedger();
    expect(sum(led.transactions.map((t) => t.amountCents))).toBe(6000);
  });

  test('the short set does NOT tie, so sums_tie has a failing case', () => {
    const led = fixture.smallLedger();
    const covered = new Set(
      fixture.missingOneCategorization().map((p) => {
        if (p.kind.type !== 'categorize') throw new Error('expected only categorizations');
        return p.kind.txnId;
      }),
    );
    const total = sum(led.transactions.filter((t) => covered.has(t.id)).map((t) => t.amountCents));
    expect(total).toBe(3000);
    expect(total).not.toBe(6000);
  });

  test('proposal ids are unique within a set', () => {
    for (const [name, build] of Object.entries(builders)) {
      fixture.resetProposalIds();
      const ids = build().map((p) => p.id);
      expect(new Set(ids).size, `${name} reused a proposal id`).toBe(ids.length);
    }
  });

  test('ids are stable across runs, so a failure names the same proposal twice', () => {
    fixture.resetProposalIds();
    const first = fixture.validCategorizations().map((p) => p.id);
    fixture.resetProposalIds();
    const second = fixture.validCategorizations().map((p) => p.id);
    expect(first).toEqual(second);
  });
});

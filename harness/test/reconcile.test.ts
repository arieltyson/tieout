import { beforeEach, describe, expect, test } from 'vitest';
import { cents } from '../src/domain/money.js';
import { reconcile, reconciliationRate } from '../src/domain/reconcile.js';
import type { BankTransaction } from '../src/domain/ledger.js';
import * as f from './support/proposals.js';

beforeEach(() => f.resetProposalIds());

const bank = (id: string, postedDate: string, amountCents: number): BankTransaction =>
  ({ id, postedDate, descriptor: 'SETTLED ACH', amountCents: cents(amountCents) });

const build = (txns: readonly [string, string, number][], rows: readonly BankTransaction[]) =>
  f.ledger(
    txns.map(([id, date, amount]) => f.transaction(id, cents(amount), { date })),
    { bankTransactions: [...rows] },
  );

describe('the ordinary case', () => {
  test('a charge and its settlement match across a date lag', () => {
    const l = build([['txn_0001', '2026-06-10', 5000]], [bank('bank_0001', '2026-06-12', 5000)]);
    const r = reconcile(l, '2026-06');
    expect(r.matched).toHaveLength(1);
    expect(r.matched[0]!.daysApart).toBe(2);
    expect(r.unreconciled).toEqual([]);
  });

  test('a charge with no settlement is unreconciled', () => {
    const l = build([['txn_0001', '2026-06-10', 5000]], []);
    expect(reconcile(l, '2026-06').unreconciled.map((t) => t.id)).toEqual(['txn_0001']);
  });

  test('a settlement with no charge is bank only', () => {
    const l = build([], [bank('bank_0001', '2026-06-10', 3500)]);
    expect(reconcile(l, '2026-06').bankOnly.map((b) => b.id)).toEqual(['bank_0001']);
  });

  test('a settlement outside the window does not match', () => {
    const l = build([['txn_0001', '2026-06-10', 5000]], [bank('bank_0001', '2026-06-20', 5000)]);
    const r = reconcile(l, '2026-06');
    expect(r.matched).toEqual([]);
    expect(r.unreconciled).toHaveLength(1);
  });

  test('a settlement dated before the charge does not match', () => {
    // Money does not settle before it is spent. A backwards pair is a
    // coincidence of amount, not a reconciliation.
    const l = build([['txn_0001', '2026-06-10', 5000]], [bank('bank_0001', '2026-06-08', 5000)]);
    expect(reconcile(l, '2026-06').matched).toEqual([]);
  });
});

describe('settlement adjustments', () => {
  test('a near miss is reported with its exact delta, not dropped', () => {
    const l = build([['txn_0001', '2026-06-10', 5000]], [bank('bank_0001', '2026-06-11', 5250)]);
    const r = reconcile(l, '2026-06');
    expect(r.matched).toEqual([]);
    expect(r.amountMismatches).toHaveLength(1);
    expect(r.amountMismatches[0]!.deltaCents).toBe(250);
  });

  test('a difference beyond tolerance is not called an adjustment', () => {
    const l = build([['txn_0001', '2026-06-10', 5000]], [bank('bank_0001', '2026-06-11', 90000)]);
    const r = reconcile(l, '2026-06');
    expect(r.amountMismatches).toEqual([]);
    expect(r.unreconciled).toHaveLength(1);
  });
});

describe('contested rows', () => {
  test('an exact pair is preferred over a tolerant one competing for it', () => {
    // Matching the tolerant pair first consumes the row the exact pair
    // needed, and leaves a clean transaction looking unreconciled.
    const l = build(
      [['txn_0001', '2026-06-10', 5000], ['txn_0002', '2026-06-10', 5100]],
      [bank('bank_0001', '2026-06-11', 5000)],
    );
    const r = reconcile(l, '2026-06');
    expect(r.matched.map((m) => m.txnId)).toEqual(['txn_0001']);
  });

  test('the nearer settlement wins when two charges share an amount', () => {
    const l = build(
      [['txn_0001', '2026-06-10', 5000], ['txn_0002', '2026-06-14', 5000]],
      [bank('bank_0001', '2026-06-11', 5000), bank('bank_0002', '2026-06-15', 5000)],
    );
    const r = reconcile(l, '2026-06');
    expect(r.matched).toHaveLength(2);
    expect(r.matched.find((m) => m.txnId === 'txn_0001')!.bankId).toBe('bank_0001');
    expect(r.matched.find((m) => m.txnId === 'txn_0002')!.bankId).toBe('bank_0002');
  });

  // The guard that mutation testing showed was unreachable from the fixture.
  // A genuine tie decided by array order is a confident wrong answer, and
  // this is the shape that produces one.
  test('a true tie stays ambiguous rather than being decided by ordering', () => {
    const l = build(
      [['txn_0001', '2026-06-10', 5000]],
      [bank('bank_0001', '2026-06-11', 5000), bank('bank_0002', '2026-06-11', 5000)],
    );
    const r = reconcile(l, '2026-06');
    expect(r.matched).toEqual([]);
    expect(r.ambiguous).toHaveLength(1);
    expect([...r.ambiguous[0]!.candidateBankIds].sort()).toEqual(['bank_0001', 'bank_0002']);
  });

  test('an ambiguous transaction is never also counted as unreconciled', () => {
    const l = build(
      [['txn_0001', '2026-06-10', 5000]],
      [bank('bank_0001', '2026-06-11', 5000), bank('bank_0002', '2026-06-11', 5000)],
    );
    const r = reconcile(l, '2026-06');
    expect(r.unreconciled).toEqual([]);
  });
});

describe('rate', () => {
  test('a fully reconciled month is 1', () => {
    const l = build([['txn_0001', '2026-06-10', 5000]], [bank('bank_0001', '2026-06-10', 5000)]);
    expect(reconciliationRate(reconcile(l, '2026-06'))).toBe(1);
  });

  test('an empty month is 1 rather than 0', () => {
    expect(reconciliationRate(reconcile(build([], []), '2026-06'))).toBe(1);
  });
});

/**
 * The reconciler scored against ground truth.
 *
 * Same argument as the anomaly detectors: if amount plus a date window
 * reconciles most of a month for nothing, that is the case for doing it in
 * code, and whatever is left is the case for the model.
 */
import { describe, expect, test } from 'vitest';
import { reconcile, reconciliationRate } from '../../harness/src/domain/reconcile.js';
import { loadGroundTruth, loadLedger } from '../src/index.js';

const ledger = loadLedger();
const groundTruth = loadGroundTruth();
const PERIOD = '2026-06';
const result = reconcile(ledger, PERIOD);
const planted = (kind: string) => groundTruth.plantedDefects.filter((d) => d.kind === kind);

describe('the fixture models a real bank feed', () => {
  test('the feed exists and is roughly the size of the period', () => {
    expect(ledger.bankTransactions.length).toBeGreaterThan(300);
  });

  test('bank descriptors differ from card descriptors', () => {
    // If they matched, the interesting part of reconciliation would not
    // exist and the detector would be tested against a straight join.
    const card = new Set(ledger.transactions.map((t) => t.vendorDescriptor));
    const overlap = ledger.bankTransactions.filter((b) => card.has(b.descriptor));
    expect(overlap).toHaveLength(0);
  });

  test('settlement dates lag the card dates', () => {
    const byAmount = new Map(ledger.transactions.map((t) => [t.amountCents, t.date]));
    const lagged = ledger.bankTransactions.filter((b) => {
      const cardDate = byAmount.get(b.amountCents);
      return cardDate !== undefined && b.postedDate > cardDate;
    });
    expect(lagged.length).toBeGreaterThan(0);
  });
});

describe('most of the month reconciles for nothing', () => {
  test('the deterministic rate is high', () => {
    expect(reconciliationRate(result)).toBeGreaterThan(0.8);
  });

  test('every matched pair really is the same amount', () => {
    for (const m of result.matched) expect(m.deltaCents).toBe(0);
  });

  test('no bank row is claimed by two transactions', () => {
    const claimed = [...result.matched, ...result.amountMismatches].map((m) => m.bankId);
    expect(new Set(claimed).size).toBe(claimed.length);
  });

  test('every pair settles within the window', () => {
    for (const m of [...result.matched, ...result.amountMismatches]) {
      expect(m.daysApart).toBeGreaterThanOrEqual(0);
      expect(m.daysApart).toBeLessThanOrEqual(4);
    }
  });
});

describe('scored against the planted reconciliation defects', () => {
  // THE PROPERTY THAT MATTERS MOST. Being unsure is acceptable. Being
  // confidently wrong is not: a charge that never settled, reported as
  // cleanly reconciled, is money quietly leaving the books.
  test('no planted defect is ever reported as cleanly matched', () => {
    const plantedIds = new Set([
      ...planted('unreconciled').flatMap((d) => d.txnIds),
      ...planted('bankAmountMismatch').flatMap((d) => d.txnIds),
    ]);
    const falselyClean = result.matched.filter((m) => plantedIds.has(m.txnId));
    expect(falselyClean).toEqual([]);
  });

  test('finds most of the charges that never settled, and guesses at none', () => {
    const expected = new Set(planted('unreconciled').flatMap((d) => d.txnIds));
    const found = new Set(result.unreconciled.map((t) => t.id));
    expect(expected.size).toBe(5);

    // Three are provably unreconciled. The other two share an amount with
    // several bank rows inside the settlement window, so arithmetic cannot
    // separate them and they are surfaced as ambiguous instead. That is the
    // deterministic half doing what it can and handing over the rest.
    const hit = [...expected].filter((id) => found.has(id));
    expect(hit.length).toBeGreaterThanOrEqual(3);

    const ambiguous = new Set(result.ambiguous.map((a) => a.txnId));
    for (const id of expected) {
      expect(found.has(id) || ambiguous.has(id), `${id} was neither flagged nor questioned`).toBe(true);
    }
  });

  test('nothing is called unreconciled that actually settled', () => {
    // Precision matters more than recall here. A false alarm on every
    // month end is how a reconciler gets switched off.
    const expected = new Set(planted('unreconciled').flatMap((d) => d.txnIds));
    for (const txn of result.unreconciled) expect(expected.has(txn.id)).toBe(true);
  });

  test('reports only statement rows that are genuinely orphaned', () => {
    // Precision over recall again. A row still wanted by an unresolved
    // transaction is the other half of an open question, not an orphan,
    // and calling it one produced forty eight false alarms against four
    // real ones before the contested rows were excluded.
    const expected = new Set(
      planted('bankOnly').map((d) => (d as { bankId: string }).bankId));
    expect(expected.size).toBe(4);

    for (const row of result.bankOnly) {
      expect(expected.has(row.id), `${row.id} is not a planted orphan`).toBe(true);
    }
  });

  test('an orphan it cannot prove is contested rather than lost', () => {
    const expected = planted('bankOnly').map((d) => (d as { bankId: string }).bankId);
    const found = new Set(result.bankOnly.map((b) => b.id));
    const contested = new Set(result.ambiguous.flatMap((a) => a.candidateBankIds));

    // Deterministically provable orphans are few, because most unmatched
    // rows are tied up in ambiguity. Resolving that is the model's job, and
    // this asserts the ones it cannot prove are at least still in play.
    expect(result.bankOnly.length).toBeGreaterThan(0);
    for (const id of expected) {
      expect(found.has(id) || contested.has(id), `${id} vanished entirely`).toBe(true);
    }
  });

  test('reports the exact delta on every adjustment it does find', () => {
    const expected = planted('bankAmountMismatch') as unknown as
      { txnIds: string[]; deltaCents: number }[];
    expect(expected).toHaveLength(4);

    const ambiguous = new Set(result.ambiguous.map((a) => a.txnId));
    let found = 0;
    for (const defect of expected) {
      const match = result.amountMismatches.find((m) => m.txnId === defect.txnIds[0]);
      if (match === undefined) {
        // Not silently lost: it is a question rather than an answer.
        expect(ambiguous.has(defect.txnIds[0]!)).toBe(true);
        continue;
      }
      found += 1;
      // A delta that is merely approximate is useless. The whole point is
      // being able to say how far out the settlement was.
      expect(match.deltaCents).toBe(defect.deltaCents);
    }
    expect(found).toBeGreaterThanOrEqual(3);
  });

  test('a settlement adjustment is reported rather than dropped', () => {
    // "This settled nine cents high" is useful. "No match found" is not.
    expect(result.amountMismatches.length).toBeGreaterThan(0);
    for (const m of result.amountMismatches) expect(m.deltaCents).not.toBe(0);
  });
});

describe('ambiguity is surfaced rather than guessed', () => {
  test('an ambiguous pairing names every candidate', () => {
    for (const a of result.ambiguous) {
      expect(a.candidateBankIds.length).toBeGreaterThan(1);
    }
  });

  test('nothing is both matched and ambiguous', () => {
    const matchedIds = new Set([...result.matched, ...result.amountMismatches].map((m) => m.txnId));
    for (const a of result.ambiguous) expect(matchedIds.has(a.txnId)).toBe(false);
  });

  test('every card row in the period ends up in exactly one bucket', () => {
    const inPeriod = ledger.transactions.filter((t) => t.date.startsWith(`${PERIOD}-`));
    const total = result.matched.length + result.amountMismatches.length
      + result.unreconciled.length + result.ambiguous.length;
    expect(total).toBe(inPeriod.length);
  });
});

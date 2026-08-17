/**
 * The query layer against the real 400-transaction fixture, scored on the
 * ground-truth manifest.
 *
 * This is where the queries stop being plausible and start being measured.
 * A query that looks right on a four-row hand-built ledger can still miss
 * every planted defect in a realistic one; these tests are the difference.
 *
 * Lives in fixtures/ rather than harness/ because it reads ground truth,
 * and the dependency only runs fixtures -> harness. Nothing in the harness
 * may import the answer key.
 */
import { describe, expect, test } from 'vitest';
import {
  byPeriod,
  exactDuplicateCandidates,
  missingReceipts,
  recurringGaps,
  uncategorized,
} from '../../harness/src/domain/queries.js';
import { loadGroundTruth, loadLedger } from '../src/index.js';

const ledger = loadLedger();
const groundTruth = loadGroundTruth();
const PERIOD = '2026-06';

const key = (ids: readonly string[]) => [...ids].sort().join('+');

describe('exactDuplicateCandidates against ground truth', () => {
  const candidates = exactDuplicateCandidates(ledger);
  const candidateKeys = new Set(candidates.map((c) => key(c.txnIds)));
  const planted = groundTruth.plantedDefects.filter((d) => d.kind === 'duplicate');

  test('recall is total — every planted duplicate pair is found', () => {
    expect(planted.length).toBe(6);
    const missed = planted.filter((d) => !candidateKeys.has(key(d.txnIds)));
    expect(missed.map((d) => d.id)).toEqual([]);
  });

  // Precision is deliberately below 1.0 and that is the correct behaviour.
  // Two identical coffee purchases on one day are a real pair, and no
  // deterministic rule can tell them from a double charge. The query
  // narrows 400 rows to a handful; the judgment is the model's.
  test('returns more candidates than planted defects, as a candidate query should', () => {
    expect(candidates.length).toBeGreaterThan(planted.length);
    expect(candidates.length).toBeLessThan(20);
  });

  test('every candidate group really does share vendor, date, and amount', () => {
    const byId = new Map(ledger.transactions.map((t) => [t.id, t]));
    for (const c of candidates) {
      const txns = c.txnIds.map((id) => byId.get(id)!);
      expect(new Set(txns.map((t) => t.vendorDescriptor)).size).toBe(1);
      expect(new Set(txns.map((t) => t.date)).size).toBe(1);
      expect(new Set(txns.map((t) => t.amountCents)).size).toBe(1);
    }
  });
});

describe('recurringGaps against ground truth', () => {
  const gaps = recurringGaps(ledger, PERIOD);
  const gapDescriptors = new Set(gaps.map((g) => g.vendorDescriptor));
  const planted = groundTruth.plantedDefects.filter((d) => d.kind === 'missingRecurring');

  test('finds exactly the five vendors that stopped billing', () => {
    expect(planted.length).toBe(5);
    expect(gaps).toHaveLength(5);
  });

  test('each gap names a vendor with a stopped recurring charge', () => {
    expect(gapDescriptors).toEqual(
      new Set([
        'CARTA INC',
        'DATADOG INC',
        'LINEAR ORBIT INC',
        'VERIZON WIRELESS',
        'ZOOM.US SAN JOSE CA',
      ]),
    );
  });

  test('every gap carries a prior amount, so an accrual can be proposed', () => {
    for (const gap of gaps) {
      expect(gap.lastAmountCents).toBeGreaterThan(0);
      expect(gap.priorMonths.length).toBeGreaterThanOrEqual(2);
    }
  });
});

describe('the remaining queries discriminate on real data', () => {
  test('byPeriod separates the close month from the prior ones', () => {
    const june = byPeriod(ledger, PERIOD);
    const april = byPeriod(ledger, '2026-04');
    expect(june.length).toBeGreaterThan(april.length);
    expect(june.length).toBeLessThan(ledger.transactions.length);
    expect(april.length).toBeGreaterThan(0);
  });

  test('missingReceipts is a strict subset, not everything', () => {
    const missing = missingReceipts(ledger);
    expect(missing.length).toBeGreaterThan(0);
    expect(missing.length).toBeLessThan(ledger.transactions.length);
    expect(missing.length).toBe(ledger.transactions.length - ledger.receipts.length);
  });

  // The one query that is vacuous today, asserted rather than glossed. No
  // transaction carries a GL code, so with nothing decided this returns the
  // whole ledger. The required parameter is what stops a Phase 4 caller
  // from getting this result by accident.
  test('uncategorized returns the whole ledger when nothing is decided', () => {
    expect(uncategorized(ledger, new Set())).toHaveLength(ledger.transactions.length);
  });

  test('and shrinks as decisions accumulate', () => {
    const decided = new Set(Object.keys(groundTruth.expectedCategorizations).slice(0, 100));
    expect(uncategorized(ledger, decided)).toHaveLength(ledger.transactions.length - 100);
  });
});

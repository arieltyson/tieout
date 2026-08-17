/**
 * The deterministic detectors scored against ground truth.
 *
 * This is the deterministic-first thesis, measured. Five of the seven
 * planted defect categories have exact answers, and if arithmetic finds
 * them at high precision and recall for zero tokens, that is the argument
 * for the architecture — not a claim about it.
 *
 * Lives in fixtures/ because it reads the answer key, and the dependency
 * only runs fixtures -> harness.
 */
import { describe, expect, test } from 'vitest';
import {
  fxMismatches,
  policyViolations,
  priceAnomalies,
  receiptMismatches,
} from '../../harness/src/domain/detectors.js';
import { exactDuplicateCandidates, recurringGaps } from '../../harness/src/domain/queries.js';
import { loadGroundTruth, loadLedger } from '../src/index.js';

const ledger = loadLedger();
const groundTruth = loadGroundTruth();
const PERIOD = '2026-06';

const plantedOf = (kind: string) => groundTruth.plantedDefects.filter((d) => d.kind === kind);

/** Precision, recall, F1 over sets of transaction ids. */
function score(found: readonly string[], expected: readonly string[]) {
  const foundSet = new Set(found);
  const expectedSet = new Set(expected);
  const truePositives = [...foundSet].filter((id) => expectedSet.has(id)).length;
  const precision = foundSet.size === 0 ? 0 : truePositives / foundSet.size;
  const recall = expectedSet.size === 0 ? 0 : truePositives / expectedSet.size;
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
  return { truePositives, found: foundSet.size, expected: expectedSet.size, precision, recall, f1 };
}

describe('fx mismatches', () => {
  const found = fxMismatches(ledger);
  const planted = plantedOf('fxMismatch');

  test('perfect recall and precision — conversion is arithmetic', () => {
    const s = score(found.map((f) => f.txnId), planted.flatMap((d) => d.txnIds));
    expect(s.expected).toBe(7);
    expect(s.recall).toBe(1);
    expect(s.precision).toBe(1);
  });

  test('reports the exact delta, which is what makes it actionable', () => {
    for (const defect of planted) {
      if (defect.kind !== 'fxMismatch') continue;
      const match = found.find((f) => f.txnId === defect.txnIds[0]);
      expect(match).toBeDefined();
      expect(match!.deltaCents).toBe(defect.deltaCents);
      expect(match!.expectedAmountCents).toBe(defect.expectedAmountCents);
    }
  });

  test('does not flag USD transactions', () => {
    const usdIds = new Set(ledger.transactions.filter((t) => t.currency === 'USD').map((t) => t.id));
    expect(found.some((f) => usdIds.has(f.txnId))).toBe(false);
  });
});

describe('receipt mismatches', () => {
  const found = receiptMismatches(ledger);
  const planted = plantedOf('receiptMismatch');

  test('perfect recall and precision — it is a comparison', () => {
    const s = score(found.map((f) => f.txnId), planted.flatMap((d) => d.txnIds));
    expect(s.expected).toBe(9);
    expect(s.recall).toBe(1);
    expect(s.precision).toBe(1);
  });

  test('reports both figures so a human can see which is wrong', () => {
    for (const f of found) {
      expect(f.transactionAmountCents).not.toBe(f.receiptTotalCents);
      expect(f.deltaCents).toBe(f.receiptTotalCents - f.transactionAmountCents);
    }
  });

  test('ignores transactions with no receipt at all', () => {
    const receipted = new Set(ledger.receipts.map((r) => r.txnId));
    expect(found.every((f) => receipted.has(f.txnId))).toBe(true);
  });
});

describe('policy violations', () => {
  // Scoped rules need the categorization, which is the agent's output. Here
  // ground truth stands in for a perfect categorizer, isolating the
  // detector's own behaviour from the model's accuracy.
  const glCodeFor = (txnId: string) => groundTruth.expectedCategorizations[txnId];
  const found = policyViolations(ledger, glCodeFor);
  const planted = plantedOf('policyViolation');

  test('finds every planted violation', () => {
    const s = score(found.map((f) => f.txnId), planted.flatMap((d) => d.txnIds));
    expect(s.expected).toBe(10);
    expect(s.recall).toBe(1);
  });

  // The assertion that was missing, and whose absence let a precision
  // figure be reported that had never been measured. It was 0.24: the
  // generator emitted ~31 legitimate large charges with no approval
  // record, so a correct detector flagged all of them against a manifest
  // that labelled only ten. The detector was right and the fixture was
  // self-contradictory; the generator now grants standing approval to
  // over-threshold spend that is not a planted violation.
  test('reports no false positives — precision is exactly 1', () => {
    const s = score(found.map((f) => f.txnId), planted.flatMap((d) => d.txnIds));
    expect(s.precision).toBe(1);
    expect(s.found).toBe(s.expected);
  });

  test('names the same rule ground truth does', () => {
    for (const defect of planted) {
      if (defect.kind !== 'policyViolation') continue;
      const match = found.find((f) => f.txnId === defect.txnIds[0]);
      expect(match).toBeDefined();
      expect(match!.rule).toBe(defect.rule);
    }
  });

  // The contrast cases. Large charges WITH approval on file must not be
  // reported, or the detector cries wolf on every legitimate purchase.
  test('never flags an approved charge, however large', () => {
    const approved = new Set(ledger.approvals);
    expect(approved.size).toBeGreaterThan(0);
    expect(found.some((f) => approved.has(f.txnId))).toBe(false);
  });

  test('reports at most one rule per transaction', () => {
    const ids = found.map((f) => f.txnId);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('price anomalies', () => {
  const found = priceAnomalies(ledger, { period: PERIOD });
  const planted = plantedOf('priceAnomaly');

  test('finds the planted month-over-month jumps', () => {
    const s = score(found.map((f) => f.txnId), planted.flatMap((d) => d.txnIds));
    expect(s.expected).toBe(6);
    // 5 of 6. The sixth vendor's descriptor varies per charge, so exact
    // grouping never establishes a prior — the documented limit of
    // deterministic vendor matching, and precisely the gap the model's
    // alias merging exists to close.
    expect(s.truePositives).toBe(5);
    expect(s.recall).toBeGreaterThanOrEqual(0.8);
  });

  // The assertion the trade above is FOR. Added after mutation testing
  // showed that deleting the usage-based guard failed no test at all: the
  // suite measured recall and never noticed the extra false positives the
  // guard exists to prevent.
  test('reports no false positives — precision is exactly 1', () => {
    const s = score(found.map((f) => f.txnId), planted.flatMap((d) => d.txnIds));
    expect(s.precision).toBe(1);
    expect(s.found).toBeLessThanOrEqual(s.expected);
  });

  test('every reported jump really does exceed the threshold', () => {
    for (const f of found) {
      expect(Math.abs(f.percentChange)).toBeGreaterThanOrEqual(0.3);
    }
  });

  test('carries the prior transaction, so the claim is checkable', () => {
    const ids = new Set(ledger.transactions.map((t) => t.id));
    for (const f of found) expect(ids.has(f.priorTxnId)).toBe(true);
  });
});

describe('duplicates and recurring gaps, already deterministic', () => {
  test('every planted duplicate pair appears among the candidates', () => {
    const candidates = new Set(
      exactDuplicateCandidates(ledger).map((c) => [...c.txnIds].sort().join('+')),
    );
    for (const d of plantedOf('duplicate')) {
      expect(candidates.has([...d.txnIds].sort().join('+'))).toBe(true);
    }
  });

  test('every planted recurring gap is found, with no false positives', () => {
    const gaps = recurringGaps(ledger, PERIOD);
    expect(gaps).toHaveLength(plantedOf('missingRecurring').length);
  });
});

// The headline for the architecture argument. Printed rather than only
// asserted, so the number is visible in test output.
describe('deterministic coverage of the benchmark', () => {
  test('arithmetic alone accounts for most planted defects, for zero tokens', () => {
    const glCodeFor = (txnId: string) => groundTruth.expectedCategorizations[txnId];
    const deterministicallyFound = new Set<string>([
      ...fxMismatches(ledger).map((f) => f.txnId),
      ...receiptMismatches(ledger).map((f) => f.txnId),
      ...policyViolations(ledger, glCodeFor).map((f) => f.txnId),
      ...priceAnomalies(ledger, { period: PERIOD }).map((f) => f.txnId),
      ...exactDuplicateCandidates(ledger).flatMap((c) => c.txnIds),
      ...recurringGaps(ledger, PERIOD).map((g) => g.lastTxnId),
    ]);

    const plantedTxnIds = new Set(groundTruth.plantedDefects.flatMap((d) => d.txnIds));
    const covered = [...plantedTxnIds].filter((id) => deterministicallyFound.has(id));
    const coverage = covered.length / plantedTxnIds.size;

    console.log(
      `\n  deterministic pre-pass touches ${covered.length}/${plantedTxnIds.size} `
        + `planted-defect transactions (${(coverage * 100).toFixed(0)}%), 0 tokens\n`,
    );
    expect(coverage).toBeGreaterThan(0.5);
  });
});

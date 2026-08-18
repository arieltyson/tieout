import { describe, expect, test } from 'vitest';
import { scoreAnomalies } from '../src/score-anomalies.js';
import type { Finding } from '../../harness/src/agents/anomaly-hunter.js';
import type { GroundTruth } from '../../fixtures/src/types.js';

const gt = (defects: unknown[]): GroundTruth =>
  ({ fixtureVersion: 2, seed: 1, period: '2026-06', expectedCategorizations: {},
     plantedDefects: defects as never }) as GroundTruth;

const bankOnly = (bankId: string): Finding =>
  ({ kind: 'bankOnly', txnIds: [], summary: bankId, materialityCents: 100,
     source: 'deterministic', bankId });

const planted = (bankId: string) =>
  ({ id: `b-${bankId}`, kind: 'bankOnly', txnIds: [], bankId, amountCents: 100, note: 'n' });

describe('bank only findings are scored on the bank row', () => {
  // The bug this exists to prevent: comparing transaction ids on findings
  // that have none compares two empty lists, matches everything against
  // everything, and reported precision 1.00 for forty eight findings
  // against four planted defects.
  test('a wrong bank row is not counted as a match', () => {
    const score = scoreAnomalies([bankOnly('bank_9999')], gt([planted('bank_0001')]));
    const row = score.byCategory.find((c) => c.kind === 'bankOnly')!;
    expect(row.truePositives).toBe(0);
    expect(row.precision).toBe(0);
  });

  test('the right bank row is counted', () => {
    const score = scoreAnomalies([bankOnly('bank_0001')], gt([planted('bank_0001')]));
    const row = score.byCategory.find((c) => c.kind === 'bankOnly')!;
    expect(row.truePositives).toBe(1);
    expect(row.recall).toBe(1);
  });

  test('many orphans against one planted defect tanks precision', () => {
    const findings = ['bank_0001', 'bank_0002', 'bank_0003', 'bank_0004'].map(bankOnly);
    const score = scoreAnomalies(findings, gt([planted('bank_0001')]));
    const row = score.byCategory.find((c) => c.kind === 'bankOnly')!;
    expect(row.reported).toBe(4);
    expect(row.precision).toBe(0.25);
  });
});

describe('transaction based categories still match on ids', () => {
  test('an overlapping transaction counts as the same finding', () => {
    const finding: Finding = {
      kind: 'unreconciled', txnIds: ['txn_0001'], summary: 's',
      materialityCents: 1, source: 'deterministic',
    };
    const score = scoreAnomalies([finding],
      gt([{ id: 'u1', kind: 'unreconciled', txnIds: ['txn_0001'], note: 'n' }]));
    expect(score.byCategory.find((c) => c.kind === 'unreconciled')!.truePositives).toBe(1);
  });
});

import { beforeEach, describe, expect, test } from 'vitest';
import { cents } from '../src/domain/money.js';
import {
  byPeriod,
  byVendor,
  exactDuplicateCandidates,
  missingReceipts,
  recurringGaps,
  uncategorized,
} from '../src/domain/queries.js';
import * as f from './support/proposals.js';

beforeEach(() => {
  f.resetProposalIds();
});

const txn = f.transaction;

describe('byPeriod', () => {
  const led = f.ledger([
    txn('txn_0001', cents(100), { date: '2026-05-31' }),
    txn('txn_0002', cents(200), { date: '2026-06-01' }),
    txn('txn_0003', cents(300), { date: '2026-06-30' }),
    txn('txn_0004', cents(400), { date: '2026-07-01' }),
  ]);

  test('returns only the requested month', () => {
    expect(byPeriod(led, '2026-06').map((t) => t.id)).toEqual(['txn_0002', 'txn_0003']);
  });

  test('includes both boundary days', () => {
    const ids = byPeriod(led, '2026-06').map((t) => t.id);
    expect(ids).toContain('txn_0002');
    expect(ids).toContain('txn_0003');
  });

  test('excludes the adjacent months', () => {
    const ids = byPeriod(led, '2026-06').map((t) => t.id);
    expect(ids).not.toContain('txn_0001');
    expect(ids).not.toContain('txn_0004');
  });

  test('a month with no activity returns empty', () => {
    expect(byPeriod(led, '2026-01')).toEqual([]);
  });
});

describe('uncategorized', () => {
  const led = f.smallLedger();

  test('an explicit empty set returns everything — nothing is decided yet', () => {
    expect(uncategorized(led, new Set()).map((t) => t.id)).toEqual([
      'txn_0001',
      'txn_0002',
      'txn_0003',
    ]);
  });

  test('excludes decided transactions', () => {
    expect(uncategorized(led, new Set(['txn_0002'])).map((t) => t.id)).toEqual([
      'txn_0001',
      'txn_0003',
    ]);
  });

  test('all decided returns empty', () => {
    const all = new Set(led.transactions.map((t) => t.id));
    expect(uncategorized(led, all)).toEqual([]);
  });

  test('ignores decided ids that are not in the ledger', () => {
    expect(uncategorized(led, new Set(['txn_9999']))).toHaveLength(3);
  });
});

describe('byVendor', () => {
  const led = f.ledger([
    txn('txn_0001', cents(100), { vendorDescriptor: 'UBER   *TRIP HELP.UBER.CO' }),
    txn('txn_0002', cents(200), { vendorDescriptor: 'UBER   *EATS' }),
    txn('txn_0003', cents(300), { vendorDescriptor: 'UBER   *TRIP HELP.UBER.CO' }),
  ]);

  test('matches the descriptor exactly', () => {
    expect(byVendor(led, 'UBER   *EATS').map((t) => t.id)).toEqual(['txn_0002']);
  });

  // The deliberate non-feature. Collapsing these to "UBER" would merge a
  // Travel charge with a Meals charge and quietly destroy what the
  // benchmark measures.
  test('does NOT collapse two descriptors sharing a brand', () => {
    expect(byVendor(led, 'UBER   *TRIP HELP.UBER.CO')).toHaveLength(2);
    expect(byVendor(led, 'UBER')).toEqual([]);
  });

  test('an unknown descriptor returns empty', () => {
    expect(byVendor(led, 'NOT A VENDOR')).toEqual([]);
  });
});

describe('missingReceipts', () => {
  const led = f.ledger(
    [txn('txn_0001', cents(100)), txn('txn_0002', cents(200)), txn('txn_0003', cents(300))],
    { receipts: [{ txnId: 'txn_0002', receiptTotalCents: cents(200) }] },
  );

  test('returns transactions with no receipt', () => {
    expect(missingReceipts(led).map((t) => t.id)).toEqual(['txn_0001', 'txn_0003']);
  });

  test('a fully receipted ledger returns empty', () => {
    const receipted = f.ledger([txn('txn_0001', cents(100))], {
      receipts: [{ txnId: 'txn_0001', receiptTotalCents: cents(100) }],
    });
    expect(missingReceipts(receipted)).toEqual([]);
  });

  test('a receipt whose amount disagrees still counts as present', () => {
    // Mismatched totals are the anomaly hunter's problem, not this query's.
    const mismatched = f.ledger([txn('txn_0001', cents(100))], {
      receipts: [{ txnId: 'txn_0001', receiptTotalCents: cents(999) }],
    });
    expect(missingReceipts(mismatched)).toEqual([]);
  });
});

describe('exactDuplicateCandidates', () => {
  test('finds a same-vendor same-day same-amount pair', () => {
    const led = f.ledger([
      txn('txn_0001', cents(100), { vendorDescriptor: 'NOTION', date: '2026-06-14' }),
      txn('txn_0002', cents(100), { vendorDescriptor: 'NOTION', date: '2026-06-14' }),
    ]);
    const candidates = exactDuplicateCandidates(led);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.txnIds).toEqual(['txn_0001', 'txn_0002']);
  });

  test('does not group across different dates', () => {
    const led = f.ledger([
      txn('txn_0001', cents(100), { vendorDescriptor: 'NOTION', date: '2026-06-14' }),
      txn('txn_0002', cents(100), { vendorDescriptor: 'NOTION', date: '2026-06-15' }),
    ]);
    expect(exactDuplicateCandidates(led)).toEqual([]);
  });

  test('does not group across different amounts', () => {
    const led = f.ledger([
      txn('txn_0001', cents(100), { vendorDescriptor: 'NOTION', date: '2026-06-14' }),
      txn('txn_0002', cents(101), { vendorDescriptor: 'NOTION', date: '2026-06-14' }),
    ]);
    expect(exactDuplicateCandidates(led)).toEqual([]);
  });

  test('does not group across different vendors', () => {
    const led = f.ledger([
      txn('txn_0001', cents(100), { vendorDescriptor: 'NOTION', date: '2026-06-14' }),
      txn('txn_0002', cents(100), { vendorDescriptor: 'FIGMA', date: '2026-06-14' }),
    ]);
    expect(exactDuplicateCandidates(led)).toEqual([]);
  });

  test('groups a triple as one candidate with three ids', () => {
    const led = f.ledger([
      txn('txn_0001', cents(100), { vendorDescriptor: 'NOTION', date: '2026-06-14' }),
      txn('txn_0002', cents(100), { vendorDescriptor: 'NOTION', date: '2026-06-14' }),
      txn('txn_0003', cents(100), { vendorDescriptor: 'NOTION', date: '2026-06-14' }),
    ]);
    expect(exactDuplicateCandidates(led)[0]!.txnIds).toHaveLength(3);
  });
});

describe('recurringGaps', () => {
  const monthly = (id: string, date: string) =>
    txn(id, cents(9600), { vendorDescriptor: 'LINEAR ORBIT INC', date });

  test('reports a vendor that billed twice then stopped', () => {
    const led = f.ledger([monthly('txn_0001', '2026-04-09'), monthly('txn_0002', '2026-05-09')]);
    const gaps = recurringGaps(led, '2026-06');
    expect(gaps).toHaveLength(1);
    expect(gaps[0]!.vendorDescriptor).toBe('LINEAR ORBIT INC');
    expect(gaps[0]!.priorMonths).toEqual(['2026-04', '2026-05']);
  });

  test('does not report a vendor that billed in the target period', () => {
    const led = f.ledger([
      monthly('txn_0001', '2026-04-09'),
      monthly('txn_0002', '2026-05-09'),
      monthly('txn_0003', '2026-06-09'),
    ]);
    expect(recurringGaps(led, '2026-06')).toEqual([]);
  });

  test('one prior month is not a pattern', () => {
    const led = f.ledger([monthly('txn_0001', '2026-05-09')]);
    expect(recurringGaps(led, '2026-06')).toEqual([]);
  });

  test('carries the last amount, so an accrual can be proposed', () => {
    const led = f.ledger([monthly('txn_0001', '2026-04-09'), monthly('txn_0002', '2026-05-09')]);
    expect(recurringGaps(led, '2026-06')[0]!.lastAmountCents).toBe(9600);
    expect(recurringGaps(led, '2026-06')[0]!.lastTxnId).toBe('txn_0002');
  });

  // The documented limitation of deterministic grouping, asserted so it
  // stays visible: a per-charge-varying descriptor never forms a pattern.
  test('cannot see a vendor whose descriptor changes every charge', () => {
    const led = f.ledger([
      txn('txn_0001', cents(82000), { vendorDescriptor: 'GOOGLE *CLOUD 1111111', date: '2026-04-05' }),
      txn('txn_0002', cents(82000), { vendorDescriptor: 'GOOGLE *CLOUD 2222222', date: '2026-05-05' }),
    ]);
    expect(recurringGaps(led, '2026-06')).toEqual([]);
  });
});

describe('the empty world', () => {
  const empty = f.ledger([]);

  test('every query returns empty rather than throwing', () => {
    expect(byPeriod(empty, '2026-06')).toEqual([]);
    expect(uncategorized(empty, new Set())).toEqual([]);
    expect(byVendor(empty, 'ANY')).toEqual([]);
    expect(missingReceipts(empty)).toEqual([]);
    expect(exactDuplicateCandidates(empty)).toEqual([]);
    expect(recurringGaps(empty, '2026-06')).toEqual([]);
  });
});

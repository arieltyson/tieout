import { describe, expect, test } from 'vitest';
import {
  DEFAULT_PERIOD,
  DEFAULT_SEED,
  GroundTruthSchema,
  LedgerSchema,
  generateFixture,
  loadGroundTruth,
  loadLedger,
} from '../src/index.js';

describe('loadLedger / loadGroundTruth', () => {
  test('the committed fixture files are valid and match the generator for the default seed', () => {
    const { ledger, groundTruth } = generateFixture(DEFAULT_SEED, DEFAULT_PERIOD);
    expect(loadLedger()).toEqual(ledger);
    expect(loadGroundTruth()).toEqual(groundTruth);
  });
});

// The loaders used to validate with Zod and then reassert the Cents brand
// with `as unknown as Ledger`. That worked only because the schema happened
// to check `.int()` — the cast itself proved nothing and would have passed a
// float straight through into the one type that exists to prevent floats.
// The schemas now brand at the point of validation, so these are the tests
// that hold that boundary shut.
describe('parsing rejects non-integer money', () => {
  const { ledger, groundTruth } = generateFixture(DEFAULT_SEED, DEFAULT_PERIOD);

  /**
   * A loosely-typed deep copy. Deliberately goes through JSON rather than
   * `structuredClone`, because that is exactly what the loaders face: a
   * plain parsed object with no brands and no readonly modifiers, which is
   * the state these schemas have to be trustworthy against.
   */
  interface LooseLedger {
    transactions: { amountCents: number }[];
    receipts: { receiptTotalCents: number }[];
  }
  interface LooseGroundTruth {
    plantedDefects: { kind: string; expectedAmountCents?: number }[];
  }
  const asJson = <T>(value: unknown): T => JSON.parse(JSON.stringify(value)) as T;

  test('a fractional transaction amount fails ledger validation', () => {
    const corrupted = asJson<LooseLedger>(ledger);
    corrupted.transactions[0]!.amountCents = 1234.56;
    expect(LedgerSchema.safeParse(corrupted).success).toBe(false);
  });

  test('a fractional receipt total fails ledger validation', () => {
    const corrupted = asJson<LooseLedger>(ledger);
    corrupted.receipts[0]!.receiptTotalCents = 99.99;
    expect(LedgerSchema.safeParse(corrupted).success).toBe(false);
  });

  test('a zero transaction amount fails ledger validation', () => {
    const corrupted = asJson<LooseLedger>(ledger);
    corrupted.transactions[0]!.amountCents = 0;
    expect(LedgerSchema.safeParse(corrupted).success).toBe(false);
  });

  test('a fractional amount inside a planted defect fails ground-truth validation', () => {
    const corrupted = asJson<LooseGroundTruth>(groundTruth);
    const fx = corrupted.plantedDefects.find((d) => d.kind === 'fxMismatch');
    expect(fx).toBeDefined();
    fx!.expectedAmountCents = 42.5;
    expect(GroundTruthSchema.safeParse(corrupted).success).toBe(false);
  });

  test('the uncorrupted fixture still parses', () => {
    expect(LedgerSchema.safeParse(ledger).success).toBe(true);
    expect(GroundTruthSchema.safeParse(groundTruth).success).toBe(true);
  });
});

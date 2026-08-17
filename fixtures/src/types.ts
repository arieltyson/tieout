/**
 * Fixture-specific types: the ground-truth manifest.
 *
 * The ledger types themselves live in `harness/src/domain/ledger.ts` — the
 * verifier bank operates on a Ledger, so it is a domain concept rather than
 * a fixture one, and duplicating the shape here would give it two
 * definitions that could drift. They are re-exported for convenience.
 *
 * Ground truth stays here on purpose. It is a property of a synthetic
 * benchmark, and nothing in the harness should be able to import it.
 */
import { z } from 'zod';
import {
  GlCodeSchema,
  PeriodSchema,
  TxnIdSchema,
  type TxnId,
} from '../../harness/src/domain/ledger.js';
import { CentsSchema, PositiveCentsSchema, type Cents } from '../../harness/src/domain/money.js';

export {
  CurrencySchema,
  LedgerSchema,
  ReceiptSchema,
  TransactionSchema,
  TxnIdSchema,
  type Currency,
  type Ledger,
  type Receipt,
  type Transaction,
  type TxnId,
} from '../../harness/src/domain/ledger.js';

// --- Ground truth -----------------------------------------------------

export interface DuplicateDefect {
  readonly id: string;
  readonly kind: 'duplicate';
  readonly txnIds: readonly [TxnId, TxnId];
  readonly note: string;
}

export interface VendorAliasDefect {
  readonly id: string;
  readonly kind: 'vendorAlias';
  readonly txnIds: readonly TxnId[];
  readonly canonicalVendor: string;
  readonly glCode: string;
  readonly note: string;
}

export interface FxMismatchDefect {
  readonly id: string;
  readonly kind: 'fxMismatch';
  readonly txnIds: readonly [TxnId];
  readonly expectedAmountCents: Cents;
  readonly actualAmountCents: Cents;
  readonly deltaCents: number;
  readonly note: string;
}

export interface ReceiptMismatchDefect {
  readonly id: string;
  readonly kind: 'receiptMismatch';
  readonly txnIds: readonly [TxnId];
  readonly transactionAmountCents: Cents;
  readonly receiptTotalCents: Cents;
  readonly deltaCents: number;
  readonly note: string;
}

export interface MissingRecurringDefect {
  readonly id: string;
  readonly kind: 'missingRecurring';
  /** The prior charges that establish the recurring pattern. */
  readonly txnIds: readonly TxnId[];
  readonly vendor: string;
  readonly glCode: string;
  readonly expectedAmountCents: Cents;
  readonly expectedPeriod: string;
  readonly note: string;
}

export interface PolicyViolationDefect {
  readonly id: string;
  readonly kind: 'policyViolation';
  readonly txnIds: readonly [TxnId];
  readonly rule: string;
  readonly note: string;
}

export interface PriceAnomalyDefect {
  readonly id: string;
  readonly kind: 'priceAnomaly';
  readonly txnIds: readonly [TxnId];
  readonly vendor: string;
  readonly priorAmountCents: Cents;
  readonly currentAmountCents: Cents;
  readonly percentChange: number;
  readonly note: string;
}

export type PlantedDefect =
  | DuplicateDefect
  | VendorAliasDefect
  | FxMismatchDefect
  | ReceiptMismatchDefect
  | MissingRecurringDefect
  | PolicyViolationDefect
  | PriceAnomalyDefect;

const baseDefectFields = { id: z.string().min(1), note: z.string().min(1) };

export const PlantedDefectSchema = z.discriminatedUnion('kind', [
  z.object({
    ...baseDefectFields,
    kind: z.literal('duplicate'),
    txnIds: z.tuple([TxnIdSchema, TxnIdSchema]),
  }),
  z.object({
    ...baseDefectFields,
    kind: z.literal('vendorAlias'),
    txnIds: z.array(TxnIdSchema).min(2),
    canonicalVendor: z.string().min(1),
    glCode: GlCodeSchema,
  }),
  z.object({
    ...baseDefectFields,
    kind: z.literal('fxMismatch'),
    txnIds: z.tuple([TxnIdSchema]),
    expectedAmountCents: CentsSchema,
    actualAmountCents: CentsSchema,
    deltaCents: z.number().int(),
  }),
  z.object({
    ...baseDefectFields,
    kind: z.literal('receiptMismatch'),
    txnIds: z.tuple([TxnIdSchema]),
    transactionAmountCents: CentsSchema,
    receiptTotalCents: CentsSchema,
    deltaCents: z.number().int(),
  }),
  z.object({
    ...baseDefectFields,
    kind: z.literal('missingRecurring'),
    txnIds: z.array(TxnIdSchema).min(1),
    vendor: z.string().min(1),
    glCode: GlCodeSchema,
    expectedAmountCents: PositiveCentsSchema,
    expectedPeriod: PeriodSchema,
  }),
  z.object({
    ...baseDefectFields,
    kind: z.literal('policyViolation'),
    txnIds: z.tuple([TxnIdSchema]),
    rule: z.string().min(1),
  }),
  z.object({
    ...baseDefectFields,
    kind: z.literal('priceAnomaly'),
    txnIds: z.tuple([TxnIdSchema]),
    vendor: z.string().min(1),
    priorAmountCents: PositiveCentsSchema,
    currentAmountCents: PositiveCentsSchema,
    percentChange: z.number(),
  }),
]);

export interface GroundTruth {
  readonly seed: number;
  readonly period: string;
  readonly expectedCategorizations: Readonly<Record<TxnId, string>>;
  readonly plantedDefects: readonly PlantedDefect[];
}

export const GroundTruthSchema = z.object({
  seed: z.number().int(),
  period: PeriodSchema,
  expectedCategorizations: z.record(TxnIdSchema, GlCodeSchema),
  plantedDefects: z.array(PlantedDefectSchema),
});

/**
 * Fixture domain types: the synthetic ledger and its ground-truth manifest.
 * Zod schemas here validate what's read back off disk (by tests and by
 * later phases); the generator itself builds plain TS objects typed against
 * the interfaces below and serializes them directly.
 */
import { z } from 'zod';
import type { Cents } from '../../harness/src/domain/money.js';

export type TxnId = string;
export const TxnIdSchema = z.string().regex(/^txn_\d{4,}$/);

export const CurrencySchema = z.enum(['USD', 'EUR']);
export type Currency = z.infer<typeof CurrencySchema>;

export interface Transaction {
  readonly id: TxnId;
  /** ISO date, YYYY-MM-DD. */
  readonly date: string;
  /** The raw, messy string as it would appear on a card statement. */
  readonly vendorDescriptor: string;
  /** What posts to the ledger — USD, always. */
  readonly amountCents: Cents;
  readonly currency: Currency;
  /** Original-currency minor units for non-USD charges; null for USD. */
  readonly originalAmountCents: Cents | null;
  /** FX rate applied at posting time; null for USD. */
  readonly fxRate: number | null;
}

export const TransactionSchema = z.object({
  id: TxnIdSchema,
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  vendorDescriptor: z.string().min(1),
  amountCents: z.number().int().positive(),
  currency: CurrencySchema,
  originalAmountCents: z.number().int().positive().nullable(),
  fxRate: z.number().positive().nullable(),
});

export interface Receipt {
  readonly txnId: TxnId;
  readonly receiptTotalCents: Cents;
}

export const ReceiptSchema = z.object({
  txnId: TxnIdSchema,
  receiptTotalCents: z.number().int().positive(),
});

export interface Ledger {
  readonly seed: number;
  readonly period: string;
  readonly transactions: readonly Transaction[];
  readonly receipts: readonly Receipt[];
  /** txnIds with prior spend approval on file — legitimate ledger data, not a defect flag. */
  readonly approvals: readonly TxnId[];
}

export const LedgerSchema = z.object({
  seed: z.number().int(),
  period: z.string().regex(/^\d{4}-\d{2}$/),
  transactions: z.array(TransactionSchema),
  receipts: z.array(ReceiptSchema),
  approvals: z.array(TxnIdSchema),
});

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
    glCode: z.string().regex(/^\d{4}$/),
  }),
  z.object({
    ...baseDefectFields,
    kind: z.literal('fxMismatch'),
    txnIds: z.tuple([TxnIdSchema]),
    expectedAmountCents: z.number().int(),
    actualAmountCents: z.number().int(),
    deltaCents: z.number().int(),
  }),
  z.object({
    ...baseDefectFields,
    kind: z.literal('receiptMismatch'),
    txnIds: z.tuple([TxnIdSchema]),
    transactionAmountCents: z.number().int(),
    receiptTotalCents: z.number().int(),
    deltaCents: z.number().int(),
  }),
  z.object({
    ...baseDefectFields,
    kind: z.literal('missingRecurring'),
    txnIds: z.array(TxnIdSchema).min(1),
    vendor: z.string().min(1),
    glCode: z.string().regex(/^\d{4}$/),
    expectedAmountCents: z.number().int().positive(),
    expectedPeriod: z.string().regex(/^\d{4}-\d{2}$/),
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
    priorAmountCents: z.number().int().positive(),
    currentAmountCents: z.number().int().positive(),
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
  period: z.string().regex(/^\d{4}-\d{2}$/),
  expectedCategorizations: z.record(TxnIdSchema, z.string().regex(/^\d{4}$/)),
  plantedDefects: z.array(PlantedDefectSchema),
});

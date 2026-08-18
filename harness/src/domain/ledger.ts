/**
 * The ledger: what an accountant would see, and nothing more.
 *
 * This lives in the harness rather than in `fixtures/` because the verifier
 * bank's signature is `(proposals, ledger)` — the ledger is a domain concept
 * the core operates on, and the fixture generator is merely one producer of
 * one. Ground-truth types stay in `fixtures/`, because ground truth is a
 * property of a synthetic benchmark and must never be something the harness
 * can reach for.
 *
 * Note what is absent: no GL code, no category, no `is_duplicate`. Every
 * question the agent exists to answer is deliberately unanswerable from this
 * type.
 */
import { z } from 'zod';
import { PositiveCentsSchema } from './money.js';

export const TxnIdSchema = z.string().regex(/^txn_\d{4,}$/, 'must look like txn_0001');
export type TxnId = z.infer<typeof TxnIdSchema>;

export const GlCodeSchema = z.string().regex(/^\d{4}$/, 'must be a four-digit GL code');

export const PeriodSchema = z.string().regex(/^\d{4}-\d{2}$/, 'must be YYYY-MM');
export type Period = z.infer<typeof PeriodSchema>;

export const CurrencySchema = z.enum(['USD', 'EUR']);
export type Currency = z.infer<typeof CurrencySchema>;

export const TransactionSchema = z.object({
  id: TxnIdSchema,
  /** ISO date, YYYY-MM-DD. */
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  /** The raw, messy string as it would appear on a card statement. */
  vendorDescriptor: z.string().min(1),
  /** What posts to the ledger — USD, always. */
  amountCents: PositiveCentsSchema,
  currency: CurrencySchema,
  /** Original-currency minor units for non-USD charges; null for USD. */
  originalAmountCents: PositiveCentsSchema.nullable(),
  /** FX rate applied at posting time; null for USD. */
  fxRate: z.number().positive().nullable(),
});
export type Transaction = z.infer<typeof TransactionSchema>;

export const ReceiptSchema = z.object({
  txnId: TxnIdSchema,
  receiptTotalCents: PositiveCentsSchema,
});
export type Receipt = z.infer<typeof ReceiptSchema>;

export const BankTransactionSchema = z.object({
  id: z.string().regex(/^bank_\d{4,}$/),
  postedDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  descriptor: z.string().min(1),
  amountCents: PositiveCentsSchema,
});
export type BankTransaction = z.infer<typeof BankTransactionSchema>;

export const LedgerSchema = z.object({
  seed: z.number().int(),
  period: PeriodSchema,
  transactions: z.array(TransactionSchema),
  receipts: z.array(ReceiptSchema),
  /** txnIds with prior spend approval on file — ordinary ledger data, not a defect flag. */
  approvals: z.array(TxnIdSchema),
  /**
   * The same month as the bank saw it. Defaulted so a fixture written
   * before the reconciler existed still loads rather than failing
   * validation on a field it could not have known about.
   */
  bankTransactions: z.array(BankTransactionSchema).default([]),
});
export type Ledger = z.infer<typeof LedgerSchema>;

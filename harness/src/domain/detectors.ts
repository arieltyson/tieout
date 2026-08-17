/**
 * Deterministic anomaly detectors.
 *
 * This file is the deterministic-first principle applied where it matters
 * most. Five of the seven defect categories in the benchmark have exact
 * answers: an FX conversion either reconciles to the cent or it does not, a
 * receipt total either equals the charge or it does not, an amount either
 * exceeds a policy threshold or it does not. Handing those to a model is
 * slower, costlier, and less accurate than arithmetic.
 *
 * What the model is FOR, and what deliberately is not here:
 *
 *   - deciding whether a duplicate CANDIDATE is a real double charge or two
 *     legitimate identical purchases on one day
 *   - merging vendor aliases, which needs judgment about identity rather
 *     than string equality
 *   - ranking findings by materiality and explaining them to a human
 *
 * Everything below returns CANDIDATES with the arithmetic already done. The
 * model's job starts where this file runs out.
 */
import { getPolicyRule, policyRules } from './policy-rules.js';
import type { Ledger, Transaction, TxnId } from './ledger.js';
import { cents, type Cents } from './money.js';

export interface FxMismatch {
  readonly txnId: TxnId;
  readonly vendorDescriptor: string;
  readonly currency: string;
  readonly originalAmountCents: Cents;
  readonly fxRate: number;
  /** What the posted amount should have been at the stated rate. */
  readonly expectedAmountCents: Cents;
  readonly actualAmountCents: Cents;
  readonly deltaCents: number;
}

/**
 * Foreign-currency charges whose posted amount does not equal the original
 * converted at the stated rate.
 *
 * Rounds half-away-from-zero to match how the generator posts, and compares
 * exactly. A tolerance would be the wrong instinct: the whole point is that
 * being off by a cent means the books do not close.
 */
export function fxMismatches(ledger: Ledger): readonly FxMismatch[] {
  const out: FxMismatch[] = [];
  for (const t of ledger.transactions) {
    if (t.currency === 'USD') continue;
    if (t.originalAmountCents === null || t.fxRate === null) continue;

    const expected = Math.round(t.originalAmountCents * t.fxRate);
    const delta = t.amountCents - expected;
    if (delta === 0) continue;

    out.push({
      txnId: t.id,
      vendorDescriptor: t.vendorDescriptor,
      currency: t.currency,
      originalAmountCents: t.originalAmountCents,
      fxRate: t.fxRate,
      expectedAmountCents: cents(expected),
      actualAmountCents: t.amountCents,
      deltaCents: delta,
    });
  }
  return out;
}

export interface ReceiptMismatch {
  readonly txnId: TxnId;
  readonly vendorDescriptor: string;
  readonly transactionAmountCents: Cents;
  readonly receiptTotalCents: Cents;
  readonly deltaCents: number;
}

/** Receipts whose total disagrees with the charge they are attached to. */
export function receiptMismatches(ledger: Ledger): readonly ReceiptMismatch[] {
  const txnById = new Map(ledger.transactions.map((t) => [t.id, t]));
  const out: ReceiptMismatch[] = [];
  for (const receipt of ledger.receipts) {
    const txn = txnById.get(receipt.txnId);
    if (txn === undefined) continue;
    const delta = receipt.receiptTotalCents - txn.amountCents;
    if (delta === 0) continue;
    out.push({
      txnId: txn.id,
      vendorDescriptor: txn.vendorDescriptor,
      transactionAmountCents: txn.amountCents,
      receiptTotalCents: receipt.receiptTotalCents,
      deltaCents: delta,
    });
  }
  return out;
}

export interface PolicyViolation {
  readonly txnId: TxnId;
  readonly vendorDescriptor: string;
  readonly amountCents: Cents;
  readonly rule: string;
  readonly thresholdCents: number;
  readonly overageCents: number;
}

/**
 * Charges breaching a spend rule with no approval on file.
 *
 * The approvals list is what separates a violation from an authorized large
 * purchase. A detector that flagged on amount alone would report every big
 * legitimate charge and be switched off within a week.
 *
 * `glCodeFor` supplies the categorization, because scoped rules need to know
 * which account a transaction landed in — and that is the agent's output,
 * not a ledger field. Unscoped rules apply regardless.
 */
export function policyViolations(
  ledger: Ledger,
  glCodeFor: (txnId: TxnId) => string | undefined = () => undefined,
): readonly PolicyViolation[] {
  const approved = new Set(ledger.approvals);
  const out: PolicyViolation[] = [];

  // Most specific rule first. A large equipment purchase breaches both the
  // general single-transaction limit and the scoped equipment limit;
  // reporting the general one is technically true and less useful, because
  // it hides which policy the buyer actually needed to know about.
  const bySpecificity = [...policyRules].sort((a, b) => {
    if ((a.glScope === null) !== (b.glScope === null)) return a.glScope === null ? 1 : -1;
    return b.thresholdCents - a.thresholdCents;
  });

  for (const t of ledger.transactions) {
    if (approved.has(t.id)) continue;
    const glCode = glCodeFor(t.id);

    for (const rule of bySpecificity) {
      if (rule.glScope !== null && rule.glScope !== glCode) continue;
      if (t.amountCents <= rule.thresholdCents) continue;
      out.push({
        txnId: t.id,
        vendorDescriptor: t.vendorDescriptor,
        amountCents: t.amountCents,
        rule: rule.id,
        thresholdCents: rule.thresholdCents,
        overageCents: t.amountCents - rule.thresholdCents,
      });
      // One finding per transaction. Two findings for one charge reads to
      // a human as two problems.
      break;
    }
  }
  return out;
}

export interface PriceAnomaly {
  readonly txnId: TxnId;
  readonly vendorDescriptor: string;
  readonly priorAmountCents: Cents;
  readonly currentAmountCents: Cents;
  readonly percentChange: number;
  readonly priorTxnId: TxnId;
}

export interface PriceAnomalyOptions {
  /** Fractional jump that counts as anomalous. 0.3 is a 30% increase. */
  readonly threshold?: number;
  readonly period: string;
}

/**
 * Recurring charges that jumped month-over-month.
 *
 * Compares a vendor's charge in the target period against its most recent
 * prior-month charge. Grouped by exact descriptor for the same reason
 * `byVendor` is: guessing that two descriptors are one vendor is judgment,
 * and a detector that guesses wrong invents anomalies out of unrelated
 * merchants.
 */
export function priceAnomalies(
  ledger: Ledger,
  options: PriceAnomalyOptions,
): readonly PriceAnomaly[] {
  const threshold = options.threshold ?? 0.3;
  const byDescriptor = new Map<string, Transaction[]>();
  for (const t of ledger.transactions) {
    const existing = byDescriptor.get(t.vendorDescriptor);
    if (existing) existing.push(t);
    else byDescriptor.set(t.vendorDescriptor, [t]);
  }

  const out: PriceAnomaly[] = [];
  for (const [descriptor, txns] of byDescriptor) {
    const current = txns.filter((t) => t.date.startsWith(`${options.period}-`));
    const prior = txns
      .filter((t) => t.date.slice(0, 7) < options.period)
      .sort((a, b) => a.date.localeCompare(b.date));

    const latestPrior = prior.at(-1);
    if (latestPrior === undefined || current.length === 0) continue;

    // Compare the LARGEST charge in the period, not the only one.
    //
    // The first version skipped any vendor with more than one charge in the
    // month, on the theory that usage-based billing makes a single
    // comparison meaningless. Mutation testing showed that guard failed no
    // test, and measuring it showed why: it was not preventing false
    // positives, it was hiding a true one. WeWork bills monthly AND picks
    // up an incidental day pass during a travel week, so the skip dropped a
    // genuine subscription increase. Recall 4/6 -> 5/6, precision still 1.
    const now = current.reduce((a, b) => (b.amountCents > a.amountCents ? b : a));
    if (latestPrior.amountCents === 0) continue;
    const change = (now.amountCents - latestPrior.amountCents) / latestPrior.amountCents;
    if (Math.abs(change) < threshold) continue;

    out.push({
      txnId: now.id,
      vendorDescriptor: descriptor,
      priorAmountCents: latestPrior.amountCents,
      currentAmountCents: now.amountCents,
      percentChange: Math.round(change * 1000) / 1000,
      priorTxnId: latestPrior.id,
    });
  }
  return out.sort((a, b) => a.vendorDescriptor.localeCompare(b.vendorDescriptor));
}

/** Everything the deterministic pass found, ready to hand to the model. */
export interface AnomalyCandidates {
  readonly fxMismatches: readonly FxMismatch[];
  readonly receiptMismatches: readonly ReceiptMismatch[];
  readonly policyViolations: readonly PolicyViolation[];
  readonly priceAnomalies: readonly PriceAnomaly[];
}

export function detectAll(
  ledger: Ledger,
  period: string,
  glCodeFor?: (txnId: TxnId) => string | undefined,
): AnomalyCandidates {
  return {
    fxMismatches: fxMismatches(ledger),
    receiptMismatches: receiptMismatches(ledger),
    policyViolations: policyViolations(ledger, glCodeFor),
    priceAnomalies: priceAnomalies(ledger, { period }),
  };
}

export function describeRule(ruleId: string): string {
  return getPolicyRule(ruleId)?.description ?? ruleId;
}

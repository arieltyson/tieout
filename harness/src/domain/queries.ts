/**
 * The ledger query layer: read-only, typed, pure.
 *
 * These are queries rather than agent work because they have exact answers.
 * Exact-duplicate detection is `GROUP BY vendor, amount, date HAVING
 * COUNT(*) > 1`; asking a model to do it is slower, costlier, and less
 * accurate. The model's job starts where this file runs out.
 *
 * ON DELIBERATELY NOT NORMALIZING VENDOR NAMES
 *
 * `byVendor` matches the descriptor exactly. That looks unhelpful — the
 * fixture is full of `AMZN Mktp US*2K4LM9XY3` and `AMAZON BUSINESS` — and it
 * is the point. Deciding that two descriptors are one vendor is the
 * categorizer's judgment, and a query layer that guessed would both do the
 * agent's job for it and get it wrong: `UBER *TRIP` and `UBER *EATS` share a
 * brand and belong to different GL codes. A helpful normalizer here would
 * quietly destroy the thing the benchmark measures.
 */
import type { Ledger, Period, Transaction, TxnId } from './ledger.js';
import type { Cents } from './money.js';

/** Transactions posted within the given accounting period. */
export function byPeriod(ledger: Ledger, period: Period): readonly Transaction[] {
  return ledger.transactions.filter((t) => t.date.startsWith(`${period}-`));
}

/**
 * Transactions with no categorization decision yet.
 *
 * `decided` is REQUIRED and has no default on purpose. Nothing in the ledger
 * records a GL code — that is the question the agent exists to answer — so
 * with an empty set this returns every transaction. A parameter defaulting
 * to empty would be vacuous at every call site that omitted it, and would
 * look correct while meaning nothing. Making it required forces a Phase 4
 * caller to supply the real decision set and forces a Phase 1 caller to pass
 * an explicit empty one, which reads as a statement rather than an accident.
 */
export function uncategorized(
  ledger: Ledger,
  decided: ReadonlySet<TxnId>,
): readonly Transaction[] {
  return ledger.transactions.filter((t) => !decided.has(t.id));
}

/** Transactions whose descriptor matches exactly. See the note above. */
export function byVendor(ledger: Ledger, vendorDescriptor: string): readonly Transaction[] {
  return ledger.transactions.filter((t) => t.vendorDescriptor === vendorDescriptor);
}

/** Transactions with no receipt attached. */
export function missingReceipts(ledger: Ledger): readonly Transaction[] {
  const receipted = new Set(ledger.receipts.map((r) => r.txnId));
  return ledger.transactions.filter((t) => !receipted.has(t.id));
}

export interface DuplicateCandidate {
  readonly vendorDescriptor: string;
  readonly date: string;
  readonly amountCents: Cents;
  readonly txnIds: readonly TxnId[];
}

/**
 * Groups of transactions sharing vendor, date, and amount.
 *
 * CANDIDATES, not verdicts. Two identical coffee purchases on one day are a
 * legitimate pair, and this query cannot tell them from a double charge.
 * Narrowing the field is deterministic work; the judgment call is the
 * model's, which is the split the whole architecture rests on.
 */
export function exactDuplicateCandidates(ledger: Ledger): readonly DuplicateCandidate[] {
  const groups = new Map<string, Transaction[]>();
  for (const t of ledger.transactions) {
    const key = `${t.vendorDescriptor} ${t.date} ${t.amountCents}`;
    const existing = groups.get(key);
    if (existing) existing.push(t);
    else groups.set(key, [t]);
  }

  const out: DuplicateCandidate[] = [];
  for (const group of groups.values()) {
    const first = group[0];
    if (group.length < 2 || first === undefined) continue;
    out.push({
      vendorDescriptor: first.vendorDescriptor,
      date: first.date,
      amountCents: first.amountCents,
      txnIds: group.map((t) => t.id),
    });
  }
  return out.sort((a, b) => (a.txnIds[0] ?? '').localeCompare(b.txnIds[0] ?? ''));
}

export interface RecurringGap {
  readonly vendorDescriptor: string;
  readonly priorMonths: readonly string[];
  readonly lastAmountCents: Cents;
  readonly lastTxnId: TxnId;
}

/**
 * Vendors that billed in at least two earlier months and then stopped.
 *
 * Grouped by exact descriptor, with the same reasoning as `byVendor` — and
 * with a real consequence worth knowing: a vendor whose descriptor varies
 * per charge (`GOOGLE *CLOUD 4471829`) never establishes a pattern here and
 * so can never be reported as a gap. That is a true limitation of
 * deterministic grouping, not a bug to paper over, and it is exactly the
 * work the categorizer's vendor memory exists to do.
 */
export function recurringGaps(ledger: Ledger, period: Period): readonly RecurringGap[] {
  const byDescriptor = new Map<string, Transaction[]>();
  for (const t of ledger.transactions) {
    const existing = byDescriptor.get(t.vendorDescriptor);
    if (existing) existing.push(t);
    else byDescriptor.set(t.vendorDescriptor, [t]);
  }

  const out: RecurringGap[] = [];
  for (const [descriptor, txns] of byDescriptor) {
    const months = new Set(txns.map((t) => t.date.slice(0, 7)));
    if (months.has(period)) continue;

    const priorMonths = [...months].filter((m) => m < period).sort();
    if (priorMonths.length < 2) continue;

    const latest = txns
      .filter((t) => t.date.slice(0, 7) < period)
      .sort((a, b) => a.date.localeCompare(b.date))
      .at(-1);
    if (latest === undefined) continue;

    out.push({
      vendorDescriptor: descriptor,
      priorMonths,
      lastAmountCents: latest.amountCents,
      lastTxnId: latest.id,
    });
  }
  return out.sort((a, b) => a.vendorDescriptor.localeCompare(b.vendorDescriptor));
}

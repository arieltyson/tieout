/**
 * Matching the card ledger against the bank feed.
 *
 * The naive approach is to match on descriptor and date, and it finds
 * almost nothing: the bank writes its own text and settles a day or three
 * later. So matching is on AMOUNT within a date window, which is exact when
 * an amount is unique in that window and ambiguous when it is not.
 *
 * That ambiguity is the whole point. A vendor charging the same amount
 * twice in a week produces two ledger rows and two bank rows that can be
 * paired either way, and no arithmetic resolves it. Unambiguous pairs are
 * matched here for nothing; the rest are handed to a model as candidates,
 * which is the same split the anomaly work uses.
 */
import type { BankTransaction, Ledger, Transaction, TxnId } from './ledger.js';

export const SETTLEMENT_WINDOW_DAYS = 4;

export interface MatchedPair {
  readonly txnId: TxnId;
  readonly bankId: string;
  readonly deltaCents: number;
  readonly daysApart: number;
}

export interface AmbiguousMatch {
  readonly txnId: TxnId;
  readonly vendorDescriptor: string;
  readonly amountCents: number;
  readonly candidateBankIds: readonly string[];
}

export interface Reconciliation {
  /** Exactly one candidate, so the pairing is settled. */
  readonly matched: readonly MatchedPair[];
  /** Matched, but the amounts disagree. A settlement adjustment. */
  readonly amountMismatches: readonly MatchedPair[];
  /** On the card, never at the bank. */
  readonly unreconciled: readonly Transaction[];
  /** At the bank, never on the card. */
  readonly bankOnly: readonly BankTransaction[];
  /** Several plausible pairings. The model decides. */
  readonly ambiguous: readonly AmbiguousMatch[];
}

/** Bank rows still wanted by an unresolved transaction. */
function reconciliationContested(ambiguous: readonly AmbiguousMatch[]): string[] {
  return ambiguous.flatMap((a) => [...a.candidateBankIds]);
}

function daysBetween(a: string, b: string): number {
  const toUtc = (d: string) => {
    const [y, m, day] = d.split('-').map(Number);
    return Date.UTC(y!, m! - 1, day!);
  };
  return Math.round((toUtc(b) - toUtc(a)) / 86_400_000);
}

/**
 * Reconciles a period.
 *
 * Amount tolerance exists because a settlement adjustment is a real thing:
 * a tip added after the fact posts at a different figure than the
 * authorisation. Pairs found within tolerance are reported as mismatches
 * rather than dropped, since "this settled nine cents high" is useful and
 * "no match found" is not.
 */
export function reconcile(
  ledger: Ledger,
  period: string,
  toleranceCents = 1000,
): Reconciliation {
  const cardRows = ledger.transactions.filter((t) => t.date.startsWith(`${period}-`));
  const bankRows = [...ledger.bankTransactions];

  const matched: MatchedPair[] = [];
  const amountMismatches: MatchedPair[] = [];
  const unreconciled: Transaction[] = [];
  const ambiguous: AmbiguousMatch[] = [];
  const claimedBank = new Set<string>();
  const settled = new Set<TxnId>();

  /**
   * The nearest candidate by settlement date, or nothing when two are
   * equally near. Deciding a true tie by whichever the query returned first
   * is how a reconciler produces a confident wrong answer.
   */
  const pickByProximity = (txn: Transaction, list: readonly BankTransaction[]) => {
    if (list.length === 1) return list[0];
    const ranked = [...list].sort(
      (a, b) => daysBetween(txn.date, a.postedDate) - daysBetween(txn.date, b.postedDate));
    const best = ranked[0]!;
    const next = ranked[1]!;
    return daysBetween(txn.date, best.postedDate) < daysBetween(txn.date, next.postedDate)
      ? best
      : undefined;
  };

  const candidatesFor = (txn: Transaction, tolerance: number) =>
    bankRows.filter((row) => {
      if (claimedBank.has(row.id)) return false;
      const gap = daysBetween(txn.date, row.postedDate);
      if (gap < 0 || gap > SETTLEMENT_WINDOW_DAYS) return false;
      return Math.abs(row.amountCents - txn.amountCents) <= tolerance;
    });

  /**
   * Pairs only where the choice is mutual.
   *
   * A transaction having exactly one candidate is not enough. That row may
   * be the only candidate for a different transaction too, and claiming it
   * first come leaves the other looking unreconciled when it simply lost a
   * race. Both sides must agree before a pair is settled.
   *
   * Removing a settled pair can make a neighbouring one unambiguous, so
   * this runs until it stops making progress rather than once.
   */
  const matchMutually = (tolerance: number) => {
    for (;;) {
      const open = cardRows.filter((t) => !settled.has(t.id));
      const options = new Map(open.map((t) => [t.id, candidatesFor(t, tolerance)]));

      // How many open transactions want each bank row.
      const wantedBy = new Map<string, number>();
      for (const list of options.values()) {
        for (const row of list) wantedBy.set(row.id, (wantedBy.get(row.id) ?? 0) + 1);
      }

      let progressed = false;
      for (const txn of open) {
        const list = options.get(txn.id) ?? [];
        if (list.length === 0) continue;

        // A tie on amount is resolved by settlement proximity, which is the
        // judgement a person makes without thinking: of two identical
        // charges, the one that posted first settled first. Only accepted
        // when the nearest candidate is strictly nearer than the next, so a
        // genuine coin flip stays ambiguous rather than being decided by
        // array order.
        const row = pickByProximity(txn, list);
        if (row === undefined || claimedBank.has(row.id)) continue;

        // Contested rows are left for a later pass. Once the uncontested
        // pairs are settled the contest usually resolves itself, and what
        // does not is genuinely ambiguous.
        if ((wantedBy.get(row.id) ?? 0) > 1 && list.length > 1) continue;

        claimedBank.add(row.id);
        settled.add(txn.id);
        const pair: MatchedPair = {
          txnId: txn.id,
          bankId: row.id,
          deltaCents: row.amountCents - txn.amountCents,
          daysApart: daysBetween(txn.date, row.postedDate),
        };
        if (pair.deltaCents === 0) matched.push(pair);
        else amountMismatches.push(pair);
        progressed = true;
      }
      if (!progressed) break;
    }
  };

  // Exact amounts across the whole period first. A tolerant pair matched
  // early can consume the row another transaction matched exactly.
  matchMutually(0);
  matchMutually(toleranceCents);

  for (const txn of cardRows) {
    if (settled.has(txn.id)) continue;
    const remaining = candidatesFor(txn, toleranceCents);
    if (remaining.length > 1) {
      ambiguous.push({
        txnId: txn.id,
        vendorDescriptor: txn.vendorDescriptor,
        amountCents: txn.amountCents,
        candidateBankIds: remaining.map((c) => c.id),
      });
    } else {
      // Either nothing plausible, or a single candidate that a competing
      // transaction also wanted. Both mean this one did not settle.
      unreconciled.push(txn);
    }
  }

  // A row that some ambiguous transaction still wants is not an orphan; it
  // is the other half of an open question. Reporting it as "on the
  // statement with no matching charge" would be a confident wrong answer,
  // and there are far more of those than there are real orphans.
  const contested = new Set(reconciliationContested(ambiguous));
  const bankOnly = bankRows.filter(
    (row) => !claimedBank.has(row.id) && !contested.has(row.id));

  return { matched, amountMismatches, unreconciled, bankOnly, ambiguous };
}

/** How much of the month reconciled without anybody looking at it. */
export function reconciliationRate(result: Reconciliation): number {
  const total =
    result.matched.length + result.amountMismatches.length
    + result.unreconciled.length + result.ambiguous.length;
  return total === 0 ? 1 : result.matched.length / total;
}

/**
 * The bank feed: the same month as the bank saw it.
 *
 * A reconciler exists because two records of the same money never quite
 * agree. This models the three ways they diverge in practice, and none of
 * them is "the descriptors are identical and the dates line up".
 *
 * SETTLEMENT LAG. A card charge authorises on one day and settles one to
 * three days later. Matching on date equality finds almost nothing.
 *
 * DIFFERENT TEXT. The bank writes its own descriptor. `SQ *BLUE BOTTLE
 * COFFE` on the card becomes something else entirely on the statement, so
 * matching on descriptor is worse than useless: it is confidently wrong.
 *
 * WHICH LEAVES AMOUNT plus a date window, and that is ambiguous whenever a
 * vendor charges the same amount twice in a week. Resolving that ambiguity
 * is the reconciler's actual job and the part a model is for.
 */
import { cents, type Cents } from '../../harness/src/domain/money.js';
import { clampDay, formatDate } from './dates.js';
import type { Rng } from './rng.js';
import type { Transaction, TxnId } from './types.js';

export interface BankTransaction {
  readonly id: string;
  /** When the bank posted it, which is not when the card authorised it. */
  readonly postedDate: string;
  readonly descriptor: string;
  readonly amountCents: Cents;
}

/** Bank statement text for a card descriptor. Deliberately unhelpful. */
function bankDescriptor(cardDescriptor: string, rng: Rng): string {
  const stem = cardDescriptor
    .replace(/^(SQ|PAYPAL|AMZN|GOOGLE|UBER)\s*\*?\s*/i, '')
    .replace(/[^A-Za-z ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toUpperCase();
  const suffix = rng.pick(['ACH', 'POS DEBIT', 'CARD PURCHASE', 'MERCHANT PMT']);
  return `${stem.slice(0, 18)} ${suffix}`.trim();
}

function shiftDate(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number);
  const shifted = new Date(Date.UTC(y!, m! - 1, d! + days));
  return formatDate(shifted.getUTCFullYear(), shifted.getUTCMonth() + 1, shifted.getUTCDate());
}

export interface BankFeedResult {
  readonly bankTransactions: BankTransaction[];
  /** Ledger rows deliberately absent from the feed. */
  readonly unreconciledTxnIds: TxnId[];
  /** Feed rows with no ledger counterpart. */
  readonly bankOnlyIds: string[];
  /** Matched pairs whose amounts disagree. */
  readonly amountMismatches: { txnId: TxnId; bankId: string; deltaCents: number }[];
}

/** Charges the bank applies that never appear on a card export. */
const BANK_ONLY_ROWS: readonly { descriptor: string; amountCents: number }[] = [
  { descriptor: 'MONTHLY SERVICE CHARGE', amountCents: 3500 },
  { descriptor: 'WIRE TRANSFER FEE', amountCents: 4500 },
  { descriptor: 'FOREIGN TXN FEE', amountCents: 1275 },
  { descriptor: 'RETURNED ITEM FEE', amountCents: 2900 },
];

export function generateBankFeed(
  transactions: readonly Transaction[],
  period: string,
  rng: Rng,
): BankFeedResult {
  const inPeriod = transactions.filter((t) => t.date.startsWith(`${period}-`));

  // Chosen from the middle of the period so a settlement shift cannot push
  // them outside the month and turn a planted defect into a date artifact.
  const eligible = inPeriod.filter((t) => {
    const day = Number(t.date.slice(8));
    return day >= 5 && day <= 24;
  });
  const shuffled = rng.shuffle(eligible);

  const unreconciled = shuffled.slice(0, 5);
  const mismatched = shuffled.slice(5, 9);
  const unreconciledSet = new Set(unreconciled.map((t) => t.id));
  const mismatchedMap = new Map(mismatched.map((t) => [t.id, t]));

  const bankTransactions: BankTransaction[] = [];
  const amountMismatches: BankFeedResult['amountMismatches'] = [];
  let seq = 1;
  const nextId = () => `bank_${String(seq++).padStart(4, '0')}`;

  for (const txn of inPeriod) {
    // A charge that never settled. Real, and the reason a reconciler runs.
    if (unreconciledSet.has(txn.id)) continue;

    const lag = rng.int(0, 3);
    const posted = shiftDate(txn.date, lag);
    const id = nextId();

    if (mismatchedMap.has(txn.id)) {
      // A tip adjustment or a partial refund settling at a different figure.
      const delta = (rng.bool() ? 1 : -1) * rng.int(100, 900);
      bankTransactions.push({
        id, postedDate: posted, descriptor: bankDescriptor(txn.vendorDescriptor, rng),
        amountCents: cents(txn.amountCents + delta),
      });
      amountMismatches.push({ txnId: txn.id, bankId: id, deltaCents: delta });
      continue;
    }

    bankTransactions.push({
      id, postedDate: posted, descriptor: bankDescriptor(txn.vendorDescriptor, rng),
      amountCents: txn.amountCents,
    });
  }

  const bankOnlyIds: string[] = [];
  for (const row of BANK_ONLY_ROWS) {
    const id = nextId();
    bankOnlyIds.push(id);
    bankTransactions.push({
      id,
      postedDate: formatDate(2026, 6, clampDay(2026, 6, rng.int(2, 27))),
      descriptor: row.descriptor,
      amountCents: cents(row.amountCents),
    });
  }

  bankTransactions.sort((a, b) =>
    a.postedDate === b.postedDate ? a.id.localeCompare(b.id) : a.postedDate.localeCompare(b.postedDate));

  return {
    bankTransactions,
    unreconciledTxnIds: unreconciled.map((t) => t.id),
    bankOnlyIds,
    amountMismatches,
  };
}

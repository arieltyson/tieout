/**
 * The seeded ledger generator. Same seed, same ledger, forever — no
 * wall-clock reads, no unseeded randomness anywhere in this module.
 *
 * The generator emits the answer key in the same pass that writes the
 * ledger (Commit 0.6): every planted defect is recorded into `groundTruth`
 * at the moment its transactions are created, so the manifest cannot drift
 * from what was actually planted. The ledger snapshot itself carries none
 * of that — no `is_duplicate` column, no defect IDs, nothing an agent
 * couldn't otherwise see on a real statement.
 */
import { cents, type Cents } from '../../harness/src/domain/money.js';
import { clampDay, formatDate } from './dates.js';
import { createRng, type Rng } from './rng.js';
import type {
  Currency,
  GroundTruth,
  Ledger,
  PlantedDefect,
  Receipt,
  Transaction,
  TxnId,
} from './types.js';
import {
  ADVERSARIAL_VENDORS,
  ALIAS_VENDOR_GROUPS,
  AMBIGUOUS_VENDORS,
  APPROVED_LARGE_SPEND_SEEDS,
  AUSTIN_CONFERENCE_BURST,
  DUPLICATE_SEEDS,
  EUR_FX_RATE,
  EUR_TRAVEL_VENDORS,
  LONG_TAIL_VENDORS,
  MISSING_RECURRING_KEYS,
  NYC_CLIENT_VISIT_BURST,
  POLICY_VIOLATION_SEEDS,
  PRICE_ANOMALY_KEYS,
  RECEIPT_MISMATCH_SEEDS,
  RECURRING_VENDORS,
  type BurstLineItem,
} from './vendors.js';

export const TARGET_TRANSACTION_COUNT = 400;
export const DEFAULT_SEED = 20260601;
export const DEFAULT_PERIOD = '2026-06';

/** [year, month] for each generated month; the last entry is the close period. */
const MONTHS: readonly { year: number; month: number }[] = [
  { year: 2026, month: 4 },
  { year: 2026, month: 5 },
  { year: 2026, month: 6 },
];
const CLOSE_MONTH_INDEX = MONTHS.length - 1;
const PARIS_BURST_DAYS = [9, 10, 11, 12, 13];

function at<T>(xs: readonly T[], i: number): T {
  const v = xs[i];
  if (v === undefined) throw new Error(`Index ${i} out of range (length ${xs.length})`);
  return v;
}

function last<T>(xs: readonly T[]): T {
  return at(xs, xs.length - 1);
}

interface Builder {
  readonly transactions: Transaction[];
  readonly receipts: Receipt[];
  readonly approvals: TxnId[];
  readonly expectedCategorizations: Record<TxnId, string>;
  readonly defects: PlantedDefect[];
  nextSeq: number;
}

interface AddTxnParams {
  readonly date: string;
  readonly vendorDescriptor: string;
  readonly amountCents: Cents;
  readonly glCode: string;
  readonly currency?: Currency;
  readonly originalAmountCents?: Cents | null;
  readonly fxRate?: number | null;
}

function addTxn(b: Builder, p: AddTxnParams): Transaction {
  const id: TxnId = `txn_${String(b.nextSeq++).padStart(4, '0')}`;
  const txn: Transaction = {
    id,
    date: p.date,
    vendorDescriptor: p.vendorDescriptor,
    amountCents: p.amountCents,
    currency: p.currency ?? 'USD',
    originalAmountCents: p.originalAmountCents ?? null,
    fxRate: p.fxRate ?? null,
  };
  b.transactions.push(txn);
  b.expectedCategorizations[id] = p.glCode;
  return txn;
}

function generateRecurring(b: Builder, rng: Rng): {
  byVendorKey: Map<string, Transaction[]>;
} {
  const byVendorKey = new Map<string, Transaction[]>();

  for (const vendor of RECURRING_VENDORS) {
    const vendorTxns: Transaction[] = [];
    for (let mi = 0; mi < MONTHS.length; mi++) {
      const isCloseMonth = mi === CLOSE_MONTH_INDEX;
      if (isCloseMonth && MISSING_RECURRING_KEYS.has(vendor.key)) continue;

      const { year, month } = at(MONTHS, mi);
      const dayJitter = vendor.dayJitterDays > 0 ? rng.int(-vendor.dayJitterDays, vendor.dayJitterDays) : 0;
      const day = clampDay(year, month, vendor.anchorDay + dayJitter);
      const date = formatDate(year, month, day);

      let amount = vendor.baseAmountCents;
      if (vendor.amountJitterPct > 0) {
        const jitter = rng.float(-vendor.amountJitterPct, vendor.amountJitterPct);
        amount = Math.round(vendor.baseAmountCents * (1 + jitter));
      }
      if (isCloseMonth && PRICE_ANOMALY_KEYS.has(vendor.key)) {
        const bump = rng.float(0.4, 0.8);
        amount = Math.round(vendor.baseAmountCents * (1 + bump));
      }

      const txn = addTxn(b, {
        date,
        vendorDescriptor: vendor.descriptor(rng),
        amountCents: cents(amount),
        glCode: vendor.glCode,
      });
      vendorTxns.push(txn);
    }
    byVendorKey.set(vendor.key, vendorTxns);

    if (MISSING_RECURRING_KEYS.has(vendor.key)) {
      b.defects.push({
        id: `missing-${vendor.key}`,
        kind: 'missingRecurring',
        txnIds: vendorTxns.map((t) => t.id),
        vendor: vendor.canonicalName,
        glCode: vendor.glCode,
        expectedAmountCents: cents(vendor.baseAmountCents),
        expectedPeriod: `${last(MONTHS).year}-${String(last(MONTHS).month).padStart(2, '0')}`,
        note: `${vendor.canonicalName} charged in ${MONTHS[0]!.month}/${MONTHS[1]!.month} but not in the close month — propose an accrual or confirm cancellation.`,
      });
    }
    if (PRICE_ANOMALY_KEYS.has(vendor.key)) {
      const juneTxn = last(vendorTxns);
      const priorTxn = at(vendorTxns, vendorTxns.length - 2);
      const pct = (juneTxn.amountCents - priorTxn.amountCents) / priorTxn.amountCents;
      b.defects.push({
        id: `price-${vendor.key}`,
        kind: 'priceAnomaly',
        txnIds: [juneTxn.id],
        vendor: vendor.canonicalName,
        priorAmountCents: priorTxn.amountCents,
        currentAmountCents: juneTxn.amountCents,
        percentChange: Math.round(pct * 1000) / 1000,
        note: `${vendor.canonicalName} jumped ${(pct * 100).toFixed(0)}% month-over-month — flag as anomalous, not duplicate.`,
      });
    }
  }

  const gcpTxns = byVendorKey.get('gcp');
  if (!gcpTxns) throw new Error('Unreachable: gcp vendor missing from recurring set');
  b.defects.push({
    id: 'alias-gcp',
    kind: 'vendorAlias',
    txnIds: gcpTxns.map((t) => t.id),
    canonicalVendor: 'Google Cloud',
    glCode: '5010',
    note: 'Same vendor, numeric suffix varies per charge — must not be treated as distinct vendors.',
  });

  return { byVendorKey };
}

function generateNotionAliasAndDuplicate(b: Builder, byVendorKey: Map<string, Transaction[]>): void {
  const notionTxns = byVendorKey.get('notion');
  if (!notionTxns) throw new Error('Unreachable: notion vendor missing from recurring set');

  const oneOff = addTxn(b, {
    date: formatDate(2026, 6, 18),
    vendorDescriptor: 'NOTION LABS INC',
    amountCents: cents(4800),
    glCode: '6010',
  });
  b.defects.push({
    id: 'alias-notion',
    kind: 'vendorAlias',
    txnIds: [...notionTxns.map((t) => t.id), oneOff.id],
    canonicalVendor: 'Notion',
    glCode: '6010',
    note: 'A PayPal-intermediated recurring charge and a direct one-off charge are the same vendor.',
  });

  const notionJune = last(notionTxns);
  const notionDup = addTxn(b, {
    date: notionJune.date,
    vendorDescriptor: notionJune.vendorDescriptor,
    amountCents: notionJune.amountCents,
    glCode: '6010',
  });
  const day = Number(notionJune.date.split('-')[2]);
  b.defects.push({
    id: 'dup-01',
    kind: 'duplicate',
    txnIds: [notionJune.id, notionDup.id],
    note: `Notion charged twice on the ${day}th.`,
  });
}

function generateAliasVendorGroups(b: Builder, rng: Rng): void {
  for (const group of ALIAS_VENDOR_GROUPS) {
    const groupTxns: Transaction[] = [];
    for (let i = 0; i < group.occurrences; i++) {
      const descriptorFn = at(group.descriptors, i % group.descriptors.length);
      const date = formatDate(2026, 6, rng.int(1, 28));
      const amount = rng.int(group.amountRangeCents[0], group.amountRangeCents[1]);
      const txn = addTxn(b, {
        date,
        vendorDescriptor: descriptorFn(rng),
        amountCents: cents(amount),
        glCode: group.glCode,
      });
      groupTxns.push(txn);
    }
    b.defects.push({
      id: `alias-${group.key}`,
      kind: 'vendorAlias',
      txnIds: groupTxns.map((t) => t.id),
      canonicalVendor: group.canonicalName,
      glCode: group.glCode,
      note: `${group.canonicalName} appears under ${group.descriptors.length} different descriptors in the same period.`,
    });
  }
}

function generateDuplicateSeeds(b: Builder, rng: Rng): void {
  for (const seed of DUPLICATE_SEEDS) {
    const date = formatDate(2026, 6, rng.int(1, 28));
    const amount = cents(rng.int(seed.amountRangeCents[0], seed.amountRangeCents[1]));
    const t1 = addTxn(b, { date, vendorDescriptor: seed.descriptor, amountCents: amount, glCode: seed.glCode });
    const t2 = addTxn(b, { date, vendorDescriptor: seed.descriptor, amountCents: amount, glCode: seed.glCode });
    b.defects.push({
      id: `dup-${seed.slug}`,
      kind: 'duplicate',
      txnIds: [t1.id, t2.id],
      note: `${seed.descriptor} charged twice on ${date}.`,
    });
  }
}

function generateEurTravelBurst(b: Builder, rng: Rng): void {
  for (const vendor of EUR_TRAVEL_VENDORS) {
    const day = rng.pick(PARIS_BURST_DAYS);
    const date = formatDate(2026, 6, day);
    const originalAmount = rng.int(vendor.originalAmountRangeCents[0], vendor.originalAmountRangeCents[1]);
    const correctAmount = Math.round(originalAmount * EUR_FX_RATE);
    const deltaCents = (rng.bool() ? 1 : -1) * rng.int(3, 9);
    const actualAmount = correctAmount + deltaCents;

    const txn = addTxn(b, {
      date,
      vendorDescriptor: vendor.descriptor(rng),
      amountCents: cents(actualAmount),
      glCode: vendor.glCode,
      currency: 'EUR',
      originalAmountCents: cents(originalAmount),
      fxRate: EUR_FX_RATE,
    });
    b.defects.push({
      id: `fx-${txn.id}`,
      kind: 'fxMismatch',
      txnIds: [txn.id],
      expectedAmountCents: cents(correctAmount),
      actualAmountCents: cents(actualAmount),
      deltaCents,
      note: `Posted at ${EUR_FX_RATE}, off by ${deltaCents}c from the correct conversion of the €${(originalAmount / 100).toFixed(2)} original charge.`,
    });
  }
}

function generateDomesticBurst(b: Builder, month: number, items: readonly BurstLineItem[]): void {
  for (const item of items) {
    addTxn(b, {
      date: formatDate(2026, month, item.day),
      vendorDescriptor: item.descriptor,
      amountCents: cents(item.amountCents),
      glCode: item.glCode,
    });
  }
}

function generateLongTail(b: Builder, rng: Rng, count: number): void {
  for (let i = 0; i < count; i++) {
    const pool = rng.bool(0.94) ? LONG_TAIL_VENDORS : AMBIGUOUS_VENDORS;
    const vendor = rng.pick(pool);
    const date = formatDate(2026, 6, rng.int(1, 28));
    const amount = rng.int(vendor.amountRangeCents[0], vendor.amountRangeCents[1]);
    addTxn(b, {
      date,
      vendorDescriptor: vendor.descriptor(rng),
      amountCents: cents(amount),
      glCode: vendor.glCode,
    });
  }
}

/**
 * Plants the adversarial merchant descriptors. Always exactly once each,
 * never sampled — an injection fixture that only shows up on some seeds is
 * not a fixture. See ADVERSARIAL_VENDORS for what this does and does not
 * currently prove.
 */
function generateAdversarialVendors(b: Builder, rng: Rng): void {
  for (const vendor of ADVERSARIAL_VENDORS) {
    addTxn(b, {
      date: formatDate(2026, 6, rng.int(1, 28)),
      vendorDescriptor: vendor.descriptor,
      amountCents: cents(vendor.amountCents),
      glCode: vendor.glCode,
    });
  }
}

function generatePolicyViolationsAndApprovals(b: Builder, rng: Rng): void {
  for (const seed of POLICY_VIOLATION_SEEDS) {
    const date = formatDate(2026, 6, rng.int(1, 28));
    const txn = addTxn(b, { date, vendorDescriptor: seed.descriptor, amountCents: cents(seed.amountCents), glCode: seed.glCode });
    b.defects.push({
      id: `policy-${txn.id}`,
      kind: 'policyViolation',
      txnIds: [txn.id],
      rule: seed.rule,
      note: `${seed.descriptor} charged ${(seed.amountCents / 100).toFixed(2)} with no approval on file, against rule "${seed.rule}".`,
    });
  }
  for (const seed of APPROVED_LARGE_SPEND_SEEDS) {
    const date = formatDate(2026, 6, rng.int(1, 28));
    const txn = addTxn(b, { date, vendorDescriptor: seed.descriptor, amountCents: cents(seed.amountCents), glCode: seed.glCode });
    b.approvals.push(txn.id);
  }
}

function generateReceiptMismatchSeeds(b: Builder, rng: Rng): void {
  for (const seed of RECEIPT_MISMATCH_SEEDS) {
    const date = formatDate(2026, 6, rng.int(1, 28));
    const txn = addTxn(b, { date, vendorDescriptor: seed.descriptor, amountCents: cents(seed.amountCents), glCode: seed.glCode });
    b.receipts.push({ txnId: txn.id, receiptTotalCents: cents(seed.receiptTotalCents) });
    const deltaCents = seed.receiptTotalCents - seed.amountCents;
    b.defects.push({
      id: `receipt-${txn.id}`,
      kind: 'receiptMismatch',
      txnIds: [txn.id],
      transactionAmountCents: cents(seed.amountCents),
      receiptTotalCents: cents(seed.receiptTotalCents),
      deltaCents,
      note: `${seed.descriptor}: receipt total differs from the posted charge by ${deltaCents}c.`,
    });
  }
}

/**
 * Ordinary receipts for a random subset of every remaining transaction,
 * always matching the transaction exactly — most receipts tie out cleanly.
 * This is what makes the mismatch seeds findable rather than the default
 * state, and why some transactions legitimately have no receipt at all
 * (the `missingReceipts` query in Phase 1.5 needs those to exist).
 */
function attachOrdinaryReceipts(b: Builder, rng: Rng): void {
  const alreadyReceipted = new Set(b.receipts.map((r) => r.txnId));
  for (const txn of b.transactions) {
    if (alreadyReceipted.has(txn.id)) continue;
    if (rng.bool(0.5)) {
      b.receipts.push({ txnId: txn.id, receiptTotalCents: txn.amountCents });
    }
  }
}

export function generateFixture(seed: number, period: string): { ledger: Ledger; groundTruth: GroundTruth } {
  const rng = createRng(seed);
  const b: Builder = {
    transactions: [],
    receipts: [],
    approvals: [],
    expectedCategorizations: {},
    defects: [],
    nextSeq: 1,
  };

  const { byVendorKey } = generateRecurring(b, rng);
  generateNotionAliasAndDuplicate(b, byVendorKey);
  generateAliasVendorGroups(b, rng);
  generateDuplicateSeeds(b, rng);
  generateEurTravelBurst(b, rng);
  generateDomesticBurst(b, 6, NYC_CLIENT_VISIT_BURST);
  generateDomesticBurst(b, 6, AUSTIN_CONFERENCE_BURST);
  generatePolicyViolationsAndApprovals(b, rng);
  generateReceiptMismatchSeeds(b, rng);
  generateAdversarialVendors(b, rng);

  const remaining = Math.max(0, TARGET_TRANSACTION_COUNT - b.transactions.length);
  generateLongTail(b, rng, remaining);

  attachOrdinaryReceipts(b, rng);

  const sortedTransactions = [...b.transactions].sort((a, c) =>
    a.date === c.date ? a.id.localeCompare(c.id) : a.date.localeCompare(c.date),
  );
  const sortedReceipts = [...b.receipts].sort((a, c) => a.txnId.localeCompare(c.txnId));
  const sortedApprovals = [...b.approvals].sort();
  const sortedDefects = [...b.defects].sort((a, c) => a.id.localeCompare(c.id));
  const sortedExpectedCategorizations = Object.fromEntries(
    Object.entries(b.expectedCategorizations).sort(([x], [y]) => x.localeCompare(y)),
  );

  const ledger: Ledger = {
    seed,
    period,
    transactions: sortedTransactions,
    receipts: sortedReceipts,
    approvals: sortedApprovals,
  };
  const groundTruth: GroundTruth = {
    seed,
    period,
    expectedCategorizations: sortedExpectedCategorizations,
    plantedDefects: sortedDefects,
  };

  return { ledger, groundTruth };
}

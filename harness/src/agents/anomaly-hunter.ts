/**
 * The anomaly hunter.
 *
 * The deterministic pre-pass has already found the FX mismatches, receipt
 * discrepancies, policy breaches, price jumps, and recurring gaps — 76% of
 * the benchmark's planted defects, exactly, for zero tokens. Those arrive
 * here as findings, not questions.
 *
 * The model is invoked for the two things arithmetic provably cannot do:
 *
 *   1. decide whether a duplicate CANDIDATE is a real double charge
 *   2. merge vendor aliases, where one merchant bills under several
 *      descriptors and one brand can span several merchants
 *
 * This split is the architecture's central claim in miniature. If the model
 * were asked to find policy breaches too, the run would cost several times
 * as much and score worse.
 */
import { detectAll, describeRule, type AnomalyCandidates } from '../domain/detectors.js';
import type { Ledger, TxnId } from '../domain/ledger.js';
import { exactDuplicateCandidates, recurringGaps } from '../domain/queries.js';
import { assertGranted } from '../tools/dispatch.js';
import { runLoop, type AuditEntry, type RunBudget } from '../loop/run.js';
import { addUsage, emptyUsage, type ModelClient, type Usage } from '../model/client.js';
import {
  buildAnomalyTools,
  type AnomalySink,
  type DuplicateVerdict,
  type VendorAliasGroup,
} from '../tools/anomaly-tools.js';

export const ANOMALY_MAX_TOKENS = 16_384;

export const ANOMALY_SYSTEM = `You are a forensic accountant reviewing a month-end close.

A deterministic pass has ALREADY found every FX mismatch, receipt
discrepancy, policy breach, price jump, and missing recurring charge. Those
are arithmetic and they are settled. Do not look for them.

You are here for the two judgments arithmetic cannot make.

1. DUPLICATE CANDIDATES

You will be given groups of transactions that share vendor, date, and
amount exactly. That is suspicious, not conclusive:

  - A $4.50 coffee bought twice on one day is two coffees.
  - A $96.00 SaaS seat charged twice on the same day is almost certainly a
    double charge.
  - Small, frequent, consumer-ish amounts repeat legitimately. Large,
    round, subscription-shaped amounts do not.

Give a verdict for EVERY candidate. Being wrong in either direction is
costly: a missed double charge is money lost, and a false accusation makes
the whole report untrustworthy.

2. VENDOR ALIASES

Card processors mangle merchant names. The same business appears as
"AMZN Mktp US*2K4LM9XY3" and "AMAZON BUSINESS"; the same product line
appears with a different numeric suffix on every charge.

But a shared brand is not a shared vendor. "UBER *TRIP" is a taxi ride and
"UBER *EATS" is a restaurant delivery — different businesses, different
accounting treatment, and merging them corrupts the books. The same is true
of "GOOGLE *CLOUD" (infrastructure) versus "GOOGLE *WORKSPACE" (software)
versus "GOOGLE ADS" (marketing).

Group only what is genuinely one merchant. Omit anything appearing under a
single descriptor.

PROCESS

Call get_duplicate_candidates and get_vendor_descriptors, then call
confirm_duplicates once and propose_vendor_aliases once. Then stop.`;

export interface Finding {
  readonly kind: string;
  readonly txnIds: readonly TxnId[];
  readonly summary: string;
  /** Cents at stake, used to rank. Null when not a money amount. */
  readonly materialityCents: number | null;
  readonly source: 'deterministic' | 'model';
  /** Set for findings about a bank row that has no ledger counterpart. */
  readonly bankId?: string;
}

export interface AnomalyHunterResult {
  readonly findings: readonly Finding[];
  readonly candidates: AnomalyCandidates;
  readonly duplicateVerdicts: readonly DuplicateVerdict[];
  readonly aliasGroups: readonly VendorAliasGroup[];
  readonly usage: Usage;
  readonly turns: number;
  readonly audit: readonly AuditEntry[];
  readonly maxTokensHits: number;
}

export interface AnomalyHunterOptions {
  readonly client: ModelClient;
  readonly ledger: Ledger;
  readonly period: string;
  readonly glCodeFor?: (txnId: TxnId) => string | undefined;
  readonly budget?: RunBudget;
  readonly runId?: string;
}

/** Everything the deterministic pass produces, as findings rather than questions. */
export function deterministicFindings(
  ledger: Ledger,
  period: string,
  candidates: AnomalyCandidates,
): Finding[] {
  const out: Finding[] = [];

  for (const f of candidates.fxMismatches) {
    out.push({
      kind: 'fxMismatch',
      txnIds: [f.txnId],
      summary:
        `${f.vendorDescriptor}: ${f.currency} ${(f.originalAmountCents / 100).toFixed(2)} at `
        + `${f.fxRate} should post ${(f.expectedAmountCents / 100).toFixed(2)}, posted `
        + `${(f.actualAmountCents / 100).toFixed(2)} — off by ${f.deltaCents}c.`,
      materialityCents: Math.abs(f.deltaCents),
      source: 'deterministic',
    });
  }

  for (const f of candidates.receiptMismatches) {
    out.push({
      kind: 'receiptMismatch',
      txnIds: [f.txnId],
      summary:
        `${f.vendorDescriptor}: receipt ${(f.receiptTotalCents / 100).toFixed(2)} vs charge `
        + `${(f.transactionAmountCents / 100).toFixed(2)} — off by ${f.deltaCents}c.`,
      materialityCents: Math.abs(f.deltaCents),
      source: 'deterministic',
    });
  }

  for (const f of candidates.policyViolations) {
    out.push({
      kind: 'policyViolation',
      txnIds: [f.txnId],
      summary:
        `${f.vendorDescriptor} charged ${(f.amountCents / 100).toFixed(2)} with no approval on `
        + `file. Breaches "${f.rule}": ${describeRule(f.rule)}`,
      materialityCents: f.overageCents,
      source: 'deterministic',
    });
  }

  for (const f of candidates.priceAnomalies) {
    out.push({
      kind: 'priceAnomaly',
      txnIds: [f.txnId],
      summary:
        `${f.vendorDescriptor} moved ${(f.percentChange * 100).toFixed(0)}% month-over-month: `
        + `${(f.priorAmountCents / 100).toFixed(2)} to ${(f.currentAmountCents / 100).toFixed(2)}.`,
      materialityCents: Math.abs(f.currentAmountCents - f.priorAmountCents),
      source: 'deterministic',
    });
  }

  for (const gap of recurringGaps(ledger, period)) {
    out.push({
      kind: 'missingRecurring',
      txnIds: [gap.lastTxnId],
      summary:
        `${gap.vendorDescriptor} billed in ${gap.priorMonths.join(' and ')} but not in ${period}. `
        + `Last charge ${(gap.lastAmountCents / 100).toFixed(2)} — propose an accrual or confirm cancellation.`,
      materialityCents: gap.lastAmountCents,
      source: 'deterministic',
    });
  }

  return out;
}

export async function runAnomalyHunter(
  options: AnomalyHunterOptions,
): Promise<AnomalyHunterResult> {
  const { ledger, period } = options;
  const candidates = detectAll(ledger, period, options.glCodeFor);
  const duplicateCandidates = exactDuplicateCandidates(ledger);

  const sink: AnomalySink = { duplicateVerdicts: [], aliasGroups: [] };
  const tools = buildAnomalyTools(ledger, duplicateCandidates, sink);
  // Fails loudly if someone hands this agent a tool it may not hold. The
  // filter version is silent, which is right at runtime and wrong here:
  // quietly dropping a needed tool produces an agent that mysteriously
  // cannot do its job.
  assertGranted('anomalyHunter', tools);

  const result = await runLoop({
    client: options.client,
    system: ANOMALY_SYSTEM,
    initialMessage:
      `Review the close for ${period}.\n\n`
      + `The deterministic pass already produced ${
        candidates.fxMismatches.length
        + candidates.receiptMismatches.length
        + candidates.policyViolations.length
        + candidates.priceAnomalies.length
      } settled findings. Your work is the ${duplicateCandidates.length} duplicate candidate(s) `
      + `and the vendor descriptors. Start by fetching both.`,
    tools,
    maxTokensPerCall: ANOMALY_MAX_TOKENS,
    ...(options.budget ? { budget: options.budget } : {}),
    runId: options.runId ?? 'run_local',
  });

  const findings = deterministicFindings(ledger, period, candidates);

  for (const verdict of sink.duplicateVerdicts) {
    if (!verdict.isDuplicate) continue;
    const first = verdict.txnIds[0];
    const txn = ledger.transactions.find((t) => t.id === first);
    findings.push({
      kind: 'duplicate',
      txnIds: verdict.txnIds,
      summary: `${txn?.vendorDescriptor ?? 'Vendor'} charged ${verdict.txnIds.length} times: ${verdict.rationale}`,
      materialityCents: txn ? txn.amountCents * (verdict.txnIds.length - 1) : null,
      source: 'model',
    });
  }

  const descriptorToTxns = new Map<string, TxnId[]>();
  for (const t of ledger.transactions) {
    const existing = descriptorToTxns.get(t.vendorDescriptor);
    if (existing) existing.push(t.id);
    else descriptorToTxns.set(t.vendorDescriptor, [t.id]);
  }
  for (const group of sink.aliasGroups) {
    const txnIds = group.descriptors.flatMap((d) => descriptorToTxns.get(d) ?? []);
    findings.push({
      kind: 'vendorAlias',
      txnIds,
      summary: `${group.canonicalVendor}: ${group.descriptors.join(' + ')} — ${group.rationale}`,
      materialityCents: null,
      source: 'model',
    });
  }

  // Biggest money first. A findings list nobody can triage is a findings
  // list nobody reads.
  findings.sort((a, b) => (b.materialityCents ?? -1) - (a.materialityCents ?? -1));

  return {
    findings,
    candidates,
    duplicateVerdicts: sink.duplicateVerdicts,
    aliasGroups: sink.aliasGroups,
    usage: result.usage,
    turns: result.turns,
    audit: result.audit,
    maxTokensHits: result.stopReason === 'max_tokens' ? 1 : 0,
  };
}

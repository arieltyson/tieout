/**
 * The reconciler.
 *
 * The deterministic pass has already matched most of the month, found the
 * charges that never settled, and reported every settlement adjustment with
 * an exact delta. None of that is a question.
 *
 * The model is here for the pairings arithmetic cannot resolve: a vendor
 * charging the same amount twice inside the settlement window produces two
 * plausible pairings and no way to choose between them by number alone. A
 * person resolves that by looking at what the merchant is and when the
 * charge happened, which is judgment.
 */
import type { Ledger, TxnId } from '../domain/ledger.js';
import { reconcile, reconciliationRate, type Reconciliation } from '../domain/reconcile.js';
import { runLoop, type AuditEntry, type RunBudget } from '../loop/run.js';
import { emptyUsage, type ModelClient, type Usage } from '../model/client.js';
import { assertGranted } from '../tools/dispatch.js';
import { buildReconcilerTools, type ReconcilerSink } from '../tools/reconciler-tools.js';
import type { Finding } from './anomaly-hunter.js';

export const RECONCILER_MAX_TOKENS = 16_384;

export const RECONCILER_SYSTEM = `You are reconciling a card ledger against a bank statement.

Most of the month is already matched. Charges that never settled and
settlement adjustments have already been found and reported. Do not look
for them again.

You are here for the pairings that arithmetic cannot resolve.

A charge and its settlement rarely share a date, because settlement lags
authorisation by a day or three, and they never share a descriptor, because
the bank writes its own. So matching is done on amount inside a date
window, and that is ambiguous whenever a merchant charges the same amount
more than once in a week.

For each ambiguous transaction you will see the candidate bank rows. Decide
which one is the settlement, or say that you cannot tell.

Useful signals: the bank descriptor often contains a mangled fragment of
the merchant name, settlement usually follows the charge closely, and a
recurring vendor tends to settle with the same lag each time.

Saying you cannot tell is a real answer. A wrong pairing hides a charge
that never settled, which is worse than an open question.

Call resolve_pairings ONCE with a verdict for every ambiguous transaction,
then stop.`;

export interface ReconcilerResult {
  readonly reconciliation: Reconciliation;
  readonly findings: readonly Finding[];
  readonly resolved: number;
  readonly declined: number;
  readonly usage: Usage;
  readonly turns: number;
  readonly audit: readonly AuditEntry[];
  readonly maxTokensHits: number;
}

export interface ReconcilerOptions {
  readonly client: ModelClient;
  readonly ledger: Ledger;
  readonly period: string;
  readonly budget?: RunBudget;
  readonly runId?: string;
}

/** Everything the deterministic pass already knows, as findings. */
export function reconciliationFindings(result: Reconciliation): Finding[] {
  const out: Finding[] = [];

  for (const txn of result.unreconciled) {
    out.push({
      kind: 'unreconciled',
      txnIds: [txn.id],
      summary: `${txn.vendorDescriptor} for ${(txn.amountCents / 100).toFixed(2)} on ${txn.date} never settled at the bank.`,
      materialityCents: txn.amountCents,
      source: 'deterministic',
    });
  }

  for (const pair of result.amountMismatches) {
    out.push({
      kind: 'bankAmountMismatch',
      txnIds: [pair.txnId],
      summary: `Settled ${pair.deltaCents}c away from the authorised amount, ${pair.daysApart} day(s) later.`,
      materialityCents: Math.abs(pair.deltaCents),
      source: 'deterministic',
    });
  }

  for (const row of result.bankOnly) {
    out.push({
      kind: 'bankOnly',
      // No ledger counterpart by definition, which is the finding. The bank
      // id is carried so this can be scored against ground truth at all:
      // matching on transaction ids would compare two empty lists and call
      // every orphan a match for every other.
      txnIds: [],
      bankId: row.id,
      summary: `${row.descriptor} for ${(row.amountCents / 100).toFixed(2)} on ${row.postedDate} is on the statement with no matching charge.`,
      materialityCents: row.amountCents,
      source: 'deterministic',
    });
  }

  return out;
}

export async function runReconciler(options: ReconcilerOptions): Promise<ReconcilerResult> {
  const { ledger, period } = options;
  const reconciliation = reconcile(ledger, period);
  const findings = reconciliationFindings(reconciliation);

  // Nothing ambiguous means nothing for the model to do, and paying for a
  // call that can only answer "nothing" is the sort of thing that quietly
  // doubles the cost of a close.
  if (reconciliation.ambiguous.length === 0) {
    return {
      reconciliation, findings, resolved: 0, declined: 0,
      usage: emptyUsage(), turns: 0, audit: [], maxTokensHits: 0,
    };
  }

  const sink: ReconcilerSink = { verdicts: [] };
  const tools = buildReconcilerTools(ledger, reconciliation, sink);
  assertGranted('reconciler', tools);

  const result = await runLoop({
    client: options.client,
    system: RECONCILER_SYSTEM,
    initialMessage:
      `Reconciling ${period}. ${reconciliation.matched.length} of `
      + `${reconciliation.matched.length + reconciliation.ambiguous.length} matched already, `
      + `${(reconciliationRate(reconciliation) * 100).toFixed(0)} percent. `
      + `${reconciliation.ambiguous.length} need your judgement. Fetch them.`,
    tools,
    maxTokensPerCall: RECONCILER_MAX_TOKENS,
    ...(options.budget ? { budget: options.budget } : {}),
    runId: options.runId ?? 'run_local',
  });

  let resolved = 0;
  let declined = 0;
  const byId = new Map(ledger.transactions.map((t) => [t.id, t]));
  for (const verdict of sink.verdicts) {
    if (verdict.bankId === null) {
      declined += 1;
      const txn = byId.get(verdict.txnId);
      findings.push({
        kind: 'unreconciled',
        txnIds: [verdict.txnId],
        summary: `${txn?.vendorDescriptor ?? verdict.txnId}: could not be paired. ${verdict.rationale}`,
        materialityCents: txn?.amountCents ?? null,
        source: 'model',
      });
      continue;
    }
    resolved += 1;
  }

  return {
    reconciliation, findings, resolved, declined,
    usage: result.usage, turns: result.turns, audit: result.audit,
    maxTokensHits: result.stopReason === 'max_tokens' ? 1 : 0,
  };
}

export function unmatchedTxnIds(result: Reconciliation): readonly TxnId[] {
  return [...result.unreconciled.map((t) => t.id), ...result.ambiguous.map((a) => a.txnId)];
}

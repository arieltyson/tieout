/**
 * The receipt chaser.
 *
 * Finding transactions without receipts is a left join and runs in code.
 * The model is here for the question that has no arithmetic answer: of two
 * hundred missing receipts, which ones actually matter enough to chase, and
 * what should the nudge say.
 *
 * The distinction matters because chasing all of them is the same as
 * chasing none. A list of two hundred is ignored; a list of eight, ordered
 * by how much trouble each one causes at audit, gets actioned.
 *
 * This agent holds no write grant of any kind. Its job is paperwork and it
 * structurally cannot alter the books, which is asserted rather than
 * intended.
 */
import { policyRules } from '../domain/policy-rules.js';
import type { Ledger, Transaction, TxnId } from '../domain/ledger.js';
import { missingReceipts } from '../domain/queries.js';
import { runLoop, type AuditEntry, type RunBudget } from '../loop/run.js';
import { emptyUsage, type ModelClient, type Usage } from '../model/client.js';
import { assertGranted } from '../tools/dispatch.js';
import { buildReceiptChaserTools, type ChaserSink } from '../tools/receipt-chaser-tools.js';

export const CHASER_MAX_TOKENS = 8_192;

/** Below this, chasing costs more attention than the receipt is worth. */
export const MATERIALITY_FLOOR_CENTS = 2_500;

export const CHASER_SYSTEM = `You are chasing missing receipts after a month end close.

Every transaction without a receipt has already been found. That part is a
database query and it is done.

Your job is deciding which ones are worth asking about, and writing the ask.

Chasing everything is the same as chasing nothing. A list of two hundred
gets ignored; a short list ordered by how much trouble each one causes gets
actioned. Prioritise by what an auditor would care about:

  - Large amounts, because those are the ones that get questioned.
  - Charges that breach a spend policy, because those need documentation
    regardless of size.
  - Anything in a category that usually requires substantiation, such as
    meals, travel, and entertainment.
  - Recurring software charges are the lowest priority. The invoice is in
    an inbox and nobody needs a photograph of it.

Write each nudge as one sentence somebody would actually send. No greeting,
no sign off, no apology for asking.

Call request_receipts ONCE with your prioritised list, then stop.`;

export interface ReceiptChaserResult {
  readonly missing: readonly Transaction[];
  readonly requested: ChaserSink['requests'];
  readonly usage: Usage;
  readonly turns: number;
  readonly audit: readonly AuditEntry[];
  readonly maxTokensHits: number;
}

export interface ReceiptChaserOptions {
  readonly client: ModelClient;
  readonly ledger: Ledger;
  readonly period: string;
  readonly glCodeFor?: (txnId: TxnId) => string | undefined;
  readonly budget?: RunBudget;
  readonly runId?: string;
}

/**
 * The candidates worth putting in front of the model.
 *
 * Filtered by materiality in code first. Sending two hundred rows so the
 * model can ignore most of them is paying to transmit noise.
 */
export function chaseworthy(
  ledger: Ledger,
  period: string,
  glCodeFor: (txnId: TxnId) => string | undefined = () => undefined,
): readonly Transaction[] {
  const approved = new Set(ledger.approvals);
  return missingReceipts(ledger)
    .filter((t) => t.date.startsWith(`${period}-`))
    .filter((t) => {
      if (t.amountCents >= MATERIALITY_FLOOR_CENTS) return true;
      // Small, but a policy breach needs documentation whatever its size.
      const glCode = glCodeFor(t.id);
      return policyRules.some(
        (rule) =>
          (rule.glScope === null || rule.glScope === glCode)
          && t.amountCents > rule.thresholdCents
          && !approved.has(t.id),
      );
    })
    .sort((a, b) => b.amountCents - a.amountCents);
}

export async function runReceiptChaser(
  options: ReceiptChaserOptions,
): Promise<ReceiptChaserResult> {
  const { ledger, period } = options;
  const missing = chaseworthy(ledger, period, options.glCodeFor);

  if (missing.length === 0) {
    return {
      missing, requested: [], usage: emptyUsage(), turns: 0, audit: [], maxTokensHits: 0,
    };
  }

  const sink: ChaserSink = { requests: [] };
  const tools = buildReceiptChaserTools(ledger, missing, options.glCodeFor, sink);
  // The property worth asserting: paperwork cannot touch the books.
  assertGranted('receiptChaser', tools);

  const result = await runLoop({
    client: options.client,
    system: CHASER_SYSTEM,
    initialMessage:
      `${missing.length} transactions in ${period} have no receipt on file. `
      + 'Fetch them, decide which are worth chasing, and write the asks.',
    tools,
    maxTokensPerCall: CHASER_MAX_TOKENS,
    ...(options.budget ? { budget: options.budget } : {}),
    runId: options.runId ?? 'run_local',
  });

  return {
    missing,
    requested: sink.requests,
    usage: result.usage,
    turns: result.turns,
    audit: result.audit,
    maxTokensHits: result.stopReason === 'max_tokens' ? 1 : 0,
  };
}

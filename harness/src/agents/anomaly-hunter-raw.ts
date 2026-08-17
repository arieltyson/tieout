/**
 * The anomaly hunter with the deterministic pre-pass removed.
 *
 * This exists to be measured against the real one. The architecture claims
 * that handing a model pre-computed candidates beats asking it to search,
 * and a claim like that is worth nothing until someone builds the version
 * without it and publishes both numbers.
 *
 * The model here gets the same INFORMATION the detectors get: every
 * transaction with its currency fields, every receipt, the spend policy,
 * and the approvals list. What it does not get is the arithmetic. It has to
 * do the conversions, the comparisons, and the grouping itself.
 *
 * Kept deliberately fair. A rigged ablation is worse than none, so the
 * prompt describes all seven defect categories as precisely as the
 * detectors implement them, and the tools return the same underlying rows.
 */
import { z } from 'zod';
import { policyRules } from '../domain/policy-rules.js';
import type { Ledger, TxnId } from '../domain/ledger.js';
import { runLoop, type AuditEntry, type RunBudget } from '../loop/run.js';
import { type ModelClient, type Usage } from '../model/client.js';
import { defineTool, type ToolDefinition } from '../tools/define.js';
import type { Finding } from './anomaly-hunter.js';

/**
 * Raised from 16k after the first attempt was truncated mid report and
 * scored zero across every category. That zero was an artefact of the
 * ceiling, not a result, and publishing it would have been a lie in the
 * ablation's favour.
 */
export const RAW_MAX_TOKENS = 32_768;
const PAGE_SIZE = 100;

export const RAW_SYSTEM = `You are a forensic accountant reviewing a month-end close.

Nothing has been pre-computed for you. Read the ledger and find every
problem in it yourself.

WHAT TO LOOK FOR

1. DUPLICATE CHARGES. The same merchant, the same date, the same amount,
   billed more than once. Not every repeat is a duplicate: a cheap item
   bought twice in a day is two purchases, while a subscription charged
   twice is almost certainly an error.

2. VENDOR ALIASES. One merchant appearing under several descriptors, for
   example an order token that changes on every charge. A shared brand is
   NOT a shared vendor: a taxi ride and a food delivery under the same
   brand are different businesses.

3. CURRENCY CONVERSION ERRORS. Non USD charges carry the original amount
   and the rate applied. The posted amount must equal the original times
   the rate, rounded to the nearest cent. Report the exact difference.

4. RECEIPT DISCREPANCIES. A receipt total that does not equal the charge
   it is attached to. Report both figures.

5. CANCELLED SUBSCRIPTIONS. A merchant that billed in at least two earlier
   months and did not bill in the closing month.

6. POLICY BREACHES. A charge above a spend limit with no approval on file.
   Charges on the approvals list are authorized however large.

7. PRICE JUMPS. A recurring charge that moved more than 30 percent
   compared with the same merchant in the previous month.

PROCESS

Work through the tools rather than thinking out loud. Do not narrate your
analysis, do not restate the ledger back, and do not explain your method.
Every token spent describing what you are about to do is a token not spent
on findings.

Fetch each page of transactions, then the receipts, then the policy and
approvals. Then call report_findings. You may call it several times, in
batches of roughly twenty, which is safer than assembling one enormous
call. Keep each summary to a single short sentence.

Use the exact category names above. Precision matters as much as recall: a
report full of false alarms is one nobody reads.`;

interface RawSink {
  readonly findings: Finding[];
}

function buildRawTools(ledger: Ledger, sink: RawSink): readonly ToolDefinition[] {
  const sorted = [...ledger.transactions].sort((a, b) => a.date.localeCompare(b.date));

  const getTransactions = defineTool({
    name: 'get_transactions',
    description:
      `Every transaction across all months, ${PAGE_SIZE} at a time, oldest first. `
      + `There are ${sorted.length} in total. Non USD rows carry originalAmountCents and fxRate.`,
    input: z.object({
      page: z.number().int().nonnegative().describe('Zero based page index.'),
    }),
    grants: ['ledger:read'],
    run: ({ page }) => {
      const slice = sorted.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
      return {
        page,
        totalPages: Math.ceil(sorted.length / PAGE_SIZE),
        transactions: slice.map((t) => ({
          id: t.id,
          date: t.date,
          descriptor: t.vendorDescriptor,
          amountCents: t.amountCents,
          ...(t.currency !== 'USD'
            ? { currency: t.currency, originalAmountCents: t.originalAmountCents, fxRate: t.fxRate }
            : {}),
        })),
      };
    },
  });

  const getReceipts = defineTool({
    name: 'get_receipts',
    description: 'Every receipt on file, as a transaction id and a total.',
    input: z.object({}),
    grants: ['ledger:read'],
    run: () => ({ receipts: ledger.receipts }),
  });

  const getPolicy = defineTool({
    name: 'get_policy_and_approvals',
    description:
      'The spend rules and the list of transactions with approval already on file. A rule with a '
      + 'glScope applies only to that account; a null scope applies to every charge.',
    input: z.object({}),
    grants: ['ledger:read'],
    run: () => ({ rules: policyRules, approvedTxnIds: ledger.approvals }),
  });

  const reportFindings = defineTool({
    name: 'report_findings',
    description:
      'Report findings. Safe to call several times in batches of roughly twenty; batching beats '
      + 'one enormous call, which risks being cut off before it completes.',
    input: z.object({
      findings: z
        .array(
          z.object({
            kind: z.enum([
              'duplicate',
              'vendorAlias',
              'fxMismatch',
              'receiptMismatch',
              'missingRecurring',
              'policyViolation',
              'priceAnomaly',
            ]),
            txnIds: z.array(z.string().regex(/^txn_\d{4,}$/)).min(1),
            summary: z.string().min(1).max(240),
          }),
        )
        .min(1),
    }),
    grants: ['propose'],
    run: ({ findings }) => {
      for (const f of findings) {
        sink.findings.push({
          kind: f.kind,
          txnIds: f.txnIds,
          summary: f.summary,
          materialityCents: null,
          source: 'model',
        });
      }
      return { recorded: findings.length };
    },
  });

  return [getTransactions, getReceipts, getPolicy, reportFindings];
}

export interface RawHunterResult {
  readonly findings: readonly Finding[];
  readonly usage: Usage;
  readonly turns: number;
  readonly audit: readonly AuditEntry[];
  readonly maxTokensHits: number;
}

export interface RawHunterOptions {
  readonly client: ModelClient;
  readonly ledger: Ledger;
  readonly period: string;
  readonly budget?: RunBudget;
  readonly runId?: string;
}

export async function runRawAnomalyHunter(options: RawHunterOptions): Promise<RawHunterResult> {
  const sink: RawSink = { findings: [] };
  const tools = buildRawTools(options.ledger, sink);

  const result = await runLoop({
    client: options.client,
    system: RAW_SYSTEM,
    initialMessage:
      `Review the close for ${options.period}. The ledger holds `
      + `${options.ledger.transactions.length} transactions spanning several months. `
      + `Page through them, then report everything you find.`,
    tools,
    maxTokensPerCall: RAW_MAX_TOKENS,
    ...(options.budget ? { budget: options.budget } : {}),
    runId: options.runId ?? 'run_ablation',
  });

  return {
    findings: sink.findings,
    usage: result.usage,
    turns: result.turns,
    audit: result.audit,
    maxTokensHits: result.stopReason === 'max_tokens' ? 1 : 0,
  };
}

export function referencedTxnCount(findings: readonly Finding[]): number {
  const ids = new Set<TxnId>();
  for (const f of findings) for (const id of f.txnIds) ids.add(id);
  return ids.size;
}

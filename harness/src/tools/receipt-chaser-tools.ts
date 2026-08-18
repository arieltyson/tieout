/**
 * The receipt chaser's tools.
 *
 * Read only, entirely. There is no propose grant here and no tool that
 * writes anything: a request for a receipt is a message to a person, not a
 * change to the ledger.
 */
import { z } from 'zod';
import { getAccount } from '../domain/chart-of-accounts.js';
import type { Ledger, Transaction, TxnId } from '../domain/ledger.js';
import { defineTool, type ToolDefinition } from './define.js';

export interface ReceiptRequest {
  readonly txnId: string;
  readonly priority: 'high' | 'medium' | 'low';
  readonly nudge: string;
}

export interface ChaserSink {
  readonly requests: ReceiptRequest[];
}

export function buildReceiptChaserTools(
  ledger: Ledger,
  missing: readonly Transaction[],
  glCodeFor: ((txnId: TxnId) => string | undefined) | undefined,
  sink: ChaserSink,
): readonly ToolDefinition[] {
  const approved = new Set(ledger.approvals);
  const lookup = glCodeFor ?? (() => undefined);

  const getMissing = defineTool({
    name: 'get_missing_receipts',
    description:
      'Transactions with no receipt, largest first, already filtered to those worth considering. '
      + 'Includes the account each was categorized to and whether it had prior spend approval.',
    input: z.object({}),
    grants: ['ledger:read'],
    run: () => ({
      transactions: missing.slice(0, 40).map((t) => {
        const glCode = lookup(t.id);
        return {
          txnId: t.id,
          date: t.date,
          descriptor: t.vendorDescriptor,
          amountCents: t.amountCents,
          glCode: glCode ?? null,
          account: glCode ? (getAccount(glCode)?.name ?? null) : null,
          preApproved: approved.has(t.id),
        };
      }),
    }),
  });

  const requestReceipts = defineTool({
    name: 'request_receipts',
    description:
      'Your prioritised list. Include only what is genuinely worth asking about: a list of two '
      + 'hundred gets ignored, a list of eight gets actioned.',
    input: z.object({
      requests: z.array(z.object({
        txnId: z.string().regex(/^txn_\d{4,}$/),
        priority: z.enum(['high', 'medium', 'low']),
        nudge: z.string().min(1).max(200),
      })).min(1),
    }),
    grants: ['ledger:read'],
    run: ({ requests }) => {
      const known = new Set(missing.map((t) => t.id));
      for (const r of requests) {
        // Asking somebody for a receipt they already filed, or for a
        // transaction that does not exist, destroys trust in the whole list.
        if (!known.has(r.txnId)) throw new Error(`${r.txnId} is not missing a receipt`);
        sink.requests.push(r);
      }
      return { recorded: requests.length };
    },
  });

  return [getMissing, requestReceipts];
}

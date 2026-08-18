/**
 * The reconciler's tools.
 *
 * There is no `match_transactions` tool. Matching on amount inside a date
 * window is arithmetic and runs in the pre-pass. The model is handed the
 * pairings that arithmetic could not resolve, and nothing else.
 */
import { z } from 'zod';
import type { Ledger } from '../domain/ledger.js';
import type { Reconciliation } from '../domain/reconcile.js';
import { defineTool, type ToolDefinition } from './define.js';

export interface PairingVerdict {
  readonly txnId: string;
  /** The chosen settlement, or null for "cannot tell". */
  readonly bankId: string | null;
  readonly rationale: string;
}

export interface ReconcilerSink {
  readonly verdicts: PairingVerdict[];
}

export function buildReconcilerTools(
  ledger: Ledger,
  reconciliation: Reconciliation,
  sink: ReconcilerSink,
): readonly ToolDefinition[] {
  const bankById = new Map(ledger.bankTransactions.map((b) => [b.id, b]));
  const txnById = new Map(ledger.transactions.map((t) => [t.id, t]));

  const getAmbiguous = defineTool({
    name: 'get_ambiguous_pairings',
    description:
      'Transactions whose settlement could not be determined by amount and date alone, each with '
      + 'its candidate bank rows. These are the only ones needing a decision.',
    input: z.object({}),
    grants: ['ledger:read'],
    run: () => ({
      pairings: reconciliation.ambiguous.slice(0, 60).map((a) => {
        const txn = txnById.get(a.txnId);
        return {
          txnId: a.txnId,
          descriptor: a.vendorDescriptor,
          date: txn?.date ?? null,
          amountCents: a.amountCents,
          candidates: a.candidateBankIds.map((id) => {
            const row = bankById.get(id);
            return row
              ? { bankId: row.id, postedDate: row.postedDate, descriptor: row.descriptor, amountCents: row.amountCents }
              : { bankId: id, postedDate: null, descriptor: null, amountCents: null };
          }),
        };
      }),
    }),
  });

  const resolvePairings = defineTool({
    name: 'resolve_pairings',
    description:
      'Record a verdict for every ambiguous transaction. Set bankId to null when you genuinely '
      + 'cannot tell, which is a real answer: a wrong pairing hides a charge that never settled.',
    input: z.object({
      verdicts: z.array(z.object({
        txnId: z.string().regex(/^txn_\d{4,}$/),
        bankId: z.string().regex(/^bank_\d{4,}$/).nullable(),
        rationale: z.string().min(1).max(200),
      })).min(1),
    }),
    grants: ['propose'],
    run: ({ verdicts }) => {
      for (const v of verdicts) {
        if (!txnById.has(v.txnId)) throw new Error(`Unknown transaction ${v.txnId}`);
        if (v.bankId !== null && !bankById.has(v.bankId)) {
          // A hallucinated bank id would silently reconcile a charge
          // against a settlement that does not exist.
          throw new Error(`Unknown bank row ${v.bankId}`);
        }
        sink.verdicts.push(v);
      }
      return { recorded: verdicts.length };
    },
  });

  return [getAmbiguous, resolvePairings];
}

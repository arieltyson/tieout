/**
 * The minimal tool surface a categorizer needs.
 *
 * Deliberately small. Every tool here is one the categorizer actually
 * calls; the fuller read/compute suites in the plan get built when an
 * agent exists that needs them, not in anticipation.
 */
import { z } from 'zod';
import { chartOfAccounts } from '../domain/chart-of-accounts.js';
import type { Ledger } from '../domain/ledger.js';
import { byVendor } from '../domain/queries.js';
import { defineTool, type ToolDefinition } from './define.js';

export interface CategorizationRecord {
  readonly txnId: string;
  readonly glCode: string;
  readonly rationale: string;
  readonly confidence: 'high' | 'medium' | 'low';
  readonly toolCallSeq: number;
}

/** Collects what the agent proposes. Owned by the run, not by the tools. */
export interface CategorizerSink {
  readonly categorizations: CategorizationRecord[];
}

const ConfidenceSchema = z.enum(['high', 'medium', 'low']);

export function buildCategorizerTools(
  ledger: Ledger,
  sink: CategorizerSink,
): readonly ToolDefinition[] {
  const getChartOfAccounts = defineTool({
    name: 'get_chart_of_accounts',
    description:
      'List every valid GL account with its code, name, and type. Categorizations must use a code from this list.',
    input: z.object({}),
    grants: ['ledger:read'],
    run: () => ({ accounts: chartOfAccounts }),
  });

  const getVendorHistory = defineTool({
    name: 'get_vendor_history',
    description:
      'Past transactions whose merchant descriptor matches EXACTLY. Descriptors are not normalized: '
      + '"UBER *TRIP" and "UBER *EATS" are different vendors here even though they share a brand.',
    input: z.object({
      vendorDescriptor: z.string().min(1).describe('The exact descriptor string to look up.'),
    }),
    grants: ['ledger:read'],
    run: ({ vendorDescriptor }) => {
      const matches = byVendor(ledger, vendorDescriptor);
      return {
        vendorDescriptor,
        count: matches.length,
        transactions: matches.slice(0, 20).map((t) => ({
          id: t.id,
          date: t.date,
          amountCents: t.amountCents,
        })),
      };
    },
  });

  const proposeCategorizations = defineTool({
    name: 'propose_categorizations',
    description:
      'Record GL codes for a batch of transactions. Does not mutate anything — it appends proposals '
      + 'that are verified and then approved by a human. Call once per batch with every transaction '
      + 'you were given. Use 6900 (Uncategorized) only when the descriptor genuinely does not '
      + 'identify a category; over-using it counts as failing to do the job.',
    input: z.object({
      categorizations: z
        .array(
          z.object({
            txnId: z.string().regex(/^txn_\d{4,}$/),
            glCode: z.string().regex(/^\d{4}$/),
            rationale: z.string().min(1).max(200),
            confidence: ConfidenceSchema,
          }),
        )
        .min(1),
    }),
    grants: ['propose'],
    run: ({ categorizations }, ctx) => {
      for (const c of categorizations) {
        sink.categorizations.push({ ...c, toolCallSeq: ctx.seq });
      }
      return { recorded: categorizations.length };
    },
  });

  return [getChartOfAccounts, getVendorHistory, proposeCategorizations];
}

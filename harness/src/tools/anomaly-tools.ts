/**
 * The anomaly hunter's tool surface.
 *
 * Note what is absent: there is no `find_duplicates` tool and no
 * `check_policy` tool. Those are `GROUP BY` and a comparison, they run in
 * the deterministic pre-pass, and asking a model to do them would be
 * slower, costlier, and less accurate.
 *
 * The model is handed candidates and asked for the two things arithmetic
 * cannot decide: whether a candidate duplicate is a real double charge, and
 * which distinct descriptors are the same vendor.
 */
import { z } from 'zod';
import type { Ledger } from '../domain/ledger.js';
import { exactDuplicateCandidates, type DuplicateCandidate } from '../domain/queries.js';
import { defineTool, type ToolDefinition } from './define.js';

export interface DuplicateVerdict {
  readonly txnIds: readonly string[];
  readonly isDuplicate: boolean;
  readonly confidence: 'high' | 'medium' | 'low';
  readonly rationale: string;
}

export interface VendorAliasGroup {
  readonly canonicalVendor: string;
  readonly descriptors: readonly string[];
  readonly rationale: string;
}

export interface AnomalySink {
  readonly duplicateVerdicts: DuplicateVerdict[];
  readonly aliasGroups: VendorAliasGroup[];
}

/** Descriptors seen more than once, or that look like a known parent brand. */
function distinctDescriptors(ledger: Ledger): { descriptor: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const t of ledger.transactions) {
    counts.set(t.vendorDescriptor, (counts.get(t.vendorDescriptor) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([descriptor, count]) => ({ descriptor, count }))
    .sort((a, b) => a.descriptor.localeCompare(b.descriptor));
}

export function buildAnomalyTools(
  ledger: Ledger,
  candidates: readonly DuplicateCandidate[],
  sink: AnomalySink,
): readonly ToolDefinition[] {
  const txnById = new Map(ledger.transactions.map((t) => [t.id, t]));

  const getDuplicateCandidates = defineTool({
    name: 'get_duplicate_candidates',
    description:
      'Groups of transactions sharing vendor, date, and amount exactly. These are CANDIDATES '
      + 'found by a deterministic query, not verdicts — two identical coffees on one day look '
      + 'the same as a double charge. Your job is to decide which is which.',
    input: z.object({}),
    grants: ['ledger:read'],
    run: () => ({
      candidates: candidates.map((c) => ({
        txnIds: c.txnIds,
        vendorDescriptor: c.vendorDescriptor,
        date: c.date,
        amountCents: c.amountCents,
      })),
    }),
  });

  const getVendorDescriptors = defineTool({
    name: 'get_vendor_descriptors',
    description:
      'Every distinct merchant descriptor in the period with its transaction count. Descriptors '
      + 'are raw card-processor strings and are never normalized by the system, because deciding '
      + 'two descriptors are one vendor is a judgment call.',
    input: z.object({}),
    grants: ['ledger:read'],
    run: () => ({ descriptors: distinctDescriptors(ledger) }),
  });

  const confirmDuplicates = defineTool({
    name: 'confirm_duplicates',
    description:
      'Record a verdict for every candidate you were given. Set isDuplicate false for legitimate '
      + 'repeat purchases — a coffee bought twice, a per-seat charge billed per person. Call once '
      + 'with all candidates.',
    input: z.object({
      verdicts: z
        .array(
          z.object({
            txnIds: z.array(z.string().regex(/^txn_\d{4,}$/)).min(2),
            isDuplicate: z.boolean(),
            confidence: z.enum(['high', 'medium', 'low']),
            rationale: z.string().min(1).max(200),
          }),
        )
        .min(1),
    }),
    grants: ['propose'],
    run: ({ verdicts }) => {
      for (const v of verdicts) {
        // Silently accepting a verdict about a transaction that does not
        // exist would let a hallucinated id into the findings.
        const unknown = v.txnIds.filter((id) => !txnById.has(id));
        if (unknown.length > 0) {
          throw new Error(`Unknown transaction id(s): ${unknown.join(', ')}`);
        }
        sink.duplicateVerdicts.push(v);
      }
      return { recorded: verdicts.length };
    },
  });

  const proposeVendorAliases = defineTool({
    name: 'propose_vendor_aliases',
    description:
      'Group descriptors that are the same real vendor under one canonical name. Only group what '
      + 'is genuinely one merchant: "UBER *TRIP" and "UBER *EATS" share a brand but are different '
      + 'businesses with different accounting treatment, so they must NOT be merged. Omit vendors '
      + 'that appear under a single descriptor.',
    input: z.object({
      groups: z
        .array(
          z.object({
            canonicalVendor: z.string().min(1).max(60),
            descriptors: z.array(z.string().min(1)).min(2),
            rationale: z.string().min(1).max(200),
          }),
        )
        .min(1),
    }),
    grants: ['propose'],
    run: ({ groups }) => {
      for (const g of groups) sink.aliasGroups.push(g);
      return { recorded: groups.length };
    },
  });

  return [getDuplicateCandidates, getVendorDescriptors, confirmDuplicates, proposeVendorAliases];
}

export { exactDuplicateCandidates };

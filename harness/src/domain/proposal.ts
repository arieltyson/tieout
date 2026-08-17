/**
 * Proposals: the only thing an agent can produce.
 *
 * Nothing in this system mutates a ledger. An agent's entire output surface
 * is a list of proposals, each of which must survive the verifier bank and
 * then a human before it means anything.
 *
 * Schemas are the source of truth and the TypeScript types are derived from
 * them, not the reverse — two hand-maintained declarations of the same shape
 * drift, and the one that drifts silently is always the runtime check.
 */
import { z } from 'zod';
import { GlCodeSchema, PeriodSchema, TxnIdSchema, type TxnId } from './ledger.js';
import { PositiveCentsSchema } from './money.js';

export const ProposalIdSchema = z.string().min(1);
export type ProposalId = z.infer<typeof ProposalIdSchema>;

export const RunIdSchema = z.string().min(1);
export type RunId = z.infer<typeof RunIdSchema>;

export const AgentKindSchema = z.enum([
  'orchestrator',
  'categorizer',
  'reconciler',
  'anomalyHunter',
  'receiptChaser',
]);
export type AgentKind = z.infer<typeof AgentKindSchema>;

export const ConfidenceSchema = z.enum(['high', 'medium', 'low']);
export type Confidence = z.infer<typeof ConfidenceSchema>;

/**
 * A reference into the audit log. Every claim traces back to a tool call
 * that actually ran — `evidence_present` exists to make "the model asserted
 * it" an unacceptable justification.
 */
export const ToolCallRefSchema = z.object({
  runId: RunIdSchema,
  seq: z.number().int().nonnegative(),
});
export type ToolCallRef = z.infer<typeof ToolCallRefSchema>;

export const ProposalKindSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('categorize'), txnId: TxnIdSchema, glCode: GlCodeSchema }),
  z.object({ type: z.literal('flagDuplicate'), txnIds: z.tuple([TxnIdSchema, TxnIdSchema]) }),
  z.object({
    type: z.literal('accrue'),
    vendor: z.string().min(1),
    amount: PositiveCentsSchema,
    period: PeriodSchema,
  }),
  z.object({ type: z.literal('flagPolicy'), txnId: TxnIdSchema, rule: z.string().min(1) }),
  z.object({ type: z.literal('requestReceipt'), txnId: TxnIdSchema }),
]);
export type ProposalKind = z.infer<typeof ProposalKindSchema>;

export const ProposalSchema = z.object({
  id: ProposalIdSchema,
  runId: RunIdSchema,
  sourceAgent: AgentKindSchema,
  kind: ProposalKindSchema,
  /**
   * Deliberately NOT `.min(1)`. An evidence-free proposal has to be
   * representable, or the `evidence_present` verifier could never be handed
   * one to reject and would be untestable theatre. The schema models what an
   * agent can emit; the bank decides what is acceptable.
   */
  evidence: z.array(ToolCallRefSchema),
  confidence: ConfidenceSchema,
  idempotencyKey: z.string().min(1),
  rationale: z.string().min(1),
});
export type Proposal = z.infer<typeof ProposalSchema>;

/**
 * Every txnId a proposal touches, regardless of kind. Used by
 * `no_orphan_references` and `no_double_categorization` so neither has to
 * re-walk the discriminated union and neither can forget a variant when a
 * new proposal kind is added.
 */
export function referencedTxnIds(kind: ProposalKind): readonly TxnId[] {
  switch (kind.type) {
    case 'categorize':
      return [kind.txnId];
    case 'flagDuplicate':
      return kind.txnIds;
    case 'flagPolicy':
      return [kind.txnId];
    case 'requestReceipt':
      return [kind.txnId];
    case 'accrue':
      // An accrual is for a charge that never arrived — there is no
      // transaction to reference, which is the entire point of it.
      return [];
    default: {
      const exhaustive: never = kind;
      throw new Error(`Unhandled proposal kind: ${JSON.stringify(exhaustive)}`);
    }
  }
}

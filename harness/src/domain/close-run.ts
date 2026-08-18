/**
 * The CloseRun artifact — the contract between the harness and the iOS app.
 *
 * This is the ONLY shape the client observes. It is versioned, flat enough
 * to decode without ceremony, and deliberately free of anything the UI does
 * not render: no raw ledger rows, no audit payloads, no ground truth.
 *
 * The Zod schema here is the source of truth. The Swift mirror in
 * ios/Tieout/Sources/TieoutCore is checked against a real emitted artifact
 * by a decode test, so drift fails a build rather than surfacing as an
 * empty screen on a device.
 */
import { z } from 'zod';

/**
 * Bumped to 2 when findings joined the artifact.
 *
 * The client pins this with a literal rather than accepting anything it can
 * partially decode. An artifact of the wrong shape should fail loudly at the
 * decode rather than render as a screen that is quietly missing a section.
 */
export const SCHEMA_VERSION = 2;

export const RunStateSchema = z.enum([
  'planning',
  'dispatched',
  'verifying',
  'awaitingApproval',
  'applying',
  'complete',
  'failed',
]);
export type RunState = z.infer<typeof RunStateSchema>;

export const AgentStatusSchema = z.object({
  agent: z.string(),
  state: z.enum(['pending', 'running', 'complete', 'failed']),
  /** Short human-readable line for the Live Activity row. */
  detail: z.string(),
});
export type AgentStatus = z.infer<typeof AgentStatusSchema>;

export const ProposalViewSchema = z.object({
  id: z.string(),
  kind: z.string(),
  txnId: z.string().nullable(),
  /** Merchant descriptor, already truncated for display. */
  vendorDescriptor: z.string().nullable(),
  amountCents: z.number().int().nullable(),
  glCode: z.string().nullable(),
  glName: z.string().nullable(),
  confidence: z.enum(['high', 'medium', 'low']),
  rationale: z.string(),
  /** Set when the verifier bank rejected it; null when it passed. */
  blockedBy: z.string().nullable(),
});
export type ProposalView = z.infer<typeof ProposalViewSchema>;

/**
 * An anomaly the run surfaced.
 *
 * `source` is the field that matters and is why this is not folded into
 * ProposalView. A finding produced by arithmetic is a fact and a reviewer
 * should treat it as one. A finding produced by the model is a judgement
 * call that a human is being asked to confirm, and the two must not look
 * alike on screen.
 */
export const FindingViewSchema = z.object({
  kind: z.string(),
  /** Empty for bank-only rows, which reference a bank row and no ledger row. */
  txnIds: z.array(z.string()),
  summary: z.string(),
  /** Null when the finding has no single dollar figure attached. */
  materialityCents: z.number().int().nullable(),
  source: z.enum(['deterministic', 'model']),
});
export type FindingView = z.infer<typeof FindingViewSchema>;

export const VerifierResultViewSchema = z.object({
  verifier: z.string(),
  passed: z.boolean(),
  isDeterministic: z.boolean(),
  detail: z.string().nullable(),
  offendingCount: z.number().int().nonnegative(),
});
export type VerifierResultView = z.infer<typeof VerifierResultViewSchema>;

export const RunSummarySchema = z.object({
  transactions: z.number().int().nonnegative(),
  categorized: z.number().int().nonnegative(),
  needsReview: z.number().int().nonnegative(),
  blocked: z.number().int().nonnegative(),
  hasBlockingFailure: z.boolean(),
  escapeHatchCount: z.number().int().nonnegative(),
  /** Null unless the run was scored against a ground-truth manifest. */
  accuracy: z.number().nullable(),
});
export type RunSummary = z.infer<typeof RunSummarySchema>;

export const RunCostSchema = z.object({
  turns: z.number().int().nonnegative(),
  batches: z.number().int().nonnegative(),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  cachedReadTokens: z.number().int().nonnegative(),
  costUsd: z.number().nullable(),
  wallClockMs: z.number().int().nonnegative(),
});
export type RunCost = z.infer<typeof RunCostSchema>;

export const CloseRunSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  runId: z.string().min(1),
  period: z.string().regex(/^\d{4}-\d{2}$/),
  state: RunStateSchema,
  startedAt: z.string(),
  finishedAt: z.string(),
  model: z.string(),
  /** True when the run used a scripted client and spent nothing. */
  dryRun: z.boolean(),
  summary: RunSummarySchema,
  cost: RunCostSchema,
  agents: z.array(AgentStatusSchema),
  verifiers: z.array(VerifierResultViewSchema),
  proposals: z.array(ProposalViewSchema),
  findings: z.array(FindingViewSchema),
});
export type CloseRun = z.infer<typeof CloseRunSchema>;

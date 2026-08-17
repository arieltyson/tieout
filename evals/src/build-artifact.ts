/**
 * Assembles the CloseRun artifact the iOS client consumes.
 *
 * Kept separate from close.ts so the shape is built in one place and can be
 * schema-validated before it ever reaches disk. An artifact that fails its
 * own schema is a build error here rather than a blank screen on a device.
 */
import { getAccount } from '../../harness/src/domain/chart-of-accounts.js';
import type { BankResult } from '../../harness/src/domain/bank.js';
import {
  CloseRunSchema,
  SCHEMA_VERSION,
  type CloseRun,
  type ProposalView,
} from '../../harness/src/domain/close-run.js';
import type { Ledger } from '../../harness/src/domain/ledger.js';
import type { Proposal } from '../../harness/src/domain/proposal.js';
import type { CategorizerResult } from '../../harness/src/agents/categorizer.js';
import type { CategorizationScore } from './score.js';

const MAX_DESCRIPTOR = 40;

export interface BuildArtifactInput {
  readonly runId: string;
  readonly period: string;
  readonly model: string;
  readonly dryRun: boolean;
  readonly ledger: Ledger;
  readonly transactionCount: number;
  readonly categorizer: CategorizerResult;
  readonly proposals: readonly Proposal[];
  readonly bank: BankResult;
  readonly score: CategorizationScore | null;
  readonly costUsd: number | null;
  readonly startedAt: Date;
  readonly finishedAt: Date;
}

export function buildCloseRun(input: BuildArtifactInput): CloseRun {
  const txnById = new Map(input.ledger.transactions.map((t) => [t.id, t]));
  const blockedIds = new Set(input.bank.blocked.map((p) => p.id));

  // Which verifier named each blocked proposal, for the UI to show a reason.
  const blockedReason = new Map<string, string>();
  for (const result of input.bank.results) {
    if (result.passed) continue;
    for (const id of result.offending) {
      if (!blockedReason.has(id)) blockedReason.set(id, result.verifier);
    }
  }

  const proposals: ProposalView[] = input.proposals.map((p) => {
    const txnId = p.kind.type === 'categorize' ? p.kind.txnId : null;
    const glCode = p.kind.type === 'categorize' ? p.kind.glCode : null;
    const txn = txnId ? txnById.get(txnId) : undefined;
    const descriptor = txn?.vendorDescriptor ?? null;
    return {
      id: p.id,
      kind: p.kind.type,
      txnId,
      vendorDescriptor:
        descriptor === null
          ? null
          : descriptor.length > MAX_DESCRIPTOR
            ? `${descriptor.slice(0, MAX_DESCRIPTOR - 1)}…`
            : descriptor,
      amountCents: txn?.amountCents ?? null,
      glCode,
      glName: glCode ? (getAccount(glCode)?.name ?? null) : null,
      confidence: p.confidence,
      rationale: p.rationale,
      blockedBy: blockedIds.has(p.id) ? (blockedReason.get(p.id) ?? 'unknown') : null,
    };
  });

  const needsReview = proposals.filter(
    (p) => p.blockedBy === null && p.confidence !== 'high',
  ).length;

  const escapeHatchCount = proposals.filter((p) => p.glCode === '6900').length;

  const artifact: CloseRun = {
    schemaVersion: SCHEMA_VERSION,
    runId: input.runId,
    period: input.period,
    state: input.bank.hasBlockingFailure ? 'verifying' : 'awaitingApproval',
    startedAt: input.startedAt.toISOString(),
    finishedAt: input.finishedAt.toISOString(),
    model: input.model,
    dryRun: input.dryRun,
    summary: {
      transactions: input.transactionCount,
      categorized: input.categorizer.categorizations.length,
      needsReview,
      blocked: input.bank.blocked.length,
      hasBlockingFailure: input.bank.hasBlockingFailure,
      escapeHatchCount,
      accuracy: input.score ? input.score.accuracy : null,
    },
    cost: {
      turns: input.categorizer.turns,
      batches: input.categorizer.batches,
      inputTokens: input.categorizer.usage.inputTokens,
      outputTokens: input.categorizer.usage.outputTokens,
      cachedReadTokens: input.categorizer.usage.cacheReadTokens ?? 0,
      costUsd: input.costUsd,
      wallClockMs: input.finishedAt.getTime() - input.startedAt.getTime(),
    },
    agents: [
      {
        agent: 'categorizer',
        state: 'complete',
        detail: `${input.categorizer.categorizations.length} categorized in ${input.categorizer.batches} batches`,
      },
      { agent: 'reconciler', state: 'pending', detail: 'not implemented' },
      { agent: 'anomalyHunter', state: 'pending', detail: 'not implemented' },
      { agent: 'receiptChaser', state: 'pending', detail: 'not implemented' },
    ],
    verifiers: input.bank.results.map((r) => ({
      verifier: r.verifier,
      passed: r.passed,
      isDeterministic: true,
      detail: r.detail ?? null,
      offendingCount: r.offending.length,
    })),
    proposals,
  };

  const parsed = CloseRunSchema.safeParse(artifact);
  if (!parsed.success) {
    throw new Error(
      `CloseRun artifact failed its own schema — the client would not decode it:\n${parsed.error.message}`,
    );
  }
  return parsed.data;
}

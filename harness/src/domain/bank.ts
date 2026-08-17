/**
 * The verifier bank.
 *
 * Runs every verifier over a proposal set and partitions the result into
 * what may proceed, what is blocked, and what merely drew a warning.
 *
 * Two ordering rules, both load-bearing:
 *
 *  1. Deterministic verifiers run FIRST and short-circuit the inferential
 *     ones for any proposal they block. There is no sense paying a model to
 *     judge whether a categorization is sensible when the arithmetic already
 *     says it cannot be applied.
 *
 *  2. Within a tier, EVERY verifier runs. The bank never stops at the first
 *     failure. An agent told only about its first mistake fixes it,
 *     resubmits, and gets told about the next one — which burns a repair
 *     attempt per defect against a budget that allows two.
 */
import type { Ledger } from './ledger.js';
import type { Proposal, ProposalId } from './proposal.js';
import type { Verifier, VerifierResult } from './verifier.js';
import { deterministicVerifiers } from './verifiers.js';

export interface BankResult {
  /** Proposals no verifier objected to. These may go to a human. */
  readonly passed: readonly Proposal[];
  /** Proposals a deterministic verifier rejected. These may not. */
  readonly blocked: readonly Proposal[];
  /** Proposals an inferential verifier flagged but did not reject. */
  readonly warned: readonly Proposal[];
  /** Every result, passing and failing, in execution order. */
  readonly results: readonly VerifierResult[];
  /**
   * True when any deterministic verifier failed — including a batch-level
   * failure like `sums_tie` that names no individual proposal.
   *
   * Callers must gate on this rather than on `blocked.length`. A set can be
   * arithmetically broken while every individual proposal looks fine, and
   * checking the array instead would let exactly that case through.
   */
  readonly hasBlockingFailure: boolean;
  /** Detail messages from failed deterministic verifiers, for agent feedback. */
  readonly blockingReasons: readonly string[];
}

export interface RunBankOptions {
  readonly deterministic?: readonly Verifier[];
  readonly inferential?: readonly Verifier[];
}

export function runBank(
  proposals: readonly Proposal[],
  ledger: Ledger,
  options: RunBankOptions = {},
): BankResult {
  const deterministic = options.deterministic ?? deterministicVerifiers;
  const inferential = options.inferential ?? [];

  const results: VerifierResult[] = [];
  const blockedIds = new Set<ProposalId>();
  const blockingReasons: string[] = [];
  let hasBlockingFailure = false;

  for (const verifier of deterministic) {
    const result = verifier.check(proposals, ledger);
    results.push(result);
    if (result.passed) continue;

    hasBlockingFailure = true;
    if (result.detail) blockingReasons.push(`${result.verifier}: ${result.detail}`);
    for (const id of result.offending) blockedIds.add(id);
  }

  // Rule 1: inferential verifiers see only what survived the cheap tier.
  const survivors = proposals.filter((p) => !blockedIds.has(p.id));
  const warnedIds = new Set<ProposalId>();

  if (survivors.length > 0) {
    for (const verifier of inferential) {
      const result = verifier.check(survivors, ledger);
      results.push(result);
      if (result.passed) continue;
      for (const id of result.offending) {
        // A deterministic block outranks a warning; do not double-report.
        if (!blockedIds.has(id)) warnedIds.add(id);
      }
    }
  }

  return {
    passed: proposals.filter((p) => !blockedIds.has(p.id) && !warnedIds.has(p.id)),
    blocked: proposals.filter((p) => blockedIds.has(p.id)),
    warned: proposals.filter((p) => warnedIds.has(p.id)),
    results,
    hasBlockingFailure,
    blockingReasons,
  };
}

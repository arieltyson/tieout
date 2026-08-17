/**
 * The verifier interface.
 *
 * Verifiers are pure functions over `(proposals, ledger)`. No async, no I/O,
 * no model, no clock. That constraint is what makes the bank the one part of
 * this system whose correctness is fully decidable in a unit test.
 *
 * `deterministic` failures BLOCK — arithmetic that doesn't tie, a GL code
 * that doesn't exist. These are facts, and a human should never be asked to
 * approve one.
 *
 * `inferential` failures WARN — a judgment call that looked wrong. These are
 * opinions, and an opinion should not be able to silently discard an agent's
 * work.
 */
import type { Ledger } from './ledger.js';
import type { Proposal, ProposalId } from './proposal.js';

export type VerifierKind = 'deterministic' | 'inferential';

export interface VerifierResult {
  readonly verifier: string;
  readonly passed: boolean;
  /** Human-readable explanation. Required on failure, so a block is never mute. */
  readonly detail?: string;
  /**
   * Proposals this verifier holds responsible. A verifier that fails without
   * naming anyone blocks the entire batch, which is occasionally correct
   * (`sums_tie` is a property of the whole set) but is usually a bug.
   */
  readonly offending: readonly ProposalId[];
}

export interface Verifier {
  readonly name: string;
  readonly kind: VerifierKind;
  check(proposals: readonly Proposal[], ledger: Ledger): VerifierResult;
}

export function pass(verifier: string): VerifierResult {
  return { verifier, passed: true, offending: [] };
}

export function fail(
  verifier: string,
  detail: string,
  offending: readonly ProposalId[],
): VerifierResult {
  return { verifier, passed: false, detail, offending };
}

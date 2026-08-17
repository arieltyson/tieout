/**
 * The self correction cycle.
 *
 * When the verifier bank blocks a proposal, the failure is handed back to
 * the agent that produced it and it tries again. Bounded, because an agent
 * that can retry forever will retry forever, and after the bound the
 * proposal goes to a human with the verdict attached rather than being
 * silently dropped.
 *
 * The failure is delivered as ordinary agent input describing exactly what
 * broke and which proposals were named. A model told only that something
 * was wrong will guess; a model told that `gl_codes_exist` rejected code
 * 9999 on two named proposals can fix it.
 *
 * Two properties this deliberately guarantees, both easy to get wrong:
 *
 *   1. A repair that fixes nothing still terminates. Progress is not
 *      assumed, only attempted.
 *   2. A repair that makes things WORSE is discarded. Retrying is only
 *      worth doing if the result is an improvement, and an agent thrashing
 *      between two broken states should not be able to leave the batch in
 *      the worse one.
 */
import { runBank, type BankResult } from '../domain/bank.js';
import type { Ledger } from '../domain/ledger.js';
import type { Proposal } from '../domain/proposal.js';

export const DEFAULT_MAX_REPAIR_ATTEMPTS = 2;

export interface RepairAttempt {
  readonly attempt: number;
  readonly blockedBefore: number;
  readonly blockedAfter: number;
  readonly reasons: readonly string[];
  /** False when the retry did not reduce the blocked count. */
  readonly improved: boolean;
  /** True when the result was thrown away for being worse than what it replaced. */
  readonly discarded: boolean;
}

export interface RepairOutcome {
  readonly proposals: readonly Proposal[];
  readonly bank: BankResult;
  readonly attempts: readonly RepairAttempt[];
  /** Proposals still blocked once repair gave up. These go to a human. */
  readonly escalated: readonly Proposal[];
}

/**
 * Asks the agent to fix what the bank rejected.
 *
 * `retry` receives the current proposals and a description of the failures
 * and returns a replacement set. Returning the input unchanged is a valid
 * response and ends the cycle.
 */
export type RepairFn = (
  proposals: readonly Proposal[],
  feedback: string,
) => Promise<readonly Proposal[]>;

export function formatFeedback(bank: BankResult): string {
  const lines = [
    'Your proposals were rejected by the verifier bank. Fix them and resubmit.',
    '',
  ];
  for (const result of bank.results) {
    if (result.passed) continue;
    lines.push(`${result.verifier}: ${result.detail ?? 'failed'}`);
    if (result.offending.length > 0) {
      lines.push(`  affected proposals: ${result.offending.join(', ')}`);
    }
  }
  lines.push(
    '',
    'Return the full corrected set, not only the proposals you changed.',
  );
  return lines.join('\n');
}

export async function repairUntilClean(
  initial: readonly Proposal[],
  ledger: Ledger,
  retry: RepairFn,
  maxAttempts: number = DEFAULT_MAX_REPAIR_ATTEMPTS,
): Promise<RepairOutcome> {
  let proposals = initial;
  let bank = runBank(proposals, ledger);
  const attempts: RepairAttempt[] = [];

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (!bank.hasBlockingFailure) break;

    const blockedBefore = bank.blocked.length;
    const reasons = bank.blockingReasons;
    const candidate = await retry(proposals, formatFeedback(bank));
    const candidateBank = runBank(candidate, ledger);

    // Fewer blocked proposals, or a batch level failure cleared entirely.
    const improved =
      candidateBank.blocked.length < blockedBefore
      || (bank.hasBlockingFailure && !candidateBank.hasBlockingFailure);

    attempts.push({
      attempt,
      blockedBefore,
      blockedAfter: candidateBank.blocked.length,
      reasons,
      improved,
      discarded: !improved,
    });

    if (!improved) {
      // Keep the better of the two. An agent oscillating between broken
      // states must not be able to leave the batch worse than it found it.
      break;
    }

    proposals = candidate;
    bank = candidateBank;
  }

  return {
    proposals,
    bank,
    attempts,
    escalated: bank.blocked,
  };
}

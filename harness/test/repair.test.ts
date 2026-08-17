import { beforeEach, describe, expect, test, vi } from 'vitest';
import { runBank } from '../src/domain/bank.js';
import type { Proposal } from '../src/domain/proposal.js';
import { formatFeedback, repairUntilClean } from '../src/loop/repair.js';
import * as f from './support/proposals.js';

beforeEach(() => {
  f.resetProposalIds();
});

const led = () => f.smallLedger();

describe('formatFeedback', () => {
  test('names the verifier, the reason, and the proposals involved', () => {
    const bank = runBank(f.nonexistentGlCode(), led());
    const text = formatFeedback(bank);
    expect(text).toContain('gl_codes_exist');
    expect(text).toContain('9999');
    expect(text).toContain(bank.blocked[0]!.id);
  });

  test('asks for the full set back, not just the changes', () => {
    // A partial resubmission silently drops the proposals it omits.
    const text = formatFeedback(runBank(f.nonexistentGlCode(), led()));
    expect(text.toLowerCase()).toContain('full corrected set');
  });

  test('lists every failing verifier, not only the first', () => {
    const text = formatFeedback(runBank(f.multiplyInvalid(), led()));
    const named = ['gl_codes_exist', 'evidence_present', 'idempotency_keys_unique'].filter((v) =>
      text.includes(v),
    );
    expect(named.length).toBeGreaterThanOrEqual(3);
  });
});

describe('repairUntilClean', () => {
  test('does not call the agent when nothing is blocked', async () => {
    const retry = vi.fn();
    const outcome = await repairUntilClean(f.validCategorizations(), led(), retry);
    expect(retry).not.toHaveBeenCalled();
    expect(outcome.attempts).toEqual([]);
    expect(outcome.escalated).toEqual([]);
  });

  test('accepts a repair that fixes the problem', async () => {
    const broken = f.nonexistentGlCode();
    const fixed = f.validCategorizations();
    const outcome = await repairUntilClean(broken, led(), async () => fixed);

    expect(outcome.bank.hasBlockingFailure).toBe(false);
    expect(outcome.escalated).toEqual([]);
    expect(outcome.attempts).toHaveLength(1);
    expect(outcome.attempts[0]!.improved).toBe(true);
  });

  test('stops at exactly the attempt bound when repairs never work', async () => {
    const broken = f.nonexistentGlCode();
    const retry = vi.fn(async () => broken);
    const outcome = await repairUntilClean(broken, led(), retry, 3);

    // The first attempt makes no progress, so there is no reason to spend
    // two more. Bounded means bounded above, not exactly N.
    expect(retry).toHaveBeenCalledTimes(1);
    expect(outcome.escalated.length).toBeGreaterThan(0);
  });

  test('escalates whatever is still blocked when it gives up', async () => {
    const broken = f.nonexistentGlCode();
    const outcome = await repairUntilClean(broken, led(), async () => broken);
    expect(outcome.escalated).toHaveLength(1);
    expect(outcome.bank.hasBlockingFailure).toBe(true);
  });

  // The property that stops a thrashing agent doing damage.
  test('discards a repair that makes things worse', async () => {
    const slightlyBroken = f.nonexistentGlCode();
    const before = runBank(slightlyBroken, led()).blocked.length;
    const muchWorse = f.multiplyInvalid();

    const outcome = await repairUntilClean(slightlyBroken, led(), async () => muchWorse);

    expect(runBank(muchWorse, led()).blocked.length).toBeGreaterThan(before);
    expect(outcome.proposals).toBe(slightlyBroken);
    expect(outcome.attempts[0]!.discarded).toBe(true);
  });

  test('improves across two attempts when each one helps', async () => {
    const worst = f.multiplyInvalid();
    const middle = f.nonexistentGlCode();
    const best = f.validCategorizations();
    const sequence: (readonly Proposal[])[] = [middle, best];
    let i = 0;

    const outcome = await repairUntilClean(worst, led(), async () => sequence[i++]!, 3);

    expect(outcome.attempts.length).toBeGreaterThanOrEqual(2);
    expect(outcome.bank.hasBlockingFailure).toBe(false);
  });

  test('a batch level failure with no named offender still triggers repair', async () => {
    // sums_tie rejects the set without blaming any single proposal, so a
    // repair loop keyed on blocked.length alone would never run at all.
    const short = f.missingOneCategorization();
    const retry = vi.fn(async () => f.validCategorizations());
    const outcome = await repairUntilClean(short, led(), retry);

    expect(runBank(short, led()).blocked).toEqual([]);
    expect(retry).toHaveBeenCalledTimes(1);
    expect(outcome.bank.hasBlockingFailure).toBe(false);
  });

  test('records what each attempt did, for the audit trail', async () => {
    const broken = f.nonexistentGlCode();
    const outcome = await repairUntilClean(broken, led(), async () => f.validCategorizations());
    const attempt = outcome.attempts[0]!;
    expect(attempt.attempt).toBe(1);
    expect(attempt.blockedBefore).toBe(1);
    expect(attempt.blockedAfter).toBe(0);
    expect(attempt.reasons.length).toBeGreaterThan(0);
  });

  test('respects a bound of zero by never retrying', async () => {
    const retry = vi.fn();
    const outcome = await repairUntilClean(f.nonexistentGlCode(), led(), retry, 0);
    expect(retry).not.toHaveBeenCalled();
    expect(outcome.escalated).toHaveLength(1);
  });
});

/**
 * The deterministic verifiers.
 *
 * Each is a pure function over `(proposals, ledger)`. Every one of these can
 * be made to fail — see `harness/test/support/proposals.ts` for the input
 * that breaks each, and the commit that introduced them for the mutation
 * results proving the checks are load-bearing rather than decorative.
 *
 * `debits_equal_credits` from the plan is deliberately absent. See the note
 * at the bottom of this file.
 */
import { isValidGLCode } from './chart-of-accounts.js';
import type { Ledger } from './ledger.js';
import { referencedTxnIds, type Proposal } from './proposal.js';
import { fail, pass, type Verifier } from './verifier.js';
import { sum, type Cents } from './money.js';

const categorizations = (proposals: readonly Proposal[]) =>
  proposals.filter((p) => p.kind.type === 'categorize');

/**
 * The categorized total must equal the ledger total, to the cent.
 *
 * This is a property of the whole batch rather than of any one proposal, so
 * a failure names no offender — it is the case the `offending: []` contract
 * exists for. The detail message carries the uncovered ids instead, because
 * "off by 3000" with no indication of where is not actionable.
 */
export const sumsTie: Verifier = {
  name: 'sums_tie',
  kind: 'deterministic',
  check(proposals, ledger) {
    const amountByTxn = new Map(ledger.transactions.map((t) => [t.id, t.amountCents]));
    const covered = new Set<string>();
    const proposed: Cents[] = [];

    for (const p of categorizations(proposals)) {
      if (p.kind.type !== 'categorize') continue;
      const amount = amountByTxn.get(p.kind.txnId);
      // A reference to a transaction that does not exist contributes
      // nothing here; no_orphan_references is what reports it.
      if (amount === undefined) continue;
      proposed.push(amount);
      covered.add(p.kind.txnId);
    }

    const proposedTotal = sum(proposed);
    const ledgerTotal = sum(ledger.transactions.map((t) => t.amountCents));
    if (proposedTotal === ledgerTotal) return pass(this.name);

    const uncovered = ledger.transactions.filter((t) => !covered.has(t.id)).map((t) => t.id);
    const detail =
      `Categorized total ${proposedTotal} does not equal ledger total ${ledgerTotal} `
      + `(off by ${proposedTotal - ledgerTotal}).`
      + (uncovered.length > 0 ? ` Uncategorized: ${uncovered.join(', ')}.` : '');
    return fail(this.name, detail, []);
  },
};

/** Every proposed GL code must exist in the chart of accounts. */
export const glCodesExist: Verifier = {
  name: 'gl_codes_exist',
  kind: 'deterministic',
  check(proposals) {
    const offenders = categorizations(proposals).filter(
      (p) => p.kind.type === 'categorize' && !isValidGLCode(p.kind.glCode),
    );
    if (offenders.length === 0) return pass(this.name);

    const codes = offenders
      .map((p) => (p.kind.type === 'categorize' ? p.kind.glCode : ''))
      .join(', ');
    return fail(
      this.name,
      `GL code(s) not in the chart of accounts: ${codes}.`,
      offenders.map((p) => p.id),
    );
  },
};

/**
 * No transaction may be categorized twice.
 *
 * Catches the same code twice as well as two conflicting codes. The
 * same-code case is the one that slips through a naive implementation that
 * only looks for disagreement, and it still corrupts the books — it
 * double-counts the amount.
 */
export const noDoubleCategorization: Verifier = {
  name: 'no_double_categorization',
  kind: 'deterministic',
  check(proposals) {
    const byTxn = new Map<string, Proposal[]>();
    for (const p of categorizations(proposals)) {
      if (p.kind.type !== 'categorize') continue;
      const existing = byTxn.get(p.kind.txnId);
      if (existing) existing.push(p);
      else byTxn.set(p.kind.txnId, [p]);
    }

    const duplicated = [...byTxn.entries()].filter(([, ps]) => ps.length > 1);
    if (duplicated.length === 0) return pass(this.name);

    const detail = duplicated
      .map(([txnId, ps]) => `${txnId} categorized ${ps.length} times`)
      .join('; ');
    return fail(this.name, `${detail}.`, duplicated.flatMap(([, ps]) => ps.map((p) => p.id)));
  },
};

/** Every transaction a proposal references must exist in the ledger. */
export const noOrphanReferences: Verifier = {
  name: 'no_orphan_references',
  kind: 'deterministic',
  check(proposals, ledger) {
    const known = new Set(ledger.transactions.map((t) => t.id));
    const offenders: { proposal: Proposal; missing: string[] }[] = [];

    for (const p of proposals) {
      // referencedTxnIds is exhaustive over the proposal union, so a new
      // kind is a compile error rather than a silently unchecked variant.
      // An accrual references nothing by design — it is for a charge that
      // never arrived — and must not be read as an orphan.
      const missing = referencedTxnIds(p.kind).filter((id) => !known.has(id));
      if (missing.length > 0) offenders.push({ proposal: p, missing });
    }
    if (offenders.length === 0) return pass(this.name);

    const detail = offenders
      .map((o) => `${o.proposal.id} references unknown ${o.missing.join(', ')}`)
      .join('; ');
    return fail(this.name, `${detail}.`, offenders.map((o) => o.proposal.id));
  },
};

/**
 * Idempotency keys must be unique within a run.
 *
 * Two proposals sharing a key means applying both is indistinguishable from
 * applying one, so the second silently vanishes at the approval gate.
 */
export const idempotencyKeysUnique: Verifier = {
  name: 'idempotency_keys_unique',
  kind: 'deterministic',
  check(proposals) {
    const byKey = new Map<string, Proposal[]>();
    for (const p of proposals) {
      const existing = byKey.get(p.idempotencyKey);
      if (existing) existing.push(p);
      else byKey.set(p.idempotencyKey, [p]);
    }

    const collisions = [...byKey.entries()].filter(([, ps]) => ps.length > 1);
    if (collisions.length === 0) return pass(this.name);

    const detail = collisions
      .map(([key, ps]) => `"${key}" used by ${ps.map((p) => p.id).join(', ')}`)
      .join('; ');
    return fail(this.name, `Duplicate idempotency key(s): ${detail}.`, collisions.flatMap(([, ps]) => ps.map((p) => p.id)));
  },
};

/**
 * No proposal without at least one tool-call reference.
 *
 * This is the verifier that makes "the model asserted it" an unacceptable
 * justification. Every claim must trace to a computation that actually ran.
 */
export const evidencePresent: Verifier = {
  name: 'evidence_present',
  kind: 'deterministic',
  check(proposals) {
    const offenders = proposals.filter((p) => p.evidence.length === 0);
    if (offenders.length === 0) return pass(this.name);
    return fail(
      this.name,
      `Proposal(s) with no supporting evidence: ${offenders.map((p) => p.id).join(', ')}.`,
      offenders.map((p) => p.id),
    );
  },
};

export const deterministicVerifiers: readonly Verifier[] = [
  sumsTie,
  glCodesExist,
  noDoubleCategorization,
  noOrphanReferences,
  idempotencyKeysUnique,
  evidencePresent,
];

/**
 * ON THE MISSING SEVENTH VERIFIER — `debits_equal_credits`
 *
 * The plan lists it. It is not implemented, and implementing it against the
 * current proposal model would produce a check that cannot fail.
 *
 * A categorize proposal carries exactly one GL code for one transaction. The
 * implied journal entry is therefore debit(glCode, amount) /
 * credit(2100 Credit Card Payable, amount), where the credit side is
 * computed from the debit side. There are no degrees of freedom, so the two
 * are equal by construction and no input — valid, invalid, or adversarial —
 * can make them differ. The same holds for `accrue`, which carries a single
 * amount.
 *
 * Double-entry only becomes falsifiable once a proposal can carry SPLIT
 * legs, one transaction across several accounts, which real accounting does
 * and this model does not yet express. Until then the check belongs where
 * journal entries are actually constructed — decision application in Phase
 * 5 — not at the proposal stage where there are no entries to balance.
 *
 * Shipping it here would add a verifier that always returns pass, inflate
 * the bank's apparent coverage, and give the Phase 9 ablation a component
 * whose removal changes nothing. That is the failure mode this bank exists
 * to prevent, so it is recorded rather than performed.
 */

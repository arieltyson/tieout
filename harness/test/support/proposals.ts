/**
 * The invalid-proposal fixture.
 *
 * Proposals come from agents, and agents do not exist until Phase 4. Without
 * hand-built bad input, every verifier in Phase 1 would be written against
 * data that cannot make it fail — which is the same as not testing it. This
 * module is what lets the bank be exercised before anything generates a
 * proposal, and it is deliberately a peer of the verifiers rather than an
 * afterthought: each named builder below corresponds to a verifier that must
 * fire on it.
 *
 * The rule for anything added here: it must be *representable*. A defect the
 * schema already rejects is the schema's job, not the bank's, and putting it
 * here would test Zod twice while leaving the verifier untested.
 */
import { cents, type Cents } from '../../src/domain/money.js';
import type { Ledger, Transaction, TxnId } from '../../src/domain/ledger.js';
import type { Proposal, ProposalKind } from '../../src/domain/proposal.js';

let seq = 0;

/** Deterministic ids so a failure message points at a stable proposal. */
export function resetProposalIds(): void {
  seq = 0;
}

export const RUN_ID = 'run_test';

export function proposal(kind: ProposalKind, overrides: Partial<Proposal> = {}): Proposal {
  seq += 1;
  const id = `prop_${String(seq).padStart(4, '0')}`;
  return {
    id,
    runId: RUN_ID,
    sourceAgent: 'categorizer',
    kind,
    evidence: [{ runId: RUN_ID, seq }],
    confidence: 'high',
    idempotencyKey: `${id}:key`,
    rationale: 'Test proposal.',
    ...overrides,
  };
}

// --- Ledger builders ---------------------------------------------------

export function transaction(id: TxnId, amountCents: Cents, overrides: Partial<Transaction> = {}): Transaction {
  return {
    id,
    date: '2026-06-15',
    vendorDescriptor: 'TEST VENDOR',
    amountCents,
    currency: 'USD',
    originalAmountCents: null,
    fxRate: null,
    ...overrides,
  };
}

export function ledger(transactions: readonly Transaction[], overrides: Partial<Ledger> = {}): Ledger {
  return {
    seed: 1,
    period: '2026-06',
    transactions: [...transactions],
    receipts: [],
    approvals: [],
    ...overrides,
  };
}

/** A three-transaction ledger totalling 6000 cents. */
export function smallLedger(): Ledger {
  return ledger([
    transaction('txn_0001', cents(1000)),
    transaction('txn_0002', cents(2000)),
    transaction('txn_0003', cents(3000)),
  ]);
}

// --- Valid baseline ----------------------------------------------------

/**
 * A clean set covering every transaction in `smallLedger()` exactly once.
 * Every verifier must pass on this. If one fails here, it is over-strict and
 * would block honest work in production.
 */
export function validCategorizations(): Proposal[] {
  return [
    proposal({ type: 'categorize', txnId: 'txn_0001', glCode: '6010' }),
    proposal({ type: 'categorize', txnId: 'txn_0002', glCode: '6020' }),
    proposal({ type: 'categorize', txnId: 'txn_0003', glCode: '6030' }),
  ];
}

// --- Named invalid cases, one per deterministic verifier ---------------

/** `sums_tie`: categorized total (3000) ≠ ledger total (6000) — txn_0003 uncovered. */
export function missingOneCategorization(): Proposal[] {
  return [
    proposal({ type: 'categorize', txnId: 'txn_0001', glCode: '6010' }),
    proposal({ type: 'categorize', txnId: 'txn_0002', glCode: '6020' }),
  ];
}

/** `gl_codes_exist`: 9999 is not in the chart of accounts. */
export function nonexistentGlCode(): Proposal[] {
  const proposals = validCategorizations();
  proposals[0] = proposal({ type: 'categorize', txnId: 'txn_0001', glCode: '9999' });
  return proposals;
}

/** `no_double_categorization`: txn_0001 categorized twice, under different codes. */
export function doubleCategorization(): Proposal[] {
  return [
    ...validCategorizations(),
    proposal({ type: 'categorize', txnId: 'txn_0001', glCode: '6040' }),
  ];
}

/** `no_double_categorization`: the subtler case — twice under the SAME code. */
export function doubleCategorizationSameCode(): Proposal[] {
  return [
    ...validCategorizations(),
    proposal({ type: 'categorize', txnId: 'txn_0001', glCode: '6010' }),
  ];
}

/** `no_orphan_references`: txn_9999 is not in the ledger. */
export function orphanReference(): Proposal[] {
  return [
    ...validCategorizations(),
    proposal({ type: 'categorize', txnId: 'txn_9999', glCode: '6010' }),
  ];
}

/** `no_orphan_references`: one of a duplicate pair does not exist. */
export function orphanDuplicatePair(): Proposal[] {
  return [
    ...validCategorizations(),
    proposal({ type: 'flagDuplicate', txnIds: ['txn_0001', 'txn_9999'] }),
  ];
}

/** `idempotency_keys_unique`: two proposals sharing a key. */
export function collidingIdempotencyKeys(): Proposal[] {
  const proposals = validCategorizations();
  return proposals.map((p, i) => (i < 2 ? { ...p, idempotencyKey: 'same-key' } : p));
}

/** `evidence_present`: a proposal asserting something with nothing behind it. */
export function evidenceFreeProposal(): Proposal[] {
  const proposals = validCategorizations();
  return proposals.map((p, i) => (i === 0 ? { ...p, evidence: [] } : p));
}

/** Several defects at once — the bank must report all of them, not just the first. */
export function multiplyInvalid(): Proposal[] {
  return [
    proposal({ type: 'categorize', txnId: 'txn_0001', glCode: '9999' }, { evidence: [] }),
    proposal({ type: 'categorize', txnId: 'txn_0001', glCode: '6020' }, { idempotencyKey: 'dupe' }),
    proposal({ type: 'categorize', txnId: 'txn_9999', glCode: '6030' }, { idempotencyKey: 'dupe' }),
  ];
}

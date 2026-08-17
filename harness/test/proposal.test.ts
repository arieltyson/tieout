import { describe, expect, test } from 'vitest';
import { cents } from '../src/domain/money.js';
import {
  ProposalKindSchema,
  ProposalSchema,
  referencedTxnIds,
  type ProposalKind,
} from '../src/domain/proposal.js';

const validProposal = {
  id: 'prop_0001',
  runId: 'run_0001',
  sourceAgent: 'categorizer',
  kind: { type: 'categorize', txnId: 'txn_0001', glCode: '6010' },
  evidence: [{ runId: 'run_0001', seq: 0 }],
  confidence: 'high',
  idempotencyKey: 'categorize:txn_0001:6010',
  rationale: 'Recurring SaaS subscription.',
};

describe('ProposalSchema', () => {
  test('accepts a well-formed proposal', () => {
    expect(ProposalSchema.safeParse(validProposal).success).toBe(true);
  });

  test('rejects an unknown agent', () => {
    expect(ProposalSchema.safeParse({ ...validProposal, sourceAgent: 'rogue' }).success).toBe(false);
  });

  test('rejects a malformed GL code', () => {
    const kind = { type: 'categorize', txnId: 'txn_0001', glCode: '601' };
    expect(ProposalSchema.safeParse({ ...validProposal, kind }).success).toBe(false);
  });

  test('rejects a malformed txn id', () => {
    const kind = { type: 'categorize', txnId: '1', glCode: '6010' };
    expect(ProposalSchema.safeParse({ ...validProposal, kind }).success).toBe(false);
  });

  test('rejects an empty rationale', () => {
    expect(ProposalSchema.safeParse({ ...validProposal, rationale: '' }).success).toBe(false);
  });

  test('rejects an accrual with a fractional amount', () => {
    const kind = { type: 'accrue', vendor: 'Linear', amount: 96.5, period: '2026-06' };
    expect(ProposalSchema.safeParse({ ...validProposal, kind }).success).toBe(false);
  });

  // This is a deliberate hole in the schema, not an oversight. If an
  // evidence-free proposal were unrepresentable, `evidence_present` could
  // never be handed one to reject and would be untestable theatre. The
  // schema models what an agent can emit; the bank decides what passes.
  test('accepts an evidence-free proposal so the bank has something to reject', () => {
    expect(ProposalSchema.safeParse({ ...validProposal, evidence: [] }).success).toBe(true);
  });
});

describe('ProposalKindSchema', () => {
  test('rejects an unknown proposal type', () => {
    expect(ProposalKindSchema.safeParse({ type: 'wireMoney', amount: 100 }).success).toBe(false);
  });
});

describe('referencedTxnIds', () => {
  const cases: readonly { kind: ProposalKind; expected: readonly string[] }[] = [
    { kind: { type: 'categorize', txnId: 'txn_0001', glCode: '6010' }, expected: ['txn_0001'] },
    { kind: { type: 'flagDuplicate', txnIds: ['txn_0002', 'txn_0003'] }, expected: ['txn_0002', 'txn_0003'] },
    { kind: { type: 'flagPolicy', txnId: 'txn_0004', rule: 'single-txn-limit' }, expected: ['txn_0004'] },
    { kind: { type: 'requestReceipt', txnId: 'txn_0005' }, expected: ['txn_0005'] },
    // An accrual is for a charge that never arrived, so there is no
    // transaction to reference. `no_orphan_references` must not treat that
    // as an orphan.
    { kind: { type: 'accrue', vendor: 'Linear', amount: cents(9600), period: '2026-06' }, expected: [] },
  ];

  for (const { kind, expected } of cases) {
    test(`extracts referenced ids from a ${kind.type} proposal`, () => {
      expect(referencedTxnIds(kind)).toEqual(expected);
    });
  }

  test('covers every proposal kind in the union', () => {
    // If a new kind is added without a case here, this count fails before
    // the orphan verifier silently starts ignoring it.
    const kinds = new Set(cases.map((c) => c.kind.type));
    expect(kinds).toEqual(
      new Set(['categorize', 'flagDuplicate', 'flagPolicy', 'requestReceipt', 'accrue']),
    );
    expect(ProposalKindSchema.options).toHaveLength(kinds.size);
  });
});

import { describe, expect, test, vi } from 'vitest';
import { chaseworthy, runReceiptChaser, MATERIALITY_FLOOR_CENTS } from '../src/agents/receipt-chaser.js';
import { reconciliationFindings, runReconciler } from '../src/agents/reconciler.js';
import { reconcile } from '../src/domain/reconcile.js';
import { AGENT_GRANTS, GrantViolation, assertGranted } from '../src/tools/dispatch.js';
import { buildReceiptChaserTools } from '../src/tools/receipt-chaser-tools.js';
import { buildReconcilerTools } from '../src/tools/reconciler-tools.js';
import { loadGroundTruth, loadLedger } from '../../fixtures/src/index.js';
import type { ModelClient } from '../src/model/client.js';

const ledger = loadLedger();
const groundTruth = loadGroundTruth();
const PERIOD = '2026-06';
const glCodeFor = (id: string) => groundTruth.expectedCategorizations[id];

describe('the reconciler', () => {
  test('reports what the deterministic pass already knows as findings', () => {
    const findings = reconciliationFindings(reconcile(ledger, PERIOD));
    const kinds = new Set(findings.map((f) => f.kind));
    expect(kinds.has('unreconciled')).toBe(true);
    expect(kinds.has('bankAmountMismatch')).toBe(true);
    expect(kinds.has('bankOnly')).toBe(true);
    expect(findings.every((f) => f.source === 'deterministic')).toBe(true);
  });

  test('a bank only finding carries no transaction, because there is none', () => {
    const findings = reconciliationFindings(reconcile(ledger, PERIOD));
    for (const f of findings.filter((x) => x.kind === 'bankOnly')) {
      expect(f.txnIds).toEqual([]);
    }
  });

  test('spends nothing when there is no ambiguity to resolve', async () => {
    // Paying for a call that can only answer "nothing" quietly doubles the
    // cost of a close.
    const complete = vi.fn();
    const clean = { ...ledger, transactions: [], bankTransactions: [] };
    const result = await runReconciler({
      client: { name: 'x', complete } as unknown as ModelClient,
      ledger: clean, period: PERIOD,
    });
    expect(complete).not.toHaveBeenCalled();
    expect(result.usage.inputTokens).toBe(0);
  });

  test('a hallucinated bank id is rejected rather than reconciled against', () => {
    const sink = { verdicts: [] };
    const tools = buildReconcilerTools(ledger, reconcile(ledger, PERIOD), sink);
    const resolve = tools.find((t) => t.name === 'resolve_pairings')!;
    expect(() => resolve.run(
      { verdicts: [{ txnId: 'txn_0001', bankId: 'bank_9999', rationale: 'made up' }] },
      { runId: 'r', seq: 1 },
    )).toThrow(/Unknown bank row/);
  });

  test('cannot tell is a permitted answer', () => {
    const sink: { verdicts: unknown[] } = { verdicts: [] };
    const tools = buildReconcilerTools(ledger, reconcile(ledger, PERIOD), sink as never);
    const resolve = tools.find((t) => t.name === 'resolve_pairings')!;
    const txnId = reconcile(ledger, PERIOD).ambiguous[0]!.txnId;
    resolve.run({ verdicts: [{ txnId, bankId: null, rationale: 'two equally close' }] },
      { runId: 'r', seq: 1 });
    expect(sink.verdicts).toHaveLength(1);
  });
});

describe('the receipt chaser', () => {
  const missing = chaseworthy(ledger, PERIOD, glCodeFor);

  test('filters to what is worth asking about rather than everything', () => {
    const allMissing = ledger.transactions.filter(
      (t) => t.date.startsWith(`${PERIOD}-`)
        && !ledger.receipts.some((r) => r.txnId === t.id));
    expect(missing.length).toBeGreaterThan(0);
    // A list of two hundred is the same as no list at all.
    expect(missing.length).toBeLessThan(allMissing.length);
  });

  test('is ordered by amount, because that is what gets questioned', () => {
    for (let i = 1; i < missing.length; i += 1) {
      expect(missing[i - 1]!.amountCents).toBeGreaterThanOrEqual(missing[i]!.amountCents);
    }
  });

  test('never chases a transaction that already has a receipt', () => {
    const receipted = new Set(ledger.receipts.map((r) => r.txnId));
    for (const t of missing) expect(receipted.has(t.id)).toBe(false);
  });

  test('keeps a small policy breach even below the materiality floor', () => {
    // Size is not the only reason something needs documentation.
    const small = missing.filter((t) => t.amountCents < MATERIALITY_FLOOR_CENTS);
    for (const t of small) {
      expect(ledger.approvals.includes(t.id)).toBe(false);
    }
  });

  test('rejects a request for a receipt that was already filed', () => {
    const sink = { requests: [] };
    const tools = buildReceiptChaserTools(ledger, missing, glCodeFor, sink);
    const request = tools.find((t) => t.name === 'request_receipts')!;
    const receipted = ledger.receipts[0]!.txnId;
    expect(() => request.run(
      { requests: [{ txnId: receipted, priority: 'high', nudge: 'send it' }] },
      { runId: 'r', seq: 1 },
    )).toThrow(/not missing a receipt/);
  });

  test('spends nothing when nothing is worth chasing', async () => {
    const complete = vi.fn();
    const result = await runReceiptChaser({
      client: { name: 'x', complete } as unknown as ModelClient,
      ledger: { ...ledger, receipts: ledger.transactions.map((t) => ({ txnId: t.id, receiptTotalCents: t.amountCents })) },
      period: PERIOD,
    });
    expect(complete).not.toHaveBeenCalled();
    expect(result.requested).toEqual([]);
  });
});

describe('least privilege, on the agent whose whole job is paperwork', () => {
  test('the receipt chaser holds no propose grant at all', () => {
    expect(AGENT_GRANTS.receiptChaser).toEqual(['ledger:read']);
  });

  test('its own tool set is accepted', () => {
    const tools = buildReceiptChaserTools(ledger, chaseworthy(ledger, PERIOD), undefined, { requests: [] });
    expect(() => assertGranted('receiptChaser', tools)).not.toThrow();
  });

  test('a proposing tool would be rejected for it', () => {
    const tools = buildReconcilerTools(ledger, reconcile(ledger, PERIOD), { verdicts: [] });
    expect(() => assertGranted('receiptChaser', tools)).toThrow(GrantViolation);
  });
});

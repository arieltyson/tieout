import { describe, expect, test } from 'vitest';
import { DEFAULT_PERIOD, DEFAULT_SEED, generateFixture } from '../src/generate-ledger.js';

const { ledger, groundTruth } = generateFixture(DEFAULT_SEED, DEFAULT_PERIOD);
const ledgerJson = JSON.stringify(ledger);

describe('ground-truth leakage', () => {
  test('no planted-defect id appears anywhere in the ledger snapshot', () => {
    for (const defect of groundTruth.plantedDefects) {
      expect(ledgerJson).not.toContain(defect.id);
    }
  });

  test('no defect-kind vocabulary appears anywhere in the ledger snapshot', () => {
    const forbidden = [
      'isDuplicate',
      'duplicate',
      'Duplicate',
      'defect',
      'Defect',
      'groundTruth',
      'ground-truth',
      'ground_truth',
      'anomaly',
      'Anomaly',
      'violation',
      'Violation',
      'mismatch',
      'Mismatch',
      'canonicalVendor',
      'expectedCategorizations',
      'plantedDefects',
    ];
    for (const word of forbidden) {
      expect(ledgerJson).not.toContain(word);
    }
  });

  test('transactions carry only fields a card statement would show', () => {
    const allowed = new Set(['id', 'date', 'vendorDescriptor', 'amountCents', 'currency', 'originalAmountCents', 'fxRate']);
    for (const txn of ledger.transactions) {
      expect(new Set(Object.keys(txn))).toEqual(allowed);
    }
  });

  test('receipts carry only txnId and total, no mismatch annotation', () => {
    const allowed = new Set(['txnId', 'receiptTotalCents']);
    for (const receipt of ledger.receipts) {
      expect(new Set(Object.keys(receipt))).toEqual(allowed);
    }
  });

  test('approvals are a bare list of txnIds, not annotated records', () => {
    for (const entry of ledger.approvals) {
      expect(typeof entry).toBe('string');
    }
  });

  test('no GL code appears anywhere on a transaction', () => {
    // Categorization is exactly the job left for the agent — the ledger
    // must not carry the answer as a field.
    for (const txn of ledger.transactions) {
      expect(txn).not.toHaveProperty('glCode');
      expect(txn).not.toHaveProperty('category');
      expect(txn).not.toHaveProperty('accountCode');
    }
  });

  test('every txnId referenced by ground truth exists in the ledger', () => {
    const realIds = new Set(ledger.transactions.map((t) => t.id));
    for (const txnId of Object.keys(groundTruth.expectedCategorizations)) {
      expect(realIds.has(txnId)).toBe(true);
    }
    for (const defect of groundTruth.plantedDefects) {
      for (const txnId of defect.txnIds) {
        expect(realIds.has(txnId)).toBe(true);
      }
    }
  });
});

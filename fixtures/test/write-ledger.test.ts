import Database from 'better-sqlite3';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { DEFAULT_PERIOD, DEFAULT_SEED, generateFixture } from '../src/generate-ledger.js';
import { GroundTruthSchema, LedgerSchema } from '../src/types.js';
import { writeGroundTruthJson, writeLedgerJson, writeLedgerSqlite } from '../src/write-ledger.js';

const { ledger, groundTruth } = generateFixture(DEFAULT_SEED, DEFAULT_PERIOD);

let dir: string;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe('writeLedgerJson / writeGroundTruthJson', () => {
  test('writes JSON that round-trips through the Zod schema', () => {
    dir = mkdtempSync(join(tmpdir(), 'tieout-fixtures-'));
    const ledgerPath = join(dir, 'ledger.json');
    const gtPath = join(dir, 'ground-truth.json');

    writeLedgerJson(ledgerPath, ledger);
    writeGroundTruthJson(gtPath, groundTruth);

    const readLedger = JSON.parse(readFileSync(ledgerPath, 'utf-8'));
    const readGroundTruth = JSON.parse(readFileSync(gtPath, 'utf-8'));

    expect(LedgerSchema.safeParse(readLedger).success).toBe(true);
    expect(GroundTruthSchema.safeParse(readGroundTruth).success).toBe(true);
    expect(readLedger).toEqual(ledger);
    expect(readGroundTruth).toEqual(groundTruth);
  });

  test('writing twice produces byte-identical files', () => {
    dir = mkdtempSync(join(tmpdir(), 'tieout-fixtures-'));
    const path = join(dir, 'ledger.json');
    writeLedgerJson(path, ledger);
    const first = readFileSync(path, 'utf-8');
    writeLedgerJson(path, ledger);
    const second = readFileSync(path, 'utf-8');
    expect(second).toBe(first);
  });
});

describe('writeLedgerSqlite', () => {
  test('writes a queryable database with matching row counts and no ground-truth columns', () => {
    dir = mkdtempSync(join(tmpdir(), 'tieout-fixtures-'));
    const dbPath = join(dir, 'ledger.db');
    writeLedgerSqlite(dbPath, ledger);

    const db = new Database(dbPath, { readonly: true });
    try {
      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
        .all()
        .map((r) => (r as { name: string }).name);
      expect(tables).toEqual(['approvals', 'receipts', 'transactions']);

      const txnCount = (db.prepare('SELECT COUNT(*) AS n FROM transactions').get() as { n: number }).n;
      expect(txnCount).toBe(ledger.transactions.length);

      const receiptCount = (db.prepare('SELECT COUNT(*) AS n FROM receipts').get() as { n: number }).n;
      expect(receiptCount).toBe(ledger.receipts.length);

      const approvalCount = (db.prepare('SELECT COUNT(*) AS n FROM approvals').get() as { n: number }).n;
      expect(approvalCount).toBe(ledger.approvals.length);

      const columns = db
        .prepare("PRAGMA table_info(transactions)")
        .all()
        .map((r) => (r as { name: string }).name);
      expect(columns).not.toContain('is_duplicate');
      expect(columns).not.toContain('defect_id');
      expect(columns).not.toContain('gl_code');
    } finally {
      db.close();
    }
  });

  test('regenerating overwrites rather than appending', () => {
    dir = mkdtempSync(join(tmpdir(), 'tieout-fixtures-'));
    const dbPath = join(dir, 'ledger.db');
    writeLedgerSqlite(dbPath, ledger);
    writeLedgerSqlite(dbPath, ledger);

    const db = new Database(dbPath, { readonly: true });
    try {
      const txnCount = (db.prepare('SELECT COUNT(*) AS n FROM transactions').get() as { n: number }).n;
      expect(txnCount).toBe(ledger.transactions.length);
    } finally {
      db.close();
    }
  });
});

/**
 * Persists a generated fixture to disk: a JSON snapshot of the ledger and
 * ground truth (both committed — they're the fixture source, and diffing
 * them across a regeneration is how idempotency gets verified), plus a
 * SQLite database of the ledger alone for query-layer consumption in later
 * phases. Ground truth never touches the database — the agent should only
 * ever be able to see what a real accountant would see.
 */
import Database from 'better-sqlite3';
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { GroundTruth, Ledger } from './types.js';

function writeJson(path: string, data: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`, 'utf-8');
}

export function writeLedgerJson(path: string, ledger: Ledger): void {
  writeJson(path, ledger);
}

export function writeGroundTruthJson(path: string, groundTruth: GroundTruth): void {
  writeJson(path, groundTruth);
}

export function writeLedgerSqlite(path: string, ledger: Ledger): void {
  mkdirSync(dirname(path), { recursive: true });
  if (existsSync(path)) unlinkSync(path);

  const db = new Database(path);
  try {
    db.exec(`
      CREATE TABLE transactions (
        id                     TEXT PRIMARY KEY,
        date                   TEXT NOT NULL,
        vendor_descriptor      TEXT NOT NULL,
        amount_cents           INTEGER NOT NULL,
        currency               TEXT NOT NULL,
        original_amount_cents  INTEGER,
        fx_rate                REAL
      );
      CREATE TABLE receipts (
        txn_id                 TEXT PRIMARY KEY REFERENCES transactions(id),
        receipt_total_cents    INTEGER NOT NULL
      );
      CREATE TABLE approvals (
        txn_id                 TEXT PRIMARY KEY REFERENCES transactions(id)
      );
    `);

    const insertTxn = db.prepare(`
      INSERT INTO transactions (id, date, vendor_descriptor, amount_cents, currency, original_amount_cents, fx_rate)
      VALUES (@id, @date, @vendorDescriptor, @amountCents, @currency, @originalAmountCents, @fxRate)
    `);
    const insertReceipt = db.prepare(`
      INSERT INTO receipts (txn_id, receipt_total_cents) VALUES (@txnId, @receiptTotalCents)
    `);
    const insertApproval = db.prepare(`INSERT INTO approvals (txn_id) VALUES (?)`);

    const writeAll = db.transaction(() => {
      for (const txn of ledger.transactions) insertTxn.run(txn);
      for (const receipt of ledger.receipts) insertReceipt.run(receipt);
      for (const txnId of ledger.approvals) insertApproval.run(txnId);
    });
    writeAll();
  } finally {
    db.close();
  }
}

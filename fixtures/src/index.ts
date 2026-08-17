/**
 * Public surface of the fixtures package. Later phases read the committed
 * ledger via `loadLedger()` / `loadGroundTruth()` rather than regenerating
 * it — the files in `fixtures/data/` are the fixture of record, and
 * `npm run fixtures:generate` is how they get refreshed.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { GroundTruthSchema, LedgerSchema, type GroundTruth, type Ledger } from './types.js';

const DATA_DIR = fileURLToPath(new URL('../data/', import.meta.url));

export function loadLedger(): Ledger {
  const raw = JSON.parse(readFileSync(`${DATA_DIR}ledger.json`, 'utf-8'));
  const parsed = LedgerSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`fixtures/data/ledger.json failed schema validation:\n${parsed.error.message}`);
  }
  // Cents is a branded type — Zod validates the runtime integer shape, and
  // this cast is what asserts the brand back on top of that proof.
  return parsed.data as unknown as Ledger;
}

export function loadGroundTruth(): GroundTruth {
  const raw = JSON.parse(readFileSync(`${DATA_DIR}ground-truth.json`, 'utf-8'));
  const parsed = GroundTruthSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`fixtures/data/ground-truth.json failed schema validation:\n${parsed.error.message}`);
  }
  return parsed.data as unknown as GroundTruth;
}

export * from './chart-of-accounts.js';
export * from './generate-ledger.js';
export * from './policy-rules.js';
export * from './types.js';
export { writeGroundTruthJson, writeLedgerJson, writeLedgerSqlite } from './write-ledger.js';

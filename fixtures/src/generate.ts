/**
 * `npm run fixtures:generate` — regenerates the ledger fixture from the
 * fixed seed. Deterministic: run it twice, get byte-identical
 * fixtures/data/ledger.json and fixtures/data/ground-truth.json.
 */
import { fileURLToPath } from 'node:url';
import { DEFAULT_PERIOD, DEFAULT_SEED, generateFixture } from './generate-ledger.js';
import { GroundTruthSchema, LedgerSchema } from './types.js';
import { writeGroundTruthJson, writeLedgerJson, writeLedgerSqlite } from './write-ledger.js';

const DATA_DIR = fileURLToPath(new URL('../data/', import.meta.url));

export function runGenerate(): void {
  const { ledger, groundTruth } = generateFixture(DEFAULT_SEED, DEFAULT_PERIOD);

  const ledgerCheck = LedgerSchema.safeParse(ledger);
  if (!ledgerCheck.success) {
    throw new Error(`Generated ledger failed schema validation:\n${ledgerCheck.error.message}`);
  }
  const groundTruthCheck = GroundTruthSchema.safeParse(groundTruth);
  if (!groundTruthCheck.success) {
    throw new Error(`Generated ground truth failed schema validation:\n${groundTruthCheck.error.message}`);
  }

  writeLedgerJson(`${DATA_DIR}ledger.json`, ledger);
  writeGroundTruthJson(`${DATA_DIR}ground-truth.json`, groundTruth);
  writeLedgerSqlite(`${DATA_DIR}ledger.db`, ledger);

  console.log(`Generated fixture for seed ${DEFAULT_SEED}, period ${DEFAULT_PERIOD}:`);
  console.log(`  ${ledger.transactions.length} transactions`);
  console.log(`  ${ledger.receipts.length} receipts`);
  console.log(`  ${ledger.approvals.length} approvals`);
  console.log(`  ${groundTruth.plantedDefects.length} planted defects`);
  console.log(`  ${Object.keys(groundTruth.expectedCategorizations).length} expected categorizations`);
  console.log(`Wrote ${DATA_DIR}ledger.json, ground-truth.json, ledger.db`);
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  runGenerate();
}

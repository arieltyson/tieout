/**
 * `npm run matrix` — runs the ablation matrix and prints the table.
 *
 * TWO OF THE SIX ROWS COST NOTHING, AND SAYING WHY MATTERS.
 *
 * Disabling the verifier bank or the self correction cycle changes what
 * happens to proposals AFTER the model has produced them. The model does
 * identical work in both arms, by construction. Paying a second time for
 * output that cannot differ would not measure anything, so those rows reuse
 * the baseline's model output and re-run only the part that differs. The
 * arms that genuinely change what the model sees or does are paid for.
 *
 * Vendor memory needs its own protocol. On a first close the memory is
 * empty, so enabling it changes nothing. Its value is entirely in the
 * second close, so the baseline run populates the memory and a warm run
 * follows. Reporting a cold run as evidence that memory does not help
 * would be measuring the wrong thing.
 */
process.loadEnvFile?.();

import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runBank } from '../../harness/src/domain/bank.js';
import { repairUntilClean } from '../../harness/src/loop/repair.js';
import { VendorMemory } from '../../harness/src/memory/vendor-memory.js';
import { AnthropicModelClient, DEFAULT_MODEL } from '../../harness/src/model/anthropic.js';
import { loadGroundTruth, loadLedger } from '../../fixtures/src/index.js';
import { BASELINE } from './ablation.js';
import { runPipeline, type PipelineResult } from './pipeline.js';
import { estimateCostUsd, scoreCategorizations } from './score.js';
import { scoreAnomalies } from './score-anomalies.js';

const RESULTS_DIR = fileURLToPath(new URL('../results/', import.meta.url));
const MEMORY_PATH = `${RESULTS_DIR}vendor-memory.db`;
const PERIOD = '2026-06';

interface Row {
  readonly name: string;
  readonly accuracy: number;
  readonly anomalyF1: number;
  readonly escapeHatch: number;
  readonly blocked: number;
  readonly turns: number;
  readonly costUsd: number;
  readonly note: string;
}

function score(result: PipelineResult, expected: Record<string, string>, groundTruth: ReturnType<typeof loadGroundTruth>) {
  const cat = scoreCategorizations(result.categorizations, expected);
  const anomalies = scoreAnomalies(result.findings, groundTruth);
  const cost = estimateCostUsd(DEFAULT_MODEL, result.usage.inputTokens, result.usage.outputTokens) ?? 0;
  return { cat, anomalies, cost };
}

async function main(): Promise<void> {
  if (!process.env['ANTHROPIC_API_KEY']) {
    console.error('ANTHROPIC_API_KEY is not set.');
    process.exit(1);
  }

  const ledger = loadLedger();
  const groundTruth = loadGroundTruth();
  const client = new AnthropicModelClient({ apiKey: process.env['ANTHROPIC_API_KEY'] });

  const expected = Object.fromEntries(
    Object.entries(groundTruth.expectedCategorizations),
  ) as Record<string, string>;

  // Start from an empty memory so the cold run is genuinely cold.
  rmSync(MEMORY_PATH, { force: true });
  mkdirSync(RESULTS_DIR, { recursive: true });
  const memory = new VendorMemory(MEMORY_PATH);

  const rows: Row[] = [];
  const raw: Record<string, unknown> = {};

  const log = (m: string) => process.stdout.write(`\r${' '.repeat(70)}\r  ${m}`);

  // --- 1. Baseline, cold -------------------------------------------------
  console.log(`\nAblation matrix · ${DEFAULT_MODEL} · ${PERIOD}\n`);
  console.log('[1/5] baseline, cold memory');
  const baseline = await runPipeline({
    client, ledger, period: PERIOD, config: BASELINE, memory, onProgress: log,
  });
  const baseScore = score(baseline, expected, groundTruth);
  rows.push({
    name: 'baseline',
    accuracy: baseScore.cat.accuracy,
    anomalyF1: baseScore.anomalies.overallF1,
    escapeHatch: baseScore.cat.escapeHatchRate,
    blocked: baseline.bank?.blocked.length ?? 0,
    turns: baseline.turns,
    costUsd: baseScore.cost,
    note: 'all components enabled',
  });
  raw['baseline'] = { score: baseScore, usage: baseline.usage, turns: baseline.turns };
  console.log('');

  // Teach the memory what this run decided, so the warm run has something
  // to remember. Only high confidence answers are recorded.
  for (const c of baseline.categorizations) {
    if (c.confidence === 'high') memory.record(
      ledger.transactions.find((t) => t.id === c.txnId)?.vendorDescriptor ?? '',
      c.glCode,
    );
  }
  const memStats = memory.stats();

  // --- 2. Derived rows, no API calls -------------------------------------
  // The model's output is identical, so only the post processing is redone.
  const scoped = { ...ledger, transactions: ledger.transactions.filter((t) => t.date.startsWith(`${PERIOD}-`)) };

  const noVerifiers = { ...baseline, bank: null };
  rows.push({
    name: 'no deterministic verifiers',
    accuracy: baseScore.cat.accuracy,
    anomalyF1: baseScore.anomalies.overallF1,
    escapeHatch: baseScore.cat.escapeHatchRate,
    blocked: 0,
    turns: baseline.turns,
    costUsd: 0,
    note: 'derived, no API calls: the bank runs after the model',
  });
  raw['no-deterministic-verifiers'] = { derived: true, blocked: noVerifiers.bank };

  const withoutRepair = runBank(baseline.proposals, scoped);
  const withRepair = await repairUntilClean(baseline.proposals, scoped, async (c) => c);
  rows.push({
    name: 'no self correction',
    accuracy: baseScore.cat.accuracy,
    anomalyF1: baseScore.anomalies.overallF1,
    escapeHatch: baseScore.cat.escapeHatchRate,
    blocked: withoutRepair.blocked.length,
    turns: baseline.turns,
    costUsd: 0,
    note: 'derived, no API calls: repair runs after the model',
  });
  raw['no-self-correction'] = {
    derived: true,
    blockedWithoutRepair: withoutRepair.blocked.length,
    blockedWithRepair: withRepair.bank.blocked.length,
    repairAttempts: withRepair.attempts.length,
  };

  // --- 3. Warm memory ----------------------------------------------------
  console.log(`[2/5] baseline, warm memory (${memStats.exact} exact, ${memStats.stems} stems, ${memStats.conflicted} conflicted)`);
  const warm = await runPipeline({
    client, ledger, period: PERIOD, config: BASELINE, memory, onProgress: log,
  });
  const warmScore = score(warm, expected, groundTruth);
  rows.push({
    name: 'baseline, second close',
    accuracy: warmScore.cat.accuracy,
    anomalyF1: warmScore.anomalies.overallF1,
    escapeHatch: warmScore.cat.escapeHatchRate,
    blocked: warm.bank?.blocked.length ?? 0,
    turns: warm.turns,
    costUsd: warmScore.cost,
    note: `vendor memory resolved ${warm.memoryHits}/${warm.categorizations.length}`,
  });
  raw['baseline-warm'] = { score: warmScore, memoryHits: warm.memoryHits, usage: warm.usage };
  console.log('');

  // --- 4. No deterministic pre pass --------------------------------------
  console.log('[3/5] no deterministic pre pass');
  const noPrepass = await runPipeline({
    client, ledger, period: PERIOD,
    config: { ...BASELINE, deterministicPrePass: false, vendorMemory: false },
    onProgress: log,
  });
  const prepassScore = score(noPrepass, expected, groundTruth);
  rows.push({
    name: 'no deterministic pre pass',
    accuracy: prepassScore.cat.accuracy,
    anomalyF1: prepassScore.anomalies.overallF1,
    escapeHatch: prepassScore.cat.escapeHatchRate,
    blocked: noPrepass.bank?.blocked.length ?? 0,
    turns: noPrepass.turns,
    costUsd: prepassScore.cost,
    note: noPrepass.maxTokensHits > 0 ? 'TRUNCATED, invalid' : 'model searches the raw ledger',
  });
  raw['no-deterministic-pre-pass'] = { score: prepassScore, usage: noPrepass.usage, truncated: noPrepass.maxTokensHits > 0 };
  console.log('');

  // --- 5. No sub agent isolation -----------------------------------------
  console.log('[4/5] no sub agent isolation');
  const flat = await runPipeline({
    client, ledger, period: PERIOD,
    config: { ...BASELINE, subAgentIsolation: false, vendorMemory: false },
    onProgress: log,
  });
  const flatScore = score(flat, expected, groundTruth);
  rows.push({
    name: 'no sub agent isolation',
    accuracy: flatScore.cat.accuracy,
    anomalyF1: flatScore.anomalies.overallF1,
    escapeHatch: flatScore.cat.escapeHatchRate,
    blocked: flat.bank?.blocked.length ?? 0,
    turns: flat.turns,
    costUsd: flatScore.cost,
    note: flat.maxTokensHits > 0 ? 'TRUNCATED, invalid' : 'one agent, one context, both jobs',
  });
  raw['no-sub-agent-isolation'] = { score: flatScore, usage: flat.usage, truncated: flat.maxTokensHits > 0 };
  console.log('\n[5/5] scoring\n');

  // --- Table -------------------------------------------------------------
  const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
  console.log('| Configuration | Accuracy | Anomaly F1 | Escape hatch | Blocked | Turns | Cost |');
  console.log('|---|---|---|---|---|---|---|');
  for (const r of rows) {
    console.log(
      `| ${r.name} | ${pct(r.accuracy)} | ${r.anomalyF1.toFixed(2)} | ${pct(r.escapeHatch)} | `
        + `${r.blocked} | ${r.turns} | $${r.costUsd.toFixed(2)} |`,
    );
  }
  console.log('\nNotes');
  for (const r of rows) console.log(`  ${r.name}: ${r.note}`);

  const total = rows.reduce((n, r) => n + r.costUsd, 0);
  console.log(`\n  total spend $${total.toFixed(2)}`);

  memory.close();
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const path = `${RESULTS_DIR}${stamp}-matrix.json`;
  writeFileSync(path, `${JSON.stringify({ model: DEFAULT_MODEL, period: PERIOD, rows, raw }, null, 2)}\n`);
  console.log(`  wrote ${path}\n`);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.stack : err);
  process.exit(1);
});

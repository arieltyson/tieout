/**
 * `npm run ablate` — runs one ablation variant and prints it beside the
 * baseline it is meant to be compared against.
 *
 * Only the anomaly side is ablated here, because that is where the
 * architecture's central claim lives: that handing a model pre-computed
 * candidates beats asking it to search. The categorizer is identical in
 * both arms, so it is not re-run and not re-paid for.
 */
process.loadEnvFile?.();

import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  deterministicFindings,
  type Finding,
} from '../../harness/src/agents/anomaly-hunter.js';
import { runRawAnomalyHunter } from '../../harness/src/agents/anomaly-hunter-raw.js';
import { detectAll } from '../../harness/src/domain/detectors.js';
import { AnthropicModelClient, DEFAULT_MODEL } from '../../harness/src/model/anthropic.js';
import { loadGroundTruth, loadLedger } from '../../fixtures/src/index.js';
import { estimateCostUsd } from './score.js';
import { scoreAnomalies, type AnomalyScore } from './score-anomalies.js';

const RESULTS_DIR = fileURLToPath(new URL('../results/', import.meta.url));
const PERIOD = '2026-06';

function table(label: string, score: AnomalyScore): void {
  console.log(`\n${label}`);
  console.log('    kind               planted  found   P     R');
  for (const c of score.byCategory) {
    console.log(
      `    ${c.kind.padEnd(18)} ${String(c.planted).padStart(4)}  ${String(c.reported).padStart(5)}   `
        + `${c.precision.toFixed(2)}  ${c.recall.toFixed(2)}`,
    );
  }
  console.log(
    `    ${'OVERALL'.padEnd(18)} ${' '.repeat(11)}${score.overallPrecision.toFixed(2)}  `
      + `${score.overallRecall.toFixed(2)}   F1 ${score.overallF1.toFixed(2)}`,
  );
}

async function main(): Promise<void> {
  const apiKey = process.env['ANTHROPIC_API_KEY'];
  if (!apiKey) {
    console.error('ANTHROPIC_API_KEY is not set.');
    process.exit(1);
  }

  const ledger = loadLedger();
  const groundTruth = loadGroundTruth();
  const glCodeFor = (txnId: string) => groundTruth.expectedCategorizations[txnId];

  // Arm A: the real pipeline's deterministic half. Costs nothing, so it is
  // recomputed here rather than read back from a previous run's artifact.
  const baseline: readonly Finding[] = deterministicFindings(
    ledger,
    PERIOD,
    detectAll(ledger, PERIOD, glCodeFor),
  );
  const baselineScore = scoreAnomalies(baseline, groundTruth);

  console.log('\nAblation: deterministic pre-pass');
  console.log(`  model     ${DEFAULT_MODEL}`);
  console.log(`  ledger    ${ledger.transactions.length} transactions`);
  console.log('  arm A     detectors compute candidates (baseline)');
  console.log('  arm B     no detectors, the model searches the raw ledger');

  const client = new AnthropicModelClient({ apiKey });
  const startedAt = Date.now();
  const raw = await runRawAnomalyHunter({ client, ledger, period: PERIOD });
  const wallClockMs = Date.now() - startedAt;
  const rawScore = scoreAnomalies(raw.findings, groundTruth);

  table('ARM A — with the deterministic pre-pass (0 tokens)', baselineScore);
  table('ARM B — without it, model searches', rawScore);

  const cost = estimateCostUsd(DEFAULT_MODEL, raw.usage.inputTokens, raw.usage.outputTokens);
  console.log('\nARM B cost');
  console.log(`  turns          ${raw.turns}`);
  console.log(`  tokens in/out  ${raw.usage.inputTokens} / ${raw.usage.outputTokens}`);
  console.log(`  estimated      ${cost === null ? 'n/a' : `$${cost.toFixed(4)}`}`);
  console.log(`  wall clock     ${(wallClockMs / 1000).toFixed(1)}s`);
  if (raw.maxTokensHits > 0) {
    console.log('  WARNING: response was truncated, treat this arm as invalid');
  }

  console.log('\nDELTA (arm B minus arm A)');
  console.log(`  precision      ${(rawScore.overallPrecision - baselineScore.overallPrecision).toFixed(2)}`);
  console.log(`  recall         ${(rawScore.overallRecall - baselineScore.overallRecall).toFixed(2)}`);
  console.log(`  F1             ${(rawScore.overallF1 - baselineScore.overallF1).toFixed(2)}`);
  console.log(`  cost           +${cost === null ? '?' : `$${cost.toFixed(4)}`} (arm A is free)`);

  mkdirSync(RESULTS_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const path = `${RESULTS_DIR}${stamp}-ablation-prepass.json`;
  writeFileSync(
    path,
    `${JSON.stringify(
      {
        variant: 'no-deterministic-pre-pass',
        model: DEFAULT_MODEL,
        armA: { score: baselineScore, tokens: 0, costUsd: 0 },
        armB: {
          score: rawScore,
          usage: raw.usage,
          turns: raw.turns,
          costUsd: cost,
          wallClockMs,
          truncated: raw.maxTokensHits > 0,
        },
      },
      null,
      2,
    )}\n`,
  );
  console.log(`\n  wrote ${path}\n`);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.stack : err);
  process.exit(1);
});

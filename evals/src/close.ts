/**
 * `npm run close` — the first end-to-end run.
 *
 * Loads the fixture, runs the categorizer over a period, verifies the
 * proposals through the bank, scores against ground truth, and prints
 * accuracy, tokens, cost, and wall clock.
 *
 * Use --dry to run the whole pipeline against the scripted model client,
 * which spends nothing and needs no API key.
 */
import { writeFileSync, mkdirSync } from 'node:fs';

// Read .env before anything looks at process.env. Without this the CLI only
// sees a key that was exported into the shell, and reports "not set" while
// the file sits right there — which is exactly what happened the first time.
try {
  process.loadEnvFile();
} catch {
  // No .env present; --dry needs no key, and the real path fails loudly below.
}

import { fileURLToPath } from 'node:url';
import { runCategorizer } from '../../harness/src/agents/categorizer.js';
import { runAnomalyHunter, deterministicFindings, type Finding } from '../../harness/src/agents/anomaly-hunter.js';
import { detectAll } from '../../harness/src/domain/detectors.js';
import { reconciliationFindings, runReconciler } from '../../harness/src/agents/reconciler.js';
import { runReceiptChaser } from '../../harness/src/agents/receipt-chaser.js';
import { reconcile } from '../../harness/src/domain/reconcile.js';
import { scoreAnomalies } from './score-anomalies.js';
import { runBank } from '../../harness/src/domain/bank.js';
import { byPeriod } from '../../harness/src/domain/queries.js';
import type { Proposal } from '../../harness/src/domain/proposal.js';
import { AnthropicModelClient, DEFAULT_MODEL } from '../../harness/src/model/anthropic.js';
import { ScriptedModelClient } from '../../harness/src/model/scripted.js';
import type { ModelClient } from '../../harness/src/model/client.js';
import { loadGroundTruth, loadLedger } from '../../fixtures/src/index.js';
import { estimateCostUsd, scoreCategorizations } from './score.js';
import { buildCloseRun } from './build-artifact.js';

const RESULTS_DIR = fileURLToPath(new URL('../results/', import.meta.url));

interface Args {
  readonly period: string;
  readonly dry: boolean;
  readonly limit: number | null;
  readonly batchSize: number;
  readonly model: string;
  readonly skipAnomalies: boolean;
}

function parseArgs(argv: readonly string[]): Args {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const positional = argv.find((a) => /^\d{4}-\d{2}$/.test(a));
  const limitRaw = get('--limit');
  return {
    period: positional ?? get('--period') ?? '2026-06',
    dry: argv.includes('--dry'),
    limit: limitRaw ? Number(limitRaw) : null,
    batchSize: Number(get('--batch') ?? 50),
    model: get('--model') ?? DEFAULT_MODEL,
    skipAnomalies: argv.includes('--no-anomalies'),
  };
}

/**
 * A scripted client that answers every batch with a correct-looking
 * categorization drawn from ground truth. Exercises the whole pipeline
 * without a token — useful for checking plumbing, useless as a score, so
 * the output says so loudly.
 */
function buildDryClient(expected: Readonly<Record<string, string>>): ModelClient {
  return {
    name: 'scripted-dry',
    async complete(req) {
      const last = req.messages.at(-1);
      const text = typeof last?.content === 'string' ? last.content : '';
      const ids = [...text.matchAll(/"id": ?"(txn_\d+)"/g)].map((m) => m[1]!);

      // Nothing left to propose means the batch is done. Without this the
      // client keeps returning tool_use forever and every batch runs to
      // the turn budget instead of finishing in one call.
      if (ids.length === 0) {
        return {
          content: [{ type: 'text', text: 'Batch complete.' }],
          stopReason: 'end_turn' as const,
          usage: { inputTokens: 0, outputTokens: 0 },
          model: 'scripted-dry',
        };
      }

      return {
        content: [
          {
            type: 'tool_use',
            id: 'tu_dry',
            name: 'propose_categorizations',
            input: {
              categorizations: ids.map((id) => ({
                txnId: id,
                glCode: expected[id] ?? '6900',
                rationale: 'dry run',
                confidence: 'high' as const,
              })),
            },
          },
        ],
        stopReason: 'tool_use' as const,
        usage: { inputTokens: 0, outputTokens: 0 },
        model: 'scripted-dry',
      };
    },
  };
}

function pct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const ledger = loadLedger();
  const groundTruth = loadGroundTruth();

  let transactions = byPeriod(ledger, args.period);
  if (transactions.length === 0) {
    console.error(`No transactions in ${args.period}. Fixture period is ${ledger.period}.`);
    process.exit(1);
  }
  if (args.limit !== null) transactions = transactions.slice(0, args.limit);

  let client: ModelClient;
  if (args.dry) {
    client = buildDryClient(groundTruth.expectedCategorizations);
  } else {
    const apiKey = process.env['ANTHROPIC_API_KEY'];
    if (!apiKey) {
      console.error('ANTHROPIC_API_KEY is not set. Use --dry to run without one.');
      process.exit(1);
    }
    client = new AnthropicModelClient({ apiKey, model: args.model });
  }

  console.log(`\nTieout — close ${args.period}`);
  console.log(`  model        ${args.dry ? 'scripted (dry run, no tokens)' : args.model}`);
  console.log(`  transactions ${transactions.length}`);
  console.log(`  batch size   ${args.batchSize}\n`);

  const startedAtDate = new Date();
  const startedAt = Date.now();
  const result = await runCategorizer({
    client,
    ledger,
    transactions,
    batchSize: args.batchSize,
    onBatch: (done, total) => process.stdout.write(`\r  categorizing ${done}/${total}`),
  });
  const categorizerWallClockMs = Date.now() - startedAt;
  process.stdout.write('\r'.padEnd(40) + '\r');

  // Every proposal goes through the bank before anyone sees a number.
  const proposals: Proposal[] = result.categorizations.map((c, i) => ({
    id: `prop_${String(i + 1).padStart(4, '0')}`,
    runId: 'run_local',
    sourceAgent: 'categorizer' as const,
    kind: { type: 'categorize' as const, txnId: c.txnId, glCode: c.glCode },
    evidence: [{ runId: 'run_local', seq: c.toolCallSeq }],
    confidence: c.confidence,
    idempotencyKey: `categorize:${c.txnId}:${c.glCode}`,
    rationale: c.rationale,
  }));

  const scopedLedger = { ...ledger, transactions: [...transactions] };
  const bank = runBank(proposals, scopedLedger);
  const expectedForScope = Object.fromEntries(
    transactions
      .map((t) => [t.id, groundTruth.expectedCategorizations[t.id]])
      .filter((e): e is [string, string] => e[1] !== undefined),
  );
  const score = scoreCategorizations(result.categorizations, expectedForScope);

  // The anomaly hunter runs after the categorizer because scoped policy
  // rules need to know which account a transaction landed in — that is the
  // categorizer's output, not a ledger field.
  const glByTxn = new Map(result.categorizations.map((c) => [c.txnId, c.glCode]));
  const glCodeFor = (txnId: string) => glByTxn.get(txnId);

  let findings: readonly Finding[] = [];
  let receiptRequests = 0;
  let anomalyUsage = { inputTokens: 0, outputTokens: 0 };
  let anomalyTurns = 0;
  // The FULL ledger, not the period-scoped one. The categorizer only needs
  // the month it is closing, but recurring gaps and price anomalies are
  // defined against prior months — handed a single period they find nothing
  // and report a confident zero.
  // Reconciliation is deterministic and free, so it runs either way. Only
  // the model half of it is behind the anomaly flag.
  const reconciled = reconciliationFindings(reconcile(ledger, args.period));

  if (args.skipAnomalies) {
    findings = [
      ...deterministicFindings(ledger, args.period, detectAll(ledger, args.period, glCodeFor)),
      ...reconciled,
    ];
  } else {
    const hunted = await runAnomalyHunter({
      client,
      ledger,
      period: args.period,
      glCodeFor,
      runId: 'run_local',
    });
    const rec = await runReconciler({ client, ledger, period: args.period, runId: 'run_local' });
    const chased = await runReceiptChaser({
      client, ledger, period: args.period, glCodeFor, runId: 'run_local',
    });
    receiptRequests = chased.requested.length;

    findings = [...hunted.findings, ...rec.findings];
    anomalyUsage = {
      inputTokens: hunted.usage.inputTokens + rec.usage.inputTokens + chased.usage.inputTokens,
      outputTokens: hunted.usage.outputTokens + rec.usage.outputTokens + chased.usage.outputTokens,
    };
    anomalyTurns = hunted.turns + rec.turns + chased.turns;
  }
  const anomalyScore = scoreAnomalies(findings, groundTruth);
  const cost = estimateCostUsd(
    args.model,
    result.usage.inputTokens + anomalyUsage.inputTokens,
    result.usage.outputTokens + anomalyUsage.outputTokens,
  );

  if (result.maxTokensHits > 0) {
    console.log('⚠️  TRUNCATED RESPONSE');
    console.log(`  ${result.maxTokensHits} of ${result.batches} batch(es) hit the max-token ceiling`);
    console.log('  mid-response, so their tool calls never completed. Any accuracy');
    console.log('  below is meaningless — lower --batch or raise the ceiling.\n');
  }

  console.log('RESULTS');
  console.log(`  accuracy           ${pct(score.accuracy)}  (${score.correct}/${score.expected} exact GL match)`);
  console.log(`  incorrect          ${score.incorrect}`);
  console.log(`  missing            ${score.missing}`);
  console.log(`  duplicated         ${score.duplicated}`);
  console.log(`  escape hatch 6900  ${pct(score.escapeHatchRate)}  (${score.escapeHatchCorrect} of them correct)`);
  console.log('');
  console.log('VERIFIER BANK');
  console.log(`  blocking failure   ${bank.hasBlockingFailure ? 'YES' : 'no'}`);
  console.log(`  blocked proposals  ${bank.blocked.length}`);
  for (const reason of bank.blockingReasons.slice(0, 3)) {
    console.log(`    - ${reason.slice(0, 140)}`);
  }
  console.log('');
  console.log('ANOMALIES');
  if (receiptRequests > 0) {
    console.log(`  receipts to chase  ${receiptRequests}`);
  }
  console.log(`  findings           ${findings.length}  (${anomalyScore.deterministicFindings} deterministic, ${anomalyScore.modelFindings} model)`);
  console.log(`  overall            P ${anomalyScore.overallPrecision.toFixed(2)}  R ${anomalyScore.overallRecall.toFixed(2)}  F1 ${anomalyScore.overallF1.toFixed(2)}`);
  console.log('  by category:');
  console.log('    kind               planted  found   P     R     source');
  for (const c of anomalyScore.byCategory) {
    console.log(
      `    ${c.kind.padEnd(18)} ${String(c.planted).padStart(4)}  ${String(c.reported).padStart(5)}   `
        + `${c.precision.toFixed(2)}  ${c.recall.toFixed(2)}  ${c.source}`,
    );
  }
  console.log('');
  console.log('COST');
  console.log(`  turns              ${result.turns + anomalyTurns} (${result.turns} categorizer over ${result.batches} batch(es), ${anomalyTurns} anomaly)`);
  console.log(`  tokens in/out      ${result.usage.inputTokens + anomalyUsage.inputTokens} / ${result.usage.outputTokens + anomalyUsage.outputTokens}`);
  console.log(`  cached read        ${result.usage.cacheReadTokens ?? 0}`);
  console.log(`  estimated cost     ${cost === null ? 'n/a' : `$${cost.toFixed(4)}`}`);
  // End to end, not just the categorizer. This line used to stop the clock
  // after categorization and print the result as the run's wall clock,
  // which halved it once the anomaly agents were added.
  console.log(`  wall clock         ${((Date.now() - startedAt) / 1000).toFixed(1)}s  (categorizer ${(categorizerWallClockMs / 1000).toFixed(1)}s)`);

  if (score.worstConfusions.length > 0) {
    console.log('\nTOP CONFUSIONS');
    for (const c of score.worstConfusions) {
      console.log(`  ${c.expected} -> ${c.actual}   ${c.count}x`);
    }
  }

  // The artifact the iOS client consumes. Written on every run, including
  // dry ones — the app needs something to render long before the harness
  // is wired to a real model.
  const artifact = buildCloseRun({
    runId: 'run_local',
    period: args.period,
    model: args.dry ? 'scripted-dry' : args.model,
    dryRun: args.dry,
    ledger,
    transactionCount: transactions.length,
    categorizer: result,
    proposals,
    bank,
    score,
    costUsd: cost,
    startedAt: startedAtDate,
    finishedAt: new Date(),
    findings,
    totals: {
      turns: result.turns + anomalyTurns,
      inputTokens: result.usage.inputTokens + anomalyUsage.inputTokens,
      outputTokens: result.usage.outputTokens + anomalyUsage.outputTokens,
    },
    agents: [
      {
        agent: 'categorizer',
        state: 'complete',
        detail: `${result.categorizations.length} categorized in ${result.batches} batches`,
      },
      {
        agent: 'anomalyHunter',
        state: 'complete',
        detail: `${findings.filter((f) => f.source === 'model').length} judged, ${
          findings.filter((f) => f.source === 'deterministic').length
        } from arithmetic`,
      },
      {
        agent: 'reconciler',
        state: 'complete',
        detail: `${reconciled.length} bank discrepancies`,
      },
      {
        agent: 'receiptChaser',
        state: args.skipAnomalies ? 'pending' : 'complete',
        detail: args.skipAnomalies ? 'skipped' : `${receiptRequests} receipts requested`,
      },
    ],
  });
  mkdirSync(RESULTS_DIR, { recursive: true });
  const artifactPath = `${RESULTS_DIR}latest-run.json`;
  writeFileSync(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`);
  console.log(`\n  wrote ${artifactPath}`);

  if (args.dry) {
    console.log('\n  DRY RUN — the scripted client replays ground truth. This exercises the');
    console.log('  pipeline end to end; it is not a measurement. Drop --dry for a real score.');
  } else {
    mkdirSync(RESULTS_DIR, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const path = `${RESULTS_DIR}${stamp}-categorizer.json`;
    writeFileSync(
      path,
      `${JSON.stringify(
        { period: args.period, model: args.model, transactions: transactions.length, score, usage: result.usage, turns: result.turns, wallClockMs: categorizerWallClockMs, costUsd: cost },
        null,
        2,
      )}\n`,
    );
    console.log(`\n  wrote ${path}`);
  }
  console.log('');
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.stack : err);
  process.exit(1);
});

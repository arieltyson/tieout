/**
 * The close pipeline, driven by an ablation config.
 *
 * One code path serves both the real close and every ablation arm. That is
 * deliberate: if the baseline ran through different code than the variants,
 * the comparison would be measuring the difference between two programs
 * rather than the contribution of one component.
 *
 * Each toggle removes exactly one thing and nothing else.
 */
import {
  deterministicFindings,
  runAnomalyHunter,
  type Finding,
} from '../../harness/src/agents/anomaly-hunter.js';
import { runRawAnomalyHunter } from '../../harness/src/agents/anomaly-hunter-raw.js';
import { runCategorizer } from '../../harness/src/agents/categorizer.js';
import { runFlatAgent } from '../../harness/src/agents/flat-agent.js';
import { reconciliationFindings, runReconciler } from '../../harness/src/agents/reconciler.js';
import { runReceiptChaser } from '../../harness/src/agents/receipt-chaser.js';
import { reconcile } from '../../harness/src/domain/reconcile.js';
import { runBank, type BankResult } from '../../harness/src/domain/bank.js';
import { detectAll } from '../../harness/src/domain/detectors.js';
import type { Ledger, Transaction, TxnId } from '../../harness/src/domain/ledger.js';
import type { Proposal } from '../../harness/src/domain/proposal.js';
import { byPeriod } from '../../harness/src/domain/queries.js';
import { repairUntilClean, type RepairAttempt } from '../../harness/src/loop/repair.js';
import { prefilter, VendorMemory } from '../../harness/src/memory/vendor-memory.js';
import { addUsage, emptyUsage, type ModelClient, type Usage } from '../../harness/src/model/client.js';
import type { CategorizationRecord } from '../../harness/src/tools/categorizer-tools.js';
import type { AblationConfig } from './ablation.js';

export interface PipelineResult {
  readonly categorizations: readonly CategorizationRecord[];
  readonly findings: readonly Finding[];
  readonly proposals: readonly Proposal[];
  readonly bank: BankResult | null;
  readonly repairAttempts: readonly RepairAttempt[];
  readonly usage: Usage;
  readonly turns: number;
  readonly batches: number;
  readonly maxTokensHits: number;
  /** Resolved from vendor memory, so never sent to the model. */
  readonly memoryHits: number;
  readonly wallClockMs: number;
  /** Receipts the chaser judged worth asking about. */
  readonly receiptRequests: number;
}

export interface PipelineOptions {
  readonly client: ModelClient;
  readonly ledger: Ledger;
  readonly period: string;
  readonly config: AblationConfig;
  readonly memory?: VendorMemory | undefined;
  readonly limit?: number | undefined;
  readonly batchSize?: number | undefined;
  readonly onProgress?: (message: string) => void;
}

function toProposals(
  categorizations: readonly CategorizationRecord[],
  runId: string,
): Proposal[] {
  return categorizations.map((c, i) => ({
    id: `prop_${String(i + 1).padStart(4, '0')}`,
    runId,
    sourceAgent: 'categorizer' as const,
    kind: { type: 'categorize' as const, txnId: c.txnId, glCode: c.glCode },
    evidence: [{ runId, seq: c.toolCallSeq }],
    confidence: c.confidence,
    idempotencyKey: `categorize:${c.txnId}:${c.glCode}`,
    rationale: c.rationale,
  }));
}

export async function runPipeline(options: PipelineOptions): Promise<PipelineResult> {
  const { client, ledger, period, config } = options;
  const startedAt = Date.now();
  const progress = options.onProgress ?? (() => {});

  let transactions: readonly Transaction[] = byPeriod(ledger, period);
  if (options.limit !== undefined) transactions = transactions.slice(0, options.limit);

  let usage = emptyUsage();
  let turns = 0;
  let batches = 0;
  let maxTokensHits = 0;
  let memoryHits = 0;
  let receiptRequests = 0;
  let categorizations: CategorizationRecord[] = [];
  const modelFindings: Finding[] = [];

  // --- Vendor memory -----------------------------------------------------
  // Applied in code before the model sees anything. On a first close the
  // memory is empty and this changes nothing, which is the honest shape of
  // the feature: it pays for itself on the second close, not the first.
  let toCategorize: readonly Transaction[] = transactions;
  if (config.vendorMemory && options.memory) {
    const split = prefilter(options.memory, transactions);
    memoryHits = split.known.length;
    toCategorize = split.unknown;
    for (const { transaction, match } of split.known) {
      categorizations.push({
        txnId: transaction.id,
        glCode: match.glCode,
        rationale: `Vendor memory, ${match.matchedOn} match, seen ${match.confidence} time(s).`,
        confidence: 'high',
        toolCallSeq: 0,
      });
    }
    progress(`vendor memory resolved ${memoryHits}/${transactions.length} without the model`);
  }

  // --- Categorization and anomalies --------------------------------------
  if (!config.subAgentIsolation) {
    // One agent, one context, both jobs.
    const flat = await runFlatAgent({ client, ledger, transactions: toCategorize });
    categorizations = [...categorizations, ...flat.categorizations];
    usage = addUsage(usage, flat.usage);
    turns += flat.turns;
    batches += 1;
    maxTokensHits += flat.maxTokensHits;

    const glByTxn = new Map(categorizations.map((c) => [c.txnId, c.glCode]));
    modelFindings.push(
      ...deterministicFindings(ledger, period, detectAll(ledger, period, (id) => glByTxn.get(id))),
      ...reconciliationFindings(reconcile(ledger, period)),
    );
    for (const v of flat.duplicateVerdicts) {
      if (!v.isDuplicate) continue;
      modelFindings.push({
        kind: 'duplicate',
        txnIds: v.txnIds,
        summary: v.rationale,
        materialityCents: null,
        source: 'model',
      });
    }
    const byDescriptor = new Map<string, TxnId[]>();
    for (const t of ledger.transactions) {
      const list = byDescriptor.get(t.vendorDescriptor);
      if (list) list.push(t.id);
      else byDescriptor.set(t.vendorDescriptor, [t.id]);
    }
    for (const g of flat.aliasGroups) {
      modelFindings.push({
        kind: 'vendorAlias',
        txnIds: g.descriptors.flatMap((d) => byDescriptor.get(d) ?? []),
        summary: `${g.canonicalVendor}: ${g.rationale}`,
        materialityCents: null,
        source: 'model',
      });
    }
  } else {
    if (toCategorize.length > 0) {
      const cat = await runCategorizer({
        client,
        ledger,
        transactions: toCategorize,
        ...(options.batchSize !== undefined ? { batchSize: options.batchSize } : {}),
        onBatch: (done, total) => progress(`categorizing ${done}/${total}`),
      });
      categorizations = [...categorizations, ...cat.categorizations];
      usage = addUsage(usage, cat.usage);
      turns += cat.turns;
      batches += cat.batches;
      maxTokensHits += cat.maxTokensHits;
    }

    const glByTxn = new Map(categorizations.map((c) => [c.txnId, c.glCode]));
    const glCodeFor = (id: TxnId) => glByTxn.get(id);

    if (config.deterministicPrePass) {
      const hunted = await runAnomalyHunter({ client, ledger, period, glCodeFor });
      modelFindings.push(...hunted.findings);
      usage = addUsage(usage, hunted.usage);
      turns += hunted.turns;
      maxTokensHits += hunted.maxTokensHits;

      // Reconciliation and receipt chasing sit behind the same toggle: both
      // are a deterministic pass with a model only for what it cannot
      // settle. Removing the pre-pass removes them too, which is the
      // honest thing for the ablation to measure.
      const reconciled = await runReconciler({ client, ledger, period });
      modelFindings.push(...reconciled.findings);
      usage = addUsage(usage, reconciled.usage);
      turns += reconciled.turns;
      maxTokensHits += reconciled.maxTokensHits;

      const chased = await runReceiptChaser({ client, ledger, period, glCodeFor });
      receiptRequests = chased.requested.length;
      usage = addUsage(usage, chased.usage);
      turns += chased.turns;
      maxTokensHits += chased.maxTokensHits;
    } else {
      // No detectors. The model searches the raw ledger itself.
      const raw = await runRawAnomalyHunter({ client, ledger, period });
      modelFindings.push(...raw.findings);
      usage = addUsage(usage, raw.usage);
      turns += raw.turns;
      maxTokensHits += raw.maxTokensHits;
    }
  }

  // --- Verification and repair -------------------------------------------
  let proposals = toProposals(categorizations, 'run_pipeline');
  let bank: BankResult | null = null;
  let repairAttempts: readonly RepairAttempt[] = [];

  if (config.deterministicVerifiers) {
    const scoped = { ...ledger, transactions: [...transactions] };
    if (config.selfCorrection) {
      // The retry here is a no op stand in: with no repair-capable agent
      // wired to the categorizer yet, resubmitting the same set is the
      // honest behaviour. The cycle still runs, still bounds itself, and
      // still escalates, so the toggle measures the cycle's cost rather
      // than pretending at a capability that does not exist.
      const outcome = await repairUntilClean(proposals, scoped, async (current) => current);
      proposals = [...outcome.proposals];
      bank = outcome.bank;
      repairAttempts = outcome.attempts;
    } else {
      bank = runBank(proposals, scoped);
    }
  }

  return {
    categorizations,
    findings: modelFindings,
    proposals,
    bank,
    repairAttempts,
    usage,
    turns,
    batches,
    maxTokensHits,
    memoryHits,
    wallClockMs: Date.now() - startedAt,
    receiptRequests,
  };
}

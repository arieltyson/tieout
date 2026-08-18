/**
 * The orchestrator.
 *
 * Plans a close, dispatches the specialists, and assembles what they send
 * back. It never reads the ledger itself, which is the point: the
 * categorizer may chew through four hundred rows to do its job, and if that
 * happened in this context window the orchestrator would lose the plot by
 * the third agent.
 *
 * Each specialist returns a SUMMARY rather than its working. That is the
 * property that makes the architecture scale, so it is asserted in a test
 * rather than left as an intention.
 *
 * Partial failure is normal rather than exceptional. If one agent dies the
 * close continues and reports what the others produced, because a month end
 * that fails entirely because receipts were unavailable is worse than one
 * that closes with a gap it tells you about.
 */
import type { Ledger } from '../domain/ledger.js';
import type { Proposal } from '../domain/proposal.js';
import type { ModelClient, Usage } from '../model/client.js';
import { addUsage, emptyUsage } from '../model/client.js';
import { CheckpointStore } from '../store/checkpoint.js';
import type { AuditLog } from '../store/audit-log.js';
import type { AgentKind } from '../tools/dispatch.js';

export interface AgentSummary {
  readonly agent: AgentKind;
  readonly ok: boolean;
  /** One line a human could read. Never raw rows. */
  readonly headline: string;
  readonly proposals: readonly Proposal[];
  readonly findings: number;
  readonly usage: Usage;
  readonly turns: number;
  /** Present only when the agent failed. */
  readonly error?: string;
}

export interface AgentTask {
  readonly agent: AgentKind;
  run(client: ModelClient, ledger: Ledger): Promise<Omit<AgentSummary, 'agent' | 'ok'>>;
}

export interface OrchestratorResult {
  readonly runId: string;
  readonly summaries: readonly AgentSummary[];
  readonly proposals: readonly Proposal[];
  readonly usage: Usage;
  readonly failed: readonly AgentKind[];
  /** The orchestrator's own context, for the size assertion. */
  readonly contextChars: number;
}

export interface OrchestratorOptions {
  readonly runId: string;
  readonly period: string;
  readonly client: ModelClient;
  readonly ledger: Ledger;
  readonly tasks: readonly AgentTask[];
  readonly checkpoints?: CheckpointStore | undefined;
  readonly audit?: AuditLog | undefined;
  readonly onProgress?: (message: string) => void;
}

/**
 * What the orchestrator holds in mind: one line per agent and nothing else.
 *
 * Kept as a function so a test can measure it. If this ever starts
 * accumulating transactions, the size assertion fails and somebody has to
 * argue for it rather than discovering the cost in a bill.
 */
export function renderContext(period: string, summaries: readonly AgentSummary[]): string {
  const lines = [`Close ${period}.`, ''];
  for (const s of summaries) {
    lines.push(`${s.agent}: ${s.ok ? s.headline : `FAILED, ${s.error ?? 'unknown'}`}`);
  }
  return lines.join('\n');
}

export async function runOrchestrator(
  options: OrchestratorOptions,
): Promise<OrchestratorResult> {
  const { runId, period, client, ledger, tasks } = options;
  const progress = options.onProgress ?? (() => {});
  const checkpoints = options.checkpoints;

  if (checkpoints && !checkpoints.exists(runId)) checkpoints.create(runId, period);
  checkpoints?.advance(runId, { type: 'dispatch' });
  progress(`dispatching ${tasks.length} agents`);

  // allSettled rather than all. One specialist failing must not take the
  // close with it.
  const settled = await Promise.allSettled(
    tasks.map(async (task) => ({ task, result: await task.run(client, ledger) })),
  );

  const summaries: AgentSummary[] = settled.map((outcome, i) => {
    const agent = tasks[i]!.agent;
    if (outcome.status === 'fulfilled') {
      return { agent, ok: true, ...outcome.value.result };
    }
    const error = outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason);
    return {
      agent, ok: false, headline: 'did not complete', proposals: [], findings: 0,
      usage: emptyUsage(), turns: 0, error,
    };
  });

  for (const s of summaries) {
    options.audit?.append({
      runId, seq: summaries.indexOf(s) + 1, agent: s.agent, tool: 'agent_run',
      args: { period }, result: { ok: s.ok, headline: s.headline, findings: s.findings },
      durationMs: 0, isError: !s.ok, tokensIn: s.usage.inputTokens, tokensOut: s.usage.outputTokens,
    });
  }

  const proposals = summaries.flatMap((s) => [...s.proposals]);
  const usage = summaries.reduce((acc, s) => addUsage(acc, s.usage), emptyUsage());
  const failed = summaries.filter((s) => !s.ok).map((s) => s.agent);

  checkpoints?.saveProposals(runId, proposals);
  checkpoints?.advance(runId, { type: 'agentsComplete' });
  progress(`${summaries.length - failed.length}/${summaries.length} agents complete`);

  return {
    runId,
    summaries,
    proposals,
    usage,
    failed,
    contextChars: renderContext(period, summaries).length,
  };
}

/** Which specialists a close needs. Nothing is dispatched that has no work. */
export function planAgents(
  available: readonly AgentTask[],
  wanted: readonly AgentKind[],
): readonly AgentTask[] {
  return available.filter((t) => wanted.includes(t.agent));
}

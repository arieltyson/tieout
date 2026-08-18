import { beforeEach, describe, expect, test, vi } from 'vitest';
import { emptyUsage, type ModelClient } from '../src/model/client.js';
import {
  planAgents, renderContext, runOrchestrator, type AgentSummary, type AgentTask,
} from '../src/loop/orchestrator.js';
import { AuditLog } from '../src/store/audit-log.js';
import { CheckpointStore } from '../src/store/checkpoint.js';
import type { AgentKind } from '../src/tools/dispatch.js';
import * as f from './support/proposals.js';

const client = { name: 'unused', complete: async () => { throw new Error('never called'); } } as ModelClient;

beforeEach(() => f.resetProposalIds());

const task = (agent: AgentKind, over: Partial<Awaited<ReturnType<AgentTask['run']>>> = {}): AgentTask => ({
  agent,
  run: async () => ({
    headline: `${agent} did its job`, proposals: [], findings: 2,
    usage: { inputTokens: 100, outputTokens: 50 }, turns: 3, ...over,
  }),
});

const failing = (agent: AgentKind, message: string): AgentTask => ({
  agent, run: async () => { throw new Error(message); },
});

const base = { runId: 'r1', period: '2026-06', client, ledger: f.smallLedger() };

describe('dispatch', () => {
  test('runs every agent and collects a summary each', async () => {
    const result = await runOrchestrator({
      ...base, tasks: [task('categorizer'), task('anomalyHunter')],
    });
    expect(result.summaries.map((s) => s.agent)).toEqual(['categorizer', 'anomalyHunter']);
    expect(result.summaries.every((s) => s.ok)).toBe(true);
  });

  test('agents run concurrently rather than one after another', async () => {
    const started: number[] = [];
    const slow = (agent: AgentKind): AgentTask => ({
      agent,
      run: async () => {
        started.push(Date.now());
        await new Promise((r) => setTimeout(r, 30));
        return { headline: 'x', proposals: [], findings: 0, usage: emptyUsage(), turns: 1 };
      },
    });
    const began = Date.now();
    await runOrchestrator({ ...base, tasks: [slow('categorizer'), slow('anomalyHunter'), slow('reconciler')] });
    // Serial would take at least 90ms. Concurrent finishes in roughly 30.
    expect(Date.now() - began).toBeLessThan(80);
    expect(started).toHaveLength(3);
  });

  test('aggregates usage across agents', async () => {
    const result = await runOrchestrator({ ...base, tasks: [task('categorizer'), task('anomalyHunter')] });
    expect(result.usage.inputTokens).toBe(200);
    expect(result.usage.outputTokens).toBe(100);
  });
});

describe('partial failure is survivable', () => {
  test('one agent dying does not take the close with it', async () => {
    // A month end that fails entirely because receipts were unavailable is
    // worse than one that closes with a gap it tells you about.
    const result = await runOrchestrator({
      ...base,
      tasks: [task('categorizer'), failing('receiptChaser', 'photo library unavailable')],
    });
    expect(result.failed).toEqual(['receiptChaser']);
    expect(result.summaries.find((s) => s.agent === 'categorizer')?.ok).toBe(true);
  });

  test('the failure reason survives into the summary', async () => {
    const result = await runOrchestrator({
      ...base, tasks: [failing('receiptChaser', 'photo library unavailable')],
    });
    expect(result.summaries[0]!.error).toContain('photo library unavailable');
  });

  test('every agent failing still returns a result rather than throwing', async () => {
    const result = await runOrchestrator({
      ...base, tasks: [failing('categorizer', 'a'), failing('anomalyHunter', 'b')],
    });
    expect(result.failed).toHaveLength(2);
    expect(result.proposals).toEqual([]);
  });

  test('proposals from surviving agents are still collected', async () => {
    const proposals = f.validCategorizations();
    const result = await runOrchestrator({
      ...base,
      tasks: [task('categorizer', { proposals }), failing('anomalyHunter', 'boom')],
    });
    expect(result.proposals).toHaveLength(3);
  });
});

describe('the orchestrator context stays small', () => {
  // The property that makes the architecture scale. Asserted rather than
  // intended: if this ever starts accumulating rows, it fails here.
  test('is a few hundred characters regardless of ledger size', async () => {
    const bigLedger = f.ledger(
      Array.from({ length: 400 }, (_, i) =>
        f.transaction(`txn_${String(i + 1).padStart(4, '0')}`, 1000 as never)),
    );
    const result = await runOrchestrator({
      ...base, ledger: bigLedger,
      tasks: [task('categorizer'), task('anomalyHunter'), task('reconciler'), task('receiptChaser')],
    });
    // Four agents, one line each. Roughly 4k tokens is 16k characters, and
    // this should be nowhere near it.
    expect(result.contextChars).toBeLessThan(1000);
  });

  test('a summary never carries raw transactions', async () => {
    const proposals = f.validCategorizations();
    const result = await runOrchestrator({ ...base, tasks: [task('categorizer', { proposals })] });
    const context = renderContext('2026-06', result.summaries as AgentSummary[]);
    expect(context).not.toContain('vendorDescriptor');
    expect(context).not.toContain('txn_0001');
  });

  test('a failed agent is named in the context, not hidden', () => {
    const context = renderContext('2026-06', [{
      agent: 'receiptChaser', ok: false, headline: 'did not complete', proposals: [],
      findings: 0, usage: emptyUsage(), turns: 0, error: 'photo library unavailable',
    }]);
    expect(context).toContain('FAILED');
    expect(context).toContain('photo library unavailable');
  });
});

describe('state and audit are recorded as it goes', () => {
  test('the run advances through dispatch and verification', async () => {
    const store = new CheckpointStore(':memory:');
    try {
      await runOrchestrator({ ...base, tasks: [task('categorizer')], checkpoints: store });
      expect(store.load('r1').state).toBe('verifying');
      expect(store.history('r1').map((h) => h.state)).toEqual(['planning', 'dispatched', 'verifying']);
    } finally { store.close(); }
  });

  test('proposals are checkpointed before verification', async () => {
    const store = new CheckpointStore(':memory:');
    try {
      await runOrchestrator({
        ...base, tasks: [task('categorizer', { proposals: f.validCategorizations() })],
        checkpoints: store,
      });
      expect(store.load('r1').proposals).toHaveLength(3);
    } finally { store.close(); }
  });

  test('a failed agent is written to the audit log as an error', async () => {
    const audit = new AuditLog(':memory:');
    try {
      await runOrchestrator({ ...base, tasks: [failing('receiptChaser', 'boom')], audit });
      const entries = audit.replay('r1');
      expect(entries).toHaveLength(1);
      expect(entries[0]!.isError).toBe(true);
    } finally { audit.close(); }
  });
});

describe('planning', () => {
  test('dispatches only the agents asked for', () => {
    const available = [task('categorizer'), task('anomalyHunter'), task('receiptChaser')];
    expect(planAgents(available, ['categorizer']).map((t) => t.agent)).toEqual(['categorizer']);
  });

  test('asking for nothing dispatches nothing', () => {
    expect(planAgents([task('categorizer')], [])).toEqual([]);
  });
});

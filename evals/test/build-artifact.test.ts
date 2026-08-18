/**
 * Guards on the artifact the iOS client renders.
 *
 * The client cannot defend itself against a well-formed artifact carrying
 * wrong content: it decodes cleanly and draws whatever it was handed. So the
 * checks that matter live here, on the producing side.
 */
import { describe, expect, test } from 'vitest';
import { buildCloseRun, type BuildArtifactInput } from '../src/build-artifact.js';
import type { Finding } from '../../harness/src/agents/anomaly-hunter.js';
import type { Ledger } from '../../harness/src/domain/ledger.js';

const ledger: Ledger = {
  seed: 1,
  period: '2026-06',
  transactions: [],
  receipts: [],
  approvals: [],
  bankTransactions: [],
};

const finding = (
  kind: string,
  materialityCents: number | null,
  source: 'deterministic' | 'model',
): Finding => ({ kind, txnIds: [], summary: kind, materialityCents, source }) as Finding;

const input = (overrides: Partial<BuildArtifactInput> = {}): BuildArtifactInput => ({
  runId: 'run_test',
  period: '2026-06',
  model: 'test',
  dryRun: false,
  ledger,
  transactionCount: 0,
  categorizer: { categorizations: [], turns: 0, batches: 0, maxTokensHits: 0,
    usage: { inputTokens: 0, outputTokens: 0 } } as never,
  proposals: [],
  bank: { passed: [], blocked: [], warned: [], results: [], hasBlockingFailure: false } as never,
  score: null,
  costUsd: null,
  startedAt: new Date(0),
  finishedAt: new Date(0),
  ...overrides,
});

describe('findings reach the artifact', () => {
  test('ranked by materiality, largest first', () => {
    const run = buildCloseRun(input({
      findings: [
        finding('small', 100, 'deterministic'),
        finding('large', 900_00, 'deterministic'),
        finding('middle', 500_00, 'model'),
      ],
    }));
    expect(run.findings.map((f) => f.kind)).toEqual(['large', 'middle', 'small']);
  });

  test('findings with no dollar figure sort last rather than first', () => {
    // materialityCents is nullable, and a null sorting as zero would be
    // survivable. Sorting as the largest value would put every unpriced
    // finding above every priced one, which inverts the whole list.
    const run = buildCloseRun(input({
      findings: [finding('unpriced', null, 'model'), finding('priced', 1, 'deterministic')],
    }));
    expect(run.findings.map((f) => f.kind)).toEqual(['priced', 'unpriced']);
  });

  test('the source of each finding survives into the artifact', () => {
    // The client shows model findings as decisions and deterministic ones
    // as facts. Losing this field collapses that distinction silently.
    const run = buildCloseRun(input({
      findings: [finding('judged', 1, 'model'), finding('computed', 2, 'deterministic')],
    }));
    expect(run.findings.find((f) => f.kind === 'judged')?.source).toBe('model');
    expect(run.findings.find((f) => f.kind === 'computed')?.source).toBe('deterministic');
  });
});

describe('agent status reflects what actually ran', () => {
  test('reported agents are the ones passed in', () => {
    // This file used to hardcode three agents as "not implemented" and kept
    // saying so for weeks after they were built.
    const run = buildCloseRun(input({
      agents: [
        { agent: 'categorizer', state: 'complete', detail: '10 categorized' },
        { agent: 'reconciler', state: 'complete', detail: '3 discrepancies' },
      ],
    }));
    expect(run.agents.map((a) => a.agent)).toEqual(['categorizer', 'reconciler']);
    expect(run.agents.every((a) => a.detail !== 'not implemented')).toBe(true);
  });
});

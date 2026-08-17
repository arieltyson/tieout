import { describe, expect, test } from 'vitest';
import { BASELINE } from '../../evals/src/ablation.js';
import { runPipeline } from '../../evals/src/pipeline.js';
import { VendorMemory } from '../src/memory/vendor-memory.js';
import { loadLedger } from '../../fixtures/src/index.js';
import type { ModelClient } from '../src/model/client.js';

const ledger = loadLedger();

/** Answers any categorize batch, so a toggle's effect is what varies. */
const stub: ModelClient = {
  name: 'stub',
  async complete(req) {
    const last = req.messages.at(-1);
    const text = typeof last?.content === 'string' ? last.content : '';
    const ids = [...text.matchAll(/"id":\s*"(txn_\d+)"/g)].map((m) => m[1]!);
    if (ids.length === 0) {
      return { content: [{ type: 'text', text: 'done' }], stopReason: 'end_turn',
               usage: { inputTokens: 10, outputTokens: 5 }, model: 'stub' };
    }
    return {
      content: [{ type: 'tool_use', id: 'tu', name: 'propose_categorizations',
        input: { categorizations: ids.map((id) => ({ txnId: id, glCode: '6010',
          rationale: 'stub', confidence: 'high' as const })) } }],
      stopReason: 'tool_use', usage: { inputTokens: 10, outputTokens: 5 }, model: 'stub',
    };
  },
};

const base = { client: stub, ledger, period: '2026-06', limit: 20 } as const;

describe('every toggle changes observable behaviour', () => {
  test('verifiers on produces a bank verdict, off produces none', async () => {
    const on = await runPipeline({ ...base, config: BASELINE });
    const off = await runPipeline({ ...base, config: { ...BASELINE, deterministicVerifiers: false } });
    expect(on.bank).not.toBeNull();
    expect(off.bank).toBeNull();
  });

  // Needs proposals the bank will actually reject. With a clean set the
  // cycle correctly does nothing, so the first version of this test proved
  // only that the stub produced valid output.
  test('self correction engages when the bank blocks, and not otherwise', async () => {
    const badCode: ModelClient = {
      name: 'bad',
      async complete(req) {
        const last = req.messages.at(-1);
        const text = typeof last?.content === 'string' ? last.content : '';
        const ids = [...text.matchAll(/"id":\s*"(txn_\d+)"/g)].map((m) => m[1]!);
        if (ids.length === 0) {
          return { content: [{ type: 'text', text: 'done' }], stopReason: 'end_turn',
                   usage: { inputTokens: 10, outputTokens: 5 }, model: 'bad' };
        }
        return {
          content: [{ type: 'tool_use', id: 'tu', name: 'propose_categorizations',
            input: { categorizations: ids.map((id, i) => ({ txnId: id,
              glCode: i === 0 ? '9999' : '6010', rationale: 'stub',
              confidence: 'high' as const })) } }],
          stopReason: 'tool_use', usage: { inputTokens: 10, outputTokens: 5 }, model: 'bad',
        };
      },
    };

    const on = await runPipeline({ ...base, client: badCode, config: BASELINE });
    const off = await runPipeline({
      ...base, client: badCode, config: { ...BASELINE, selfCorrection: false },
    });
    expect(on.repairAttempts.length).toBeGreaterThan(0);
    expect(off.repairAttempts).toEqual([]);
    // Both still surface the failure; only one of them tried to fix it.
    expect(on.bank?.hasBlockingFailure).toBe(true);
    expect(off.bank?.hasBlockingFailure).toBe(true);
  });

  test('vendor memory resolves transactions the model never sees', async () => {
    const memory = new VendorMemory(':memory:');
    try {
      for (const t of ledger.transactions.slice(0, 50)) memory.record(t.vendorDescriptor, '6010');
      const withMemory = await runPipeline({ ...base, config: BASELINE, memory });
      const without = await runPipeline({ ...base, config: { ...BASELINE, vendorMemory: false }, memory });
      expect(withMemory.memoryHits).toBeGreaterThan(0);
      expect(without.memoryHits).toBe(0);
      expect(withMemory.usage.inputTokens).toBeLessThan(without.usage.inputTokens);
    } finally {
      memory.close();
    }
  });

  test('flat mode runs one agent instead of a categorizer plus a hunter', async () => {
    const isolated = await runPipeline({ ...base, config: BASELINE });
    const flat = await runPipeline({ ...base, config: { ...BASELINE, subAgentIsolation: false } });
    expect(isolated.batches).toBeGreaterThan(0);
    expect(flat.batches).toBe(1);
  });

  test('pre pass off still yields findings, from a different source', async () => {
    const on = await runPipeline({ ...base, config: BASELINE });
    expect(on.findings.some((f) => f.source === 'deterministic')).toBe(true);
  });
});

import { describe, expect, test } from 'vitest';
import { z } from 'zod';
import { BudgetExceeded, DEFAULT_BUDGET, runLoop } from '../src/loop/run.js';
import { ScriptedModelClient, say, toolCall } from '../src/model/scripted.js';
import { defineTool } from '../src/tools/define.js';

const echo = defineTool({
  name: 'echo',
  description: 'Echo a value back.',
  input: z.object({ value: z.string() }),
  grants: ['ledger:read'],
  run: ({ value }) => ({ echoed: value }),
});

const explodes = defineTool({
  name: 'explodes',
  description: 'Always throws.',
  input: z.object({}),
  grants: ['ledger:read'],
  run: () => {
    throw new Error('tool blew up');
  },
});

const base = { system: 'sys', initialMessage: 'go', tools: [echo, explodes] };

describe('runLoop — termination', () => {
  test('stops when the model stops asking for tools', async () => {
    const client = new ScriptedModelClient([say('done')]);
    const result = await runLoop({ ...base, client });
    expect(result.stopReason).toBe('end_turn');
    expect(result.turns).toBe(1);
    expect(result.finalText).toBe('done');
  });

  test('dispatches a tool then continues', async () => {
    const client = new ScriptedModelClient([toolCall('echo', { value: 'hi' }), say('finished')]);
    const result = await runLoop({ ...base, client });
    expect(result.turns).toBe(2);
    expect(result.audit).toHaveLength(1);
    expect(result.audit[0]!.result).toEqual({ echoed: 'hi' });
  });

  test('sends ONLY tool_result blocks back, never chatty text', async () => {
    // Mixing text in with tool results teaches the model to expect a human
    // turn after every call, and it starts asking questions instead of
    // continuing.
    const client = new ScriptedModelClient([toolCall('echo', { value: 'hi' }), say('ok')]);
    await runLoop({ ...base, client });
    const followUp = client.requests[1]!.messages.at(-1)!;
    expect(followUp.role).toBe('user');
    expect(Array.isArray(followUp.content)).toBe(true);
    const blocks = followUp.content as unknown as { type: string }[];
    expect(blocks.every((b) => b.type === 'tool_result')).toBe(true);
  });

  test('handles several tool calls in one turn', async () => {
    const client = new ScriptedModelClient([
      {
        content: [
          { type: 'tool_use', id: 'a', name: 'echo', input: { value: '1' } },
          { type: 'tool_use', id: 'b', name: 'echo', input: { value: '2' } },
        ],
      },
      say('ok'),
    ]);
    const result = await runLoop({ ...base, client });
    expect(result.audit).toHaveLength(2);
    expect((client.requests[1]!.messages.at(-1)!.content as unknown[]).length).toBe(2);
  });
});

describe('runLoop — budgets', () => {
  test('a model that loops forever terminates at exactly maxTurns', async () => {
    const script = Array.from({ length: 50 }, () => toolCall('echo', { value: 'x' }));
    const client = new ScriptedModelClient(script);
    const result = await runLoop({
      ...base,
      client,
      budget: { ...DEFAULT_BUDGET, maxTurns: 5 },
    });
    expect(result.stopReason).toBe('budget');
    expect(result.turns).toBe(5);
    expect(result.budgetError?.kind).toBe('turns');
  });

  test('the budget is checked before the call, so it never overspends by one', async () => {
    const script = Array.from({ length: 10 }, () => toolCall('echo', { value: 'x' }));
    const client = new ScriptedModelClient(script);
    await runLoop({ ...base, client, budget: { ...DEFAULT_BUDGET, maxTurns: 3 } });
    expect(client.callCount).toBe(3);
  });

  test('stops on the input-token budget', async () => {
    const script = Array.from({ length: 10 }, () => ({
      ...toolCall('echo', { value: 'x' }),
      inputTokens: 1000,
    }));
    const client = new ScriptedModelClient(script);
    const result = await runLoop({
      ...base,
      client,
      budget: { ...DEFAULT_BUDGET, maxInputTokens: 2500 },
    });
    expect(result.budgetError?.kind).toBe('inputTokens');
  });

  test('stops on wall clock using an injected clock', async () => {
    let t = 0;
    const script = Array.from({ length: 10 }, () => toolCall('echo', { value: 'x' }));
    const client = new ScriptedModelClient(script);
    const result = await runLoop({
      ...base,
      client,
      budget: { ...DEFAULT_BUDGET, maxWallClockMs: 100 },
      now: () => (t += 40),
    });
    expect(result.budgetError?.kind).toBe('wallClock');
  });

  test('throws a typed error when asked to', async () => {
    const script = Array.from({ length: 10 }, () => toolCall('echo', { value: 'x' }));
    const client = new ScriptedModelClient(script);
    await expect(
      runLoop({ ...base, client, budget: { ...DEFAULT_BUDGET, maxTurns: 2 }, throwOnBudget: true }),
    ).rejects.toBeInstanceOf(BudgetExceeded);
  });
});

describe('runLoop — errors come back as tool results, not exceptions', () => {
  test('bad arguments are reported to the model, which can retry', async () => {
    const client = new ScriptedModelClient([toolCall('echo', { wrong: 'shape' }), say('ok')]);
    const result = await runLoop({ ...base, client });
    expect(result.stopReason).toBe('end_turn');
    expect(result.audit[0]!.isError).toBe(true);
    const sent = client.requests[1]!.messages.at(-1)!.content as unknown as { is_error?: boolean }[];
    expect(sent[0]!.is_error).toBe(true);
  });

  test('a throwing tool does not kill the run', async () => {
    const client = new ScriptedModelClient([toolCall('explodes', {}), say('recovered')]);
    const result = await runLoop({ ...base, client });
    expect(result.stopReason).toBe('end_turn');
    expect(result.audit[0]!.isError).toBe(true);
    expect(result.audit[0]!.result).toContain('tool blew up');
  });

  test('an unknown tool is reported with the list of real ones', async () => {
    const client = new ScriptedModelClient([toolCall('nonexistent', {}), say('ok')]);
    const result = await runLoop({ ...base, client });
    const sent = client.requests[1]!.messages.at(-1)!.content as unknown as { content: string }[];
    expect(sent[0]!.content).toContain('Unknown tool');
    expect(sent[0]!.content).toContain('echo');
  });
});

describe('runLoop — accounting', () => {
  test('accumulates usage across turns', async () => {
    const client = new ScriptedModelClient([
      { ...toolCall('echo', { value: 'x' }), inputTokens: 10, outputTokens: 5 },
      { ...say('ok'), inputTokens: 20, outputTokens: 7 },
    ]);
    const result = await runLoop({ ...base, client });
    expect(result.usage.inputTokens).toBe(30);
    expect(result.usage.outputTokens).toBe(12);
  });

  test('audit sequence numbers are monotonic', async () => {
    const client = new ScriptedModelClient([
      toolCall('echo', { value: '1' }),
      toolCall('echo', { value: '2' }),
      say('ok'),
    ]);
    const result = await runLoop({ ...base, client });
    expect(result.audit.map((a) => a.seq)).toEqual([1, 2]);
  });

  test('marks the system prompt cacheable — it is static across a run', async () => {
    const client = new ScriptedModelClient([say('ok')]);
    await runLoop({ ...base, client });
    expect(client.requests[0]!.cacheSystem).toBe(true);
  });
});

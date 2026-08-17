/**
 * The tool-use loop.
 *
 * call model -> if stop_reason is tool_use, dispatch every tool_use block ->
 * append the results as a SINGLE user message -> repeat.
 *
 * The subtle part is that the user message must contain ONLY tool_result
 * blocks. Appending a chatty "here are your results" alongside them teaches
 * the model to expect a human turn after every tool call, and it starts
 * asking questions instead of continuing.
 */
import { z } from 'zod';
import {
  addUsage,
  emptyUsage,
  type CompleteResponse,
  type Message,
  type ModelClient,
  type ToolResultBlock,
  type Usage,
} from '../model/client.js';
import { toToolSpec, type ToolContext, type ToolDefinition } from '../tools/define.js';

export interface RunBudget {
  readonly maxTurns: number;
  readonly maxInputTokens: number;
  readonly maxOutputTokens: number;
  readonly maxWallClockMs: number;
}

export const DEFAULT_BUDGET: RunBudget = {
  maxTurns: 12,
  maxInputTokens: 400_000,
  maxOutputTokens: 60_000,
  maxWallClockMs: 5 * 60_000,
};

export type BudgetKind = 'turns' | 'inputTokens' | 'outputTokens' | 'wallClock';

export class BudgetExceeded extends Error {
  constructor(
    readonly kind: BudgetKind,
    readonly limit: number,
    readonly actual: number,
  ) {
    super(`Budget exceeded: ${kind} reached ${actual}, limit ${limit}`);
    this.name = 'BudgetExceeded';
  }
}

export interface AuditEntry {
  readonly seq: number;
  readonly tool: string;
  readonly args: unknown;
  readonly result: unknown;
  readonly durationMs: number;
  readonly isError: boolean;
}

export interface LoopResult {
  readonly messages: readonly Message[];
  readonly usage: Usage;
  readonly turns: number;
  readonly audit: readonly AuditEntry[];
  readonly stopReason: 'end_turn' | 'budget' | 'max_tokens';
  readonly budgetError?: BudgetExceeded;
  readonly finalText: string;
}

export interface RunLoopOptions {
  readonly client: ModelClient;
  readonly system: string;
  readonly initialMessage: string;
  readonly tools: readonly ToolDefinition[];
  readonly budget?: RunBudget;
  readonly maxTokensPerCall?: number;
  readonly runId?: string;
  /** Throwing on budget is the caller's choice; the default reports instead. */
  readonly throwOnBudget?: boolean;
  readonly now?: () => number;
}

export async function runLoop(options: RunLoopOptions): Promise<LoopResult> {
  const budget = options.budget ?? DEFAULT_BUDGET;
  const now = options.now ?? (() => Date.now());
  const runId = options.runId ?? 'run_local';
  const startedAt = now();

  const byName = new Map(options.tools.map((t) => [t.name, t]));
  const specs = options.tools.map(toToolSpec);

  const messages: Message[] = [{ role: 'user', content: options.initialMessage }];
  const audit: AuditEntry[] = [];
  let usage = emptyUsage();
  let turns = 0;
  let seq = 0;
  let finalText = '';

  const overBudget = (): BudgetExceeded | undefined => {
    if (turns >= budget.maxTurns) return new BudgetExceeded('turns', budget.maxTurns, turns);
    if (usage.inputTokens >= budget.maxInputTokens) {
      return new BudgetExceeded('inputTokens', budget.maxInputTokens, usage.inputTokens);
    }
    if (usage.outputTokens >= budget.maxOutputTokens) {
      return new BudgetExceeded('outputTokens', budget.maxOutputTokens, usage.outputTokens);
    }
    const elapsed = now() - startedAt;
    if (elapsed >= budget.maxWallClockMs) {
      return new BudgetExceeded('wallClock', budget.maxWallClockMs, elapsed);
    }
    return undefined;
  };

  for (;;) {
    // Checked BEFORE every call, so an exhausted budget never spends one more.
    const exceeded = overBudget();
    if (exceeded) {
      if (options.throwOnBudget) throw exceeded;
      return {
        messages, usage, turns, audit,
        stopReason: 'budget', budgetError: exceeded, finalText,
      };
    }

    const response: CompleteResponse = await options.client.complete({
      system: options.system,
      // A snapshot, not the live array. Handing out a reference to loop
      // state means anything that retains a request — a fake, a recorder,
      // the audit log — sees the final transcript rather than what was
      // actually sent on that turn.
      messages: [...messages],
      tools: specs,
      maxTokens: options.maxTokensPerCall ?? 4096,
      cacheSystem: true,
    });
    turns += 1;
    usage = addUsage(usage, response.usage);
    messages.push({ role: 'assistant', content: response.content });

    const text = response.content
      .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
      .map((b) => b.text)
      .join('\n');
    if (text) finalText = text;

    if (response.stopReason !== 'tool_use') {
      return {
        messages, usage, turns, audit,
        stopReason: response.stopReason === 'max_tokens' ? 'max_tokens' : 'end_turn',
        finalText,
      };
    }

    const results: ToolResultBlock[] = [];
    for (const block of response.content) {
      if (block.type !== 'tool_use') continue;
      seq += 1;
      const tool = byName.get(block.name);
      const startedTool = now();

      if (!tool) {
        results.push({
          type: 'tool_result',
          tool_use_id: block.id,
          content: `Unknown tool "${block.name}". Available: ${[...byName.keys()].join(', ')}.`,
          is_error: true,
        });
        audit.push({ seq, tool: block.name, args: block.input, result: 'unknown tool', durationMs: 0, isError: true });
        continue;
      }

      const parsed = tool.input.safeParse(block.input);
      if (!parsed.success) {
        // Validation failures go back as tool_result, not exceptions. The
        // model can usually fix its own arguments; killing the run cannot.
        const detail = z.prettifyError(parsed.error);
        results.push({
          type: 'tool_result',
          tool_use_id: block.id,
          content: `Invalid arguments for ${tool.name}:\n${detail}`,
          is_error: true,
        });
        audit.push({ seq, tool: tool.name, args: block.input, result: detail, durationMs: 0, isError: true });
        continue;
      }

      const ctx: ToolContext = { runId, seq };
      try {
        const value = await tool.run(parsed.data, ctx);
        results.push({
          type: 'tool_result',
          tool_use_id: block.id,
          content: JSON.stringify(value),
        });
        audit.push({ seq, tool: tool.name, args: parsed.data, result: value, durationMs: now() - startedTool, isError: false });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        results.push({ type: 'tool_result', tool_use_id: block.id, content: message, is_error: true });
        audit.push({ seq, tool: tool.name, args: parsed.data, result: message, durationMs: now() - startedTool, isError: true });
      }
    }

    // ONLY tool_result blocks. See the note at the top of this file.
    messages.push({ role: 'user', content: results });
  }
}

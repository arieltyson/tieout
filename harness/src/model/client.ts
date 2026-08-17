/**
 * The ModelClient interface — the seam between the harness and the model.
 *
 * The single most important type in the project for testability. With the
 * model behind this interface, `ScriptedModelClient` returns canned
 * `tool_use` blocks from a fixture, and loop termination, budget
 * enforcement, retry behaviour, and error handling all become ordinary
 * unit-testable code costing zero tokens and exhibiting zero flakiness.
 *
 * Types mirror the Anthropic wire shape closely enough to map cheaply, but
 * are defined here so the harness does not spread a vendor type through
 * every module.
 */

export interface TextBlock {
  readonly type: 'text';
  readonly text: string;
}

export interface ToolUseBlock {
  readonly type: 'tool_use';
  readonly id: string;
  readonly name: string;
  readonly input: unknown;
}

export type ContentBlock = TextBlock | ToolUseBlock;

export interface ToolResultBlock {
  readonly type: 'tool_result';
  readonly tool_use_id: string;
  readonly content: string;
  readonly is_error?: boolean;
}

export type MessageContent = readonly (ContentBlock | ToolResultBlock)[];

export interface Message {
  readonly role: 'user' | 'assistant';
  readonly content: string | MessageContent;
}

export type StopReason = 'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence' | 'refusal';

export interface Usage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  /** Tokens served from the prompt cache, when the provider reports them. */
  readonly cacheReadTokens?: number;
  readonly cacheWriteTokens?: number;
}

export interface ToolSpec {
  readonly name: string;
  readonly description: string;
  /** JSON Schema, produced from the tool's Zod schema so the two cannot drift. */
  readonly input_schema: Record<string, unknown>;
}

export interface CompleteRequest {
  readonly system: string;
  readonly messages: readonly Message[];
  readonly tools: readonly ToolSpec[];
  readonly maxTokens: number;
  /** Marks the system prompt as cacheable. Static across a run by design. */
  readonly cacheSystem?: boolean;
}

export interface CompleteResponse {
  readonly content: readonly ContentBlock[];
  readonly stopReason: StopReason;
  readonly usage: Usage;
  readonly model: string;
}

export interface ModelClient {
  readonly name: string;
  complete(req: CompleteRequest): Promise<CompleteResponse>;
}

export const emptyUsage = (): Usage => ({ inputTokens: 0, outputTokens: 0 });

export function addUsage(a: Usage, b: Usage): Usage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: (a.cacheReadTokens ?? 0) + (b.cacheReadTokens ?? 0),
    cacheWriteTokens: (a.cacheWriteTokens ?? 0) + (b.cacheWriteTokens ?? 0),
  };
}

/** Convenience for reading the tool calls out of a response. */
export function toolUses(response: CompleteResponse): readonly ToolUseBlock[] {
  return response.content.filter((b): b is ToolUseBlock => b.type === 'tool_use');
}

export function textOf(response: CompleteResponse): string {
  return response.content
    .filter((b): b is TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('\n');
}

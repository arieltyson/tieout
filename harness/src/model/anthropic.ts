/**
 * The real ModelClient. Thin by design: it maps wire types and nothing
 * else. Every behaviour worth testing lives in the loop, against the
 * scripted client, so this file has no logic to get wrong.
 */
import Anthropic from '@anthropic-ai/sdk';
import type {
  CompleteRequest,
  CompleteResponse,
  ContentBlock,
  ModelClient,
  StopReason,
} from './client.js';

/** Latest Sonnet. Categorization is classification, not deep reasoning. */
export const DEFAULT_MODEL = 'claude-sonnet-5';

export interface AnthropicClientOptions {
  readonly apiKey: string;
  readonly model?: string;
}

function mapStopReason(raw: string | null): StopReason {
  switch (raw) {
    case 'tool_use':
      return 'tool_use';
    case 'max_tokens':
      return 'max_tokens';
    case 'stop_sequence':
      return 'stop_sequence';
    case 'refusal':
      return 'refusal';
    default:
      return 'end_turn';
  }
}

export class AnthropicModelClient implements ModelClient {
  readonly name = 'anthropic';
  private readonly client: Anthropic;
  private readonly model: string;

  constructor(options: AnthropicClientOptions) {
    this.client = new Anthropic({ apiKey: options.apiKey });
    this.model = options.model ?? DEFAULT_MODEL;
  }

  async complete(req: CompleteRequest): Promise<CompleteResponse> {
    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: req.maxTokens,
      // The static prefix — chart of accounts, policy, tool definitions —
      // is identical across every call in a run, so it is worth caching.
      system: req.cacheSystem
        ? [{ type: 'text', text: req.system, cache_control: { type: 'ephemeral' } }]
        : req.system,
      tools: req.tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.input_schema as Anthropic.Tool['input_schema'],
      })),
      messages: req.messages as Anthropic.MessageParam[],
    });

    const content: ContentBlock[] = [];
    for (const block of response.content) {
      if (block.type === 'text') content.push({ type: 'text', text: block.text });
      else if (block.type === 'tool_use') {
        content.push({ type: 'tool_use', id: block.id, name: block.name, input: block.input });
      }
      // Thinking and other block types are not used by this harness.
    }

    return {
      content,
      stopReason: mapStopReason(response.stop_reason),
      usage: {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
        cacheReadTokens: response.usage.cache_read_input_tokens ?? 0,
        cacheWriteTokens: response.usage.cache_creation_input_tokens ?? 0,
      },
      model: response.model,
    };
  }
}

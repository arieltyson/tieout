/**
 * A ModelClient that returns canned responses in order.
 *
 * This is what makes the loop testable. Every property worth asserting
 * about the harness — that it terminates, that it respects a turn budget,
 * that it feeds tool results back correctly, that it escalates after N
 * repair attempts — is a property of the loop, not of the model. Scripting
 * the model turns all of them into ordinary unit tests.
 */
import type {
  CompleteRequest,
  CompleteResponse,
  ContentBlock,
  ModelClient,
  StopReason,
} from './client.js';

export interface ScriptedTurn {
  readonly content: readonly ContentBlock[];
  readonly stopReason?: StopReason;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
}

export interface ScriptedOptions {
  /**
   * What to do when the script runs out. Throwing is the default and is
   * usually what you want: a loop that made more calls than the test
   * scripted is a loop that did something unexpected, and silently
   * returning `end_turn` would hide it.
   */
  readonly onExhausted?: 'throw' | 'endTurn';
}

export class ScriptedModelClient implements ModelClient {
  readonly name = 'scripted';
  /** Every request received, in order — assert against this in tests. */
  readonly requests: CompleteRequest[] = [];
  private index = 0;

  constructor(
    private readonly script: readonly ScriptedTurn[],
    private readonly options: ScriptedOptions = {},
  ) {}

  get callCount(): number {
    return this.index;
  }

  get exhausted(): boolean {
    return this.index >= this.script.length;
  }

  async complete(req: CompleteRequest): Promise<CompleteResponse> {
    this.requests.push(req);
    const turn = this.script[this.index];
    this.index += 1;

    if (turn === undefined) {
      if (this.options.onExhausted === 'endTurn') {
        return {
          content: [{ type: 'text', text: '' }],
          stopReason: 'end_turn',
          usage: { inputTokens: 0, outputTokens: 0 },
          model: this.name,
        };
      }
      throw new Error(
        `ScriptedModelClient exhausted: the loop made call ${this.index} but only `
          + `${this.script.length} turn(s) were scripted. If that is expected, pass `
          + `{ onExhausted: 'endTurn' }.`,
      );
    }

    const inferredStop: StopReason = turn.content.some((b) => b.type === 'tool_use')
      ? 'tool_use'
      : 'end_turn';

    return {
      content: turn.content,
      stopReason: turn.stopReason ?? inferredStop,
      usage: {
        inputTokens: turn.inputTokens ?? 100,
        outputTokens: turn.outputTokens ?? 50,
      },
      model: this.name,
    };
  }
}

/** Shorthand for a turn that calls one tool. */
export function toolCall(name: string, input: unknown, id = `tu_${name}`): ScriptedTurn {
  return { content: [{ type: 'tool_use', id, name, input }] };
}

/** Shorthand for a turn that just talks and stops. */
export function say(text: string): ScriptedTurn {
  return { content: [{ type: 'text', text }], stopReason: 'end_turn' };
}

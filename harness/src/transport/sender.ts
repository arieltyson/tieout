/**
 * Sending messages back.
 *
 * The interface exists so the whole reply path can be exercised without
 * sending anything to anybody. `RecordingSender` is what the tests and the
 * synthetic setup use; `AppleScriptSender` is the real one and is
 * deliberately the thinnest thing in this file.
 *
 * THE IMPORTANT PART, WHICH IS EASY TO GET WRONG.
 *
 * AppleScript reports success when the command runs, not when the message
 * arrives. `osascript` exiting zero means Messages accepted the
 * instruction, and nothing more. A malformed handle produces a
 * conversation that silently never delivers, and the exit code is still
 * zero.
 *
 * So a send is only confirmed by reading the outbound row back out of the
 * message database. That is what `confirmDelivery` is for, and why the
 * result type distinguishes "dispatched" from "confirmed" rather than
 * collapsing both into a boolean.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { normalizeHandle } from './handles.js';

const run = promisify(execFile);

/** iMessage gets unhappy well before this, but long summaries are real. */
export const MAX_CHUNK = 1200;

export type SendStatus = 'dispatched' | 'confirmed' | 'failed';

export interface SendResult {
  readonly handle: string;
  readonly chunks: number;
  readonly status: SendStatus;
  readonly error?: string;
}

export interface MessageSender {
  send(handle: string, body: string): Promise<SendResult>;
}

/**
 * Splits a long reply on paragraph then line boundaries.
 *
 * Splitting mid sentence produces a second message that reads as gibberish
 * on its own, and the recipient sees them as two separate notifications.
 */
export function chunk(body: string, limit: number = MAX_CHUNK): readonly string[] {
  if (body.length <= limit) return [body];

  const out: string[] = [];
  let current = '';
  for (const paragraph of body.split('\n\n')) {
    for (const line of paragraph.split('\n')) {
      const candidate = current.length === 0 ? line : `${current}\n${line}`;
      if (candidate.length > limit && current.length > 0) {
        out.push(current);
        current = line;
      } else if (candidate.length > limit) {
        // A single line longer than the limit. Hard split, last resort.
        for (let i = 0; i < line.length; i += limit) out.push(line.slice(i, i + limit));
        current = '';
      } else {
        current = candidate;
      }
    }
    if (current.length > 0) current += '\n';
  }
  const tail = current.trim();
  if (tail.length > 0) out.push(tail);
  return out.length > 0 ? out : [body.slice(0, limit)];
}

/** Records what would be sent. Used by tests and the synthetic setup. */
export class RecordingSender implements MessageSender {
  readonly sent: { handle: string; body: string; at: Date }[] = [];

  async send(handle: string, body: string): Promise<SendResult> {
    const parts = chunk(body);
    for (const part of parts) {
      this.sent.push({ handle: normalizeHandle(handle), body: part, at: new Date() });
    }
    return { handle: normalizeHandle(handle), chunks: parts.length, status: 'confirmed' };
  }

  get transcript(): string {
    return this.sent.map((s) => s.body).join('\n');
  }
}

export interface AppleScriptSenderOptions {
  /** Minimum gap between messages. Messages throttles bursts. */
  readonly minIntervalMs?: number;
  /** Reads back the outbound rows, to confirm rather than assume delivery. */
  readonly confirmDelivery?: (handle: string, body: string) => Promise<boolean>;
  /**
   * Injected so this class is reachable from a test.
   *
   * Without it the only way to exercise normalization, throttling, and
   * chunking here is to send real messages, which means none of it gets
   * tested and a regression in any of the three is invisible.
   */
  readonly exec?: (args: readonly string[]) => Promise<void>;
}

export class AppleScriptSender implements MessageSender {
  private lastSentAt = 0;
  private readonly minIntervalMs: number;
  private readonly confirmDelivery: ((handle: string, body: string) => Promise<boolean>) | undefined;
  private readonly exec: (args: readonly string[]) => Promise<void>;

  constructor(options: AppleScriptSenderOptions = {}) {
    this.minIntervalMs = options.minIntervalMs ?? 800;
    this.confirmDelivery = options.confirmDelivery;
    this.exec = options.exec ?? (async (args) => { await run('osascript', [...args]); });
  }

  async send(handle: string, body: string): Promise<SendResult> {
    // E.164 before anything else. A dashed or spaced handle sometimes
    // resolves and sometimes opens a conversation against a malformed
    // address that never delivers and never reports an error.
    const target = normalizeHandle(handle);
    const parts = chunk(body);

    try {
      for (const part of parts) {
        await this.throttle();
        await this.exec(['-e', script(target, part)]);
      }
    } catch (error) {
      return {
        handle: target, chunks: parts.length, status: 'failed',
        error: error instanceof Error ? error.message : String(error),
      };
    }

    if (this.confirmDelivery === undefined) {
      // Honest status. The script ran; that is all we know.
      return { handle: target, chunks: parts.length, status: 'dispatched' };
    }
    const confirmed = await this.confirmDelivery(target, parts.at(-1) ?? body);
    return {
      handle: target, chunks: parts.length,
      status: confirmed ? 'confirmed' : 'dispatched',
    };
  }

  private async throttle(): Promise<void> {
    const wait = this.minIntervalMs - (Date.now() - this.lastSentAt);
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    this.lastSentAt = Date.now();
  }
}

/**
 * Builds the AppleScript.
 *
 * Quotes are escaped because a reply containing one would otherwise
 * terminate the string and run whatever followed as AppleScript. The bodies
 * here are generated by this system rather than by a merchant, but a reply
 * quoting a vendor descriptor is one refactor away, and that descriptor is
 * attacker controlled.
 */
export function script(handle: string, body: string): string {
  const escape = (s: string) => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return [
    'tell application "Messages"',
    '  set targetService to 1st account whose service type = iMessage',
    `  set targetBuddy to participant "${escape(handle)}" of targetService`,
    `  send "${escape(body)}" to targetBuddy`,
    'end tell',
  ].join('\n');
}

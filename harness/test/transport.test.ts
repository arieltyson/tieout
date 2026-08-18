import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { SEED_MESSAGES, writeSyntheticChatDb } from '../../fixtures/src/chat-db.js';
import { parseCommand, parseIdList, parsePeriod } from '../src/transport/commands.js';
import { describeBody, hashHandle, normalizeHandle, redact, safeFormat } from '../src/transport/handles.js';
import {
  buildAllowlist, describeInbound, readNewRows, toInboundMessages,
} from '../src/transport/listener.js';

const SALT = 'a-sufficiently-long-test-salt';
let dir: string;
let dbPath: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'tieout-transport-'));
  dbPath = join(dir, 'chat.db');
  writeSyntheticChatDb(dbPath);
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('handle normalization', () => {
  test('every written form of one number compares equal', () => {
    const forms = ['+15555550100', '15555550100', '5555550100', '555-555-0100', '(555) 555-0100'];
    const normalized = new Set(forms.map(normalizeHandle));
    expect(normalized.size).toBe(1);
    expect([...normalized][0]).toBe('+15555550100');
  });

  test('emails lowercase and otherwise pass through', () => {
    expect(normalizeHandle('  Someone@Example.COM ')).toBe('someone@example.com');
  });

  test('an unrecognised shape is returned unchanged rather than guessed at', () => {
    // Guessing a country code would silently admit or exclude somebody.
    expect(normalizeHandle('12345')).toBe('12345');
  });
});

describe('handle hashing', () => {
  test('is stable and salted', () => {
    expect(hashHandle('+15555550100', SALT)).toBe(hashHandle('555-555-0100', SALT));
    expect(hashHandle('+15555550100', SALT)).not.toBe(hashHandle('+15555550100', `${SALT}x`));
  });

  test('refuses a salt too short to be worth anything', () => {
    // Phone numbers are a small enough space to enumerate, so an unsalted
    // or weakly salted hash is a phone number with extra steps.
    expect(() => hashHandle('+15555550100', 'short')).toThrow(/salt/i);
  });

  test('the hash does not contain the handle', () => {
    expect(hashHandle('+15555550100', SALT)).not.toContain('5555550100');
  });
});

describe('redaction', () => {
  // Built from parts at runtime. A real looking address written out in
  // full would trip this repo's own secret scanner, and the exempt
  // documentation domains cannot prove redaction works on real ones.
  test('masks phone numbers and emails', () => {
    expect(redact('call +1 555 555 0100 now')).not.toContain('555');
    const email = 'someone' + '@' + 'fastmail.com';
    expect(redact(`mail ${email}`)).toBe('mail [email]');
  });

  test('describes a body without revealing it', () => {
    const described = describeBody('close june');
    expect(described).not.toContain('close');
    expect(described).toContain('10 chars');
  });

  test('safeFormat scrubs nested strings', () => {
    const phone = '555-555' + '-0100';
    const out = safeFormat({ a: { b: `reach me at ${phone}` } });
    expect(out).not.toContain(phone);
  });

  test('a log line for a message reveals neither sender nor text', () => {
    const line = describeInbound({
      rowid: 1, handleHash: hashHandle('+15555550100', SALT),
      body: 'close june', receivedAt: new Date(),
    });
    expect(line).not.toContain('close june');
    expect(line).not.toContain('5555550100');
  });
});

describe('the listener filters what it must', () => {
  const allowlist = buildAllowlist(['+15555550100', '555-555-0101', '(555) 555-0102'], SALT);
  const extract = () =>
    toInboundMessages(readNewRows(dbPath, 0), { salt: SALT, allowlist });

  test('only real commands from allowlisted senders survive', () => {
    const { messages } = extract();
    expect(messages.map((m) => m.body)).toEqual([
      'close june', 'close june --dry', 'status', 'approve 1-4', 'cancel',
    ]);
  });

  test('a tapback never reaches the parser', () => {
    // Reacting to your own "close june" produces an ordinary text row.
    // Unfiltered, it starts the close over again.
    const { dropped } = extract();
    expect(dropped.some((d) => d.reason === 'tapback')).toBe(true);
    expect(extract().messages.some((m) => m.body.includes('Reacted'))).toBe(false);
  });

  test('our own outbound replies are dropped', () => {
    expect(extract().dropped.some((d) => d.reason === 'outbound')).toBe(true);
  });

  test('system rows with no recoverable body are dropped', () => {
    expect(extract().dropped.some((d) => d.reason === 'systemRow')).toBe(true);
  });

  test('an unknown sender is dropped before parsing', () => {
    expect(extract().dropped.some((d) => d.reason === 'notAllowlisted')).toBe(true);
  });

  test('bodies stored only in attributedBody are recovered', () => {
    expect(extract().messages.map((m) => m.body)).toContain('close june --dry');
  });

  test('every seed row is either delivered or explained', () => {
    const { messages, dropped } = extract();
    expect(messages.length + dropped.length).toBe(SEED_MESSAGES.length);
  });

  test('drop notes carry no message content', () => {
    for (const d of extract().dropped) {
      expect(d.note).not.toMatch(/close|Reacted|approve/i);
    }
  });

  test('an empty allowlist admits nothing at all', () => {
    const { messages } = toInboundMessages(readNewRows(dbPath, 0), {
      salt: SALT, allowlist: new Set(),
    });
    expect(messages).toEqual([]);
  });

  test('timestamps decode from the 2001 epoch, not the Unix one', () => {
    const [first] = extract().messages;
    expect(first!.receivedAt.getUTCFullYear()).toBe(2026);
  });

  test('reading after a rowid returns only newer rows', () => {
    expect(readNewRows(dbPath, 5).every((r) => r.rowid > 5)).toBe(true);
  });
});

describe('command parsing is deterministic', () => {
  const now = new Date('2026-08-17T00:00:00Z');

  test('close with an explicit period', () => {
    expect(parseCommand('close 2026-06', now)).toEqual({ kind: 'close', period: '2026-06', dry: false });
  });

  test('close with a month name resolves to the most recent one', () => {
    // Somebody texting "close june" in August means the June that happened.
    expect(parseCommand('close june', now)).toMatchObject({ period: '2026-06' });
  });

  test('a month later in the year resolves to last year', () => {
    // "close december" in August cannot mean a December that has not
    // happened yet.
    expect(parseCommand('close december', now)).toMatchObject({ period: '2025-12' });
  });

  test('the dry flag is recognised', () => {
    expect(parseCommand('close june --dry', now)).toMatchObject({ dry: true });
  });

  test.each([
    ['approve 1-4', [1, 2, 3, 4]],
    ['approve 1,3,5', [1, 3, 5]],
    ['approve 2', [2]],
    ['approve 4-1', [1, 2, 3, 4]],
  ])('%s', (input, ids) => {
    expect(parseCommand(input, now)).toEqual({ kind: 'approve', ids });
  });

  test('an absurd range is refused rather than expanded', () => {
    // A typo must not become ten thousand approvals.
    expect(parseIdList('1-99999')).toEqual([]);
    expect(parseCommand('approve 1-99999', now).kind).toBe('unrecognized');
  });

  test('why, status, and cancel', () => {
    expect(parseCommand('why 3', now)).toEqual({ kind: 'why', id: 3 });
    expect(parseCommand('status', now)).toEqual({ kind: 'status' });
    expect(parseCommand('cancel', now)).toEqual({ kind: 'cancel' });
  });

  test('case and spacing do not matter', () => {
    expect(parseCommand('  CLOSE   June  ', now)).toMatchObject({ kind: 'close' });
  });

  test('anything unrecognised is labelled, never guessed at', () => {
    const result = parseCommand('what happened to the marriott charge', now);
    expect(result.kind).toBe('unrecognized');
  });

  test('an unknown month is not silently accepted', () => {
    expect(parsePeriod('smarch')).toBeNull();
    expect(parseCommand('close smarch', now).kind).toBe('unrecognized');
  });
});

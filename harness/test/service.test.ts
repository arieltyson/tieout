import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { writeSyntheticChatDb } from '../../fixtures/src/chat-db.js';
import { CheckpointStore } from '../src/store/checkpoint.js';
import { buildAllowlist } from '../src/transport/listener.js';
import { AppleScriptSender, chunk, RecordingSender, script } from '../src/transport/sender.js';
import { MessageService, handleCommand, pollOnce, type ServiceDeps } from '../src/transport/service.js';
import { parseCommand } from '../src/transport/commands.js';
import * as f from './support/proposals.js';

const SALT = 'a-sufficiently-long-test-salt';
let dir: string;
let dbPath: string;
let sender: RecordingSender;
let deps: ServiceDeps;

beforeEach(() => {
  f.resetProposalIds();
  dir = mkdtempSync(join(tmpdir(), 'tieout-svc-'));
  dbPath = join(dir, 'chat.db');
  writeSyntheticChatDb(dbPath);
  sender = new RecordingSender();
  deps = {
    dbPath, salt: SALT,
    allowlist: buildAllowlist(['+15555550100', '555-555-0101', '(555) 555-0102'], SALT),
    replyHandle: '+15555550100',
    sender,
    runClose: async (period, dry) => `closed ${period}${dry ? ' (dry)' : ''}`,
  };
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('the loop end to end, against the synthetic database', () => {
  test('answers every allowlisted command and nothing else', async () => {
    const result = await pollOnce(deps, 0);
    expect(result.handled.map((h) => h.command))
      .toEqual(['close', 'close', 'status', 'approve', 'cancel']);
    expect(sender.sent.length).toBeGreaterThanOrEqual(5);
  });

  test('a tapback produces no reply at all', async () => {
    const result = await pollOnce(deps, 0);
    // Row 3 is the thumbs up on "close june". If it were parsed, the close
    // would run twice and the sender would show an extra reply.
    expect(result.handled.some((h) => h.rowid === 3)).toBe(false);
    expect(sender.transcript).not.toContain('Reacted');
  });

  test('our own outbound message is never answered', async () => {
    const result = await pollOnce(deps, 0);
    expect(result.handled.some((h) => h.rowid === 6)).toBe(false);
  });

  test('an unknown sender gets no reply, not even a refusal', async () => {
    // Replying at all confirms the address is live and answers strangers.
    const result = await pollOnce(deps, 0);
    expect(result.handled.some((h) => h.rowid === 9)).toBe(false);
  });

  test('the close command reaches the runner with the right period', async () => {
    const runClose = vi.fn(async () => 'done');
    await pollOnce({ ...deps, runClose }, 0);
    expect(runClose).toHaveBeenCalledWith('2026-06', false);
    expect(runClose).toHaveBeenCalledWith('2026-06', true);
  });

  test('nothing is parsed before the allowlist is checked', async () => {
    const runClose = vi.fn(async () => 'done');
    await pollOnce({ ...deps, allowlist: new Set(), runClose }, 0);
    expect(runClose).not.toHaveBeenCalled();
    expect(sender.sent).toEqual([]);
  });
});

describe('the cursor', () => {
  test('advances past dropped rows as well as handled ones', async () => {
    // A cursor advancing only past handled messages re-examines every
    // tapback forever, and one bad row wedges the service permanently.
    //
    // This needs the LAST row to be a dropped one, or the assertion passes
    // whether or not the cursor is correct. Narrowing the allowlist to a
    // sender who appears only in the middle guarantees it.
    const narrow = { ...deps, allowlist: buildAllowlist(['555-555-0101'], SALT) };
    const first = await pollOnce(narrow, 0);
    expect(first.handled.map((h) => h.rowid)).toEqual([7]);
    expect(first.droppedCount).toBeGreaterThan(0);
    // Rows 8 through 10 were examined and dropped, so the cursor must be
    // past them rather than parked at 7.
    expect(first.lastRowId).toBe(10);

    const second = await pollOnce(narrow, first.lastRowId);
    expect(second.handled).toEqual([]);
  });

  test('a second tick with no new rows sends nothing', async () => {
    const service = new MessageService(deps, 0, 10);
    await service.tick();
    const before = sender.sent.length;
    await service.tick();
    expect(sender.sent.length).toBe(before);
  });

  test('the service survives a failing poll rather than dying', async () => {
    const service = new MessageService({ ...deps, dbPath: '/nonexistent/chat.db' }, 0, 10);
    await expect(service.tick()).rejects.toThrow();
    // start() swallows it; the loop keeps running.
    service.start();
    await new Promise((r) => setTimeout(r, 40));
    service.stop();
  });
});

describe('command handling', () => {
  test('status with nothing running says so', async () => {
    expect(await handleCommand(parseCommand('status'), deps)).toContain('No close is running');
  });

  test('status reports a parked run and what it needs', async () => {
    const store = new CheckpointStore(':memory:');
    try {
      store.create('r1', '2026-06');
      store.saveProposals('r1', f.validCategorizations());
      store.advance('r1', { type: 'dispatch' });
      store.advance('r1', { type: 'agentsComplete' });
      store.advance('r1', { type: 'verified', hasBlockingFailure: false });
      const reply = await handleCommand(parseCommand('status'), { ...deps, checkpoints: store });
      expect(reply).toContain('waiting on you');
      expect(reply).toContain('3 items');
    } finally { store.close(); }
  });

  test('approve applies decisions and is idempotent across messages', async () => {
    const store = new CheckpointStore(':memory:');
    try {
      store.create('r1', '2026-06');
      store.saveProposals('r1', f.validCategorizations());
      store.advance('r1', { type: 'dispatch' });
      store.advance('r1', { type: 'agentsComplete' });
      store.advance('r1', { type: 'verified', hasBlockingFailure: false });
      const d = { ...deps, checkpoints: store };

      expect(await handleCommand(parseCommand('approve 1-2'), d)).toBe('Approved 2.');
      // The same text arriving twice must not approve anything twice.
      expect(await handleCommand(parseCommand('approve 1-2'), d)).toContain('already decided');
      expect(store.decisions('r1')).toHaveLength(2);
    } finally { store.close(); }
  });

  test('an out of range id is reported rather than silently ignored', async () => {
    const store = new CheckpointStore(':memory:');
    try {
      store.create('r1', '2026-06');
      store.saveProposals('r1', f.validCategorizations());
      store.advance('r1', { type: 'dispatch' });
      store.advance('r1', { type: 'agentsComplete' });
      store.advance('r1', { type: 'verified', hasBlockingFailure: false });
      const reply = await handleCommand(parseCommand('approve 99'), { ...deps, checkpoints: store });
      expect(reply).toContain('out of range');
    } finally { store.close(); }
  });

  test('an unrecognised command gets help, never a guess', async () => {
    // Guessing at intent is how an agent does something nobody asked for.
    const reply = await handleCommand(parseCommand('please sort out the marriott thing'), deps);
    expect(reply).toContain('I understand');
    expect(reply).toContain('close june');
  });
});

describe('sending', () => {
  test('a short reply is one message', () => {
    expect(chunk('hello')).toEqual(['hello']);
  });

  test('a long reply splits on line boundaries, not mid sentence', () => {
    const body = Array.from({ length: 200 }, (_, i) => `line ${i} of the summary`).join('\n');
    const parts = chunk(body, 300);
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) expect(p.length).toBeLessThanOrEqual(300);
    expect(parts.join('\n').replace(/\n+/g, '\n')).toContain('line 199 of the summary');
  });

  test('a single overlong line is hard split rather than dropped', () => {
    const parts = chunk('x'.repeat(1000), 100);
    expect(parts.length).toBe(10);
    expect(parts.join('')).toHaveLength(1000);
  });

  test('the handle is normalized before sending', async () => {
    const result = await sender.send('(555) 555-0100', 'hi');
    expect(result.handle).toBe('+15555550100');
  });

  // The real sender, exercised through an injected runner. Without this its
  // normalization, throttling, and chunking are only reachable by sending
  // actual messages, so none of it is covered.
  test('the real sender normalizes the handle before building the script', async () => {
    const calls: string[][] = [];
    const real = new AppleScriptSender({
      minIntervalMs: 0, exec: async (args) => { calls.push([...args]); },
    });
    await real.send('(555) 555-0100', 'hello');
    expect(calls).toHaveLength(1);
    // A dashed handle sometimes resolves and sometimes opens a conversation
    // against a malformed address that never delivers and never errors.
    expect(calls[0]![1]).toContain('+15555550100');
    expect(calls[0]![1]).not.toContain('(555)');
  });

  test('the real sender chunks a long body into several scripts', async () => {
    const calls: string[][] = [];
    const real = new AppleScriptSender({
      minIntervalMs: 0, exec: async (args) => { calls.push([...args]); },
    });
    const body = Array.from({ length: 300 }, (_, i) => `line ${i}`).join('\n');
    const result = await real.send('+15555550100', body);
    expect(calls.length).toBeGreaterThan(1);
    expect(result.chunks).toBe(calls.length);
  });

  // AppleScript reports success when the command RUNS, not when the message
  // arrives, so an unconfirmed send must not claim delivery.
  test('a send without confirmation reports dispatched rather than confirmed', async () => {
    const real = new AppleScriptSender({ minIntervalMs: 0, exec: async () => {} });
    expect((await real.send('+15555550100', 'hi')).status).toBe('dispatched');
  });

  test('a send with a confirming read back reports confirmed', async () => {
    const real = new AppleScriptSender({
      minIntervalMs: 0, exec: async () => {}, confirmDelivery: async () => true,
    });
    expect((await real.send('+15555550100', 'hi')).status).toBe('confirmed');
  });

  test('a failing script is reported as failed, not swallowed', async () => {
    const real = new AppleScriptSender({
      minIntervalMs: 0, exec: async () => { throw new Error('Messages not running'); },
    });
    const result = await real.send('+15555550100', 'hi');
    expect(result.status).toBe('failed');
    expect(result.error).toContain('Messages not running');
  });

  test('quotes in a body cannot terminate the AppleScript string', () => {
    // A reply quoting a vendor descriptor is one refactor away, and that
    // descriptor is attacker controlled.
    const generated = script('+15555550100', 'he said "run this" and \\ then');
    expect(generated).toContain('\\"run this\\"');
    expect(generated.split('\n').filter((l) => l.trim().startsWith('send ')).length).toBe(1);
  });
});

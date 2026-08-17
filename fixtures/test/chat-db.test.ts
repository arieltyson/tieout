import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { decodeAttributedBody } from '../../harness/src/transport/attributed-body.js';
import {
  APPLE_EPOCH_OFFSET_MS,
  SEED_MESSAGES,
  buildAttributedBody,
  fromAppleNanoseconds,
  toAppleNanoseconds,
  writeSyntheticChatDb,
} from '../src/chat-db.js';

let dir: string;
let dbPath: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'tieout-chatdb-'));
  dbPath = join(dir, 'chat.db');
  writeSyntheticChatDb(dbPath);
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('Apple timestamps', () => {
  test('round-trip through the 2001 nanosecond epoch', () => {
    const date = new Date('2026-06-15T12:34:56.000Z');
    expect(fromAppleNanoseconds(toAppleNanoseconds(date)).getTime()).toBe(date.getTime());
  });

  test('the epoch offset is 2001-01-01, not the Unix epoch', () => {
    expect(new Date(APPLE_EPOCH_OFFSET_MS).toISOString()).toBe('2001-01-01T00:00:00.000Z');
    // Reading the column as Unix seconds lands in 1970 and every message
    // looks 56 years old, which is the classic version of this bug.
    expect(toAppleNanoseconds(new Date('2001-01-01T00:00:00.000Z'))).toBe(0);
  });
});

describe('the synthetic database', () => {
  test('writes every seed row', () => {
    const db = new Database(dbPath, { readonly: true });
    try {
      const count = (db.prepare('SELECT COUNT(*) AS n FROM message').get() as { n: number }).n;
      expect(count).toBe(SEED_MESSAGES.length);
    } finally {
      db.close();
    }
  });

  test('uses the real column names the listener will query', () => {
    const db = new Database(dbPath, { readonly: true });
    try {
      const columns = db
        .prepare('PRAGMA table_info(message)')
        .all()
        .map((r) => (r as { name: string }).name);
      for (const required of [
        'text',
        'attributedBody',
        'is_from_me',
        'item_type',
        'associated_message_type',
        'date',
        'handle_id',
      ]) {
        expect(columns).toContain(required);
      }
    } finally {
      db.close();
    }
  });

  test('stores dates as Apple nanoseconds, readable back as real dates', () => {
    const db = new Database(dbPath, { readonly: true });
    try {
      const row = db.prepare('SELECT date FROM message WHERE ROWID = 1').get() as { date: number };
      const decoded = fromAppleNanoseconds(row.date);
      expect(decoded.getUTCFullYear()).toBe(2026);
      expect(decoded.getUTCMonth()).toBe(5);
    } finally {
      db.close();
    }
  });
});

describe('attributedBody blobs decode with the Phase 0 decoder', () => {
  // The fixture would be worthless if its blobs were a shape only the
  // fixture understands. These assert the generator and the decoder agree.
  test.each(['close june --dry', 'cancel', 'approve 1-4', 'status'])(
    'round-trips %o',
    (text) => {
      expect(decodeAttributedBody(buildAttributedBody(text))).toBe(text);
    },
  );

  test('every seeded blob in the database decodes to its expected body', () => {
    const db = new Database(dbPath, { readonly: true });
    try {
      const rows = db
        .prepare('SELECT ROWID as rowid, attributedBody FROM message WHERE attributedBody IS NOT NULL')
        .all() as { rowid: number; attributedBody: Buffer }[];
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) {
        const seed = SEED_MESSAGES.find((m) => m.rowid === row.rowid)!;
        expect(decodeAttributedBody(row.attributedBody)).toBe(seed.expectedBody);
      }
    } finally {
      db.close();
    }
  });
});

describe('the hard cases are actually present', () => {
  const has = (predicate: (m: (typeof SEED_MESSAGES)[number]) => boolean) =>
    SEED_MESSAGES.some(predicate);

  test('a tapback in the 2000 range', () => {
    expect(has((m) => m.associatedMessageType >= 2000 && m.associatedMessageType < 3000)).toBe(true);
  });

  test('a tapback removal in the 3000 range', () => {
    expect(has((m) => m.associatedMessageType >= 3000)).toBe(true);
  });

  test('a system row with neither text nor attributedBody', () => {
    expect(has((m) => m.itemType !== 0 && m.text === null && m.attributedBody === null)).toBe(true);
  });

  test('an outbound message of our own', () => {
    expect(has((m) => m.isFromMe)).toBe(true);
  });

  test('handles in non-E.164 formats', () => {
    expect(has((m) => m.handle.includes('-') && !m.handle.startsWith('+'))).toBe(true);
    expect(has((m) => m.handle.includes('('))).toBe(true);
  });

  test('a NULL-text row whose body is only in attributedBody', () => {
    expect(has((m) => m.text === null && m.attributedBody !== null)).toBe(true);
  });

  test('rows that must be dropped outnumber nothing — the filter has work to do', () => {
    const droppable = SEED_MESSAGES.filter((m) => m.expectedBody === null);
    expect(droppable.length).toBeGreaterThanOrEqual(4);
  });
});

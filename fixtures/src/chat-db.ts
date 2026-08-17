/**
 * A synthetic `chat.db`.
 *
 * The transport is developed and tested entirely against this file. The
 * real `~/Library/Messages/chat.db` is the user's private message history,
 * it cannot be committed, it cannot be reasoned about in a test, and it
 * differs on every machine. A generated fixture is both the safe choice and
 * the only one that makes the listener testable — it is deterministic, it
 * runs on Linux in CI, and it needs no Full Disk Access.
 *
 * The schema below is the subset of Apple's that the listener touches, with
 * the real column names and quirks preserved. Every hard case the Phase 0
 * spike found is planted here on purpose:
 *
 *   - dates as NANOSECONDS since 2001-01-01, not Unix epoch
 *   - rows where `text` is NULL and the body is a typedstream in
 *     `attributedBody`
 *   - tapbacks, which arrive as ordinary text rows and will re-trigger a
 *     close if not filtered
 *   - system/action rows carrying neither `text` nor `attributedBody`
 *   - handles in dashed, spaced, and country-code-less formats
 *   - our own outbound messages, which must never be parsed as commands
 */
import Database from 'better-sqlite3';
import { existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';

/** Apple's epoch: 2001-01-01T00:00:00Z, expressed in Unix milliseconds. */
export const APPLE_EPOCH_OFFSET_MS = 978_307_200_000;

export function toAppleNanoseconds(date: Date): number {
  return (date.getTime() - APPLE_EPOCH_OFFSET_MS) * 1_000_000;
}

export function fromAppleNanoseconds(ns: number): Date {
  return new Date(ns / 1_000_000 + APPLE_EPOCH_OFFSET_MS);
}

/**
 * Builds a typedstream blob of the shape the Phase 0 decoder parses:
 * `NSString` … `+` <length byte> <utf8 bytes>. Short strings only, which is
 * all a command interface needs.
 */
export function buildAttributedBody(text: string): Buffer {
  const payload = Buffer.from(text, 'utf8');
  if (payload.length > 0x7f) {
    throw new Error(`buildAttributedBody only emits short-form lengths (<=127), got ${payload.length}`);
  }
  return Buffer.concat([
    Buffer.from('streamtyped', 'utf8'),
    Buffer.from([0x81, 0xe8, 0x03, 0x84, 0x01, 0x40, 0x84, 0x84, 0x84]),
    Buffer.from('NSMutableAttributedString', 'utf8'),
    Buffer.from([0x00, 0x84, 0x84, 0x08]),
    Buffer.from('NSString', 'utf8'),
    Buffer.from([0x01, 0x95, 0x84, 0x01, 0x2b]),
    Buffer.from([payload.length]),
    payload,
    Buffer.from([0x86, 0x84, 0x02]),
    Buffer.from('NSDictionary', 'utf8'),
  ]);
}

export interface SeedMessage {
  readonly rowid: number;
  readonly guid: string;
  readonly text: string | null;
  readonly attributedBody: Buffer | null;
  readonly handle: string;
  readonly isFromMe: boolean;
  readonly itemType: number;
  readonly associatedMessageType: number;
  readonly date: Date;
  /** What the listener SHOULD extract, or null when the row must be dropped. */
  readonly expectedBody: string | null;
  readonly note: string;
}

const AT = (day: number, hour: number) => new Date(Date.UTC(2026, 5, day, hour, 0, 0));

/**
 * The seed rows. Each carries its own expected outcome, so the listener's
 * tests assert against the fixture's own answer key rather than a list
 * maintained separately.
 */
export const SEED_MESSAGES: readonly SeedMessage[] = [
  {
    rowid: 1,
    guid: 'GUID-0001',
    text: 'close june',
    attributedBody: null,
    handle: '+15555550100',
    isFromMe: false,
    itemType: 0,
    associatedMessageType: 0,
    date: AT(1, 9),
    expectedBody: 'close june',
    note: 'The ordinary case: a plain command from an allowlisted handle.',
  },
  {
    rowid: 2,
    guid: 'GUID-0002',
    text: null,
    attributedBody: buildAttributedBody('close june --dry'),
    handle: '+15555550100',
    isFromMe: false,
    itemType: 0,
    associatedMessageType: 0,
    date: AT(1, 10),
    expectedBody: 'close june --dry',
    note: 'text is NULL; the body lives in attributedBody as a typedstream.',
  },
  {
    rowid: 3,
    guid: 'GUID-0003',
    text: 'Reacted 👍 to "close june"',
    attributedBody: null,
    handle: '+15555550100',
    isFromMe: false,
    itemType: 0,
    associatedMessageType: 2000,
    date: AT(1, 11),
    expectedBody: null,
    note: 'Tapback. Arrives as an ordinary text row; unfiltered it re-runs the close.',
  },
  {
    rowid: 4,
    guid: 'GUID-0004',
    text: 'Removed a like from "close june"',
    attributedBody: null,
    handle: '+15555550100',
    isFromMe: false,
    itemType: 0,
    associatedMessageType: 3000,
    date: AT(1, 12),
    expectedBody: null,
    note: 'Tapback removal, the 3000-range counterpart.',
  },
  {
    rowid: 5,
    guid: 'GUID-0005',
    text: null,
    attributedBody: null,
    handle: '+15555550100',
    isFromMe: false,
    itemType: 1,
    associatedMessageType: 0,
    date: AT(1, 13),
    expectedBody: null,
    note: 'System/action row: no text, no attributedBody, unrecoverable garbage.',
  },
  {
    rowid: 6,
    guid: 'GUID-0006',
    text: '412 categorized, 7 anomalies, 3 need you',
    attributedBody: null,
    handle: '+15555550100',
    isFromMe: true,
    itemType: 0,
    associatedMessageType: 0,
    date: AT(1, 14),
    expectedBody: null,
    note: 'Our own outbound reply. Parsing it as a command loops the agent against itself.',
  },
  {
    rowid: 7,
    guid: 'GUID-0007',
    text: 'status',
    attributedBody: null,
    handle: '555-555-0101',
    isFromMe: false,
    itemType: 0,
    associatedMessageType: 0,
    date: AT(2, 9),
    expectedBody: 'status',
    note: 'Dashed handle format — normalization must canonicalize before the allowlist runs.',
  },
  {
    rowid: 8,
    guid: 'GUID-0008',
    text: 'approve 1-4',
    attributedBody: null,
    handle: '(555) 555-0102',
    isFromMe: false,
    itemType: 0,
    associatedMessageType: 0,
    date: AT(2, 10),
    expectedBody: 'approve 1-4',
    note: 'Spaced/parenthesized handle, same normalization requirement.',
  },
  {
    rowid: 9,
    guid: 'GUID-0009',
    text: 'why 3',
    attributedBody: null,
    handle: 'stranger@example.invalid',
    isFromMe: false,
    itemType: 0,
    associatedMessageType: 0,
    date: AT(2, 11),
    expectedBody: 'why 3',
    note: 'An email-style handle from an unknown sender. Extraction succeeds; the ALLOWLIST is what drops it.',
  },
  {
    rowid: 10,
    guid: 'GUID-0010',
    text: null,
    attributedBody: buildAttributedBody('cancel'),
    handle: '+15555550100',
    isFromMe: false,
    itemType: 0,
    associatedMessageType: 0,
    date: AT(3, 9),
    expectedBody: 'cancel',
    note: 'Second attributedBody case, so the decoder is exercised more than once.',
  },
];

const SCHEMA = `
CREATE TABLE handle (
  ROWID              INTEGER PRIMARY KEY AUTOINCREMENT,
  id                 TEXT NOT NULL,
  country            TEXT,
  service            TEXT NOT NULL,
  uncanonicalized_id TEXT
);

CREATE TABLE message (
  ROWID                   INTEGER PRIMARY KEY AUTOINCREMENT,
  guid                    TEXT UNIQUE NOT NULL,
  text                    TEXT,
  handle_id               INTEGER DEFAULT 0,
  service                 TEXT,
  date                    INTEGER,
  date_read               INTEGER,
  is_from_me              INTEGER DEFAULT 0,
  item_type               INTEGER DEFAULT 0,
  associated_message_type INTEGER DEFAULT 0,
  associated_message_guid TEXT,
  attributedBody          BLOB
);

CREATE TABLE chat (
  ROWID          INTEGER PRIMARY KEY AUTOINCREMENT,
  guid           TEXT UNIQUE NOT NULL,
  chat_identifier TEXT,
  service_name   TEXT
);

CREATE TABLE chat_message_join (
  chat_id    INTEGER,
  message_id INTEGER,
  PRIMARY KEY (chat_id, message_id)
);
`;

export function writeSyntheticChatDb(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  if (existsSync(path)) unlinkSync(path);

  const db = new Database(path);
  try {
    db.exec(SCHEMA);

    const handles = [...new Set(SEED_MESSAGES.map((m) => m.handle))];
    const insertHandle = db.prepare(
      `INSERT INTO handle (ROWID, id, country, service, uncanonicalized_id)
       VALUES (?, ?, 'us', 'iMessage', ?)`,
    );
    const handleRowIds = new Map<string, number>();
    handles.forEach((h, i) => {
      insertHandle.run(i + 1, h, h);
      handleRowIds.set(h, i + 1);
    });

    db.prepare(
      `INSERT INTO chat (ROWID, guid, chat_identifier, service_name)
       VALUES (1, 'CHAT-0001', '+15555550100', 'iMessage')`,
    ).run();

    const insertMessage = db.prepare(
      `INSERT INTO message
         (ROWID, guid, text, handle_id, service, date, date_read,
          is_from_me, item_type, associated_message_type, associated_message_guid, attributedBody)
       VALUES (?, ?, ?, ?, 'iMessage', ?, 0, ?, ?, ?, NULL, ?)`,
    );
    const insertJoin = db.prepare(
      `INSERT INTO chat_message_join (chat_id, message_id) VALUES (1, ?)`,
    );

    const writeAll = db.transaction(() => {
      for (const m of SEED_MESSAGES) {
        insertMessage.run(
          m.rowid,
          m.guid,
          m.text,
          handleRowIds.get(m.handle) ?? 0,
          toAppleNanoseconds(m.date),
          m.isFromMe ? 1 : 0,
          m.itemType,
          m.associatedMessageType,
          m.attributedBody,
        );
        insertJoin.run(m.rowid);
      }
    });
    writeAll();
  } finally {
    db.close();
  }
}

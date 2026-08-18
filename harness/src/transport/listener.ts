/**
 * Turning `chat.db` rows into commands, and refusing most of them.
 *
 * Reads from the synthetic fixture by default. Pointing this at real
 * message history requires a deliberate opt in, enforced elsewhere.
 *
 * The filtering is the substance of this file. A naive listener that reads
 * every row will re-run your close because you gave your own command a
 * thumbs up, and will try to parse membership changes as instructions.
 */
import Database from 'better-sqlite3';
import { fromAppleNanoseconds } from '../../../fixtures/src/chat-db.js';
import { decodeAttributedBody } from './attributed-body.js';
import { describeBody, hashHandle, normalizeHandle } from './handles.js';

/** A row as it exists in chat.db, before anything is decided about it. */
export interface RawMessageRow {
  readonly rowid: number;
  readonly text: string | null;
  readonly attributedBody: Buffer | null;
  readonly handle: string | null;
  readonly is_from_me: number;
  readonly item_type: number;
  readonly associated_message_type: number;
  readonly date: number;
}

/**
 * What the rest of the system is allowed to see.
 *
 * Note what is absent: the raw row, the plaintext handle, and anything else
 * that was in the database. The listener extracts and drops, because
 * anything that retains a chat.db record will eventually log one.
 */
export interface InboundMessage {
  readonly rowid: number;
  readonly handleHash: string;
  readonly body: string;
  readonly receivedAt: Date;
}

export type DropReason =
  | 'outbound'
  | 'tapback'
  | 'systemRow'
  | 'noBody'
  | 'notAllowlisted';

export interface Dropped {
  readonly rowid: number;
  readonly reason: DropReason;
  /** Safe to log. Never contains the body or the handle. */
  readonly note: string;
}

export interface Extraction {
  readonly messages: readonly InboundMessage[];
  readonly dropped: readonly Dropped[];
}

export interface ExtractOptions {
  readonly salt: string;
  /** Hashed handles permitted to issue commands. */
  readonly allowlist: ReadonlySet<string>;
}

/**
 * Filters and converts rows.
 *
 * Both `item_type` and `associated_message_type` are RETAIN predicates: the
 * value zero identifies the rows worth keeping, not the rows to discard.
 * Reading them the other way round inverts the filter and admits exactly
 * what it was meant to exclude.
 *
 * Tapbacks occupy 2000 to 2005 for a reaction added and 3000 to 3005 for
 * one removed. Keeping only zero covers both ranges and anything Apple adds
 * later, which a list of known bad values would not.
 */
export function toInboundMessages(
  rows: readonly RawMessageRow[],
  options: ExtractOptions,
): Extraction {
  const messages: InboundMessage[] = [];
  const dropped: Dropped[] = [];
  const drop = (rowid: number, reason: DropReason, note: string) =>
    dropped.push({ rowid, reason, note });

  for (const row of rows) {
    if (row.is_from_me === 1) {
      // Our own replies. Parsing them turns the agent into its own user.
      drop(row.rowid, 'outbound', 'sent by us');
      continue;
    }
    if (row.associated_message_type !== 0) {
      drop(row.rowid, 'tapback', `associated_message_type=${row.associated_message_type}`);
      continue;
    }
    if (row.item_type !== 0) {
      drop(row.rowid, 'systemRow', `item_type=${row.item_type}`);
      continue;
    }

    const body = (row.text ?? (row.attributedBody ? decodeAttributedBody(row.attributedBody) : null))
      ?.trim();
    if (!body) {
      drop(row.rowid, 'noBody', 'no text and nothing decodable in attributedBody');
      continue;
    }

    const handleHash = row.handle ? hashHandle(row.handle, options.salt) : '';
    if (!options.allowlist.has(handleHash)) {
      // Checked BEFORE parsing and before a token is spent. An agent with
      // tool access that answers arbitrary inbound messages is a remote
      // execution surface with a friendly interface.
      drop(row.rowid, 'notAllowlisted', 'sender not on the allowlist');
      continue;
    }

    messages.push({
      rowid: row.rowid,
      handleHash,
      body,
      receivedAt: fromAppleNanoseconds(row.date),
    });
  }

  return { messages, dropped };
}

/** Builds the hashed allowlist from plaintext handles held in config. */
export function buildAllowlist(handles: readonly string[], salt: string): ReadonlySet<string> {
  return new Set(handles.map((h) => hashHandle(normalizeHandle(h), salt)));
}

const QUERY = `
  SELECT m.ROWID as rowid, m.text, m.attributedBody, m.is_from_me,
         m.item_type, m.associated_message_type, m.date, h.id as handle
  FROM message m
  LEFT JOIN handle h ON h.ROWID = m.handle_id
  WHERE m.ROWID > ?
  ORDER BY m.ROWID ASC
`;

/** Reads rows newer than the last one seen. */
export function readNewRows(dbPath: string, afterRowId: number): readonly RawMessageRow[] {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db.prepare(QUERY).all(afterRowId) as RawMessageRow[];
  } finally {
    db.close();
  }
}

/** A log line for a message that reveals neither the sender nor the text. */
export function describeInbound(message: InboundMessage): string {
  return `rowid=${message.rowid} from=${message.handleHash.slice(0, 12)}… body=${describeBody(message.body)}`;
}

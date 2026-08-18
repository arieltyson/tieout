/**
 * Handle normalization, hashing, and redaction.
 *
 * Three jobs that all exist for the same reason: a message handle is a
 * phone number or an email address belonging to a real person, and it
 * should appear in as few places as possible.
 *
 * Normalization comes first because an allowlist that compares raw strings
 * is not an allowlist. The same person arrives as `+15555550100`,
 * `555-555-0100`, and `(555) 555-0100` depending on how Messages happened
 * to store the row, and a check that misses two of those is a check that
 * can be walked around by accident.
 *
 * Hashing comes next because nothing downstream needs the real handle. The
 * allowlist compares hashes, the audit log stores hashes, and the plaintext
 * exists only where a message is actually sent.
 *
 * Redaction comes last because the other two are useless if an error three
 * layers down prints the thing anyway.
 */
import { createHash } from 'node:crypto';

/**
 * Reduces a handle to a comparable form.
 *
 * Phone numbers become E.164 where that can be done without guessing. A ten
 * digit number is assumed North American, which is the only assumption made
 * here and is stated rather than hidden. Emails lowercase and otherwise
 * pass through, because an email is already canonical.
 */
export function normalizeHandle(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return '';
  if (trimmed.includes('@')) return trimmed.toLowerCase();

  const digits = trimmed.replace(/[^\d+]/g, '');
  if (digits.startsWith('+')) return digits;
  const bare = digits.replace(/\D/g, '');
  if (bare.length === 11 && bare.startsWith('1')) return `+${bare}`;
  if (bare.length === 10) return `+1${bare}`;
  // Anything else is returned as found. Guessing a country code for a
  // handle we do not recognise would silently admit or exclude somebody.
  return trimmed;
}

/**
 * A stable, salted identifier for a handle.
 *
 * The salt must be secret for this to be worth anything: the space of phone
 * numbers is small enough to enumerate, so an unsalted hash is a phone
 * number with extra steps.
 */
export function hashHandle(handle: string, salt: string): string {
  if (salt.length < 16) {
    throw new Error(
      'Handle salt must be at least 16 characters. A short salt over a space '
        + 'as small as phone numbers is decoration.',
    );
  }
  return createHash('sha256').update(`${normalizeHandle(handle)}:${salt}`).digest('hex');
}

const PHONE = /\+?\d[\d\s().-]{6,}\d/g;
const EMAIL = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;

/**
 * Masks anything that identifies a person.
 *
 * Used by every logger, error formatter, and audit writer in the transport.
 * The defence has to live at the formatter rather than at each throw site:
 * an error thrown three layers down carries whatever context it was given,
 * and nobody remembers to sanitize on the way up.
 */
export function redact(value: string): string {
  return value.replace(EMAIL, '[email]').replace(PHONE, '[phone]');
}

/**
 * A message body reduced to what is safe to write down.
 *
 * Length and a short digest, never the text. If the content is genuinely
 * needed to debug something, it can be read from the source database
 * directly; that should be a deliberate act rather than the default state
 * of a log file sitting on a disk.
 */
export function describeBody(body: string): string {
  const digest = createHash('sha256').update(body).digest('hex').slice(0, 8);
  return `<${body.length} chars, ${digest}>`;
}

/** Formats an object for logging with every string redacted. */
export function safeFormat(value: unknown): string {
  return redact(
    JSON.stringify(value, (_key, v: unknown) => (typeof v === 'string' ? redact(v) : v)) ?? '',
  );
}

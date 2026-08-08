/**
 * Decoder for the `attributedBody` column of Apple's chat.db.
 *
 * The body is an NSKeyedArchiver "typedstream" blob (legacy NSArchiver
 * format — NOT a binary plist, so plist parsers fail on it).
 *
 * Provenance: validated during the Phase 0 transport spike against 500
 * real messages, using the `text` column as a ground-truth oracle.
 * 500/500 exact match. See test/fixtures/attributed-body.json.
 *
 * This is a FALLBACK. On current macOS the `text` column is populated for
 * real messages and this path may never execute. Callers should log at
 * `warn` when it does — that signals an OS behavior change.
 */

/**
 * Layout around the payload we want:
 *
 *   ... "NSString" <version bytes> 0x2B <length> <utf8 bytes> ...
 *                                   '+'
 *
 * Length encoding:
 *   0x00..0x7F  -> that byte is the length
 *   0x81        -> next 2 bytes, uint16 LE
 *   0x82        -> next 4 bytes, uint32 LE
 *
 * Emoji, tapbacks, and rich attachments produce more complex streams; this
 * handles the plain-text case, which is what a command interface needs.
 * If you later need full fidelity, port a real typedstream parser rather
 * than growing this function.
 */
export function decodeAttributedBody(buf: Buffer): string | null {
  const marker = buf.indexOf('NSString', 0, 'utf8');
  if (marker === -1) return null;

  let i = marker + 'NSString'.length;

  // Scan a short window forward for the '+' type marker.
  const limit = Math.min(i + 16, buf.length);
  while (i < limit && buf[i] !== 0x2b) i++;
  if (i >= limit) return crudeFallback(buf);
  i++; // step past '+'

  const lead = buf[i];
  if (lead === undefined) return null;

  let len: number;
  if (lead < 0x80) {
    len = lead;
    i += 1;
  } else if (lead === 0x81) {
    len = buf.readUInt16LE(i + 1);
    i += 3;
  } else if (lead === 0x82) {
    len = buf.readUInt32LE(i + 1);
    i += 5;
  } else {
    return crudeFallback(buf);
  }

  if (len <= 0 || i + len > buf.length) return crudeFallback(buf);
  return buf.subarray(i, i + len).toString('utf8');
}

/** Last resort: slice between known markers. Lossy, but better than nothing. */
export function crudeFallback(buf: Buffer): string | null {
  const s = buf.toString('utf8');
  const start = s.indexOf('NSString');
  if (start === -1) return null;
  const tail = s.slice(start + 8);
  const end = tail.search(/NSDictionary|NSNumber|__kIM/);
  const chunk = (end === -1 ? tail : tail.slice(0, end))
    .replace(/[\x00-\x1f\x7f]+/g, ' ')
    .trim();
  return chunk.length > 0 ? chunk : null;
}

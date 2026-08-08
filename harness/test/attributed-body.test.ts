import { describe, expect, test } from 'vitest';
import { decodeAttributedBody } from '../src/transport/attributed-body.js';
import fixtures from './fixtures/attributed-body.json' with { type: 'json' };

describe('decodeAttributedBody', () => {
  test.each(fixtures)('decodes fixture $rowid', ({ expected, blobBase64 }) => {
    expect(decodeAttributedBody(Buffer.from(blobBase64, 'base64'))).toBe(expected);
  });

  test('returns null on a blob with no NSString marker', () => {
    expect(decodeAttributedBody(Buffer.from('garbage'))).toBeNull();
  });

  test('exercises the uint16 length prefix', () => {
    const long = fixtures.filter((f) => Buffer.byteLength(f.expected) > 127);
    expect(long.length).toBeGreaterThan(0); // fails if the long fixture was never captured
  });
});

import { describe, expect, test } from 'vitest';
import {
  CentsSchema,
  PositiveCentsSchema,
  cents,
  fromDecimal,
  sum,
  toDisplay,
} from '../src/domain/money.js';

describe('cents', () => {
  test('accepts an integer', () => {
    expect(cents(1234)).toBe(1234);
  });

  test('rejects a non-integer', () => {
    expect(() => cents(12.5)).toThrow(/non-integer/i);
  });
});

describe('fromDecimal', () => {
  test('parses a whole-and-fractional amount', () => {
    expect(fromDecimal('12.34')).toBe(1234);
  });

  test('parses a whole-dollar amount with no decimal part', () => {
    expect(fromDecimal('12')).toBe(1200);
  });

  test('pads a single fractional digit', () => {
    expect(fromDecimal('12.3')).toBe(1230);
  });

  test('parses a sub-dollar amount', () => {
    expect(fromDecimal('0.05')).toBe(5);
  });

  test('parses a negative amount', () => {
    expect(fromDecimal('-12.34')).toBe(-1234);
  });

  test('normalizes negative zero to zero', () => {
    expect(Object.is(fromDecimal('-0.00'), -0)).toBe(false);
    expect(fromDecimal('-0.00')).toBe(0);
  });

  test('rejects more than two fractional digits', () => {
    expect(() => fromDecimal('12.345')).toThrow(/cannot parse/i);
  });

  test('rejects non-numeric input', () => {
    expect(() => fromDecimal('twelve dollars')).toThrow(/cannot parse/i);
  });

  // The classic case: 0.1 + 0.2 !== 0.3 in IEEE-754 floats. Parsing on the
  // string and summing as integers must not reproduce that error.
  test('0.1 + 0.2 sums exactly to 0.3, unlike raw floats', () => {
    expect(0.1 + 0.2).not.toBe(0.3); // sanity check the failure mode exists
    const total = sum([fromDecimal('0.1'), fromDecimal('0.2')]);
    expect(total).toBe(fromDecimal('0.3'));
    expect(total).toBe(30);
  });
});

describe('toDisplay', () => {
  test('formats a whole-and-fractional amount', () => {
    expect(toDisplay(cents(1234))).toBe('$12.34');
  });

  test('formats zero', () => {
    expect(toDisplay(cents(0))).toBe('$0.00');
  });

  test('formats a sub-dollar amount with a leading zero', () => {
    expect(toDisplay(cents(5))).toBe('$0.05');
  });

  test('formats a negative amount', () => {
    expect(toDisplay(cents(-1234))).toBe('-$12.34');
  });

  test('round-trips through fromDecimal', () => {
    expect(toDisplay(fromDecimal('1999.09'))).toBe('$1999.09');
  });
});

describe('sum', () => {
  test('sums a list of amounts exactly', () => {
    expect(sum([cents(100), cents(200), cents(300)])).toBe(600);
  });

  test('sums an empty list to zero', () => {
    expect(sum([])).toBe(0);
  });
});

// These schemas exist so that no loader has to reassert the Cents brand
// with a cast after validating elsewhere. The tests that matter here are
// the rejections: a cast would have laundered every one of these through.
describe('CentsSchema', () => {
  test('parses an integer', () => {
    expect(CentsSchema.parse(1234)).toBe(1234);
  });

  test('parses a negative integer', () => {
    expect(CentsSchema.parse(-1234)).toBe(-1234);
  });

  test('parses zero', () => {
    expect(CentsSchema.parse(0)).toBe(0);
  });

  test('rejects a float', () => {
    expect(CentsSchema.safeParse(12.34).success).toBe(false);
  });

  test('rejects the result of a float sum that lands off-integer', () => {
    expect(CentsSchema.safeParse(0.1 + 0.2).success).toBe(false);
  });

  test('rejects NaN and Infinity', () => {
    expect(CentsSchema.safeParse(Number.NaN).success).toBe(false);
    expect(CentsSchema.safeParse(Number.POSITIVE_INFINITY).success).toBe(false);
  });

  test('rejects a numeric string', () => {
    expect(CentsSchema.safeParse('1234').success).toBe(false);
  });
});

describe('PositiveCentsSchema', () => {
  test('parses a positive integer', () => {
    expect(PositiveCentsSchema.parse(1234)).toBe(1234);
  });

  test('rejects zero', () => {
    expect(PositiveCentsSchema.safeParse(0).success).toBe(false);
  });

  test('rejects a negative amount', () => {
    expect(PositiveCentsSchema.safeParse(-1).success).toBe(false);
  });

  test('rejects a positive float', () => {
    expect(PositiveCentsSchema.safeParse(12.34).success).toBe(false);
  });
});

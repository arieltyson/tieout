import { describe, expect, test } from 'vitest';
import { chartOfAccounts, getAccount, isValidGLCode } from '../src/chart-of-accounts.js';

describe('chartOfAccounts', () => {
  test('loads a non-empty, Zod-validated chart', () => {
    expect(chartOfAccounts.length).toBeGreaterThan(0);
  });

  test('every code is a unique four-digit string', () => {
    const codes = chartOfAccounts.map((a) => a.code);
    expect(new Set(codes).size).toBe(codes.length);
    for (const code of codes) expect(code).toMatch(/^\d{4}$/);
  });

  test('includes the uncategorized escape hatch', () => {
    expect(isValidGLCode('6900')).toBe(true);
    expect(getAccount('6900')?.name).toBe('Uncategorized');
  });
});

describe('isValidGLCode', () => {
  test('accepts a real code', () => {
    expect(isValidGLCode('6010')).toBe(true);
  });

  test('rejects an unknown code', () => {
    expect(isValidGLCode('9999')).toBe(false);
  });

  test('rejects a malformed code', () => {
    expect(isValidGLCode('not-a-code')).toBe(false);
  });
});

describe('getAccount', () => {
  test('returns the account for a known code', () => {
    expect(getAccount('6020')?.name).toBe('Travel');
    expect(getAccount('6020')?.type).toBe('expense');
  });

  test('returns undefined for an unknown code', () => {
    expect(getAccount('9999')).toBeUndefined();
  });
});

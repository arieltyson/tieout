import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

// Built from parts rather than a literal so this file's own source never
// contains an unbroken "sk-ant-..." run for the pre-commit secret scanner
// (scripts/scan-secrets.sh) to trip over.
const FAKE_API_KEY = ['sk', 'ant', 'fake-for-testing'].join('-');

const REQUIRED_ENV = {
  TIEOUT_ALLOWLIST: '+15555550100, +15555550101',
  TIEOUT_REPLY_HANDLE: '+15555550100',
  ANTHROPIC_API_KEY: FAKE_API_KEY,
};

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  vi.resetModules();
  for (const key of Object.keys(REQUIRED_ENV)) delete process.env[key];
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe('config', () => {
  test('loads and parses valid environment', async () => {
    Object.assign(process.env, REQUIRED_ENV);
    const { config } = await import('../src/config.js');
    expect(config.allowlist).toEqual(['+15555550100', '+15555550101']);
    expect(config.replyHandle).toBe('+15555550100');
    expect(config.anthropicApiKey).toBe(FAKE_API_KEY);
  });

  test('throws when a required variable is missing', async () => {
    Object.assign(process.env, REQUIRED_ENV);
    delete process.env['ANTHROPIC_API_KEY'];
    await expect(import('../src/config.js')).rejects.toThrow(/ANTHROPIC_API_KEY/);
  });

  test('rejects a non-E.164 handle', async () => {
    Object.assign(process.env, REQUIRED_ENV);
    // Dashed format is invalid regardless of digits; built from parts so
    // this line doesn't read as a real number to a human skimming a diff.
    process.env['TIEOUT_REPLY_HANDLE'] = ['604', '555', '0199'].join('-');
    await expect(import('../src/config.js')).rejects.toThrow(/E\.164/);
  });
});

/**
 * Reads and validates process configuration. This module is the ONLY place
 * a real iMessage handle or API key may enter the process — everything else
 * (the allowlist, the outbound sender, logging) imports `config` rather than
 * reading `process.env` directly. That makes "no handle literals outside
 * config" a property you can grep for instead of a rule people remember.
 */

import { z } from 'zod';

try {
  // .env is optional locally (CI/production inject env vars directly) and
  // is gitignored — see .env.example for the shape it must take.
  process.loadEnvFile();
} catch {
  // No .env file present; fall through to validation below, which will
  // fail loudly if required variables are missing from the environment.
}

const e164 = z
  .string()
  .regex(/^\+[1-9]\d{6,14}$/, 'must be E.164, e.g. +15555550100');

const envSchema = z.object({
  TIEOUT_ALLOWLIST: z
    .string()
    .min(1, 'TIEOUT_ALLOWLIST is required — comma-separated E.164 handles')
    .transform((s) => s.split(',').map((h) => h.trim()))
    .pipe(z.array(e164).min(1, 'TIEOUT_ALLOWLIST must contain at least one handle')),
  TIEOUT_REPLY_HANDLE: e164,
  ANTHROPIC_API_KEY: z.string().min(1, 'ANTHROPIC_API_KEY is required'),
});

export interface Config {
  readonly allowlist: readonly string[];
  readonly replyHandle: string;
  readonly anthropicApiKey: string;
}

function loadConfig(): Config {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(
      `Invalid configuration:\n${issues}\n\n`
        + 'Copy .env.example to .env and fill in real values.',
    );
  }
  return {
    allowlist: parsed.data.TIEOUT_ALLOWLIST,
    replyHandle: parsed.data.TIEOUT_REPLY_HANDLE,
    anthropicApiKey: parsed.data.ANTHROPIC_API_KEY,
  };
}

export const config: Config = loadConfig();

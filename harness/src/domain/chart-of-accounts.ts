/**
 * The chart of accounts: loaded from JSON and Zod-validated at import time,
 * not lazily. A malformed chart should fail the process on startup, not on
 * the first transaction that happens to touch it.
 *
 * Lives in the harness domain rather than in fixtures/ because the
 * `gl_codes_exist` verifier needs it, and fixtures already imports from
 * harness — putting it the other way round would make the dependency
 * circular. It is also reference data an accounting system supplies in
 * reality, not something synthetic about this benchmark.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

export const AccountType = z.enum([
  'asset',
  'liability',
  'equity',
  'revenue',
  'cogs',
  'expense',
]);
export type AccountType = z.infer<typeof AccountType>;

export const AccountSchema = z.object({
  code: z.string().regex(/^\d{4}$/, 'GL code must be four digits'),
  name: z.string().min(1),
  type: AccountType,
});
export type Account = z.infer<typeof AccountSchema>;

const ChartOfAccountsSchema = z.object({
  accounts: z.array(AccountSchema).min(1),
});

const DATA_PATH = fileURLToPath(new URL('../../data/chart-of-accounts.json', import.meta.url));

function loadChartOfAccounts(): readonly Account[] {
  const raw = readFileSync(DATA_PATH, 'utf-8');
  const parsed = ChartOfAccountsSchema.safeParse(JSON.parse(raw));
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid chart of accounts at ${DATA_PATH}:\n${issues}`);
  }
  const codes = new Set<string>();
  for (const account of parsed.data.accounts) {
    if (codes.has(account.code)) {
      throw new Error(`Duplicate GL code in chart of accounts: ${account.code}`);
    }
    codes.add(account.code);
  }
  return parsed.data.accounts;
}

export const chartOfAccounts: readonly Account[] = loadChartOfAccounts();

const validGLCodes = new Set(chartOfAccounts.map((a) => a.code));

/** Used by the `gl_codes_exist` verifier — every proposed code must appear here. */
export function isValidGLCode(code: string): boolean {
  return validGLCodes.has(code);
}

export function getAccount(code: string): Account | undefined {
  return chartOfAccounts.find((a) => a.code === code);
}

/** The deliberate escape hatch — an agent that reaches for this too often is punting, not categorizing. */
export const UNCATEGORIZED_GL_CODE = '6900';

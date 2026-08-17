/**
 * Scoring against the ground-truth manifest.
 *
 * Metric definitions are fixed in evals/RESULTS.md and implemented here.
 * Exact GL-code match: no fuzzy matching, no partial credit for the right
 * account type.
 */
import type { CategorizationRecord } from '../../harness/src/tools/categorizer-tools.js';
import { UNCATEGORIZED_GL_CODE } from '../../harness/src/domain/chart-of-accounts.js';

export interface CategorizationScore {
  readonly attempted: number;
  readonly expected: number;
  readonly correct: number;
  readonly incorrect: number;
  /** Expected a categorization, got none. */
  readonly missing: number;
  /** Proposed twice — counted once, and flagged. */
  readonly duplicated: number;
  readonly accuracy: number;
  /** Fraction filed to 6900. Tracked separately: punting is not accuracy. */
  readonly escapeHatchRate: number;
  /** Cases where 6900 was correct, i.e. ground truth also says 6900. */
  readonly escapeHatchCorrect: number;
  readonly worstConfusions: readonly {
    readonly expected: string;
    readonly actual: string;
    readonly count: number;
  }[];
}

export function scoreCategorizations(
  proposed: readonly CategorizationRecord[],
  expected: Readonly<Record<string, string>>,
): CategorizationScore {
  const seen = new Map<string, string>();
  let duplicated = 0;
  for (const p of proposed) {
    if (seen.has(p.txnId)) {
      duplicated += 1;
      continue;
    }
    seen.set(p.txnId, p.glCode);
  }

  const expectedIds = Object.keys(expected);
  let correct = 0;
  let incorrect = 0;
  let missing = 0;
  let escapeHatch = 0;
  let escapeHatchCorrect = 0;
  const confusion = new Map<string, number>();

  for (const txnId of expectedIds) {
    const want = expected[txnId]!;
    const got = seen.get(txnId);
    if (got === undefined) {
      missing += 1;
      continue;
    }
    if (got === UNCATEGORIZED_GL_CODE) {
      escapeHatch += 1;
      if (want === UNCATEGORIZED_GL_CODE) escapeHatchCorrect += 1;
    }
    if (got === want) correct += 1;
    else {
      incorrect += 1;
      const key = `${want}->${got}`;
      confusion.set(key, (confusion.get(key) ?? 0) + 1);
    }
  }

  const worstConfusions = [...confusion.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([key, count]) => {
      const [exp = '', act = ''] = key.split('->');
      return { expected: exp, actual: act, count };
    });

  return {
    attempted: seen.size,
    expected: expectedIds.length,
    correct,
    incorrect,
    missing,
    duplicated,
    accuracy: expectedIds.length === 0 ? 0 : correct / expectedIds.length,
    escapeHatchRate: expectedIds.length === 0 ? 0 : escapeHatch / expectedIds.length,
    escapeHatchCorrect,
    worstConfusions,
  };
}

/** Published Anthropic pricing, USD per million tokens. */
const PRICING: Record<string, { input: number; output: number }> = {
  'claude-sonnet-5': { input: 3, output: 15 },
  'claude-opus-5': { input: 15, output: 75 },
  'claude-haiku-4-5': { input: 1, output: 5 },
};

export function estimateCostUsd(
  model: string,
  inputTokens: number,
  outputTokens: number,
): number | null {
  const key = Object.keys(PRICING).find((k) => model.startsWith(k));
  if (!key) return null;
  const price = PRICING[key]!;
  return (inputTokens / 1e6) * price.input + (outputTokens / 1e6) * price.output;
}

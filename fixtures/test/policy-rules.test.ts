import { describe, expect, test } from 'vitest';
import { getPolicyRule, policyRules } from '../src/policy-rules.js';

describe('policyRules', () => {
  test('loads a non-empty, Zod-validated rule set', () => {
    expect(policyRules.length).toBeGreaterThan(0);
  });

  test('every rule has a positive threshold', () => {
    for (const rule of policyRules) {
      expect(rule.thresholdCents).toBeGreaterThan(0);
    }
  });
});

describe('getPolicyRule', () => {
  test('returns the rule for a known id', () => {
    expect(getPolicyRule('single-txn-limit')?.thresholdCents).toBe(75000);
  });

  test('returns undefined for an unknown id', () => {
    expect(getPolicyRule('not-a-rule')).toBeUndefined();
  });
});

/**
 * Spend policy. Lives in the harness domain because the policy detector
 * needs it, and fixtures already imports from harness — the other direction
 * would make the dependency circular. Like the chart of accounts, this is
 * reference data a real finance team supplies, not something synthetic
 * about the benchmark.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

export const PolicyRuleSchema = z.object({
  id: z.string().min(1),
  description: z.string().min(1),
  glScope: z.string().regex(/^\d{4}$/).nullable(),
  thresholdCents: z.number().int().positive(),
});
export type PolicyRule = z.infer<typeof PolicyRuleSchema>;

const PolicyRulesSchema = z.object({
  rules: z.array(PolicyRuleSchema).min(1),
});

const DATA_PATH = fileURLToPath(new URL('../../data/policy-rules.json', import.meta.url));

function loadPolicyRules(): readonly PolicyRule[] {
  const raw = readFileSync(DATA_PATH, 'utf-8');
  const parsed = PolicyRulesSchema.safeParse(JSON.parse(raw));
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid policy rules at ${DATA_PATH}:\n${issues}`);
  }
  return parsed.data.rules;
}

export const policyRules: readonly PolicyRule[] = loadPolicyRules();

export function getPolicyRule(id: string): PolicyRule | undefined {
  return policyRules.find((r) => r.id === id);
}

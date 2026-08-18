/**
 * Anomaly scoring against the ground-truth manifest.
 *
 * Reported per defect category as well as overall, deliberately. A system
 * that aces duplicates and misses every FX mismatch should not be able to
 * hide behind an average — that is the number the eval exists to expose.
 */
import type { Finding } from '../../harness/src/agents/anomaly-hunter.js';
import type { GroundTruth, PlantedDefect } from '../../fixtures/src/types.js';

export interface CategoryScore {
  readonly kind: string;
  readonly planted: number;
  readonly reported: number;
  readonly truePositives: number;
  readonly falsePositives: number;
  readonly precision: number;
  readonly recall: number;
  readonly f1: number;
  /** Which side of the split produced the findings for this category. */
  readonly source: 'deterministic' | 'model' | 'mixed' | 'none';
}

export interface AnomalyScore {
  readonly byCategory: readonly CategoryScore[];
  readonly overallPrecision: number;
  readonly overallRecall: number;
  readonly overallF1: number;
  readonly deterministicFindings: number;
  readonly modelFindings: number;
}

const KINDS = [
  'duplicate',
  'vendorAlias',
  'fxMismatch',
  'receiptMismatch',
  'missingRecurring',
  'policyViolation',
  'priceAnomaly',
  'unreconciled',
  'bankOnly',
  'bankAmountMismatch',
] as const;

/**
 * A finding matches a planted defect when they overlap on any transaction.
 *
 * Exact set equality would be too strict: a vendor-alias group legitimately
 * spans more transactions than ground truth lists, and a recurring-gap
 * finding names the last prior charge while ground truth names the whole
 * prior series. Overlap is the honest criterion for "found the same thing".
 */
function overlaps(a: readonly string[], b: readonly string[]): boolean {
  const set = new Set(a);
  return b.some((id) => set.has(id));
}

/**
 * Whether a finding and a defect describe the same thing.
 *
 * Bank only findings reference no transaction at all, so comparing
 * transaction ids compares two empty lists and matches everything against
 * everything. An earlier version of this function did exactly that and
 * reported precision 1.00 while returning forty eight findings for four
 * planted defects. They are matched on the bank row instead.
 */
function describesSame(finding: Finding, defect: PlantedDefect): boolean {
  if (finding.kind === 'bankOnly') {
    const defectBankId = (defect as { bankId?: string }).bankId;
    return defectBankId !== undefined && finding.bankId === defectBankId;
  }
  return overlaps(finding.txnIds, defect.txnIds);
}

function scoreKind(
  kind: string,
  findings: readonly Finding[],
  planted: readonly PlantedDefect[],
): CategoryScore {
  const reported = findings.filter((f) => f.kind === kind);
  const expected = planted.filter((d) => d.kind === kind);

  const matchedDefects = new Set<string>();
  let truePositives = 0;
  for (const finding of reported) {
    const hit = expected.find((d) => describesSame(finding, d));
    if (hit) {
      truePositives += 1;
      matchedDefects.add(hit.id);
    }
  }
  const falsePositives = reported.length - truePositives;

  const precision = reported.length === 0 ? 0 : truePositives / reported.length;
  const recall = expected.length === 0 ? 0 : matchedDefects.size / expected.length;
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);

  const sources = new Set(reported.map((f) => f.source));
  const source: CategoryScore['source'] =
    sources.size === 0 ? 'none' : sources.size > 1 ? 'mixed' : [...sources][0]!;

  return {
    kind,
    planted: expected.length,
    reported: reported.length,
    truePositives,
    falsePositives,
    precision,
    recall,
    f1,
    source,
  };
}

export function scoreAnomalies(
  findings: readonly Finding[],
  groundTruth: GroundTruth,
): AnomalyScore {
  const byCategory = KINDS.map((kind) => scoreKind(kind, findings, groundTruth.plantedDefects));

  const totalReported = byCategory.reduce((n, c) => n + c.reported, 0);
  const totalTruePositives = byCategory.reduce((n, c) => n + c.truePositives, 0);
  const totalPlanted = byCategory.reduce((n, c) => n + c.planted, 0);
  const matched = byCategory.reduce((n, c) => n + Math.round(c.recall * c.planted), 0);

  const overallPrecision = totalReported === 0 ? 0 : totalTruePositives / totalReported;
  const overallRecall = totalPlanted === 0 ? 0 : matched / totalPlanted;
  const overallF1 =
    overallPrecision + overallRecall === 0
      ? 0
      : (2 * overallPrecision * overallRecall) / (overallPrecision + overallRecall);

  return {
    byCategory,
    overallPrecision,
    overallRecall,
    overallF1,
    deterministicFindings: findings.filter((f) => f.source === 'deterministic').length,
    modelFindings: findings.filter((f) => f.source === 'model').length,
  };
}

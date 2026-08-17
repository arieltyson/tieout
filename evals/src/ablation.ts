/**
 * Ablation configuration.
 *
 * Every component the architecture claims is load-bearing gets a switch, so
 * the claim can be tested by removing it and re-running the same fixture.
 * A component whose removal changes nothing is not an architecture, it is
 * decoration — the same standard the mutation testing applies to individual
 * predicates, applied to whole subsystems.
 *
 * Five toggles is 32 configurations. Six are worth running: the baseline
 * plus each toggle disabled on its own. Interaction effects are interesting
 * but not worth 26 extra paid runs before the singles are understood.
 */

export interface AblationConfig {
  /** The verifier bank. Off means nothing gates proposals before a human. */
  readonly deterministicVerifiers: boolean;
  /** Known merchant -> GL mappings applied in code before the model is called. */
  readonly vendorMemory: boolean;
  /** Off means one flat context instead of isolated sub-agents. */
  readonly subAgentIsolation: boolean;
  /**
   * The deterministic detectors. Off means the model is asked to FIND
   * anomalies rather than judge candidates — the single most expensive
   * thing this architecture avoids.
   */
  readonly deterministicPrePass: boolean;
  /** Feeding verifier failures back to the originating agent to repair. */
  readonly selfCorrection: boolean;
}

export const BASELINE: AblationConfig = {
  deterministicVerifiers: true,
  vendorMemory: true,
  subAgentIsolation: true,
  deterministicPrePass: true,
  selfCorrection: true,
};

export interface AblationVariant {
  readonly name: string;
  readonly config: AblationConfig;
  /** What this run is supposed to demonstrate, written before it is run. */
  readonly hypothesis: string;
}

const off = (key: keyof AblationConfig): AblationConfig => ({ ...BASELINE, [key]: false });

/**
 * The six runs, with a hypothesis recorded for each BEFORE any of them
 * execute. Writing the expected direction in advance is what stops a
 * surprising result from being quietly reinterpreted as the thing you
 * expected all along.
 */
export const VARIANTS: readonly AblationVariant[] = [
  {
    name: 'baseline',
    config: BASELINE,
    hypothesis: 'Reference row. Everything else is measured as a delta from this.',
  },
  {
    name: 'no-deterministic-verifiers',
    config: off('deterministicVerifiers'),
    hypothesis:
      'Accuracy should fall and bad proposals should reach the approval gate. If it changes '
      + 'nothing, the bank is catching errors the model was not making and the architecture is '
      + 'not earning it.',
  },
  {
    name: 'no-vendor-memory',
    config: off('vendorMemory'),
    hypothesis:
      'Cost should rise sharply — every known merchant goes back to the model — while accuracy '
      + 'moves little. This toggle is expected to be about price, not quality.',
  },
  {
    name: 'no-sub-agent-isolation',
    config: off('subAgentIsolation'),
    hypothesis:
      'One flat context should raise cost the most and degrade the later stages, because the '
      + 'ledger rows crowd out the reasoning by the time anomalies are considered.',
  },
  {
    name: 'no-deterministic-pre-pass',
    config: off('deterministicPrePass'),
    hypothesis:
      'The sharpest expected drop. The detectors score P 1.00 / R 0.77 for zero tokens; asking '
      + 'the model to FIND rather than judge should cost far more and score worse.',
  },
  {
    name: 'no-self-correction',
    config: off('selfCorrection'),
    hypothesis:
      'Turns and cost should fall while blocked proposals rise — cheaper runs that need more '
      + 'human intervention. A win on the cost column is not a win.',
  },
];

export function variantByName(name: string): AblationVariant | undefined {
  return VARIANTS.find((v) => v.name === name);
}

export function describeConfig(config: AblationConfig): string {
  const disabled = (Object.keys(BASELINE) as (keyof AblationConfig)[]).filter((k) => !config[k]);
  return disabled.length === 0 ? 'baseline (all components enabled)' : `disabled: ${disabled.join(', ')}`;
}

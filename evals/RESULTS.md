# Benchmark Results

**First measured run: 2026-08-17.** The metric definitions below were fixed
before any number existed, and have not been changed since.

The ablation matrix is still pending — those runs need the toggles wired
through the harness. What follows is the baseline configuration only.

## Baseline — claude-sonnet-5, 370 transactions, 2026-06

| | |
|---|---|
| Categorization accuracy | **95.1%** (352/370 exact GL match) |
| Anomaly F1 | **0.94** (P 0.92 / R 0.96) |
| Escape-hatch rate | 4.9% (18/370, all correct) |
| Verifier blocks | 0 |
| Turns | 20 (17 categorizer over 8 batches, 3 anomaly) |
| Tokens | 83,352 in / 49,774 out (29,776 cached) |
| Cost | **$1.00** |
| Wall clock | 291s |

### Anomalies by category

| Category | Planted | Found | Precision | Recall | Found by |
|---|---|---|---|---|---|
| FX mismatch | 7 | 7 | 1.00 | 1.00 | deterministic |
| Receipt mismatch | 9 | 9 | 1.00 | 1.00 | deterministic |
| Policy violation | 10 | 10 | 1.00 | 1.00 | deterministic |
| Missing recurring | 5 | 5 | 1.00 | 1.00 | deterministic |
| Price anomaly | 6 | 5 | 1.00 | 0.83 | deterministic |
| Vendor alias | 4 | 5 | 0.80 | 1.00 | model |
| Duplicate | 6 | 8 | 0.63 | 0.83 | model |

**The split is the result.** Five categories are solved exactly by arithmetic
for zero tokens. The two the model handles are the two it was given because
arithmetic provably cannot do them — and they are also the two with the
lowest precision, which is the honest shape of the trade rather than an
embarrassment. The model over-flags duplicates: three of its eight calls were
legitimate repeat purchases.

Notably the model found all four vendor-alias groups including the one the
deterministic pass structurally cannot reach, where the merchant's descriptor
carries a different numeric suffix on every charge.

### Where the categorizer was wrong

All 18 misses fall into three clusters, and every one is a debatable
classification rather than a clear error:

| Ground truth | Model | Count | Vendor |
|---|---|---|---|
| 6060 Marketing | 6010 Software | 10 | `CANVA PRO` |
| 6080 Telecom | 6010 Software | 5 | `TWILIO INC` |
| 6900 Uncategorized | 6050 Professional Services | 3 | `VENDOR SVCS LLC` and similar |

Canva Pro genuinely is a software subscription. Twilio is a communications
API and could sit in either account. The third cluster is the model
committing where the manifest says punt.

**Ground truth has not been changed to match.** Adjusting the answer key
after seeing the output is the failure this whole document exists to prevent.
The honest reading is that 95.1% is a floor: a chart of accounts with
sharper boundaries, or a policy note on where Canva belongs, would raise it
without the harness changing at all.

---

## What is being measured

The claim under test is **that the harness matters more than the model**. The
same model, run through progressively degraded versions of the same harness,
should produce measurably worse accounting. If it doesn't, the architecture
isn't earning its complexity and the README should say so.

## The fixture

Measurements run against the committed synthetic ledger — same seed, same
ledger, every run. CI regenerates it on every push and fails on any drift.

| | |
|---|---|
| Seed | `20260601` |
| Period | `2026-06` |
| Transactions | 400 |
| Expected GL codes | 400 (one per transaction) |
| Planted defects | 47, across 7 categories |
| Chart of accounts | 18 accounts |

Ground truth is emitted by the generator in the same pass that plants each
defect, so the answer key cannot drift from what was actually planted. A test
asserts that no ground-truth key is reachable from the ledger snapshot — the
agent sees only what an accountant would see.

### Planted defects by category

| Category | Count | What the agent must detect |
|---|---|---|
| Policy violation | 10 | Charge over a named limit with no approval on file |
| Receipt mismatch | 9 | Receipt total ≠ posted transaction amount |
| FX mismatch | 7 | EUR conversion off by a few cents, exact delta reported |
| Duplicate charge | 6 | Same vendor, amount, and date, charged twice |
| Price anomaly | 6 | Vendor jumps 40%+ month-over-month, flagged as anomaly not duplicate |
| Missing recurring | 5 | Monthly charge that silently stops; gap detected, accrual proposed |
| Vendor alias | 4 | One entity under multiple descriptors, merged to one canonical vendor |

Three adversarial merchant descriptors are also planted (prompt-injection
payloads). They are **not** scored below; the regression that proves the agent
ignores them lands with the transport layer in Phase 6.5.

## Metric definitions

Fixed now so they can't be redefined to fit a result later.

- **Categorization accuracy** — exact GL-code match against
  `expectedCategorizations`. Not fuzzy, not "close enough", not partial credit
  for the right account type. Exact string equality on the four-digit code.
- **Anomaly precision** — of the defects the agent flagged, the fraction that
  were genuinely planted. Punishes crying wolf.
- **Anomaly recall** — of the 47 planted defects, the fraction found. Punishes
  quiet misses, which in a close are the expensive kind.
- **Anomaly F1** — harmonic mean of the two, reported per defect category as
  well as overall. A system that aces duplicates and misses every FX mismatch
  should not hide behind an average.
- **Escape-hatch rate** — the fraction of transactions filed to
  `6900 Uncategorized`. Tracked separately and deliberately: an agent that
  punts on 30% of the ledger is not doing the job, however accurate it is on
  the remainder. High accuracy paired with a high escape-hatch rate is a
  failing result, not a passing one.
- **Verifier block rate** — how often the deterministic bank caught something
  before a human saw it. This is the number that justifies the architecture.
- **Cost per run / tokens per run / turns per run / wall clock** — measured,
  not estimated.

## Ablation matrix

**Pending.** Five toggles is 32 configurations; six are worth running: the
baseline, plus each component disabled individually. Configurations and
per-variant hypotheses are committed in `evals/src/ablation.ts`, written
before the runs so a surprising result cannot be quietly reinterpreted
afterwards.

| Configuration | Categorization accuracy | Anomaly F1 | Escape-hatch rate | Verifier block rate | Median turns | Cost / run |
|---|---|---|---|---|---|---|
| Baseline (full harness) | pending | pending | pending | pending | pending | pending |
| — deterministic verifiers | pending | pending | pending | pending | pending | pending |
| — vendor memory | pending | pending | pending | pending | pending | pending |
| — sub-agent isolation | pending | pending | pending | pending | pending | pending |
| — deterministic pre-pass | pending | pending | pending | pending | pending | pending |
| — self-correction cycle | pending | pending | pending | pending | pending | pending |

## Model comparison

The same harness against two or three models, to separate harness
contribution from model capability.

| Model | Categorization accuracy | Anomaly F1 | Cost / run |
|---|---|---|---|
| pending | pending | pending | pending |

## Honest limitations

Recorded now, while there's no result to be defensive about.

- **The ledger is synthetic.** It's generated by a program, so its defects are
  the defects that program knows how to plant. Real ledgers are messier in ways
  this fixture doesn't anticipate, and a number measured here is a claim about
  this fixture, not about production accounting.
- **The fixture author and the harness author are the same person.** Some
  circularity is unavoidable in a solo benchmark. Mitigated by writing the
  ground truth in the same pass that plants each defect and by fixing these
  metric definitions before any result exists — but it is not eliminated.
- **One seed, one month.** Results on a single fixture are a point estimate.
  Multi-seed variance is worth reporting before treating any gap as real.
- **Some ground-truth labels are debatable.** Every categorization miss in
  the baseline run was on a vendor that could reasonably sit in two
  accounts. That makes 95.1% a floor rather than a ceiling, and it means
  small accuracy differences between configurations should not be
  over-read — a 2-point gap is within the noise of how the chart of
  accounts was drawn.
- **The duplicate judgment is the weakest link and the most interesting
  one.** Precision 0.63 is the model deciding that identical same-day
  charges are double charges when some are simply repeat purchases. No
  deterministic rule separates them, which is exactly why it was given to
  the model — but it is where a human reviewer will spend their attention.

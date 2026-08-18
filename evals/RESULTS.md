# Benchmark Results

**Measured against fixture v2 on 2026-08-18.** The metric definitions below
were fixed before any number existed, and have not been changed since.

Numbers here supersede an earlier run against fixture v1. The fixture gained
bank reconciliation, taking it from 47 planted defects to 60 across ten
categories rather than seven. Anomaly scores from the two runs are not
comparable, and the fixture carries a version field so the mismatch is
visible rather than silent.

## Baseline — claude-sonnet-5, 370 transactions, 2026-06

| | |
|---|---|
| Categorization accuracy | **94.1%** (348/370 exact GL match) |
| Anomaly F1 | **0.90** (P 0.93 / R 0.87) |
| Escape-hatch rate | 5.1% (19/370, all correct) |
| Verifier blocks | 0 |
| Turns | 27 |
| Cost | **$1.41** |

### Anomalies by category

| Category | Planted | Found | Precision | Recall | Found by |
|---|---|---|---|---|---|
| FX mismatch | 7 | 7 | 1.00 | 1.00 | deterministic |
| Receipt mismatch | 9 | 9 | 1.00 | 1.00 | deterministic |
| Policy violation | 10 | 10 | 1.00 | 1.00 | deterministic |
| Missing recurring | 5 | 5 | 1.00 | 1.00 | deterministic |
| Price anomaly | 6 | 5 | 1.00 | 0.83 | deterministic |
| Bank amount mismatch | 4 | 3 | 1.00 | 0.75 | deterministic |
| Unreconciled | 5 | 3 | 1.00 | 0.60 | deterministic |
| Bank only | 4 | 1 | 1.00 | 0.25 | deterministic |
| Vendor alias | 4 | 5 | 0.80 | 1.00 | model |
| Duplicate | 6 | 8 | 0.63 | 0.83 | model |

43 findings came from arithmetic, 13 from the model.

**The split is the result.** Eight categories are solved by arithmetic for
zero tokens. The two the model handles are the two it was given because
arithmetic provably cannot do them — and they are also the only two that
score below 1.00 on precision, which is the honest shape of the trade rather
than an embarrassment. The model over-flags duplicates: three of its eight
calls were legitimate repeat purchases.

Notably the model found all four vendor-alias groups including the one the
deterministic pass structurally cannot reach, where the merchant's descriptor
carries a different numeric suffix on every charge.

### Why reconciliation recall is low, and why that is the intended trade

The three new categories are the three weakest by recall, and they are the
reason overall F1 sits at 0.90 rather than the 0.94 measured against the
smaller fixture. Bank-only recall of 0.25 is the worst number in this
document.

It is also deliberate. The reconciler matches a ledger row to a bank row only
when the pairing is mutually unique, and breaks ties on settlement proximity
only when one candidate is strictly closer than the next. When several bank
rows plausibly explain the same charge, it declines to choose and excludes
the contested rows from the bank-only set rather than reporting them as
orphans.

The cost of that rule is visible above as missed defects. What it buys is the
other column: **precision is 1.00 across all three reconciliation
categories.** Not one clean pairing was reported as a discrepancy.

That is the right direction for the error to run. A missed exception surfaces
next month when the account still does not tie. A false one sends an
accountant to chase a payment that reconciled correctly, and doing that a few
times is how a control stops being read at all. An earlier version of the
matching loop claimed bank rows greedily and scored better on recall while
inventing mismatches, which is the failure this rule exists to prevent.

### Where the categorizer was wrong

All 18 misses fall into three clusters, and every one is a debatable
classification rather than a clear error:

| Ground truth | Model | Count | Vendor |
|---|---|---|---|
| 6060 Marketing | 6010 Software | 11 | `CANVA PRO` |
| 6080 Telecom | 6010 Software | 9 | `TWILIO INC` |
| 6900 Uncategorized | 6050 Professional Services | 2 | `VENDOR SVCS LLC` and similar |

Canva Pro genuinely is a software subscription. Twilio is a communications
API and could sit in either account. The third cluster is the model
committing where the manifest says punt.

**Ground truth has not been changed to match.** Adjusting the answer key
after seeing the output is the failure this whole document exists to prevent.
The honest reading is that 94.1% is a floor: a chart of accounts with
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
| Fixture version | 2 |
| Seed | `20260601` |
| Period | `2026-06` |
| Transactions | 400 (370 in the closing period) |
| Expected GL codes | 400 (one per transaction) |
| Planted defects | 60, across 10 categories |
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
| Unreconciled | 5 | Ledger row the bank never posted |
| Vendor alias | 4 | One entity under multiple descriptors, merged to one canonical vendor |
| Bank only | 4 | Bank row with no ledger entry behind it |
| Bank amount mismatch | 4 | Row that settled for a different amount than it posted |

The bank feed is generated as a separate view of the same month, with
settlement lag of nought to three days and its own descriptors, so matching
it back is a real problem rather than a lookup by shared key.

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
- **Anomaly recall** — of the 60 planted defects, the fraction found. Punishes
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

Each component disabled in turn, same fixture, same model, same seed.
Hypotheses were written in `evals/src/ablation.ts` before any of these ran.

| Configuration | Accuracy | Anomaly F1 | Turns | Cost | Delta vs baseline |
|---|---|---|---|---|---|
| **Baseline** | **94.1%** | **0.90** | 27 | **$1.41** | reference |
| Second close, warm memory | **94.6%** | 0.89 | 11 | **$0.62** | 56% cheaper |
| No sub agent isolation | 91.9% | 0.87 | 19 | $1.93 | 37% dearer |
| No deterministic pre pass | no score | no score | 19 | $1.39 | ran out of context |
| No deterministic verifiers | 94.1% | 0.90 | 27 | $0.00 | none |
| No self correction | 94.1% | 0.90 | 27 | $0.00 | none |

Total spend for the matrix: $5.35.

### What each row means

**Context isolation is the clearest win.** One agent doing both jobs in one
conversation costs 37% more and scores worse on both measures. The
transactions accumulate in the window while the anomaly work happens, and
the model pays to re-read all of them on every turn. This is the row that
most directly supports the architecture.

**Vendor memory is the second.** The second close resolved 327 of 370
transactions from memory, cut cost by 56%, and took 11 turns against 27. Of
the 53 stems it learned, none were ever marked conflicted, so the Uber trap
never had to fire, though the guard that would catch it is tested
separately. Accuracy moved up a fraction and anomaly F1 down a fraction,
both well inside the noise of a single seed.

**The deterministic pre pass has no valid result on this fixture.** Without
the detectors the model searches the raw ledger itself, and against 60
defects across ten categories it exhausted its output ceiling before
finishing. The arm is recorded as truncated and its scores are withheld
rather than reported as zeros.

This is worth stating carefully, because the temptation is to read the
failure as a win for the architecture. It is not one. The ceiling is a
configuration choice, and a larger budget or a batched raw hunter might well
complete. What can be said is narrower: on the same budget that suffices for
every other arm, the configuration without detectors did not finish.

Against the earlier 47-defect fixture this arm did complete, and it
contradicted its own hypothesis — anomaly F1 rose slightly while cost rose
64%. That result is left on record in ADR-002. The prediction that removing
the detectors would cause "the sharpest expected drop" has now failed to be
confirmed twice, once by contradiction and once by truncation. The detectors
are kept for reasons the table does show, namely that they are free,
deterministic, and self-explaining, and not for the claim that the model
would be worse at the arithmetic.

**Two rows show no effect at all, and that is the finding rather than a gap
in it.** The verifier bank blocked zero proposals on a clean run, so
removing it changes nothing. The bank earns its place under failure, not
under success: it caught a truncated run during development that would
otherwise have reported 0% accuracy as though it were a score. A control
that only matters when something goes wrong still matters.

Self correction shows the same nothing for a related reason: with no
proposals blocked there is nothing to repair. That row measures the cost of
the cycle, which is zero when it never fires.

### Which arm truncates is not stable

On fixture v1 the flat-context arm truncated and the raw-ledger arm
completed. On v2 they swapped: the flat arm completed at 91.9% and the
raw-ledger arm ran out of room. Both are configurations asked to hold more
in one context than the budget allows, and which one tips first depends on
the fixture. Neither arm's failure should be quoted as a stable property of
the architecture.

The renderer that produces the slide reads the truncation flag and draws a
dash rather than the zero the score carries, because a zero on a slide reads
as a measurement and this one is not.

### Method notes

Two rows cost nothing by design. Disabling the bank or the repair cycle
changes what happens after the model produces output, and that output is
identical by construction, so those arms reuse the baseline rather than
paying twice for work that cannot differ.

Vendor memory is measured on a second close because on a first one the
memory is empty and the toggle does nothing. Reporting a cold run as
evidence about memory would measure the wrong thing.

The flat context arm was invalid on its first attempt: it tried to emit
several hundred categorizations in one response, hit the output ceiling,
and scored zero. That zero was the ceiling, not the architecture. It was
re-run with batched emission and a turn budget matched to the work, since
isolated mode gets twelve turns per batch across eight loops and handing
the flat agent twelve in total would have measured the budget instead. It
completes on v2.

An earlier scoring pass counted all 400 ground-truth entries when only 370
are in the closing period, which cost every row about seven points
uniformly. Corrected above.

Bank-only findings reference a bank row and no ledger row. An earlier
scorer compared transaction lists to decide whether a finding and a defect
described the same thing, which for this category compared two empty lists
and therefore matched everything against everything. It reported precision
1.00 on 48 findings against 4 planted defects. Bank-only findings are now
matched on the bank row, and a test fails against the old behaviour.

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
  accounts. That makes 94.1% a floor rather than a ceiling, and it means
  small accuracy differences between configurations should not be
  over-read — a 2-point gap is within the noise of how the chart of
  accounts was drawn.
- **Reconciliation recall is the weakest measured number.** Bank-only
  recall of 0.25 comes from a matcher that declines to guess on contested
  rows. The trade is defensible and precision is 1.00, but a fixture with
  cleaner settlement timing would flatter it, and a messier one would not.
- **The duplicate judgment is the weakest link and the most interesting
  one.** Precision 0.63 is the model deciding that identical same-day
  charges are double charges when some are simply repeat purchases. No
  deterministic rule separates them, which is exactly why it was given to
  the model — but it is where a human reviewer will spend their attention.

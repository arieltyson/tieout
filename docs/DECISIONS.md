# Decisions

Short records of why the system is shaped the way it is. Reasoning a
reviewer can follow is worth more than another feature, and a decision
whose justification nobody wrote down gets reversed by accident later.

Newest last.

---

## ADR-001: TypeScript for the harness, Swift for the surface

**Status:** accepted

The harness needs a fast test loop, a mature schema validation story, and
the ability to run in continuous integration on Linux without a Mac. The
surface needs to be a real iOS app rather than a web view, because the
argument being made is partly that the interface belongs on a phone.

Neither language is a compromise for the other. The seam between them is a
single versioned JSON contract, and the Swift client decodes a byte for
byte copy of what the harness actually emits, so drift fails a build rather
than appearing as an empty screen on a device.

**Cost.** Two type systems describing one shape. Mitigated by the contract
test rather than by code generation, which was the original plan: a test
that decodes real output proves agreement, while generated types only prove
that generation ran.

---

## ADR-002: Deterministic first, and what the measurements did to that claim

**Status:** accepted, with the original justification corrected

Every operation with an exact answer runs in typed code. Finding two
charges that share a vendor, a date, and an amount is a `GROUP BY`. Checking
whether a currency conversion reconciles is arithmetic. The model is
reserved for judgment that genuinely has no exact answer.

The original argument was that a model would be **worse** at the
deterministic work. The ablation does not support that. Removing the
detectors and asking the model to search the raw ledger produced slightly
**better** anomaly F1, at 64 percent higher cost.

Re-run against the larger fixture, this arm exhausted its output budget
before finishing and has no score. That is not a belated confirmation of
the original claim and is not recorded as one. The budget is a setting, and
the honest statement is only that on the budget every other arm completes
with, this one did not. The hypothesis has now failed to be confirmed
twice, first by contradiction and then by truncation.

So the claim is narrowed rather than abandoned. The detectors are kept
because they are free, instant, deterministic across runs, and explain
themselves with exact deltas. Those are real properties. "The model would
get it wrong" is not one of them, and the README no longer says so.

**Why this ADR exists at all.** The hypothesis was written down before the
run. Without that, this would have been quietly reinterpreted afterwards as
the result everyone expected.

---

## ADR-003: Sub agents for context isolation rather than parallelism

**Status:** accepted

The wrong reason to use sub agents is speed. The right reason is that the
categorizer chews through hundreds of rows, and if that happens in the
orchestrator's window then the orchestrator is compacting by the third
agent and loses the thread.

Measured: one agent doing both jobs in one conversation costs 37 percent
more and scores worse on both accuracy and anomaly F1. This is the clearest
result in the ablation and the one that most directly earns the
architecture.

The size of the gap is not stable and should not be quoted as though it
were. An earlier fixture put it at 92 percent, and on that run this arm
exhausted its context and produced no score at all. The direction has held
across both. The magnitude depends on how much the fixture makes the single
window carry.

A second benefit falls out. Each specialist gets only the tools its job
needs, which makes least privilege something a test can assert.

---

## ADR-004: Synthetic data, and publishing the ground truth generator

**Status:** accepted

Ground truth is the point. Accuracy claims are meaningless without known
answers, and known answers are impossible with real transactions.

The generator emits the answer key in the same pass that plants each
defect, so the manifest cannot drift from what was planted. A test asserts
none of the answer key is reachable from the ledger the agent reads.

**The uncomfortable part, recorded deliberately.** The fixture author and
the harness author are the same person. Some circularity is unavoidable in
a solo benchmark. It is mitigated by fixing the metric definitions before
any number existed and by writing hypotheses before runs, but it is not
eliminated, and `evals/RESULTS.md` says so where somebody evaluating the
numbers will actually see it.

---

## ADR-005: Verifiers block, inferential checks warn

**Status:** accepted

A deterministic failure is a fact. Sums that do not tie, a GL code that
does not exist, a transaction categorized twice: none of these are matters
of opinion and none should ever be presented to a person for approval.

An inferential failure is an opinion. A model judging that a categorization
looks wrong is useful information and a poor reason to discard an agent's
work outright.

Hence: deterministic failures block and route back to the agent that caused
them, inferential ones warn.

**What the ablation showed.** The bank blocked zero proposals on a clean
run, so removing it changed nothing measurable. That reads as a null result
and is not one. The bank caught a truncated model response during
development that would otherwise have reported zero percent accuracy as
though it were a score. A control that only matters when something goes
wrong still matters, and a benchmark on a good day cannot show that.

---

## ADR-006: Planning notes are not published

**Status:** accepted

The implementation plan and scoping notes contain dated assumptions,
abandoned approaches, and prose written to be argued with. Publishing that
invites a reviewer to evaluate the plan instead of the build, and to
mistake an idea recorded in one week for a commitment held in another.

They stay local and gitignored. This file and `SECURITY.md` are the
published record.

---

## ADR-007: The Xcode project is generated, not committed

**Status:** accepted, reversing an earlier decision

It was committed at first so a reviewer could clone and open it without
installing anything. That was a reasonable trade until adding a developer
account made XcodeGen resolve the signing config and write a team
identifier straight into the project file.

An account identifier does not belong in a public repository, and a
gitignored config file did not solve it: verified by blanking the config,
regenerating, and watching the occurrences drop from three to zero.

So `project.yml` is the source and the project is generated.
`xcodegen generate` is one command, documented in the README. Generated
artifacts drift from their source and produce noisy diffs regardless.

---

## ADR-008: Vendor memory generalizes, then refuses to trust itself

**Status:** accepted

Exact descriptors are safe and nearly useless for the merchants that
matter, because an order token that changes on every charge means a
descriptor never repeats. Generalizing is useful and dangerous: strip
enough away and a taxi ride and a food delivery under one brand collapse
into a single key covering two different accounts.

The resolution is to stem aggressively and then mark any stem whose
evidence disagrees with itself as permanently conflicted, after which that
merchant is served by exact matches only.

Crude generalization with a check beats careful generalization without one,
because the check fails loudly and cleverness fails quietly. That principle
recurs throughout this codebase and this is the clearest instance of it.

---

## ADR-009: The reconciler's model half needs a way to abstain

**Status:** open, found by measurement

The deterministic matcher pairs a ledger row to a bank row only when the
pairing is mutually unique, and hands the contested rows to a model to
adjudicate. The prompt asks that model to judge. It never tells it that
declining is an available and often correct answer.

Three models were run through it. The gap this leaves was invisible in two
of them and glaring in the third.

| Model | Unreconciled reported | True | False |
|---|---|---|---|
| Haiku 4.5 | 5 | 5 | 0 |
| Sonnet 5 | 3 | 3 | 0 |
| Opus 5 | 39 | 5 | 34 |

Sonnet abstained on everything and added nothing to the deterministic
three. Haiku added two and both were right. Opus adjudicated every row it
was handed, found all five planted defects, and produced thirty four false
positives doing it. Its recall was 1.00. It was not being careless; it was
answering the question actually put to it.

The reading that matters: **the two cheaper models looked correct because
they did nothing.** An abstention that comes from reticence rather than
from a rule is not a control, it is luck that happens to look like one. The
same prompt in front of a more willing model produced the failure that was
always available.

That is also why this ADR is open rather than accepted. The fix is a
defined abstention path with an explicit rule for when a contested row
stays contested, and a cap on how many exceptions any single agent may
raise before the run treats it as a fault rather than a finding. Neither
exists yet.

The published anomaly F1 of 0.90 therefore rests on a model that declines
to use a gap rather than on a harness that closes it. Recorded here rather
than quietly fixed, because the discovery is the useful part: a benchmark
across models found a hole that a benchmark on one model had no way to see.

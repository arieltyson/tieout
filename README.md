<div align="center">

# Tieout 📒⚖️

### Close the books from your Messages app.

[![CI](https://github.com/arieltyson/tieout/actions/workflows/ci.yml/badge.svg)](https://github.com/arieltyson/tieout/actions/workflows/ci.yml)

**94.1% categorization accuracy · 0.90 anomaly F1 · $1.41 per close**

[Full results and methodology](evals/RESULTS.md)

</div>

## What it is 🎨

Tieout closes a month of accounting for you. It reads a ledger, assigns a
general ledger code to every transaction, hunts for the things that go wrong
in a real close, checks its own work against a bank of deterministic
verifiers, and hands back only the decisions that genuinely need a person.

The name is the accountant's verb. To tie out is to prove that two sets of
records agree. That proof is the spine of the whole system: a set of pure
functions that gate every proposal before a human ever sees it. The model
decides which transactions belong together and what category applies. Typed
code computes every sum, every conversion, every balance. A language model
that adds a column of dollar figures will be wrong occasionally and confident
always, which is intolerable in a domain where being off by a cent means the
books do not close.

The harness is TypeScript. The surface is Swift.

## Benchmark Results 📊

Measured against a synthetic ledger of 370 transactions carrying 60 planted
defects, using Claude Sonnet 5.

| | |
|---|---|
| Categorization accuracy | **94.1%** (348 of 370, exact code match) |
| Anomaly F1 | **0.90** (precision 0.93, recall 0.87) |
| Cost | **$1.41** per close |
| Proposals blocked by verifiers | 0 |

The headline is not the total. It is where the work happens.

| Handled by | Categories | Precision | Recall | Tokens |
|---|---|---|---|---|
| Plain arithmetic | Currency conversion, receipts, spend policy, cancelled subscriptions, price jumps, bank reconciliation | 1.00 | 0.86 | **none** |
| The model | Duplicate judgment, vendor identity | 0.69 | 0.90 | all of them |

Eight of the ten defect categories have exact answers, so code finds them and
the model never sees them. A currency conversion either reconciles to the cent
or it does not. A receipt either matches the charge or it does not. Asking a
language model to do that arithmetic would be slower, more expensive, and less
accurate.

The model is called for the two questions arithmetic cannot answer. Are two
identical charges on the same day a double billing or simply two cups of
coffee? Are `AMZN Mktp US*2K4LM9XY3` and `AMAZON BUSINESS` the same merchant?
Those are judgments, and the split is why a close costs a dollar rather than
ten.

It also shows the price of that trade honestly. The two categories the model
owns are the only two that miss a perfect precision score. It calls too many
duplicates, flagging three legitimate repeat purchases as double charges.
Burying that inside an average would have hidden it.

The arithmetic side pays its own price, in recall rather than precision. The
reconciler matches a ledger row to a bank row only when the pairing is
unambiguous, and when several bank rows could explain the same charge it
declines to choose. That is why it finds three of five unreconciled entries
and only one of four bank orphans. The trade is deliberate. A missed
exception turns up next month when the account still does not tie. A false
one sends an accountant chasing a payment that was always fine, and a control
that does that a few times stops being read.

### What each part is worth

Every component disabled in turn, same fixture, same model.

| Configuration | Accuracy | Anomaly F1 | Cost |
|---|---|---|---|
| **Baseline** | **94.1%** | **0.90** | **$1.41** |
| Second close, warm memory | 94.6% | 0.89 | $0.62 |
| No sub agent isolation | 91.9% | 0.87 | $1.93 |
| No deterministic pre pass | ran out of context | | $1.39 |
| No deterministic verifiers | 94.1% | 0.90 | no change |
| No self correction | 94.1% | 0.90 | no change |

Context isolation is the clearest win. One agent doing both jobs in one
conversation costs 37 percent more and scores worse on both measures, because
the ledger accumulates in the window and gets re-read on every turn.

Vendor memory is next. A second close resolves 327 of 370 transactions from
what it learned the first time, cutting cost by 56 percent and taking 11
turns instead of 27.

**One arm has no score, and the blank stays visible.** Stripped of the
detectors, the model has to search the raw ledger itself, and against sixty
defects it exhausted its output budget before finishing. Reporting the zero
it technically scored would put a number on the board that nothing measured,
so the row shows the failure instead.

That failure is not a win for the architecture and is not offered as one. The
budget is a setting, and a larger one might finish. The narrow claim is that
on the same budget every other arm completes with, this one did not. Against
an earlier, smaller fixture the same arm did complete, and it contradicted
its own hypothesis by scoring a fraction better while costing 64 percent
more. The prediction that removing the detectors would be the sharpest drop
has now failed to hold up twice, in two different ways. The detectors stay
because they are free, deterministic, and self explaining, not because the
evidence says the model would be worse at the job.

Two rows show no effect, which is the finding rather than a hole in it. The
verifier bank blocked nothing on a clean run. It earns its place under
failure instead: during development it caught a truncated run that would
otherwise have reported zero accuracy as though it were a score.

Full method notes, including two arms that had to be re-run after producing
plausible looking nonsense, are in [evals/RESULTS.md](evals/RESULTS.md).

### Where the categorizer was wrong

Every one of the 22 categorization misses is a defensible disagreement rather
than a blunder. Canva went to software subscriptions instead of marketing.
Twilio went to software instead of telecom. Both readings are arguable, and
the answer key has not been edited to agree with the model, because fitting a
benchmark to its own output is the failure this project exists to avoid.
Treat 94.1% as a floor.

## Highlights 💫

<div align="left">

### The Harness 🔧
- **Specialist agents with isolated context.** Each one gets a fresh window and
  returns a compact summary rather than raw rows, so the orchestrator never
  drowns in four hundred transactions.
- **A typed tool layer built on Zod.** One schema produces both the JSON
  Schema the model receives and the TypeScript type used internally, so the
  two cannot drift apart.
- **Permission tags on every tool.** Least privilege becomes something a test
  asserts rather than something a reviewer has to trust.
- **Budgets checked before every call.** Turns, input tokens, output tokens,
  and wall clock, all enforced ahead of the request so an exhausted budget
  cannot spend one more.

### Deterministic Verification ⚖️
- **Six pure verifiers** over `(proposals, ledger)`, with no network, no clock,
  and no model. Sums tie to the cent, codes must exist in the chart of
  accounts, nothing is categorized twice, nothing references a transaction
  that is not there, and no claim arrives without evidence pointing at a tool
  call that actually ran.
- **Every check proven capable of failing.** Each verifier was tested by
  breaking the predicate it depends on and confirming the right tests fail and
  no others. A control that cannot be made to fail is decoration.
- **Money is an integer.** A branded cents type makes floating point dollars
  impossible to represent. Values are validated and branded in a single
  expression, so no loader can reassert the type over a number nobody checked.
- **Arithmetic never reaches the model.** Sums, conversions, and balances all
  run in tested code.

### Anomaly Detection 🔎
- **Five defect categories solved by code**, at perfect precision and for no
  tokens: currency conversion errors, receipt discrepancies, spend policy
  breaches, silently cancelled subscriptions, and month on month price jumps.
- **The model judges rather than searches.** It receives candidates with the
  arithmetic already done and answers only the questions that have no exact
  answer.
- **Findings ranked by materiality**, because a list nobody can triage is a
  list nobody reads.

### The iOS Surface 💬
- **A Live Activity** on the Lock Screen and in the Dynamic Island.
  ActivityKit was built for food delivery, and a close turns out to fit the
  same shape: it takes minutes, it moves through stages, and it ends by
  needing something from you, which is exactly what you should not have to
  open an app to discover.
- **Approval cards inside the Messages thread**, rendered by a Messages
  extension. The message carries an identifier and nothing else, since
  payloads are size constrained and a run holds hundreds of proposals.
- **Rejected proposals cannot be approved.** Anything a verifier blocked
  appears in the list without a button. A deterministic failure is a fact, and
  nobody should be invited to wave one through.
- **A shared contract that cannot drift.** The Swift client decodes a byte for
  byte copy of what the harness actually writes, so a change to the shape
  fails a build instead of showing up as an empty screen on a device.
- **A listener that speaks fluent Messages.** Polling the message database
  means handling timestamps counted in nanoseconds from 2001 and bodies
  stored as archived text rather than plain strings, both solved. Tapbacks and
  system rows are filtered out, because a thumbs up on your own command would
  otherwise start the close all over again.
- **App Intents** put the close in Siri, Shortcuts, and Spotlight.

### Hostile Input by Default 🛡️
- **Merchant text is treated as an attack surface.** A merchant chooses its own
  descriptor and that string reaches the model. Ledger rows travel inside a
  delimited block explicitly framed as untrusted data, never spliced into the
  system prompt.
- **Three attack payloads live permanently in the fixture**, including one that
  tries to close the data block and issue its own instructions. All three were
  filed to the uncategorized account in the real benchmark run, and the model
  named them as injection attempts in its own reasoning.
- **Your real messages stay out.** The transport reads a synthetic message
  database and refuses any path inside your Messages directory unless you
  deliberately opt in, sidecar files included.
- **Secrets cannot enter the repository.** A hook blocks phone numbers, email
  addresses, and API keys before every commit, and a second pass in continuous
  integration scans every tracked file, catching anything committed with the
  hook disabled.

### Durable Runs and Approval Gates ⏸️
- **Checkpointed to SQLite at every state transition**, so a run parks while
  it waits for you and resumes cleanly an hour later with nothing held in
  memory and no timer left running.
- **Idempotency keys derived from content**, which makes applying the same
  decision twice a no op. People double tap approve, and that is planned for
  rather than discovered during a demo.
- **Bounded self correction.** A verifier failure goes back to the agent that
  caused it as a tool result, for a capped number of repair attempts, then
  escalates to a person with the verdict attached.

### Vendor Memory 🧠
- **Approved categorizations become learned mappings**, merchant pattern to
  account code, with a confidence counter behind them.
- **Consulted before the model is called**, so a familiar ledger gets cheaper
  every time it is closed. The first correction is a correction. The second is
  a rule.

### On Device Receipt Intelligence 📸
- **Vision reads the receipt on the phone**, pulling merchant, total, date, and
  line items out of a photo that never leaves the device.
- **Two tiers of model.** Apple's on device model handles the cheap questions,
  such as whether an image is even a receipt, and only genuine ambiguity
  reaches the frontier model.
- **Limited photo library access**, asking for the images you choose rather
  than the whole camera roll.

### Measured, Not Asserted 📊
- **A ledger generated from a fixed seed**, byte identical every time.
  Continuous integration rebuilds it on every push and fails if one byte moves.
- **An answer key written by the generator itself**, in the same pass that
  plants each defect, so it cannot drift from what was planted. A test proves
  none of it is reachable from the ledger the agent reads.
- **Scoring per category, not just overall**, so a system that aces duplicates
  and misses every conversion error cannot hide behind an average.
- **A scripted model client** that returns canned tool calls, making
  termination, budget limits, argument validation, and tool failure ordinary
  unit tests that cost nothing and never flake.

Four of these are still landing: checkpointing, vendor memory, receipt
reading, and the message listener. Everything else on this page is running
today and measured above.

</div>

## Why the fixture is the hard part 🧪

Vendor descriptors are deliberately mangled the way real card processors
mangle them, because a generator that emits clean names would score 99% and
prove nothing.

Two pairs carry most of the difficulty. `AMZN Mktp US*2K4LM9XY3` and
`AMAZON BUSINESS` are one merchant wearing two names, so a system that keys
memory on the raw string treats them as strangers. `UBER *TRIP` and
`UBER *EATS` are one brand covering two businesses that belong in different
accounts, so a normalizer that strips both to `UBER` will confidently misfile
one of them. Together they punish carelessness in either direction.

One defect is unreachable by arithmetic on purpose. That merchant's descriptor
carries a different numeric suffix on every charge, so exact matching can
never group it. The model found it.

## Running it ⚙️

```bash
git clone https://github.com/arieltyson/tieout.git
cd tieout
npm install

# Rebuild the ledger from its seed. Produces no diff.
npm run fixtures:generate

# Typecheck and run everything. No API key needed.
npm run typecheck
npm test

# Walk the whole pipeline with a scripted model. Costs nothing.
npm run close -- 2026-06 --dry

# Run it for real. Needs ANTHROPIC_API_KEY in .env.
npm run close -- 2026-06
```

The iOS app lives in `ios/`. The Xcode project is generated from
`ios/project.yml`, so build it with:

```bash
brew install xcodegen
cd ios && xcodegen generate && open Tieout.xcodeproj
```

To run on a physical device, copy `ios/Signing.example.xcconfig` to
`ios/Signing.xcconfig` and add your Apple Developer team. That file is
gitignored, since a team identifier belongs to your account rather than to
this repository. Simulator builds need no signing at all.

Requires Node 22 or newer.

318 TypeScript tests and 12 Swift tests. All of them run without an API key.

## Further reading 📄

- [evals/RESULTS.md](evals/RESULTS.md) covers the benchmark, the full
  ablation matrix, and the limitations.
- [docs/SECURITY.md](docs/SECURITY.md) covers prompt injection through
  merchant text, how your real messages are kept out, and what is enforced
  today versus designed.
- [docs/DECISIONS.md](docs/DECISIONS.md) records why the system is shaped
  this way, including a claim the measurements forced me to narrow.

## License 🪪

MIT. See [LICENSE](LICENSE).

---

<div align="center">

*An active solo build. The git history is the progress bar.*

</div>

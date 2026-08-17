<div align="center">

# Tieout 📒⚖️

### Close the books from your Messages app.

[![CI](https://github.com/arieltyson/tieout/actions/workflows/ci.yml/badge.svg)](https://github.com/arieltyson/tieout/actions/workflows/ci.yml)

**Status: in active development — Phase 0 of 10 complete.**
The benchmark fixture is built; the agent that runs against it is not.
Measurement plan: [evals/RESULTS.md](evals/RESULTS.md)

</div>

## What it is 🎨

**Tieout** is an agentic month-end close operated by text message. The intended
shape: you send it `close june`, it dispatches specialist sub-agents across a
ledger, verifies every proposal against deterministic checks, and replies with
only the decisions that actually need a human.

The name is the accountant's verb — to *tie out* is to prove two sets of
records agree. That proof is the architectural spine: a bank of pure verifier
functions gating every model output before a person sees it. The model decides
which transactions group and what category applies; typed code computes every
sum, conversion, and balance. An LLM that adds a column of dollar figures will
be wrong occasionally and confident always, which is unacceptable in a domain
where being off by a cent means the books don't close.

The harness is TypeScript. The surface will be Swift.

## Status 🚧

This is a build log, not a finished product. Phase 0 established the
foundation and the benchmark; Phases 1–10 build the agent on top of it.

**Built and tested:**

- **Deterministic ledger fixture** — 400 synthetic transactions with 47 planted
  defects across seven categories, plus an expected GL code for every
  transaction. Same seed, same ledger, byte for byte; CI regenerates it on
  every push and fails on any drift.
- **Ground truth that can't drift** — the generator emits the answer key in the
  same pass that plants each defect, and a test asserts none of it is reachable
  from the ledger the agent sees.
- **Integer-cent money type** — a branded `Cents` type making floating-point
  dollars structurally impossible, with the classic `0.1 + 0.2` case in the
  suite.
- **Chart of accounts** — 18 accounts, Zod-validated at load, exposing the
  `isValidGLCode` check the verifier bank will depend on.
- **`attributedBody` decoder** — iMessage bodies frequently live as a serialized
  `NSAttributedString` typedstream rather than plain text. Validated 500/500
  against real messages using the populated `text` column as the oracle.
- **Secret scanning** — pre-commit hook plus a whole-tree CI pass, with tests
  proving it catches what the staged scan structurally cannot.

101 tests, none of which spend a token.

**Not built yet:** the verifier bank, the tool layer, the agent loop, the
sub-agents, durable checkpointing, the iMessage transport, the eval runner, and
the entire iOS surface. The iOS half — a Messages extension for approval cards,
a Live Activity for run progress, and on-device Vision for receipt matching — is
specced in detail in the plan. Harness first.

## Benchmark 📊

**No numbers yet.** The eval runner is Phase 9. Rather than publish
placeholders, the methodology is fixed in advance in
[evals/RESULTS.md](evals/RESULTS.md): metric definitions, the ablation matrix,
and the limitations — written before any result exists, so scoring can't be
adjusted to flatter the output.

What the benchmark will test is whether **harness quality dominates model
choice**: the same model run through progressively degraded versions of the
same harness. If disabling the verifier bank doesn't measurably hurt, the
architecture isn't earning its complexity, and this README will say so.

The fixture that makes that measurable already exists:

| Defect category | Count |
|---|---|
| Policy violation | 10 |
| Receipt mismatch | 9 |
| FX mismatch | 7 |
| Duplicate charge | 6 |
| Price anomaly | 6 |
| Missing recurring | 5 |
| Vendor alias | 4 |
| **Total planted defects** | **47** |

Plus 400 transactions carrying an expected GL code each.

### Why the fixture is the hard part

Vendor descriptors are deliberately mangled the way real card processors mangle
them. Two pairs do most of the work:

- `AMZN Mktp US*2K4LM9XY3` and `AMAZON BUSINESS` are the same vendor under two
  descriptors. A system keying vendor memory on the raw string treats them as
  strangers.
- `UBER *TRIP` and `UBER *EATS` are one brand under two different GL codes.
  A normalizer that strips to `UBER` and memorizes one mapping confidently
  mis-files the other.

Between them they punish both under- and over-normalization, which is the
tension a real categorizer has to navigate. A generator emitting clean vendor
names would yield 99% accuracy and prove nothing.

## The design 🔧

Described as intent. Almost none of this is built yet — the Status section
above lists what is.

**Deterministic-first.** Every operation that *can* run in code *must* run in
code; the model is reserved for judgment that genuinely requires it. Exact
duplicate detection is `GROUP BY vendor, amount, date HAVING COUNT(*) > 1`, not
a prompt. The model's job starts where SQL runs out.

**The verifier bank.** Pure functions, `(Proposal, Ledger) -> VerifierResult` —
no I/O, no network, no model. Sums must tie to the cent, GL codes must exist,
no transaction categorized twice, debits equal credits. Deterministic failures
block; inferential failures warn.

**Context isolation over parallelism.** Four sub-agents — categorizer,
reconciler, anomaly hunter, receipt chaser — exist so the categorizer can chew
through thousands of rows without the orchestrator compacting by turn three.
Each gets a fresh context and returns a compact structured summary. Least
privilege on tool grants falls out as a second-order benefit.

**Bounded self-correction.** Verifier failures are fed back to the originating
sub-agent as a tool result for a capped number of repair attempts, then
escalated to a human with the verifier output attached.

**A scripted model client.** The loop, budget enforcement, retry bounds, and
self-correction are all testable against canned `tool_use` blocks — zero
tokens, zero flakiness.

## Security & scope 🔒

**Tieout runs against synthetic data and has no path to real money movement.**
Every action it takes is a proposal requiring explicit human approval.

Separated honestly, because a security claim about an unbuilt control is worse
than no claim at all.

**Enforced today:**

- **Secret scanning.** Phone numbers, emails, and API keys are blocked from the
  repo by a pre-commit hook, and by a whole-tree scan in CI that also catches
  anything committed with `--no-verify`.
- **Config isolation.** Handles and keys enter the process in exactly one
  module, which reads them from the environment. "No handle literals outside
  config" is greppable rather than remembered.
- **Money is never a float.** Enforced by the type system and unit tests.
- **Read-only by construction.** Nothing in the repository can mutate a
  financial system, live or otherwise.
- **An adversarial merchant descriptor is planted in the fixture.** A merchant
  controls its own descriptor string, and that string reaches the model's
  context — prompt injection through a merchant name is a fintech-specific
  attack surface almost nobody models. The payload is planted and reaches the
  ledger unescaped, on purpose. **The regression test proving the agent ignores
  it lands with the transport layer in Phase 6.5** — planting the target is not
  the same as testing the defence.

**Designed, not yet built:**

- **Sender allowlist**, checked before any parsing and before a token is spent.
  An agent with tool access that answers arbitrary inbound messages is a remote
  execution surface wearing a friendly hat.
- **Untrusted input isolation** — ledger text passed inside a delimited,
  explicitly-framed data block, never interpolated into a system prompt.
- **Message filtering.** The listener will retain only rows where
  `item_type = 0` and `associated_message_type = 0`. Both are *retain*
  predicates — `0` identifies the rows you keep. Non-zero
  `associated_message_type` marks a tapback, and reacting to your own
  `close june` message produces an ordinary text row reading
  `Reacted 👍 to "close june"`; without the predicate the listener parses it as
  a fresh command and re-runs the close. Observed live during the Phase 0
  transport spike.
- **Least-privilege tool grants**, with a CI assertion that the receipt chaser
  is offered zero tools tagged `ledger:write`.
- **Deterministic command parsing** — `approve 1-4` parsed by a grammar, never
  interpreted by a model.

## Running it locally ⚙️

```bash
git clone https://github.com/arieltyson/tieout.git
cd tieout
npm install

# Regenerate the synthetic ledger and ground-truth manifest.
# Deterministic — this should produce no diff.
npm run fixtures:generate

# Typecheck and run the full suite. No API key required.
npm run typecheck
npm test
```

Everything above works today. There is no `close` command yet — the agent loop
is Phase 3 and the iMessage transport is Phase 6. Requires Node 22+.

## Technical approach 💻

**Harness:** TypeScript 7 in strict mode (`strict`,
`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`), Node 22+, Zod for
schemas, `better-sqlite3` for the fixture and later for checkpoints and the
audit log, Vitest, and the Anthropic SDK behind a `ModelClient` interface.

**Planned iOS surface:** Swift 6 with strict concurrency, SwiftUI, The
Composable Architecture, the Messages framework for in-thread approval cards,
ActivityKit for run progress, App Intents for Siri and Shortcuts, and
Vision + FoundationModels for on-device receipt triage.

**Why strict everything:** this is a financial system. The compiler is the
cheapest verifier available.

## License 🪪

MIT — see [LICENSE](LICENSE).

---

<div align="center">

*An active solo build. The plan runs to ten phases; the git history is the
progress bar.*

</div>

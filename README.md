<div align="center">

# Tieout 📒⚖️

### Close the books from your Messages app.

[![CI](https://github.com/arieltyson/tieout/actions/workflows/ci.yml/badge.svg)](https://github.com/arieltyson/tieout/actions/workflows/ci.yml)

**Status: in active development.** The harness runs end to end and is
measured; the iMessage transport and the ablation table are not built yet.
Numbers: [evals/RESULTS.md](evals/RESULTS.md)

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

A build log, not a finished product. The harness runs end to end and is
measured; the transport that makes it a *Messages* app is not built.

**Built, tested, and measured:**

- **The harness runs.** `npm run close 2026-06` categorizes 370 transactions,
  hunts anomalies, verifies every proposal, and scores against ground truth.
- **Verifier bank** — six deterministic verifiers over pure
  `(proposals, ledger)` functions. Every one mutation-tested: break the
  predicate, confirm the right tests fail and no others.
- **Deterministic detectors** — five defect categories solved by arithmetic at
  P 1.00, before a model is invoked.
- **Deterministic ledger fixture** — 400 transactions, 47 planted defects,
  byte-identical from its seed. CI regenerates it every push and fails on drift.
- **Agent loop** — tool dispatch, four budget types checked before every call,
  and errors returned as `tool_result` rather than exceptions. Fully testable
  against a scripted model client, zero tokens.
- **iOS app** — SwiftUI run detail, a Live Activity with Lock Screen and
  Dynamic Island presentations, and a Messages extension rendering approval
  cards. Builds against the iOS 26.5 simulator; verified by screenshot.
- **Shared contract** — the Swift client decodes a byte-for-byte copy of what
  the harness actually emits, so drift fails a build rather than a screen.
- **Private data stays out** — the transport reads a synthetic `chat.db` and
  *refuses* any path under `~/Library/Messages` without an explicit opt-in.

**318 TypeScript tests and 12 Swift tests**, all runnable without an API key.

**Not built yet:** the iMessage listener and sender, the reconciler and receipt
chaser sub-agents, durable checkpointing and decision application, vendor
memory, the ablation runs, and on-device receipt Vision.

## Benchmark 📊

Measured against the committed fixture: 370 transactions, 47 planted defects
across seven categories, `claude-sonnet-5`. Full methodology, per-category
breakdown, and error analysis in [evals/RESULTS.md](evals/RESULTS.md).

| | |
|---|---|
| Categorization accuracy | **95.1%** (352/370 exact GL match) |
| Anomaly F1 | **0.94** (P 0.92 / R 0.96) |
| Escape-hatch rate | 4.9%, all correct |
| Cost | **$1.00** per close |
| Wall clock | 291s |

**The interesting number is the split, not the total.**

| Found by | Categories | Precision | Recall | Tokens |
|---|---|---|---|---|
| Deterministic code | FX, receipts, policy, recurring gaps, price jumps | 1.00 | 0.96 | **0** |
| The model | Duplicate judgment, vendor aliasing | 0.71 | 0.90 | all of them |

Five of seven defect categories are solved exactly by arithmetic, for nothing.
The model is invoked only for the two that have no deterministic answer —
whether identical same-day charges are a double charge or two legitimate
purchases, and which mangled descriptors are the same merchant. That split is
the architecture, and it is why a close costs a dollar instead of ten.

It also shows the cost of the trade honestly: the model's two categories have
the lowest precision on the board. It over-flags duplicates, calling three
legitimate repeat purchases double charges.

**On the 18 categorization misses:** every one is a debatable classification
rather than a clear error — `CANVA PRO` filed as software rather than
marketing, `TWILIO` as software rather than telecom. Ground truth has not been
adjusted to match, because fitting the answer key to the output is the failure
this benchmark exists to prevent. 95.1% is a floor.

The ablation table — each component disabled in turn — is still pending. The
configurations and their hypotheses are committed in `evals/src/ablation.ts`,
written before the runs.

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

**Deterministic-first.** Every operation that *can* run in code *must* run in
code; the model is reserved for judgment that genuinely requires it. Exact
duplicate detection is `GROUP BY vendor, amount, date HAVING COUNT(*) > 1`, not
a prompt. The model's job starts where SQL runs out.

**The verifier bank.** Pure functions, `(Proposal, Ledger) -> VerifierResult` —
no I/O, no network, no model. Sums must tie to the cent, GL codes must exist,
no transaction categorized twice, debits equal credits. Deterministic failures
block; inferential failures warn.

**Context isolation over parallelism.** Sub-agents exist so the categorizer can
chew through thousands of rows without the orchestrator compacting by turn
three. Each gets a fresh context and returns a compact structured summary.
Least privilege on tool grants falls out as a second-order benefit. Two of the
four are built — categorizer and anomaly hunter; the reconciler and receipt
chaser are not.

**Bounded self-correction** *(designed, not built)*. Verifier failures are fed
back to the originating sub-agent as a tool result for a capped number of
repair attempts, then escalated to a human with the verifier output attached.

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

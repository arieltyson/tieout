# Security

Tieout runs against synthetic data and has no path to moving real money.
Every action it takes is a proposal that a person has to approve. That is a
design decision rather than a limitation, and it is worth saying plainly
before anything else: an agent with tool access, wired to a messaging
surface, is an interesting attack surface wearing a friendly interface.

What follows separates what is enforced today from what is designed. A
security claim about a control that does not exist is worse than no claim,
because it stops anybody looking.

## Merchant text is hostile input

A merchant chooses its own descriptor and that string reaches the model's
context. Prompt injection through a merchant name is a fintech specific
attack surface that almost nobody models, and it is the reason this project
treats ledger text the way a web application treats a query parameter.

Ledger rows travel inside a delimited block that is explicitly framed as
untrusted merchant supplied data. They are never spliced into a system
prompt. The system prompt tells the model, in the same breath, that a
transaction whose descriptor contains instructions is simply a suspicious
transaction and belongs in the uncategorized account.

Three attack payloads live permanently in the fixture, covering distinct
shapes: a direct instruction override, an attempt to close the data block
and issue commands, and a forged authority claim. They reach the ledger
unescaped on purpose, because a fixture that sanitizes its own payloads
tests nothing.

### What is actually proven

Four properties are asserted on every test run, for free:

- The payloads reach the ledger unescaped, so the fixture is live rather
  than a description of one.
- The system prompt is byte identical regardless of what is in the data,
  and contains none of the payload text.
- Every descriptor arrives inside the delimited block, framed as merchant
  supplied data.
- A descriptor containing the exact closing delimiter is neutralized. The
  planted payload carries `</ledger_data>`, which does not match the real
  closing tag, so today it could not escape anyway. That was luck rather
  than design, and the escaping now makes the property hold because of what
  the code does rather than what the attacker happened to guess.

And the behavioural half, from a real paid run rather than from hope: all
three payloads were filed to the uncategorized account, and the model named
them as injection attempts in its own rationale, including "descriptor
contains injected instruction, not a real vendor". A test reads that
artifact back, so a future run that starts obeying them fails the suite.

**Remaining limit, stated rather than buried.** That is one model on one
run against three payloads. It is evidence, not a guarantee, and a
different model or a cleverer payload is not covered by it. The prompt
assembly properties above are the durable part; the behavioural result is a
snapshot.

## Your messages stay out of this project

The transport reads a synthetic message database. Any path inside the real
Messages directory is refused unless `TIEOUT_ALLOW_REAL_CHATDB` is set to
exactly `1`.

The refusal is a thrown error rather than a warning, because a warning in a
log nobody reads is the same as no check. It covers the `-wal` and `-shm`
sidecars, which hold un-checkpointed message data, and the attachments
directory, which holds the media. Guarding only `chat.db` would leave the
actual bytes readable. Paths resolve before comparison, so a traversal
through a sibling directory does not slip past.

The opt in is compared against the exact string `1`. Treating any non empty
value as consent means `TIEOUT_ALLOW_REAL_CHATDB=0` reads as yes.

Consequence: the transport is developed and tested on Linux in continuous
integration, with no macOS and no Full Disk Access anywhere in the loop.

## Only known senders are answered

Inbound messages are checked against a handle allowlist before any parsing
and before a single token is spent.

Handles are normalized to E.164 first, because the same person arrives as
`+15555550100`, `555-555-0100`, and `(555) 555-0100` depending on how
Messages happened to store the row. An allowlist comparing raw strings is
not an allowlist. A handle whose shape is not recognised is left unchanged
rather than guessed at, since inventing a country code silently admits or
excludes somebody.

Handles are then salted and hashed, and the salt must be at least sixteen
characters. The space of phone numbers is small enough to enumerate, so a
weak salt makes the hash a phone number with extra steps. Everything
downstream sees the hash. The plaintext exists only in configuration and
only at the moment a message is sent.

## Reactions cannot re-run your close

A thumbs up on your own `close june` message arrives in the database as an
ordinary text row reading `Reacted to "close june"`. An unfiltered listener
parses that as a fresh command and starts the close again.

The listener keeps only rows where `item_type` and
`associated_message_type` are both zero. Both are **retain** predicates:
zero identifies the rows worth keeping, not the rows to discard. Reading
them the other way inverts the filter and admits exactly what it was meant
to exclude, which is a mistake this project made in prose before catching
it in code. Keeping only zero covers reactions added, reactions removed,
and whatever Apple adds next, which a list of known bad values would not.

Messages we sent ourselves are dropped too. Parsing them turns the agent
into its own user.

## Nothing is logged that identifies a person

Redaction lives at the formatter rather than at each throw site. An error
thrown three layers deep carries whatever context it was given, and nobody
remembers to sanitize on the way up.

Message bodies are recorded as a length and a short digest, never as text.
If the content is genuinely needed to debug something, it can be read from
the source database directly. That should be a deliberate act rather than
the default state of a log file sitting on a disk. A test asserts that the
reason a message was dropped can never contain the message.

## Secrets cannot enter the repository

A hook blocks phone numbers, email addresses, and API keys before every
commit. A second pass in continuous integration scans every tracked file,
which also catches anything committed with the hook disabled, and anything
that landed before the hook existed. The staged scan cannot see either.

Ranges reserved for documentation are exempt: the NANP fictional block in
any written form, and RFC 2606 documentation domains. Tests assert the
exemption opened no hole, using a real area code, a real number, a real
mail provider, and a lookalike domain.

This scanner has blocked its own author three times during development,
twice on its own documentation.

## Least privilege is enforced

Every tool declares the permissions it requires and every agent declares
what it holds. Dispatch is the only place the two meet.

The receipt chaser is offered zero tools that write to the ledger. No agent
anywhere holds a ledger write grant. The orchestrator cannot propose
anything itself, because it plans and synthesizes while proposals come from
specialists. Only the categorizer may write vendor memory.

These are assertions rather than intentions. Until recently they were
neither: the filter function existed and was never called, so every agent
received whatever it was handed. That gap is exactly the kind that survives
until somebody goes looking, which is the argument for testing a claim
rather than writing it down.

## Money cannot silently become a float

A branded integer type makes floating point dollars impossible to
represent. Values are validated and branded in a single expression, so no
loader can reassert the type over a number nobody checked.

The client mirrors the rule. Receipt amounts parse to integer cents
directly from the digits and never pass through a floating point type, at
the one point where a person is about to compare two figures.

## Nothing mutates a financial system

There is no write path to a ledger anywhere in this repository, live or
otherwise. Proposals accumulate, verifiers gate them, a person approves
them, and the result is recorded as a decision. The decision table is the
end of the line.

## Reporting

This is a portfolio project against synthetic data, so there is no
disclosure process to speak of. If you find something wrong with the
reasoning above, open an issue and say so plainly.

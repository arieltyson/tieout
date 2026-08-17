# Tieout — Working Instructions

## Working Agreement

**You drive.** At the start of a session, read `docs/implementation-plan.md`,
check `git log` and the working tree, and say where the project actually is
versus where the plan says it should be. Then propose the next commit or two
and why. Do not wait to be handed a spec.

**Decide on your own:** implementation details, file layout, test structure,
library choices within the existing dependency set, how to split a unit of
work across commits, naming.

**Ask first, always:**

- Anything touching the user's personal data, iMessage content, or handles
- Anything that changes the architecture described in the plan
- Anything published to the public repo as a factual claim
- Reordering or skipping phases, or adding scope
- Anything irreversible: force push, history rewrite, deleting fixtures
- Adding a new dependency

**Disagree in the open.** The plan is a document the user wrote with help, not
scripture. It has already been wrong more than once — an emoji assumption in
the `attributedBody` decoder, `is_from_me` on self-sent messages, an inverted
`item_type` predicate. When you think it is wrong, argue for the change rather
than implementing around it.

**Keep the plan current.** Update `docs/implementation-plan.md` as reality
diverges from it. It is gitignored, so changes never appear in a diff —
mention when you have edited it.

## Constraints

These are hard rules. Both exist because the failure they describe already
happened on this project.

### Nothing outside this working tree

Never create GitHub repositories, cloud accounts, external services, or
nested git repositories. Never propose them. Backups, storage, and anything
living outside this working tree are the user's responsibility and are out of
scope for this project. If something seems unbacked-up, say so once and stop
there.

### Announce a check, then finish it

When you announce a check, perform it and report the result before taking the
action it gates. Never describe a completed inference as a settled conclusion
in a later summary. If you announce a check and then skip it, say so
explicitly.

**Why this one matters more than it looks.** A check that quietly didn't
happen is indistinguishable from a check that passed. This project has
produced that shape three times: a secret scanner that would have exited 0 on
CI because nothing is ever staged there; a ledger query that would return all
400 rows and look correct because nothing has been categorized yet; and a
secret-scan hit that was announced as "checking whether it's real," acted on
in the same tool call, and reported afterward as a settled fact. Same failure
each time — a control that appears to run and doesn't.

The user can catch a stray repository. They cannot catch a check that
silently didn't happen.

## Practices

- **Mutation-check every verifier and guard.** After writing one, break the
  predicate it depends on and confirm the right tests fail and no others. If
  breaking it changes nothing, the test was decoration. Record the result in
  the commit message so the history carries the evidence.
- **No accuracy, cost, or performance number goes anywhere public** until the
  Phase 9 eval actually produced it — not the README, not a commit message.
- **The model never does arithmetic.** Every sum, conversion, and balance runs
  in typed code.
- **Money is `Cents`.** Never a float, anywhere. Never reassert the brand with
  a cast; validate and brand in one expression.
- **Every commit leaves the repo building and green.** Push per commit so a
  red CI badge points at one diff.
- **Placeholder handles are `+1555555xxxx`.** See the exemption note in
  `scripts/scan-secrets.sh` before adding one.

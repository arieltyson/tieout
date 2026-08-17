# Tieout — Working Instructions

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

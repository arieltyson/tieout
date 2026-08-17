# Architecture Decisions

Short ADRs recording *why*, not *what* — the code already says what. Newest
last.

---

## ADR-001: Planning material lives in a separate private repository

**Status:** accepted · 2026-08-17

**Context.** The project carries two kinds of document. The published kind —
this file, `SECURITY.md`, the README — is part of the artifact a reader is
meant to evaluate. The working kind — a ten-phase implementation plan, an
original scoping overview, session handoff notes — is thinking-in-progress.
It contains dated assumptions, abandoned approaches, and prose written to be
argued with rather than read.

Publishing the second kind invites a reviewer to evaluate the plan instead of
the build, and to mistake an idea recorded in March for a commitment held in
August. Deleting it loses the reasoning trail that makes the phases legible
to the person doing the work.

**Decision.** Working notes live in a private repository, `tieout-plan`,
checked out at `docs/plan/` inside this working tree and gitignored here via
`docs/*`. Published documents stay in `docs/` as direct children, re-included
by explicit negations in `.gitignore`.

The nesting depth is load-bearing. A `.git` directly in `docs/` makes this
repository treat the whole directory as an embedded repository and silently
stop tracking `docs/DECISIONS.md` and `docs/SECURITY.md` — `git add` exits 0
and stages nothing. One level down avoids that entirely.

**Consequences.** Planning history is versioned and backed up off-machine
without being published. A reader who notices `docs/` holds only two files
finds this ADR rather than an unexplained gap. The cost is two repositories
to keep in sync, which is acceptable because they change on different
rhythms and never share a file.

The private repo is scanned by `scripts/scan-secrets.sh` before pushing, on
the same terms as this one — handoff notes discuss real message handles, and
"it's private" is not a reason to relax that.

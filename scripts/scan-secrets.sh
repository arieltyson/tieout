#!/usr/bin/env bash
set -euo pipefail

# Patterns that must never enter the repo.
PATTERNS=(
  '\+1[0-9]{10}'                                 # E.164 North American
  '[0-9]{3}-[0-9]{3}-[0-9]{4}'                   # dashed phone
  '[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-z]{2,}'  # email
  'sk-ant-[a-zA-Z0-9-]+'                         # Anthropic key
)

# Two modes, because they answer different questions:
#
#   (no args)  staged — only what this commit is about to add. Fast, and
#                       what the pre-commit hook wants.
#   --all             — every tracked file, whole content. This is the mode
#                       CI must use: nothing is ever staged on a CI runner,
#                       so a staged-diff scan there would find no files,
#                       exit 0, and report a pass that proves nothing.
#
# The second mode also catches anything that landed via `--no-verify` or
# before the hook existed, which the staged scan structurally cannot see.

MODE="${1:-}"
if [ -n "$MODE" ] && [ "$MODE" != "--all" ]; then
  echo "usage: scan-secrets.sh [--all]" >&2
  exit 2
fi

STAGED=""

# THE 555555 EXEMPTION — read this before adding a placeholder.
#
# `grep -v '555555'` drops any matching line containing that literal
# six-digit run. It does NOT mean "fictional numbers are allowed". It
# exempts exactly one shape: the E.164 placeholders +1555555xxxx, whose
# leading 5s happen to form that run.
#
# Consequences, all of which have bitten:
#
#   +15555550100   exempt — the canonical placeholder, use this one
#   +15555550101   exempt — same run, fine for a second handle
#   555-0100       NOT exempt — dashed form has no six-5 run, even though
#                  it is the same reserved number
#   +1604555nnnn   NOT exempt — only three consecutive 5s. Written with
#                  letters here on purpose: spelled out in full, this line
#                  would trip the very scanner it documents.
#
# NANP reserves 555-0100 through 555-0199 for fictional use. 555-1234 is a
# common convention but is NOT in that block, so do not reach for it: it is
# both outside the reserved range and outside this exemption.
#
# Keep every placeholder in this repo as +1555555xxxx. The deliberate
# trigger strings in test/scan-secrets.test.ts are the exception — they are
# assembled from split literals at runtime precisely so they stay OUTSIDE
# the exemption and prove the scanner still blocks.
matches_staged() {
  git diff --cached -U0 -- $STAGED \
    | grep -E '^\+' | grep -vE '^\+\+\+' \
    | grep -nE "$1" \
    | grep -v '555555' || true
}

matches_all() {
  git ls-files -z \
    | xargs -0 grep -nHE "$1" 2>/dev/null \
    | grep -v '555555' || true
}

if [ "$MODE" != "--all" ]; then
  STAGED=$(git diff --cached --name-only --diff-filter=ACM)
  [ -z "$STAGED" ] && exit 0
fi

FAIL=0
for pattern in "${PATTERNS[@]}"; do
  if [ "$MODE" = "--all" ]; then
    MATCH=$(matches_all "$pattern")
  else
    MATCH=$(matches_staged "$pattern")
  fi
  if [ -n "$MATCH" ]; then
    echo "✗ Blocked: content matches /$pattern/"
    echo "$MATCH" | head -5
    FAIL=1
  fi
done

if [ "$FAIL" -eq 1 ]; then
  echo ""
  echo "Move the value to .env and read it via harness/src/config.ts."
  echo "Override only if certain:  git commit --no-verify"
  exit 1
fi

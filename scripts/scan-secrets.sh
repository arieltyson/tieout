#!/usr/bin/env bash
set -euo pipefail

# Patterns that must never enter the repo.
PATTERNS=(
  '\+1[0-9]{10}'                                 # E.164 North American
  '[0-9]{3}-[0-9]{3}-[0-9]{4}'                   # dashed phone
  '[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-z]{2,}'  # email
  'sk-ant-[a-zA-Z0-9-]+'                         # Anthropic key
)

# THE EXEMPTION — read this before adding a placeholder.
#
# Real secrets are blocked. Values from ranges that standards bodies reserve
# for documentation are not, because a repo that cannot write down an example
# phone number ends up with contributors splitting string literals to sneak
# past its own scanner — which is worse, since it trains people to work
# around the check rather than fix the value.
#
# Exempt, in ANY written form:
#
#   +15555550100     NANP 555-0100..555-0199, reserved for fiction (E.164)
#   555-555-0142     the same reserved range, dashed
#   a@example.com    RFC 2606 reserved documentation domains
#   x@host.invalid   RFC 2606 reserved TLDs: .invalid .test .example
#
# NOT exempt, deliberately:
#
#   +1604555nnnn     a real area code. 555-1234 is a convention, not a
#                    reserved number, and sits outside the NANP block above.
#                    Written with letters here on purpose: spelled out in
#                    full, this line would trip the scanner it documents.
#   a@{provider}.com a real mail provider. Braces here for the same reason
#                    as the digits above: written literally, this line would
#                    trip the scanner it documents. That has now happened
#                    twice while writing this comment, which is a decent
#                    sign the patterns are not too narrow.
#
# HISTORY, because the previous rule was subtly wrong. It matched the literal
# string "555555", which exempted +15555550100 and nothing else — not the
# dashed form of the SAME reserved number, and no documentation domain. It
# then blocked this repo's own synthetic chat.db fixture. Widened to the
# ranges that are actually reserved, rather than to whatever shape happened
# to be in the way at the time.
EXEMPT='(\+1555555[0-9]{4}|555-555-0[0-9]{3}|@example\.(com|net|org)|\.(invalid|test|example)\b)'

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

matches_staged() {
  git diff --cached -U0 -- $STAGED \
    | grep -E '^\+' | grep -vE '^\+\+\+' \
    | grep -nE "$1" \
    | grep -vE "$EXEMPT" || true
}

matches_all() {
  git ls-files -z \
    | xargs -0 grep -nHE "$1" 2>/dev/null \
    | grep -vE "$EXEMPT" || true
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
  echo "If it is a documentation placeholder, use a reserved range — see the"
  echo "EXEMPT note in this script."
  echo "Override only if certain:  git commit --no-verify"
  exit 1
fi

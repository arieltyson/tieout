#!/usr/bin/env bash
set -euo pipefail

# Patterns that must never enter the repo. Checked against staged content
# only, so it stays fast and cannot be bypassed by an unstaged working copy.
PATTERNS=(
  '\+1[0-9]{10}'                              # E.164 North American
  '[0-9]{3}-[0-9]{3}-[0-9]{4}'                # dashed phone
  '[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-z]{2,}'  # email
  'sk-ant-[a-zA-Z0-9-]+'                      # Anthropic key
)

STAGED=$(git diff --cached --name-only --diff-filter=ACM)
[ -z "$STAGED" ] && exit 0

FAIL=0
for pattern in "${PATTERNS[@]}"; do
  # .env.example is allowed to contain 555 placeholders
  if MATCH=$(git diff --cached -U0 -- $STAGED \
      | grep -E '^\+' | grep -vE '^\+\+\+' \
      | grep -nE "$pattern" \
      | grep -v '555555' || true); [ -n "$MATCH" ]; then
    echo "✗ Blocked: staged content matches /$pattern/"
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

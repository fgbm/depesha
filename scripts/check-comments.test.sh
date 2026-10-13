#!/usr/bin/env bash
# Self-test for scripts/check-comments.sh: every rule must fire on the fixture, and the
# script must fail on it. Without a fired rule a silent rule would go unnoticed.
set -uo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"

out="$(COMMENT_CHECK_DIRS=scripts/testdata/comments scripts/check-comments.sh 2>&1)"
rc=$?

fail=0

for rule in restatement name-echo boilerplate same-subject narration review-ref allow; do
  if ! grep -q ": $rule: " <<<"$out"; then
    echo "check-comments.test: the fixture did not fire rule '$rule'" >&2
    fail=1
  fi
done

if [[ $rc -ne 1 ]]; then
  echo "check-comments.test: expected exit 1 on the fixture, got $rc" >&2
  fail=1
fi

if ! grep -q '^check-comments: files 3, violations ' <<<"$out"; then
  echo "check-comments.test: the summary line is missing or unexpected" >&2
  fail=1
fi

if [[ $fail -ne 0 ]]; then
  printf '%s\n' "$out" >&2
  exit 1
fi

echo "check-comments.test: all rules fired on the fixture"

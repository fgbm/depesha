#!/usr/bin/env bash
# Release notes for a tag: the version's section of CHANGELOG.md, then the commits since
# the previous tag grouped by their conventional-commit type.
#
#   scripts/release-notes.sh v0.5.1 > notes.md
#
# Needs the full history with tags (actions/checkout with fetch-depth: 0).
set -euo pipefail
cd "$(dirname "$0")/.."

tag=${1:?usage: release-notes.sh <tag>}
version=${tag#v}
repo_url=${REPO_URL:-https://github.com/fgbm/depesha}

prev=$(git describe --tags --abbrev=0 --match 'v*' "$tag^" 2>/dev/null || true)
range=${prev:+$prev..}$tag

# "## 0.5.1 — 2026-10-03" without its heading, then every older section down to the
# previous tag's (a version that never got a tag, like 0.5.0, ships with the next one).
changes=$(awk -v v="$version" -v stop="${prev#v}" '
  /^## / {
    if (inside && ($2 == stop || stop == "")) exit
    if (inside) { print; next }
    if ($2 == v) { inside = 1; next }
  }
  inside { print }
' CHANGELOG.md | sed -e '/./,$!d')
if [ -z "$changes" ]; then
  echo "CHANGELOG.md has no section \"## $version\"" >&2
  exit 1
fi

# One file per group, in the order they are printed.
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
groups=(feat fix perf refactor docs other)
declare -A titles=(
  [feat]="Новое"
  [fix]="Исправления"
  [perf]="Производительность"
  [refactor]="Переработка"
  [docs]="Документация"
  [other]="Служебное"
)

while IFS=$'\t' read -r hash subject; do
  if [[ $subject =~ ^([a-z]+)(\([^\)]*\))?!?:\ (.*)$ ]]; then
    type=${BASH_REMATCH[1]}
    text=${BASH_REMATCH[3]}
  else
    type=other
    text=$subject
  fi
  case $type in
    feat | fix | perf | refactor | docs) ;;
    revert) text="откат: $text"; type=other ;;
    *) type=other ;;
  esac
  # The version bump says nothing to a reader.
  [[ $text =~ ^версия\ [0-9.]+$ ]] && continue
  printf -- '- %s (%s)\n' "$text" "$hash" >>"$work/$type"
done < <(git log --no-merges --reverse --format='%h%x09%s' "$range")

echo "$changes"
echo
echo "## Что сделано"
for g in "${groups[@]}"; do
  [ -s "$work/$g" ] || continue
  echo
  echo "### ${titles[$g]}"
  echo
  cat "$work/$g"
done
echo
if [ -n "$prev" ]; then
  echo "Все изменения: [$prev...$tag]($repo_url/compare/$prev...$tag)"
  echo
fi
echo "Сборки не подписаны: Windows SmartScreen и macOS Gatekeeper предупредят при первом запуске."

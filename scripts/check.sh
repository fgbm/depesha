#!/usr/bin/env bash
# Full verification: static checks, unit tests, integration tests against GreenMail,
# and the end-to-end GUI run on a virtual display.
#
#   scripts/check.sh          everything
#   scripts/check.sh --fast   static checks and unit tests only
#   scripts/check.sh --changed  only what the branch touched (against the merge-base with
#                               origin/main, plus uncommitted files); for work on a branch.
#                               e2e is never run here.
#   scripts/check.sh --ci     the checks of --fast over the whole project, then a push of the current
#                             branch and a wait for its CI run (`gh run watch`); the exit code is the
#                             run's. The e2e (in parts), integration and platform jobs run there, not
#                             on this machine, so the stand below is not needed. The merge into main
#                             wants this green on the branch (again after a rebase on main).
#
# The full run (no flag) takes a lock on the shared stand ($DEPESHA_STAND_LOCK, default
# ${XDG_RUNTIME_DIR:-/tmp}/depesha-e2e.lock) before GreenMail and waits if another run holds it;
# e2e/run.mjs started by hand takes the same lock. --fast and --changed do not touch it.
#
# The E2E part needs Xvfb on $E2E_DISPLAY (default :99), tauri-driver and WebKitWebDriver;
# see e2e/README.md.
set -euo pipefail
cd "$(dirname "$0")/.."

step() { printf '\n== %s\n' "$*"; }

# One compile cache for every worktree, only where sccache is installed. It does not cache
# incremental crates, hence CARGO_INCREMENTAL=0. It also hashes every CARGO_* variable of the
# environment, CARGO_TARGET_DIR included: a per-worktree value would make every key unique,
# so the target stays the worktree's own default `target/` (see docs/release-process.md).
if [[ -z "${RUSTC_WRAPPER:-}" && -z "${DEPESHA_NO_SCCACHE:-}" ]] && command -v sccache >/dev/null 2>&1; then
  sccache --start-server >/dev/null 2>&1 || true
  if sccache -s >/dev/null 2>&1; then
    export RUSTC_WRAPPER=sccache CARGO_INCREMENTAL=0
    unset CARGO_TARGET_DIR
  else
    echo "sccache не отвечает: собираю без него. DEPESHA_NO_SCCACHE=1 отключает эту проверку." >&2
  fi
fi

ci_preflight() {
  branch=$(git symbolic-ref --short -q HEAD || true)
  if [[ -z $branch ]]; then
    echo "--ci: HEAD не на ветке, пушить нечего. Перейди на ветку." >&2
    exit 1
  fi
  if [[ $branch == main ]]; then
    echo "--ci работает на ветке задачи, не на main." >&2
    exit 1
  fi
  if ! upstream=$(git rev-parse --abbrev-ref --symbolic-full-name '@{u}' 2>/dev/null); then
    echo "--ci: у ветки «$branch» нет upstream, пушить некуда. Один раз: git push -u origin $branch" >&2
    exit 1
  fi
  if ! command -v gh >/dev/null 2>&1; then
    echo "--ci: нужен gh (GitHub CLI), он не найден." >&2
    exit 1
  fi
  if [[ -n $(git status --porcelain --untracked-files=no) ]]; then
    echo "Внимание: есть незакоммиченные изменения; CI увидит только коммиты." >&2
  fi
}

[[ "${1:-}" == "--ci" ]] && ci_preflight

if [[ "${1:-}" == "--changed" ]]; then
  base=$(git merge-base HEAD origin/main 2>/dev/null || git merge-base HEAD main)
  # No rename detection: a file moved from src/ to e2e/ counts as both a deletion and an addition,
  # so both groups see it. quotePath off keeps Cyrillic names as they are.
  changed=$({ git -c core.quotePath=false diff --name-only --no-renames "$base"; git -c core.quotePath=false ls-files --others --exclude-standard; } | sort -u)
  printf 'База: %s, изменено файлов: %s\n' "${base:0:9}" "$(grep -c . <<<"$changed" || true)"
  if [[ -z $changed ]]; then
    echo "Нечего проверять: изменений относительно базы нет."
    exit 0
  fi
  pick() { grep -E "$1" <<<"$changed" || true; }
  rust=$(pick '^(crates/|src-tauri/|Cargo\.(toml|lock)$|rustfmt\.toml$)')
  front=$(pick '^(src/|plugins/|public/|index\.html$|package(-lock)?\.json$|vite\.config|svelte\.config|tsconfig|eslint|docs/frontend-|scripts/(frontend-|check\.sh))')
  # Config that changes how every file is linted: the whole tree, not the list of changed files.
  lintconf=$(pick '^(eslint|package(-lock)?\.json$|tsconfig|vite\.config)')
  e2e=$(pick '^e2e/')
  # Files that exist (not deleted); an array, so that names with spaces survive.
  mapfile -t lintable < <(pick '\.(ts|js|mjs|svelte)$' | while IFS= read -r f; do [[ -f $f ]] && printf '%s\n' "$f"; done)

  if [[ -n $rust ]]; then
    step "rustfmt"
    cargo fmt --all --check
    step "clippy"
    cargo clippy --workspace --all-targets -- -D warnings
    if grep -qE '^(crates/|Cargo)' <<<"$rust"; then
      step "cargo test -p depesha-core"
      cargo test -p depesha-core
    fi
    # src-tauri depends on the core, so a change in crates/ reaches it too.
    if grep -qE '^(crates/|src-tauri/|Cargo)' <<<"$rust"; then
      step "cargo test -p depesha --lib"
      cargo test -p depesha --lib
    fi
  fi
  if [[ -n $front ]]; then
    step "svelte-check"
    npx svelte-check --tsconfig ./tsconfig.json --fail-on-warnings
    step "метрики фронтенда"
    scripts/frontend-metrics.sh
    step "инварианты фронтенда"
    scripts/frontend-invariants.sh
    step "vitest (затронутое)"
    npx vitest run --changed "$base" --passWithNoTests
    step "главный чанк фронтенда"
    scripts/frontend-bundle.sh
  fi
  if [[ -n $lintconf ]]; then
    step "eslint (весь проект: изменился конфиг)"
    npm run lint
  elif ((${#lintable[@]})); then
    step "eslint (изменённые файлы)"
    npx eslint --no-warn-ignored "${lintable[@]}"
  fi
  if [[ -n $e2e ]]; then
    step "e2e (синтаксис и тест прогона)"
    while IFS= read -r f; do [[ $f == *.mjs && -f $f ]] && node --check "$f"; done <<<"$e2e"
    npx vitest run e2e
    echo "e2e не запускается в --changed: он идёт в CI на ветке (scripts/check.sh --ci)."
  fi
  step "хук персональных данных"
  scripts/hooks/pre-commit.test.sh
  exit 0
fi

step "rustfmt"
cargo fmt --all --check
step "clippy"
cargo clippy --workspace --all-targets -- -D warnings
step "svelte-check"
npx svelte-check --tsconfig ./tsconfig.json --fail-on-warnings
step "eslint"
npm run lint
step "хук персональных данных"
scripts/hooks/pre-commit.test.sh
step "метрики фронтенда"
scripts/frontend-metrics.sh
step "инварианты фронтенда"
scripts/frontend-invariants.sh
step "vitest"
npx vitest run
step "главный чанк фронтенда"
scripts/frontend-bundle.sh
step "cargo test (unit + scripted Exchange SMTP)"
cargo test -p depesha-core
cargo test -p depesha --lib

if [[ "${1:-}" == "--fast" ]]; then
  exit 0
fi

if [[ "${1:-}" == "--ci" ]]; then
  step "CI на ветке"
  git push
  sha=$(git rev-parse HEAD)
  run=""
  for i in $(seq 30); do
    run=$(gh run list --workflow ci.yml --branch "$branch" --commit "$sha" --event push --limit 1 --json databaseId --jq '.[0].databaseId // empty' 2>/dev/null || true)
    [[ -n $run ]] && break
    sleep 2
  done
  if [[ -z $run ]]; then
    echo "--ci: запуск CI для ${sha:0:9} на ветке $branch не появился за минуту." >&2
    exit 1
  fi
  echo "запуск: $(gh run view "$run" --json url --jq .url)"
  gh run watch "$run" --exit-status --interval 20
  exit $?
fi

# The build needs no stand, so it goes before the lock and does not hold the others up.
step "сборка для E2E"
npx tauri build --debug --no-bundle --features e2e

# One stand for every worktree and agent (ports 3025/3143/…, WebDriver 4444/4445): wait for a
# run that holds it. e2e/run.mjs started by hand takes the same lock itself.
step "стенд"
lock="${DEPESHA_STAND_LOCK:-${XDG_RUNTIME_DIR:-/tmp}/depesha-e2e.lock}"
exec 9>"$lock"
if ! flock -n 9; then
  echo "стенд занят, жду до часа… ($lock)"
  flock -w 3600 9 || { echo "стенд не освободился за час ($lock)" >&2; exit 1; }
fi
export DEPESHA_STAND_LOCKED=1

stand_up() {
  docker compose -f compose.test.yaml up -d --force-recreate
  # An open port is not a ready server: Dovecot closes the first TLS handshakes with EOF.
  python3 scripts/wait-stand.py
}

step "GreenMail"
stand_up
step "integration tests"
# Full parallelism drops dozens of TLS sessions against one Dovecot at once. 9>&-: a sccache
# server started by cargo here must not inherit the lock's descriptor and keep the lock alive.
DEPESHA_IT=1 cargo test -p depesha-core --test greenmail --test dovecot -- --test-threads=4 9>&-

step "E2E"
stand_up
# GreenMail accepts connections a moment before its users exist.
for i in $(seq 10); do
  python3 e2e/imap_helper.py seed 2>/dev/null && break
  [[ $i == 10 ]] && { echo "seed failed"; exit 1; }
  sleep 2
done
e2e/keyring.sh node e2e/run.mjs

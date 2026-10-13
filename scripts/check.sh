#!/usr/bin/env bash
# Full verification: static checks, unit tests, integration tests against GreenMail,
# and the end-to-end GUI run on a virtual display.
#
#   scripts/check.sh          everything
#   scripts/check.sh --fast   static checks and unit tests only
#   scripts/check.sh --changed  only what the branch touched (against the merge-base with
#                               origin/main, plus uncommitted files); for work on a branch.
#                               e2e is never run here.
#   scripts/check.sh --ci     the checks of --changed over the branch, then a push of the current
#                             branch and a wait for its CI run (`gh run watch`); the exit code is the
#                             run's. Optional: for a risky change, to try CI on the branch before the
#                             merge; a merge itself needs only --changed. The e2e (in parts),
#                             integration and platform jobs, and the whole project's static checks
#                             and unit tests (CI's "Lint and unit tests" job), run there, not on this
#                             machine, so the stand below is not needed and the local run stays cheap.
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

# Unused dependencies (cargo machete); CI installs it, here it runs only where it is installed.
machete() {
  if command -v cargo-machete >/dev/null 2>&1; then
    step "cargo machete"
    cargo machete
  else
    echo "cargo-machete не установлен: проверка лишних зависимостей идёт в CI (cargo install cargo-machete --version 0.9.2 --locked)"
  fi
}

# Русские документы из охвата styles/DepeshaRU: те же файлы, что у ste-lint по умолчанию (mirror .vale.ini).
ru_docs() {
  printf '%s\n' README.md AGENTS.md e2e/README.md design/mockups/README.md docs/style/ru-technical.md
  for d in docs docs/agents design/references; do
    [[ -d $d ]] && find "$d" -maxdepth 1 -type f -name '*.md'
  done
}

# Markdown в охвате Vale (styles/DepeshaEN и styles/DepeshaRU; mirror .vale.ini).
style_docs() {
  ru_docs
  printf '%s\n' README.en.md plugins/README.md SECURITY.md CONTRIBUTING.md docs/style/ste-en.md
}

# Vale по переданным файлам, только где он установлен; иначе одна строка-напоминание, проверка не падает.
vale_check() {
  if command -v vale >/dev/null 2>&1; then
    step "стиль текста (Vale)"
    vale --minAlertLevel=error "$@"
  else
    echo "vale не установлен: проверку стиля гоняет CI (job vale) и, при установленном vale, scripts/check.sh"
  fi
}

# Правила комментариев в коде (AGENTS.md, раздел Code rules): тест на fixture и дерево.
comment_check() {
  step "правила комментариев в коде (тест)"
  scripts/check-comments.test.sh
  step "правила комментариев в коде"
  scripts/check-comments.sh
}

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

# Push the branch and wait for its CI run; the exit code is the run's. --ci runs the --changed
# checks first, so the branch is pushed only once they are green.
ci_push_watch() {
  step "CI на ветке"
  # Text-only changes start no CI run (ci.yml has paths-ignore): there is nothing to push and wait for.
  b=$(git merge-base HEAD origin/main 2>/dev/null || git merge-base HEAD main)
  files=$(git diff --name-only "$b")
  if [[ -z $files ]] || ! grep -qvE '^(docs/|design/|.*\.md$)' <<<"$files"; then
    echo "--ci: изменений для CI нет (правки только текстов) — ждать нечего."
    exit 0
  fi
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
}

if [[ "${1:-}" == "--changed" || "${1:-}" == "--ci" ]]; then
  base=$(git merge-base HEAD origin/main 2>/dev/null || git merge-base HEAD main)
  # No rename detection: a file moved from src/ to e2e/ counts as both a deletion and an addition,
  # so both groups see it. quotePath off keeps Cyrillic names as they are.
  changed=$({ git -c core.quotePath=false diff --name-only --no-renames "$base"; git -c core.quotePath=false ls-files --others --exclude-standard; } | sort -u)
  printf 'База: %s, изменено файлов: %s\n' "${base:0:9}" "$(grep -c . <<<"$changed" || true)"
  if [[ -z $changed ]]; then
    echo "Нечего проверять: изменений относительно базы нет."
    [[ "${1:-}" == "--ci" ]] && ci_push_watch
    exit 0
  fi
  pick() { grep -E "$1" <<<"$changed" || true; }
  rust=$(pick '^(crates/|src-tauri/|src/lib/generated/|Cargo\.(toml|lock)$|rustfmt\.toml$)')
  front=$(pick '^(src/|plugins/|public/|index\.html$|package(-lock)?\.json$|vite\.config|svelte\.config|tsconfig|eslint|docs/(frontend-|plugin-api)|scripts/(frontend-|plugin-api-|check\.sh))')
  # Config that changes how every file is linted: the whole tree, not the list of changed files.
  lintconf=$(pick '^(eslint|package(-lock)?\.json$|tsconfig|vite\.config)')
  e2e=$(pick '^e2e/')
  ipcguard=$(pick '^scripts/ipc-callers')
  # Files that exist (not deleted); an array, so that names with spaces survive.
  mapfile -t lintable < <(pick '\.(ts|js|mjs|svelte)$' | while IFS= read -r f; do [[ -f $f ]] && printf '%s\n' "$f"; done)
  # Markdown of the branch, drafts in docs/internal/ aside.
  mapfile -t mdfiles < <(pick '\.md$' | grep -vE '^(docs/internal/|node_modules/)' | while IFS= read -r f; do [[ -f $f ]] && printf '%s\n' "$f"; done)

  if [[ -n $rust$front$e2e$ipcguard ]]; then
    step "у каждой IPC-команды есть вызов"
    node scripts/ipc-callers.mjs
  fi
  if [[ -n $rust ]]; then
    step "единственный lock"
    scripts/lock-guard.sh
    scripts/lock-guard.test.sh
    step "rustfmt"
    cargo fmt --all --check
    step "clippy"
    cargo clippy --workspace --all-targets -- -D warnings
    step "TS-типы совпадают с Rust"
    scripts/gen-types.sh --check
    machete
    # The crate tests recompile the changed crate and its dependents — the slow part of a one-line
    # edit; they run in CI's check job on main. gen-types above already compiles the depesha --lib
    # test binary, so a filtered run adds little here.
    echo "cargo test -p depesha-core и -p depesha --lib идут в CI на main (check)."
  fi
  if [[ -n $front ]]; then
    step "метрики фронтенда"
    scripts/frontend-metrics.sh
    step "инварианты фронтенда"
    scripts/frontend-invariants.sh
    step "API плагинов против снимка"
    node scripts/plugin-api-snapshot.mjs
    if grep -qE '^scripts/frontend-' <<<"$front"; then
      step "тест проверок метрик и инвариантов"
      scripts/frontend-checks.test.sh
    fi
    step "vitest (затронутое)"
    npx vitest run --changed "$base" --passWithNoTests
    # The main-chunk build is slow and only catches an accidental eager import, so it is built here
    # only when the dependencies or the build config moved; the whole-project svelte-check and the
    # baseline guard against main run in CI's check job on main, which builds the frontend anyway.
    if grep -qE '^(package(-lock)?\.json$|vite\.config|svelte\.config)' <<<"$front"; then
      step "главный чанк фронтенда (изменились зависимости или конфиг сборки)"
      scripts/frontend-bundle.sh
    fi
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
    echo "e2e не запускается в --changed: он идёт в CI на main."
  fi
  if ((${#mdfiles[@]})); then
    step "одна строка на абзац (Markdown)"
    node scripts/md-onelines.mjs "${mdfiles[@]}"
    # Vale по изменённым файлам: .vale.ini сам пропускает то, что вне охвата.
    vale_check "${mdfiles[@]}"
  fi
  if grep -qE '^scripts/md-onelines' <<<"$changed"; then
    step "тест проверки Markdown"
    npx vitest run scripts/md-onelines.test.mjs
  fi
  if grep -qE '^(scripts/(stand-lock|check)|e2e/stand-lock)' <<<"$changed"; then
    step "тест замка стенда"
    scripts/stand-lock.test.sh
  fi
  # Ste-lint — только изменённые русские документы из охвата: на английском он ложно ругается русским словарём.
  mapfile -t ruChanged < <(comm -12 <(printf '%s\n' "${mdfiles[@]:-}" | grep . | sort -u) <(ru_docs | sort -u))
  if ((${#ruChanged[@]})) || grep -qE '^scripts/ste-lint' <<<"$changed"; then
    step "правила письма (STE)"
    if ((${#ruChanged[@]})); then node scripts/ste-lint.mjs "${ruChanged[@]}"; else node scripts/ste-lint.mjs; fi
    step "тест проверки STE"
    npx vitest run scripts/ste-lint.test.mjs
  fi
  comment_check
  step "хук персональных данных"
  scripts/hooks/pre-commit.test.sh
  [[ "${1:-}" == "--ci" ]] && ci_push_watch
  exit 0
fi

step "единственный lock"
scripts/lock-guard.sh
scripts/lock-guard.test.sh
step "rustfmt"
cargo fmt --all --check
step "clippy"
cargo clippy --workspace --all-targets -- -D warnings
step "TS-типы совпадают с Rust"
scripts/gen-types.sh --check
machete
step "svelte-check"
npx svelte-check --tsconfig ./tsconfig.json --fail-on-warnings
step "eslint"
npm run lint
step "одна строка на абзац (Markdown)"
node scripts/md-onelines.mjs
mapfile -t styledocs < <(style_docs | sort -u)
vale_check "${styledocs[@]}"
step "правила письма (STE)"
node scripts/ste-lint.mjs
step "тест проверки STE"
npx vitest run scripts/ste-lint.test.mjs
comment_check
step "хук персональных данных"
scripts/hooks/pre-commit.test.sh
step "метрики фронтенда"
scripts/frontend-metrics.sh
step "инварианты фронтенда"
scripts/frontend-invariants.sh
step "API плагинов против снимка"
node scripts/plugin-api-snapshot.mjs
step "у каждой IPC-команды есть вызов"
node scripts/ipc-callers.mjs
step "baseline против main"
git fetch -q --no-tags origin main 2>/dev/null || true
scripts/frontend-baseline-guard.sh
step "тест проверок метрик и инвариантов"
scripts/frontend-checks.test.sh
step "тест замка стенда"
scripts/stand-lock.test.sh
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

# The build needs no stand, so it goes before the lock and does not hold the others up.
step "сборка для E2E"
npx tauri build --debug --no-bundle --features e2e

# One stand for every worktree and agent (ports 3025/3143/…, WebDriver 4444/4445): wait for a
# run that holds it. e2e/run.mjs started by hand takes the same lock itself.
step "стенд"
source scripts/stand-lock.sh
stand_lock_take || exit 1

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
# 9>&-: an orphaned WebKitWebDriver must not inherit the lock and hold the stand until its timeout.
e2e/keyring.sh node e2e/run.mjs 9>&-

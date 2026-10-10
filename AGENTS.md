<!-- CODEGRAPH_START -->
## CodeGraph

In repositories indexed by CodeGraph (a `.codegraph/` directory exists at the repo root), reach for it BEFORE grep/find or reading files when you need to understand or locate code:

- **MCP tool** (when available): `codegraph_explore` answers most code questions in one call — the relevant symbols' verbatim source plus the call paths between them, including dynamic-dispatch hops grep can't follow. Name a file or symbol in the query to read its current line-numbered source. If it's listed but deferred, load it by name via tool search.
- **Shell** (always works): `codegraph explore "<symbol names or question>"` prints the same output.

If there is no `.codegraph/` directory, skip CodeGraph entirely — indexing is the user's decision.
<!-- CODEGRAPH_END -->

## What Depesha is

Depesha is a mail client. It receives mail and it sends mail. That is the whole product.

Everything else is a plugin. Snoozing, follow-ups, templates, preflight checks, accent colours — none of that is mail, so none of it belongs in the core. This is the product's philosophy, not a cleanup rule: the core stays something you can hold in your head, and the interesting parts live behind a contract.

What this means when you work:

- A new feature starts with one question: **is this receiving or sending mail?** If no, it is a plugin, and the work is to find or add the point of extension it needs — not to grow the core.
- When a plugin needs something the core doesn't expose, extend the contract (`src/plugin-api/`), keep the addition as small as the plugin actually requires, and leave the core's own behaviour unchanged when no plugin is loaded.
- A plugin that is a matter of taste ships switched off (`defaultOff`). A plugin that stops the user making a real mistake can ship switched on — the distinction is harm, not preference.
- Pushing something into a plugin is not a way to dodge the work. If the feature is worth doing, the plugin does it properly, including its point of extension in the core.

When a plugin is added, removed, or changes what it does or whether it ships switched on, update the wiki page that lists them — https://github.com/fgbm/depesha/wiki/Плагины (the wiki is a git repo of its own: `git clone https://github.com/fgbm/depesha.wiki.git`). It is written for the people who use Depesha, not for developers; the contract itself stays in `plugins/README.md`.

## Work through subagents — you are the orchestrator

This section is for the main session only. **If you were invoked as a subagent (`explore`, `coder`, `general`), ignore it: do the work you were given yourself and don't delegate further.** A subagent that re-delegates loses the context it was handed and spends tokens on nothing.

Default to delegating. Keep the main session for planning, slicing, wiring the pieces together and talking to the operator; push reading and writing code into subagents.

- `explore` — read-only discovery: where something lives, how a flow works, call sites, configs, conventions. State the thoroughness you need (quick / medium / very thorough). Use it instead of a manual grep-and-read loop (after CodeGraph, which is still the first stop for indexed code).
- `coder` — implementation by a precise spec. Never ask it to "figure out what to do".
- `general` — review and multi-step research. Every non-trivial change gets a review pass on `general` before you report it done.

### Slicing

Break anything larger than a single file-local edit into slices, one `coder` call per slice:

- A slice is independently reviewable and leaves the tree building: one layer, one feature flag, one component plus its tests.
- Order slices so each builds on the previous one; run independent slices in parallel (`background: true`), dependent ones sequentially.
- Prefer 3–6 focused slices over one large task. If a slice's spec doesn't fit in a short paragraph plus a file list, split it again.

### Spec for a `coder` call

Subagents start with no context. Every call carries:

1. **Goal** — one sentence on what changes and why.
2. **Files** — exact paths to touch, plus the paths to read for context (CodeGraph output or `explore` findings pasted in, not "look around").
3. **Constraints** — conventions, what must not change, public API and i18n keys to keep, surrounding style.
4. **Acceptance criteria** — what must pass: `npm run check`, `cargo clippy`, specific tests, UI behaviour.
5. **Scope fence** — "no refactors beyond the listed files, no dependency changes, no version bumps."

Don't trust a subagent's report at face value: verify the claims (diff, build, tests) in the main session or hand the diff to `general` for review. If a subagent reports something that contradicts what you know, re-check before acting on it.

### Review on `general`

Give the reviewer the diff (`git diff`, or the file list), the original spec and the acceptance criteria, and ask for concrete findings: correctness, missed call sites, conventions, i18n and accessibility, tests. Feed findings back into a follow-up `coder` slice rather than fixing them ad hoc in the main session.

### When to do it yourself

One-line fixes, a quick file read, running a build or test, committing, answering a question from context you already have. Delegation overhead isn't worth it there.

## Работа в репозитории: грабли

Стенд и прогон — в `e2e/README.md`, библиотеки и протоколы — в `docs/dev-notes.md`. Здесь — как не наступить на грабли самого репозитория.

### Параллельная работа и git

- Worktree создавай абсолютным путём: `git -C <repo> worktree add <относительный>` считает путь от `-C` и кладёт worktree внутрь checkout.
- Не `git add -A` и не `git add -A ':!node_modules' ':!target'`: первое забирает чужие незакоммиченные файлы, второе падает с «The following paths are ignored» и не добавляет ничего. Перечисляй свои пути и перед коммитом смотри `git diff --cached --stat`.
- Общие файлы (CHANGELOG, PAPERCUTS, baseline) смотри через `git diff <file>`: `git add` забирает чужой незакоммиченный кусок. Свою часть — через `git add -p` или индекс из `HEAD:<file>` плюс своя правка.
- Чужие правки перед коммитом прогоняй `scripts/check.sh --fast`, а не только их тест: непрогнанный `cargo fmt` роняет CI.
- Основное дерево — только для слияний. Параллельная сессия в нём правит те же файлы, и её `git checkout` откатывает чужое; перед коммитом и после слияния сверяй `git status` и `git diff --name-only` со своим списком файлов.
- Не прячь рабочую копию `stash`'ем: `stash pop` сливает индекс с рабочей копией и двоит блоки, а `stash drop` после конфликта уносит незакоммиченное. Временный откат — патчем по своим файлам (`git diff > /tmp/x.patch`). После конфликтного `stash pop` не делай `checkout HEAD` по конфликтным путям: там лежат и твои правки, а stash после такого pop сам не удаляется.
- Промежуточные коммиты проверяй в `git worktree add --detach <sha>`, а не через stash и не `cargo check` в рабочем дереве: check смотрит дерево, а не индекс, и в историю уходит красный коммит. База нарезки — фиксированный хэш, не `HEAD`.
- После `cargo fmt` перечитывай фрагмент перед правкой: fmt переносит длинные вызовы, и правка по старому тексту не находится.
- `git checkout <base> -- path` не удаляет новые файлы: он обновляет только пути, которые есть в base, поэтому откат «до» сохраняет файл, добавленный позже.

### node_modules в worktree

- Копируй `cp -a --reflink=auto <основной>/node_modules <wt>/node_modules`, а не симлинк. npm не дописывает симлинк, а reify-ит его в настоящую папку: пакеты задваиваются, и `npm run lint` из главного дерева линтер не видит.
- В `.gitignore` правило `node_modules` без косой черты. `node_modules/` ловит только папку, симлинк попадает в коммит и после слияния заменяет реальную папку (FilesystemLoop).

### Сборка Rust в worktree

- У каждого параллельного worktree свой `CARGO_TARGET_DIR`. Общий target между ветками с разным кодом смешивает артефакты: cargo подхватывает чужой `depesha-core`, и сборка падает ложными «no method» при живом `cargo check`. `CARGO_INCREMENTAL=0` и `cargo clean -p depesha-core -p depesha` — только если иначе нельзя: общий `target/debug/incremental` тоже делится, а `touch` ядра помогает лишь до следующей чужой сборки.
- `scripts/check.sh` сам включает `sccache` (общий кэш компиляции всех worktree, `~/.cache/sccache`), если он установлен и отвечает на `sccache -s` (сервер скрипт запускает сам), и ставит `CARGO_INCREMENTAL=0`: sccache не кэширует инкрементальные крейты. Не отвечает — скрипт собирает без него и напоминает про `DEPESHA_NO_SCCACHE=1` (отключает проверку). Ловушка: sccache хеширует все переменные `CARGO_*`, и `CARGO_TARGET_DIR` делает ключ уникальным для каждого worktree, кэш не попадает ни разу. Поэтому только внутри `check.sh` при `sccache` скрипт снимает `CARGO_TARGET_DIR`, а целью служит `target/` самого worktree (он на `/home`, не в `/tmp`). Вне `check.sh` (ручной `cargo`, `tauri build`) `CARGO_TARGET_DIR` действует как прежде, и правило про свой каталог на worktree остаётся в силе. Установка без sudo: бинарник с GitHub releases в `~/.cargo/bin`.
- Reflink `target` на этом ZFS не экономит место: `cp -a --reflink=auto` между каталогами копирует десятки гигабайт по-настоящему. Сверяй `df` до и после.
- `/tmp` — tmpfs на 7 ГБ, `CARGO_TARGET_DIR` туда не класть: сборка tokio его забивает. Параллельные rustc душат память — ограничивай `CARGO_BUILD_JOBS`.

### Tauri-команды

- Новая команда регистрируется в четырёх местах: `build.rs::COMMANDS`, `generate_handler!` в `lib.rs`, `capabilities/main.json` и `capabilities/message.json`. Тест `acl_matches_the_commands` требует, чтобы `main.json` совпадал с набором команд ровно, и расхождение видно только на `cargo test`, не на `cargo check`: `cargo test -p depesha --lib acl_matches_the_commands`.
- Команду держи тонкой обёрткой в `commands.rs`, логику — в модуле. Парсер теста берёт из `generate_handler!` только строки с префиксом `commands::` (`strip_prefix`), а `pub use` не переносит скрытый `__cmd__`. Если команда живёт в своём модуле (`drafts::draft_cache_*`), парсер должен брать имя после любого `module::` — правь его вместе с модулем.
- Windows-код трея и уведомлений не проверить `cargo clippy --target x86_64-pc-windows-msvc -p depesha`: сборочный скрипт `ring` падает («GNU compiler is not supported for this target»), без MSVC C-кода ядро не собрать. Мини-крейт в `/tmp` только с `tauri`, `tauri-winrt-notification`, `windows` и копией Windows-модуля собирается под msvc-целью без C-компилятора.

### Проверки фронтенда

- Метрики размера и инварианты — ориентир, не закон. Проверка падает только на ухудшении: рост размера компонента или функции (`scripts/frontend-metrics.sh`), новый член `app.*` (`scripts/frontend-invariants.sh`). Уменьшение и удаление проходят без пересборки; baseline подтягивается вниз командами `scripts/frontend-metrics.sh --tighten` и `scripts/frontend-invariants.sh --tighten` (они не поднимают значения и не добавляют члены `app.*`). Оправданный рост — строка с причиной в `docs/frontend-metrics-exceptions.txt` или `docs/frontend-invariants/exceptions.txt`, не молчаливый `--save`. Главный чанк по-прежнему сверяется по `scripts/frontend-bundle.sh` (`--save` отдельным коммитом, если рост оправдан). Baseline общие для веток; чужие не перезаписывай.
- Баланс: дробить код ради цифры нельзя — прокси-объекты, хосты с десятками колбэков, обёртки-пробросы без своей логики только прячут размер. Длинная функция, которая читается целиком, лучше десяти обёрток; рост с обоснованием лучше искусственной структуры. Ревьюер отдельно ищет обёртки ради обёрток и новые члены `app.*`, которые завели ради обхода лимита.
- Удалённое нарушение оставляет подавление в `eslint-suppressions.json`, и `eslint .` падает с кодом 2 без единой ошибки («suppressions left that do not occur anymore»). Чисти `eslint . --prune-suppressions` и смотри diff: файл подавлений общий для веток.
- `max-lines-per-function` считает вложенные `it` внутри `describe`: лимит падает на стрелку `describe`, а не на новый тест. Новый сценарий — в соседний `describe`.
- `no-control-regex` роняет проверку на литерале управляющих символов в паттерне. Фильтруй циклом по символам (`codePointAt`).

### Проверки и цикл исправлений

- Во время работы над веткой — `scripts/check.sh --changed`: файлы считаются от `git merge-base HEAD origin/main` плюс незакоммиченные (без поиска переименований: перенос `src/x` в `e2e/x` виден и как удаление, и как добавление). Правка `crates/` или `src-tauri/` — fmt, clippy, `cargo test -p depesha-core` (только для `crates/`) и `cargo test -p depesha --lib`. Фронтенд (`src/`, `plugins/`, `public/`, конфиги, `docs/frontend-*`, `scripts/frontend-*`, `scripts/check.sh`) — svelte-check, метрики, инварианты, `vitest --changed`, бандл. Конфиги eslint, `package*.json`, `tsconfig*`, `vite.config*` — полный `npm run lint`, а не список файлов; иначе eslint по изменённым. Правка `e2e/` — eslint, `node --check` и `vitest run e2e` (тест раннера шагов); сам e2e в `--changed` не запускается, скрипт пишет это строкой. Только docs/design — хук персональных данных. Нет изменений — строка «нечего проверять» и код 0. CI не вызывает `check.sh`: у него свои задачи (`check`, `integration`, `e2e` в трёх частях, `build`, платформенные).
- Перед слиянием в `main` — `scripts/check.sh --ci`, то есть зелёный CI на ветке. Скрипт прогоняет статические проверки и юнит-тесты по всему проекту (как `--fast`), пушит текущую ветку без force и ждёт её запуск (`gh run watch`); код выхода — итог запуска. Без upstream он пишет, что пушить некуда: один раз `git push -u origin <ветка>`. Локальный полный `scripts/check.sh` для слияния не обязателен: очередь к общему стенду не нужна. После rebase на `main`, перед ff, — снова зелёный CI на ветке (`--ci`).
- CI запускается на push любой ветки; новый push в ветку отменяет её прошлый запуск (`main` и `release/**` доигрываются). Тяжёлые платформенные задачи (`e2e-windows`, сборки Windows и macOS, печать на macOS, если она есть) на ветке идут, только если она трогает `crates/`, `src-tauri/` (с его `Cargo.toml`), корневые `Cargo.toml` и `Cargo.lock`, `package.json`, `package-lock.json`, `src/lib/drops.ts`, `e2e/drops.mjs`, `e2e/drop-steps.mjs`, `e2e/native-drop.ps1`, `e2e/windows-display.ps1` или `ci.yml`; на `main`, `release/**` и `workflow_dispatch` — всегда. Новая платформенная задача цепляется к задаче `changes` (`needs: changes`, `if: needs.changes.outputs.platform == 'true'`). e2e Linux в CI разделён на три части (`DEPESHA_E2E_SHARD=1/3…3/3`, разделы в `e2e/shard.mjs`), у каждой свой стенд и профиль; новый раздел сценария отметь `section("…")` в `e2e/run.mjs` и впиши в `SECTIONS`.
- Полный локальный `scripts/check.sh` остаётся для тех, кому он нужен. Часть со стендом (GreenMail, интеграция, e2e) берёт замок `${XDG_RUNTIME_DIR:-/tmp}/depesha-e2e.lock` и, если стенд занят, пишет «стенд занят, жду…» и ждёт. `e2e/run.mjs`, запущенный вручную, берёт тот же замок сам (под `check.sh` он уже держится, `DEPESHA_STAND_LOCKED=1`). `--fast`, `--changed` и `--ci` замок не берут. Стенд один, второй прогон рядом ломает оба, поэтому замок не обходи. После `docker compose up` скрипт ждёт не порта, а настоящего входа по IMAP и TLS (`scripts/wait-stand.py`): Dovecot открывает порт раньше, чем отвечает по TLS.
- e2e — в CI на ветке перед слиянием и перед выпуском. Перезапускается один раз только шаг с явной пометкой `{ retry: true }` в `e2e/run.mjs`: это шаги, которые лишь читают и ходят по интерфейсу. Шаги с отправкой, перемещением, удалением, черновиками и проверками по времени не помечай: повтор выполнит действие заново или спрячет медленный ответ. Перезапущенные шаги перечислены в итоговой сводке, в `results.json` у них `retried` и `firstError`; упавший дважды — провал.
- Reviewer смотрит дифф ветки до слияния: одна попытка исправления по ревью, затем повторное ревью правок. Некритичное уходит в заявку на следующую версию, а не в новый круг.
- Тест и исправление — в одном коммите. Baseline бандла пересобирается один раз, при слиянии; метрики и инварианты подтягиваются вниз `--tighten`, рост идёт через файл исключений.

### Коммиты test → fix

- Если тест требует новый API, коммить его вместе с правкой. Отдельный `test:` не собирается, а `pub` в приватном модуле не спасает от `cargo clippy --all-targets -D warnings` (dead_code). Делить `test:`/`fix:` можно только там, где тест собирается до правки.
- Переплетённые в одних файлах хунки `git add -p` не берёт. Нарезка: `git diff > all.patch`, порезать на `diff --git` + заголовок файла + один `@@`, затем `grep -v '^index ' <hunk> | git apply --cached --recount -` (без строки `index` и с `--recount` частичный хунк ложится в индекс), `git diff --cached --stat`, коммит. Промежуточный коммит проверяй в `git worktree add --detach <sha>`.

### Закреплённые версии

- `typescript@5`: svelte-check 4.7 принимает peer `^5 || ^6`, TypeScript 7 роняет `npm install` с ERESOLVE.
- `@codemirror/language@6.12.4`: `6.13.0` импортирует `@codemirror/streamparser`, но не объявляет его, vitest падает с «Cannot find package».
- `@eslint/js@^9`: свежий `@eslint/js@10` требует eslint ^10 и даёт ERESOLVE при eslint 9.
- Перед обновлением смотри `npm ls` и прогон тестов, а не только факт установки.

### Svelte 5

- Проп `state` ломает `$state`: Svelte читает `$state` как подписку на стор `state`. Переименовывай при деструктуризации (`state: answer`).
- Глобальный `.field` из `app.css` бьёт scoped-класс с тем же именем: это колонка flex, и `flex: 1` у textarea перебивает `height`. Имена обёрток не бери из `app.css`.
- Пропы компонента «на один раз» (`{#key}`, закрывается через родительский state) снимай при монтировании через `untrack`. Проп — геттер родительского выражения, и после `menu = null` чтение падает с `null is not an object`, без видимой ошибки в UI.
- Параметр-свойство конструктора (`constructor(private draft)`) присваивается после инициализаторов полей, и `$derived(this.draft()…)` в поле даёт «used before its initialization», хотя `$derived` ленивый. Читай такой источник через геттер и зови геттер из `$derived`.
- Фокус в `Popover` ставь через `requestAnimationFrame`: `$effect` считает позицию и сразу зовёт `focus()`, но `.pop` ещё `visibility: hidden`, а скрытый элемент не фокусируется.
- У `input[type=search]` кнопка очистки резервирует место, и `appearance: none` на самом поле её не убирает (`scrollWidth` больше текста). Нужно ещё `::-webkit-search-cancel-button, ::-webkit-search-decoration { appearance: none }`.

### Выпуск

- Имена картинок к релизу — латиницей (`01-background.png`). Кириллицу GitHub вырезает из имён, остаются точки (`01-.-.-.png`), и ссылки в описании приходится переписывать.
- В конфиге Tauri `category` — `Productivity` (`Office` не из списка, `invalid category`), `productName` — латиницей (`Depesha`): кириллица даёт пакет `Package: депеша`, который dpkg не установит. Русское имя — через свой `desktopTemplate`.
- У tauri-action параметр называется `uploadUpdaterJson`, не `includeUpdaterJson`. Ссылки в `latest.json` из черновика ведут на API-адреса ассетов и работают только с `Accept: application/octet-stream` (плагин updater ставит его сам). Проверяй скачиванием с этим заголовком.

# Papercuts

Мелкое трение — упавший вызов, путаный запуск, флакающая команда, устаревший кэш, вводящая в заблуждение ошибка, отсутствующий хелпер — дописывай сюда записью `## YYYY-MM-DD HH:MM — <модель>` и одной строкой «что делал → что помешало», с вероятной причиной или обходом; дубли не добавляй, это не журнал работ и не баг.

Записи по 2026-10-08 разобраны: правила — в `AGENTS.md`, стенд — в `e2e/README.md`, библиотеки — в `docs/dev-notes.md`, общие приёмы — в навыках агента. История — в git.

## 2026-10-09 03:00 — claude-opus-5-5

Параллельные ветки 0.7.2 гоняли полный `scripts/check.sh` одновременно на общем стенде → e2e падал на случайных шагах, `docker compose` одной ветки пересоздавал GreenMail другой. Ждать пустого `pgrep -af "e2e/run.mjs|WebKitWebDriver|tauri-driver|check.sh"` до запуска и не сливать в main до зелёного полного прогона.

## 2026-10-09 03:00 — claude-opus-5-5

Шаг `run: cargo test -p depesha --lib paths::` в `ci.yml` → весь workflow «workflow file issue» за 0 с: `::` в конце строки YAML читает как mapping. Заключать такие аргументы в кавычки (`-- "paths::"`); ошибка видна только после push, потому что CI не идёт на локальном main.

## 2026-10-09 03:00 — claude-opus-5-5

`scripts/check.sh` в свежем worktree со своим `CARGO_TARGET_DIR` → e2e не находит `target/debug/depesha` и нет `node_modules`. Нужны `npm ci` и `DEPESHA_APP=$CARGO_TARGET_DIR/debug/depesha`.

## 2026-10-09 20:10 — claude-sonnet-5-5

Вывод `shell` длиннее ~2,4 тыс. знаков обрезается в середине («output cut… call output_slice»), и нужные строки `grep`/`sed` теряются → читай файлы инструментом `read`, а команды сужай (`cut -c1-160 | head`) и пиши в файл.

## 2026-10-09 20:10 — claude-sonnet-5-5

Playwright MCP (`browser_take_screenshot`, `filename`) пишет только в `/home/vch/Projects/depesha/.playwright-mcp`, а `/tmp` и worktree отклоняет («outside allowed roots») → для снимков из worktree указывай абсолютный путь в этой папке и читай картинку оттуда.

## 2026-10-09 20:10 — claude-sonnet-5-5

`bind:this` на компонент с `export function` внутри `{#key}` и `{#if}`: фокус и подсветка строки по найденной настройке в e2e (WebKit, настоящее приложение) не срабатывали, а в Chromium и в MiniBrowser работали → не держать ссылку на экземпляр компонента ради DOM-действия, искать элемент по `data-*` в родителе и передавать подсветку пропом.

## 2026-10-09 20:10 — claude-sonnet-5-5

Нужен WebKit без сборки приложения: системный `/usr/lib/x86_64-linux-gnu/webkit2gtk-4.1/MiniBrowser` под `WebKitWebDriver` из `~/.local/depesha-testenv` (`dbus-run-session`, свой Xvfb на `:98`, `setsid nohup … & disown`, иначе процесс умирает вместе с командой) и страница с заглушкой `window.__TAURI_INTERNALS__`. Не `pkill -f`: гаси по PID.

## 2026-10-10 02:00 — claude-sonnet-5-5

Читал большие куски `store.rs` и `MessageList.svelte` через `shell` (`sed -n`) → вывод режется («middle dropped») уже около 10 КБ, куски пропадают без ошибки. Читать файлы инструментом `read` с `offset`/`limit` по 250–300 строк.
## 2026-10-09 23:12 — claude-sonnet-5-5

Читал большие файлы и вывод `grep`/`sed` через `shell` → вывод режется до ~1000 знаков с «output id», середина теряется. Файлы читать инструментом `read` (отдаёт целиком), в `shell` — узкие `grep -n`/`sed -n` с `cut -c1-200`.

## 2026-10-09 23:12 — claude-sonnet-5-5

В e2e клавиша окна письма с Alt: `press()` шлёт keydown на `window`, а обработчик ключей окна письма висит на самом диалоге → Alt-клавиши не доходят. Слать через `pressIn(<элемент внутри .compose>, key, { altKey: true, code })` (хелпер `altKey` в `e2e/run.mjs`); `code` нужен, раскладка берётся по физической клавише.

## 2026-10-10 14:30 — claude-opus-5-5

Новые worktree в `depesha-wt/q-*` для `check.sh --changed`/`--ci` → нет `node_modules`, svelte-check не находит `@tsconfig/svelte`; агенты кто `npm ci` (минуты), кто симлинк на основное дерево. Нужен один способ в `AGENTS.md` или шаг в `check.sh` («нет node_modules — `npm ci`»). Плюс `git push -u` забывают: upstream остаётся `origin/main`, первый `--ci` падает на push.

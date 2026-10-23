## 2026-10-22 02:40 — deepseek-v4.1-flash

Съёмка кадров цепочки на стенде с `imap_helper.py seed` → `kit.boot` ждёт в панели папку «Отчёты», а её создаёт `demo-seed`, не `seed`: прогон падает на «timeout waiting for folders» после мастера. Создай папку сам (`imap_helper.utf7_path('Отчёты')` + `c.imaplib.IMAP4.create`) или сей `demo-seed`.

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

## 2026-10-11 14:20 — deepseek-v4.1-flash

Выпуск 0.8.2: кадры `docs/screenshots/` и набор `release-shots` показывают версию в заголовке окна, поэтому снимать их надо ПОСЛЕ коммита `chore: версия X.Y.Z` и пересборки бинарника (`npx tauri build --debug --no-bundle --features e2e`) — иначе на картинках прошлая версия. У 0.8.1 так и сделано: пересъёмка `3fc1ed5` после бампа `7854c32`. Сборку в новом worktree ускоряет копия прогретого `target/` из основного дерева (`cp -a --reflink=auto`, ~40 с на инкрементальную сборку).

Там же: `scripts/release-shots.sh` сеет демо-данные тем же `SHOTS_SET`, что выбирает набор кадров, а `imap_helper.py demo-seed` понимал только «0.8.0» → новый набор «0.8.2» получил бы данные 0.7 (чужие папки, адрес carol). Расширил `demo_seed` на «0.8.2»; для будущих наборов, которым нужны те же письма, делать так же.

## 2026-10-17 08:17 — claude-opus-5-5

Ожидание CI после push в main → `gh run list --workflow ci.yml --commit 55e23d2` с коротким хешем отдаёт пустой список, и цикл ожидания ждал почти час, хотя прогон давно стал зелёным. `--commit` сравнивает полный SHA: передавай `$(git rev-parse HEAD)` или фильтруй `--json headSha` по префиксу.

## 2026-10-18 — deepseek-v4.1-flash

Вызов OpenChamber knowledge/render с `action: "save"` и `action: "render"` → отказ «Expected "knowledge.save" / "render.page"», хотя в описании инструмента и в подсказке каталога действие названо коротко. Передавай полное имя с точкой (`knowledge.save`, `knowledge.show`, `render.page`), короткое имя валит вызов ещё до выполнения.

## 2026-10-21 13:45 — claude-opus-5-5

`scripts/check.sh --changed` в worktree q-167-dkim → vitest падал на каждом файле с `ENOENT … /tmp/<случайное>/ssr/<хеш>`, хотя код ни при чём: кто-то из соседних сессий чистит каталоги vite в `/tmp` (tmpfs занят на 81 %). С `TMPDIR=$PWD/target/tmp` прогон зелёный. Вероятно, стоит ставить `TMPDIR` внутри worktree в самом `check.sh`.

## 2026-10-21 15:05 — claude-opus-5-5

Кадры настроек на своём Xvfb → `Xvfb` нет в `PATH` (лежит в `~/.local/depesha-testenv/root/usr/bin/`), а замок `/tmp/.X<n>-lock` он пишет только в `/tmp`, где кончилась квота пользователя («Превышена дисковая квота» даже на пустой файл). `unshare -Urm` с частным `/tmp` запрещён (uid_map). Помогло удалить устаревший кэш `/tmp/node-compile-cache/v24.16.0-*`. Главный потребитель квоты — `/tmp/node-compile-cache` текущей Node (2,3 ГБ): стоит задать `NODE_COMPILE_CACHE` в `~/.cache`.

## 2026-10-21 14:55 — claude-opus-5-5

`tauri build` в worktree → общий сервер sccache запущен чужой сессией с `TMPDIR=~/.cache/qs-vitest-tmp`, которого уже нет: каждый rustc падает «Failed to create temp dir». Собрал с `RUSTC_WRAPPER=` без sccache. Сервер sccache стоит перезапускать со стабильным `TMPDIR`.

## 2026-10-21 15:55 — claude-opus-5-5

Тест «какие имена DKIM-проверка спросила у DNS» (#167) → `mail_auth::ResolverCache::get<Q: ?Sized>` обобщён по типу ключа, имя в строку не достать (ни `downcast`, ни `Debug`). Обход: писать в тестовом поле `TxtCache` хеш имени через `RandomState::hash_one`, а сверять по `hash_one(&str)` и по числу запросов (`dkim.rs`).

## 2026-10-21 16:40 — claude-opus-5-5

Кадры настроек на своём Xvfb `:117` → после первого прогона съёмки Xvfb умирал, а следующий прогон падал «Failed to initialize GTK» и «HeadersTimeoutError». Причина — сброс сервера, когда отключается последний клиент. Помог флаг `-noreset`; стоит дописать его в команду Xvfb в `e2e/README.md`.

## 2026-10-21 18:45 — minimax-m3.1-flash

Выпуск 0.8.12: CI на коммите версии упал — задачи «Build macos-latest» и «Print a sheet (macOS)» отменились без раннера (`runner_name` пуст, шагов нет), при этом status.github.com показывал degraded Actions. Обход: `gh run rerun <id> --failed` — задачи взяли раннер и прошли. Отмена macOS-задач без раннера бывает и от сбоя платформы GitHub, а не от кода: смотреть `runner_name` в `gh api .../jobs` и лог задачи (у отменённой он недоступен).

## 2026-10-21 19:10 — minimax-m3.1-flash

Съёмка кадров (`scripts/release-shots.sh`) без Xvfb на `:99` → приложение падает с «Failed to initialize GTK», а `e2e/release-shots.mjs` висит: `d.start(app)` ждёт окна, которого не будет. Скрипт не поднимает Xvfb — в CI его стартует строка в `ci.yml`, локально его надо запустить самому (`~/.local/depesha-testenv/root/usr/bin/Xvfb :99 -screen 0 1440x900x24 -nolisten tcp &`). Висящий прогон держит замок стенда, и следующий ждёт его час: снимать свой процесс (`pgrep -af release-shots`).

## 2026-10-21 19:05 — minimax-m3.1-flash

Проверка текстовой части письма в e2e → в письме она quoted-printable, и поиск «[Изображение: …]» по сырому источнику не находит («=D0=98=D0=B7=D0=BE…»). Помощнику `e2e/imap_helper.py` добавлена команда `plain`: текстовая часть, декодированная (`email.message_from_bytes` + `get_payload(decode=True)`).

## 2026-10-22 00:55 — minimax-m3.1-flash

Vale (`DepeshaRU.SentenceLength`) и `scripts/md-onelines.mjs` тянут в разные стороны: разбить длинное предложение на несколько строк не помогает — правило считает слова до точки, а `md-onelines` требует один абзац на одной строке. Работающий способ: закончить предложение точкой и начать новое, потом `node scripts/md-onelines.mjs --fix` (склеит переносы) и гонять Vale по файлу.

## 2026-10-22 00:20 — minimax-m3.1-flash

Подпись DKIM, написанная вручную, не проходит проверку, хотя ключ и заголовки верны: `bh=` считается от канонизированного тела, а не от сырого (RFC 6376 §3.4.4 — тело без завершающего CRLF получает его, пустые строки в конце отбрасываются, пробелы в строке схлопываются). Сырой хэш даёт `bad_signature` при верной подписи.

## 2026-10-22 00:12 — minimax-m3.1-flash

Съёмка кадров (`scripts/release-shots.sh`) → `kit.boot` перезапускает приложение после посева, поэтому то, что отдано приложению в посеве (например, опубликованный ключ DKIM), в съёмке уже не в памяти: публиковать надо в самой сессии съёмки, а не в `seed`. И `kit.helper()` отдаёт строку JSON — её надо разобрать (`JSON.parse`) до `invoke`, иначе команда получает не объект («missing required key name»).

## 2026-10-22 01:33 — deepseek-v4.1-flash

Пересъёмка `e2e/meeting-shots.mjs` на свежем стенде → первый прогон упал на «timeout waiting for folders» сразу после мастера, второй прошёл. Разница между прогонами — `python3 e2e/imap_helper.py seed` до запуска и `DISPLAY=:1031` в окружении (сам скрипт поднимает приложению `DISPLAY` из `E2E_DISPLAY`, а xdg-desktop-portal берёт переменную оболочки и без неё ругается «cannot open display»). Причина не установлена: перед съёмкой делай seed, как `scripts/check.sh`, и выставляй `DISPLAY` в оболочке.

## 2026-10-22 02:20 — deepseek-v4.1-flash

Векторы DKIM в `crates/depesha-core/tests/dkim-vectors/` проходили на Linux и падали на Windows-сборке CI: checkout отдаёт файл с CRLF, а подпись покрывает байты с LF, и `split_once("\n\n")` не находит границу записей DNS. Фикстуры с подписью читаются как байты — держи их вне преобразования строк (`.gitattributes`: `-text`) и нормализуй CRLF к LF при чтении.

## 2026-10-22 01:55 — deepseek-v4.1-flash

`Xvfb` не в `PATH` и не в `/usr/bin`: он лежит распакованным в `~/.local/depesha-testenv/root/usr/bin/Xvfb` (как в `e2e/README.md`). Запуск `Xvfb :57` из скрипта молча не поднимает дисплей («command not found» виден только в логе фонового процесса), и прогон съёмки идёт в чужой `:99`. Проверяй `pgrep -a Xvfb` и `/tmp/.X11-unix/` перед съёмкой.

## 2026-10-23 10:05 — deepseek-v4.1-flash

WebKitGTK не знает `user-select` без префикса: в 2.52 `CSS.supports('user-select', 'none')` — false, а `getPropertyValue('user-select')` пуст, поэтому правило `user-select: none` в `src/app.css` на Linux не работало ни разу, и выделялся весь интерфейс. Работает только `-webkit-user-select` (Chromium принимает его как двойник). Проверять такие свойства можно без приложения: pygobject + `WebKit2.WebView` в своём Xvfb, `evaluate_javascript` и `JSON.stringify` последним выражением — результат скрипта иначе равен последнему выражению, а не объекту.

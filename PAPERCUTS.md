# Papercuts

## 2026-10-03 01:20 — claude-opus-5-5

Сборка фронтенда → `svelte-check` 4.7 не принимает TypeScript 7 (peer `^5 || ^6`), `npm install` падает с ERESOLVE. Fix: держать `typescript@5`.

## 2026-10-03 01:25 — claude-opus-5-5

Отправка → `lettre` не ставит `Message-ID`, пока не вызвать `.message_id(...)`; без него ломается защита от дублей в «Отправленных». Fix: генерировать Message-ID самим в `smtp::build`.

## 2026-10-03 01:35 — claude-opus-5-5

E2E-хелпер на Python → GreenMail отвечает `BAD Search command not supported` на `UID SEARCH CHARSET UTF-8`. Fix: сравнивать декодированные темы на стороне клиента (`e2e/imap_helper.py`).

## 2026-10-03 01:40 — claude-opus-5-5

Показ внешних картинок → WebKitGTK не перезагружает iframe при смене атрибута `srcdoc`, документ остаётся старым. Fix: `{#key}` вокруг `MailFrame`, iframe пересоздаётся.

## 2026-10-03 01:45 — claude-opus-5-5

Ошибки входа IMAP → `async-imap` отдаёт NO/BAD строкой `code: None, info: Some("...")`, пользователю это показывать нельзя. Fix: `imap::server_text` вытаскивает текст сервера.

## 2026-10-03 01:50 — claude-opus-5-5

Проверка «≤ 3 соединений» через `ss` → каждое соединение к опубликованному порту Docker видно дважды: клиент → 127.0.0.1 и docker-proxy → контейнер, у обоих dport 3143. Fix: считать только peer `127.0.0.1:<порт>`.

## 2026-10-03 01:55 — claude-opus-5-5

`tauri build` → `"category": "Office"` не входит в список Tauri (`invalid category`), а кириллический `productName` даёт пакет `Package: депеша`, который dpkg не установит. Fix: `Productivity`, `productName: Depesha`, русское имя — через свой `desktopTemplate`.

## 2026-10-03 02:40 — claude-opus-5-5

Нагрузочный тест на 50 000 писем → APPEND в Dovecot ~30 мс на письмо (fsync), полчаса на ящик; а Maildir, подложенный в `mail/cur`, Dovecot 2.4 не видит: ящики лежат в каталогах с GUID. Fix: `scripts/perf-fill.py` готовит Maildir и делает `doveadm import`, 15 с.

## 2026-10-03 03:10 — claude-opus-5-5

E2E-ввод в textarea → WebKitWebDriver по спецификации ставит курсор в конец поля и молча выбрасывает `\n` из набираемого текста. Fix: Enter как ``, вставка в начало через `execCommand('insertText')`.

## 2026-10-03 03:45 — claude-opus-5-5

`gh run watch` релиза → «error connecting to api.github.com» посреди ожидания, код выхода 1 при живом прогоне. Fix: перепроверять статус `gh run view` с повторами, а не верить коду выхода watch.

## 2026-10-03 05:20 — claude-opus-5-5

Список цепочек через `GROUP BY` с «голыми» колонками → SQLite берёт их из строки с MAX, только если в запросе один MIN/MAX; второй `MAX(flagged)` молча сделал выбор строки произвольным, поймал юнит-тест. Fix: остальные агрегаты через SUM.

## 2026-10-03 05:25 — claude-opus-5-5

Повторный `scripts/perf-fill.py` → в ящике 100 000 писем вместо 50 000: у образа dovecot `/srv/vmail` в анонимном томе, `docker compose up --force-recreate` его сохраняет; а `rm` в образе нет. Fix: скрипт делает `doveadm expunge` перед импортом и берёт уникальный каталог импорта.

## 2026-10-03 06:15 — claude-opus-5-5

E2E по окну настроек → WebKitWebDriver не прокручивает вложенный контейнер с overflow, клик и clear по элементу ниже видимой части окна дают «element not interactable», а дальше каскад «click intercepted» на всех шагах. Fix: `Driver.reveal()` (scrollIntoView) внутри click/clear/type.

## 2026-10-03 06:20 — claude-opus-5-5

Автообновление → у tauri-action v1 параметр называется `uploadUpdaterJson` (не `includeUpdaterJson`), а в `latest.json` из черновика ссылки ведут на API-адреса ассетов: они работают только с `Accept: application/octet-stream`, который плагин updater ставит сам. Проверять скачиванием с этим заголовком.

## 2026-10-03 07:40 — claude-opus-5-5

OAuth/EWS в рабочем дереве main, параллельно другой агент → его коммит `3f2b006` (git add -A) забрал чужие незаконченные файлы ядра (oauth.rs, http.rs, account.rs) и ушёл в origin. Параллельным агентам лучше работать в отдельных worktree или коммитить только свои пути.

## 2026-10-03 07:50 — claude-opus-5-5

Вход IMAP через SASL PLAIN → у `async_imap::Client` (до входа) нет `capabilities()`, а `run_command` закрыт (`pub(crate)`), так что `AUTH=` до логина не прочитать напрямую. Fix: `run_command_and_check_ok("CAPABILITY", Some(tx))` и разбор `UnsolicitedResponse::Other` из канала.

## 2026-10-03 08:06 — claude-opus-5-5

Остановка фонового vite через `pkill -f 'vite --port 5321'; rm -f …` в одной команде → pkill совпал с командной строкой самой оболочки и убил её, `rm` не выполнился. Fix: останавливать по PID (`pgrep -f 'node .*vite --port 5321'`) или запускать pkill отдельной командой. Заодно: `browser.capture` сразу после открытия модалки дал чёрный кадр — повторный захват спустя секунду нормальный.

## 2026-10-03 08:15 — claude-opus-5-5

Сравнение вариантов логотипа во встроенном браузере → `browser.scroll` дважды не ответил за 20 с, а после пересборки SVG браузер показывал старые картинки из кэша. ImageMagick (`magick file.svg`) теряет обводки с `fill="none"` и обрезает `rotate`. Fix: к `src` картинок добавлять `?<timestamp>`, снимать элементы через `playwright.browser_take_screenshot` (обязателен `scale: "css"`, путь только внутри проекта). И снова: `pgrep -f "http.server 5399" | xargs kill` убил собственную оболочку — шаблон совпал с её командной строкой.

## 2026-10-03 — claude-opus-5-5

Проверка `design/logo/seal.svg` растеризацией → `magick seal.svg out.png` молча теряет обводку дуги (`A` в path), кольцо «@» пропадает и выглядит как баг логотипа. Растеризовать SVG логотипа только через `npx tauri icon` (resvg), и запускать его из корня проекта: из `/tmp` npx не находит tauri, а с `>/dev/null` это не видно.

## 2026-10-03 09:30 — claude-opus-5-5

Базовый e2e-прогон из `git worktree` в /tmp → `docker compose` взял имя проекта по каталогу (`depesha-base`) и упёрся в занятый порт 3025, а отдельный `CARGO_TARGET_DIR` в /tmp (tmpfs 7 ГБ) кончился на сборке tokio. Запускать compose с `-p depesha` или из основного каталога и делить `target/` основного репозитория.

## 2026-10-03 10:25 — claude-opus-5-5

Коммит правки CHANGELOG.md, пока в той же рабочей копии работает другая сессия → `git add CHANGELOG.md` забрал и её незакоммиченный раздел «Unreleased», он ушёл в push. Перед `git add` общего файла смотреть `git diff <file>`, а свою строку добавлять через `git add -p` или собирать индекс из `HEAD:<file>` плюс своя правка.

## 2026-10-03 10:45 — claude-opus-5-5

Контекстное меню списка писем → пункт меню закрывал меню (`menu = null` в родителе), а потом читал проп `ids`; в Svelte 5 проп — геттер родительского выражения `menu.ids`, и он упал с `null is not an object`, без видимой ошибки в UI. Fix: в компонентах, которые живут «один раз» (`{#key}`) и закрываются через родительский state, снимать пропы при монтировании через `untrack(() => …)`. Нашлось только перехватом `window.onerror` из e2e: сам WebDriver ошибок страницы не показывает.

## 2026-10-03 10:50 — claude-opus-5-5

Правка `commands.rs` через edit по тексту, который я сам вставил минутой раньше → не нашлась: между ними прошёл `cargo fmt` и переносил длинный `CmdError::new(...)`. После `cargo fmt` перечитывать фрагмент перед повторной правкой.

## 2026-10-03 11:40 — claude-opus-5-5

Разбивка смешанных правок на коммиты своим скриптом (`git diff -U0` → блоки → `update-index --cacheinfo`) → после первого коммита блоки считались от сдвинувшегося HEAD и не сходились. Базу брать фиксированным хэшем, а не `HEAD`; смешанные блоки резать построчно, а каждый промежуточный коммит прогонять `cargo check` + `svelte-check` в отдельном worktree — иначе два коммита из десяти не собирались.

## 2026-10-03 11:35 — claude-opus-5-5

Закоммитил и запушил правку другой сессии (`http.rs`, ошибка 411), проверив только её тест → CI на main упал на `cargo fmt --check`: та сессия не прогоняла форматирование. Чужие незакоммиченные правки перед коммитом прогонять через `cargo fmt --all --check` (а лучше весь `scripts/check.sh`), а не только через их собственный тест.

## 2026-10-03 12:35 — claude-opus-5-5

Скачивал логотип Google для кнопки входа из официального `signin-assets.zip` (брендбук Sign in with Google) → там только кнопки целиком, а «G» в них — экспорт из Figma с конусным градиентом через `foreignObject` и JSON в `fill`; ImageMagick рисует его сиреневым, на WebKitGTK тоже ненадёжно. Брать плоский четырёхцветный `Google_"G"_logo.svg` с Wikimedia Commons.

## 2026-10-03 12:49 — claude-opus-5-5

Гонял `e2e/run.mjs` с новым шагом просмотрщика → шаг упал при открытом полноэкранном слое, и все следующие ~40 шагов посыпались с `element click intercepted`, хотя были ни при чём. У `step()` нет уборки после провала: стоит закрывать слои (Esc / закрыть `.viewer`, `.modal`) в `catch` шага, чтобы один провал не валил весь прогон.

Пересоздавал GreenMail через `docker compose -f compose.test.yaml up -d --force-recreate` для e2e → контейнеры общие на машину, параллельная сессия, гоняющая свои тесты, теряет ящики посреди прогона. Перед пересозданием смотреть `pgrep -af "e2e/run.mjs|tauri-driver"`; лучше вынести project name (`-p depesha-$SESSION`) и порты в переменные.

## 2026-10-05 08:20 — claude-opus-5-5

Прогон e2e (`node e2e/run.mjs`) → мастер не сохраняет пароль: связка ключей пользователя заблокирована («SS error: prompt dismissed»), и все шаги после входа падают каскадом. `gnome-keyring-daemon --unlock` в `dbus-run-session` не создаёт коллекцию по умолчанию («result not returned from SS API»); работает `--login` с паролем-пустышкой и затем `--start --components=secrets`. Рецепт записан в e2e/README.md.

## 2026-10-05 12:40 — claude-opus-5-5

Писал e2e-шаг, который пишет счётчик «Входящих» через `MutationObserver` сразу после `invoke("set_flag")` → шаг ловил ложный «рост счётчика»: боковая панель перечитывает папки с задержкой (`scheduleFolders`), и первое обновление от моей же подготовки приходило уже во время записи. Перед записью ждать, пока счётчик в панели совпадёт с числом из `invoke("messages", { unread_only: true })`.

## 2026-10-05 13:05 — claude-opus-5-5

Разбивал правки на коммиты: фрагменты `git diff -U0` в индекс через `git apply --cached --unidiff-zero`, промежуточный коммит проверял через `git stash push --keep-index` + `stash pop` → `stash pop` слил версию индекса с рабочей, и вставленный блок e2e-шага задвоился в рабочем файле, а следующий `git add -A` унёс дубль в коммит. Промежуточные коммиты проверять в отдельном `git worktree`, а не через stash; после разбивки сверять `git diff HEAD` с ожидаемым.

## 2026-10-05 17:30 — claude-opus-5-5

Параллельная работа сабагентов в git worktree → новый worktree начинает с пустого `target/`, и каждая ветка собирает все зависимости с нуля (десятки минут, три сборки душат 14 ГБ памяти). Fix: при создании worktree `cp -a --reflink=auto <прогретый>/target <wt>/target` — на ZFS с block cloning это секунды и почти ноль места.

## 2026-10-05 17:30 — claude-opus-5-5

`scripts/check.sh` из worktree (`../depesha-wt/verify`) → docker compose берёт имя проекта из имени каталога, создаёт `verify-*` и падает на занятых портах 3143/31143; шаг E2E 3.6 сам зовёт `docker compose` и падает так же. Fix: `name: depesha` в `compose.test.yaml` (делается в ветке fix/e2e-consent) или `export COMPOSE_PROJECT_NAME=depesha`.

## 2026-10-05 17:30 — claude-opus-5-5

`git -C depesha worktree add depesha-wt/verify` → относительный путь считается от `-C`, worktree создался внутри основного checkout. Fix: в `worktree add` всегда абсолютный путь.

## 2026-10-05 17:58 — claude-opus-5-5

Снимал скриншоты HTML-макета через chrome-headless-shell из ~/.cache/ms-playwright → без флага `--no-sandbox` процесс падает с «Ловушка трассировки/останова» (SIGTRAP) и не пишет PNG, а при `2>/dev/null` причины не видно. Запускать с `--no-sandbox`.

## 2026-10-05 18:03 — claude-opus-5-5

Нужно было вложить скриншоты в issue → решил по старой памяти, что gh не умеет загружать картинки, и отдал это пользователю. С gh 2.99 есть `--attach` у `gh issue/pr create|edit|comment`; ссылки `![alt](./file.png)` в теле переписываются на загруженные файлы. Сначала смотреть `gh <cmd> --help`. Анонимный `curl` на `github.com/user-attachments/...` даёт 404 — это нормально, проверять через `body_html` (подписанные `private-user-images`).

## 2026-10-05 22:40 — deepseek-v4.1-flash

`git add -A` в worktree с симлинком `node_modules` → правило `.gitignore` `node_modules/` (с косой чертой) ловит только папку, не симлинк, поэтому ссылка попала в коммит и после слияния заменила реальную папку (FilesystemLoop). Fix: `node_modules` без косой черты; перед коммитом смотреть `git diff --cached --stat`, а не `add -A` вслепую.

## 2026-10-05 23:14 — deepseek-v4.1-flash

`npm install --save-dev eslint` в worktree `depesha-wt/issue-48` → npm заменил симлинк `node_modules` на реальную папку в worktree, из-за чего пакеты задваиваются с main-чекаутом, а `npm run lint` из главного дерева не увидел линтер. Причина: npm не «дописывает» симлинкнутый node_modules, а reify-ит его как обычный каталог. Лучше сначала `npm install` в main-чекауте, а worktree-пакетам дать увидеть общий `node_modules` через симлинк (пересоздать после установки), либо ставить пакеты вне worktree.

## 2026-10-05 23:14 — deepseek-v4.1-flash

`npm install --save-dev @eslint/js` взял `@eslint/js@10` (peer eslint ^10) при установленном eslint 9 → ERESOLVE. Ставить с тегом мажора: `@eslint/js@^9`.

## 2026-10-06 13:45 — claude-opus-5-5

Своя ручка высоты в `QuickReply.svelte` → `$state` не компилировался: проп компонента называется `state`, и Svelte читает `$state` как подписку на стор `state`. Обход: переименовать проп при деструктуризации (`state: answer`).

## 2026-10-06 13:45 — claude-opus-5-5

Обёртка поля быстрого ответа с классом `.field` → заданная высота textarea игнорировалась: глобальный `.field` в `src/app.css` — колонка flex, и `flex: 1` у textarea перебивал `height`. Scoped-класс Svelte не изолирует от глобального с тем же именем; для обёрток брать имена, которых нет в `app.css`.

## 2026-10-06 11:35 — claude-opus-5-5

Снимал кадры макета через `tools.playwright.browser_take_screenshot` с `element`/`target` → вызов падает с «scale: Missing key», хотя в описании параметр выглядит необязательным. Передавать `scale: "css"` (и `type: "png"`) явно.

## 2026-10-07 12:13 — deepseek-v4.1-flash

Работал над плагином account-color в общем рабочем дереве `/home/vch/Projects/depesha` → параллельная сессия в те же минуты правила 19 чужих файлов (crates/, src/lib/signatures.ts, store.test.ts, локали, baseline-и). `git status` показывал их как мои, число тестов скакало 323→328, инварианты «дрейфовали» по чужому ключу. Перед проверкой слайса сверять `git diff --name-only` со своим списком файлов и не перезаписывать чужие baseline без нужды; для изоляции — worktree.

## 2026-10-07 12:45 — claude-opus-5-5

Прототип CodeMirror для #45: останавливал фоновый процесс через `pkill -f <шаблон>` → шаблон совпал с командной строкой самого вызывающего shell, и тот был убит. Убивать по PID (`$!`, сохранённому при запуске) или использовать `pgrep -f … | grep -v $$`.

## 2026-10-07 12:45 — claude-opus-5-5

Хотел проверить CodeMirror в настоящем WebKitGTK без Tauri → WebKitGTK 2.52 под GDK_BACKEND=broadway (python-gi WebView) без GPU страницы не грузит даже без песочницы, а WebKit для Playwright не установлен. Проверку поведения в WebKitGTK делать вручную через `npm run tauri dev`.

## 2026-10-07 12:50 — claude-opus-5-5

Читал issue для макетов 0.7 через `gh issue view N --comments` → в этом окружении команда молча печатает пустоту и завершается с кодом 0. Работает `gh issue view N --json title,body,comments`; в промптах субагентам давать именно эту форму.

## 2026-10-07 — claude-opus-5-5

Поднимал http.server для просмотра макета на 8797 → порт уже занят чужим python-сервером, отдававшим другой каталог; curl вернул 404, а не ошибку соединения. Перед проверкой смотреть лог запуска (`Address already in use`) или `ss -ltnp`, брать случайный свободный порт.

## 2026-10-07 15:55 — claude-opus-5-5

Ставил CodeMirror в worktree #45 → `@codemirror/language@6.13.0` (свежий latest) импортирует `@codemirror/streamparser`, но не объявляет его в зависимостях: vitest падает с «Cannot find package». Закреплён `6.12.4`; перед обновлением проверять `npm ls` и запуск тестов, а не только установку.

## 2026-10-07 15:55 — claude-opus-5-5

Нужны были новые npm-пакеты в worktree, а основное дерево трогать нельзя → вместо симлинка на общий `node_modules` скопировал его `cp -a --reflink=auto <основной>/node_modules <wt>/node_modules` (меньше секунды на ZFS) и ставил пакеты туда: общий `node_modules` не меняется, `.gitignore` (`node_modules` без косой черты) папку не пускает в коммит.

## 2026-10-07 15:55 — claude-opus-5-5

Проверял редактор на contenteditable (CodeMirror) встроенным браузером OpenChamber → `browser.click` по тексту внутри редактора отвечает «No clickable element», а `browser.capture` и логи Playwright MCP пишутся в `.openchamber/screenshots` и `.playwright-mcp` основного checkout, даже когда работа идёт в worktree. Для редактора брать `tools.playwright.browser_run_code_unsafe` (клавиатура, `page.evaluate`, скриншот в /tmp), а свои файлы из основного дерева потом убирать.

## 2026-10-07 16:10 — claude-opus-5-5

e2e-проверка подсветки подписи на прокрученном письме → в новом письме подпись стоит последней, и прокрутка упирается в конец, не пряча её верх под шапку; первый прогон выглядел как «вставка строк не сработала». Чтобы прокрутить блок под шапку, под ним тоже нужно содержимое (строки после подписи, как цитата ответа).

## 2026-10-07 16:10 — claude-opus-5-5

Хотел поставить каретку в конец `.rich` через `range.setStart(el, el.childNodes.length)` и `execCommand('insertHTML')` → WebKitGTK переносит вставку перед заблокированным (`contenteditable=false`) блоком подписи, и строки оказываются над ней. Для e2e надёжнее `insertAdjacentHTML('beforeend', …)` и событие `input`.

## 2026-10-07 17:45 — claude-opus-5-5

Убрал из `App.svelte` старый `onKey` (#46) → `npx eslint .` стал падать с кодом 2 без единой ошибки, только «There are suppressions left that do not occur anymore»: в `eslint-suppressions.json` осталось подавление для исчезнувшего нарушения. Fix: `npx eslint . --prune-suppressions` и смотреть diff файла подавлений — он общий для веток.

## 2026-10-07 17:45 — claude-opus-5-5

Класс-композабл со `$derived(this.draft()...)` в полях и `constructor(private draft: …)` → svelte-check: «Property 'draft' is used before its initialization», хотя `$derived` ленивый. Параметр-свойство присваивается после инициализаторов полей. Обход: читать такие источники через геттер (`get custom() { return this.draft()… }`), а в `$derived` звать геттер.

## 2026-10-07 18:05 — claude-opus-5-5

Выносил новые Tauri-команды #59 в свой модуль `src-tauri/src/waiting.rs` → тест `acl_matches_the_commands` берёт из `generate_handler!` только строки с префиксом `commands::`, а `pub use` чужой команды не переносит скрытый `__cmd__…` макроса. Команды держать тонкими обёртками в `commands.rs` (плюс `build.rs` и обе `capabilities/*.json`), логику — в модуле.

## 2026-10-07 18:10 — claude-opus-5-5

Хотел проверить Windows-код трея и уведомлений через `cargo clippy --target x86_64-pc-windows-msvc -p depesha` → падает сборочный скрипт `ring` («GNU compiler is not supported for this target»): без MSVC C-кода не собрать, а `ring` тянет ядро. Обход: мини-крейт в /tmp только с `tauri`, `tauri-winrt-notification`, `windows` и копией Windows-модуля — он проверяется под msvc-целью без C-компилятора.

## 2026-10-07 18:10 — claude-opus-5-5

Живая проверка уведомлений на своём пользователе GreenMail (`traycheck@local.test`, создаётся доставкой по SMTP) → через пару минут вход ломается: соседняя сессия делает `docker compose … --force-recreate`, и автосозданные пользователи пропадают. Перед каждой проверкой заново доставлять письмо (это снова создаёт пользователя), а не считать ящик постоянным.

## 2026-10-07 18:10 — claude-opus-5-5

Проверял видимость окна на Xvfb через ctypes `XGetWindowAttributes` → структура `XWindowAttributes` описана неточно, `map_state` читался мусором и показывал «hidden» у видимого окна. Надёжнее снимок: `DISPLAY=:N import -window root shot.png` (ImageMagick есть в системе).

## 2026-10-07 18:20 — deepseek-v4.1-flash

Разбивал правку на `test:` и `fix:` коммиты: `git stash` (спрятать рабочую копию) → `git apply --cached` тестовой части → коммит → `git stash pop` упёрся в уже закоммиченные те же строки, а `git stash drop` забрал вместе с конфликтом и незакоммиченные правки фронтенда. Fix: перед `stash drop` смотреть `git stash show -p`, а лучше не прятать всю копию — собирать патчи из `git diff` по файлу и `git apply --cached --recount` (обычный `git apply --cached` падал на «патч повреждён» из-за неточных номеров строк).

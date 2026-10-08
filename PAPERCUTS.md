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

## 2026-10-07 18:53 — deepseek-v4.1-flash

Слияние готовых веток в main → через минуту после `git merge --ff-only` `scripts/check.sh --fast` упал в vitest: «Cannot find module MailFrame.test.ts / lockedBlock.test.ts», а `git status` показал рабочее дерево, откатанное ровно к прежнему HEAD по файлам слитых веток. Причина: в основном дереве /home/vch/Projects/depesha параллельно работает ещё одна сессия claude (PID с `--resume`), и её проверка/`git checkout` вернула файлы. Fix: после каждого слияния и перед проверкой сверять `git status` с ожидаемым и восстанавливать `git checkout -- .` (HEAD цел), а лучше сливать в отдельном worktree.

## 2026-10-07 19:40 — deepseek-v4.1-flash

Запустил e2e из worktree `depesha-wt/prefs` → `tauri-driver` не поднялся: «Unable to listen for HTTP server at 127.0.0.1 and port 4445», «Maximum number of active sessions». Порт 4444 был занят чужим драйвером (в `pgrep` его в тот момент не было), а на второй попытке мой же `tauri-driver` висел от прошлого прогона, оборванного по `| tail`. Fix: перед прогоном проверять `ss -ltnp | grep 4444` и убивать свои осиротевшие `tauri-driver`/`WebKitWebDriver` по PID; прогон из worktree не отдавать в `| tail` — он буферизует и прячет прогресс до самого конца.

## 2026-10-07 19:40 — deepseek-v4.1-flash

Правил `Preferences.svelte` под #68 в worktree → `scripts/frontend-metrics.sh` и `frontend-invariants.sh` сообщают «РОСТ»/«ДРЕЙФ» не из-за ошибки: новые функции и новые ключи `t()` законно меняют baseline, а `check.sh --fast` из-за них не доходит до конца. Fix: после осознанной правки обновлять baseline (`frontend-metrics.sh --save`, `frontend-invariants.sh --save`, `frontend-bundle.sh --save`) и только тогда сверяться; «РОСТ» в выводе — не регрессия.

## 2026-10-07 20:05 — deepseek-v4.1-flash

Читал NAMESPACE через async-imap (RFC 2342) → `Response::parse` из imap-proto 0.17 не знает этого ответа и возвращает `Err(TakeWhile1)`; в `Client::run_command`+`read_response` незапарсенная строка валит соединение `io::Error` («TakeWhile1 during parsing»). Fix: команду писать через `run_command` (тег библиотеки), а ответ дочитывать сырыми байтами из `session.get_mut()` до строки с тегом и разбирать своей регуляркой; MYRIGHTS/ACL/PERMANENTFLAGS, наоборот, imap-proto разбирает штатно.

## 2026-10-07 20:05 — deepseek-v4.1-flash

Проверял `PERMANENTFLAGS` у Dovecot тестового стенда → `EXAMINE` отдаёт `[PERMANENTFLAGS ()]` (папка read-only), а `SELECT` — полный список с `\*`. Fix: свойства папки читать через SELECT, не EXAMINE, иначе свои метки всегда выглядят запрещёнными.

## 2026-10-07 20:20 — deepseek-v4.1-flash

Замерял рост главного чанка из worktree #45 → чтобы снять свои правки и собрать baseline, сделал `git stash push -u`, собрал, `git stash pop`; pop дал конфликт в baseline-файлах, я разрешил его через `git checkout HEAD -- <файлы>` и потерял собственные незакоммиченные правки (они лежали в том же stash и в рабочем дереве). Восстановил через `git stash apply` — stash после конфликтного pop не удаляется сам. Fix: для временного отката собирать патч по своим файлам (`git diff > /tmp/x.patch`), а не прятать всю копию; после конфликтного `stash pop` не делать `checkout HEAD` по конфликтным путям, а разрешать их вручную и сразу `git stash drop` отдельной командой.

## 2026-10-07 20:20 — deepseek-v4.1-flash

Отлаживал виджет таблицы CodeMirror в прогоне e2e → `pgrep -f 'node .*vite --port 5310' | xargs kill` снова совпал с командной строкой собственной оболочки и убил её (SIGTERM), `rm public/md-harness.html` не выполнился. Fix: убивать по PID из `ss -ltnp`, а не по шаблону `pgrep -f`; временные файлы удалять отдельной командой заранее.


## 2026-10-07 20:35 — deepseek-v4.1-flash

Создавал worktree для #66/#44/#69 → `cp -a --reflink=auto ../../depesha-wt/prefs/target ./target` (46 ГБ) шёл 24 с, но места на диске занял все 46 ГБ: на ZFS блок-клонирование не сработало между каталогами, свободное место упало 109→103 ГБ. Fix: сверить `df -h` до и после копирования; при нехватке места делиться `CARGO_TARGET_DIR` основного дерева (cargo сам сериализует сборки локом), а не копировать `target` целиком.

## 2026-10-07 20:40 — deepseek-v4.1-flash

Добавлял Tauri-команды `people`/`hint_save` в src-tauri → одна и та же команда перечисляется в четырёх местах: `build.rs::COMMANDS`, `generate_handler!` в `lib.rs`, `capabilities/main.json` и `capabilities/message.json`; тест `acl_matches_the_commands` требует, чтобы `main.json` совпадал с набором команд ровно, а ошибка всплывает только на `cargo test`, не на `cargo check`. Fix: заводить команду сразу во всех четырёх местах и прогонять `cargo test -p depesha --lib acl_matches_the_commands`.

## 2026-10-07 20:45 — deepseek-v4.1-flash

Проверял в тесте smtp сборку Markdown-письма с подписью → `assert!(raw.contains("<cid>"))` падал: quoted-printable (a) рвёт длинные строки мягким переносом `=\r\n` прямо посреди `cid:66e4…`, (b) сам `=` пишет как `=3D`, поэтому в HTML-части стоит `src=3D"cid:…"`. Fix: проверять тело части после `raw.replace("=\r\n", "")` и `replace("=3D", "=")`, либо брать декодированный `parse_view`, а не сырой вывод `build().formatted()`.

## 2026-10-07 20:46 — deepseek-v4.1-flash

`git add -A ':!node_modules' ':!target'` в worktree с копиями `node_modules` и `target` → команда завершилась кодом 1 с «The following paths are ignored…», ничего не добавив. Fix: перечислять свои пути явно (`git add <файлы>`), как и советует запись про симлинк node_modules от 2026-10-05.

## 2026-10-07 20:55 — deepseek-v4.1-flash

Добавлял ACL-плагин в тестовый Dovecot (compose.test.yaml, worktree) → MYRIGHTS то работает, то «Unknown command»: параллельная сессия из `/home/vch/Projects/depesha-wt/people` гоняет e2e и на `docker compose up` пересоздаёт общий контейнер `depesha-dovecot-1` из СВОЕГО compose-файла, без моих `depends_on`/томов/конфига. Fix: интеграционные тесты, зависящие от конфига стенда, делать терпимыми к его отсутствию (`let Some(..) = rights else { return }`), а конфиг прогонять `--force-recreate dovecot` прямо перед своим прогоном; e2e-прогон другой сессии держится на GreenMail (3143), поэтому пересоздание только dovecot её не ломает.

## 2026-10-07 20:55 — deepseek-v4.1-flash

Включал ACL в образе dovecot/dovecot → одних `mail_plugins { acl = yes }` и `protocol imap { mail_plugins { imap_acl = yes } }` мало: MYRIGHTS отвечает `NO [NONEXISTENT]` или Internal error. Нужен ещё `acl_driver = vfile`; без него плагин загружен, но «ACL not enabled». Публичный namespace в 2.4 описывается через `type = public`, `prefix`, `separator` и `mail_driver`/`mail_path` (старого `location` нет); `mailbox_list_layout = fs` даёт простые имена папок без Maildir++ точки. Права в `dovecot-acl` — словами (`anyone lookup read`), не буквами (`lr` даёт «Unknown ACL 'o'»).

## 2026-10-07 21:10 — deepseek-v4.1-flash

Проверял в e2e, что Enter на кнопке в фокусе запускает действие → хелпер `press("Enter")` в `e2e/run.mjs` шлёт синтетический `KeyboardEvent` на `window`, а браузер на синтетические события не выполняет default action, поэтому фокусная кнопка не нажимается и `until` упирается в таймаут. Fix: нажимать клавишу настоящим событием — `Driver.pressKey` через W3C Actions `/actions` (keyDown/keyUp), либо `sendKeys` по элементу.

## 2026-10-07 21:12 — deepseek-v4.1-flash

Карточка человека в e2e → фокус не вставал на первую кнопку: `Popover.svelte` в своём `$effect` считает `pos` и сразу зовёт `first.focus()`, но `.pop` на этот момент ещё имеет `visibility:hidden` (стиль применится только следующим тиком), а скрытый элемент не фокусируется. Fix: фокусировать через `requestAnimationFrame` после того, как позиция применена (сделано в `PersonCard`; общий фокус в `Popover` по-прежнему может не срабатывать на первом открытии).

## 2026-10-07 21:14 — deepseek-v4.1-flash

Прогон e2e из worktree с общими контейнерами `depesha-*` → контейнеры подняты, но живого `run.mjs`/`WebKitWebDriver` нет (`pgrep` пуст), то есть это остатки чужого/прошлого прогона; шаг 3.7 один раз упал на `imap_helper.py ... socket error: EOF` (GreenMail), при повторном прогоне 80/80. Fix: считать контейнеры занятыми по наличию живого `run.mjs`/драйвера, а не по факту `docker ps`; одиночные EOF хелпера к GreenMail проверять повторным прогоном, а не искать причину в правках.

## 2026-10-08 02:04 — deepseek-v4.1-flash

Снимал кадры к релизу 0.7.0 (`scripts/release-shots.sh`) с русскими именами файлов (`01-фон-и-запуск.png`) → при загрузке картинок к релизу на GitHub кириллица из имён вырезается, остаются точки: `01-.-.-.png`, и ссылки в описании приходится переписывать на уже загруженные имена. Fix: имена кадров к релизу — только латиница (`01-background.png`), тогда GitHub сохраняет их как есть.

## 2026-10-08 07:30 — deepseek-v4.1-flash

Писал в санитайзере нормализацию URL `value.replace(/[\u0000-\u0020\\]/g, …)` → eslint `no-control-regex` роняет `check.sh --fast`. Fix: заменить регэксп на цикл по символам (`codePointAt`), тогда управляющие символы фильтруются без литералов в паттерне.

## 2026-10-08 08:15 — deepseek-v4.1-flash

Копировал `target` из основного чекаута в новый worktree (`cp -a --reflink=auto target ./target`) → reflink между каталогами одного ZFS-датасета (`rpool/USERDATA/home_0gjn2n`) не сработал: `df` до/после показал рост «Использовано» на ~49 ГБ, то есть скопировалось целиком, вопреки записи от 2026-10-05. Fix: перед копированием сверять `df`; при нескольких параллельных worktree (48 ГБ × N) не копировать `target` целиком, а делить `CARGO_TARGET_DIR` основного дерева.

## 2026-10-08 07:38 — deepseek-v4.1-flash

Разбивал правки по находкам ревью на пару коммитов `test:` → `fix:` → тесты ссылаются на новые сигнатуры и поля (`missed(…, awake_since)`, `resolve(…, find_in)`, `OutboxItem.sending_started`), поэтому `test:`-коммит не собирается, и «сначала падает» превращается в красную сборку; а когда находки переплетены в одних файлах (background.rs, outbox.rs, desktop_notify.rs, store.rs), по файлам их не разделить. Fix: тест и правку, меняющую API, коммитить вместе (или заводить тест на существующем API), а `test:`/`fix:` делить только там, где тест собирается до правки.

## 2026-10-08 08:12 — deepseek-v4.1-flash

Запустил e2e из worktree fix-c на общем стенде → на середине прогона шаги 3.5/5.1/5.3 упали с `ConnectionRefused` на GreenMail (3143), прогон остановился на 35/39; `docker ps` показал `depesha-greenmail-1 Up 2 minutes` — параллельная сессия сделала `docker compose --force-recreate` прямо во время прогона. Fix: полный e2e на общем стенде запускать, только убедившись, что рядом нет живой параллельной сессии (или поднимать свой project name/порты), а падение e2e по `ConnectionRefused` к контейнеру не приписывать своим правкам.

## 2026-10-08 08:12 — deepseek-v4.1-flash

Ждал освобождения e2e-портов чужим фоновым циклом → `pgrep -af "e2e/run.mjs|WebKitWebDriver|tauri-driver"` показывает сам процесс-ожидатель (его командная строка содержит шаблон), а его условие `pgrep -f "e2e/run.mjs"` матчит себя же и висит вечно при свободных портах. Fix: в шаблонах ожидания исключать себя (`pgrep -f … | grep -v $$`) или проверять занятость через `ss -ltn`.

## 2026-10-08 09:15 — deepseek-v4.1-flash

Собирал `cargo test -p depesha --lib` из своего worktree с общим `CARGO_TARGET_DIR=/home/vch/Projects/depesha/target` (ветка с правками `depesha-core`) → cargo подхватил артефакт `depesha-core`, собранный параллельным агентом из другой ветки (без новых методов), и сборка упала с «no method named followup_reparked» и help-ссылкой на строки чужого файла, хотя `cargo check` в тот же момент проходил. Fix: перед сборкой `touch crates/depesha-core/src/lib.rs`, чтобы форсировать пересборку ядра из своего дерева; при расхождении ядра между параллельными worktree общий target опасен.

## 2026-10-08 08:48 — deepseek-v4.1-flash

Прогон `scripts/check.sh --fast` из worktree с общим `CARGO_TARGET_DIR` → clippy падал на `commands.rs` «expected Vec<String>, found integer»: `depesha-core` из общего target пересобирался параллельной веткой с другой сигнатурой, и `touch` ядра помогало лишь до следующей чужой сборки. Fix: не только `touch`, но и `CARGO_INCREMENTAL=0` (общий `target/debug/incremental` тоже делится между worktree) и `cargo clean -p depesha-core -p depesha` перед проверкой.

## 2026-10-08 09:20 — deepseek-v4.1-flash

Параллелил фоновую работу по ящикам в `src-tauri` через `futures::stream::buffer_unordered` → `futures` не в зависимостях `src-tauri` (есть только в `depesha-core`), `cargo check` упал на «unresolved module futures». Fix: без новой зависимости — `tokio::task::JoinSet` со `spawn` (нужен `Arc<AppState>` и `'static`-фьючеры) и общий помощник `run_bounded`, ограничивающий число задач сразу.

## 2026-10-08 09:08 — deepseek-v4.1-flash

Проверял страницу настроек «Люди» в браузере на vite dev-сервере без Tauri → приложение падает в `getCurrentWindow` и в `t()`: `@tauri-apps/api` v2 ждёт `window.__TAURI_INTERNALS__` с `metadata.currentWindow.label` и `transformCallback`, а язык читается командой `language` — без неё `dicts[i18n.lang]` undefined и весь UI в ошибках. Fix: мок `__TAURI_INTERNALS__` (metadata + invoke для settings_get/language/people/accounts) через `page.addInitScript`; иначе вкладка настроек не открывается из-за мастера при пустом списке ящиков.

## 2026-10-08 09:08 — deepseek-v4.1-flash

Поле поиска в меню настроек обрезало подсказку «Найти настройку» → `input[type=search]` в Chromium резервирует ~13 px под кнопку очистки, поэтому `scrollWidth` больше ширины текста, и `appearance: none` на самом поле это не убирает. Fix: ещё `::-webkit-search-cancel-button, ::-webkit-search-decoration { appearance: none }`.

## 2026-10-08 09:08 — deepseek-v4.1-flash

Гонял e2e из worktree дважды подряд → второй прогон без `docker compose --force-recreate` и `imap_helper.py seed` упал на 3.1–3.3/6.5/3.4 «timeout waiting for folders/row» (остатки пользователей и ящиков GreenMail). Fix: перед каждым прогоном пересоздавать стенд и сеять заново, как в `check.sh`. Заодно: в двух прогонах на чистом стенде падал ровно один РАЗНЫЙ шаг с «timeout waiting for row» (9.2, затем 3.6/3.8/5.4) — это флак отрисовки списка, не правка.

## 2026-10-08 09:54 — deepseek-v4.1-flash

Фронтендовая правка (метки #42) без единой строки Rust → `scripts/check.sh --fast` падает на «метрики фронтенда» (РОСТ компонентов/функций) и «инварианты фронтенда» (новые t-ключи, компонент, член `app.*`). Fix: после правки прогнать `scripts/frontend-metrics.sh --save docs/frontend-metrics-baseline.txt` и `scripts/frontend-invariants.sh --save`, иначе рост и дрейф считаются регрессией. Оба бейзлайна — общие для веток, при параллельных агентах их правки конфликтуют при слиянии.

## 2026-10-08 09:54 — deepseek-v4.1-flash

Нужен был e2e-прогон из своего worktree, но общий стенд (docker-порты 3143/31143 + WebKitWebDriver 4445) был занят по кругу параллельными агентами: ждал освобождения суммарно ~55 мин (`pgrep -f e2e/run.mjs`), но F и I запускали прогоны один за другим, каждый держит стенд 20–40 мин (`timeout 2400`). Fix: при нескольких параллельных агентах, гоняющих e2e, шанса на свободный стенд практически нет — либо поднимать свой project name/порты и править порты в `run.mjs`, либо оставить e2e невыполненным и опираться на `check.sh --fast` (он полностью зелёный). Ожидание в цикле не помогает: окно между прогонами меньше секунд.

## 2026-10-08 11:40 — deepseek-v4.1-flash

Писал e2e-шаг: сеял 60 писем и ждал `document.querySelectorAll('.list .row').length >= 40` → список виртуализирован, в DOM только видимые строки (~20), условие не выполнялось никогда, шаг падал по таймауту. Fix: считать письма через `invoke("messages", { query })`, а по DOM проверять лишь наличие строк.

## 2026-10-08 11:55 — deepseek-v4.1-flash

Мерил «до/после» на уровне приложения: `git checkout <base> -- crates src-tauri`, сборка, прогон e2e, затем `git checkout HEAD -- crates src-tauri` → файл, добавленный моими коммитами, но отсутствующий в base (`tests/move_burst.rs`), checkout не удаляет (он обновляет только существующие пути), поэтому «до»-сборка его сохраняла. Для теста это безвредно, но при откате к base нужно помнить, что новые файлы остаются.

## 2026-10-08 10:31 — deepseek-v4.1-flash

Делил правку на `test:` и `fix:`, но тесты ссылались на новую функцию (`parse_url`), без которой `test:`-коммит не собирается, а `cargo clippy --all-targets -D warnings` валит его на dead_code (`pub` в приватном модуле не спасает). `git add -p` ненадёжен на крупных хунках, поэтому разделил по платформе: сохранил финальный файл в /tmp, собрал «до»-версию скриптом (вернул старый `#[cfg(windows)]`-модуль, вырезал windows-тесты), закоммитил `test:`, затем вернул финальный файл и закоммитил `fix:`. Windows-код под `cfg` на Linux не компилируется, поэтому «до»-версия Linux-проверки проходит.

## 2026-10-08 12:05 — deepseek-v4.1-flash

Гонял e2e-шаг #42 из worktree → предсуществующий шаг 12.6 падал «timeout waiting for row "Счёт за октябрь"». Причина: шаг 3.6 делает `docker compose up -d --force-recreate`, а GreenMail держит письма в памяти, поэтому приёмочный seed (`imap_helper.py seed`) исчезает задолго до конца прогона. Fix: в начале шага, которому нужны сеяные письма, звать `helper("seed")` (GreenMail там уже свежий, повторный seed не падает). Заодно: значение оператора `метка:` не должно содержать пробелов и двоеточий — `stamp` в виде `HH:MM:SS` ломал токенизацию (`метка:Правка 07:51:50` распадалось на токены), а имена с пробелами нужно брать в кавычки (`метка:"Клиент Север"`); подсказка дописывает такие имена уже в кавычках.

## 2026-10-08 12:20 — deepseek-v4.1-flash

Сливал 0.7.1 и гонял полный `check.sh`: e2e падал на старте `session not created: Maximum number of active sessions`, а в `ss` были заняты 4444/4445 — по вводным ветки K/L «e2e не гоняют», но `fix-k` крутил `e2e/run.mjs` на общем стенде (и `docker compose --force-recreate` в моём прогоне сбрасывал ему GreenMail). Fix: перед прогоном проверять `pgrep -af "e2e/run.mjs"` (а не только `docker ps`), дождаться освобождения 4444/4445, свой стенд не поднимать поверх чужого.

## 2026-10-08 12:20 — deepseek-v4.1-flash

e2e-шаг 13.3 «важное наверху не прыгает под рукой» стабильно падал «прочитанное уехало», хотя pin (`ListQuery.pins`) работал. Причина: после `viewOption("Важное наверху")` список пересортировывается асинхронным `reload`, а `d.until("unread on top")` проверял только «верхняя строка непрочитана» — и ловил прежний порядок (дата), где верх тоже непрочитан; `first` брался из старого порядка, а после открытия список уже стоял по «важному». Fix: ждать, пока верхняя строка списка совпадёт с верхом, который отдаёт `invoke("messages", {query: {…, sort: важное, …}})` без pin'ов.

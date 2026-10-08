# Сквозной тест

`run.mjs` запускает настоящее приложение на виртуальном дисплее, управляет им по WebDriver и проходит сценарий приёмки против GreenMail. Каждый шаг помечен номером критерия из `docs/acceptance.md`. Скриншоты и `results.json` пишутся в `e2e/screens/`.

## Скриншоты для README

Кадры в `docs/screenshots/` снимаются не вручную, а сценарием `shots.mjs` — он делает всё то же, что и `run.mjs`, но показывает витрину, а не проверки. Демо-данные сеет `imap_helper.py demo-seed`: аккуратные письма, одна беседа из трёх писем, рассылка, черновик и два письма в «Отправленных», которые «ждут ответа»; адреса только на `example.com` / `example.org`, даты входящих фиксированы, поэтому кадры повторяемы. «Ждут ответа» заполняется прямо в кэше, минуя отправку, чтобы картинка не зависела от очереди исходящих.

Одна команда пересъёмки:

```
scripts/shots.sh
```

Она поднимает GreenMail, сеет демо-данные, собирает приложение (`--debug --no-bundle --features e2e`) и прогоняет `e2e/shots.mjs`, записывая кадры в `docs/screenshots/`. С `DEPESHA_APP=…` берётся уже собранный бинарник и сборка пропускается. Кадры: `main`, `compose`, `signatures`, `followups`, `narrow-list`, `narrow-message`, `snooze`, `preflight`, `dark`, `english`, `certificate`; русский интерфейс — у всех, кроме `english` (для английского README, светлая тема). Узкие кадры — окно 600×720, остальные — 1280×820. Продолжить снимок и оставить профиль можно переменной `E2E_KEEP=1`.

## Окружение без root

На машине разработчика нужны Xvfb, `WebKitWebDriver` той же версии, что и WebKitGTK, и `tauri-driver`. Пакеты можно не ставить, а распаковать:

```
mkdir -p ~/.local/depesha-testenv/debs && cd ~/.local/depesha-testenv/debs
apt-get download webkitgtk-webdriver xvfb
for d in *.deb; do dpkg-deb -x "$d" ../root; done
~/.local/depesha-testenv/root/usr/bin/Xvfb :99 -screen 0 1440x900x24 -nolisten tcp &
cargo install tauri-driver --locked
```

## Запуск

```
docker compose -f compose.test.yaml up -d --force-recreate
python3 e2e/imap_helper.py seed
npx tauri build --debug --no-bundle --features e2e
e2e/keyring.sh node e2e/run.mjs
```

Переменные: `DEPESHA_APP` (путь к бинарнику, например релизный `target/release/depesha`), `WEBKIT_DRIVER`, `E2E_DISPLAY`. `DEPESHA_E2E_COPY_BACKOFF` (секунды; `run.mjs` ставит 3) заменяет паузы 30 мин → 2 ч → 6 ч между отказами сервера принять копию в «Отправленные»: шаг 5.12 ждёт паузу копии за полминуты.

Сборка с фичей `e2e` считает выбранными пользователем файлы и папки из `DEPESHA_E2E_ROOT` (профиль прогона и корень репозитория; `run.mjs` задаёт его сам): системные диалоги WebDriver не нажимает, а без диалога бэкенд не пишет и не читает файлы по путям из интерфейса. Релизная сборка этой фичи не включает, и переменная там ничего не значит. Шаги, которые сами открывают диалог, подменяют ответ команды `pick_folder`.

`e2e/keyring.sh` запускает команду в отдельной сессии D-Bus с одноразовой разблокированной связкой ключей: пароли тестовых ящиков не попадают в связку пользователя, а заблокированная связка не мешает мастеру («SS error: prompt dismissed»). Так прогон запускает `scripts/check.sh`; вручную — `e2e/keyring.sh node e2e/run.mjs`. С `E2E_SYSTEM_KEYRING=1` используется связка текущей сессии.

Прогон останавливается, если не прошёл шаг, без которого остальные не имеют смысла (мастер, вход в ящик), или три шага подряд: дальше они только ждали бы свои таймауты. После провала шаг закрывает открытые меню и окна клавишей Esc, чтобы они не перекрывали следующие шаги.

Тест работает во временном профиле (`XDG_*` во временном каталоге) и отключает системные уведомления (`DEPESHA_NO_NOTIFICATIONS=1`). В конце прогона пароли тестовых ящиков удаляются из связки по id тестовой учётной записи.

## Стенд и грабли

### Общий стенд

- Имя проекта compose — `depesha`: в `compose.test.yaml` стоит `name: depesha`, иначе задай `COMPOSE_PROJECT_NAME=depesha`. Без этого compose берёт имя каталога worktree, поднимает свой проект и упирается в занятые порты 3143/31143.
- Порты WebDriver 4444/4445 зашиты в прогон, поэтому e2e одновременно может гонять только один агент. Свой project name второго прогона не даёт: драйвер всё равно слушает те же порты («Unable to listen», «Maximum number of active sessions»). Остальным — `scripts/check.sh --fast`; ждать в цикле бесполезно, окно между прогонами короче самого прогона.
- Занятость определяй по живому `e2e/run.mjs` или драйверу (`pgrep -af "e2e/run.mjs|tauri-driver|WebKitWebDriver"`) и по `ss -ltnp` на 4444/4445, а не по `docker ps`: контейнеры переживают прогон. В шаблонах ожидания исключай себя (`pgrep -f … | grep -v $$`), иначе процесс-ожидатель матчит собственную командную строку и висит при свободных портах.
- Осиротевшие `tauri-driver` и `WebKitWebDriver` убивай по PID (`ss -ltnp`), не по шаблону: `pgrep` в момент проверки может их не показать, а порт уже занят.
- Не отдавай прогон в `| tail`: он буферизует вывод до конца и обрывает прогон, оставляя драйвер висеть.
- Перед каждым прогоном `docker compose -f compose.test.yaml up -d --force-recreate` и `python3 e2e/imap_helper.py seed`. GreenMail держит письма и автосозданных пользователей в памяти: без пересоздания следующий прогон видит чужие ящики, а `--force-recreate` соседа стирает твоих. Свой стенд не поднимай поверх чужого прогона.
- Шаг 3.6 сам пересоздаёт стенд, и приёмочный seed исчезает. Шагам после него, которым нужны сеяные письма, звать `helper("seed")`: GreenMail уже свежий, повторный seed не падает.
- `ConnectionRefused` на 3143 и одиночный `socket error: EOF` хелпера — признак чужого пересоздания, не твоей правки. Проверь повтором. Одиночный «timeout waiting for row» на чистом стенде, разный от прогона к прогону, — флак отрисовки списка, не правка.

### WebKitWebDriver

- `\n` в textarea выбрасывается: драйвер по спецификации ставит курсор в конец и молча выкидывает перевод строки. Enter — символ ``, вставка в начало — `execCommand('insertText')`.
- Вложенный контейнер с overflow драйвер не прокручивает: клик ниже видимой части даёт «element not interactable», дальше каскад «click intercepted». `Driver.reveal()` (scrollIntoView) внутри click/clear/type.
- Синтетический `KeyboardEvent` на `window` не нажимает кнопку в фокусе: браузер не выполняет default action. Жми `Driver.pressKey` через W3C Actions `/actions` (keyDown/keyUp) или `sendKeys` по элементу.
- Клик по узлу, который перерисовка только что заменила, не всплывает: Svelte 5 делегирует `onclick` на корень. Повторяй клик в `until`, пока вид не сменится (заголовок списка станет нужным), а не считай успех по факту `click()`.
- Ошибки страницы WebDriver не показывает. Видны только через перехват `window.onerror`.
- Шаг закрывает слои в `catch` (Esc, `.viewer`, `.modal`). Иначе один провал при открытом слое валит остальные шаги с `element click intercepted`.

### Виртуальный список

- В DOM только видимые строки (~20). Считать письма через `invoke("messages", { query })`, по DOM проверять лишь наличие строк: `querySelectorAll('.list .row').length` никогда не дойдёт до числа писем в ящике.
- Прокрутка должна слать событие `scroll`, иначе виртуальный список не обновляет строки. Ждать, пока верх списка совпадёт с верхом из `invoke("messages", { query })`: асинхронный `reload` ещё показывает прежний порядок, и проверка «верхняя строка непрочитана» ловит старую сортировку.
- Счётчик папок обновляется с задержкой `scheduleFolders`. Перед записью жди, пока счётчик в панели совпадёт с `invoke("messages", { unread_only: true })`, иначе поймаешь обновление от собственной подготовки.
- Папка с ролью в сайдбаре подписана локализованно («Входящие», «Архив»), а не именем из `folders.name` (`INBOX`). Заголовок списка при нескольких ящиках — `<папка> · <ящик>`, поэтому `startsWith("Входящие")` совпадает и с чужим ящиком. Ищи строку по видимой подписи и сверяй заголовок целиком.

### Dovecot

- ACL: одних `mail_plugins { acl = yes }` и `protocol imap { mail_plugins { imap_acl = yes } }` мало — MYRIGHTS отвечает `NO [NONEXISTENT]` или Internal error. Нужен `acl_driver = vfile`, иначе плагин загружен, но «ACL not enabled». Публичный namespace в 2.4 — через `type = public`, `prefix`, `separator` и `mail_driver`/`mail_path` (старого `location` нет); `mailbox_list_layout = fs` даёт простые имена без Maildir++ точки. Права в `dovecot-acl` — словами (`anyone lookup read`), не буквами (`lr` даёт «Unknown ACL 'o'»).
- Набор интеграционных тестов гоняй с `--test-threads=4`. Полный параллелизм (`cargo test --test dovecot` без ограничения) роняет десятки TLS-сессий к одному контейнеру за 0.00 с с `UnexpectedEof: peer closed connection`; поодиночке те же тесты проходят.
- Нагрузочный ящик готовит `scripts/perf-fill.py`: APPEND ~30 мс на письмо из-за fsync, а Maildir, подложенный в `mail/cur`, Dovecot 2.4 не видит (ящики лежат в каталогах с GUID). Скрипт делает `doveadm import`. Том `/srv/vmail` анонимный, `--force-recreate` его сохраняет, `rm` в образе нет — скрипт перед импортом делает `doveadm expunge` и берёт уникальный каталог импорта, иначе повторный запуск удваивает ящик.
- `EXAMINE` отдаёт пустые `PERMANENTFLAGS` (`[PERMANENTFLAGS ()]`): папка read-only. Полный список с `\*` — у `SELECT`.

### GreenMail

- Нет `UID SEARCH CHARSET UTF-8`: сервер отвечает `BAD Search command not supported`. Сравнивай декодированные темы на стороне клиента (`e2e/imap_helper.py`).

### Подсчёт соединений через `ss`

- Соединение к опубликованному порту Docker видно дважды: клиент → `127.0.0.1` и docker-proxy → контейнер, у обоих один dport. Считай только peer `127.0.0.1:<порт>`.

### Без Tauri

- Vite dev-сервер без Tauri падает в `getCurrentWindow` и в `t()`: `@tauri-apps/api` v2 ждёт `window.__TAURI_INTERNALS__` с `metadata.currentWindow.label` и `transformCallback`, язык читается командой `language`. Мок через `page.addInitScript`: metadata, `transformCallback` и `invoke` для `settings_get`, `language`, `people`, `accounts`. Без ящиков мастер не пускает на страницу настроек.
- WebKitGTK вне Tauri (broadway, `GDK_BACKEND=broadway`) без GPU страницы не грузит. Поведение в WebKitGTK проверяй через `npm run tauri dev`.
- Видимость окна на Xvfb — снимком `DISPLAY=:N import -window root shot.png`. Разбор `XWindowAttributes` через ctypes врёт в `map_state`.

### Конкретные приёмы e2e

- Подпись под шапкой требует содержимого ниже: прокрутка упирается в конец и не прячет верх блока. Чтобы увести блок под шапку, после него нужны строки (как цитата ответа).
- Вставка в `.rich` — `insertAdjacentHTML('beforeend', …)` и событие `input`. `range.setStart` плюс `execCommand('insertHTML')` WebKitGTK переносит перед блоком `contenteditable=false`.
- Значение оператора `метка:` с пробелами — в кавычках (`метка:"Клиент Север"`); пробел и двоеточие рвут токен (`метка:Правка 07:51:50`). Подсказка такие имена уже дописывает в кавычках.

## Замер на кэше реального размера

`perf.mjs` повторяет жалобу на замирание при разборе почты: в первом ящике 50 нажатий «e» (в архив), а во втором лежит кэш на 60 000 писем. Синтетические ящики сценарий сеет сам прямо в `mail.sqlite`, поэтому нужны только стенд с GreenMail и собранный бинарник:

```
docker compose -f compose.test.yaml up -d --force-recreate && python3 e2e/imap_helper.py seed
npx tauri build --debug --no-bundle --features e2e
DEPESHA_APP=… e2e/keyring.sh node e2e/perf.mjs
```

Переменные: `PERF_RUNS` (по умолчанию 3), `PERF_SCALE` (во сколько раз больше почты, чтобы найти порог), `PERF_OUT` (файл результата). В конце печатается сводка: медиана и максимум по каждому показателю.

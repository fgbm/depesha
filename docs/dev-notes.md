# Грабли библиотек и протоколов

Поведение библиотек и серверов, о которое уже спотыкались: правило и короткое «почему», рецепты команд — как есть. Стенд и прогон — в `e2e/README.md`, работа в репозитории — в `AGENTS.md`.

## IMAP

- NO/BAD от `async-imap` приходит строкой `code: None, info: Some("...")`, пользователю её показывать нельзя. Текст сервера вытаскивает `imap::server_text`.
- До логина у `async_imap::Client` нет `capabilities()`, а `run_command` закрыт (`pub(crate)`), поэтому `AUTH=` до входа так не прочитать. CAPABILITY — через `run_command_and_check_ok("CAPABILITY", Some(tx))` и разбор `UnsolicitedResponse::Other` из канала.
- NAMESPACE imap-proto не разбирает: `Response::parse` (0.17) возвращает `Err(TakeWhile1)`, и непрочитанная строка в `read_response` рвёт соединение `io::Error`. Команду пиши через `run_command` (тег библиотеки), ответ дочитывай сырыми байтами из `session.get_mut()` до строки с тегом и разбирай своей регуляркой. MYRIGHTS, ACL и PERMANENTFLAGS imap-proto разбирает штатно.
- Свойства папки читай через SELECT, не EXAMINE. EXAMINE отдаёт `[PERMANENTFLAGS ()]`, SELECT — полный список с `\*`; иначе свои метки всегда выглядят запрещёнными.
- STORE в read-only папке Dovecot молча отвечает OK: `UID STORE -FLAGS.SILENT` не снимает флаг и не отвечает NO. Перед снятием сверяй MYRIGHTS (`imap::folder_props`) и read-only считай отказом, иначе кэш теряет метку, а на сервере она остаётся.

## SMTP

- `lettre` не ставит `Message-ID`, пока не вызвать `.message_id(...)`. Без него ломается защита от дублей в «Отправленных»; идентификатор генерирует `smtp::build`.
- В тестах quoted-printable рвёт длинные строки мягким переносом `=\r\n` и пишет `=` как `=3D`, поэтому `cid:` в сыром `build().formatted()` не найти. Проверяй тело после `raw.replace("=\r\n", "").replace("=3D", "=")` или декодированный `parse_view`.

## SQLite

- `GROUP BY` с голыми колонками берёт их из строки с MAX, только если в запросе один MIN/MAX. Второй `MAX(flagged)` молча делает выбор строки произвольным. Остальные агрегаты — через SUM.

## WebKitGTK

- Сбой WebKitWebProcess при закрытии окна (`_gbm_device_destroy` → SEGV, Mesa/GBM, #73): при старте выставляется `WEBKIT_DISABLE_DMABUF_RENDERER=1`, если переменная не задана. Свой вариант (даже `0`) приложение не трогает: `WEBKIT_DISABLE_DMABUF_RENDERER=0 depesha`.
- Смена атрибута `srcdoc` iframe не перезагружает документ. Оборачивай `MailFrame` в `{#key}`, чтобы iframe пересоздался.
- Вставка перед `contenteditable=false` уезжает над заблокированным блоком: WebKitGTK переносит `insertHTML` перед ним. Для проверки надёжнее `insertAdjacentHTML('beforeend')` и событие `input`.

## Tauri

- В `src-tauri` нет `futures` (зависимость есть только в `depesha-core`), `cargo check` падает на «unresolved module futures». Параллель задач — `tokio::task::JoinSet` со `spawn` (нужны `Arc<AppState>` и `'static`-фьючеры) и помощник `run_bounded`, ограничивающий число задач сразу.

## Графика

- SVG логотипа растеризуй только через `npx tauri icon` (resvg) из корня проекта. ImageMagick (`magick seal.svg`) молча теряет обводку дуги (`A` в path) и `fill="none"`, обрезает `rotate`; из `/tmp` npx не находит tauri, а с `>/dev/null` этого не видно.
- Логотип Google — плоский `Google_"G"_logo.svg` с Wikimedia Commons. В официальном `signin-assets.zip` только кнопки целиком, а «G» в них — экспорт из Figma с конусным градиентом через `foreignObject` и JSON в `fill`: ImageMagick рисует его сиреневым, на WebKitGTK тоже ненадёжно.

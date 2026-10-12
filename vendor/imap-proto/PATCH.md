# Правка imap-proto 0.17.0

Копия крейта [`imap-proto`](https://crates.io/crates/imap-proto) 0.17.0, подключённая через `[patch.crates-io]` в корневом `Cargo.toml`. Лицензия — MIT OR Apache-2.0, тексты рядом (`LICENSE-MIT`, `LICENSE-APACHE`). Отличие от версии с crates.io — одна строка.

## Что изменено

`src/rfc3501/body.rs`, разбор ответа на `FETCH` с частью тела (`msg_att_body_section`): `tag(" ")` заменён на `opt(tag(" "))`. RFC 3501 (`msg-att-static`) требует пробел перед `nstring` — `"BODY" section ["<" number ">"] SP nstring`; пробел сделан необязательным.

## Почему

Депеша читает превью текста письма префиксом части: `BODY.PEEK[<часть>]<0.4096>` (#177). Некоторые серверы пишут ответ на такой запрос без пробела — GreenMail отдаёт `BODY[1.1]<0>{265}` там, где Dovecot и Gmail отдают `BODY[1.1]<0> {265}` (проверено на стенде: `BODY[1.1] {n}` с пробелом, `BODY[1.1]<0>{n}` — без). Строгий разбор такую строку отвергает.

Отвергнутый ответ хуже, чем отсутствие превью: `async-imap` не освобождает буфер соединения после ошибки разбора, поэтому остаток ответа съедается следующим запросом — соединение рассинхронизируется и падает вся синхронизация папки, а не только превью (в CI это роняло задачу Integration на `send_sync_read_flag_move`).

## Когда копию убрать

Когда `imap-proto` (или `async-imap`) станет разбирать ответ без пробела сам — например, в новой версии появится `opt(tag(" "))` или иная терпимость к формату. Признак: ответ GreenMail `BODY[1.1]<0>{n}` разбирается без этой копии. Тогда удалить `vendor/imap-proto`, `[patch.crates-io]` из корневого `Cargo.toml` и `exclude` для `vendor/` из `[workspace]`, обновить `Cargo.lock` и прогнать `DEPESHA_IT=1 cargo test -p depesha-core --test greenmail --test dovecot` и `scripts/check.sh --ci`.

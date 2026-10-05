# Сквозной тест

`run.mjs` запускает настоящее приложение на виртуальном дисплее, управляет им по WebDriver и проходит сценарий приёмки против GreenMail. Каждый шаг помечен номером критерия из `docs/acceptance.md`. Скриншоты и `results.json` пишутся в `e2e/screens/`.

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
npx tauri build --debug --no-bundle
e2e/keyring.sh node e2e/run.mjs
```

Переменные: `DEPESHA_APP` (путь к бинарнику, например релизный `target/release/depesha`), `WEBKIT_DRIVER`, `E2E_DISPLAY`.

`e2e/keyring.sh` запускает команду в отдельной сессии D-Bus с одноразовой разблокированной связкой ключей: пароли тестовых ящиков не попадают в связку пользователя, а заблокированная связка не мешает мастеру («SS error: prompt dismissed»). Так прогон запускает `scripts/check.sh`; вручную — `e2e/keyring.sh node e2e/run.mjs`. С `E2E_SYSTEM_KEYRING=1` используется связка текущей сессии.

Прогон останавливается, если не прошёл шаг, без которого остальные не имеют смысла (мастер, вход в ящик), или три шага подряд: дальше они только ждали бы свои таймауты. После провала шаг закрывает открытые меню и окна клавишей Esc, чтобы они не перекрывали следующие шаги.

Тест работает во временном профиле (`XDG_*` во временном каталоге) и отключает системные уведомления (`DEPESHA_NO_NOTIFICATIONS=1`). В конце прогона пароли тестовых ящиков удаляются из связки по id тестовой учётной записи.

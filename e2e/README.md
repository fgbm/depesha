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
node e2e/run.mjs
```

Переменные: `DEPESHA_APP` (путь к бинарнику, например релизный `target/release/depesha`), `WEBKIT_DRIVER`, `E2E_DISPLAY`.

Если связка ключей пользователя заблокирована, мастер не сохранит пароль («SS error: prompt dismissed»). Тогда прогон запускается в отдельной сессии D-Bus с одноразовой связкой, основная не трогается:

```
cat > /tmp/e2e-keyring.sh <<'SH'
#!/bin/bash
export XDG_DATA_HOME="$(mktemp -d)"
echo -n x | gnome-keyring-daemon --login >/dev/null 2>&1
eval "$(gnome-keyring-daemon --start --components=secrets)"
unset XDG_DATA_HOME
node e2e/run.mjs
SH
chmod +x /tmp/e2e-keyring.sh && dbus-run-session -- /tmp/e2e-keyring.sh
```

Тест работает во временном профиле (`XDG_*` во временном каталоге) и отключает системные уведомления (`DEPESHA_NO_NOTIFICATIONS=1`). Пароли тестовых ящиков попадают в связку ключей пользователя и удаляются в конце прогона по id тестовой учётной записи.

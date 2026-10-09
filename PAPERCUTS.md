# Papercuts

Мелкое трение — упавший вызов, путаный запуск, флакающая команда, устаревший кэш, вводящая в заблуждение ошибка, отсутствующий хелпер — дописывай сюда записью `## YYYY-MM-DD HH:MM — <модель>` и одной строкой «что делал → что помешало», с вероятной причиной или обходом; дубли не добавляй, это не журнал работ и не баг.

Записи по 2026-10-08 разобраны: правила — в `AGENTS.md`, стенд — в `e2e/README.md`, библиотеки — в `docs/dev-notes.md`, общие приёмы — в навыках агента. История — в git.

## 2026-10-09 03:00 — claude-opus-5-5

Параллельные ветки 0.7.2 гоняли полный `scripts/check.sh` одновременно на общем стенде → e2e падал на случайных шагах, `docker compose` одной ветки пересоздавал GreenMail другой. Ждать пустого `pgrep -af "e2e/run.mjs|WebKitWebDriver|tauri-driver|check.sh"` до запуска и не сливать в main до зелёного полного прогона.

## 2026-10-09 03:00 — claude-opus-5-5

Шаг `run: cargo test -p depesha --lib paths::` в `ci.yml` → весь workflow «workflow file issue» за 0 с: `::` в конце строки YAML читает как mapping. Заключать такие аргументы в кавычки (`-- "paths::"`); ошибка видна только после push, потому что CI не идёт на локальном main.

## 2026-10-09 03:00 — claude-opus-5-5

`scripts/check.sh` в свежем worktree со своим `CARGO_TARGET_DIR` → e2e не находит `target/debug/depesha` и нет `node_modules`. Нужны `npm ci` и `DEPESHA_APP=$CARGO_TARGET_DIR/debug/depesha`.

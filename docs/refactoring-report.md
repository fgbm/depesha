# Отчёт о рефакторинге фронтенда (issue #48)

Критерии — [refactoring-acceptance.md](refactoring-acceptance.md). Рефакторинг поведение-сохраняющий, идёт по фазам, каждая фаза — отдельный PR.

Дата начала: 2026-10-05.

Как проверяется:

- **lint** — ESLint (flat config) поверх `src/**` и `plugins/**`; правила-стражи как `error`.
- **metrics** — `scripts/frontend-metrics.sh`: размеры компонентов (всего/скрипт/разметка/стиль) и топ длинных функций, сверка с `docs/frontend-metrics-baseline.txt`.
- **invariants** — `scripts/frontend-invariants.sh`: наборы и числа ключей `t()`, `role=`/`aria-*`, видов `data-*`, членов `app.*`; сверка с `docs/frontend-invariants/`.
- **svelte-check / vitest** — как раньше, в `scripts/check.sh`.
- **E2E** — `e2e/run.mjs` (полный `scripts/check.sh`).

## Фаза 0. Линтер и метрики

Статус: **выполнено**.

### Что сделано

1. Линтер: `eslint` 9 (flat config) + `typescript-eslint` + `eslint-plugin-svelte`, только `devDependencies`. Скрипт `npm run lint` (AC6, AC17).
2. Правила-стражи как `error` (общие для `.ts` и `.svelte`):
   - `max-lines-per-function` — 60, без пустых строк и комментариев (AC13);
   - `complexity` — 25;
   - `max-depth` — 6;
   - `@typescript-eslint/no-explicit-any`;
   - `@typescript-eslint/no-unused-vars` — с шаблонами `^_` для аргументов, переменных и `catch`.
   Дополнительно: рекомендации `eslint`, `typescript-eslint` и `eslint-plugin-svelte`; `no-undef` выключен (типы проверяет `svelte-check`); `svelte/prefer-svelte-reactivity` выключен — классы-контроллеры держат обычные `Set`/`Map` под руной `$state`, это не стражник R1.
3. `scripts/frontend-metrics.sh` — POSIX sh/awk, режимы `--print` / `--save` / `--compare`; baseline `docs/frontend-metrics-baseline.txt` (538 записей). Рост любого размера — регрессия, выход ненулевой; уменьшения и новые/удалённые записи печатаются, но не роняют проверку.
4. `scripts/frontend-invariants.sh` — POSIX sh/awk; baseline в `docs/frontend-invariants/` (`t-keys.txt`, `roles.txt`, `aria-attrs.txt`, `data-kinds.txt`, `app-members.txt`, `summary.txt`). Любой дрейф набора или счётчика — выход ненулевой.
5. CI (`check`) и `scripts/check.sh --fast`: добавлены `npm run lint`, `scripts/frontend-metrics.sh`, `scripts/frontend-invariants.sh` перед `vitest`.

### Текущие метрики (на этой ветке)

Инварианты (в скобках — замер issue #48; числа расходятся, потому что #24/#8/#25/#37 и др. уже поменяли компоненты):

| Величина | Сейчас | В issue |
| --- | --- | --- |
| Компонентов | 52 | 50 |
| Ключей `t()` (литеральных) | 447 | 444 |
| Атрибутов `role=` | 62 | — |
| Атрибутов `aria-*` | 149 | — |
| `role=`/`aria-*` атрибутов | 211 | 202 |
| Видов `role=`/`aria-*` | 17 | 17 |
| Литеральных значений `role=` | 22 | — |
| Имён `aria-*` | 16 | — |
| Видов `data-*` | 17 | 17 |
| Членов `app.*` | 83 | 83 |

Крупнейшие компоненты (всего / скрипт / разметка / стиль):

| Компонент | Сейчас | В issue |
| --- | --- | --- |
| `Sidebar.svelte` | 1304 / 238 / 346 / 720 | 1304 / 238 / — / 720 |
| `Reader.svelte` | 1298 / 367 / 295 / 636 | 1272 / 348 / — / 636 |
| `Compose.svelte` | 1103 / 528 / 187 / 388 | 1110 / 527 / — / 396 |
| `Preferences.svelte` | 678 / 129 / 204 / 345 | 662 / 128 / — / 340 |
| `MessageList.svelte` | 547 / 131 / 102 / 314 | 547 / 131 / — / 314 |
| `FormatBar.svelte` | 374 / 231 / 65 / 78 | — |
| `RichEditor.svelte` | 361 / 224 / 31 / 106 | — |
| `app.css` | 307 строк | 307 |

Топ длинных функций (сейчас): `render` 184 (`src/lib/richtext.ts`), `coreCommands` 109 (`src/lib/commands.ts`), `onKey` 68 (`src/App.svelte`), `context` 63 (`src/plugin-host/host.svelte.ts`).

### Отступления и игноры

- `eslint-suppressions.json` — 22 точечных подавления в 15 файлах (bulk suppressions ESLint 9): длинные/сложные `render`, `coreCommands`, `onKey`, `context`; неиспользуемые импорты в компонентах; `{@html}` в предпросмотре Markdown (очищено дважды); `role="document"` без имени; `any` в описании рендерера вложений. Подавления по счётчикам: исчезнувшее нарушение роняет `npm run lint` с подсказкой `--prune-suppressions`, то есть долг виден и убирается по мере фаз.
- Из линта исключены: `dist`, `node_modules`, `target`, `src-tauri`, `docs`, `public`, `e2e`. `e2e/run.mjs` не линтуется — AC2 держит его diff пустым.
- Плагины (`plugins/**`) намеренно **в** охвате линта: сейчас чисты, стражники работают на будущее, при необходимости подавляются тем же механизмом.

### Проверка фазы

| Проверка | Результат |
| --- | --- |
| `npm run lint` | зелёный (0 ошибок) |
| `npx svelte-check --tsconfig ./tsconfig.json --fail-on-warnings` | 0 ошибок, 0 предупреждений |
| `npx vitest run` | 37 файлов, 239 тестов — зелёные |
| `scripts/frontend-metrics.sh` | регрессий нет |
| `scripts/frontend-invariants.sh` | дрейфа нет |
| `bash -n` новых скриптов | чисто |

## Фаза 1. Стор

Статус: **выполнено**.

### Что сделано

`src/lib/store.svelte.ts` (563 → 241 строк) остался фасадом: он владеет контроллерами, объявляет
реактивные поля окна письма (`windowOf`) и держит `app.*` единственной точкой входа. Состояние
переехало в связные модули, а геттеры/сеттеры фасада возвращают его как было — публичный API и
поведение не изменились. Хосты у всех модулей узкие, как у `ListController`:

- `settings.svelte.ts` (114) — `SettingsController` / `SettingsHost` — настройки, настройки плагинов,
  язык, тема, проверка и установка обновлений;
- `mailboxes.svelte.ts` (80) — `MailboxController` / `MailboxHost` — ящики, папки, исходящие, версия,
  адрес «домой» и отложенное чтение папок;
- `ui.svelte.ts` (108) — `UiController` — тосты, диалог подтверждения, мастер, окно настроек, панель
  задач и счётчик `track`; сюда же переехали `Toast` / `Confirmation` / `WizardState`;
- `selection.svelte.ts` (186) — `SelectionController` / `SelectionHost` — вид списка, его порядок и
  фильтр, выделение, открытие/перемещение по строкам, `flag`, `listed`, `takeOut`, `openWindow`.

Поля `accounts`, `folders`, `outbox`, `version`, `settings`, `update`, `toasts`, `confirmation`,
`wizard`, `busy`, `tasks`, `tasksOpen`, `settingsOpen`, `settingsPage`, `settingsSection`,
`settingsTurn`, `focusSearch`, `selected`, `anchor` объявлены в модулях и открыты геттерами/сеттерами
фасада. Контроллерные поля и `listed` получили явные аннотации типов: без них TypeScript ловит
циклический вывод `AppStore` → `SelectionHost` → `AppStore`.

### Проверка фазы

| Проверка | Результат |
| --- | --- |
| `npm run lint` | зелёный (0 ошибок; подавлений не добавлено) |
| `npx svelte-check --tsconfig ./tsconfig.json --fail-on-warnings` | 0 ошибок, 0 предупреждений |
| `npx vite build` | зелёный (размер бандла не вырос) |
| `npx vitest run` | 40 файлов, 271 тест — зелёные (`store.test.ts` в том числе) |
| `scripts/frontend-metrics.sh` | регрессий нет |
| `scripts/frontend-invariants.sh` | дрейфа нет (`app_members 85` идентичен) |
| `git diff --name-only main -- '*.svelte' 'e2e'` | пусто |

| Файл | Строк | Ответственность |
| --- | --- | --- |
| `store.svelte.ts` | 241 | фасад: контроллеры, `windowOf`, геттеры/сеттеры и делегаты `app.*` |
| `selection.svelte.ts` | 186 | вид списка, порядок/фильтр, выделение, навигация, флаги |
| `settings.svelte.ts` | 114 | настройки приложения и плагинов, язык, тема, обновления |
| `ui.svelte.ts` | 108 | тосты, подтверждения, мастер, окно настроек, задачи, `track` |
| `mailboxes.svelte.ts` | 80 | ящики, папки, исходящие, версия, `home` |


## Фаза 2. Compose

Статус: **выполнено**.

### Что сделано

Логика `src/components/Compose.svelte` (1190 → 837 строк, скрипт 542 → 188) вынесена в
`src/lib/compose/`; разметка и scoped-стили не менялись (`git diff` по разметке пуст, кроме
переименования ссылок на вынесенное состояние). Компонент остался окном: разметка, поля
адресов, ширина окна, тосты и `t("…")` его сообщений. Хосты у всех модулей узкие, как у
`ListController`; ни один не видит весь `AppStore` или весь компонент.

- `format.svelte.ts` (281) — `ComposeFormat` / `ComposeFormatHost` — тело письма: что
  набрано, подпись под ним и цитата, в своём формате; переключение plain/HTML/Markdown
  (`convertDraft`, `takeBodyPictures`), предпросмотр Markdown, вставка картинок в текст;
- `sending.svelte.ts` (223) — `ComposeSending` / `ComposeSendHost` — проверки перед
  отправкой (`sendWarnings`), параметры отправки для плагинов (`options`, `followup*`),
  `composeCtx`, клавиши окна (`composeAction`), закрытие, удаление, сворачивание;
- `attachments.svelte.ts` (110) — `ComposeAttachments` / `ComposeAttachHost` — файлы и
  картинки: выбор, вставка из буфера, drag&drop и зоны окна;
- `autosave.svelte.ts` (86) — `ComposeAutosave` / `ComposeAutosaveHost` — автосохранение
  черновика через 3 с, одно сохранение за раз.

`setFormat` остался в `format.svelte.ts`; из компонента убран только мёртвый импорт
`FileText` (иконка не использовалась) — это не функция и не поведение, а чистка.

### Проверка фазы

| Проверка | Результат |
| --- | --- |
| `npm run lint` | зелёный (0 ошибок; подавление неиспользуемого импорта `Compose.svelte` снято `--prune-suppressions`) |
| `npx svelte-check --tsconfig ./tsconfig.json --fail-on-warnings` | 0 ошибок, 0 предупреждений |
| `npx vite build` | зелёный |
| `npx vitest run` | 40 файлов, 277 тестов — зелёные |
| `cargo fmt --all --check` | чисто |
| `cargo clippy --workspace --all-targets -- -D warnings` | зелёный |
| `cargo test -p depesha-core` / `-p depesha --lib` | зелёные |
| `scripts/frontend-metrics.sh` | регрессий нет (`Compose.svelte` 1190 → 837) |
| `scripts/frontend-invariants.sh` | дрейфа нет (`t_keys 559`, `app_members 85`, `role/aria 238`) |
| `git diff --name-only main -- '*.svelte' 'e2e'` | только `Compose.svelte` |

| Файл | Строк | Ответственность |
| --- | --- | --- |
| `components/Compose.svelte` | 837 (скрипт 188) | окно, разметка, scoped-стили, поля адресов, ширина, тосты и тексты |
| `lib/compose/format.svelte.ts` | 281 | тело, подпись, цитата, форматы, картинки в тексте |
| `lib/compose/sending.svelte.ts` | 223 | проверки, отправка, параметры плагинов, клавиши, закрытие |
| `lib/compose/attachments.svelte.ts` | 110 | вложения и картинки: выбор, буфер, drag&drop |
| `lib/compose/autosave.svelte.ts` | 86 | автосохранение черновика |


## Фаза 3. Preferences

Статус: **не начато**.

## Фаза 4. Sidebar

Статус: **не начато**.

## Фаза 5. Reader

Статус: **не начато**.

## Итоговая приёмка

Статус: **не начато**. Все фазы пройдены; полный `scripts/check.sh` зелёный; метрики AC10–AC19 достигнуты.

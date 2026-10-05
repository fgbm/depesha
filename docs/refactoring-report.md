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

Статус: **выполнено**.

### Что сделано

`src/components/Preferences.svelte` (739 → 378 строк, разметка 231 → 52, стиль 355 → 179)
остался оболочкой окна настроек: вкладки (`CORE`, сгруппированные ящики и секции
плагинов), `role="tablist"` и стрелки `↑/↓`, заголовок страницы, `content`, общий
footer с `cancel`/`save`, `closeSettings`, `Escape` и черновик `draft`. Разметка и
scoped-стили панелей переехали с их владельцами в `components/prefs/`; CSS оболочки
(бокавая колонка вкладок, `pane`, `header`, `.content`, `footer`, узкое окно)
осталась в ней.

Панели (имя — по шву `{#if current === …}`, а не механически по списку из issue):

- `GeneralPanel` — `general` + `updates`: язык, оформление и тема, порог крупного
  письма (`largeValue`/`largeUnit` — `$bindable`), авто-обновления, проверка и версии;
- `MailPanel` — `mail` + `notifications`: список, формат новых писем, чтение
  (`letter_view`), папка вложений, «Отменить отправку» (`undo_send_secs`), уведомления
  и квоты;
- `OfflinePanel` — `offline`: срок хранения и вложения офлайн;
- `AccountsPanel` — `accounts`, `account:new`, `account:<id>`: менеджер ящиков
  (`Accounts.svelte`), мастер и `AccountPage`;
- `PluginsPanel` — `plugins` и `plugin:<i>`: менеджер плагинов и секции из реестра.

Отличие от имён в issue объяснено швами и лимитом в 350 строк (AC10): `General`,
`Mail`, `Offline` и `Updates` — это одна и та же форма (секция, `h4`, снипет
`option`, радио, `.inline`) с общим CSS; четыре отдельных файла скопировали бы её
четыре раза. Поэтому группировка — по смыслу страницы: приложение+обновления
(`GeneralPanel`) и почта+уведомления (`MailPanel`, тоже ≤ 350). `Accounts` и `Plugins`
в issue названы раздельно, но обе панели рендерят общие компоненты `Accounts.svelte`
и `Plugins.svelte` из соседних фаз и делят один `section`-стиль; они свёрнуты в одну
панель, чтобы не плодить файлы ради файлов (R10, «не дробить ради дробления»).
Если проверяющему нужны ровно четыре файла с issue-именами, `MailPanel` отделяется
от `GeneralPanel` без изменения поведения.

Правила выноса соблюдены: `app.*` остался единственной точкой входа (панели берут
узкий `draft: Settings` и, где нужно, сам `app`), пропсы не пробрасываются цепочками,
`mail`/`notifications`/`updates`/`offline`-CSS переехал вместе с разметкой; классы
`.prefs`, `.account-page`, `.plugins`, `.tab[data-page]`, `.folder input`,
`.pane h2`, `footer .btn.primary`, `input.large` не тронуты — E2E-селекторы целы.
Разметка каждого блока побайтово совпала с исходной (сверка построчным `diff`), с
точностью до структурных `{#if}`-обёрток.

### Проверка фазы

| Проверка | Результат |
| --- | --- |
| `npm run lint` | зелёный (0 ошибок; подавлений не добавлено) |
| `npx svelte-check --tsconfig ./tsconfig.json --fail-on-warnings` | 0 ошибок, 0 предупреждений |
| `npx vite build` | зелёный |
| `npx vitest run` | 40 файлов, 277 тестов — зелёные |
| `cargo fmt --all --check` | чисто |
| `cargo clippy --workspace --all-targets -- -D warnings` | зелёный |
| `cargo test -p depesha-core` / `-p depesha --lib` | зелёные |
| `scripts/frontend-metrics.sh` | регрессий нет (`Preferences.svelte` 739 → 378) |
| `scripts/frontend-invariants.sh` | дрейфа нет (`t_keys 559`, `app_members 85`, `role/aria 238`); обновлён только счётчик компонентов 55 → 60 |
| `git diff --name-only main -- '*.svelte' 'e2e'` | только `Preferences.svelte` и новые `components/prefs/*.svelte`; `e2e/run.mjs` без изменений |

| Файл | Строк | Ответственность |
| --- | --- | --- |
| `components/Preferences.svelte` | 378 (разметка 52) | оболочка окна: вкладки, заголовок, `content`, footer, закрытие |
| `components/prefs/GeneralPanel.svelte` | 252 | язык, оформление/тема, порог крупного письма, обновления |
| `components/prefs/MailPanel.svelte` | 181 | список, формат, чтение, вложения, отправка, уведомления, квоты |
| `components/prefs/OfflinePanel.svelte` | 80 | офлайн: срок хранения и вложения |
| `components/prefs/AccountsPanel.svelte` | 53 | менеджер ящиков, мастер, страница ящика |
| `components/prefs/PluginsPanel.svelte` | 32 | менеджер плагинов и секции из реестра |


## Фаза 4. Sidebar

Статус: **выполнено**.

### Что сделано

`src/components/Sidebar.svelte` (1322 → 31 строк) стал оболочкой: выбирает полосу (#38)
или полный сайдбар по `layout.strip` и держит общие для полосы `$effect`
(сброс `flyout` на широком окне, закрытие ветки «Все папки» при смене ящика). Обе
половины, строки, дерево и избранное вынесены в `components/sidebar/`; состояние
сайдбара — в `sidebarUi`.

Шов — не по списку из issue, а по тому, что реально дублировалось и по строкам (AC10 ≤ 350):

- `FolderRow` — один компонент строки папки (R7): и строка дерева, и строка избранного
  (в том числе затухающая и «пропавшая с сервера») рендерятся им, а не снипетом из двух
  путей. С ним же переехали звезда, счётчик, треугольник сворачивания и путь вложенной
  папки, а значит и CSS, держащий звёзды в одной правой колонке (#39).
- `SidebarTree` — цикл дерева ящика (папки, вложенность, `withChildren`/`unfolded`).
- `Favourites` — блок избранного ящика (`.favs`), строки — `FolderRow`.
- `SidebarFolded` — полоса (#38): плитки, кружки ящиков с вылетом и «Все папки».
- `SidebarFull` — полный сайдбар: умные секции, группы ящиков, строки обновления и футер.
- `SmartSections` — умные секции, вкладки плагинов и «Исходящие» одним списком для обеих
  половин (`variant="full"` — строка со счётчиком, `variant="strip"` — плитка со значком).
- `Problem` — строка ошибки ящика и `statusText` (нужны и в полосе, и в полной панели).
- `DndButton`, `TasksButton` — кнопки футера.

Из issue имена `Favourites`/`SidebarFolded`/`SidebarTree` совпали; `FolderRow` — как
названо. Лишних дроблений нет: `SmartSections`, `Problem`, `DndButton`, `TasksButton`
вынесены не «ради дробления», а потому что их разметка нужна в обеих половинах — иначе
она (вместе с `role=`/`aria-*` и `t()`) дублировалась бы и роняла счётчики AC8.

`app.*` остался единственной точкой входа в состояние письма; сайдбар держит только своё
состояние просмотра (`sidebarUi`: свёрнутые ящики и папки, контекстное меню, вылет,
флаги «не беспокоить»), как `layout` и `favourites`. Пропсы не пробрасываются цепочками.
Фокус при уходе строки избранного (`favourites.onleave`) назначен один раз в `sidebarUi`,
а не в каждом из двух блоков.

### Про CSS (отступление, объяснение)

CSS сайдбара (719 строк) переехал **целиком** в `components/sidebar/sidebar.css`, который
импортирует оболочка, и обёрнут под `.side` — корнем, который есть только у сайдбара.
Причина — ограничения 350/400: строки, счётчики и звёзды одни и те же и в дереве, и в
избранном, и в полосе, и в полной панели, а Svelte-скоуп не переживает границу
компонента (фаза 3 поэтому дублировала общие правила по панелям). Дублировать ~720 строк
в четырёх файлах — это рост и риск расхождения колонок звёзд (#39), поэтому один файл со
`.side`-обёрткой — сознательный компромисс: селекторы прежние, байт-в-байт по правилам,
`app.css` не тронут (312 строк). Если проверяющему нужен именно Svelte-scoped CSS,
`sidebar.css` разносится по компонентам с дублированием общих правил без смены поведения.

Инварианты E2E сохранены: `role=`/`aria-*`/`data-*` и классы не менялись — `summary.txt`
изменён только строкой `components` (60 → 69; на `main` с уже влитой фазой 5 — 76),
`e2e/run.mjs` не тронут (diff пуст).

### Проверка фазы

| Проверка | Результат |
| --- | --- |
| `npm run lint` | зелёный (0 ошибок; подавлений не добавлено) |
| `npx svelte-check --tsconfig ./tsconfig.json --fail-on-warnings` | 0 ошибок, 0 предупреждений |
| `npx vite build` | зелёный |
| `npx vitest run` | 40 файлов, 277 тестов — зелёные |
| `cargo fmt --all --check` | чисто |
| `cargo clippy --workspace --all-targets -- -D warnings` | зелёный |
| `cargo test -p depesha-core` / `-p depesha --lib` | зелёные |
| `scripts/frontend-metrics.sh` | регрессий нет (`Sidebar.svelte` 1322 → 31; новые ≤ 121) |
| `scripts/frontend-invariants.sh` | дрейфа нет (`t_keys 559`, `app_members 85`, `role/aria 238`); обновлён только счётчик компонентов (60 → 69; после влитой в `main` фазы 5 — 67 → 76) |
| `git diff --name-only <base> -- '*.svelte' 'e2e'` | только `Sidebar.svelte` и новые `components/sidebar/*`; `e2e/run.mjs` без изменений |

| Файл | Строк | Ответственность |
| --- | --- | --- |
| `components/Sidebar.svelte` | 31 | оболочка: полоса/полный сайдбар, общие `$effect`, подключает CSS |
| `components/sidebar/SidebarFull.svelte` | 103 | полный сайдбар: умные секции, группы ящиков, обновление, футер |
| `components/sidebar/SidebarFolded.svelte` | 114 | полоса (#38): плитки, кружки, вылет с избранным и «Все папки» |
| `components/sidebar/FolderRow.svelte` | 121 | строка папки: дерево, избранное, затухание, путь вложенной |
| `components/sidebar/SmartSections.svelte` | 75 | умные секции, вкладки плагинов, «Исходящие» (full/strip) |
| `components/sidebar/DndButton.svelte` | 46 | «не беспокоить» и его меню |
| `components/sidebar/Problem.svelte` | 39 | строка ошибки ящика, `statusText` |
| `components/sidebar/Favourites.svelte` | 27 | блок избранного ящика (`.favs`) |
| `components/sidebar/SidebarTree.svelte` | 20 | цикл дерева папок ящика |
| `components/sidebar/TasksButton.svelte` | 18 | кнопка задач |
| `components/sidebar/sidebar.svelte.ts` | 195 | `sidebarUi`: состояние просмотра сайдбара, `roleIcon`, `onleave` |
| `components/sidebar/sidebar.css` | 719 | CSS сайдбара, scoped под `.side` (см. «Про CSS») |

## Фаза 5. Reader

Статус: **выполнено**.

### Что сделано

`src/components/Reader.svelte` (1299 → 310 строк, скрипт 368 → 112, разметка 295 → 97,
стиль 636 → 101) остался областью чтения: она владеет состояниями письма, решает,
какое из них показать (письмо, заготовка, ошибка, массовая операция, «письмо идёт»),
держит `iframe srcdoc` с его правилами пересоздания и сборкой вьюера вложений и
разметку строки вложений/тела. Всё остальное переехало в `components/reader/`; CSS
переехал с владельцем разметки, `app.*` остался единственной точкой входа, пропсы
узкие — реактивные состояния компонентов, без цепочек.

Компоненты (имена — по шву разметки, а не механически по списку из issue):

- `ReaderHeader` — заголовок письма: тема, отправитель с фото/логотипом, получатели,
  дата, а также строка вложений (`.files`/`.file`/`.file-name`/`.fname`/`.fsize`, №23:
  клик по имени открывает вьюер, кнопки сохранения). Свои `.head`/`.from`/`.avatar`/
  `.who`/`.date`/`.sender`/`.files`/`.file*`/`.small-btn`; сюда же переехали
  `fromSender`, `onlyToMe`, `list`, `saveDir`, показ вложений.
- `ReaderToolbar` — панель письма: «назад»/соседи (переданы снипетом `nav`), «продолжить
  черновик», «Готово», кнопки плагинов, «Удалить», меню «Ещё» и «Переместить»; здесь
  живут `moreOpen`/`moveOpen`, `messageCommands`, `pluginActions`, `folders` и весь
  toolbar-CSS (`.toolbar`, `.anchor`, `.sep`, `.icon`, `.folder-list`, `.compact`,
  контейнерные запросы).
- `ReaderStates` — всё, что не письмо: массовая операция, ошибка, «письмо идёт»
  (прогресс/скелет/«медленно»), заготовка «выберите письмо»; свой `.center`/`.opening`/
  `.progress`/`.skeleton`/`.slow`/`.hint`/`.actions`/`.select-all`/`.danger-text`.
- `ReaderBody` — «HTML · Markdown · Текст» и сам текст: `MailFrame` с `#key` по
  `row.id` и `allowRemote || trusted_sender` (пересоздание `iframe srcdoc` сохранено
  дословно), `mailto:`/ссылки. Здесь же сброс выбранного вида на смену письма (`picked`
  обнуляется эффектом по `row.id` — это и есть сохранённая фиксация «сброс при смене
  письма»).
- `Conversation` — карточки переписки выше/ниже письма и «N ещё»: `.card`, `.mini`,
  `.draft-tag`, `.more-line`; каркас `.thread` (рамка, `aria-label={t("conv.label")}`)
  остался у области чтения, чтобы `aria-*` не сдвинулся.
- `QuickReply` — быстрый ответ: `.quick*`-разметка и CSS; состояние и действия — в
  `useQuickReply`.
- `ReplyActions` — «Ответить/Ответить всем/Переслать» (`.acts`/`.act`): вынесены из
  `ReaderHeader`, чтобы он уложился в 350 строк.

Композаблы (состояние без разметки, возвращают объект из `use*`):

- `useAttachmentViewer.svelte.ts` — вьюер вложений в области чтения (R8, #23): какое
  вложение показано, его `at`, возврат к письму (`scrollBefore`/`closeViewer`),
  сохранение файла/всех файлов, `openAttachment`; `Viewer.svelte` получает `id`, `files`
  и `bind:at`, а тосты и заголовки диалогов остаются в области чтения (там свои `t()`).
- `useQuickReply.svelte.ts` — быстрый ответ: `quick`, `text`, `busy`, `manyRecipients`,
  `openQuick`/`setAll`/`toWindow`/`send`/`onKey` и эффект «незаконченный ответ уходит в
  окно при смене письма».

Отличия от имён в issue объяснены швами и лимитом 350 (AC10): `Header` и `Conversation`
— как названо; `QuickReply` — как названо; вместо одного `AttachmentViewer.svelte`
вьюер остался существующим `Viewer.svelte` (#23), а его сквозная логика вынесена в
`useAttachmentViewer`; дополнительно выделены `ReaderToolbar`, `ReaderStates`,
`ReaderBody` и `ReplyActions` — без них `Reader` был бы 400+ строк (панель и заголовок
одного письма не влезают в 350 вместе с телом и областью чтения), а тело письма с
`iframe srcdoc` — отдельный шов с собственным CSS. Дробления ради дробления нет:
каждый файл — смысловой блок со своим CSS.

Поведение не изменилось: классы, `role=`/`aria-*`, `data-*` и все `t()`-ключи
побайтово на месте (инварианты сверены), `e2e/run.mjs` не тронут, доверие отправителю
(`allowRemote`/`trusted_sender`/`sender_unverified`/«показать»/`trustSender`) и пересоздание
`iframe srcdoc` сохранены дословно.

### Проверка фазы

| Проверка | Результат |
| --- | --- |
| `npm run lint` | зелёный (0 ошибок; сняты 3 неактуальных подавления `Reader.svelte`) |
| `npx svelte-check --tsconfig ./tsconfig.json --fail-on-warnings` | 0 ошибок, 0 предупреждений |
| `npx vite build` | зелёный (бандл не вырос) |
| `npx vitest run` | 40 файлов, 277 тестов — зелёные |
| `cargo fmt --all --check` | чисто |
| `cargo clippy --workspace --all-targets -- -D warnings` | зелёный |
| `cargo test -p depesha-core` / `-p depesha --lib` | зелёные (2 / 24) |
| `scripts/frontend-metrics.sh` | регрессий нет (`Reader.svelte` 1299 → 310) |
| `scripts/frontend-invariants.sh` | дрейфа нет (`t_keys 559`, `app_members 85`, `role/aria 238`, `data_kinds 23`); обновлён только счётчик компонентов 60 → 67 |
| `git diff --name-only main -- '*.svelte' 'e2e'` | только `Reader.svelte` и новые `components/reader/*.svelte`; `e2e/run.mjs` без изменений |

| Файл | Строк | Ответственность |
| --- | --- | --- |
| `components/Reader.svelte` | 310 | область чтения: состояния и выбор, `iframe srcdoc`, вьюер, строка вложений, каркас `.scroll`/`.thread`/`.body-area` |
| `components/reader/ReaderHeader.svelte` | 266 | заголовок письма и строка вложений |
| `components/reader/ReaderToolbar.svelte` | 179 | панель письма, меню «Ещё»/«Переместить», кнопки плагинов |
| `components/reader/QuickReply.svelte` | 138 | разметка быстрого ответа |
| `components/reader/Conversation.svelte` | 131 | карточки переписки и «N ещё» |
| `components/reader/ReaderBody.svelte` | 109 | «HTML · Markdown · Текст» и текст (`MailFrame`, ссылки) |
| `components/reader/ReaderStates.svelte` | 99 | массовая операция, ошибка, «письмо идёт», заготовка |
| `components/reader/ReplyActions.svelte` | 65 | «Ответить/Ответить всем/Переслать» |
| `components/reader/useAttachmentViewer.svelte.ts` | 124 | вьюер вложений: показанное вложение, возврат, сохранение (R8) |
| `components/reader/useQuickReply.svelte.ts` | 121 | быстрый ответ: состояние, отправка, уход в окно |

## Итоговая приёмка

Статус: **пройдена**. Все фазы (0–5) влиты, каждая — полный `scripts/check.sh` с E2E (78 шагов, зелёные). Метрики и инварианты сверены; полный список критериев и их фактические значения — в `docs/refactoring-acceptance.md`. Два отступления, зафиксированные для оператора: лимиты AC10/AC12 по всему файлу не достигнуты для `Compose.svelte` (837 строк; критерий его же фазы — скрипт ≤ 200, выполнено) и стили сайдбара собраны в один файл `components/sidebar/sidebar.css` с префиксом `.side` вместо scoped-по-компонентам.

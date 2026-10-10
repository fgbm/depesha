// Линтер фронтенда. Правила-стражи (см. issue #48, R1) держат размер функций,
// вложенность и типизацию под контролем; остальные правила — из рекомендованных
// наборов eslint, typescript-eslint и eslint-plugin-svelte.
import js from "@eslint/js";
import globals from "globals";
import svelte from "eslint-plugin-svelte";
import tseslint from "typescript-eslint";
import silentCatch from "./scripts/eslint-silent-catch.js";

export default tseslint.config(
  {
    // Линтуется весь репозиторий (включая `plugins/`) — так правило «одна
    // команда, один охват» не обходит расширения. Сгенерированные и собранные
    // деревья не проверяем; у E2E-сценария свой стиль и своя приёмка.
    ignores: [
      "dist/**",
      "node_modules/**",
      "target/**",
      "src-tauri/**",
      "docs/**",
      "public/**",
      // E2E — отдельный сценарий поверх приложения (AC2: рефакторинг не меняет
      // `e2e/run.mjs`); его стиль и размеры фазе 0 не принадлежат.
      "e2e/**",
      // Макеты и их набор — рабочие материалы дизайна, не код приложения.
      "design/**",
      "**/*.min.js",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  ...svelte.configs["flat/recommended"],
  {
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.node,
        // Руны Svelte 5: компилятор, а не рантайм; for no-undef.
        $state: "readonly",
        $derived: "readonly",
        $props: "readonly",
        $bindable: "readonly",
        $effect: "readonly",
        $inspect: "readonly",
        $host: "readonly",
      },
    },
  },
  {
    files: ["**/*.svelte", "**/*.svelte.ts", "**/*.svelte.js"],
    languageOptions: {
      parserOptions: {
        parser: tseslint.parser,
      },
    },
  },
  {
    // Проект сознательно держит обычные Set/Map внутри классов-контроллеров
    // (ListController, AppStore и т. п.): реактивность им даёт руна `$state`
    // вокруг, а не SvelteSet/SvelteMap. Это не один из стражников R1, поэтому
    // рекомендацию плагина отключаем целиком, а не по строкам.
    rules: {
      "svelte/prefer-svelte-reactivity": "off",
      "svelte/prefer-writable-derived": "error",
    },
  },
  {
    // Стражники размера и сложности, общие для .ts и .svelte.
    files: ["**/*.{js,ts,svelte}"],
    plugins: { depesha: silentCatch },
    rules: {
      // Ни одна функция не длиннее 60 строк (AC13). Пустые строки и
      // комментарии не считаем: они не создают логической длины.
      "max-lines-per-function": ["error", { max: 60, skipBlankLines: true, skipComments: true }],
      complexity: ["error", { max: 25 }],
      "max-depth": ["error", { max: 6 }],
      "@typescript-eslint/no-explicit-any": "error",
      "no-unused-vars": "off",
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
          destructuredArrayIgnorePattern: "^_",
        },
      ],
      // Типы и руны проверяет svelte-check/tsc; no-undef в TS только мешает.
      "no-undef": "off",
      // Ошибку не глотают молча (#147): app.fail, журнал или комментарий «почему можно».
      "depesha/no-silent-catch": "error",
    },
  },
  {
    // Плагин видит ядро только через `@depesha/plugin-api` (plugins/README.md). Правило ловит
    // нарушение при вводе; `src/plugin-api/boundary.test.ts` проверяет то же по файлам.
    // Вверх по дереву (`../`) плагин не ходит вовсе: это либо ядро, либо соседний плагин.
    files: ["plugins/**/*.{ts,svelte}"],
    ignores: ["plugins/**/*.test.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              regex: "^(?!@depesha/plugin-api$|svelte(/|$)|@lucide/svelte/icons/|\\.{1,2}/)",
              message: "Плагин импортирует только @depesha/plugin-api, svelte, @lucide/svelte/icons/* и свои файлы.",
            },
            {
              regex: "^(\\./)*\\.\\./",
              message: "Из плагина нельзя подниматься вверх: ядро — только через @depesha/plugin-api, соседний плагин — никак.",
            },
          ],
        },
      ],
    },
  },
  {
    // Тесты плагинов могут тянуть тестовую обвязку ядра (фальшивый backend, i18n, раскладку
    // клавиш): они проверяют плагин в сборе с ядром. Всё остальное — как у плагина.
    files: ["plugins/**/*.test.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              regex: "^(?!@depesha/plugin-api$|svelte(/|$)|@lucide/svelte/icons/|vitest$|node:|\\.{1,2}/)",
              message: "Тест плагина импортирует только @depesha/plugin-api, svelte, vitest и свои файлы.",
            },
            {
              regex: "^(\\./)*\\.\\./(?!\\.\\./src/lib/(testing|i18n\\.svelte|keymap)$)",
              message: "Из ядра тест плагина берёт только src/lib/testing, i18n.svelte и keymap; соседний плагин — никак.",
            },
          ],
        },
      ],
    },
  },
  {
    // `import(...)` обходит правило выше: путь вычисляется или ведёт наружу. Динамический
    // импорт плагина — литерал и свой файл (или то же, что разрешено статическому).
    files: ["plugins/**/*.{ts,svelte}"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector: "ImportExpression:not([source.type='Literal'])",
          message: "import() с вычисляемым путём прячет, что берёт плагин: путь — строковый литерал.",
        },
        {
          selector: "ImportExpression[source.value=/^(?!\\.\\/|@depesha\\/plugin-api$|svelte(\\/|$)|@lucide\\/svelte\\/icons\\/)/]",
          message: "import() в плагине берёт только @depesha/plugin-api, svelte, @lucide/svelte/icons/* и файлы своей папки (./…).",
        },
      ],
    },
  },
);

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
);

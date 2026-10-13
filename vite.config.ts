import { defaultClientConditions } from "vite";
import { defineConfig } from "vitest/config";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { fileURLToPath } from "node:url";

const here = (path: string) => fileURLToPath(new URL(path, import.meta.url));

// Tauri expects a fixed port and no clearing of its own output.
export default defineConfig({
  plugins: [svelte()],
  // Plugins (plugins/) see the core only through this contract.
  resolve: {
    alias: {
      "@depesha/plugin-api": here("./src/plugin-api/index.ts"),
    },
    // A component test mounts into jsdom and needs the browser build of Svelte (`mount` is not on the server one).
    conditions: process.env.VITEST ? ["browser", ...defaultClientConditions] : undefined,
  },
  clearScreen: false,
  server: { port: 1420, strictPort: true, watch: { ignored: ["**/src-tauri/**", "**/crates/**", "**/target/**"] } },
  build: { target: "es2022", sourcemap: false, outDir: "dist" },
  test: { include: ["src/**/*.test.ts", "plugins/**/*.test.ts", "e2e/**/*.test.mjs", "scripts/**/*.test.mjs"] },
});

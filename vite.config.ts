import { defaultClientConditions } from "vite";
import { defineConfig } from "vitest/config";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { fileURLToPath } from "node:url";

// Tauri expects a fixed port and no clearing of its own output.
export default defineConfig({
  plugins: [svelte()],
  // Plugins (plugins/) see the core only through this contract.
  resolve: {
    alias: { "@depesha/plugin-api": fileURLToPath(new URL("./src/plugin-api/index.ts", import.meta.url)) },
    // A component test mounts into jsdom and needs the browser build of Svelte (`mount` is not on the server one).
    conditions: process.env.VITEST ? ["browser", ...defaultClientConditions] : undefined,
  },
  clearScreen: false,
  server: { port: 1420, strictPort: true, watch: { ignored: ["**/src-tauri/**", "**/crates/**", "**/target/**"] } },
  build: { target: "es2022", sourcemap: false },
  test: { include: ["src/**/*.test.ts", "plugins/**/*.test.ts", "e2e/**/*.test.mjs", "scripts/**/*.test.mjs"] },
});

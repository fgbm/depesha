import { defaultClientConditions, type Plugin } from "vite";
import { defineConfig } from "vitest/config";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { fileURLToPath } from "node:url";

const here = (path: string) => fileURLToPath(new URL(path, import.meta.url));

/** Where each Tauri module is stood in for in `demo` mode (`src/demo/tauri/*`). */
const TAURI_STAND_INS: Record<string, string> = {
  "@tauri-apps/api/core": "./src/demo/tauri/core.ts",
  "@tauri-apps/api/event": "./src/demo/tauri/event.ts",
  "@tauri-apps/api/window": "./src/demo/tauri/window.ts",
  "@tauri-apps/api/webview": "./src/demo/tauri/webview.ts",
  "@tauri-apps/api/app": "./src/demo/tauri/app.ts",
  "@tauri-apps/api/dpi": "./src/demo/tauri/dpi.ts",
  "@tauri-apps/plugin-dialog": "./src/demo/tauri/dialog.ts",
  "@tauri-apps/plugin-opener": "./src/demo/tauri/opener.ts",
};

/**
 * In the demo build the page opens from `file://` (a double click on `dist-demo/index.html`),
 * where the sidebar's `/icon.png` would point at the filesystem root. Vite rewrites asset URLs
 * in HTML and CSS, but not the string a component carries, so it is made relative here.
 */
function demoAssets(): Plugin {
  return {
    name: "depesha-demo-assets",
    apply: "build",
    renderChunk(code) {
      if (!code.includes('"/icon.png"')) return null;
      return { code: code.replaceAll('"/icon.png"', '"./icon.png"'), map: null };
    },
  };
}

/**
 * The demo bundle is one classic script (`iife`, dynamic imports inlined — see the build
 * options), but Vite still writes the entry as a module. A module script is refused from
 * `file://` for a CORS reason, so the attributes that make it one are dropped: what is left
 * is a plain `<script src="./assets/index.js">`, which a double click runs.
 */
function demoIndex(): Plugin {
  return {
    name: "depesha-demo-index",
    apply: "build",
    transformIndexHtml: {
      order: "post",
      handler(html: string) {
        // `defer`: the app mounts into `#app`, which a script in `<head>` runs before.
        return html.replaceAll('<script type="module" crossorigin ', "<script defer ").replaceAll(' crossorigin', "");
      },
    },
  };
}

// Tauri expects a fixed port and no clearing of its own output.
export default defineConfig(({ mode }) => {
  const demo = mode === "demo";
  return {
    plugins: [svelte(), ...(demo ? [demoAssets(), demoIndex()] : [])],
    // Plugins (plugins/) see the core only through this contract.
    resolve: {
      alias: {
        "@depesha/plugin-api": here("./src/plugin-api/index.ts"),
        // `src/main.ts` calls the panel through this alias: the demo entry in `demo` mode,
        // a no-op otherwise. It keeps the entry the same in both builds.
        "@demo/start": here(demo ? "./src/demo/start.ts" : "./src/lib/demo-off.ts"),
        ...(demo
          ? Object.fromEntries(Object.entries(TAURI_STAND_INS).map(([pkg, path]) => [pkg, here(path)]))
          : {}),
      },
      // A component test mounts into jsdom and needs the browser build of Svelte (`mount` is not on the server one).
      conditions: process.env.VITEST ? ["browser", ...defaultClientConditions] : undefined,
    },
    clearScreen: false,
    server: { port: demo ? 1421 : 1420, strictPort: true, watch: { ignored: ["**/src-tauri/**", "**/crates/**", "**/target/**"] } },
    // The demo is a static site opened from a file or any static server: relative base, own folder.
    base: demo ? "./" : undefined,
    build: demo
      ? {
          target: "es2022",
          sourcemap: false,
          outDir: "dist-demo",
          // A double click on index.html opens it from `file://`, where a browser refuses a
          // module script (and its dynamic imports) for a CORS reason. One classic script,
          // everything inlined, loads from a file and from a server alike.
          modulePreload: false,
          rollupOptions: { output: { format: "iife", inlineDynamicImports: true } },
        }
      : { target: "es2022", sourcemap: false, outDir: "dist" },
    test: { include: ["src/**/*.test.ts", "plugins/**/*.test.ts", "e2e/**/*.test.mjs", "scripts/**/*.test.mjs"] },
  };
});

<script lang="ts">
  import { t } from "../lib/i18n.svelte";
  import { FRAME_RELAY, RELAY_HASH, THEME_VARS, frameMessage, keysMessage, themeMessage, toFrame } from "../lib/frameRelay";
  import { frameTakes } from "../lib/frameKeys";
  // Renders sanitized message HTML in a sandboxed iframe: nothing of the letter runs, no network
  // except images the user allowed, links go through onLink.
  // `allow-scripts` without `allow-same-origin` (#124): the frame has an opaque origin, so a letter
  // script that got past the policy can reach nothing of the app's. `allow-scripts` is still needed
  // — WebKitGTK runs no listener at all in a frame sandboxed without scripts (#70) — so the one
  // script the frame runs is the relay Depesha writes (frameRelay.ts), allowed by its hash, talking
  // to the app through postMessage alone. On Windows wry puts Tauri's scripts into every frame, so
  // there the policy (no script but the relay, no connection) and the ACL of an `about:srcdoc`
  // source (Remote, no capability) keep the frame off IPC, not the sandbox alone.
  // A srcdoc document also takes the window's CSP (tauri.conf.json), and its own <meta> only
  // narrows it: so the window's policy keeps `img-src https: http:` (remote images, once
  // allowed) and `style-src 'unsafe-inline'` (the letters' own styles) for this frame alone, and
  // lists the relay's hash too.
  let {
    html,
    allowRemote,
    onLink,
    themed = false,
    markdown = false,
    takes = [],
  }: {
    html: string;
    allowRemote: boolean;
    onLink: (href: string) => void;
    /** Drawn in the theme's colours on the page behind it (Depesha's own Markdown); else on white, as the sender wrote it. */
    themed?: boolean;
    /** Depesha rendered this from Markdown: its bare tables get a grid; an HTML letter lays out its own. */
    markdown?: boolean;
    /** Keys the surroundings take besides the window's own (VIEWER_TAKES), which the relay stops by itself. */
    takes?: string[];
  } = $props();

  let frame = $state<HTMLIFrameElement | null>(null);
  let hover = $state("");

  function themeCss(): string {
    const css = getComputedStyle(document.documentElement);
    // The same color-scheme as the window, or WebView2 paints the frame opaque.
    const vars = THEME_VARS.map((v) => `${v}:${css.getPropertyValue(v).trim()}`).join(";");
    return `:root{color-scheme:${css.colorScheme || "light"};${vars};--md-line:var(--line);--md-head:color-mix(in srgb, var(--line) 55%, transparent)}
html{background:transparent;color:var(--ink)}
blockquote{margin:0 0 0 4px;padding-left:12px;border-left:3px solid var(--line);color:var(--muted)}
a{color:var(--link)}`;
  }

  /** A grid for the bare tables pulldown-cmark writes out of Markdown; a letter's own HTML lays out its own. */
  function markdownCss(): string {
    // `display:block` lets a table wider than the frame scroll sideways instead of stretching
    // the page; a cell keeps the text-align pulldown-cmark put inline. Light greys by default,
    // the theme's own line in a themed frame (themeCss overrides the two variables).
    return `:root{--md-line:#d9dde3;--md-head:#f0f1f3}
body table{border-collapse:collapse;display:block;width:max-content;max-width:100%;overflow-x:auto}
body th,body td{border:1px solid var(--md-line);padding:4px 10px}
body th{background:var(--md-head);font-weight:600}`;
  }

  /**
   * The frame's own policy, whatever the window's says (and in `dev`, where it is another one):
   * the relay and no other script, no plugins, no frames, no `<base>`, no forms, no connection.
   * Pictures from the network only when allowed; the letters' own styles.
   */
  const csp = $derived(
    `default-src 'none'; script-src ${RELAY_HASH}; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'; connect-src 'none'; img-src data: ${allowRemote ? "https: http:" : ""}; style-src 'unsafe-inline'; font-src data:`,
  );

  // The relay in the frame's head. Its closing tag is spelled in two parts: written whole, it
  // would end this component's own script block.
  const RELAY_ELEMENT = `<script>${FRAME_RELAY}</scr` + `ipt>`;

  // The policy comes first in the head: nothing the letter writes can stand before it.
  const srcdoc = $derived(`<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${csp}">
<meta charset="utf-8">
<meta http-equiv="x-dns-prefetch-control" content="off">
${RELAY_ELEMENT}
<style>
html{background:#fff;color:#1d232b}
body{margin:18px 22px;font:14px/1.5 system-ui,"Segoe UI",Roboto,"Noto Sans",Arial,sans-serif;overflow-wrap:anywhere}
img{max-width:100%;height:auto}
table{max-width:100%}
pre{white-space:pre-wrap}
blockquote{margin:0 0 0 4px;padding-left:12px;border-left:3px solid #d5dbe3;color:#55606c}
a{color:#1f5fa8}
${markdown ? markdownCss() : ""}
${themed ? themeCss() : ""}
</style></head><body>${html}</body></html>`);

  /** Another theme picked, or the system's changed: a themed frame follows without reloading. */
  function repaint() {
    if (themed) toFrame(frame?.contentWindow, themeMessage(getComputedStyle(document.documentElement)));
  }

  /** What the frame must know before the first press: the keys the app takes, and the theme. */
  function sync() {
    toFrame(frame?.contentWindow, keysMessage(frameTakes(takes)));
    repaint();
  }

  // With the load, and again whenever the frame, the keys or the layout change.
  $effect(sync);

  $effect(() => {
    if (!themed) return;
    const theme = new MutationObserver(repaint);
    theme.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    const system = matchMedia("(prefers-color-scheme: dark)");
    system.addEventListener("change", repaint);
    return () => {
      theme.disconnect();
      system.removeEventListener("change", repaint);
    };
  });

  /**
   * What the relay of the frame says: a link, a hover, a key. Only the frame's own window is
   * heard — a letter's script runs in it by then, and everything else is a stranger.
   */
  function onMessage(e: MessageEvent) {
    const el = frame;
    if (!el || e.source !== el.contentWindow) return;
    const msg = frameMessage(e.data);
    if (!msg) return;
    if (msg.type === "hover") {
      hover = msg.href;
      return;
    }
    if (msg.type === "link") {
      // A message is a stranger's word: an empty address and an anchor of the letter stay inside.
      if (msg.href && !msg.href.startsWith("#")) onLink(msg.href);
      return;
    }
    // Keys pressed in the frame reach no listener of the window: they are replayed on the iframe
    // element, which does, so the app's shortcuts work after a click into the message. The plain
    // arrows are the relay's to keep, and so is the default of a key the app may take.
    el.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: msg.key,
        code: msg.code,
        ctrlKey: msg.ctrlKey,
        metaKey: msg.metaKey,
        altKey: msg.altKey,
        shiftKey: msg.shiftKey,
        repeat: msg.repeat,
        bubbles: true,
        cancelable: true,
      }),
    );
  }

  $effect(() => {
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  });
</script>

<div class="wrap">
  <iframe class:themed bind:this={frame} title={t("reader.message")} sandbox="allow-scripts" {srcdoc} onload={sync}></iframe>
  {#if hover}<div class="status" title={hover}>{hover}</div>{/if}
</div>

<style>
  .wrap {
    position: relative;
    flex: 1;
    min-height: 0;
    display: flex;
  }

  iframe {
    flex: 1;
    border: none;
    background: #fff;
    border-radius: 6px;
  }

  iframe.themed {
    background: transparent;
  }

  .status {
    position: absolute;
    left: 6px;
    bottom: 6px;
    max-width: calc(100% - 12px);
    background: var(--side);
    color: var(--side-ink);
    font-size: 12px;
    padding: 3px 8px;
    border-radius: 4px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    pointer-events: none;
  }
</style>

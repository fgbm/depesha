<script lang="ts">
  import { t } from "../lib/i18n.svelte";
  import { linkAt } from "../lib/frameLink";
  // Renders sanitized message HTML in a sandboxed iframe: no scripts, no network
  // except images the user allowed, links go through onLink.
  // `allow-scripts` is there for the page's own listeners, not for the letter's scripts: WebKitGTK does
  // not run a listener the page added to the document of a frame sandboxed without scripts, so
  // links, hover and keys of the letter's text were dead (#70). Scripts of the letter stay shut by the
  // frame's own Content-Security-Policy (`default-src 'none'`), by the window's (`script-src 'self'`)
  // and by the sanitizer; the sandbox still keeps forms, popups and top navigation off.
  // A srcdoc document also takes the window's CSP (tauri.conf.json), and its own <meta> only
  // narrows it: so the window's policy keeps `img-src https: http:` (remote images, once
  // allowed) and `style-src 'unsafe-inline'` (the letters' own styles) for this frame alone.
  let {
    html,
    allowRemote,
    onLink,
    themed = false,
    markdown = false,
  }: {
    html: string;
    allowRemote: boolean;
    onLink: (href: string) => void;
    /** Drawn in the theme's colours on the page behind it (Depesha's own Markdown); else on white, as the sender wrote it. */
    themed?: boolean;
    /** Depesha rendered this from Markdown: its bare tables get a grid; an HTML letter lays out its own. */
    markdown?: boolean;
  } = $props();

  let frame = $state<HTMLIFrameElement | null>(null);
  let hover = $state("");

  /** The theme's colours a themed frame takes from the window, which the frame's document cannot see. */
  const THEME_VARS = ["--ink", "--muted", "--line", "--link"];

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
   * no script of any kind, no plugins, no frames, no `<base>`, no forms. Pictures from the
   * network only when allowed; the letters' own styles.
   */
  const csp = $derived(
    `default-src 'none'; script-src 'none'; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'; img-src data: ${allowRemote ? "https: http:" : ""}; style-src 'unsafe-inline'; font-src data:`,
  );

  // The policy comes first in the head: nothing the letter writes can stand before it.
  const srcdoc = $derived(`<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${csp}">
<meta charset="utf-8">
<meta http-equiv="x-dns-prefetch-control" content="off">
<style>
html{background:#fff;color:#1d232b}
body{margin:18px 22px;font:14px/1.5 system-ui,"Segoe UI",Roboto,"Noto Sans",Arial,sans-serif;overflow-wrap:anywhere}
img{max-width:100%;height:auto}
table{max-width:100%}
pre{white-space:pre-wrap}
blockquote{margin:0 0 0 4px;padding-left:12px;border-left:3px solid #d8cfbd;color:#55606c}
a{color:#1f5fa8}
${markdown ? markdownCss() : ""}
${themed ? themeCss() : ""}
</style></head><body>${html}</body></html>`);

  /** Another theme picked, or the system's changed: a themed frame follows without reloading. */
  function repaint() {
    const root = frame?.contentDocument?.documentElement;
    if (!root) return;
    const css = getComputedStyle(document.documentElement);
    root.style.colorScheme = css.colorScheme || "light";
    for (const v of THEME_VARS) root.style.setProperty(v, css.getPropertyValue(v).trim());
  }

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

  /** The documents that already have the listeners: a load and the first look must not add them twice. */
  const attached = new WeakSet<Document>();

  /**
   * Takes the frame's own element, not `frame`: WebKitGTK may load the document before
   * `bind:this` has set `frame` (the load comes with the srcdoc), and a handler that waits
   * for `frame` finds nothing, so no link, hover or key of the letter's text reaches the app.
   */
  function attach(el: HTMLIFrameElement | null) {
    const doc = el?.contentDocument;
    if (!el || !doc || attached.has(doc)) return;
    attached.add(doc);
    doc.addEventListener("click", (e) => {
      const a = linkAt(e.target);
      if (!a) return;
      e.preventDefault();
      const href = a.getAttribute("href") ?? "";
      if (href && !href.startsWith("#")) onLink(href);
    });
    doc.addEventListener("mouseover", (e) => {
      const a = linkAt(e.target);
      hover = a?.getAttribute("href") ?? "";
    });
    doc.addEventListener("mouseleave", () => (hover = ""));
    // Keys pressed inside the frame never reach the window: replay them on the
    // iframe element so the app shortcuts work after a click into the message.
    // Plain arrows stay with the frame and scroll the message.
    doc.addEventListener("keydown", (e) => {
      if ((e.key === "ArrowDown" || e.key === "ArrowUp") && !e.ctrlKey && !e.metaKey && !e.altKey) return;
      const copy = new KeyboardEvent("keydown", {
        key: e.key,
        code: e.code,
        ctrlKey: e.ctrlKey,
        metaKey: e.metaKey,
        altKey: e.altKey,
        shiftKey: e.shiftKey,
        repeat: e.repeat,
        bubbles: true,
        cancelable: true,
      });
      if (!el.dispatchEvent(copy)) e.preventDefault();
    });
  }

  // The load may have come before the frame was bound: look at the document once it is.
  $effect(() => attach(frame));
</script>

<div class="wrap">
  <iframe class:themed bind:this={frame} title={t("reader.message")} sandbox="allow-same-origin allow-scripts" {srcdoc} onload={(e) => attach(e.currentTarget as HTMLIFrameElement)}></iframe>
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

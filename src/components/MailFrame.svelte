<script lang="ts">
  import { t } from "../lib/i18n.svelte";
  // Renders sanitized message HTML in a sandboxed iframe: no scripts, no network
  // except images the user allowed, links go through onLink.
  // A srcdoc document also takes the window's CSP (tauri.conf.json), and its own <meta> only
  // narrows it: so the window's policy keeps `img-src https: http:` (remote images, once
  // allowed) and `style-src 'unsafe-inline'` (the letters' own styles) for this frame alone.
  let {
    html,
    allowRemote,
    onLink,
  }: { html: string; allowRemote: boolean; onLink: (href: string) => void } = $props();

  let frame = $state<HTMLIFrameElement | null>(null);
  let hover = $state("");

  const srcdoc = $derived(`<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: ${allowRemote ? "https: http:" : ""}; style-src 'unsafe-inline'; font-src data:">
<style>
html{background:#fff;color:#1d232b}
body{margin:18px 22px;font:14px/1.5 system-ui,"Segoe UI",Roboto,"Noto Sans",Arial,sans-serif;overflow-wrap:anywhere}
img{max-width:100%;height:auto}
table{max-width:100%}
pre{white-space:pre-wrap}
blockquote{margin:0 0 0 4px;padding-left:12px;border-left:3px solid #d8cfbd;color:#55606c}
a{color:#1f5fa8}
</style></head><body>${html}</body></html>`);

  function attach() {
    const doc = frame?.contentDocument;
    if (!doc) return;
    doc.addEventListener("click", (e) => {
      const a = (e.target as Element | null)?.closest?.("a");
      if (!a) return;
      e.preventDefault();
      const href = a.getAttribute("href") ?? "";
      if (href && !href.startsWith("#")) onLink(href);
    });
    doc.addEventListener("mouseover", (e) => {
      const a = (e.target as Element | null)?.closest?.("a");
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
      if (!frame?.dispatchEvent(copy)) e.preventDefault();
    });
  }
</script>

<div class="wrap">
  <iframe bind:this={frame} title={t("reader.message")} sandbox="allow-same-origin" {srcdoc} onload={attach}></iframe>
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

<script lang="ts">
  // PDF through pdf.js, the same on every system: WebKitGTK has no PDF viewer of its own.
  // Pages are drawn as they scroll into view; their text can be selected and copied.
  import { onDestroy } from "svelte";
  import Minus from "@lucide/svelte/icons/minus";
  import Plus from "@lucide/svelte/icons/plus";
  import type { PDFDocumentProxy, PDFDocumentLoadingTask } from "pdfjs-dist";
  import { t } from "../../lib/i18n.svelte";
  import type { ViewedFile } from "../../lib/viewer";

  let { file }: { file: ViewedFile } = $props();

  let doc = $state<PDFDocumentProxy | null>(null);
  /** Size of each page at scale 1, to lay them out before they are drawn. */
  let sizes = $state<{ w: number; h: number }[]>([]);
  /** Zoom; null fits the page width. */
  let zoom = $state<number | null>(null);
  let width = $state(0);
  let current = $state(1);
  let scroller = $state<HTMLDivElement | null>(null);
  let task: PDFDocumentLoadingTask | null = null;

  const fit = $derived(sizes.length && width ? Math.min(2, (width - 48) / sizes[0].w) : 1);
  const scale = $derived(zoom ?? fit);

  $effect(() => {
    let gone = false;
    (async () => {
      const bytes = await file.bytes();
      const pdfjs = await import("pdfjs-dist");
      const worker = (await import("pdfjs-dist/build/pdf.worker.min.mjs?url")).default;
      pdfjs.GlobalWorkerOptions.workerSrc = worker;
      // pdf.js takes the buffer over: a copy keeps the original for "Save".
      task = pdfjs.getDocument({ data: new Uint8Array(bytes.slice(0)), enableXfa: false });
      const d = await task.promise;
      if (gone) return void d.cleanup();
      const list: { w: number; h: number }[] = [];
      for (let i = 1; i <= d.numPages; i++) {
        const vp = (await d.getPage(i)).getViewport({ scale: 1 });
        list.push({ w: vp.width, h: vp.height });
      }
      sizes = list;
      doc = d;
    })().catch((e) => !gone && file.fail(e));
    return () => {
      gone = true;
    };
  });

  onDestroy(() => {
    task?.destroy();
  });

  /** Draws one page into its slot when the slot comes near the view. */
  function page(slot: HTMLDivElement, { n }: { n: number; scale: number }) {
    let drawn = -1;
    let busy = false;
    let visible = false;
    const draw = async () => {
      if (!doc || busy || drawn === scale || !visible) return;
      busy = true;
      const s = scale;
      try {
        const p = await doc.getPage(n);
        const vp = p.getViewport({ scale: s });
        const ratio = window.devicePixelRatio || 1;
        const canvas = document.createElement("canvas");
        canvas.width = Math.floor(vp.width * ratio);
        canvas.height = Math.floor(vp.height * ratio);
        canvas.style.width = `${vp.width}px`;
        canvas.style.height = `${vp.height}px`;
        const ctx = canvas.getContext("2d")!;
        await p.render({ canvas, canvasContext: ctx, viewport: vp, transform: ratio !== 1 ? [ratio, 0, 0, ratio, 0, 0] : undefined }).promise;
        const { TextLayer } = await import("pdfjs-dist");
        const text = document.createElement("div");
        text.className = "textLayer";
        slot.style.setProperty("--total-scale-factor", String(s));
        await new TextLayer({ textContentSource: p.streamTextContent(), container: text, viewport: vp }).render();
        slot.replaceChildren(canvas, text);
        drawn = s;
      } catch (e) {
        console.error("pdf page", n, e);
      } finally {
        busy = false;
      }
      // Zoomed while drawing: draw again at the new scale.
      if (drawn !== scale) draw();
    };
    const io = new IntersectionObserver(
      ([e]) => {
        visible = e.isIntersecting;
        if (visible) {
          draw();
            if (e.intersectionRatio > 0.5) current = n;
        }
      },
      { root: scroller, rootMargin: "600px 0px", threshold: [0, 0.5] },
    );
    io.observe(slot);
    return {
      // Zoom redraws the pages in view; the others wait until they are scrolled to.
      update: () => draw(),
      destroy: () => io.disconnect(),
    };
  }

  function step(dir: 1 | -1) {
    const next = Math.min(4, Math.max(0.25, Math.round((scale + dir * 0.25) * 4) / 4));
    zoom = next;
  }

  function onWheel(e: WheelEvent) {
    if (!e.ctrlKey) return;
    e.preventDefault();
    step(e.deltaY < 0 ? 1 : -1);
  }
</script>

<div class="pdf">
  <div class="bar">
    <span class="muted">{doc ? t("viewer.page", { n: current, total: sizes.length }) : t("loading")}</span>
    <span class="sep"></span>
    <button class="btn ghost icon" onclick={() => step(-1)} title={t("viewer.zoomOut")} aria-label={t("viewer.zoomOut")}><Minus size={15} /></button>
    <button class="btn ghost zoom" onclick={() => (zoom = null)} title={t("viewer.fitWidth")}>{Math.round(scale * 100)}%</button>
    <button class="btn ghost icon" onclick={() => step(1)} title={t("viewer.zoomIn")} aria-label={t("viewer.zoomIn")}><Plus size={15} /></button>
  </div>
  <div class="pages" bind:this={scroller} bind:clientWidth={width} onwheel={onWheel}>
    {#if doc}
      {#each sizes as s, i (i)}
        <div class="page" style:width="{s.w * scale}px" style:height="{s.h * scale}px" use:page={{ n: i + 1, scale }}></div>
      {/each}
    {/if}
  </div>
</div>

<style>
  .pdf {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
  }

  .bar {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 4px 12px;
    font-size: 13px;
    font-variant-numeric: tabular-nums;
  }

  .sep {
    flex: 1;
  }

  .zoom {
    min-width: 58px;
    justify-content: center;
    font-variant-numeric: tabular-nums;
  }

  .icon {
    min-width: 32px;
    justify-content: center;
  }

  .pages {
    flex: 1;
    min-height: 0;
    overflow: auto;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 12px;
    padding: 12px 24px 24px;
    background: var(--paper-2);
  }

  .page {
    position: relative;
    flex: none;
    background: #fff;
    box-shadow: 0 1px 4px rgb(0 0 0 / 18%);
  }

  .page :global(canvas) {
    display: block;
  }

  /* The text layer of pdf.js, trimmed to what selection needs (pdf_viewer.css carries a whole viewer). */
  .page :global(.textLayer) {
    position: absolute;
    inset: 0;
    overflow: clip;
    line-height: 1;
    text-align: initial;
    text-size-adjust: none;
    forced-color-adjust: none;
    transform-origin: 0 0;
    --min-font-size: 1;
    --text-scale-factor: calc(var(--total-scale-factor) * var(--min-font-size));
    --min-font-size-inv: calc(1 / var(--min-font-size));
  }

  .page :global(.textLayer :is(span, br)) {
    color: transparent;
    position: absolute;
    white-space: pre;
    cursor: text;
    transform-origin: 0% 0%;
    user-select: text;
  }

  .page :global(.textLayer > :not(.markedContent)),
  .page :global(.textLayer .markedContent span:not(.markedContent)) {
    --font-height: 0;
    font-size: calc(var(--text-scale-factor) * var(--font-height));
    --scale-x: 1;
    --rotate: 0deg;
    transform: rotate(var(--rotate)) scaleX(var(--scale-x)) scale(var(--min-font-size-inv));
  }

  .page :global(.textLayer .markedContent) {
    display: contents;
  }

  .page :global(.textLayer ::selection) {
    background: rgb(0 90 200 / 25%);
  }
</style>

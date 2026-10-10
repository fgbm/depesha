<script lang="ts">
  // The attachment viewer: one shell for every format. The renderer comes from the
  // registry (src/lib/viewer.ts): the core's formats and plugins' are chosen alike.
  // It takes the place of the letter's text in the reading pane; ←/→ go through the
  // letter's attachments, Esc closes; what cannot be shown is offered to its application.
  import X from "@lucide/svelte/icons/x";
  import Download from "@lucide/svelte/icons/download";
  import ExternalLink from "@lucide/svelte/icons/external-link";
  import ChevronLeft from "@lucide/svelte/icons/chevron-left";
  import ChevronRight from "@lucide/svelte/icons/chevron-right";
  import FileQuestion from "@lucide/svelte/icons/file-question";
  import { api, asError } from "../lib/api";
  import { size } from "../lib/format";
  import { t } from "../lib/i18n.svelte";
  import { app } from "../lib/store.svelte";
  import type { AttachmentInfo } from "../lib/types";
  import { decodeText, pickViewer, type ViewedFile } from "../lib/viewer";
  import { registry } from "../plugin-host/registry.svelte";

  let {
    id,
    files,
    at = $bindable(),
    onClose,
    onSave,
    onOpenApp,
  }: {
    /** The letter the attachments belong to. */
    id: number;
    files: AttachmentInfo[];
    /** Position in `files` shown; the attachments row highlights it. */
    at: number;
    onClose: () => void;
    onSave: (a: AttachmentInfo) => void;
    onOpenApp: (a: AttachmentInfo) => void;
  } = $props();

  let el = $state<HTMLElement | null>(null);
  // Keys come here at once, not to the attachment that was clicked.
  $effect(() => el?.focus({ preventScroll: true }));
  const a = $derived(files[Math.min(at, files.length - 1)]);
  const viewer = $derived(a ? pickViewer(registry.items("fileViewers"), a.name, a.mime) : null);
  /** Why the renderer gave up; the fallback offers the application instead. */
  let failed = $derived.by<string | null>(() => {
    void file;
    return null;
  });
  let loading = $state(false);

  /** The file as renderers see it; content is fetched once per opening. */
  const file = $derived.by((): ViewedFile => {
    const info = a;
    let bytes: Promise<ArrayBuffer> | null = null;
    const load = () => {
      if (!bytes) {
        loading = true;
        bytes = api.attachmentBytes(id, info.index).finally(() => (loading = false));
      }
      return bytes;
    };
    return {
      name: info.name,
      mime: info.mime,
      size: info.size,
      bytes: load,
      text: async () => decodeText(new Uint8Array(await load())),
      openLink: (href) => app.openLink(href),
      fail: (e) => {
        console.error(`viewer ${info.name}:`, e);
        failed = asError(e).message;
      },
    };
  });

  function go(step: 1 | -1) {
    if (files.length < 2) return;
    at = (at + step + files.length) % files.length;
  }

  // Capture on the window takes only the viewer's own keys; the app's shortcuts
  // (j/k, e, r…) keep working on the letter. Esc closes the top layer only:
  // a dialog or a menu goes first, the viewer next, the letter's window last.
  function onKey(e: KeyboardEvent) {
    if (app.confirmation) return;
    const target = e.target as HTMLElement | null;
    const typing = target?.closest?.("input, textarea, select, [contenteditable]");
    if (target?.closest?.(".compose")) return;
    if (e.key === "Escape") {
      if (document.querySelector(".pop, .modal, .palette")) return;
      onClose();
    } else if (!typing && !e.ctrlKey && !e.metaKey && !e.altKey && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
      // A menu open over the viewer (the list of the letter's files) keeps its arrows: → goes to a row's «Save».
      if (document.querySelector(".pop") || target?.closest?.(".pop")) return;
      go(e.key === "ArrowLeft" ? -1 : 1);
    } else if (!typing && (e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === "s") {
      onSave(a);
    } else {
      return;
    }
    e.preventDefault();
    e.stopPropagation();
  }
</script>

<svelte:window onkeydowncapture={onKey} />

{#if a}
  <div class="viewer" role="region" aria-label={a.name} tabindex="-1" bind:this={el}>
    <header>
      {#if files.length > 1}
        <button class="btn ghost icon" onclick={() => go(-1)} title={t("viewer.prev")} aria-label={t("viewer.prev")}><ChevronLeft size={17} /></button>
        <span class="count muted">{at + 1} / {files.length}</span>
        <button class="btn ghost icon" onclick={() => go(1)} title={t("viewer.next")} aria-label={t("viewer.next")}><ChevronRight size={17} /></button>
      {/if}
      <span class="name" title={a.name} aria-live="polite">{a.name}</span>
      <span class="size muted">{size(a.size)}</span>
      {#if loading}<span class="dot" aria-label={t("loading")}></span>{/if}
      <span class="sep"></span>
      <button class="btn ghost" onclick={() => onSave(a)} title={t("file.save")}><Download size={15} /><span class="lbl">{t("file.save")}</span></button>
      <button class="btn ghost" onclick={() => onOpenApp(a)} title={t("viewer.openApp")}><ExternalLink size={15} /><span class="lbl">{t("viewer.openApp")}</span></button>
      <button class="btn ghost icon" onclick={onClose} title={t("viewer.close")} aria-label={t("viewer.close")}><X size={17} /></button>
    </header>

    <div class="stage">
      {#if viewer && !failed}
        {#key file}
          <viewer.component {...viewer.props ?? {}} {file} />
        {/key}
      {:else}
        <div class="fallback">
          <FileQuestion size={40} strokeWidth={1.4} />
          <p>{failed ? t("viewer.failed") : t("viewer.unknown")}</p>
          {#if failed}<p class="muted small">{failed}</p>{/if}
          <div class="buttons">
            <button class="btn primary" onclick={() => onOpenApp(a)}><ExternalLink size={15} /> {t("viewer.openApp")}</button>
            <button class="btn" onclick={() => onSave(a)}><Download size={15} /> {t("file.save")}</button>
          </div>
        </div>
      {/if}
    </div>
  </div>
{/if}

<style>
  /* In the reading pane, in place of the letter's text: what is left of its height. */
  .viewer {
    flex: 1;
    /* The pane gives it no less than the composition window gives the text (#103, 2.2 Б): a low pane scrolls. */
    min-height: 160px;
    display: flex;
    flex-direction: column;
    margin: 0 16px 16px;
    border: 1px solid var(--line);
    border-radius: 8px;
    overflow: hidden;
    background: var(--paper-2);
    container-type: inline-size;
    outline: none;
  }

  header {
    display: flex;
    align-items: center;
    gap: 6px;
    min-height: 42px;
    padding: 4px 6px 4px 8px;
    border-bottom: 1px solid var(--line);
    background: var(--paper);
  }

  .name {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-weight: 600;
    margin-left: 4px;
  }

  .size,
  .count {
    flex: none;
    font-size: 12px;
    font-variant-numeric: tabular-nums;
  }

  .sep {
    flex: 1;
  }

  .icon {
    min-width: 32px;
    justify-content: center;
  }

  @container (max-width: 520px) {
    .lbl {
      display: none;
    }
  }

  /* Loading: a quiet pulse next to the name, the stage keeps its layout. */
  .dot {
    flex: none;
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--accent);
    animation: pulse 1s ease-in-out infinite;
  }

  @keyframes pulse {
    50% {
      opacity: 0.25;
    }
  }

  .stage {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
  }

  .fallback {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 8px;
    padding: 24px;
    text-align: center;
    color: var(--muted);
  }

  .fallback p {
    margin: 0;
    color: var(--ink);
  }

  .fallback .small {
    font-size: 12px;
    color: var(--muted);
    max-width: 520px;
    overflow-wrap: anywhere;
  }

  .buttons {
    display: flex;
    gap: 8px;
    margin-top: 8px;
  }
</style>

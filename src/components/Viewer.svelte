<script lang="ts">
  // The attachment viewer: one shell for every format. The renderer comes from the
  // registry (src/lib/viewer.ts): the core's formats and plugins' are chosen alike.
  // ←/→ go through the letter's attachments, Esc closes; what cannot be shown is
  // offered to its application.
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
    start,
    onClose,
    onSave,
    onOpenApp,
  }: {
    /** The letter the attachments belong to. */
    id: number;
    files: AttachmentInfo[];
    /** Position in `files` to show first. */
    start: number;
    onClose: () => void;
    onSave: (a: AttachmentInfo) => void;
    onOpenApp: (a: AttachmentInfo) => void;
  } = $props();

  // svelte-ignore state_referenced_locally
  let at = $state(start);
  const a = $derived(files[Math.min(at, files.length - 1)]);
  const viewer = $derived(a ? pickViewer(registry.items("fileViewers"), a.name, a.mime) : null);
  /** Why the renderer gave up; the fallback offers the application instead. */
  let failed = $state<string | null>(null);
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

  $effect(() => {
    void file;
    failed = null;
  });

  function go(step: 1 | -1) {
    if (files.length < 2) return;
    at = (at + step + files.length) % files.length;
  }

  // Capture on the window: the app's shortcuts underneath stay quiet while the viewer is open.
  function onKey(e: KeyboardEvent) {
    if (app.confirmation) return;
    const typing = (e.target as HTMLElement | null)?.closest?.("input, textarea, [contenteditable]");
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    } else if (!typing && !e.ctrlKey && !e.metaKey && !e.altKey && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
      e.preventDefault();
      go(e.key === "ArrowLeft" ? -1 : 1);
    } else if (!typing && (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
      e.preventDefault();
      onSave(a);
    } else {
      // Copy and select-all still work inside the renderer.
      if ((e.ctrlKey || e.metaKey) && ["c", "a"].includes(e.key.toLowerCase())) return;
    }
    e.stopPropagation();
  }
</script>

<svelte:window onkeydowncapture={onKey} />

{#if a}
  <div class="viewer" role="dialog" aria-modal="true" aria-label={a.name}>
    <header data-tauri-drag-region>
      {#if files.length > 1}
        <button class="btn ghost icon" onclick={() => go(-1)} title={t("viewer.prev")} aria-label={t("viewer.prev")}><ChevronLeft size={17} /></button>
        <span class="count muted" data-tauri-drag-region>{at + 1} / {files.length}</span>
        <button class="btn ghost icon" onclick={() => go(1)} title={t("viewer.next")} aria-label={t("viewer.next")}><ChevronRight size={17} /></button>
      {/if}
      <span class="name" title={a.name} data-tauri-drag-region>{a.name}</span>
      <span class="size muted" data-tauri-drag-region>{size(a.size)}</span>
      {#if loading}<span class="dot" aria-label={t("loading")}></span>{/if}
      <span class="sep" data-tauri-drag-region></span>
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
  /* Over the whole window, under toasts (30), dialogs (50) and the window controls (60). */
  .viewer {
    position: fixed;
    inset: 0;
    z-index: 25;
    display: flex;
    flex-direction: column;
    background: var(--paper-2);
    container-type: inline-size;
  }

  header {
    display: flex;
    align-items: center;
    gap: 6px;
    min-height: 46px;
    /* The right edge stays clear for the window controls (WindowControls.svelte). */
    padding: 6px 144px 6px 10px;
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

  @container (max-width: 640px) {
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

<script lang="ts">
  // The attachments of an opened letter: chips in at most two rows, the rest behind «+N more ›»
  // in the same list as the composition window's (AttachmentMenu). The rows are counted by the
  // pane's real width and the chips' real widths, and again whenever the pane is resized.
  import Paperclip from "@lucide/svelte/icons/paperclip";
  import Download from "@lucide/svelte/icons/download";
  import FolderOutput from "@lucide/svelte/icons/folder-output";
  import { size } from "../../lib/format";
  import { t } from "../../lib/i18n.svelte";
  import { foldChips } from "../../lib/attachFold";
  import type { AttachmentInfo } from "../../lib/types";
  import AttachmentMenu, { type RowAction } from "../AttachmentMenu.svelte";

  let {
    files,
    viewing,
    viewingAt,
    onViewAttachment,
    onSaveAttachment,
    onSaveAttachmentAs,
    onSaveAll,
    saveDir,
  }: {
    /** The letter's files, minus the pictures drawn in its text. */
    files: AttachmentInfo[];
    /** An attachment is shown in place of the letter. */
    viewing: boolean;
    /** The shown attachment's place among the files. */
    viewingAt: number;
    onViewAttachment: (a: AttachmentInfo) => void;
    onSaveAttachment: (a: AttachmentInfo) => void;
    onSaveAttachmentAs: (a: AttachmentInfo) => void;
    onSaveAll: () => void;
    /** The folder the save button names; empty: the file dialog asks. */
    saveDir: string;
  } = $props();

  /** The strip's width: the rows are counted for it. */
  let avail = $state(0);
  let listOpen = $state(false);
  let measureBox = $state<HTMLElement | null>(null);
  /** The chips' widths, taken once from an unseen copy of all of them; they do not depend on the pane. */
  let measured = $state<{ key: string; widths: number[] } | null>(null);

  const key = $derived(`${saveDir ? 1 : 0}|${files.map((f) => `${f.index}:${f.name}:${f.size}`).join("|")}`);
  const widths = $derived(measured?.key === key ? measured.widths : null);

  $effect(() => {
    if (!measureBox || measured?.key === key) return;
    measured = { key, widths: [...measureBox.children].map((c) => Math.ceil(c.getBoundingClientRect().width)) };
  });

  const shown = $derived(widths ? foldChips(widths, avail) : files.length);
  const hidden = $derived(files.length - shown);
  /** The shown file is among the folded ones: the button of the list says so. */
  const hiddenCurrent = $derived(viewing && viewingAt >= shown);

  const actions = $derived<RowAction[]>([
    { label: t("file.save"), icon: Download, run: (i) => onSaveAttachment(files[i]) },
    ...(saveDir ? [{ label: t("file.saveAs"), icon: FolderOutput, run: (i: number) => onSaveAttachmentAs(files[i]) }] : []),
  ]);
</script>

{#snippet chip(a: AttachmentInfo, measuring: boolean)}
  {@const current = !measuring && viewing && files[viewingAt] === a}
  <div class="file" class:current inert={measuring}>
    <button class="file-name" onclick={() => onViewAttachment(a)} title={current ? t("viewer.close") : `${t("file.open")}: ${a.name}`} aria-pressed={current}><Paperclip size={13} /><span class="fname">{a.name}</span></button>
    <span class="fsize muted">{size(a.size)}</span>
    <button class="btn ghost small-btn" onclick={() => onSaveAttachment(a)} title={saveDir ? t("file.saveIn", { dir: saveDir }) : t("file.save")} aria-label={t("file.save")}><Download size={14} /></button>
    {#if saveDir}
      <button class="btn ghost small-btn" onclick={() => onSaveAttachmentAs(a)} title={t("file.saveAs")} aria-label={t("file.saveAs")}><FolderOutput size={14} /></button>
    {/if}
  </div>
{/snippet}

{#if files.length}
  <div class="files" bind:clientWidth={avail}>
    {#each files.slice(0, shown) as a (a.index)}{@render chip(a, false)}{/each}
    {#if hidden > 0}
      <span class="anchor">
        <button class="more" class:current={hiddenCurrent} onclick={() => (listOpen = !listOpen)} aria-haspopup="menu" aria-expanded={listOpen}>
          {t("compose.attach.more", { n: hidden })} ›
        </button>
        <AttachmentMenu
          bind:open={listOpen}
          title={t("compose.attach.list", { n: files.length })}
          {files}
          current={viewing ? viewingAt : -1}
          rowTitle={t("file.open")}
          {actions}
          onPick={(i) => { listOpen = false; onViewAttachment(files[i]); }}
        >
          {#snippet footer()}
            <button class="mi" role="menuitem" onclick={() => { listOpen = false; onSaveAll(); }}>{t("file.saveAll")}</button>
          {/snippet}
        </AttachmentMenu>
      </span>
    {:else if files.length > 1}
      <button class="btn ghost small-btn" onclick={onSaveAll}>{t("file.saveAll")}</button>
    {/if}
  </div>
  {#if !widths}
    <!-- Every chip once, out of sight, to know how wide each is. -->
    <div class="measure" bind:this={measureBox} aria-hidden="true">
      {#each files as a (a.index)}{@render chip(a, true)}{/each}
    </div>
  {/if}
{/if}

<style>
  .files {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin: 0 22px 10px;
    align-items: center;
  }

  .measure {
    position: fixed;
    left: -10000px;
    top: 0;
    display: flex;
    width: max-content;
    visibility: hidden;
    pointer-events: none;
  }

  .anchor {
    position: relative;
    display: inline-flex;
  }

  .file {
    display: flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
    max-width: min(340px, 100%);
    height: 32px;
    border: 1px solid var(--line);
    background: var(--paper);
    border-radius: 6px;
    padding: 0 2px 0 8px;
  }

  /* The name shrinks with an ellipsis; the icon, size and button keep their room. */
  .file-name {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 5px;
    background: none;
    border: none;
    padding: 0;
    color: var(--link);
  }

  .file-name :global(svg) {
    flex: none;
  }

  .fname {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .fname:hover {
    text-decoration: underline;
  }

  .fsize {
    flex: none;
    font-size: 12px;
    white-space: nowrap;
    font-variant-numeric: tabular-nums;
  }

  .file .small-btn {
    flex: none;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 28px;
    height: 28px;
    padding: 0;
  }

  .small-btn {
    padding: 2px 6px;
    font-size: 12px;
  }

  .file.current {
    border-color: var(--accent);
    box-shadow: inset 0 0 0 1px var(--accent);
    background: color-mix(in srgb, var(--accent) 8%, var(--paper));
  }

  /* «+N more ›»: the composition window's look; it takes the shown file's frame when that file is folded. */
  .more {
    height: 32px;
    padding: 0 8px;
    border: 1px solid transparent;
    border-radius: 6px;
    background: none;
    color: var(--accent);
    font: inherit;
    font-size: 13px;
    white-space: nowrap;
    cursor: pointer;
  }

  .more:hover,
  .more:focus-visible {
    text-decoration: underline;
  }

  .more.current {
    border-color: var(--accent);
    box-shadow: inset 0 0 0 1px var(--accent);
  }
</style>

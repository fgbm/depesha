<script lang="ts">
  // The attachments of an opened letter: chips in at most two rows, the rest behind «+N more ›»
  // in the same list as the composition window's (AttachmentMenu). The rows are counted by the
  // pane's real width and the chips' real widths, and again whenever the pane is resized.
  import Download from "@lucide/svelte/icons/download";
  import FolderOutput from "@lucide/svelte/icons/folder-output";
  import { i18n, t } from "../../lib/i18n.svelte";
  import { onMount, tick } from "svelte";
  import { foldChips, keepFit } from "../../lib/attachFold";
  import type { AttachmentInfo } from "../../lib/types";
  import AttachmentChip from "./AttachmentChip.svelte";
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
  let moreButton = $state<HTMLElement | null>(null);
  let measureBox = $state<HTMLElement | null>(null);
  /** The chips' widths, taken once from an unseen copy of all of them; they do not depend on the pane. */
  let measured = $state<{ key: string; widths: number[]; more: number; saveAll: number } | null>(null);
  /** The page's fonts came in after the first measure: the widths are taken again. */
  let fonts = $state(0);
  onMount(() => {
    void document.fonts?.ready.then(() => fonts++);
  });

  const key = $derived(`${i18n.lang}|${fonts}|${saveDir ? 1 : 0}|${files.map((f) => `${f.index}:${f.name}:${f.size}`).join("|")}`);
  // While a new measure is taken the old one stays: the strip and its list are not unmounted for it.
  const fit = $derived(keepFit(measured, files.length));

  $effect(() => {
    if (!measureBox || measured?.key === key) return;
    // The files' chips, then «+N more» and «Save all», each as wide as it is drawn.
    const w = [...measureBox.children].map((c) => Math.ceil(c.getBoundingClientRect().width));
    measured = { key, widths: w.slice(0, files.length), more: w[files.length], saveAll: w[files.length + 1] };
  });

  const shown = $derived(fit ? foldChips(fit.widths, avail, { more: fit.more, saveAll: fit.saveAll }) : files.length);
  const hidden = $derived(files.length - shown);
  /** The shown file is among the folded ones: the button of the list says so. */
  const hiddenCurrent = $derived(viewing && viewingAt >= shown);

  /** A file chosen in the list is shown; the focus follows it into the viewer, or back to the button. */
  async function pick(i: number) {
    listOpen = false;
    // The file shown already: Enter keeps it (a click on its chip is what closes the viewer).
    if (!(viewing && i === viewingAt)) onViewAttachment(files[i]);
    await tick();
    const viewer = moreButton?.closest(".scroll")?.querySelector<HTMLElement>(".viewer");
    (viewer ?? moreButton)?.focus({ preventScroll: true });
  }

  const actions = $derived<RowAction[]>([
    { label: t("file.save"), icon: Download, run: (i) => onSaveAttachment(files[i]) },
    ...(saveDir ? [{ label: t("file.saveAs"), icon: FolderOutput, run: (i: number) => onSaveAttachmentAs(files[i]) }] : []),
  ]);
</script>

{#snippet chip(a: AttachmentInfo, measuring: boolean)}
  <AttachmentChip {a} current={!measuring && viewing && files[viewingAt] === a} {measuring} onView={onViewAttachment} onSave={onSaveAttachment} onSaveAs={onSaveAttachmentAs} {saveDir} />
{/snippet}

{#if files.length}
  <div class="files" bind:clientWidth={avail}>
    {#each files.slice(0, shown) as a (a.index)}{@render chip(a, false)}{/each}
    {#if hidden > 0}
      <span class="anchor">
        <button class="more" bind:this={moreButton} class:current={hiddenCurrent} onclick={() => (listOpen = !listOpen)} aria-haspopup="menu" aria-expanded={listOpen}>
          {t("compose.attach.more", { n: hidden })} ›
        </button>
        <AttachmentMenu
          bind:open={listOpen}
          title={t("compose.attach.list", { n: files.length })}
          {files}
          current={viewing ? viewingAt : -1}
          rowTitle={t("file.open")}
          {actions}
          start={shown}
          onPick={pick}
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
  {#if measured?.key !== key}
    <!-- Every chip once, out of sight, to know how wide each is. -->
    <div class="measure" bind:this={measureBox} aria-hidden="true">
      {#each files as a (a.index)}{@render chip(a, true)}{/each}
      <button class="more">{t("compose.attach.more", { n: files.length })} ›</button>
      <button class="btn ghost small-btn">{t("file.saveAll")}</button>
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

  .small-btn {
    padding: 2px 6px;
    font-size: 12px;
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

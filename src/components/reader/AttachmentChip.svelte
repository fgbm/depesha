<script lang="ts">
  // One attachment of a letter: the chip of the reading pane's strip (AttachmentStrip) and of a
  // letter unfolded in the conversation (ThreadLetter, 4.8). Its name, its size and a button that
  // saves it. Where the pane has a viewer the name is a button that shows the file; a letter of
  // the conversation has no viewer, so its name is plain text.
  import Paperclip from "@lucide/svelte/icons/paperclip";
  import Download from "@lucide/svelte/icons/download";
  import FolderOutput from "@lucide/svelte/icons/folder-output";
  import { size } from "../../lib/format";
  import { t } from "../../lib/i18n.svelte";
  import type { AttachmentInfo } from "../../lib/types";

  let {
    a,
    onView,
    onSave,
    onSaveAs,
    saveDir,
    current = false,
    measuring = false,
  }: {
    /** The file this chip is about. */
    a: AttachmentInfo;
    /** Shows the file in place of the letter; absent where there is no viewer. */
    onView?: (a: AttachmentInfo) => void;
    onSave: (a: AttachmentInfo) => void;
    onSaveAs?: (a: AttachmentInfo) => void;
    /** The folder the save button names; empty: the file dialog asks. */
    saveDir: string;
    /** The file shown now, in the viewer. */
    current?: boolean;
    /** A copy taken out of sight, to know how wide the chip is; not reachable. */
    measuring?: boolean;
  } = $props();
</script>

<div class="file" class:current inert={measuring}>
  {#if onView}
    <button class="file-name" onclick={() => onView(a)} title={current ? t("viewer.close") : `${t("file.open")}: ${a.name}`} aria-pressed={current}><Paperclip size={13} /><span class="fname">{a.name}</span></button>
  {:else}
    <span class="file-name"><Paperclip size={13} /><span class="fname">{a.name}</span></span>
  {/if}
  <span class="fsize muted">{size(a.size)}</span>
  <button class="btn ghost small-btn" onclick={() => onSave(a)} title={saveDir ? t("file.saveIn", { dir: saveDir }) : t("file.save")} aria-label={t("file.save")}><Download size={14} /></button>
  {#if saveDir}
    <button class="btn ghost small-btn" onclick={() => onSaveAs?.(a)} title={t("file.saveAs")} aria-label={t("file.saveAs")}><FolderOutput size={14} /></button>
  {/if}
</div>

<style>
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
</style>

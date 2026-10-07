<script lang="ts">
  // Documents that become HTML: Markdown and HTML files (cleaned by the backend like
  // letters), Word and spreadsheets (drawn by their libraries, cleaned here). All show
  // in the letter's sandboxed frame: no scripts, nothing loads from the network.
  import { api } from "../../lib/api";
  import { t } from "../../lib/i18n.svelte";
  import type { Sheet } from "../../lib/office";
  import { COLUMN_CSS, MARKDOWN_CSS } from "../../lib/prose";
  import type { ViewedFile } from "../../lib/viewer";
  import MailFrame from "../MailFrame.svelte";

  let { file, format }: { file: ViewedFile; format: "markdown" | "html" | "docx" | "sheet" } = $props();

  let html = $state<string | null>(null);
  let sheets = $state<Sheet[]>([]);
  let sheet = $state(0);
  let cut = $state(false);

  /** Markdown reads as a column, drawn as in a letter. */
  const PROSE = COLUMN_CSS + MARKDOWN_CSS;

  $effect(() => {
    let gone = false;
    (async () => {
      if (format === "markdown" || format === "html") {
        const r = await file.text();
        const clean = await api.documentHtml(r.text, format === "markdown");
        if (gone) return;
        cut = r.cut;
        html = format === "markdown" ? PROSE + clean : clean;
      } else if (format === "docx") {
        const { docxHtml } = await import("../../lib/office");
        const out = await docxHtml(await file.bytes());
        if (!gone) html = out;
      } else {
        const { sheetsHtml } = await import("../../lib/office");
        const out = await sheetsHtml(await file.bytes());
        if (gone) return;
        sheets = out;
        html = out[0]?.html ?? "";
      }
    })().catch((e) => !gone && file.fail(e));
    return () => {
      gone = true;
    };
  });

  function pick(i: number) {
    sheet = i;
    html = sheets[i].html;
  }
</script>

<div class="doc">
  {#if cut || sheets[sheet]?.hidden}
    <div class="cut muted">{sheets[sheet]?.hidden ? t("viewer.rowsHidden", { n: sheets[sheet].hidden }) : t("viewer.cut")}</div>
  {/if}
  {#if html !== null}
    {#key html}<MailFrame markdown={format === "markdown"} {html} allowRemote={false} onLink={(href) => file.openLink(href)} />{/key}
  {/if}
  {#if sheets.length > 1}
    <div class="tabs" role="tablist">
      {#each sheets as s, i (i)}
        <button role="tab" aria-selected={sheet === i} class:on={sheet === i} onclick={() => pick(i)}>{s.name}</button>
      {/each}
    </div>
  {/if}
</div>

<style>
  .doc {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
    padding: 0 16px 16px;
  }

  .cut {
    padding: 0 6px 8px;
    font-size: 12px;
  }

  /* Sheets as tabs under the table, where spreadsheets keep them. */
  .tabs {
    display: flex;
    gap: 2px;
    overflow-x: auto;
    padding-top: 6px;
  }

  .tabs button {
    flex: none;
    padding: 5px 14px;
    border: 1px solid var(--line);
    border-top: none;
    border-radius: 0 0 6px 6px;
    background: var(--paper-2);
    color: var(--muted);
    font-size: 13px;
  }

  .tabs button.on {
    background: var(--paper);
    color: var(--ink);
    font-weight: 600;
  }
</style>

<script lang="ts">
  // CSV and TSV as a table; the first row stays on top while scrolling.
  import { t } from "../../lib/i18n.svelte";
  import { extOf, parseCsv, type ViewedFile } from "../../lib/viewer";

  let { file }: { file: ViewedFile } = $props();

  const LIMIT = 5000;
  let rows = $state<string[][] | null>(null);
  let hidden = $state(0);
  let cut = $state(false);

  $effect(() => {
    let gone = false;
    file
      .text()
      .then((r) => {
        if (gone) return;
        const all = parseCsv(r.text, extOf(file.name) === "tsv");
        hidden = Math.max(0, all.length - LIMIT);
        rows = all.slice(0, LIMIT);
        cut = r.cut;
      })
      .catch((e) => file.fail(e));
    return () => {
      gone = true;
    };
  });
</script>

<div class="csv">
  {#if cut || hidden}<div class="cut muted">{t("viewer.cut")}</div>{/if}
  {#if rows}
    <table class="selectable">
      {#if rows.length}
        <thead><tr>{#each rows[0] as c, i (i)}<th>{c}</th>{/each}</tr></thead>
      {/if}
      <tbody>
        {#each rows.slice(1) as r, i (i)}
          <tr>{#each r as c, j (j)}<td>{c}</td>{/each}</tr>
        {/each}
      </tbody>
    </table>
  {/if}
</div>

<style>
  .csv {
    flex: 1;
    min-height: 0;
    overflow: auto;
    background: var(--paper);
  }

  table {
    border-collapse: collapse;
    font-size: 13px;
    font-variant-numeric: tabular-nums;
  }

  th,
  td {
    border: 1px solid var(--line);
    padding: 4px 10px;
    text-align: left;
    vertical-align: top;
    max-width: 420px;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }

  th {
    position: sticky;
    top: 0;
    background: var(--paper-2);
    font-weight: 600;
  }

  .cut {
    padding: 8px 22px;
    font-size: 12px;
  }
</style>

<script lang="ts">
  // Plain text, logs, code and configs: monospace, wrapped, selectable.
  import { t } from "../../lib/i18n.svelte";
  import type { ViewedFile } from "../../lib/viewer";

  let { file }: { file: ViewedFile } = $props();

  let text = $state<string | null>(null);
  let cut = $state(false);

  $effect(() => {
    let gone = false;
    file
      .text()
      .then((r) => {
        if (gone) return;
        text = r.text;
        cut = r.cut;
      })
      .catch((e) => file.fail(e));
    return () => {
      gone = true;
    };
  });
</script>

<div class="text">
  {#if cut}<div class="cut muted">{t("viewer.cut")}</div>{/if}
  {#if text !== null}<pre class="selectable">{text}</pre>{/if}
</div>

<style>
  .text {
    flex: 1;
    min-height: 0;
    overflow: auto;
    background: var(--paper);
  }

  pre {
    margin: 0;
    padding: 16px 22px 32px;
    font: 13px/1.55 var(--mono);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    tab-size: 4;
  }

  .cut {
    padding: 8px 22px;
    font-size: 12px;
    border-bottom: 1px solid var(--line);
  }
</style>

<script lang="ts">
  import { i18n } from "../lib/i18n.svelte";
  import { caps } from "../lib/keymap";
  import { shortcuts } from "../lib/shortcuts.svelte";

  /**
   * A key with the Russian letter of the same key beside it, `e у`, as engraved on a
   * keyboard: `key` itself, or the key `of` a command as the user set it. As key caps on
   * the «Keys» page (`cap`), as quiet text in menus and the palette otherwise; nothing
   * for a command without a key.
   */
  let { key, of, cap = false }: { key?: string; of?: string; cap?: boolean } = $props();

  const shown = $derived(key ?? (of ? shortcuts.key(of) : undefined));
  const parts = $derived(shown ? caps(shown, i18n.lang) : []);
  const legend = $derived(parts.at(-1)?.legend);
</script>

{#if cap}
  <span class="caps">
    {#each parts as p, i (i)}{#if i}<b class="plus">+</b>{/if}<kbd class="cap">{p.main}{#if p.legend}<i>{p.legend}</i>{/if}</kbd>{/each}
  </span>
{:else if shown}{parts.map((p) => p.main).join("+")}{#if legend}<i class="legend">{legend}</i>{/if}{/if}

<style>
  .caps {
    display: inline-flex;
    align-items: center;
    gap: 3px;
  }

  /* A key cap: the paper with a thicker lower edge, like kbd in app.css. */
  .cap {
    font: 12px/1 var(--mono);
    min-width: 22px;
    height: 23px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 4px;
    padding: 0 6px;
    border: 1px solid var(--line);
    border-bottom-width: 2px;
    border-radius: 5px;
    color: var(--ink);
    background: var(--paper);
  }

  .cap i {
    font-style: normal;
    font-size: 10px;
    color: var(--muted);
    align-self: flex-end;
    margin-bottom: 3px;
    font-family: var(--font);
  }

  .plus {
    font-weight: 400;
    color: var(--muted);
    font-size: 11px;
  }

  .legend {
    font-style: normal;
    font-size: 0.9em;
    margin-left: 4px;
    opacity: 0.75;
  }
</style>

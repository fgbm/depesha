<script lang="ts">
  // Choosing the signature of a letter, from the signature itself: a small label with its
  // name on the block ("chip"), or, once it was taken away, a quiet line under the text
  // to put one back ("line"). The menu is the same: the mailbox's signatures, none, the settings.
  import ChevronDown from "@lucide/svelte/icons/chevron-down";
  import Check from "@lucide/svelte/icons/check";
  import Popover from "./Popover.svelte";
  import { t } from "../lib/i18n.svelte";
  import type { Signature } from "../lib/types";

  let {
    variant,
    signatures,
    current,
    onpick,
    onsettings,
  }: {
    variant: "chip" | "line";
    signatures: Signature[];
    current: Signature | null;
    onpick: (sig: Signature | null) => void;
    /** Opens the mailbox's signatures in the settings; absent where there are no settings (a letter's own window). */
    onsettings?: () => void;
  } = $props();

  let open = $state(false);

  function pick(sig: Signature | null) {
    open = false;
    onpick(sig);
  }
</script>

<span class="anchor" class:line={variant === "line"}>
  {#if variant === "chip"}
    <button class="chip" class:open aria-haspopup="menu" aria-expanded={open} title={t("compose.signature.choose")} onmousedown={(e) => e.preventDefault()} onclick={() => (open = !open)}>
      {current?.name.trim() || t("compose.signature.unnamed")}
      <ChevronDown size={12} />
    </button>
  {:else}
    <span class="none">{t("compose.signature.none")} ·</span>
    <button class="add" aria-haspopup="menu" aria-expanded={open} onclick={() => (open = !open)}>{t("compose.signature.add")} <ChevronDown size={12} /></button>
  {/if}
  <Popover bind:open align={variant === "chip" ? "right" : "left"}>
    <div class="mt">{t("compose.signature.title")}</div>
    {#each signatures as s (s.id)}
      <button class="mi" role="menuitemradio" aria-checked={current?.id === s.id} onclick={() => pick(s)}>
        <span class="ck">{#if current?.id === s.id}<Check size={14} />{/if}</span>{s.name.trim() || t("compose.signature.unnamed")}
      </button>
    {/each}
    {#if current}
      <hr />
      <button class="mi" onclick={() => pick(null)}><span class="ck"></span>{t("compose.signature.none")}</button>
    {/if}
    {#if onsettings}
      <hr />
      <button class="mi dim" onclick={() => { open = false; onsettings?.(); }}><span class="ck"></span>{t("compose.signature.settings")}</button>
    {/if}
  </Popover>
</span>

<style>
  .anchor {
    position: relative;
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }

  .chip {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    font-size: 12px;
    line-height: 1.4;
    padding: 1px 8px;
    border: 1px solid var(--line);
    border-radius: 10px;
    background: var(--paper);
    color: var(--muted);
    white-space: nowrap;
  }

  .chip:hover,
  .chip.open,
  .chip:focus-visible {
    color: var(--ink);
  }

  .line {
    font-size: 12px;
    color: var(--muted);
  }

  .add {
    display: inline-flex;
    align-items: center;
    gap: 2px;
    border: none;
    background: none;
    padding: 0;
    font: inherit;
    color: var(--muted);
    text-decoration: underline;
    text-underline-offset: 2px;
  }

  .add:hover,
  .add:focus-visible {
    color: var(--ink);
  }

  .ck {
    display: inline-flex;
    width: 14px;
    color: var(--accent);
  }

  :global(.pop) .dim {
    color: var(--muted);
  }
</style>

<script lang="ts">
  // The mailbox's colour in the sidebar and the shared lists; «automatic» takes one by its place.
  import Check from "@lucide/svelte/icons/check";
  import { t } from "../../lib/i18n.svelte";
  import { ACCOUNT_PALETTE } from "../../lib/format";

  let { value = $bindable("") }: { value: string } = $props();
</script>

<div class="field">
  <span id="account-color">{t("account.color")}</span>
  <div class="colors" role="radiogroup" aria-labelledby="account-color">
    {#each ["", ...ACCOUNT_PALETTE] as c (c)}
      {@const on = (value || "") === c}
      <label class="swatch" class:auto={!c} class:on style:--c={c || null} title={c || t("accounts.colorAuto")}>
        <input type="radio" name="account-color" value={c} checked={on} onchange={() => (value = c)} aria-label={c || t("accounts.colorAuto")} />
        {#if on}<Check size={12} />{/if}
      </label>
    {/each}
  </div>
</div>

<style>
  .colors {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    padding: 2px 0;
  }

  .swatch {
    position: relative;
    width: 22px;
    height: 22px;
    border-radius: 50%;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    color: #fff;
    background: var(--c);
    box-shadow: inset 0 0 0 1px color-mix(in srgb, #000 15%, transparent);
    cursor: pointer;
  }

  .swatch.auto {
    background: conic-gradient(#c0504d, #c77d1a, #4a9a6a, #2a9d9b, #3f7cc4, #9b59b6, #d0658f, #c0504d);
  }

  .swatch.on {
    outline: 2px solid var(--ink);
    outline-offset: 2px;
  }

  /* The radio stays for the keyboard and screen readers; the swatch is what one sees. */
  .swatch input {
    position: absolute;
    opacity: 0;
    pointer-events: none;
  }

  .swatch:has(input:focus-visible) {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }
</style>

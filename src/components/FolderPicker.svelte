<script lang="ts">
  // A folder on disk, picked in the system dialog; empty is a choice too. It is not typed:
  // the backend saves files only into a folder the user picked there.
  import X from "@lucide/svelte/icons/x";
  import { api } from "../lib/api";
  import { app } from "../lib/store.svelte";
  import { t } from "../lib/i18n.svelte";

  let { value = $bindable(""), label, placeholder = "" }: { value: string; label: string; placeholder?: string } = $props();

  async function pick() {
    try {
      const dir = await api.pickFolder("save", label, value || null);
      if (dir) value = dir;
    } catch (e) {
      app.ui.fail(e);
    }
  }
</script>

<div class="folder">
  <input class="input" {value} readonly {placeholder} aria-label={label} spellcheck="false" onclick={pick} />
  {#if value}
    <button class="btn ghost icon" onclick={() => (value = "")} title={t("settings.askEveryTime")} aria-label={t("settings.askEveryTime")}><X size={14} /></button>
  {/if}
  <button class="btn" onclick={pick}>{t("settings.chooseFolder")}</button>
</div>

<style>
  .folder {
    display: flex;
    align-items: center;
    gap: 6px;
  }

  input {
    flex: 1;
    min-width: 0;
  }
</style>

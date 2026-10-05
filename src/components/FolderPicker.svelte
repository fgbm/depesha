<script lang="ts">
  // A folder on disk: typed, or picked in the system dialog; empty is a choice too.
  import { open as openDialog } from "@tauri-apps/plugin-dialog";
  import X from "@lucide/svelte/icons/x";
  import { t } from "../lib/i18n.svelte";

  let { value = $bindable(""), label, placeholder = "" }: { value: string; label: string; placeholder?: string } = $props();

  async function pick() {
    const dir = await openDialog({ directory: true, title: label, defaultPath: value || undefined });
    if (typeof dir === "string") value = dir;
  }
</script>

<div class="folder">
  <input class="input" bind:value {placeholder} aria-label={label} spellcheck="false" />
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

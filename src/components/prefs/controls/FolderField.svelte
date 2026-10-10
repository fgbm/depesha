<script lang="ts">
  // A folder on disk, picked in the system dialog and cleared with ×; empty is a choice too
  // (#102). It is not typed: the backend saves files only into a folder picked in the dialog.
  import X from "@lucide/svelte/icons/x";
  import { api } from "../../../lib/api";
  import { app } from "../../../lib/store.svelte";
  import { t } from "../../../lib/i18n.svelte";

  let {
    value,
    label,
    disabled = false,
    onpick,
  }: { value: string; label: string; disabled?: boolean; onpick: (path: string) => void } = $props();

  export async function pick() {
    try {
      const dir = await api.pickFolder("save", label, value || null);
      if (dir) onpick(dir);
    } catch (e) {
      app.ui.fail(e);
    }
  }
</script>

<div class="folder">
  <span class="path" class:ph={!value} title={value}>{value || t("settings.askEveryTime")}</span>
  <button type="button" class="btn small" tabindex="-1" {disabled} onclick={pick}>{t("settings.chooseFolder")}</button>
  {#if value}
    <button type="button" class="btn ghost small" tabindex="-1" {disabled} aria-label={t("settings.askEveryTime")} title={t("settings.askEveryTime")} onclick={() => onpick("")}><X size={13} /></button>
  {/if}
</div>

<style>
  .folder {
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .path {
    width: 230px;
    padding: 5px 8px;
    border: 1px solid var(--line);
    border-radius: 6px;
    background: var(--paper);
    font-size: 13px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .path.ph {
    color: var(--muted);
  }
</style>

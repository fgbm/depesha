<script lang="ts">
  import TriangleAlert from "@lucide/svelte/icons/triangle-alert";
  import { onMount } from "svelte";
  import { api } from "../../lib/api";
  import { t } from "../../lib/i18n.svelte";
  import Select from "../Select.svelte";
  import type { Settings } from "../../lib/types";

  /** The «Background and startup» page (#4, frame 5): closing the window, starting at login, the tray icon. */
  let { draft }: { draft: Settings } = $props();

  /** The system shows no tray icons: a hidden window comes back only by starting the app again. */
  let noTray = $state(false);
  onMount(() => {
    api.backgroundStatus().then((s) => (noTray = s.tray === "absent"), () => {});
  });

  // Chosen here, with the warning in sight, the background without an icon is agreed to.
  $effect(() => {
    if (noTray && draft.close_action === "background") draft.background_without_tray = true;
  });
</script>

<section data-settings="bg-close">
  <h4>{t("bg.onClose")}</h4>
  <Select
    label={t("bg.onClose")}
    bind:value={draft.close_action}
    options={[
      { value: "background", label: t("bg.onClose.background") },
      { value: "quit", label: t("bg.onClose.quit") },
      { value: "ask", label: t("bg.onClose.ask") },
    ]}
  />
  {#if noTray}
    <div class="warn" role="status"><TriangleAlert size={15} /><span>{t("bg.noTrayWarn")}</span></div>
  {/if}
  <p class="hint">{t("bg.quitHint")}</p>
</section>
<section data-settings="bg-login">
  <h4>{t("bg.atLogin")}</h4>
  <Select
    label={t("bg.atLogin")}
    bind:value={draft.autostart}
    options={[
      { value: "off", label: t("bg.atLogin.off") },
      { value: "window", label: t("bg.atLogin.window") },
      { value: "background", label: t("bg.atLogin.background") },
    ]}
  />
</section>
<section data-settings="bg-tray">
  <h4>{t("bg.trayIcon")}</h4>
  <label class="option">
    <input type="checkbox" bind:checked={draft.tray_count} />
    <span class="text">{t("bg.trayCount")}<span class="note">{t("bg.trayCountNote")}</span></span>
  </label>
  <label class="option">
    <input type="checkbox" bind:checked={draft.tray_always} />
    <span class="text">{t("bg.trayAlways")}</span>
  </label>
</section>
<section>
  <h4>{t("bg.whileBackground")}</h4>
  <p class="hint">{t("bg.whileBackgroundText")}</p>
</section>

<style>
  section {
    padding: 14px 0;
    border-bottom: 1px solid var(--line);
  }

  section:last-child {
    border-bottom: none;
  }

  h4 {
    margin: 0 0 10px;
    font-size: 13px;
    font-weight: 600;
    color: var(--muted);
  }

  /* A choice: the control, then its name with an explanation under it. */
  .option {
    display: flex;
    align-items: flex-start;
    gap: 10px;
    padding: 5px 0;
    cursor: pointer;
  }

  .option input {
    margin-top: 2px;
  }

  .text {
    display: flex;
    flex-direction: column;
    gap: 2px;
    line-height: 1.4;
  }

  .note,
  .hint {
    font-size: 12px;
    color: var(--muted);
    line-height: 1.45;
  }

  .hint {
    margin: 8px 0 0;
  }

  /* The yellow line of a system without tray icons (frame 3). */
  .warn {
    display: flex;
    align-items: flex-start;
    gap: 10px;
    margin-top: 10px;
    padding: 8px 10px;
    border-radius: 8px;
    font-size: 13px;
    line-height: 1.4;
    background: color-mix(in srgb, var(--warn) 12%, var(--paper));
    border: 1px solid color-mix(in srgb, var(--warn) 40%, var(--paper));
  }

  .warn :global(svg) {
    flex: none;
    margin-top: 2px;
    color: var(--warn);
  }
</style>

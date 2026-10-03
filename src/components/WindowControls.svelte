<script lang="ts">
  import { onMount } from "svelte";
  import { getCurrentWindow } from "@tauri-apps/api/window";
  import { Minus, Square, Copy, X } from "@lucide/svelte";
  import { t } from "../lib/i18n.svelte";

  // The window has no system title bar (decorations: false), so these buttons stand in for it.
  const win = getCurrentWindow();
  let maximized = $state(false);

  onMount(() => {
    const sync = async () => (maximized = await win.isMaximized());
    sync();
    const off = win.onResized(sync);
    return () => void off.then((f) => f());
  });
</script>

<div class="wincontrols">
  <button onclick={() => win.minimize()} title={t("window.minimize")} aria-label={t("window.minimize")}><Minus size={16} /></button>
  <button onclick={() => win.toggleMaximize()} title={t(maximized ? "window.restore" : "window.maximize")} aria-label={t(maximized ? "window.restore" : "window.maximize")}>
    {#if maximized}<Copy size={13} />{:else}<Square size={13} />{/if}
  </button>
  <button class="close" onclick={() => win.close()} title={t("close")} aria-label={t("close")}><X size={17} /></button>
</div>

<style>
  /* Above dialogs (z-index 50): the window can always be closed. */
  .wincontrols {
    position: fixed;
    top: 0;
    right: 0;
    display: flex;
    z-index: 60;
  }

  button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 44px;
    height: 36px;
    border: 0;
    background: transparent;
    color: var(--muted);
  }

  button:hover {
    background: var(--hover);
    color: var(--ink);
  }

  .close:hover {
    background: #c42b1c;
    color: #fff;
  }
</style>

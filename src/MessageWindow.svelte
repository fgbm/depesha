<script lang="ts">
  // A letter in a window of its own (double click in the list): the same reader as in
  // the main window, answers written right here. Done, Delete and moves close it; their
  // undo is offered in the main window, where the list is.
  import { onMount } from "svelte";
  import { getCurrentWindow } from "@tauri-apps/api/window";
  import { app } from "./lib/store.svelte";
  import { t } from "./lib/i18n.svelte";
  import { shortcutKeys } from "./lib/keys";
  import Reader from "./components/Reader.svelte";
  import Dock from "./components/Dock.svelte";
  import WindowControls from "./components/WindowControls.svelte";
  import Confirm from "./components/Confirm.svelte";
  import { host } from "./plugin-host/host.svelte";
  import { registry } from "./plugin-host/registry.svelte";

  let { id }: { id: number } = $props();

  const win = getCurrentWindow();

  onMount(() => {
    app.initWindow(id).catch((e) => app.fail(e, t("startup")));
    // An answer being written is not dropped by closing the window unasked.
    const off = win.onCloseRequested(async (e) => {
      if (!app.composes.length) return;
      e.preventDefault();
      const ok = await app.confirm({ text: t("window.closeWithAnswer"), okLabel: t("close"), cancelLabel: t("compose.goBack"), danger: true });
      if (ok) await win.destroy();
    });
    return () => void off.then((f) => f());
  });

  // Plugins add their buttons and banners to the reader here as in the main window.
  $effect(() => {
    void app.settings.disabled_plugins;
    void app.settings.enabled_plugins;
    host.sync();
  });

  $effect(() => {
    const subject = app.opened?.view.summary.subject;
    if (subject !== undefined) win.setTitle(subject || t("noSubject")).catch(() => {});
  });

  function onKey(e: KeyboardEvent) {
    if (app.confirmation || e.ctrlKey || e.metaKey || e.altKey) return;
    const target = e.target as HTMLElement | null;
    if (target?.closest?.(".compose")) return;
    if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT" || target.isContentEditable)) return;
    const opened = app.opened;
    const actions: Record<string, () => void> = {
      r: () => app.replyTo(false),
      a: () => app.replyTo(true),
      f: () => app.forwardOpened(),
      Delete: () => app.remove(),
      "#": () => app.remove(),
      e: () => app.archive(),
      "!": () => app.spam(),
      u: () => opened && app.flag("seen", !opened.row.flags.seen),
      s: () => opened && app.flag("flagged", !opened.row.flags.flagged),
      // Nothing being written: Esc closes the window, as a viewer of one letter.
      Escape: () => !app.composes.length && win.close(),
    };
    const action = shortcutKeys(e).map((k) => actions[k]).find(Boolean);
    if (action) {
      e.preventDefault();
      action();
    }
  }
</script>

<svelte:window onkeydown={onKey} />

<div class="single">
  <Reader onReply={(all) => app.replyTo(all)} onForward={() => app.forwardOpened()} />
</div>

<Dock />
<!-- Dialogs plugins open from their banners, e.g. a new date for a reminder. -->
{#each registry.lists.overlays as o (o)}
  <o.item.component {...o.item.props ?? {}} />
{/each}

{#if app.confirmation}
  {#key app.confirmation}<Confirm q={app.confirmation} />{/key}
{/if}

<WindowControls />

<style>
  .single {
    display: grid;
    height: 100vh;
  }
</style>

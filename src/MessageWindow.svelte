<script lang="ts">
  // A letter in a window of its own (double click in the list): the same reader as in
  // the main window, answers written right here. Done, Delete and moves close it; their
  // undo is offered in the main window, where the list is.
  import { onMount } from "svelte";
  import { getCurrentWindow } from "@tauri-apps/api/window";
  import { api } from "./lib/api";
  import { app } from "./lib/store.svelte";
  import { watchDrops } from "./lib/drops";
  import { t } from "./lib/i18n.svelte";
  import { shortcuts } from "./lib/shortcuts.svelte";
  import { printKey } from "./lib/print";
  import Reader from "./components/Reader.svelte";
  import Dock from "./components/Dock.svelte";
  import Popover from "./components/Popover.svelte";
  import LabelPicker from "./components/LabelPicker.svelte";
  import WindowControls from "./components/WindowControls.svelte";
  import Confirm from "./components/Confirm.svelte";
  import MergeDialog from "./components/people/MergeDialog.svelte";
  import PickPerson from "./components/people/PickPerson.svelte";
  import { peopleOps } from "./lib/peopleOps.svelte";
  import { host, keybindingRun } from "./plugin-host/host.svelte";
  import { registry } from "./plugin-host/registry.svelte";

  let { id }: { id: number } = $props();

  const win = getCurrentWindow();

  onMount(() => {
    app.initWindow(id).catch((e) => app.ui.fail(e, t("startup")));
    // An answer being written is not dropped by closing the window unasked. Quitting
    // from the tray or Ctrl+Q closes this window the same way, so the same question is asked.
    const off = win.onCloseRequested(async (e) => {
      if (!app.compose.windows.length) return;
      e.preventDefault();
      const ok = await app.ui.confirm({ text: t("window.closeWithAnswer"), okLabel: t("close"), cancelLabel: t("compose.goBack"), danger: true });
      if (ok) {
        // The drafts are kept before the window goes; a slow server does not hold it up (#71).
        await app.compose.saveAll(4000);
        await win.destroy();
      }
      // Kept: a quit waiting for this window stops.
      // A lost cancel leaves the quit waiting for the window; the next quit asks again.
      else api.quitCancel().catch(() => {});
    });
    // Files dropped on this window are attached to its own draft (#107).
    const stopDrops = watchDrops(app);
    return () => {
      void off.then((f) => f());
      stopDrops();
    };
  });

  // A quit asks this window first when a letter is being written here.
  $effect(() => {
    // Only tells the backend whether a quit must ask; the next change tells again.
    api.composeUnsaved(app.compose.windows.length > 0).catch(() => {});
  });

  // Plugins add their buttons and banners to the reader here as in the main window.
  $effect(() => {
    void app.settingsCtl.settings.disabled_plugins;
    void app.settingsCtl.settings.enabled_plugins;
    host.sync();
  });

  $effect(() => {
    const subject = app.reader.opened?.view.summary.subject;
    // The window title is cosmetic.
    if (subject !== undefined) win.setTitle(subject || t("noSubject")).catch(() => {});
  });

  function onKey(e: KeyboardEvent) {
    const target = e.target as HTMLElement | null;
    // Ctrl+P prints this letter, whatever has the focus; the browser's own would print the interface.
    if (printKey(e, !!app.ui.confirmation || !!target?.closest?.(".compose"))) return;
    if (app.ui.confirmation) return;
    if (target?.closest?.(".compose")) return;
    if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT" || target.isContentEditable)) return;
    const opened = app.reader.opened;
    // The letter's commands, by the keys of the main window (keyCommands.ts, Settings → Keys); a plugin's key (h, w) runs as there.
    const actions: Record<string, () => void> = {
      "core.reply": () => app.replyTo(false),
      "core.reply-all": () => app.replyTo(true),
      "core.forward": () => app.forwardOpened(),
      "core.delete": () => app.remove(),
      "core.archive": () => app.archive(),
      "core.spam": () => app.spam(),
      "core.unread": () => app.selection.toggleSeen(),
      "core.flag": () => app.selection.toggleFlagged(),
      "core.labels": () => opened && app.labels.openPick([opened.row.id]),
      // The card of the sender, and the way back from a merge made in its card (#104).
      "core.sender-card": () => app.openSenderCard(),
      "core.undo": () => app.undo(),
    };
    // Nothing being written: Esc closes the window, as a viewer of one letter.
    const plain = !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey;
    const id = shortcuts.find(e, "main");
    const action = plain && e.key === "Escape" ? () => !app.compose.windows.length && win.close() : id ? (actions[id] ?? keybindingRun(id)) : undefined;
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
{#if app.labels.pick}
  <Popover
    bind:open={() => app.labels.pick !== null, (v) => !v && app.labels.closePick()}
    at={app.labels.pick.at ?? { x: Math.round(window.innerWidth / 2 - 120), y: 90 }}
  >
    <LabelPicker rows={app.labels.pickRows()} />
  </Popover>
{/if}
<!-- Dialogs plugins open from their banners, e.g. a new date for a reminder. -->
{#each registry.lists.overlays as o (o)}
  <o.item.component {...o.item.props ?? {}} />
{/each}

<!-- The card of the sender joins people here as in the main window: the same dialogs. -->
{#if peopleOps.dialog}<MergeDialog />{/if}
{#if peopleOps.picking}<PickPerson />{/if}

{#if app.ui.confirmation}
  {#key app.ui.confirmation}<Confirm q={app.ui.confirmation} />{/key}
{/if}

<WindowControls />

<style>
  .single {
    display: grid;
    height: 100vh;
  }
</style>

<script lang="ts">
  import { onMount, tick, untrack } from "svelte";
  import { app } from "./lib/store.svelte";
  import { watchDrops } from "./lib/drops";
  import { currentRow } from "./lib/anchor";
  import { api } from "./lib/api";
  import { t } from "./lib/i18n.svelte";
  import { shortcuts } from "./lib/shortcuts.svelte";
  import { pressName } from "./lib/keymap";
  import { printKey } from "./lib/print";
  import { quitApp } from "./lib/background.svelte";
  import { layout } from "./lib/layout.svelte";
  import Sidebar from "./components/Sidebar.svelte";
  import MessageList from "./components/MessageList.svelte";
  import Reader from "./components/Reader.svelte";
  import Dock from "./components/Dock.svelte";
  import Wizard from "./components/Wizard.svelte";
  import Outbox from "./components/Outbox.svelte";
  import PeopleView from "./components/people/PeopleView.svelte";
  import MergeDialog from "./components/people/MergeDialog.svelte";
  import PickPerson from "./components/people/PickPerson.svelte";
  import { peopleOps } from "./lib/peopleOps.svelte";
  import Preferences from "./components/Preferences.svelte";
  import Tasks from "./components/Tasks.svelte";
  import WindowControls from "./components/WindowControls.svelte";
  import Confirm from "./components/Confirm.svelte";
  import Popover from "./components/Popover.svelte";
  import { keyAnchor } from "./lib/anchor";
  import LabelPicker from "./components/LabelPicker.svelte";
  import { allCommands, host } from "./plugin-host/host.svelte";
  import FolderPropsCard from "./components/prefs/FolderProps.svelte";
  import { registry } from "./plugin-host/registry.svelte";

  let searchInput = $state<HTMLInputElement | null>(null);

  // The width decides the layout from the first paint.
  layout.resize(window.innerWidth);

  /** Dragging a hairline: column widths, remembered between launches; the sidebar's snaps into the strip. */
  function drag(which: "side" | "list", e: PointerEvent) {
    const startX = e.clientX;
    const start = which === "side" ? layout.sideWidth : layout.listWidth;
    const target = e.currentTarget as HTMLElement;
    target.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => {
      const w = start + ev.clientX - startX;
      if (which === "side") layout.dragSide(w);
      else layout.dragList(w);
    };
    const up = () => {
      target.removeEventListener("pointermove", move);
      target.removeEventListener("pointerup", up);
      layout.save();
    };
    target.addEventListener("pointermove", move);
    target.addEventListener("pointerup", up);
  }

  /** The outbox and the address book take the place of the list and the letter. */
  const wideView = $derived(app.view.kind === "outbox" || app.view.kind === "people");

  /** A letter (or its error, or one being opened) to show; several selected rows are not one. */
  const hasLetter = $derived(app.selected.size <= 1 && !!(app.opened || app.opening || app.openError));
  const column = $derived(layout.single ? layout.column(hasLetter) : null);

  // Another list starts on the list in a narrow window.
  $effect(() => {
    void app.view;
    untrack(() => layout.showList());
  });
  $effect(() => {
    const has = hasLetter;
    untrack(() => layout.follow(has));
  });

  let listPane = $state<HTMLElement>();
  let readerPane = $state<HTMLElement>();
  let shownColumn: typeof column = null;
  // Back on the list in a narrow window: the focus left with the hidden letter, so it goes
  // to the selected row. Focus put elsewhere on purpose (the sidebar) stays there.
  $effect(() => {
    const was = shownColumn;
    shownColumn = column;
    if (was === "message" && column === "list") tick().then(refocusList);
  });

  function refocusList() {
    const at = document.activeElement;
    if (at && at !== document.body && !readerPane?.contains(at)) return;
    const row = (listPane ? currentRow(listPane) : null) ?? listPane?.querySelector<HTMLElement>("[role=listbox]");
    row?.focus({ preventScroll: true });
  }

  onMount(() => {
    app.init().catch((e) => app.fail(e, t("startup")));
    // Files dropped on the window go to the open composition: attached, or, in an HTML
    // letter, pictures into the text when dropped on that zone.
    return watchDrops(app);
  });

  /** What the commands of the main window do; their keys are in keyCommands.ts and Settings → Keys. */
  const actions: Record<string, () => void> = {
    "core.settings": () => app.openSettings(),
    "core.quit": () => quitApp(),
    "core.compose": () => app.newMessage(),
    "core.search": () => (app.view.kind === "people" ? app.focusPeople() : searchInput?.focus()),
    "core.people": () => void app.openPeople(),
    "core.sender-card": () => app.openSenderCard(),
    "core.undo": () => app.undo(),
    "core.sync": () => api.syncNow().catch((e) => app.fail(e)),
    "core.next": () => app.move(1),
    "core.prev": () => app.move(-1),
    "core.select-all": () => app.selectAll(),
    "core.reply": () => app.replyTo(false),
    "core.reply-all": () => app.replyTo(true),
    "core.forward": () => app.forwardOpened(),
    "core.archive": () => app.archive(),
    "core.delete": () => app.remove(),
    "core.empty-folder": () => {
      const here = app.clearing.here();
      if (here) void app.clearing.begin(here.account_id, here.folder.name);
    },
    "core.spam": () => app.spam(),
    "core.unread": () => app.toggleSeen(),
    "core.flag": () => app.toggleFlagged(),
    "core.labels": () => app.labels.openPick(labelTarget()),
  };

  /** The rows the labels command acts on: the selection, or the open letter (#42, frame 10). */
  function labelTarget(): number[] {
    const ids = app.selectedIds();
    return ids.length ? ids : app.opened ? [app.opened.row.id] : [];
  }

  /** What a command does now: the core's, a plugin's key, or any command of the palette given a key. */
  function action(id: string | undefined): (() => void) | undefined {
    if (!id) return;
    return actions[id] ?? registry.items("keybindings").find((b) => b.id === id && (!b.when || b.when()))?.run ?? allCommands().find((c) => c.id === id)?.run;
  }

  /** Text fields keep their own editing keys even when a command has them. */
  const EDITING = ["Mod+a", "Mod+z", "Mod+y", "Mod+Shift+z"];

  function onKey(e: KeyboardEvent) {
    // Quit is the one key that works everywhere — over the wizard, the settings, a text
    // field: the backend asks about letters waiting before it really quits.
    if ((e.ctrlKey || e.metaKey) && shortcuts.find(e, "main") === "core.quit") {
      e.preventDefault();
      quitApp();
      return;
    }
    // The print key is ours before anything else: the browser would print the whole interface.
    if (printKey(e, !!app.wizard || app.settingsOpen || app.tasksOpen || !!(e.target as HTMLElement | null)?.closest?.(".compose"))) return;
    if (app.wizard) return;
    // Typing in a composition window: its own keys (Ctrl+Enter, Esc) handle it.
    // Only Ctrl+K reaches the app from there: the palette opens from anywhere.
    const inCompose = !!(e.target as HTMLElement | null)?.closest?.(".compose");
    const id = shortcuts.find(e, inCompose ? "compose" : "main");
    if (inCompose && shortcuts.command(id)?.scope !== "all") return;
    const t = e.target as HTMLElement | null;
    const typing = !!t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable);
    // Shortcuts with Ctrl/Cmd work from text fields too (Ctrl+K in the search box), those
    // of the list and the letter aside; Ctrl+A in a field selects its text, in the list every row.
    if (e.ctrlKey || e.metaKey) {
      const cmd = shortcuts.command(id);
      if (!cmd || (app.settingsOpen && cmd.owner === "core")) return;
      if (typing && (cmd.group !== "everywhere" || EDITING.includes(pressName(e) ?? ""))) return;
      if (cmd.id === "core.select-all" && app.windowOf !== null) return;
      const run = action(id);
      if (run) {
        e.preventDefault();
        run();
      }
      return;
    }
    if (app.settingsOpen || app.tasksOpen) return;
    if (typing) {
      if (e.key === "Escape") t!.blur();
      return;
    }
    const run = action(id);
    if (e.altKey) {
      if (run) {
        e.preventDefault();
        run();
      }
      return;
    }
    // A narrow window shows the list or the letter: Enter opens the selected one, Esc goes back.
    // Keys a viewer or a menu took already, and Enter on a focused button, are not theirs.
    const onButton = !!t?.closest?.("button, a");
    if (!e.defaultPrevented && ((e.key === "Enter" && !onButton && layout.enter(app.selected.size)) || (e.key === "Escape" && layout.back(hasLetter)))) {
      e.preventDefault();
      return;
    }
    if (run) {
      e.preventDefault();
      run();
    }
  }

  // Built-in plugins follow the settings: switched on and off at once.
  $effect(() => {
    void app.settings.disabled_plugins;
    void app.settings.enabled_plugins;
    host.sync();
  });

  // A quit asks this window to keep its drafts: it says whether it holds any (#71).
  $effect(() => {
    api.composeUnsaved(app.composes.length > 0 || app.settingsTyping).catch(() => {});
  });

  $effect(() => {
    app.focusSearch = () => searchInput?.focus();
  });
</script>

<svelte:window onkeydown={onKey} onresize={() => layout.resize(window.innerWidth)} />

<div
  class="layout"
  class:single={layout.single}
  style:grid-template-columns={wideView
    ? `${layout.sideWidth}px 1fr`
    : layout.single
      ? `${layout.sideWidth}px 1px 1fr`
      : `${layout.sideWidth}px 1px ${layout.listWidth}px 1px 1fr`}
>
  <Sidebar onCompose={() => app.newMessage()} />
  {#if app.view.kind === "outbox"}
    <section class="wide"><Outbox /></section>
  {:else if app.view.kind === "people"}
    <section class="wide"><PeopleView /></section>
  {:else}
    <div class="gutter" role="separator" aria-orientation="vertical" onpointerdown={(e) => drag("side", e)}></div>
    <!-- Both stay in place in a narrow window, one of them hidden: the list keeps its scroll and selection. -->
    <div class="pane" class:away={column === "message"} inert={column === "message"} bind:this={listPane}>
      <MessageList bind:searchInput edge={layout.single} />
    </div>
    {#if !layout.single}
      <div class="gutter" role="separator" aria-orientation="vertical" onpointerdown={(e) => drag("list", e)}></div>
    {/if}
    <div class="pane" class:away={column === "list"} inert={column === "list"} bind:this={readerPane}>
      <Reader onReply={(all) => app.replyTo(all)} onForward={() => app.forwardOpened()} />
    </div>
  {/if}
</div>

<Dock />
{#if app.wizard}
  <Wizard />
{/if}
{#if app.settingsOpen}
  <Preferences />
{/if}
{#if app.tasksOpen}
  <Tasks />
{/if}
{#each registry.lists.overlays as o (o)}
  <o.item.component {...o.item.props ?? {}} />
{/each}

{#if peopleOps.dialog}<MergeDialog />{/if}
{#if peopleOps.picking}<PickPerson />{/if}

{#if app.confirmation}
  {#key app.confirmation}<Confirm q={app.confirmation} />
{/key}
{/if}

{#if app.labels.card}
  {@const acc = app.account(app.labels.card.accountId)}
  {@const fol = app.folder(app.labels.card.accountId, app.labels.card.folder)}
  {#if acc && fol}
    <FolderPropsCard at={{ x: Math.round(window.innerWidth / 2 - 160), y: 120 }} account={acc} folder={fol} onclose={() => app.labels.closeCard()} />
  {/if}
{/if}

{#if app.labels.pick}
  <Popover
    bind:open={() => app.labels.pick !== null, (v) => !v && app.labels.closePick()}
    at={app.labels.pick.at ?? keyAnchor()}
  >
    <LabelPicker rows={app.labels.pickRows()} />
  </Popover>
{/if}

<WindowControls />


<style>
  .layout {
    display: grid;
    height: 100vh;
  }

  /* A hairline to look at, a wider strip to grab. */
  .gutter {
    position: relative;
    z-index: 5;
    cursor: col-resize;
    background: var(--line);
    touch-action: none;
  }

  .gutter::after {
    content: "";
    position: absolute;
    inset: 0 -3px;
  }

  .gutter:hover,
  .gutter:active {
    background: var(--accent);
    box-shadow: 0 0 0 1px var(--accent);
  }

  .wide {
    overflow: auto;
  }

  .pane {
    display: grid;
    min-width: 0;
    min-height: 0;
  }

  /* One column for both in a narrow window; the one away keeps its layout, unseen. */
  .single .pane {
    grid-row: 1;
    grid-column: 3;
  }

  .pane.away {
    visibility: hidden;
  }
</style>

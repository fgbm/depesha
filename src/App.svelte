<script lang="ts">
  import { onMount, untrack } from "svelte";
  import { getCurrentWebview } from "@tauri-apps/api/webview";
  import type { PhysicalPosition } from "@tauri-apps/api/dpi";
  import type { DropZone } from "./lib/images";
  import { app } from "./lib/store.svelte";
  import { api } from "./lib/api";
  import { t } from "./lib/i18n.svelte";
  import { keyNames, shortcutKeys } from "./lib/keys";
  import { layout } from "./lib/layout.svelte";
  import Sidebar from "./components/Sidebar.svelte";
  import MessageList from "./components/MessageList.svelte";
  import Reader from "./components/Reader.svelte";
  import Dock from "./components/Dock.svelte";
  import Wizard from "./components/Wizard.svelte";
  import Outbox from "./components/Outbox.svelte";
  import Preferences from "./components/Preferences.svelte";
  import Tasks from "./components/Tasks.svelte";
  import WindowControls from "./components/WindowControls.svelte";
  import Confirm from "./components/Confirm.svelte";
  import { host } from "./plugin-host/host.svelte";
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

  /** A letter (or its error, or one being opened) to show; several selected rows are not one. */
  const hasLetter = $derived(app.selected.size <= 1 && !!(app.opened || app.opening || app.openError));
  const column = $derived(layout.single ? layout.column(hasLetter) : null);

  // Another list starts on the list in a narrow window.
  $effect(() => {
    void app.view;
    untrack(() => layout.showList());
  });

  onMount(() => {
    app.init().catch((e) => app.fail(e, t("startup")));
    // Files dropped on the window go to the open composition: attached, or, in an HTML
    // letter, pictures into the text when dropped on that zone.
    const zoneAt = (pos: PhysicalPosition): DropZone | null => {
      const { x, y } = pos.toLogical(window.devicePixelRatio);
      const zone = document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-drop-zone]")?.dataset.dropZone;
      return zone === "inline" || zone === "attach" ? zone : null;
    };
    const unlisten = getCurrentWebview().onDragDropEvent(async (e) => {
      const c = app.activeCompose();
      const p = e.payload;
      if (!c) return;
      if (p.type === "enter") app.compose.dragEnter(c, p.paths);
      else if (p.type === "over" && app.compose.dragging) app.compose.dragging.zone = zoneAt(p.position);
      else if (p.type === "leave") app.compose.dragging = null;
      else if (p.type === "drop") await app.compose.dropFiles(c, p.paths, zoneAt(p.position));
    });
    return () => {
      unlisten.then((f) => f());
    };
  });

  /** The first plugin binding of any of the names (what the key types, then its US key). */
  function pluginKey(names: string[]): (() => void) | undefined {
    const bindings = registry.items("keybindings");
    for (const name of names) {
      const run = bindings.find((b) => b.key === name && (!b.when || b.when()))?.run;
      if (run) return run;
    }
  }

  function onKey(e: KeyboardEvent) {
    if (app.wizard) return;
    const names = keyNames(e);
    // Typing in a composition window: its own keys (Ctrl+Enter, Esc) handle it.
    // Only Ctrl+K reaches the app from there: the palette opens from anywhere.
    if ((e.target as HTMLElement | null)?.closest?.(".compose") && !names.includes("Mod+k")) return;
    // Shortcuts with Ctrl/Cmd work from text fields too (Ctrl+K in the search box).
    if (e.ctrlKey || e.metaKey) {
      // Ctrl+, opens the settings, as in most desktop programs (Obsidian, VS Code).
      if (e.key === "," && !e.altKey && !app.settingsOpen) {
        e.preventDefault();
        app.openSettings();
        return;
      }
      // Ctrl+A in the list selects every row, as in any list; in a field it selects its text.
      const target = e.target as HTMLElement | null;
      const typing = !!target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable);
      if (names.includes("Mod+a") && !e.altKey && !e.shiftKey && !typing && !app.settingsOpen && app.windowOf === null) {
        e.preventDefault();
        app.selectAll();
        return;
      }
      const run = pluginKey(names);
      if (run) {
        e.preventDefault();
        run();
      }
      return;
    }
    if (app.settingsOpen || app.tasksOpen) return;
    const t = e.target as HTMLElement;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)) {
      if (e.key === "Escape") t.blur();
      return;
    }
    if (e.altKey) return;
    // A narrow window shows the list or the letter: Enter opens the selected one, Esc goes back.
    // Keys a viewer or a menu took already, and Enter on a focused button, are not theirs.
    const onButton = !!t?.closest?.("button, a");
    if (!e.defaultPrevented && ((e.key === "Enter" && !onButton && layout.enter(app.selected.size)) || (e.key === "Escape" && layout.back(hasLetter)))) {
      e.preventDefault();
      return;
    }
    const actions: Record<string, () => void> = {
      j: () => app.move(1),
      ArrowDown: () => app.move(1),
      k: () => app.move(-1),
      ArrowUp: () => app.move(-1),
      r: () => app.replyTo(false),
      a: () => app.replyTo(true),
      f: () => app.forwardOpened(),
      c: () => app.newMessage(),
      Delete: () => app.remove(),
      "#": () => app.remove(),
      e: () => app.archive(),
      "!": () => app.spam(),
      z: () => app.undo(),
      u: () => app.opened && app.flag("seen", !app.opened.row.flags.seen),
      s: () => app.opened && app.flag("flagged", !app.opened.row.flags.flagged),
      "/": () => searchInput?.focus(),
    };
    // Named keys (ArrowDown, Delete) keep their case; letters work on any layout.
    const action = shortcutKeys(e).map((k) => actions[k]).find(Boolean) ?? pluginKey(names);
    if (action) {
      e.preventDefault();
      action();
    }
  }

  // Built-in plugins follow the settings: switched on and off at once.
  $effect(() => {
    void app.settings.disabled_plugins;
    host.sync();
  });

  $effect(() => {
    app.focusSearch = () => searchInput?.focus();
  });
</script>

<svelte:window onkeydown={onKey} onresize={() => layout.resize(window.innerWidth)} />

<div
  class="layout"
  class:single={layout.single}
  style:grid-template-columns={app.view.kind === "outbox"
    ? `${layout.sideWidth}px 1fr`
    : layout.single
      ? `${layout.sideWidth}px 1px 1fr`
      : `${layout.sideWidth}px 1px ${layout.listWidth}px 1px 1fr`}
>
  <Sidebar onCompose={() => app.newMessage()} />
  {#if app.view.kind === "outbox"}
    <section class="wide"><Outbox /></section>
  {:else}
    <div class="gutter" role="separator" aria-orientation="vertical" onpointerdown={(e) => drag("side", e)}></div>
    <!-- Both stay in place in a narrow window, one of them hidden: the list keeps its scroll and selection. -->
    <div class="pane" class:away={column === "message"} inert={column === "message"}>
      <MessageList bind:searchInput edge={layout.single} />
    </div>
    {#if !layout.single}
      <div class="gutter" role="separator" aria-orientation="vertical" onpointerdown={(e) => drag("list", e)}></div>
    {/if}
    <div class="pane" class:away={column === "list"} inert={column === "list"}>
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

{#if app.confirmation}
  {#key app.confirmation}<Confirm q={app.confirmation} />{/key}
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

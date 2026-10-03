<script lang="ts">
  import { onMount } from "svelte";
  import { getCurrentWebview } from "@tauri-apps/api/webview";
  import { app } from "./lib/store.svelte";
  import { api } from "./lib/api";
  import { t } from "./lib/i18n.svelte";
  import { keyNames, shortcutKeys } from "./lib/keys";
  import Sidebar from "./components/Sidebar.svelte";
  import MessageList from "./components/MessageList.svelte";
  import Reader from "./components/Reader.svelte";
  import Compose from "./components/Compose.svelte";
  import Wizard from "./components/Wizard.svelte";
  import Outbox from "./components/Outbox.svelte";
  import Preferences from "./components/Preferences.svelte";
  import Plugins from "./components/Plugins.svelte";
  import Tasks from "./components/Tasks.svelte";
  import Accounts from "./components/Accounts.svelte";
  import WindowControls from "./components/WindowControls.svelte";
  import Confirm from "./components/Confirm.svelte";
  import { host } from "./plugin-host/host.svelte";
  import { registry } from "./plugin-host/registry.svelte";

  let searchInput = $state<HTMLInputElement | null>(null);

  // Pane widths, remembered between launches.
  const saved = JSON.parse(localStorage.getItem("depesha.panes") ?? "{}");
  let side = $state<number>(saved.side ?? 248);
  let list = $state<number>(saved.list ?? 380);

  function drag(which: "side" | "list", e: PointerEvent) {
    const startX = e.clientX;
    const start = which === "side" ? side : list;
    const target = e.currentTarget as HTMLElement;
    target.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => {
      const w = start + ev.clientX - startX;
      if (which === "side") side = Math.min(420, Math.max(180, w));
      else list = Math.min(760, Math.max(280, w));
    };
    const up = () => {
      target.removeEventListener("pointermove", move);
      target.removeEventListener("pointerup", up);
      localStorage.setItem("depesha.panes", JSON.stringify({ side, list }));
    };
    target.addEventListener("pointermove", move);
    target.addEventListener("pointerup", up);
  }

  onMount(() => {
    app.init().catch((e) => app.fail(e, t("startup")));
    // Files dropped on the window become attachments of the open composition.
    const unlisten = getCurrentWebview().onDragDropEvent(async (e) => {
      const c = app.activeCompose();
      if (e.payload.type !== "drop" || !c) return;
      for (const path of e.payload.paths) {
        try {
          const info = await api.fileInfo(path);
          c.draft.attachments.push({ kind: "file", path, name: info.name, size: info.size });
        } catch (err) {
          app.fail(err);
        }
      }
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
    // Typing in a composition window: its own keys (Ctrl+Enter, Esc) handle it.
    if ((e.target as HTMLElement | null)?.closest?.(".compose")) return;
    const names = keyNames(e);
    // Shortcuts with Ctrl/Cmd work from text fields too (Ctrl+K in the search box).
    if (e.ctrlKey || e.metaKey) {
      const run = pluginKey(names);
      if (run) {
        e.preventDefault();
        run();
      }
      return;
    }
    if (app.settingsOpen || app.pluginsOpen || app.tasksOpen || app.accountsOpen) return;
    const t = e.target as HTMLElement;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)) {
      if (e.key === "Escape") t.blur();
      return;
    }
    if (e.altKey) return;
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

<svelte:window onkeydown={onKey} />

<div
  class="layout"
  style:grid-template-columns={app.view.kind === "outbox" ? `${side}px 1fr` : `${side}px 1px ${list}px 1px 1fr`}
>
  <Sidebar onCompose={() => app.newMessage()} />
  {#if app.view.kind === "outbox"}
    <section class="wide"><Outbox /></section>
  {:else}
    <div class="gutter" role="separator" aria-orientation="vertical" onpointerdown={(e) => drag("side", e)}></div>
    <MessageList bind:searchInput />
    <div class="gutter" role="separator" aria-orientation="vertical" onpointerdown={(e) => drag("list", e)}></div>
    <Reader onReply={(all) => app.replyTo(all)} onForward={() => app.forwardOpened()} />
  {/if}
</div>

<!-- Compositions dock in the corner and leave the mail usable, as in Gmail and Yandex Mail. -->
<!-- Toasts sit left of the windows: they never cover a window's Send button. -->
<div class="dock">
  <div class="toasts" aria-live="polite">
    {#each app.toasts as toast (toast.id)}
      <div class="toast" class:error={toast.error}>
        <span class="selectable">{toast.text}</span>
        {#if toast.action}
          <button class="btn ghost act" onclick={() => { app.dismiss(toast.id); toast.action?.run(); }}>{toast.action.label}</button>
        {/if}
        <button class="btn ghost close" onclick={() => app.dismiss(toast.id)} aria-label={t("close")}>×</button>
      </div>
    {/each}
  </div>
  {#each app.composes as c (c.id)}
    <Compose {c} />
  {/each}
</div>
{#if app.wizard}
  <Wizard />
{/if}
{#if app.settingsOpen}
  <Preferences />
{/if}
{#if app.pluginsOpen}
  <Plugins />
{/if}
{#if app.tasksOpen}
  <Tasks />
{/if}
{#if app.accountsOpen}
  <Accounts />
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

  /* Newest on the right; a full-screen window leaves the dock (position: fixed). */
  .dock {
    position: fixed;
    right: 16px;
    bottom: 0;
    display: flex;
    align-items: flex-end;
    gap: 12px;
    z-index: 30;
    pointer-events: none;
  }

  .dock > :global(*) {
    pointer-events: auto;
  }

  /* In the dock, under dialogs (their z-index is higher): a toast covers neither
     a dialog's buttons nor a composition window. */
  .toasts {
    display: flex;
    flex-direction: column;
    gap: 8px;
    margin-bottom: 16px;
    max-width: 440px;
  }

  .toast {
    display: flex;
    align-items: center;
    gap: 8px;
    background: var(--side);
    color: var(--side-ink);
    border-radius: var(--radius);
    padding: 10px 8px 10px 14px;
    box-shadow: 0 8px 24px rgb(0 0 0 / 25%);
    line-height: 1.4;
  }

  .toast.error {
    border-left: 4px solid var(--accent);
  }

  .toast .act {
    color: inherit;
    text-decoration: underline;
    text-underline-offset: 3px;
    font-weight: 600;
    padding: 0 6px;
    white-space: nowrap;
  }

  .toast .close {
    color: var(--side-muted);
    padding: 0 6px;
    font-size: 16px;
  }
</style>

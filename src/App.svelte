<script lang="ts">
  import { onMount } from "svelte";
  import { getCurrentWebview } from "@tauri-apps/api/webview";
  import { app } from "./lib/store.svelte";
  import { api } from "./lib/api";
  import { t } from "./lib/i18n.svelte";
  import Sidebar from "./components/Sidebar.svelte";
  import MessageList from "./components/MessageList.svelte";
  import Reader from "./components/Reader.svelte";
  import Compose from "./components/Compose.svelte";
  import Wizard from "./components/Wizard.svelte";
  import Outbox from "./components/Outbox.svelte";
  import Preferences from "./components/Preferences.svelte";
  import Plugins from "./components/Plugins.svelte";
  import WindowControls from "./components/WindowControls.svelte";
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
      if (e.payload.type !== "drop" || !app.compose) return;
      for (const path of e.payload.paths) {
        try {
          const info = await api.fileInfo(path);
          app.compose.draft.attachments.push({ kind: "file", path, name: info.name, size: info.size });
        } catch (err) {
          app.fail(err);
        }
      }
    });
    return () => {
      unlisten.then((f) => f());
    };
  });

  /** "Mod+k", "h", "Delete": how plugins name keys. */
  function keyName(e: KeyboardEvent): string {
    const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    return (e.ctrlKey || e.metaKey ? "Mod+" : "") + (e.altKey ? "Alt+" : "") + key;
  }

  function pluginKey(name: string): (() => void) | undefined {
    return registry.items("keybindings").find((b) => b.key === name && (!b.when || b.when()))?.run;
  }

  function onKey(e: KeyboardEvent) {
    if (app.compose || app.wizard) return;
    const name = keyName(e);
    // Shortcuts with Ctrl/Cmd work from text fields too (Ctrl+K in the search box).
    if (name.startsWith("Mod+")) {
      const run = pluginKey(name);
      if (run) {
        e.preventDefault();
        run();
      }
      return;
    }
    if (app.settingsOpen || app.pluginsOpen) return;
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
    const action = actions[e.key] ?? pluginKey(name);
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
  style:grid-template-columns={app.view.kind === "outbox" ? `${side}px 1fr` : `${side}px 4px ${list}px 4px 1fr`}
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

{#if app.compose}
  <Compose />
{/if}
{#if app.wizard}
  <Wizard />
{/if}
{#if app.settingsOpen}
  <Preferences />
{/if}
{#if app.pluginsOpen}
  <Plugins />
{/if}
{#each registry.lists.overlays as o (o)}
  <o.item.component {...o.item.props ?? {}} />
{/each}

<WindowControls />

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

<style>
  .layout {
    display: grid;
    height: 100vh;
  }

  .gutter {
    cursor: col-resize;
    background: var(--line);
    touch-action: none;
  }

  .gutter:hover,
  .gutter:active {
    background: var(--accent);
  }

  .wide {
    overflow: auto;
  }

  /* Under dialogs (their z-index is higher): a toast never covers a dialog's buttons. */
  .toasts {
    position: fixed;
    right: 16px;
    bottom: 16px;
    display: flex;
    flex-direction: column;
    gap: 8px;
    z-index: 40;
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
    color: #f3c27a;
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

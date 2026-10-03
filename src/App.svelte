<script lang="ts">
  import { onMount } from "svelte";
  import { getCurrentWebview } from "@tauri-apps/api/webview";
  import { app } from "./lib/store.svelte";
  import { emptyDraft, forward, reply, withSignature } from "./lib/compose";
  import { api } from "./lib/api";
  import Sidebar from "./components/Sidebar.svelte";
  import MessageList from "./components/MessageList.svelte";
  import Reader from "./components/Reader.svelte";
  import Compose from "./components/Compose.svelte";
  import Wizard from "./components/Wizard.svelte";
  import Outbox from "./components/Outbox.svelte";

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
    app.init().catch((e) => app.fail(e, "Запуск"));
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

  function newMessage() {
    const acc = app.defaultAccount();
    if (!acc) {
      app.wizard = { account: null };
      return;
    }
    const draft = withSignature(emptyDraft({ name: acc.display_name, email: acc.email }), acc.signature);
    app.compose = { account_id: acc.id, draft, draft_id: null };
  }

  function replyTo(all: boolean) {
    const msg = app.opened;
    if (!msg) return;
    const acc = app.account(msg.row.account_id);
    if (!acc) return;
    app.compose = {
      account_id: acc.id,
      draft: withSignature(reply(msg, { name: acc.display_name, email: acc.email }, all), acc.signature),
      draft_id: null,
    };
  }

  function forwardIt() {
    const msg = app.opened;
    if (!msg) return;
    const acc = app.account(msg.row.account_id);
    if (!acc) return;
    const draft = withSignature(forward(msg, { name: acc.display_name, email: acc.email }), acc.signature);
    app.compose = { account_id: acc.id, draft, draft_id: null };
  }

  function onKey(e: KeyboardEvent) {
    if (app.compose || app.wizard) return;
    const t = e.target as HTMLElement;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)) {
      if (e.key === "Escape") t.blur();
      return;
    }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const actions: Record<string, () => void> = {
      j: () => app.move(1),
      ArrowDown: () => app.move(1),
      k: () => app.move(-1),
      ArrowUp: () => app.move(-1),
      r: () => replyTo(false),
      a: () => replyTo(true),
      f: () => forwardIt(),
      c: () => newMessage(),
      Delete: () => app.remove(),
      "#": () => app.remove(),
      u: () => app.opened && app.flag("seen", !app.opened.row.flags.seen),
      s: () => app.opened && app.flag("flagged", !app.opened.row.flags.flagged),
      "/": () => searchInput?.focus(),
    };
    const action = actions[e.key];
    if (action) {
      e.preventDefault();
      action();
    }
  }
</script>

<svelte:window onkeydown={onKey} />

<div
  class="layout"
  style:grid-template-columns={app.view.kind === "outbox" ? `${side}px 1fr` : `${side}px 4px ${list}px 4px 1fr`}
>
  <Sidebar onCompose={newMessage} />
  {#if app.view.kind === "outbox"}
    <section class="wide"><Outbox /></section>
  {:else}
    <div class="gutter" role="separator" aria-orientation="vertical" onpointerdown={(e) => drag("side", e)}></div>
    <MessageList bind:searchInput />
    <div class="gutter" role="separator" aria-orientation="vertical" onpointerdown={(e) => drag("list", e)}></div>
    <Reader onReply={replyTo} onForward={forwardIt} />
  {/if}
</div>

{#if app.compose}
  <Compose />
{/if}
{#if app.wizard}
  <Wizard />
{/if}

<div class="toasts" aria-live="polite">
  {#each app.toasts as t (t.id)}
    <div class="toast" class:error={t.error}>
      <span class="selectable">{t.text}</span>
      <button class="btn ghost close" onclick={() => app.dismiss(t.id)} aria-label="Закрыть">×</button>
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

  .toasts {
    position: fixed;
    right: 16px;
    bottom: 16px;
    display: flex;
    flex-direction: column;
    gap: 8px;
    z-index: 100;
    max-width: 440px;
  }

  .toast {
    display: flex;
    align-items: flex-start;
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

  .toast .close {
    color: var(--side-muted);
    padding: 0 6px;
    font-size: 16px;
  }
</style>

<script lang="ts">
  import { app, type View } from "../lib/store.svelte";
  import { api } from "../lib/api";
  import type { AccountView, FolderInfo, FolderRole } from "../lib/types";

  let { onCompose }: { onCompose: () => void } = $props();

  const ROLE_LABEL: Record<FolderRole, string> = {
    inbox: "Входящие",
    drafts: "Черновики",
    sent: "Отправленные",
    archive: "Архив",
    junk: "Спам",
    trash: "Корзина",
  };
  const ROLE_ICON: Record<FolderRole, string> = {
    inbox: "📥",
    drafts: "📝",
    sent: "📤",
    archive: "🗄",
    junk: "⚠",
    trash: "🗑",
  };

  let collapsed = $state<Record<string, boolean>>({});
  let menuFor = $state<string | null>(null);

  const totalUnread = $derived(
    app.folders.filter((f) => f.role === "inbox").reduce((n, f) => n + f.unread, 0),
  );

  function foldersOf(acc: AccountView): FolderInfo[] {
    return app.folders.filter((f) => f.account_id === acc.id && !f.hidden);
  }

  function depth(f: FolderInfo): number {
    if (!f.delimiter || f.role) return 0;
    const parts = f.name.split(f.delimiter);
    // Children of INBOX on Dovecot-style servers are shown one level deep.
    return Math.max(0, parts.length - 1 - (parts[0].toUpperCase() === "INBOX" ? 1 : 0));
  }

  function label(f: FolderInfo): string {
    if (f.role) return ROLE_LABEL[f.role];
    if (!f.delimiter) return f.display_name;
    return f.display_name.split(f.delimiter).pop() ?? f.display_name;
  }

  function isActive(v: View): boolean {
    const c = app.view;
    if (c.kind !== v.kind) return false;
    if (c.kind === "unified" && v.kind === "unified")
      return c.role === v.role && !!c.unread === !!v.unread && !!c.flagged === !!v.flagged;
    if (c.kind === "folder" && v.kind === "folder") return c.account_id === v.account_id && c.folder === v.folder;
    return c.kind === "outbox";
  }

  function statusText(acc: AccountView): string {
    const s = acc.status;
    if (!s) return "Подключение…";
    if (s.state === "online") return "В сети";
    if (s.state === "connecting") return "Подключение…";
    return s.error?.message ?? "Ошибка";
  }

  async function refresh(acc: AccountView) {
    menuFor = null;
    try {
      await api.syncNow(acc.id);
    } catch (e) {
      app.fail(e, acc.email);
    }
  }

  const outboxFailed = $derived(app.outbox.some((o) => o.failed));
</script>

<nav class="side">
  <div class="brand">
    <img src="/icon.png" alt="" width="26" height="26" />
    <span>Депеша</span>
  </div>

  <button class="btn primary compose-btn" onclick={onCompose}>✎ Написать</button>

  <div class="scroll">
    <div class="group">
      {#each [{ kind: "unified", role: "inbox" }, { kind: "unified", role: "inbox", unread: true }, { kind: "unified", role: "inbox", flagged: true }] as v, i}
        <button class="item" class:active={isActive(v as View)} onclick={() => app.setView(v as View)}>
          <span class="icon">{["📥", "●", "⚑"][i]}</span>
          <span class="name">{["Все входящие", "Непрочитанные", "С флагом"][i]}</span>
          {#if i === 0 && totalUnread > 0}<span class="count">{totalUnread}</span>{/if}
        </button>
      {/each}
      {#if app.outbox.length > 0}
        <button class="item" class:active={isActive({ kind: "outbox" })} onclick={() => app.setView({ kind: "outbox" })}>
          <span class="icon">⏳</span>
          <span class="name">Исходящие</span>
          <span class="count" class:alert={outboxFailed}>{app.outbox.length}</span>
        </button>
      {/if}
    </div>

    {#each app.accounts as acc (acc.id)}
      <div class="group">
        <div class="account">
          <button class="account-name" onclick={() => (collapsed[acc.id] = !collapsed[acc.id])} title={acc.email}>
            <span class="dot {acc.status?.state ?? 'connecting'}" title={statusText(acc)}></span>
            <span class="name">{acc.display_name || acc.email}</span>
            <span class="chev">{collapsed[acc.id] ? "▸" : "▾"}</span>
          </button>
          <button class="menu-btn" onclick={() => (menuFor = menuFor === acc.id ? null : acc.id)} aria-label="Меню ящика">⋯</button>
          {#if menuFor === acc.id}
            <div class="menu">
              <button onclick={() => refresh(acc)}>Обновить</button>
              <button onclick={() => { menuFor = null; app.wizard = { account: acc }; }}>Настройки…</button>
            </div>
          {/if}
        </div>
        {#if acc.status && (acc.status.state === "error" || acc.status.state === "paused")}
          <button class="problem" onclick={() => (acc.status?.state === "paused" ? (app.wizard = { account: acc }) : refresh(acc))}>
            {statusText(acc)}
            <span class="fix">{acc.status.state === "paused" ? "Исправить…" : "Повторить"}</span>
          </button>
        {/if}
        {#if !collapsed[acc.id]}
          {#each foldersOf(acc) as f (f.name)}
            {@const v = { kind: "folder", account_id: acc.id, folder: f.name } as View}
            <button
              class="item"
              class:active={isActive(v)}
              class:disabled={!f.selectable}
              disabled={!f.selectable}
              style:padding-left="{14 + depth(f) * 14}px"
              onclick={() => app.setView(v)}
              title={f.display_name}
            >
              <span class="icon">{f.role ? ROLE_ICON[f.role] : "📁"}</span>
              <span class="name">{label(f)}</span>
              {#if f.unread > 0 && f.role !== "sent" && f.role !== "trash" && f.role !== "drafts"}
                <span class="count">{f.unread}</span>
              {/if}
            </button>
          {/each}
        {/if}
      </div>
    {/each}
  </div>

  <button class="btn ghost add" onclick={() => (app.wizard = { account: null })}>＋ Добавить ящик</button>
</nav>

<style>
  .side {
    background: var(--side);
    color: var(--side-ink);
    display: flex;
    flex-direction: column;
    min-height: 0;
  }

  .brand {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 16px 16px 8px;
    font-weight: 700;
    font-size: 17px;
    letter-spacing: 0.02em;
  }

  .compose-btn {
    margin: 8px 14px 10px;
    justify-content: center;
    padding: 8px;
  }

  .scroll {
    flex: 1;
    overflow-y: auto;
    padding-bottom: 8px;
  }

  .group {
    padding: 6px 0;
    border-top: 1px solid rgb(255 255 255 / 6%);
  }

  .group:first-child {
    border-top: none;
  }

  .item {
    width: 100%;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 5px 14px;
    background: none;
    border: none;
    color: var(--side-ink);
    text-align: left;
  }

  .item:hover:not(:disabled) {
    background: var(--side-2);
  }

  .item.active {
    background: var(--side-2);
    box-shadow: inset 3px 0 0 var(--accent);
  }

  .item.disabled {
    color: var(--side-muted);
    cursor: default;
  }

  .icon {
    width: 18px;
    text-align: center;
    font-size: 13px;
    opacity: 0.85;
  }

  .name {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .count {
    font-size: 12px;
    font-weight: 600;
    color: var(--side-ink);
    background: rgb(255 255 255 / 10%);
    border-radius: 10px;
    padding: 0 7px;
  }

  .count.alert {
    background: var(--accent);
  }

  .account {
    position: relative;
    display: flex;
    align-items: center;
    padding-right: 6px;
  }

  .account-name {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 8px;
    background: none;
    border: none;
    color: var(--side-muted);
    padding: 6px 4px 6px 14px;
    font-size: 12px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    text-align: left;
  }

  .chev {
    font-size: 10px;
  }

  .menu-btn {
    background: none;
    border: none;
    color: var(--side-muted);
    padding: 2px 6px;
    border-radius: 4px;
  }

  .menu-btn:hover {
    background: var(--side-2);
    color: var(--side-ink);
  }

  .menu {
    position: absolute;
    right: 8px;
    top: 28px;
    background: var(--paper);
    color: var(--ink);
    border-radius: 8px;
    box-shadow: 0 8px 24px rgb(0 0 0 / 30%);
    z-index: 10;
    display: flex;
    flex-direction: column;
    padding: 4px;
    min-width: 150px;
  }

  .menu button {
    background: none;
    border: none;
    text-align: left;
    padding: 6px 10px;
    border-radius: 5px;
  }

  .menu button:hover {
    background: var(--hover);
  }

  .dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    flex: none;
    background: var(--side-muted);
  }

  .dot.online {
    background: #4caf7a;
  }

  .dot.error {
    background: #e0a030;
  }

  .dot.paused {
    background: var(--accent);
  }

  .problem {
    margin: 2px 12px 6px;
    padding: 6px 8px;
    font-size: 12px;
    line-height: 1.35;
    color: #f2c9c4;
    background: rgb(179 38 30 / 22%);
    border: none;
    border-radius: 6px;
    text-align: left;
    width: calc(100% - 24px);
  }

  .problem .fix {
    display: block;
    margin-top: 3px;
    font-weight: 600;
    color: #fff;
  }

  .add {
    color: var(--side-muted);
    margin: 6px 10px 12px;
    justify-content: flex-start;
  }

  .add:hover {
    color: var(--side-ink);
    background: var(--side-2) !important;
  }
</style>

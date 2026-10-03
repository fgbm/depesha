<script lang="ts">
  import { app } from "../lib/store.svelte";
  import { addrName, listDate, pluralRu } from "../lib/format";
  import type { MessageRow } from "../lib/types";

  let { searchInput = $bindable() }: { searchInput: HTMLInputElement | null } = $props();

  const ROLE_TITLE = {
    inbox: "Входящие",
    drafts: "Черновики",
    sent: "Отправленные",
    archive: "Архив",
    junk: "Спам",
    trash: "Корзина",
  } as const;

  const ROW = 64;
  const OVERSCAN = 8;

  let viewport = $state<HTMLDivElement | null>(null);
  let scrollTop = $state(0);
  let height = $state(600);
  let searchText = $state("");
  let searchTimer: ReturnType<typeof setTimeout> | null = null;

  const start = $derived(Math.max(0, Math.floor(scrollTop / ROW) - OVERSCAN));
  const end = $derived(Math.min(app.messages.length, Math.ceil((scrollTop + height) / ROW) + OVERSCAN));
  const visible = $derived(app.messages.slice(start, end));

  const title = $derived.by(() => {
    const v = app.view;
    if (v.kind === "search") return "Поиск";
    if (v.kind === "unified") return v.unread ? "Непрочитанные" : v.flagged ? "С флагом" : "Все входящие";
    if (v.kind === "folder") {
      const f = app.folder(v.account_id, v.folder);
      const acc = app.account(v.account_id);
      const name = f?.role ? ROLE_TITLE[f.role] : (f?.display_name ?? v.folder);
      return `${name}${app.accounts.length > 1 && acc ? ` · ${acc.display_name || acc.email}` : ""}`;
    }
    return "";
  });

  const showAccount = $derived(app.accounts.length > 1 && app.view.kind !== "folder");
  const isSentLike = $derived.by(() => {
    const v = app.view;
    if (v.kind !== "folder") return false;
    const role = app.folder(v.account_id, v.folder)?.role;
    return role === "sent" || role === "drafts";
  });

  function onScroll() {
    if (!viewport) return;
    scrollTop = viewport.scrollTop;
    if (viewport.scrollTop + viewport.clientHeight > viewport.scrollHeight - ROW * 10) app.loadMore();
  }

  function onSearch() {
    if (searchTimer) clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      const text = searchText.trim();
      if (text) app.setView({ kind: "search", text });
      else if (app.view.kind === "search") app.setView({ kind: "unified", role: "inbox" });
    }, 250);
  }

  function clearSearch() {
    searchText = "";
    if (app.view.kind === "search") app.setView({ kind: "unified", role: "inbox" });
  }

  function click(e: MouseEvent, m: MessageRow) {
    app.select(m.id, e.shiftKey ? "range" : e.ctrlKey || e.metaKey ? "toggle" : "single");
  }

  function who(m: MessageRow): string {
    if (isSentLike) return m.to.length ? `Кому: ${m.to.map(addrName).join(", ")}` : "(нет получателей)";
    return addrName(m.from) || "(без отправителя)";
  }

  // Keep the opened message visible when moving with the keyboard.
  $effect(() => {
    const id = app.opened?.row.id;
    if (!viewport || id === undefined) return;
    const i = app.messages.findIndex((m) => m.id === id);
    if (i < 0) return;
    const top = i * ROW;
    if (top < viewport.scrollTop) viewport.scrollTop = top;
    else if (top + ROW > viewport.scrollTop + viewport.clientHeight) viewport.scrollTop = top + ROW - viewport.clientHeight;
  });

  // A new view starts at the top.
  $effect(() => {
    void app.view;
    if (viewport) viewport.scrollTop = 0;
    scrollTop = 0;
  });

  $effect(() => {
    if (app.view.kind !== "search") searchText = "";
  });
</script>

<section class="list">
  <header>
    <div class="search">
      <input
        class="input"
        placeholder="Поиск по почте  /"
        bind:this={searchInput}
        bind:value={searchText}
        oninput={onSearch}
        onkeydown={(e) => e.key === "Escape" && clearSearch()}
      />
      {#if searchText}<button class="btn ghost clear" onclick={clearSearch} aria-label="Очистить">×</button>{/if}
    </div>
    <div class="title">
      <h2>{title}</h2>
      <span class="muted">
        {#if app.selected.size > 1}
          выбрано {app.selected.size}
        {:else}
          {app.messages.length}{app.exhausted ? "" : "+"} {pluralRu(app.messages.length, "письмо", "письма", "писем")}
        {/if}
      </span>
    </div>
  </header>

  {#if app.view.kind === "search" && app.view.text.trim()}
    <div class="server">
      {#if app.serverSearching}
        <span class="muted">Ищем на серверах…</span>
      {:else if app.serverRows}
        <span class="muted">На серверах найдено: {app.serverRows.length}</span>
      {:else}
        <span class="muted">Здесь только загруженные письма.</span>
        <button class="btn ghost small" onclick={() => app.searchServer()}>Искать на сервере</button>
      {/if}
    </div>
  {/if}

  <div class="viewport" bind:this={viewport} bind:clientHeight={height} onscroll={onScroll} role="listbox" tabindex="-1">
    {#if app.messages.length === 0}
      <div class="empty muted">
        {#if app.view.kind === "search"}
          Ничего не найдено. Ищутся тема, адреса и текст уже открытых писем.
        {:else if app.accounts.length === 0}
          Добавьте почтовый ящик, чтобы начать.
        {:else}
          Писем нет
        {/if}
      </div>
    {/if}
    <div class="spacer" style:height="{app.messages.length * ROW}px">
      {#each visible as m, i (m.id)}
        <div
          class="row"
          class:unread={!m.flags.seen}
          class:selected={app.selected.has(m.id)}
          class:opened={app.opened?.row.id === m.id}
          style:top="{(start + i) * ROW}px"
          role="option"
          aria-selected={app.selected.has(m.id)}
          tabindex="-1"
          onclick={(e) => click(e, m)}
          onkeydown={() => {}}
        >
          <div class="line1">
            <span class="from">{who(m)}</span>
            {#if m.flags.flagged}<span class="flag" title="С флагом">⚑</span>{/if}
            {#if m.has_attachments}<span class="clip" title="Есть вложения">📎</span>{/if}
            <span class="date">{listDate(m.date)}</span>
          </div>
          <div class="line2">
            {#if m.flags.answered}<span class="answered" title="Отвечено">↩</span>{/if}
            <span class="subject">{m.subject || "(без темы)"}</span>
          </div>
          {#if showAccount}
            <div class="acct muted">{app.account(m.account_id)?.display_name ?? ""}</div>
          {/if}
        </div>
      {/each}
    </div>
    {#if app.loadingMore}<div class="more muted">Загрузка…</div>{/if}
  </div>
</section>

<style>
  .list {
    display: flex;
    flex-direction: column;
    min-height: 0;
    border-right: 1px solid var(--line);
    background: var(--paper);
  }

  header {
    padding: 12px 12px 8px;
    border-bottom: 1px solid var(--line);
  }

  .search {
    position: relative;
  }

  .search .input {
    width: 100%;
    padding-right: 30px;
  }

  .clear {
    position: absolute;
    right: 2px;
    top: 2px;
    padding: 3px 8px;
  }

  .title {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 8px;
    margin-top: 10px;
  }

  h2 {
    margin: 0;
    font-size: 16px;
    font-weight: 650;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .title .muted {
    font-size: 12px;
    white-space: nowrap;
  }

  .server {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    padding: 6px 12px;
    border-bottom: 1px solid var(--line);
    font-size: 12px;
    background: var(--paper-2);
  }

  .server .small {
    font-size: 12px;
    padding: 2px 8px;
    color: var(--link);
  }

  .viewport {
    flex: 1;
    overflow-y: auto;
    position: relative;
    outline: none;
  }

  .spacer {
    position: relative;
  }

  .row {
    position: absolute;
    left: 0;
    right: 0;
    height: 64px;
    padding: 9px 14px 0 18px;
    border-bottom: 1px solid var(--line);
    cursor: default;
    overflow: hidden;
  }

  .row:hover {
    background: var(--hover);
  }

  .row.selected,
  .row.opened {
    background: var(--selected);
  }

  .row.unread::before {
    content: "";
    position: absolute;
    left: 6px;
    top: 15px;
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--accent);
  }

  .line1,
  .line2 {
    display: flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
  }

  .from {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .unread .from,
  .unread .subject {
    font-weight: 650;
  }

  .date {
    font-size: 12px;
    color: var(--muted);
    white-space: nowrap;
  }

  .line2 {
    margin-top: 3px;
    color: var(--muted);
  }

  .unread .line2 {
    color: var(--ink);
  }

  .subject {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .flag {
    color: var(--accent);
  }

  .clip,
  .answered {
    font-size: 12px;
    color: var(--muted);
  }

  .acct {
    position: absolute;
    right: 14px;
    bottom: 6px;
    font-size: 11px;
  }

  .empty {
    padding: 40px 24px;
    text-align: center;
    line-height: 1.5;
  }

  .more {
    text-align: center;
    padding: 10px;
  }
</style>

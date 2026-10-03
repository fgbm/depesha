<script lang="ts">
  import Flag from "@lucide/svelte/icons/flag";
  import Paperclip from "@lucide/svelte/icons/paperclip";
  import Reply from "@lucide/svelte/icons/reply";
  import AlarmClock from "@lucide/svelte/icons/alarm-clock";
  import MessageSquareReply from "@lucide/svelte/icons/message-square-reply";
  import { app, type Split } from "../lib/store.svelte";
  import { addrName, listDate, roleLabel } from "../lib/format";
  import { i18n, t, tn } from "../lib/i18n.svelte";
  import { when } from "../lib/later";
  import type { MessageRow } from "../lib/types";

  let { searchInput = $bindable() }: { searchInput: HTMLInputElement | null } = $props();


  const SPLITS = $derived<{ value: Split; label: string }[]>([
    { value: "all", label: t("split.all") },
    { value: "people", label: t("split.people") },
    { value: "bulk", label: t("split.bulk") },
  ]);

  /** Account colour stripe in lists that mix accounts. */
  const PALETTE = ["#3f7cc4", "#c77d1a", "#4a9a6a", "#9b59b6", "#c0504d", "#2a9d9b"];
  function accountColor(id: string): string {
    return PALETTE[Math.max(0, app.accounts.findIndex((a) => a.id === id)) % PALETTE.length];
  }

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
    if (v.kind === "search") return t("search.title");
    if (v.kind === "snoozed") return t("role.snoozed");
    if (v.kind === "followups") return t("nav.followups");
    if (v.kind === "unified") return v.unread ? t("nav.unread") : v.flagged ? t("nav.flagged") : t("nav.allInboxes");
    if (v.kind === "folder") {
      const f = app.folder(v.account_id, v.folder);
      const acc = app.account(v.account_id);
      const name = f?.role ? roleLabel(f.role) : (f?.display_name ?? v.folder);
      return `${name}${app.accounts.length > 1 && acc ? ` · ${acc.display_name || acc.email}` : ""}`;
    }
    return "";
  });

  const showAccount = $derived(app.accounts.length > 1 && app.view.kind !== "folder");
  const isSentLike = $derived.by(() => {
    const v = app.view;
    if (v.kind === "followups") return true;
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
    if (isSentLike) return m.to.length ? t("list.to", { who: m.to.map(addrName).join(", ") }) : t("list.noRecipients");
    return addrName(m.from) || t("list.noSender");
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
        placeholder={t("search.placeholder")}
        bind:this={searchInput}
        bind:value={searchText}
        oninput={onSearch}
        onkeydown={(e) => e.key === "Escape" && clearSearch()}
      />
      {#if searchText}<button class="btn ghost clear" onclick={clearSearch} aria-label={t("clear")}>×</button>{/if}
    </div>
    {#if app.splittable()}
      <div class="split" role="tablist">
        {#each SPLITS as sp (sp.value)}
          <button role="tab" aria-selected={app.split === sp.value} class:on={app.split === sp.value} onclick={() => app.setSplit(sp.value)}>
            {sp.label}
          </button>
        {/each}
      </div>
    {/if}
    <div class="title">
      <h2>{title}</h2>
      <span class="muted">
        {#if app.selected.size > 1}
          {t("list.selected", { n: app.selected.size })}
        {:else}
          {tn("count.messages", app.messages.length, { n: `${app.messages.length}${app.exhausted ? "" : "+"}` })}
        {/if}
      </span>
    </div>
  </header>

  {#if app.view.kind === "search" && app.view.text.trim()}
    <div class="server">
      {#if app.serverSearching}
        <span class="muted">{t("search.serverRunning")}</span>
      {:else if app.serverRows}
        <span class="muted">{t("search.serverFound", { n: app.serverRows.length })}</span>
      {:else}
        <span class="muted">{t("search.localOnly")}</span>
        <button class="btn ghost small" onclick={() => app.searchServer()}>{t("search.onServer")}</button>
      {/if}
    </div>
  {/if}

  <div class="viewport" bind:this={viewport} bind:clientHeight={height} onscroll={onScroll} role="listbox" tabindex="-1">
    {#if app.messages.length === 0}
      <div class="empty muted">
        {#if app.view.kind === "search"}
          {t("search.nothing")}
          <div class="ops">
            {t("search.refine")}
            {#each (i18n.lang === "ru" ? ["от:", "кому:", "тема:", "есть:вложение", "is:unread", "после:2026-09-01", "в:архив"] : ["from:", "to:", "subject:", "has:attachment", "is:unread", "after:2026-09-01", "in:archive"]) as op (op)}<code>{op}</code>{" "}{/each}
          </div>
        {:else if app.view.kind === "snoozed"}
          {t("empty.snoozed.before")} <kbd>h</kbd> {t("empty.snoozed.after")}
        {:else if app.view.kind === "followups"}
          {t("empty.followups")}
        {:else if app.split === "people" && app.splittable()}
          {t("empty.people")}
        {:else if app.accounts.length === 0}
          {t("empty.noAccounts")}
        {:else}
          {t("empty.list")}
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
          style:--acct={showAccount ? accountColor(m.account_id) : "transparent"}
          role="option"
          aria-selected={app.selected.has(m.id)}
          tabindex="-1"
          onclick={(e) => click(e, m)}
          onkeydown={() => {}}
        >
          <div class="line1">
            <span class="from">{who(m)}</span>
            {#if m.thread_count > 1}<span class="count" title={t("list.inThread")}>{m.thread_count}</span>{/if}
            {#if m.flags.flagged}<span class="flag" title={t("nav.flagged")}><Flag size={13} /></span>{/if}
            {#if m.has_attachments}<span class="clip" title={t("list.hasFiles")}><Paperclip size={13} /></span>{/if}
            <span class="date">{listDate(m.date)}</span>
          </div>
          <div class="line2">
            {#if m.flags.answered}<span class="answered" title={t("list.answered")}><Reply size={13} /></span>{/if}
            <span class="subject">{m.subject || t("noSubject")}</span>
            {#if m.snoozed_until}
              <span class="tag" title={t("list.snoozedTag")}><AlarmClock size={12} /> {when(m.snoozed_until)}</span>
            {:else if m.followup_due}
              <span class="tag" class:due={m.followup_due * 1000 < Date.now()} title={t("list.followupTag")}><MessageSquareReply size={12} /> {when(m.followup_due)}</span>
            {/if}
          </div>
        </div>
      {/each}
    </div>
    {#if app.loadingMore}<div class="more muted">{t("loading")}</div>{/if}
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

  .split {
    display: flex;
    gap: 2px;
    margin-top: 10px;
    background: var(--paper-2);
    border-radius: 7px;
    padding: 2px;
  }

  .split button {
    flex: 1;
    border: none;
    background: none;
    border-radius: 5px;
    padding: 3px 6px;
    font-size: 12px;
    color: var(--muted);
  }

  .split button.on {
    background: var(--selected);
    color: var(--ink);
    font-weight: 600;
    box-shadow: 0 1px 2px rgb(0 0 0 / 10%);
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
    box-shadow: inset 3px 0 0 var(--acct, transparent);
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
    display: inline-flex;
  }

  .clip,
  .answered {
    color: var(--muted);
    display: inline-flex;
  }

  .count {
    font-size: 11px;
    color: var(--muted);
    border: 1px solid var(--line);
    border-radius: 8px;
    padding: 0 5px;
    line-height: 15px;
  }

  .tag {
    margin-left: auto;
    flex: none;
    display: inline-flex;
    align-items: center;
    gap: 3px;
    font-size: 11px;
    color: var(--muted);
    white-space: nowrap;
  }

  .tag.due {
    color: var(--accent);
    font-weight: 600;
  }

  .ops {
    margin-top: 10px;
    font-size: 12px;
    line-height: 1.9;
  }

  .ops code {
    background: var(--paper-2);
    border-radius: 4px;
    padding: 1px 4px;
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

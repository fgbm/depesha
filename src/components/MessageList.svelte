<script lang="ts">
  import Flag from "@lucide/svelte/icons/flag";
  import Paperclip from "@lucide/svelte/icons/paperclip";
  import Reply from "@lucide/svelte/icons/reply";
  import { app } from "../lib/store.svelte";
  import RowMenu from "./RowMenu.svelte";
  import ViewMenu from "./ViewMenu.svelte";
  import SearchBox from "./SearchBox.svelte";
  import { registry } from "../plugin-host/registry.svelte";
  import type { RowTag } from "../plugin-api";
  import { addrName, listDate, size } from "../lib/format";
  import { layout } from "../lib/layout.svelte";
  import { viewTitle } from "../lib/titles";
  import { i18n, locale, t, tn } from "../lib/i18n.svelte";
  import { recentSearches } from "../lib/recentSearches.svelte";
  import type { Addr, MessageRow } from "../lib/types";

  let {
    searchInput = $bindable(),
    edge = false,
  }: {
    searchInput: HTMLInputElement | null;
    /** The rightmost column (a narrow window): the header leaves room for the window buttons. */
    edge?: boolean;
  } = $props();


  const pluginView = $derived(app.view.kind === "plugin" ? registry.view(app.view.id) : undefined);

  function tagsOf(m: MessageRow): RowTag[] {
    return registry.collect<RowTag, MessageRow>("rowTags", m).slice(0, 1);
  }

  /** Account colour stripe in lists that mix accounts. */

  const ROW = 64;
  const OVERSCAN = 8;

  let viewport = $state<HTMLDivElement | null>(null);
  let scrollTop = $state(0);
  let height = $state(600);

  const start = $derived(Math.max(0, Math.floor(scrollTop / ROW) - OVERSCAN));
  const end = $derived(Math.min(app.messages.length, Math.ceil((scrollTop + height) / ROW) + OVERSCAN));
  const visible = $derived(app.messages.slice(start, end));

  const title = $derived(viewTitle(app.view));

  const count = $derived(tn("count.messages", app.messages.length, { n: `${app.messages.length}${app.exhausted ? "" : "+"}` }));

  const showAccount = $derived(app.accounts.length > 1 && app.view.kind !== "folder");
  /** Every row shows its size, quietly; ordered by size, the sizes are what is read. */
  const bySize = $derived(app.sort()[0]?.by === "size");
  const found = $derived.by(() => {
    const totals = app.searchTotals;
    if (!totals) return "";
    return tn("search.found", totals.count, { n: new Intl.NumberFormat(locale()).format(totals.count), size: size(totals.size) });
  });
  const isSentLike = $derived.by(() => {
    const v = app.view;
    if (v.kind === "plugin") return !!pluginView?.showRecipients;
    if (v.kind === "unified") return v.role === "sent" || v.role === "drafts";
    if (v.kind !== "folder") return false;
    const role = app.folder(v.account_id, v.folder)?.role;
    return role === "sent" || role === "drafts";
  });

  function onScroll() {
    if (!viewport) return;
    scrollTop = viewport.scrollTop;
    if (viewport.scrollTop + viewport.clientHeight > viewport.scrollHeight - ROW * 10) app.loadMore();
  }

  function click(e: MouseEvent, m: MessageRow) {
    const mode = e.shiftKey ? "range" : e.ctrlKey || e.metaKey ? "toggle" : "single";
    // A plain click opens the letter; in a narrow window it takes the column.
    if (mode === "single") layout.showLetter();
    // A result opened: the search was worth it, it goes among the recent ones.
    if (app.view.kind === "search") recentSearches.remember(app.view.text);
    app.select(m.id, mode);
  }

  let menu = $state<{ at: { x: number; y: number }; ids: number[] } | null>(null);

  /** A right click acts on the selection it falls in, otherwise selects its row, as in Outlook. */
  function context(e: MouseEvent, m: MessageRow) {
    e.preventDefault();
    let ids = app.selected.has(m.id) ? [...app.selected] : [m.id];
    if (!app.selected.has(m.id)) app.select(m.id);
    if (!ids.length) ids = [m.id];
    menu = { at: { x: e.clientX, y: e.clientY }, ids };
  }

  function who(m: MessageRow): string {
    if (isSentLike) return m.to.length ? t("list.to", { who: m.to.map(addrName).join(", ") }) : t("list.noRecipients");
    // A conversation names everyone who wrote, me as "me": "Ivan, me", as in Gmail.
    if (m.thread_senders?.length > 1) {
      const mine = new Set(app.accounts.map((a) => a.email.toLowerCase()));
      const names = m.thread_senders.map((a) => (mine.has(a.email.toLowerCase()) ? t("list.me") : firstName(a)));
      return names.length > 3 ? `${names[0]} … ${names.slice(-2).join(", ")}` : names.join(", ");
    }
    return addrName(m.from) || t("list.noSender");
  }

  function firstName(a: Addr): string {
    const name = a.name?.trim();
    return name ? name.split(/\s+/)[0] : a.email.split("@")[0];
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
</script>

<!-- The number of messages says little at a glance: it stays in the title's tooltip. -->
<section class="list" data-count={count}>
  <!-- Work on the server after a click (move, flag, search) shows here, so a click never looks ignored. -->
  {#if app.busy > 0}<div class="busy" role="progressbar" aria-label={t("loading")}><span></span></div>{/if}
  <header data-tauri-drag-region class:scrolled={scrollTop > 0} class:edge>
    <SearchBox bind:input={searchInput} />
    <div class="title">
      <h2 title={count}>{title}</h2>
      {#if app.listKey()}<ViewMenu />{/if}
    </div>
  </header>

  {#if app.view.kind === "search" && app.view.text.trim()}
    <!-- Totals of what the cache has; the servers are asked on demand, for mail older than the cache. -->
    <div class="server">
      <span class="totals">
        {#if found}<span class="found">{found}</span>{/if}
        <span class="muted">{app.serverRows ? t("search.withServer") : t("search.byCache")}</span>
      </span>
      {#if app.serverSearching}
        <span class="muted">{t("search.serverRunning")}</span>
      {:else if app.serverRows}
        <span class="muted" title={t("search.serverFound", { n: app.serverRows.length })}>{t("search.serverFoundShort", { n: app.serverRows.length })}</span>
      {:else}
        <button class="btn ghost small" title={t("search.onServerHint")} onclick={() => app.searchServer()}>{t("search.onServer")}</button>
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
            {#each (i18n.lang === "ru" ? ["от:", "кому:", "тема:", "есть:вложение", "is:unread", "после:2026-09-01", "год:2025", "старше:1г", "больше:25М", "в:Работа/*", "ящик:"] : ["from:", "to:", "subject:", "has:attachment", "is:unread", "after:2026-09-01", "year:2025", "older:1y", "larger:25M", "in:Work/*", "account:"]) as op (op)}<code>{op}</code>{" "}{/each}
          </div>
        {:else if pluginView}
          {pluginView.empty()}
        {:else if app.accounts.length === 0}
          {t("empty.noAccounts")}
        {:else if app.busy > 0}
          {t("loading")}
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
          style:--acct={showAccount ? app.accountColor(m.account_id) : "transparent"}
          role="option"
          aria-selected={app.selected.has(m.id)}
          tabindex="-1"
          onclick={(e) => click(e, m)}
          ondblclick={(e) => !e.shiftKey && !e.ctrlKey && !e.metaKey && app.openWindow(m)}
          oncontextmenu={(e) => context(e, m)}
          onkeydown={() => {}}
        >
          <div class="line1">
            <span class="from">{who(m)}</span>
            {#if m.thread_count > 1}<span class="count" title={t("list.inThread")}>{m.thread_count}</span>{/if}
            {#if m.thread_draft}<span class="draft">{t("list.draft")}</span>{/if}
            {#if m.flags.flagged}<span class="flag" title={t("nav.flagged")}><Flag size={13} /></span>{/if}
            {#if m.has_attachments}<span class="clip" title={t("list.hasFiles")}><Paperclip size={13} /></span>{/if}
            <span class="date">{listDate(m.thread_date || m.date)}</span>
          </div>
          <div class="line2">
            {#if m.flags.answered}<span class="answered" title={t("list.answered")}><Reply size={13} /></span>{/if}
            <span class="subject">{m.subject || t("noSubject")}</span>
            {#each tagsOf(m) as tag, ti (ti)}
              <span class="tag" class:due={tag.alert} title={tag.title}>{#if tag.icon}<tag.icon size={12} />{/if} {tag.text}</span>
            {/each}
            <span class="size" class:strong={bySize} title={t("list.size")}>{size(m.thread_size ?? m.size)}</span>
          </div>
        </div>
      {/each}
    </div>
    {#if app.loadingMore}<div class="more muted">{t("loading")}</div>{/if}
  </div>
  {#if menu}
    {#key menu}<RowMenu at={menu.at} ids={menu.ids} onclose={() => (menu = null)} />{/key}
  {/if}
</section>

<style>
  .list {
    display: flex;
    flex-direction: column;
    min-height: 0;
    position: relative;
    background: var(--paper);
  }

  /* Shows only when the server takes longer than a blink. */
  .busy {
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    height: 2px;
    overflow: hidden;
    z-index: 2;
    opacity: 0;
    animation: show 0s 0.15s forwards;
  }

  .busy span {
    display: block;
    width: 30%;
    height: 100%;
    background: var(--accent);
    animation: slide 1.1s ease-in-out infinite;
  }

  @keyframes show {
    to {
      opacity: 1;
    }
  }

  @keyframes slide {
    from {
      transform: translateX(-100%);
    }
    to {
      transform: translateX(340%);
    }
  }

  /* The header gets its line only once rows slide under it. */
  header {
    padding: 12px 12px 6px;
    border-bottom: 1px solid transparent;
  }

  header.scrolled {
    border-bottom-color: var(--line);
  }

  /* The right edge stays clear for the window controls (WindowControls.svelte). */
  header.edge :global(.search) {
    margin-right: 132px;
  }

  .title {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-top: 10px;
    min-height: 26px;
  }

  h2 {
    flex: 1;
    min-width: 0;
    margin: 0;
    font-size: 16px;
    font-weight: 650;
    overflow: hidden;
    text-overflow: ellipsis;
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

  .totals {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .found {
    color: var(--ink);
    font-weight: 600;
    margin-right: 4px;
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

  /* Rows are told apart by space and hover, not by lines between them. */
  .row {
    position: absolute;
    left: 6px;
    right: 6px;
    height: 62px;
    padding: 9px 10px 0 16px;
    border-radius: 7px;
    cursor: default;
    overflow: hidden;
  }

  /* Account mark in lists that mix accounts. */
  .row::after {
    content: "";
    position: absolute;
    left: 0;
    top: 14px;
    bottom: 14px;
    width: 3px;
    border-radius: 2px;
    background: var(--acct, transparent);
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
    left: 5px;
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

  /* Gmail's red "Draft": an answer was started and waits. */
  .draft {
    font-size: 12px;
    color: var(--accent);
    font-weight: 600;
    white-space: nowrap;
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

  /* The size, right in the second line: the subject gives way first in a narrow list. */
  .size {
    margin-left: auto;
    flex: none;
    font-size: 12px;
    color: var(--muted);
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }

  .tag + .size {
    margin-left: 0;
  }

  .size.strong {
    color: var(--ink);
    font-weight: 650;
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

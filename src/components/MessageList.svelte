<script lang="ts">
  import Flag from "@lucide/svelte/icons/flag";
  import Forward from "@lucide/svelte/icons/forward";
  import Paperclip from "@lucide/svelte/icons/paperclip";
  import Reply from "@lucide/svelte/icons/reply";
  import ReplyAll from "@lucide/svelte/icons/reply-all";
  import Eraser from "@lucide/svelte/icons/eraser";
  import Check from "@lucide/svelte/icons/check";
  import { tick } from "svelte";
  import { shortcuts } from "../lib/shortcuts.svelte";
  import { followFocus } from "../lib/listFocus";
  import { app } from "../lib/store.svelte";
  import { arrivals } from "../lib/arrivals.svelte";
  import Avatar from "./Avatar.svelte";
  import RowMenu from "./RowMenu.svelte";
  import Segments from "./Segments.svelte";
  import ViewMenu from "./ViewMenu.svelte";
  import SearchBox from "./SearchBox.svelte";
  import { registry } from "../plugin-host/registry.svelte";
  import type { RowTag } from "../plugin-api";
  import { addrName, listDate, size } from "../lib/format";
  import { layout } from "../lib/layout.svelte";
  import { viewTitle } from "../lib/titles";
  import { i18n, locale, t, tn } from "../lib/i18n.svelte";
  import { recentSearches } from "../lib/recentSearches.svelte";
  import { rowMarks } from "../lib/marks";
  import { rowAvatar } from "../lib/listAvatar";
  import { labelChips, readOnly } from "../lib/labels";
  import { labels as labelsCtl } from "../lib/labels.svelte";
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

  /** Below this the quiet notes of the first line give their room to the names. */
  const NOTES_FROM = 420;
  const notes = $derived(!layout.single && layout.listWidth >= NOTES_FROM);

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
  /** Whether labels can be stored on the server for the folders the rows lie in (#42). */  const labelsLocal = $derived.by(() => {
    const per = new Map<string, boolean>();
    for (const m of app.messages) {
      const key = `${m.account_id}\u0000${m.folder}`;
      if (!per.has(key)) per.set(key, !(labelsCtl.prop(m.account_id, m.folder)?.labels_on_server ?? true));
    }
    return per;
  });
  /** The label chips of a row, capped at two plus "+n", per the design (#42, frame 10). */
  function chipsOf(m: MessageRow) {
    const known = labelsCtl.of(m.account_id);
    const local = labelsLocal.get(`${m.account_id}\u0000${m.folder}`) ?? false;
    return labelChips(m.keywords ?? [], known, local);
  }

  /** A folder opened here that is known to be read-only: the header says so (#42, frame 7А). */
  const readOnlyHere = $derived.by(() => {
    const v = app.view;
    if (v.kind !== "folder") return false;
    const rights = labelsCtl.prop(v.account_id, v.folder)?.rights;
    return !!rights && readOnly(rights);
  });
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

  /** A round picture at the left of every row (#108); off, the rows are as they were. */
  const avatars = $derived(app.settings.list_avatars);
  const myAddresses = $derived(new Set(app.accounts.map((a) => a.email.toLowerCase())));
  /** The pictured row's person and whether a company logo may stand by them (the setting for logos too). */
  function pictureOf(m: MessageRow) {
    const mine = isSentLike && (app.view.kind !== "plugin" || ["sent", "drafts"].includes(app.folder(m.account_id, m.folder)?.role ?? ""));
    const who = rowAvatar(m, mine, myAddresses);
    return { addr: who.addr, brand: who.brand && app.settings.sender_logos };
  }

  const MARK_ICON = { reply: Reply, reply_all: ReplyAll, forward: Forward };

  function who(m: MessageRow): string {
    // "Waiting for reply" lists my letters and the letters I answered: each says its own.
    const mine = isSentLike && (app.view.kind !== "plugin" || ["sent", "drafts"].includes(app.folder(m.account_id, m.folder)?.role ?? ""));
    if (mine) return m.to.length ? t("list.to", { who: m.to.map(addrName).join(", ") }) : t("list.noRecipients");
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
    // The system focus frame goes with the selection, not stays on the row left behind (#94).
    const list = viewport;
    tick().then(() => followFocus(list, [...list.querySelectorAll<HTMLElement>(".row")].find((r) => r.style.top === `${top}px`)));
  });

  // A row a notification led to takes the keyboard (#63): e, #, j/k and Enter work at once.
  $effect(() => {
    const id = arrivals.focus;
    if (id === null || !viewport) return;
    const i = app.messages.findIndex((m) => m.id === id);
    if (i < 0) return;
    const top = i * ROW;
    if (top < viewport.scrollTop || top + ROW > viewport.scrollTop + viewport.clientHeight) viewport.scrollTop = top;
    scrollTop = viewport.scrollTop;
    tick().then(() => {
      [...(viewport?.querySelectorAll<HTMLElement>(".row") ?? [])].find((r) => r.style.top === `${top}px`)?.focus({ preventScroll: true });
      arrivals.focus = null;
    });
  });

  /** Enter on a row that has the keyboard opens it. */
  function rowKey(e: KeyboardEvent, m: MessageRow) {
    if (e.key !== "Enter" || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || app.opened?.row.id === m.id) return;
    e.preventDefault();
    layout.showLetter();
    app.select(m.id);
  }

  const clear = $derived(app.clearing.here());
  const clearReason = $derived(clear ? app.clearing.reason(clear.folder) : null);

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
    {#if pluginView?.tabs}<Segments tabs={pluginView.tabs} />{/if}
    <div class="title">
      <h2 title={count}>{title}</h2>
      {#if readOnlyHere}<span class="ro" title={t("list.readOnlyHint")}>{t("list.readOnly")}</span>{/if}
      {#if clear}
        <!-- «Clear» (#74): only in Trash, Spam and Drafts; the same command as the folder's menu and the palette. -->
        <button
          class="btn ghost small clear"
          disabled={!!clearReason}
          title={clearReason ?? shortcuts.titled(app.clearing.title(clear.role), "core.empty-folder")}
          onclick={() => void app.clearing.begin(clear.account_id, clear.folder.name)}
        ><Eraser size={14} /> {app.clearing.title(clear.role)} ({clear.folder.total})</button>
      {/if}
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
            {#each (i18n.lang === "ru" ? ["от:", "кому:", "тема:", "есть:вложение", "is:unread", "это:важное", "после:2026-09-01", "год:2025", "старше:1г", "больше:25М", "в:Работа/*", "ящик:"] : ["from:", "to:", "subject:", "has:attachment", "is:unread", "is:important", "after:2026-09-01", "year:2025", "older:1y", "larger:25M", "in:Work/*", "account:"]) as op (op)}<code>{op}</code>{" "}{/each}
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
        {@const tags = tagsOf(m)}
        <div
          class="row"
          class:unread={!m.flags.seen}
          class:selected={app.selected.has(m.id)}
          class:opened={app.opened?.row.id === m.id}
          class:avatars
          class:flash={arrivals.flash === m.id}
          class:fresh={arrivals.isFresh(app.view, m.id)}
          style:top="{(start + i) * ROW}px"
          style:--acct={showAccount ? app.accountColor(m.account_id) : "transparent"}
          role="option"
          aria-selected={app.selected.has(m.id)}
          tabindex="-1"
          onclick={(e) => click(e, m)}
          ondblclick={(e) => !e.shiftKey && !e.ctrlKey && !e.metaKey && app.openWindow(m)}
          oncontextmenu={(e) => context(e, m)}
          onkeydown={(e) => rowKey(e, m)}
        >
          <!-- Without the dot the unread state would live in the look alone: the name says it (#108). -->
          {#if !m.flags.seen}<span class="sr">{t("list.unreadSr")}</span>{/if}
          {#if app.selected.has(m.id)}
            <!-- A chosen row: a tick in the place of the picture, and the ground (#108, 2.5 Б). -->
            <span class="pick" class:round={avatars} aria-hidden="true"><Check size={avatars ? 18 : 10} strokeWidth={3} /></span>
          {:else if avatars}
            {@const pic = pictureOf(m)}
            <span class="pic"><Avatar addr={pic.addr} accountId={m.account_id} brand={pic.brand} /></span>
          {/if}
          <div class="line1">
            <span class="from">{who(m)}</span>
            {#if notes}
              {#each tags as tag, ti (ti)}
                {#if tag.note}<span class="note" title={tag.title}>{#if tag.note.icon}<tag.note.icon size={11} />{/if}<span class="note-text">{tag.note.text}</span></span>{/if}
              {/each}
            {/if}
            {#if m.thread_count > 1}<span class="count" title={t("list.inThread")}>{m.thread_count}</span>{/if}
            {#if m.thread_draft}<span class="draft">{t("list.draft")}</span>{/if}
            <!-- Asked to be read first (#72): the first of the marks before the date, in amber. -->
            {#if m.importance === "high"}<span class="imp" title={t("list.important")} aria-label={t("list.important")} role="img">!</span>{/if}
            {#if m.flags.flagged}<span class="flag" title={t("nav.flagged")}><Flag size={13} /></span>{/if}
            {#if m.has_attachments}<span class="clip" title={t("list.hasFiles")}><Paperclip size={13} /></span>{/if}
            <!-- What was done with it: last before the date, like the clip (#55). -->
            {#each rowMarks(m.marks) as mark (mark.act)}{@const Icon = MARK_ICON[mark.act]}<span class="mark" title={mark.title} aria-label={mark.label} role="img"><Icon size={13} /></span>{/each}
            <span class="date">{listDate(m.thread_date || m.date)}</span>
          </div>
          <div class="line2">
            <span class="subject">{m.subject || t("noSubject")}</span>
            <!-- Labels after the subject (#42, frame 10А): at most two, then "+n". -->
            {#each chipsOf(m).slice(0, 2) as chip (chip.name)}
              <span class="lbl" class:local={chip.local} style:--c={chip.color} title={chip.local ? t("label.localHint", { name: chip.name }) : chip.name}>{chip.name}</span>
            {/each}
            {#if chipsOf(m).length > 2}<span class="lbl more" title={chipsOf(m).slice(2).map((c) => c.name).join(", ")}>+{chipsOf(m).length - 2}</span>{/if}
            {#each tags as tag, ti (ti)}
              <span class="tag" class:due={tag.alert} class:good={tag.good} class:info={tag.info} title={tag.title}>{#if tag.icon}<tag.icon size={12} />{/if} {tag.text}</span>
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

  /* "Only read" in the header of a folder known to be read-only (#42, frame 7А). */
  .clear {
    flex: none;
    display: inline-flex;
    align-items: center;
    gap: 5px;
    white-space: nowrap;
  }

  .ro {
    flex: none;
    padding: 1px 7px;
    border-radius: 8px;
    border: 1px solid var(--line);
    color: var(--warn);
    font-size: 11px;
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

  /* New letters of a summary a notification opened (#63): tinted while the list is open. */
  .row.fresh {
    background: color-mix(in srgb, var(--accent) 8%, transparent);
  }

  /* The one frame is the app's own, not the browser's black one (#94). */
  .row {
    outline: none;
  }

  .row:hover {
    background: var(--hover);
  }

  /* Chosen rows have the ground and a tick; the row that is open or has the keyboard (the
     cursor) has only the bar, so a choice is never taken for the current letter (#108). The
     bar stands right of the mailbox stripe, not on it. */
  .row.selected {
    background: var(--selected);
  }

  .row.opened::before,
  .row:focus-visible::before {
    content: "";
    position: absolute;
    left: 4px;
    top: 8px;
    bottom: 8px;
    width: 2px;
    border-radius: 1px;
    background: var(--accent);
  }

  /* The picture (36 px, two lines tall) and the tick that takes its place. */
  .row.avatars {
    padding-left: 60px;
  }

  .pic,
  .pick {
    position: absolute;
    left: 14px;
    top: 13px;
    display: flex;
  }

  .pick {
    width: 36px;
    height: 36px;
    align-items: center;
    justify-content: center;
    border-radius: 50%;
    background: var(--accent);
    color: var(--accent-ink);
  }

  /* No pictures: the tick takes the strip at the left, the text does not move. */
  .pick:not(.round) {
    left: 6px;
    top: 14px;
    width: 10px;
    height: 10px;
    background: none;
    color: var(--accent);
  }

  .sr {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }

  /* The row a notification led to: a frame that fades in a moment. */
  .row.flash {
    box-shadow: inset 0 0 0 2px var(--accent);
    animation: flash-out 1.5s ease-in forwards;
  }

  @keyframes flash-out {
    to {
      box-shadow: inset 0 0 0 2px transparent;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .row.flash {
      animation: none;
    }
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

  /* A label of the row (#42): a chip with its colour; a dashed frame when it is kept
     only on this device. */
  .lbl {
    flex: none;
    max-width: 40%;
    padding: 0 6px;
    border-radius: 7px;
    border: 1px solid color-mix(in srgb, var(--c, var(--muted)) 45%, transparent);
    background: color-mix(in srgb, var(--c, var(--muted)) 14%, transparent);
    color: var(--c, var(--muted));
    font-size: 11px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .lbl.local {
    border-style: dashed;
  }

  .lbl.more {
    --c: var(--muted);
    font-variant-numeric: tabular-nums;
  }

  .flag {
    color: var(--accent);
    display: inline-flex;
  }

  .imp {
    color: var(--imp);
    font-weight: 800;
    font-size: 14px;
    line-height: 1;
  }

  .clip,
  .mark {
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

  /* The kind of a reminder before the date: gives way to the names first. */
  .note {
    flex: 0 1000 auto;
    min-width: 0;
    max-width: 50%;
    display: inline-flex;
    align-items: center;
    gap: 3px;
    overflow: hidden;
    font-size: 11px;
    color: var(--muted);
  }

  .note-text {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .tag.good {
    color: var(--ok);
  }

  /* Where the letter is going: "to Waiting for reply". */
  .tag.info {
    color: var(--link);
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

<script lang="ts">
  import type { Component } from "svelte";
  import Inbox from "@lucide/svelte/icons/inbox";
  import Send from "@lucide/svelte/icons/send";
  import FilePen from "@lucide/svelte/icons/file-pen";
  import Archive from "@lucide/svelte/icons/archive";
  import ShieldAlert from "@lucide/svelte/icons/shield-alert";
  import Trash from "@lucide/svelte/icons/trash-2";
  import Folder from "@lucide/svelte/icons/folder";
  import AlarmClock from "@lucide/svelte/icons/alarm-clock";
  import Mails from "@lucide/svelte/icons/mails";
  import Mail from "@lucide/svelte/icons/mail";
  import Flag from "@lucide/svelte/icons/flag";
  import Hourglass from "@lucide/svelte/icons/hourglass";
  import Bell from "@lucide/svelte/icons/bell";
  import BellOff from "@lucide/svelte/icons/bell-off";
  import Settings from "@lucide/svelte/icons/settings";
  import Pencil from "@lucide/svelte/icons/pencil";
  import Plus from "@lucide/svelte/icons/plus";
  import Puzzle from "@lucide/svelte/icons/puzzle";
  import Download from "@lucide/svelte/icons/download";
  import RotateCw from "@lucide/svelte/icons/rotate-cw";
  import ChevronRight from "@lucide/svelte/icons/chevron-right";
  import Ellipsis from "@lucide/svelte/icons/ellipsis";
  import Activity from "@lucide/svelte/icons/activity";
  import { app, type View } from "../lib/store.svelte";
  import { api } from "../lib/api";
  import { when } from "../lib/later";
  import { t } from "../lib/i18n.svelte";
  import { accountLabel, roleLabel } from "../lib/format";
  import { registry } from "../plugin-host/registry.svelte";
  import Popover from "./Popover.svelte";
  import FolderMenu from "./FolderMenu.svelte";
  import type { AccountView, FolderInfo, FolderRole } from "../lib/types";

  let { onCompose }: { onCompose: () => void } = $props();

  const ROLE_ICON: Record<FolderRole, Component> = {
    inbox: Inbox,
    snoozed: AlarmClock,
    drafts: FilePen,
    sent: Send,
    archive: Archive,
    junk: ShieldAlert,
    trash: Trash,
  };

  // With one account "All inboxes" would repeat its Inbox.
  const SMART = $derived<{ view: View; label: string; icon: Component }[]>([
    ...(app.accounts.length === 1 ? [] : [{ view: { kind: "unified", role: "inbox" } as View, label: t("nav.allInboxes"), icon: Mails }]),
    { view: { kind: "unified", role: "inbox", unread: true }, label: t("nav.unread"), icon: Mail },
    { view: { kind: "unified", role: "inbox", flagged: true }, label: t("nav.flagged"), icon: Flag },
  ]);

  let dndMenu = $state(false);
  const dnd = $derived(app.settings.dnd_until > Date.now() / 1000);

  function setDnd(until: number) {
    dndMenu = false;
    app.saveSettings({ ...app.settings, dnd_until: until });
  }

  function dndOptions(): { label: string; until: number }[] {
    const now = Date.now() / 1000;
    const morning = new Date();
    morning.setDate(morning.getDate() + (morning.getHours() >= 9 ? 1 : 0));
    morning.setHours(9, 0, 0, 0);
    return [
      { label: t("dnd.hour"), until: Math.floor(now + 3600) },
      { label: t("dnd.morning"), until: Math.floor(morning.getTime() / 1000) },
      { label: t("dnd.forever"), until: 4_102_444_800 },
    ];
  }

  /** Folded mailboxes, kept between launches. */
  const COLLAPSED_KEY = "depesha.sidebar.collapsed";
  let collapsed = $state<Record<string, boolean>>(readCollapsed());

  function readCollapsed(): Record<string, boolean> {
    try {
      return JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? "{}");
    } catch {
      return {};
    }
  }

  function toggle(id: string) {
    collapsed[id] = !collapsed[id];
    localStorage.setItem(COLLAPSED_KEY, JSON.stringify(collapsed));
  }
  /** The context menu of a folder, or of an account (folder null). */
  let folderMenu = $state<{ at: { x: number; y: number }; account: AccountView; folder: FolderInfo | null } | null>(null);

  function contextMenu(e: MouseEvent, account: AccountView, folder: FolderInfo | null) {
    e.preventDefault();
    menuFor = null;
    folderMenu = { at: { x: e.clientX, y: e.clientY }, account, folder };
  }
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
    if (f.role) return roleLabel(f.role);
    if (!f.delimiter) return f.display_name;
    return f.display_name.split(f.delimiter).pop() ?? f.display_name;
  }

  function isActive(v: View): boolean {
    const c = app.view;
    if (c.kind !== v.kind) return false;
    if (c.kind === "unified" && v.kind === "unified")
      return c.role === v.role && !!c.unread === !!v.unread && !!c.flagged === !!v.flagged;
    if (c.kind === "folder" && v.kind === "folder") return c.account_id === v.account_id && c.folder === v.folder;
    if (c.kind === "plugin" && v.kind === "plugin") return c.id === v.id;
    return true;
  }

  function statusText(acc: AccountView): string {
    const s = acc.status;
    if (!s) return t("status.connecting");
    if (s.state === "online") return t("status.online");
    if (s.state === "connecting") return t("status.connecting");
    return s.error?.message ?? t("status.error");
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
  const tasksRunning = $derived(app.tasks.filter((x) => x.state === "running").length);
  const tasksFailed = $derived(app.tasks.some((x) => x.state === "failed"));
  const tasksTitle = $derived(
    tasksFailed ? t("tasks.hintFailed") : tasksRunning ? t("tasks.hintRunning", { n: tasksRunning }) : t("tasks.title"),
  );
</script>

<nav class="side">
  <div class="brand" data-tauri-drag-region>
    <img src="/icon.png" alt="" width="26" height="26" />
    <span>{t("app.name")}</span>
    {#if app.version}<span class="version" title={t("app.version", { version: app.version })}>{app.version}</span>{/if}
  </div>

  <button class="btn primary compose-btn" onclick={onCompose} title={t("compose.newHint")}><Pencil size={15} /> {t("compose.new")}</button>

  <div class="scroll">
    <div class="group">
      {#each SMART as s (s.label)}
        <button class="item" class:active={isActive(s.view)} onclick={() => app.setView(s.view)}>
          <span class="icon"><s.icon size={16} /></span>
          <span class="name">{s.label}</span>
          {#if s.icon === Mails && totalUnread > 0}<span class="count">{totalUnread}</span>{/if}
        </button>
      {/each}
      {#each registry.items("views") as pv (pv.id)}
        {@const n = pv.count()}
        {#if n > 0}
          <button class="item" class:active={isActive({ kind: "plugin", id: pv.id })} onclick={() => app.setView({ kind: "plugin", id: pv.id })}>
            <span class="icon"><pv.icon size={16} /></span>
            <span class="name">{pv.title()}</span>
            <span class="count quiet">{n}</span>
          </button>
        {/if}
      {/each}
      {#if app.outbox.length > 0}
        <button class="item" class:active={isActive({ kind: "outbox" })} onclick={() => app.setView({ kind: "outbox" })}>
          <span class="icon"><Hourglass size={16} /></span>
          <span class="name">{t("nav.outbox")}</span>
          <span class="count" class:alert={outboxFailed}>{app.outbox.length}</span>
        </button>
      {/if}
    </div>

    {#each app.accounts as acc (acc.id)}
      <div class="group" class:collapsed={collapsed[acc.id]}>
        <div class="account" class:open={menuFor === acc.id} class:collapsed={collapsed[acc.id]}>
          <button class="account-name" onclick={() => toggle(acc.id)} oncontextmenu={(e) => contextMenu(e, acc, null)} title={acc.email}>
            <span class="dot {acc.status?.state ?? 'connecting'}" style:--dot={app.accountColor(acc.id)} title={statusText(acc)}></span>
            <span class="name">{accountLabel(acc)}</span>
            <span class="chev"><ChevronRight size={13} /></span>
          </button>
          <button class="menu-btn" onclick={() => (menuFor = menuFor === acc.id ? null : acc.id)} title={t("account.menu")} aria-label={t("account.menu")}><Ellipsis size={15} /></button>
          <Popover bind:open={() => menuFor === acc.id, (v) => (menuFor = v ? acc.id : null)}>
            <button class="mi" onclick={() => refresh(acc)}><RotateCw size={15} /> {t("account.refresh")}</button>
            <button class="mi" onclick={() => { menuFor = null; app.wizard = { account: acc }; }}><Settings size={15} /> {t("account.settings")}</button>
            <hr />
            <button class="mi" onclick={() => { menuFor = null; app.accountsOpen = true; }}><Inbox size={15} /> {t("accounts.manage")}</button>
            <button class="mi" onclick={() => { menuFor = null; app.wizard = { account: null }; }}><Plus size={15} /> {t("account.add")}</button>
          </Popover>
        </div>
        {#if acc.status && (acc.status.state === "error" || acc.status.state === "paused")}
          <button class="problem" onclick={() => (acc.status?.state === "paused" ? (app.wizard = { account: acc }) : refresh(acc))}>
            {statusText(acc)}
            <span class="fix">{acc.status.state === "paused" ? t("account.fix") : t("retry")}</span>
          </button>
        {/if}
        {#if !collapsed[acc.id]}
          {#each foldersOf(acc) as f (f.name)}
            {@const v = { kind: "folder", account_id: acc.id, folder: f.name } as View}
            {@const Icon = f.role ? ROLE_ICON[f.role] : Folder}
            <button
              class="item"
              class:active={isActive(v)}
              class:disabled={!f.selectable}
              disabled={!f.selectable}
              style:padding-left="{14 + depth(f) * 14}px"
              onclick={() => app.setView(v)}
              oncontextmenu={(e) => f.selectable && contextMenu(e, acc, f)}
              title={f.display_name}
            >
              <span class="icon"><Icon size={16} /></span>
              <span class="name">{label(f)}</span>
              <!-- Drafts count all of them: a draft is not "unread". -->
              {#if f.role === "drafts"}
                {#if f.total > 0}<span class="count quiet">{f.total}</span>{/if}
              {:else if f.unread > 0 && f.role !== "sent" && f.role !== "trash"}
                <span class="count">{f.unread}</span>
              {/if}
            </button>
          {/each}
        {/if}
      </div>
    {/each}
  </div>

  {#if folderMenu}
    {#key folderMenu}<FolderMenu at={folderMenu.at} account={folderMenu.account} folder={folderMenu.folder} onclose={() => (folderMenu = null)} />{/key}
  {/if}

  {#if app.update && ["available", "downloading", "ready", "installed"].includes(app.update.state)}
    {@const u = app.update}
    <div class="update">
      {#if u.state === "installed" || u.state === "ready"}
        <span>{t("update.ready", { version: u.version ?? "" })}</span>
        <button class="btn primary" onclick={() => app.restartForUpdate()}><RotateCw size={14} /> {t("update.restart")}</button>
      {:else if u.state === "downloading"}
        <span>{t("update.downloading", { version: u.version ?? "" })}</span>
      {:else}
        <span>{t("update.available", { version: u.version ?? "" })}</span>
        <button class="btn primary" onclick={() => app.installUpdate()}><Download size={14} /> {t("update.install")}</button>
      {/if}
    </div>
  {/if}

  <div class="foot">
    <button class="btn ghost settings" onclick={() => (app.settingsOpen = true)}><Settings size={15} /> {t("settings.title")}</button>
    <span class="spacer"></span>
    <div class="dnd-wrap">
      <button
        class="foot-btn"
        class:on={dnd}
        onclick={() => (dnd ? setDnd(0) : (dndMenu = !dndMenu))}
        title={dnd ? t("dnd.until", { when: when(app.settings.dnd_until) }) : t("dnd.title")}
        aria-label={t("dnd.title")}
      >
        {#if dnd}<BellOff size={16} />{:else}<Bell size={16} />{/if}
      </button>
      <Popover bind:open={dndMenu} align="left">
        <div class="mt">{t("dnd.title")}</div>
        {#each dndOptions() as o (o.label)}<button class="mi" onclick={() => setDnd(o.until)}>{o.label}</button>{/each}
      </Popover>
    </div>
    <button class="foot-btn tasks-btn" class:busy={tasksRunning > 0} class:failed={tasksFailed} onclick={() => (app.tasksOpen = true)} title={tasksTitle} aria-label={t("tasks.title")}>
      <span class="idle"><Activity size={16} /></span>
      {#if tasksRunning > 0}<span class="spin"><RotateCw size={16} /></span>{/if}
    </button>
    <button class="foot-btn" onclick={() => (app.pluginsOpen = true)} title={t("ext.title")} aria-label={t("ext.title")}><Puzzle size={16} /></button>
  </div>
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

  /* Service information: there when looked for, never competing with the mail. */
  .version {
    align-self: flex-end;
    margin-bottom: 3px;
    font-size: 11px;
    font-weight: 400;
    letter-spacing: 0;
    color: var(--side-muted);
    opacity: 0.7;
    font-variant-numeric: tabular-nums;
  }

  /* Drag the window by the logo and name too: the drag region only counts direct hits on itself. */
  .brand > :global(*) {
    pointer-events: none;
  }

  .compose-btn {
    margin: 8px 14px 10px;
    justify-content: center;
    padding: 8px;
  }

  .compose-btn :global(svg) {
    flex: none;
  }

  .scroll {
    flex: 1;
    overflow-y: auto;
    padding-bottom: 8px;
  }

  /* Groups are set apart by space, not lines. */
  .group {
    padding: 4px 0;
  }

  .group + .group {
    margin-top: 10px;
  }

  /* A folded mailbox is one line: no room kept for folders it does not show. */
  .group.collapsed {
    padding-bottom: 0;
  }

  .group.collapsed + .group {
    margin-top: 2px;
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
    display: inline-flex;
    justify-content: center;
    opacity: 0.8;
  }

  .item.active .icon {
    opacity: 1;
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
    background: color-mix(in srgb, var(--side-ink) 12%, transparent);
    border-radius: 10px;
    padding: 0 7px;
  }

  .count.alert {
    background: var(--accent);
    color: var(--accent-ink);
  }

  .count.quiet {
    font-weight: 500;
    color: var(--side-muted);
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
    text-align: left;
  }

  .account-name:hover {
    color: var(--side-ink);
  }

  /* The chevron and the menu show up on hover; a folded account keeps its chevron. */
  .chev {
    display: inline-flex;
    transform: rotate(90deg);
    transition: transform 0.12s;
  }

  .account.collapsed .chev {
    transform: none;
  }

  /* Hidden by colour, not opacity: WebDriver takes an element with opacity 0 for hidden. */
  .chev,
  .menu-btn {
    color: transparent;
  }

  .account:hover .chev,
  .account:hover .menu-btn,
  .account:focus-within .chev,
  .account:focus-within .menu-btn,
  .account.open .menu-btn,
  .account.collapsed .chev {
    color: var(--side-muted);
  }

  .menu-btn {
    display: inline-flex;
    background: none;
    border: none;
    padding: 3px 5px;
    border-radius: 4px;
  }

  .menu-btn:hover {
    background: var(--side-2);
    color: var(--side-ink);
  }

  /* The mailbox's colour; how it is connected shows as a ring around it. */
  .dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    flex: none;
    background: var(--dot, var(--side-muted));
  }

  .dot.connecting {
    opacity: 0.45;
  }

  .dot.error {
    box-shadow: 0 0 0 2px #e0a030;
  }

  .dot.paused {
    box-shadow: 0 0 0 2px var(--accent);
  }

  .problem {
    margin: 2px 12px 6px;
    padding: 6px 8px;
    font-size: 12px;
    line-height: 1.35;
    color: var(--side-ink);
    background: color-mix(in srgb, var(--accent) 22%, transparent);
    border: none;
    border-radius: 6px;
    text-align: left;
    width: calc(100% - 24px);
  }

  .problem .fix {
    display: block;
    margin-top: 3px;
    font-weight: 600;
  }

  .update {
    margin: 0 10px 6px;
    padding: 8px 10px;
    border-radius: 8px;
    background: var(--side-2);
    display: flex;
    flex-direction: column;
    gap: 6px;
    font-size: 12px;
  }

  .update .btn {
    justify-content: center;
    padding: 4px 8px;
    font-size: 12px;
  }

  .foot {
    display: flex;
    align-items: center;
    gap: 2px;
    padding: 6px 8px 10px;
  }

  .spacer {
    flex: 1;
  }

  .foot-btn {
    background: none;
    border: none;
    color: var(--side-muted);
    padding: 6px;
    border-radius: 6px;
    display: inline-flex;
  }

  .foot-btn:hover {
    background: var(--side-2);
    color: var(--side-ink);
  }

  .foot-btn.on {
    color: #e0a030;
  }

  .dnd-wrap {
    position: relative;
  }

  .tasks-btn {
    position: relative;
  }

  /* Short syncs (a folder in a blink) do not make the button flicker: it spins only after a moment. */
  .tasks-btn .idle {
    display: inline-flex;
  }

  .tasks-btn.busy .idle {
    animation: vanish 0s 0.6s forwards;
  }

  .tasks-btn.busy .spin {
    position: absolute;
    inset: 6px;
    display: inline-flex;
    opacity: 0;
    animation:
      appear 0s 0.6s forwards,
      spin 1.2s linear infinite;
  }

  @keyframes vanish {
    to {
      opacity: 0;
    }
  }

  .tasks-btn.failed::after {
    content: "";
    position: absolute;
    top: 4px;
    right: 4px;
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--accent);
  }

  @keyframes appear {
    to {
      opacity: 1;
    }
  }

  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .tasks-btn.busy .spin {
      animation: appear 0s 0.6s forwards;
    }
  }

  .settings {
    color: var(--side-muted);
    justify-content: flex-start;
    padding: 5px 8px;
  }

  .settings:hover {
    color: var(--side-ink);
    background: var(--side-2) !important;
  }
</style>

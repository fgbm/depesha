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
  import Download from "@lucide/svelte/icons/download";
  import RotateCw from "@lucide/svelte/icons/rotate-cw";
  import ChevronRight from "@lucide/svelte/icons/chevron-right";
  import ChevronDown from "@lucide/svelte/icons/chevron-down";
  import Ellipsis from "@lucide/svelte/icons/ellipsis";
  import Activity from "@lucide/svelte/icons/activity";
  import ChevronsLeft from "@lucide/svelte/icons/chevrons-left";
  import ChevronsRight from "@lucide/svelte/icons/chevrons-right";
  import Star from "@lucide/svelte/icons/star";
  import { slide } from "svelte/transition";
  import { app, type View } from "../lib/store.svelte";
  import { favourites, neighbour, splitPath, type Favourite } from "../lib/favourites.svelte";
  import { api } from "../lib/api";
  import { when } from "../lib/later";
  import { t } from "../lib/i18n.svelte";
  import { accountLabel, initials, roleLabel } from "../lib/format";
  import { layout } from "../lib/layout.svelte";
  import { unfolded, withChildren } from "../lib/folders";
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

  // With one account "All inboxes" and "All drafts" would repeat its own folders.
  const SMART = $derived<{ view: View; label: string; icon: Component }[]>([
    ...(app.accounts.length === 1 ? [] : [{ view: { kind: "unified", role: "inbox" } as View, label: t("nav.allInboxes"), icon: Mails }]),
    { view: { kind: "unified", role: "inbox", unread: true }, label: t("nav.unread"), icon: Mail },
    { view: { kind: "unified", role: "inbox", flagged: true }, label: t("nav.flagged"), icon: Flag },
    ...(app.accounts.length === 1 ? [] : [{ view: { kind: "unified", role: "drafts" } as View, label: t("nav.allDrafts"), icon: FilePen }]),
  ]);
  /** Drafts of every mailbox, read or not, as next to each Drafts folder. */
  const totalDrafts = $derived(app.folders.filter((f) => f.role === "drafts").reduce((n, f) => n + f.total, 0));

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

  /** Folded folders with subfolders, by account and name; kept between launches, as mailboxes are. */
  const FOLDED_KEY = "depesha.sidebar.folded";
  let folded = $state<Record<string, boolean>>(readFolded());

  function readFolded(): Record<string, boolean> {
    try {
      return JSON.parse(localStorage.getItem(FOLDED_KEY) ?? "{}");
    } catch {
      return {};
    }
  }

  const foldKey = (f: FolderInfo) => `${f.account_id}\u0000${f.name}`;

  function fold(f: FolderInfo) {
    const key = foldKey(f);
    if (folded[key]) delete folded[key];
    else folded[key] = true;
    localStorage.setItem(FOLDED_KEY, JSON.stringify(folded));
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

  /** The mailbox whose folders open beside the strip; a click opens them, hovering does not. */
  let flyout = $state<string | null>(null);
  /** The flyout of a mailbox with favourites shows them; the whole tree opens under «All folders». */
  let flyoutTree = $state(false);

  // The full sidebar shows the folders itself: an open flyout does not come back with the strip.
  $effect(() => {
    if (!layout.strip) flyout = null;
  });

  $effect(() => {
    void flyout;
    flyoutTree = false;
  });

  const favouriteOf = (f: FolderInfo): Favourite => ({ name: f.name, display: f.display_name, delimiter: f.delimiter });

  /** The folder list of the mailbox has been read: a favourite missing from it is gone, not just not loaded yet. */
  function listed(acc: AccountView): boolean {
    return app.folders.some((f) => f.account_id === acc.id);
  }

  // A row leaving the favourites with the focus on its star hands the focus on: to the next
  // row's star, else the one before, else the mailbox's name (the flyout's «All folders»).
  favourites.onleave = (account, name) => {
    const row = (document.activeElement as HTMLElement | null)?.closest<HTMLElement>(".fav-row");
    if (!row || row.dataset.account !== account || row.dataset.folder !== name) return;
    const block = row.closest<HTMLElement>(".favs");
    const rows = [...(block?.querySelectorAll<HTMLElement>(".fav-row") ?? [])];
    const next = neighbour(rows, rows.indexOf(row))?.querySelector<HTMLElement>(".star");
    const around = block?.closest<HTMLElement>(".group, .fly-folders");
    (next ?? around?.querySelector<HTMLElement>(".account-name, .all-folders"))?.focus();
  };

  /** The height of a removed favourite goes to zero shortly; at once when motion is reduced. */
  function closing(node: Element) {
    const reduced = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
    return slide(node, { duration: reduced ? 0 : 150 });
  }

  function inboxUnread(acc: AccountView): number {
    return app.folders.filter((f) => f.account_id === acc.id && f.role === "inbox").reduce((n, f) => n + f.unread, 0);
  }

  function accountInitials(acc: AccountView): string {
    return initials({ name: acc.label?.trim() || acc.display_name?.trim() || acc.email.split("@")[0], email: acc.email });
  }

  /** A count on an icon: small, so big numbers are cut short. */
  function badge(n: number): string {
    return n > 99 ? "99+" : String(n);
  }

  const outboxFailed = $derived(app.outbox.some((o) => o.failed));
  const tasksRunning = $derived(app.tasks.filter((x) => x.state === "running").length);
  const tasksFailed = $derived(app.tasks.some((x) => x.state === "failed"));
  const tasksTitle = $derived(
    tasksFailed ? t("tasks.hintFailed") : tasksRunning ? t("tasks.hintRunning", { n: tasksRunning }) : t("tasks.title"),
  );
</script>

<!-- A folder of a mailbox, the same in the full sidebar and in the strip's flyout. -->
{#snippet folderRows(acc: AccountView, picked?: () => void)}
  {@const all = foldersOf(acc)}
  {@const parents = withChildren(all)}
  {#each unfolded(all, (name) => !!folded[`${acc.id}\u0000${name}`]) as f (f.name)}
    {@const v = { kind: "folder", account_id: acc.id, folder: f.name } as View}
    {@const Icon = f.role ? ROLE_ICON[f.role] : Folder}
    <div class="folder-row" data-folder={f.name}>
      {#if parents.has(f.name)}
        {@const open = !folded[foldKey(f)]}
        <!-- A triangle of its own: a click on the name still opens the folder. -->
        <button
          class="fold"
          style:left="{depth(f) * 14}px"
          onclick={() => fold(f)}
          aria-expanded={open}
          title={open ? t("sidebar.foldFolder") : t("sidebar.unfoldFolder")}
          aria-label={`${open ? t("sidebar.foldFolder") : t("sidebar.unfoldFolder")}: ${label(f)}`}
        >{#if open}<ChevronDown size={12} />{:else}<ChevronRight size={12} />{/if}</button>
      {/if}
      <button
        class="item"
        class:active={isActive(v)}
        class:disabled={!f.selectable}
        disabled={!f.selectable}
        role={picked ? "menuitem" : undefined}
        style:padding-left="{14 + depth(f) * 14}px"
        onclick={() => {
          picked?.();
          app.setView(v);
        }}
        oncontextmenu={(e) => f.selectable && contextMenu(e, acc, f)}
        title={f.display_name}
      >
        <span class="icon"><Icon size={16} /></span>
        <span class="name">{label(f)}</span>
        {@render count(f)}
      </button>
      {#if f.selectable}{@render star(acc, favouriteOf(f), false)}{/if}
    </div>
  {/each}
{/snippet}

{#snippet count(f: FolderInfo)}
  <!-- Drafts count all of them: a draft is not "unread". -->
  {#if f.role === "drafts"}
    {#if f.total > 0}<span class="count quiet">{f.total}</span>{/if}
  {:else if f.unread > 0 && f.role !== "sent" && f.role !== "trash"}
    <span class="count">{f.unread}</span>
  {/if}
{/snippet}

<!-- The star in the last column of a row: its place does not depend on the name, the depth or the counter.
     Quick actions of the row, when there are some, go left of it. -->
{#snippet star(acc: AccountView, fav: Favourite, inBlock: boolean)}
  {@const on = favourites.has(acc.id, fav.name)}
  <button
    class="star"
    class:on
    aria-pressed={on}
    title={on ? t("favourites.remove") : t("favourites.add")}
    aria-label={on ? t("favourites.remove") : t("favourites.add")}
    onclick={() => favourites.toggle(acc.id, fav, inBlock)}
  ><Star size={15} fill={on ? "currentColor" : "none"} /></button>
{/snippet}

<!-- The mailbox's favourites, in the order added, whatever is folded; a nested one shows its path. -->
{#snippet favouriteRows(acc: AccountView, picked?: () => void)}
  {@const list = favourites.of(acc.id)}
  {#if list.length}
    <div class="favs" role="group" aria-label={t("favourites.title")}>
      {#each list as fav (fav.name)}
        {@const f = app.folder(acc.id, fav.name)}
        {@const gone = listed(acc) && !f?.selectable}
        {@const v = { kind: "folder", account_id: acc.id, folder: fav.name } as View}
        {@const Icon = f?.role ? ROLE_ICON[f.role] : Folder}
        {@const where = splitPath(f?.display_name ?? fav.display, f?.delimiter ?? fav.delimiter)}
        <div class="folder-row fav-row" class:leaving={favourites.isLeaving(acc.id, fav.name)} data-account={acc.id} data-folder={fav.name} out:closing>
          <button
            class="item"
            class:active={!gone && isActive(v)}
            class:disabled={gone}
            disabled={gone}
            role={picked ? "menuitem" : undefined}
            onclick={() => {
              picked?.();
              app.setView(v);
            }}
            oncontextmenu={(e) => f && !gone && contextMenu(e, acc, f)}
            title={gone ? t("favourites.gone", { name: fav.display }) : (f?.display_name ?? fav.display)}
          >
            <span class="icon"><Icon size={16} /></span>
            <span class="name">{f?.role ? roleLabel(f.role) : where.leaf}{#if where.path}<span class="path">{where.path}</span>{/if}</span>
            {#if f && !gone}{@render count(f)}{/if}
          </button>
          {@render star(acc, fav, true)}
        </div>
      {/each}
    </div>
  {/if}
{/snippet}

{#snippet problem(acc: AccountView, picked?: () => void)}
  {#if acc.status && (acc.status.state === "error" || acc.status.state === "paused")}
    <button
      class="problem"
      role={picked ? "menuitem" : undefined}
      onclick={() => {
        picked?.();
        if (acc.status?.state === "paused") app.accountSettings(acc);
        else refresh(acc);
      }}
    >
      {statusText(acc)}
      <span class="fix">{acc.status.state === "paused" ? t("account.fix") : t("retry")}</span>
    </button>
  {/if}
{/snippet}

{#snippet dndButton(align: "left" | "right")}
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
    <Popover bind:open={dndMenu} {align}>
      <div class="mt">{t("dnd.title")}</div>
      {#each dndOptions() as o (o.label)}<button class="mi" onclick={() => setDnd(o.until)}>{o.label}</button>{/each}
    </Popover>
  </div>
{/snippet}

{#snippet menus()}
  {#if folderMenu}
    {#key folderMenu}<FolderMenu at={folderMenu.at} account={folderMenu.account} folder={folderMenu.folder} onclose={() => (folderMenu = null)} />{/key}
  {/if}
{/snippet}

{#snippet tasksButton()}
  <button class="foot-btn tasks-btn" class:busy={tasksRunning > 0} class:failed={tasksFailed} onclick={() => (app.tasksOpen = true)} title={tasksTitle} aria-label={t("tasks.title")}>
    <span class="idle"><Activity size={16} /></span>
    {#if tasksRunning > 0}<span class="spin"><RotateCw size={16} /></span>{/if}
  </button>
{/snippet}

{#if layout.strip}
  <!-- The folded sidebar: the same sections as icons, a circle per mailbox with its folders beside it. -->
  <nav class="side strip">
    <div class="brand" data-tauri-drag-region>
      <img src="/icon.png" alt="" width="26" height="26" />
    </div>

    <button class="btn primary tile-compose" onclick={onCompose} title={t("compose.newHint")} aria-label={t("compose.new")}><Pencil size={16} /></button>

    <div class="scroll">
      <div class="tiles">
        {#each SMART as s (s.label)}
          <button class="tile" class:active={isActive(s.view)} onclick={() => app.setView(s.view)} title={s.label} aria-label={s.label}>
            <s.icon size={18} />
            {#if s.icon === Mails && totalUnread > 0}<span class="badge">{badge(totalUnread)}</span>{/if}
            {#if s.icon === FilePen && totalDrafts > 0}<span class="badge quiet">{badge(totalDrafts)}</span>{/if}
          </button>
        {/each}
        {#each registry.items("views") as pv (pv.id)}
          {@const n = pv.count()}
          {#if n > 0}
            <button class="tile" class:active={isActive({ kind: "plugin", id: pv.id })} onclick={() => app.setView({ kind: "plugin", id: pv.id })} title={pv.title()} aria-label={pv.title()}>
              <pv.icon size={18} />
              <span class="badge quiet">{badge(n)}</span>
            </button>
          {/if}
        {/each}
        {#if app.outbox.length > 0}
          <button class="tile" class:active={isActive({ kind: "outbox" })} onclick={() => app.setView({ kind: "outbox" })} title={t("nav.outbox")} aria-label={t("nav.outbox")}>
            <Hourglass size={18} />
            <span class="badge" class:alert={outboxFailed}>{badge(app.outbox.length)}</span>
          </button>
        {/if}
      </div>

      <div class="circles">
        {#each app.accounts as acc (acc.id)}
          {@const unread = inboxUnread(acc)}
          {@const state = acc.status?.state ?? "connecting"}
          <div class="circle-wrap">
            <button
              class="circle"
              class:open={flyout === acc.id}
              class:current={app.view.kind === "folder" && app.view.account_id === acc.id}
              style:--acc={app.accountColor(acc.id)}
              onclick={() => (flyout = flyout === acc.id ? null : acc.id)}
              oncontextmenu={(e) => contextMenu(e, acc, null)}
              title={`${accountLabel(acc)} · ${statusText(acc)}`}
              aria-label={accountLabel(acc)}
              aria-haspopup="menu"
              aria-expanded={flyout === acc.id}
            >
              {accountInitials(acc)}
              <span class="status {state}"></span>
              {#if unread > 0}<span class="badge">{badge(unread)}</span>{/if}
            </button>
            <Popover bind:open={() => flyout === acc.id, (v) => (flyout = v ? acc.id : null)} beside tone="side">
              <div class="fly-head" oncontextmenu={(e) => contextMenu(e, acc, null)} role="presentation">
                <span class="dot {state}" style:--dot={app.accountColor(acc.id)} title={statusText(acc)}></span>
                <span class="fly-name">{accountLabel(acc)}</span>
              </div>
              {#if acc.label?.trim()}<div class="fly-mail">{acc.email}</div>{/if}
              {@render problem(acc, () => (flyout = null))}
              <div class="fly-folders">
                {#if favourites.of(acc.id).length}
                  {@render favouriteRows(acc, () => (flyout = null))}
                  <button class="item all-folders" role="menuitem" aria-expanded={flyoutTree} onclick={() => (flyoutTree = !flyoutTree)}>
                    <span class="icon"><Folder size={16} /></span>
                    <span class="name">{t("favourites.allFolders")}</span>
                    <span class="disclose" class:open={flyoutTree}><ChevronRight size={14} /></span>
                  </button>
                  {#if flyoutTree}{@render folderRows(acc, () => (flyout = null))}{/if}
                {:else}
                  {@render folderRows(acc, () => (flyout = null))}
                {/if}
              </div>
            </Popover>
          </div>
        {/each}
      </div>
    </div>

    {#if app.update && ["available", "ready", "installed"].includes(app.update.state)}
      {@const u = app.update}
      {#if u.state === "available"}
        <button class="tile update-tile" onclick={() => app.installUpdate()} title={t("update.available", { version: u.version ?? "" })} aria-label={t("update.install")}><Download size={18} /></button>
      {:else}
        <button class="tile update-tile" onclick={() => app.restartForUpdate()} title={t("update.ready", { version: u.version ?? "" })} aria-label={t("update.restart")}><RotateCw size={18} /></button>
      {/if}
    {/if}

    <div class="strip-foot">
      <button class="foot-btn" onclick={() => layout.toggleSidebar()} title={t("sidebar.unfold")} aria-label={t("sidebar.unfold")}><ChevronsRight size={16} /></button>
      {@render dndButton("left")}
      {@render tasksButton()}
      <button class="foot-btn" onclick={() => app.openSettings()} title={t("settings.title")} aria-label={t("settings.title")}><Settings size={16} /></button>
    </div>
    {@render menus()}
  </nav>
{:else}
  <nav class="side">
    <div class="brand" data-tauri-drag-region>
      <img src="/icon.png" alt="" width="26" height="26" />
      <span>{t("app.name")}</span>
      {#if app.version}<span class="version" title={t("app.version", { version: app.version })}>{app.version}</span>{/if}
      <span class="spacer"></span>
      <button class="fold-side" onclick={() => layout.toggleSidebar()} title={t("sidebar.fold")} aria-label={t("sidebar.fold")}><ChevronsLeft size={14} /></button>
    </div>

    <button class="btn primary compose-btn" onclick={onCompose} title={t("compose.newHint")}><Pencil size={15} /> {t("compose.new")}</button>

    <div class="scroll">
      <div class="group">
        {#each SMART as s (s.label)}
          <button class="item" class:active={isActive(s.view)} onclick={() => app.setView(s.view)}>
            <span class="icon"><s.icon size={16} /></span>
            <span class="name">{s.label}</span>
            {#if s.icon === Mails && totalUnread > 0}<span class="count">{totalUnread}</span>{/if}
            {#if s.icon === FilePen && totalDrafts > 0}<span class="count quiet">{totalDrafts}</span>{/if}
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
              <button class="mi" onclick={() => { menuFor = null; app.accountSettings(acc); }}><Settings size={15} /> {t("account.settings")}</button>
              <hr />
              <button class="mi" onclick={() => { menuFor = null; app.openSettings("accounts"); }}><Inbox size={15} /> {t("accounts.manage")}</button>
              <button class="mi" onclick={() => { menuFor = null; app.accountSettings(null); }}><Plus size={15} /> {t("account.add")}</button>
            </Popover>
          </div>
          {@render problem(acc)}
          {@render favouriteRows(acc)}
          {#if !collapsed[acc.id]}
            {#if favourites.of(acc.id).length}<div class="all-label">{t("favourites.allFolders")}</div>{/if}
            {@render folderRows(acc)}
          {/if}
        </div>
      {/each}
    </div>

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
      <button class="btn ghost settings" onclick={() => app.openSettings()}><Settings size={15} /> {t("settings.title")}</button>
      <span class="spacer"></span>
      {@render dndButton("left")}
      {@render tasksButton()}
    </div>
    {@render menus()}
  </nav>
{/if}


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
  .brand > :global(*:not(button)) {
    pointer-events: none;
  }

  /* «: quiet, as the version beside it; the panel folds into the strip. */
  .fold-side {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 24px;
    height: 22px;
    padding: 0;
    border: 1px solid color-mix(in srgb, var(--side-ink) 18%, transparent);
    border-radius: 5px;
    background: none;
    color: var(--side-muted);
  }

  .fold-side:hover {
    color: var(--side-ink);
    background: var(--side-2);
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

  .folder-row {
    position: relative;
  }

  /* In the indent left of the folder's icon. */
  .fold {
    position: absolute;
    top: 50%;
    transform: translateY(-50%);
    z-index: 1;
    width: 14px;
    height: 20px;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 0;
    border: none;
    border-radius: 4px;
    background: none;
    color: var(--side-muted);
  }

  .fold:hover {
    color: var(--side-ink);
    background: var(--side-2);
  }

  /* Every row keeps the star's column on its right, the sections without stars too:
     counters stand in one column, stars in another. */
  .side {
    --star: 24px;
    --star-right: 8px;
    --tail: calc(var(--star) + var(--star-right) + 6px);
  }

  .item {
    width: 100%;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 5px var(--tail) 5px 14px;
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

  /* The same distance from the right edge in every row, whatever the panel's width. */
  .star {
    position: absolute;
    top: 50%;
    right: var(--star-right);
    transform: translateY(-50%);
    z-index: 1;
    width: var(--star);
    height: var(--star);
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 0;
    border: none;
    border-radius: 5px;
    background: none;
    /* An empty star shows on the row under the pointer or in focus; hidden by colour, as the account's chevron. */
    color: transparent;
  }

  .folder-row:hover .star,
  .folder-row:focus-within .star,
  .fav-row.leaving .star {
    color: var(--side-muted);
  }

  .star:hover {
    color: var(--side-ink);
    background: color-mix(in srgb, var(--side-ink) 10%, transparent);
  }

  .star.on,
  .folder-row:hover .star.on {
    color: #e0b040;
  }

  .star:focus-visible {
    outline: 2px solid color-mix(in srgb, var(--side-ink) 55%, transparent);
    outline-offset: -1px;
  }

  /* An unstarred favourite stays in its place and fades; its star stays, a second press keeps it. */
  .fav-row.leaving .item {
    opacity: 0;
    transition: opacity 0.7s ease-in;
  }

  @media (prefers-reduced-motion: reduce) {
    .fav-row.leaving .item {
      opacity: 1;
      transition: none;
    }
  }

  .favs {
    display: flex;
    flex-direction: column;
  }

  .path {
    margin-left: 7px;
    font-size: 12px;
    color: var(--side-muted);
  }

  /* Gone from the server: the record stays until it is unstarred, plainly not a folder to open. */
  .fav-row .item.disabled .name {
    text-decoration: line-through;
  }

  /* «All folders» under the favourites: a quiet caption with a line, the tree follows. */
  .all-label {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px var(--tail) 3px 40px;
    font-size: 11.5px;
    color: var(--side-muted);
  }

  .all-label::after {
    content: "";
    flex: 1;
    height: 1px;
    background: color-mix(in srgb, var(--side-ink) 12%, transparent);
  }

  .fly-folders .all-folders {
    margin-top: 4px;
    color: var(--side-muted);
    border-top: 1px solid color-mix(in srgb, var(--side-ink) 12%, transparent);
    border-radius: 0 0 5px 5px;
  }

  .disclose {
    display: inline-flex;
    transition: transform 0.12s;
  }

  .disclose.open {
    transform: rotate(90deg);
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

  /* The strip: the sidebar folded into a column of icons. */
  .strip {
    align-items: center;
    overflow: hidden;
  }

  .strip .brand {
    justify-content: center;
    padding: 14px 0 8px;
    align-self: stretch;
  }

  .tile-compose {
    width: 38px;
    height: 36px;
    padding: 0;
    margin: 6px 0 10px;
    justify-content: center;
    flex: none;
  }

  .strip .scroll {
    align-self: stretch;
    display: flex;
    flex-direction: column;
    align-items: center;
    /* No scrollbar eating the narrow column; the wheel and the keyboard still scroll it. */
    scrollbar-width: none;
  }

  .tiles,
  .circles {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 4px;
    padding: 4px 0;
  }

  .circles {
    gap: 10px;
    margin-top: 6px;
    padding-top: 12px;
    border-top: 1px solid color-mix(in srgb, var(--side-ink) 12%, transparent);
  }

  .tile {
    position: relative;
    flex: none;
    width: 38px;
    height: 34px;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 0;
    border: none;
    border-radius: 7px;
    background: none;
    color: var(--side-ink);
    opacity: 0.85;
  }

  .tile:hover {
    background: var(--side-2);
    opacity: 1;
  }

  .tile.active {
    background: var(--side-2);
    opacity: 1;
    box-shadow: inset 3px 0 0 var(--accent);
  }

  .update-tile {
    margin-bottom: 4px;
    color: var(--accent-ink);
    background: var(--accent);
    opacity: 1;
  }

  .update-tile:hover {
    background: var(--accent);
    filter: brightness(1.1);
  }

  /* A count on an icon, in its upper right corner. */
  .badge {
    position: absolute;
    top: -3px;
    right: -5px;
    min-width: 17px;
    height: 17px;
    padding: 0 4px;
    border-radius: 9px;
    font-size: 10.5px;
    font-weight: 700;
    line-height: 17px;
    text-align: center;
    background: var(--accent);
    color: var(--accent-ink);
    box-shadow: 0 0 0 2px var(--side);
    font-variant-numeric: tabular-nums;
  }

  .badge.quiet {
    background: color-mix(in srgb, var(--side-ink) 22%, var(--side));
    color: var(--side-ink);
    font-weight: 600;
  }

  .circle-wrap {
    position: relative;
  }

  /* A mailbox: its colour and initials; how it is connected is the dot at the bottom. */
  .circle {
    position: relative;
    width: 34px;
    height: 34px;
    padding: 0;
    border: none;
    border-radius: 50%;
    background: var(--acc);
    color: #fff;
    font-size: 12px;
    font-weight: 700;
    letter-spacing: 0.02em;
  }

  .circle:hover,
  .circle.open {
    box-shadow:
      0 0 0 2px var(--side),
      0 0 0 4px color-mix(in srgb, var(--side-ink) 45%, transparent);
  }

  .circle.current:not(.open) {
    box-shadow:
      0 0 0 2px var(--side),
      0 0 0 4px var(--accent);
  }

  .status {
    position: absolute;
    right: -1px;
    bottom: -1px;
    width: 10px;
    height: 10px;
    border-radius: 50%;
    background: var(--side-muted);
    box-shadow: 0 0 0 2px var(--side);
  }

  .status.online {
    background: var(--ok);
  }

  .status.error,
  .status.paused {
    background: var(--accent);
  }

  .strip-foot {
    flex: none;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 2px;
    padding: 6px 0 10px;
  }

  /* The flyout beside the strip: the mailbox's folders, as in the full sidebar. */
  .fly-head {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 10px 2px;
    font-size: 12px;
    font-weight: 600;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: var(--side-muted);
  }

  .fly-name {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .fly-mail {
    padding: 0 10px 6px 26px;
    font-size: 12px;
    color: var(--side-muted);
  }

  .fly-folders {
    min-width: 220px;
    padding-top: 4px;
  }

  .fly-folders .item {
    border-radius: 5px;
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

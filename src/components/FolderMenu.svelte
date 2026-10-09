<script lang="ts">
  import FolderOpen from "@lucide/svelte/icons/folder-open";
  import FolderPlus from "@lucide/svelte/icons/folder-plus";
  import MailOpen from "@lucide/svelte/icons/mail-open";
  import RotateCw from "@lucide/svelte/icons/rotate-cw";
  import Settings from "@lucide/svelte/icons/settings";
  import Inbox from "@lucide/svelte/icons/inbox";
  import Activity from "@lucide/svelte/icons/activity";
  import Star from "@lucide/svelte/icons/star";
  import Info from "@lucide/svelte/icons/info";
  import Eraser from "@lucide/svelte/icons/eraser";
  import { app } from "../lib/store.svelte";
  import { api } from "../lib/api";
  import { t } from "../lib/i18n.svelte";
  import { accountLabel } from "../lib/format";
  import { favourites } from "../lib/favourites.svelte";
  import FolderProps from "./prefs/FolderProps.svelte";
  import type { AccountView, FolderInfo } from "../lib/types";
  import Popover from "./Popover.svelte";
  import Keys from "./Keys.svelte";
  import { untrack } from "svelte";

  /** The context menu of a folder, or of an account when `folder` is null. */
  let props: { at: { x: number; y: number }; account: AccountView; folder: FolderInfo | null; onclose: () => void } = $props();
  // The menu lives for one right click; closing it clears the sidebar's state its props
  // come from, so they are taken once, when it opens.
  const { at, account, folder, onclose } = untrack(() => ({ ...props }));

  /** The second step: the name of a new folder, or the folder's properties card. */
  let naming = $state(false);
  let showingProps = $state(false);
  let name = $state("");
  let input = $state<HTMLInputElement | null>(null);

  // A known ban turns the menu item off with "нет прав" (#42, frame 4А).
  const canCreateChild = $derived.by(() => {
    if (!folder) return true;
    const rights = app.labels.prop(account.id, folder.name)?.rights;
    return !rights || rights.create_child;
  });

  $effect(() => {
    if (naming) input?.focus();
  });

  function run(fn: () => void) {
    fn();
    onclose();
  }

  async function sync() {
    const id = account.id;
    const f = folder?.name;
    const label = folder?.display_name ?? accountLabel(account);
    onclose();
    try {
      await app.track(api.syncNow(id, f));
    } catch (e) {
      app.fail(e, label);
    }
  }

  async function markAllRead() {
    const id = account.id;
    const f = folder?.name;
    onclose();
    if (!f) return;
    try {
      const unread = await app.track(api.messages({ account_id: id, folder: f, unread_only: true, limit: 100_000 }));
      await app.flag("seen", true, unread.map((m) => m.id));
    } catch (e) {
      app.fail(e);
    }
  }

  async function create() {
    const leaf = name.trim();
    if (!leaf) return;
    const id = account.id;
    const parent = folder?.name ?? null;
    onclose();
    try {
      await app.track(api.folderCreate(id, parent, leaf));
      app.toast(t("folder.created", { name: leaf }));
    } catch (e) {
      app.fail(e, t("folder.createFailed"));
    }
  }
</script>

<Popover {at} bind:open={() => !showingProps, (v) => !v && !naming && !showingProps && onclose()}>
  {#if folder}
    <div class="mt">{folder.display_name}</div>
    <button class="mi" onclick={() => run(() => app.setView({ kind: "folder", account_id: account.id, folder: folder.name }))}><FolderOpen size={15} /> {t("folder.open")}</button>
    <button class="mi" onclick={sync}><RotateCw size={15} /> {t("folder.sync")}</button>
    <button class="mi" disabled={folder.unread === 0} onclick={markAllRead}><MailOpen size={15} /> {t("folder.markAllRead")}</button>
    <!-- «Clear» (#74): the same command as the button above the list and the palette's, in Trash, Spam and Drafts only. -->
    {@const clear = app.clearing.target(account.id, folder.name)}
    {#if clear}
      {@const why = app.clearing.reason(folder)}
      <button class="mi" disabled={!!why} title={why ?? undefined} onclick={() => run(() => void app.clearing.begin(account.id, folder.name))}
        ><Eraser size={15} /> {app.clearing.title(clear.role)}…<span class="hint"><Keys of="core.empty-folder" /></span></button
      >
    {/if}
    <hr />
    <!-- The same as the star in the folder's row: from the menu the favourite goes at once. -->
    {@const starred = favourites.has(account.id, folder.name)}
    <button class="mi" onclick={() => run(() => favourites.toggle(account.id, { name: folder.name, display: folder.display_name, delimiter: folder.delimiter }))}
      ><Star size={15} fill={starred ? "currentColor" : "none"} /> {starred ? t("favourites.remove") : t("favourites.add")}</button
    >
    <button class="mi" disabled={!canCreateChild} title={!canCreateChild ? t("folder.noRightHint") : undefined} onclick={() => (naming = true)}><FolderPlus size={15} /> {t("folder.newInside")}{#if !canCreateChild}<span class="why">{t("folder.noRight")}</span>{/if}</button>
    <hr />
    <button class="mi" onclick={() => (showingProps = true)}><Info size={15} /> {t("folder.properties")}</button>
  {:else}
    <div class="mt">{accountLabel(account)}</div>
    <button class="mi" onclick={sync}><RotateCw size={15} /> {t("account.refresh")}</button>
    <button class="mi" onclick={() => (naming = true)}><FolderPlus size={15} /> {t("folder.new")}</button>
    <hr />
    <button class="mi" onclick={() => run(() => app.accountSettings(account))}><Settings size={15} /> {t("account.settings")}</button>
    <button class="mi" onclick={() => run(() => app.openSettings("accounts"))}><Inbox size={15} /> {t("accounts.manage")}</button>
    <button class="mi" onclick={() => run(() => (app.tasksOpen = true))}><Activity size={15} /> {t("tasks.title")}…</button>
  {/if}
</Popover>

<Popover {at} bind:open={() => naming, (v) => !v && onclose()}>
  <div class="mt">{folder ? t("folder.newIn", { folder: folder.display_name }) : t("folder.new")}</div>
  <form class="new" onsubmit={(e) => { e.preventDefault(); create(); }}>
    <input class="input" bind:this={input} bind:value={name} placeholder={t("folder.name")} aria-label={t("folder.name")} />
    <button class="btn primary" type="submit" disabled={!name.trim()}>{t("folder.create")}</button>
  </form>
</Popover>

{#if folder && showingProps}
  <!-- The properties card of the folder (#42, frame 4А): rights, labels, owner, count. -->
  <FolderProps {at} account={account} {folder} onclose={() => (showingProps = false, onclose())} />
{/if}

<style>
  .new {
    display: flex;
    gap: 6px;
    padding: 4px 6px 6px;
  }

  .new .input {
    flex: 1;
    min-width: 0;
  }

  .why {
    margin-left: auto;
    color: var(--muted);
    font-size: 11.5px;
  }
</style>

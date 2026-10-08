<script lang="ts">
  // The full sidebar: the smart sections, then a group per mailbox — its name and menu,
  // its favourites, its folder tree and its storage line. The strip is the other half of
  // the sidebar (#38); this is what a wide window shows.

  import Settings from "@lucide/svelte/icons/settings";
  import Pencil from "@lucide/svelte/icons/pencil";
  import ChevronsLeft from "@lucide/svelte/icons/chevrons-left";
  import ChevronRight from "@lucide/svelte/icons/chevron-right";
  import Ellipsis from "@lucide/svelte/icons/ellipsis";
  import Inbox from "@lucide/svelte/icons/inbox";
  import Plus from "@lucide/svelte/icons/plus";
  import RotateCw from "@lucide/svelte/icons/rotate-cw";
  import Download from "@lucide/svelte/icons/download";
  import { app } from "../../lib/store.svelte";
  import { t } from "../../lib/i18n.svelte";
  import { shortcuts } from "../../lib/shortcuts.svelte";
  import { accountLabel } from "../../lib/format";
  import { layout } from "../../lib/layout.svelte";
  import { favourites } from "../../lib/favourites.svelte";
  import Popover from "../Popover.svelte";
  import FolderMenu from "../FolderMenu.svelte";
  import QuotaLine from "../QuotaLine.svelte";
  import { sidebarUi } from "./sidebar.svelte";
  import { statusText } from "./Problem.svelte";
  import Problem from "./Problem.svelte";
  import DndButton from "./DndButton.svelte";
  import TasksButton from "./TasksButton.svelte";
  import SmartSections from "./SmartSections.svelte";
  import Favourites from "./Favourites.svelte";
  import Labels from "./Labels.svelte";
  import SidebarTree from "./SidebarTree.svelte";

  let { onCompose }: { onCompose: () => void } = $props();
</script>

<nav class="side">
  <div class="brand" data-tauri-drag-region>
    <img src="/icon.png" alt="" width="26" height="26" />
    <span>{t("app.name")}</span>
    {#if app.version}<span class="version" title={t("app.version", { version: app.version })}>{app.version}</span>{/if}
    <span class="spacer"></span>
    <button class="fold-side" onclick={() => layout.toggleSidebar()} title={t("sidebar.fold")} aria-label={t("sidebar.fold")}><ChevronsLeft size={14} /></button>
  </div>

  <button class="btn primary compose-btn" onclick={onCompose} title={shortcuts.titled(t("compose.newHint"), "core.compose")}><Pencil size={15} /> {t("compose.new")}</button>

  <div class="scroll">
    <div class="group">
      <SmartSections variant="full" />
    </div>

    {#each app.accounts as acc (acc.id)}
      <div class="group" class:collapsed={sidebarUi.collapsed[acc.id]}>
        <div class="account" class:open={sidebarUi.menuFor === acc.id} class:collapsed={sidebarUi.collapsed[acc.id]}>
          <button class="account-name" onclick={() => sidebarUi.toggleAccount(acc.id)} oncontextmenu={(e) => sidebarUi.contextMenu(e, acc, null)} title={acc.email}>
            <span class="dot {acc.status?.state ?? 'connecting'}" style:--dot={app.accountColor(acc.id)} title={statusText(acc)}></span>
            <span class="name">{accountLabel(acc)}</span>
            <span class="chev"><ChevronRight size={13} /></span>
          </button>
          <button class="menu-btn" onclick={() => (sidebarUi.menuFor = sidebarUi.menuFor === acc.id ? null : acc.id)} title={t("account.menu")} aria-label={t("account.menu")}><Ellipsis size={15} /></button>
          <Popover bind:open={() => sidebarUi.menuFor === acc.id, (v) => (sidebarUi.menuFor = v ? acc.id : null)}>
            <button class="mi" onclick={() => sidebarUi.refresh(acc)}><RotateCw size={15} /> {t("account.refresh")}</button>
            <button class="mi" onclick={() => { sidebarUi.menuFor = null; app.accountSettings(acc); }}><Settings size={15} /> {t("account.settings")}</button>
            <hr />
            <button class="mi" onclick={() => { sidebarUi.menuFor = null; app.openSettings("accounts"); }}><Inbox size={15} /> {t("accounts.manage")}</button>
            <button class="mi" onclick={() => { sidebarUi.menuFor = null; app.accountSettings(null); }}><Plus size={15} /> {t("account.add")}</button>
          </Popover>
        </div>
        <Problem account={acc} />
        <Favourites account={acc} />
        {#if !sidebarUi.collapsed[acc.id]}
          {#if favourites.of(acc.id).length}<div class="all-label">{t("favourites.allFolders")}</div>{/if}
          <SidebarTree account={acc} />
          <Labels account={acc} />
        {/if}
        <QuotaLine account={acc} />
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
    <DndButton align="left" />
    <TasksButton />
  </div>
  {#if sidebarUi.folderMenu}
    {#key sidebarUi.folderMenu}<FolderMenu at={sidebarUi.folderMenu.at} account={sidebarUi.folderMenu.account} folder={sidebarUi.folderMenu.folder} onclose={() => (sidebarUi.folderMenu = null)} />{/key}
  {/if}
</nav>

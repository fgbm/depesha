<script lang="ts">
  // The sidebar folded into a strip of icons (#38): the smart sections as square tiles, a
  // circle per mailbox, and beside a circle the mailbox's folders — its favourites first,
  // the whole tree under «All folders». Used when the window is too narrow for the full
  // sidebar or when it is folded by hand.

  import Download from "@lucide/svelte/icons/download";
  import RotateCw from "@lucide/svelte/icons/rotate-cw";
  import ChevronsRight from "@lucide/svelte/icons/chevrons-right";
  import Settings from "@lucide/svelte/icons/settings";
  import Folder from "@lucide/svelte/icons/folder";
  import ChevronRight from "@lucide/svelte/icons/chevron-right";
  import Pencil from "@lucide/svelte/icons/pencil";
  import { app } from "../../lib/store.svelte";
  import { t } from "../../lib/i18n.svelte";
  import { accountLabel } from "../../lib/format";
  import { layout } from "../../lib/layout.svelte";
  import { rooms } from "../../lib/room.svelte";
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
  import SidebarTree from "./SidebarTree.svelte";
  import Favourites from "./Favourites.svelte";

  let { onCompose }: { onCompose: () => void } = $props();
</script>

<nav class="side strip">
  <div class="brand" data-tauri-drag-region>
    <img src="/icon.png" alt="" width="26" height="26" />
  </div>

  <button class="btn primary tile-compose" onclick={onCompose} title={t("compose.newHint")} aria-label={t("compose.new")}><Pencil size={16} /></button>

  <div class="scroll">
    <div class="tiles">
      <SmartSections variant="strip" />
    </div>

    <div class="circles">
      {#each app.accounts as acc (acc.id)}
        {@const unread = sidebarUi.inboxUnread(acc)}
        {@const state = acc.status?.state ?? "connecting"}
        <div class="circle-wrap">
          <button
            class="circle"
            class:open={sidebarUi.flyout === acc.id}
            class:current={app.view.kind === "folder" && app.view.account_id === acc.id}
            style:--acc={app.accountColor(acc.id)}
            onclick={() => (sidebarUi.flyout = sidebarUi.flyout === acc.id ? null : acc.id)}
            oncontextmenu={(e) => sidebarUi.contextMenu(e, acc, null)}
            title={`${accountLabel(acc)} · ${statusText(acc)}`}
            aria-label={accountLabel(acc)}
            aria-haspopup="menu"
            aria-expanded={sidebarUi.flyout === acc.id}
          >
            {sidebarUi.accountInitials(acc)}
            {#if rooms.level(acc) > 0}<span class="ring" class:full={rooms.level(acc) === 3}></span>{/if}
            <span class="status {state}"></span>
            {#if unread > 0}<span class="badge">{sidebarUi.badge(unread)}</span>{/if}
          </button>
          <Popover bind:open={() => sidebarUi.flyout === acc.id, (v) => (sidebarUi.flyout = v ? acc.id : null)} beside tone="side">
            <div class="fly-head" oncontextmenu={(e) => sidebarUi.contextMenu(e, acc, null)} role="presentation">
              <span class="dot {state}" style:--dot={app.accountColor(acc.id)} title={statusText(acc)}></span>
              <span class="fly-name">{accountLabel(acc)}</span>
            </div>
            {#if acc.label?.trim()}<div class="fly-mail">{acc.email}</div>{/if}
            <Problem account={acc} picked={() => (sidebarUi.flyout = null)} />
            <div class="fly-folders">
              {#if favourites.of(acc.id).length}
                <Favourites account={acc} picked={() => (sidebarUi.flyout = null)} />
                <button class="item all-folders" role="menuitem" aria-expanded={sidebarUi.flyoutTree} onclick={() => (sidebarUi.flyoutTree = !sidebarUi.flyoutTree)}>
                  <span class="icon"><Folder size={16} /></span>
                  <span class="name">{t("favourites.allFolders")}</span>
                  <span class="disclose" class:open={sidebarUi.flyoutTree}><ChevronRight size={14} /></span>
                </button>
                {#if sidebarUi.flyoutTree}<SidebarTree account={acc} picked={() => (sidebarUi.flyout = null)} />{/if}
              {:else}
                <SidebarTree account={acc} picked={() => (sidebarUi.flyout = null)} />
              {/if}
            </div>
            <QuotaLine account={acc} fly onopen={() => (sidebarUi.flyout = null)} />
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
    <DndButton align="left" />
    <TasksButton />
    <button class="foot-btn" onclick={() => app.openSettings()} title={t("settings.title")} aria-label={t("settings.title")}><Settings size={16} /></button>
  </div>
  {#if sidebarUi.folderMenu}
    {#key sidebarUi.folderMenu}<FolderMenu at={sidebarUi.folderMenu.at} account={sidebarUi.folderMenu.account} folder={sidebarUi.folderMenu.folder} onclose={() => (sidebarUi.folderMenu = null)} />{/key}
  {/if}
</nav>

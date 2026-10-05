<script lang="ts">
  // One folder row of the sidebar, whichever way it is shown: a folder of the tree, the
  // same folder under the favourites while it fades out, or an unavailable favourite. One
  // component instead of a snippet rendered from two places: the row, its star and its
  // counter are laid out once, and the CSS that keeps the stars in one column goes with
  // them. The tree loop and the favourites block are rendered by their parents.

  import Star from "@lucide/svelte/icons/star";
  import ChevronRight from "@lucide/svelte/icons/chevron-right";
  import ChevronDown from "@lucide/svelte/icons/chevron-down";
  import { slide } from "svelte/transition";
  import { app, type View } from "../../lib/store.svelte";
  import { t } from "../../lib/i18n.svelte";
  import { roleLabel } from "../../lib/format";
  import { favourites, splitPath, type Favourite } from "../../lib/favourites.svelte";
  import type { AccountView, FolderInfo } from "../../lib/types";
  import { sidebarUi, roleIcon } from "./sidebar.svelte";

  // A folder of the tree, or a favourite of the mailbox (which may be gone from the server);
  // `picked` is called when the row is chosen inside the strip's flyout.
  let { account, folder = null, favourite = null, hasChildren = false, picked = null }: {
    account: AccountView;
    folder?: FolderInfo | null;
    favourite?: Favourite | null;
    hasChildren?: boolean;
    picked?: (() => void) | null;
  } = $props();

  /** For a favourite: the folder in the mailbox, or undefined when it is gone. */
  const found = $derived(favourite ? app.folder(account.id, favourite.name) : undefined);
  const gone = $derived(!!favourite && sidebarUi.listed(account) && !found?.selectable);
  const Icon = $derived(roleIcon(folder ? folder.role : (found?.role ?? null)));

  /** The height of a removed favourite goes to zero shortly; at once when motion is reduced. */
  function closing(node: Element) {
    const reduced = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
    return slide(node, { duration: reduced ? 0 : 150 });
  }
</script>

{#snippet count(f: FolderInfo)}
  <!-- Drafts count all of them: a draft is not «unread». -->
  {#if f.role === "drafts"}
    {#if f.total > 0}<span class="count quiet">{f.total}</span>{/if}
  {:else if f.unread > 0 && f.role !== "sent" && f.role !== "trash"}
    <span class="count">{f.unread}</span>
  {/if}
{/snippet}

{#snippet star(acc: AccountView, fav: Favourite)}
  {@const on = favourites.has(acc.id, fav.name)}
  <button
    class="star"
    class:on
    aria-pressed={on}
    title={on ? t("favourites.remove") : t("favourites.add")}
    aria-label={on ? t("favourites.remove") : t("favourites.add")}
    onclick={() => favourites.toggle(acc.id, fav)}
  ><Star size={15} fill={on ? "currentColor" : "none"} /></button>
{/snippet}

{#if folder}
  {@const v = { kind: "folder", account_id: account.id, folder: folder.name } as View}
  <div class="folder-row" data-folder={folder.name}>
    {#if hasChildren}
      {@const open = !sidebarUi.isFolded(folder)}
      <!-- A triangle of its own: a click on the name still opens the folder. -->
      <button
        class="fold"
        style:left="{sidebarUi.depth(folder) * 14}px"
        onclick={() => sidebarUi.fold(folder)}
        aria-expanded={open}
        title={open ? t("sidebar.foldFolder") : t("sidebar.unfoldFolder")}
        aria-label={`${open ? t("sidebar.foldFolder") : t("sidebar.unfoldFolder")}: ${sidebarUi.label(folder)}`}
      >{#if open}<ChevronDown size={12} />{:else}<ChevronRight size={12} />{/if}</button>
    {/if}
    <button
      class="item"
      class:active={sidebarUi.isActive(v)}
      class:disabled={!folder.selectable}
      disabled={!folder.selectable}
      role={picked ? "menuitem" : undefined}
      style:padding-left="{14 + sidebarUi.depth(folder) * 14}px"
      onclick={() => {
        picked?.();
        app.setView(v);
      }}
      oncontextmenu={(e) => folder.selectable && sidebarUi.contextMenu(e, account, folder)}
      title={folder.display_name}
    >
      <span class="icon"><Icon size={16} /></span>
      <span class="name">{sidebarUi.label(folder)}</span>
      {@render count(folder)}
    </button>
    {#if folder.selectable}{@render star(account, sidebarUi.favouriteOf(folder))}{/if}
  </div>
{:else if favourite}
  {@const fav = favourite}
  {@const v = { kind: "folder", account_id: account.id, folder: fav.name } as View}
  {@const where = splitPath(found?.display_name ?? fav.display, found?.delimiter ?? fav.delimiter)}
  <div class="folder-row fav-row" class:leaving={favourites.isLeaving(account.id, fav.name)} data-account={account.id} data-folder={fav.name} out:closing>
    <button
      class="item"
      class:active={!gone && sidebarUi.isActive(v)}
      class:disabled={gone}
      disabled={gone}
      role={picked ? "menuitem" : undefined}
      onclick={() => {
        picked?.();
        app.setView(v);
      }}
      oncontextmenu={(e) => found && !gone && sidebarUi.contextMenu(e, account, found)}
      title={gone ? t("favourites.gone", { name: fav.display }) : (found?.display_name ?? fav.display)}
    >
      <span class="icon"><Icon size={16} /></span>
      <span class="name">{found?.role ? roleLabel(found.role) : where.leaf}{#if where.path}<span class="path">{where.path}</span>{/if}</span>
      {#if found && !gone}{@render count(found)}{/if}
    </button>
    {@render star(account, fav)}
  </div>
{/if}

<script lang="ts" module>
  // The counter and the star are shared with FavouriteRow; the `block` flag keeps the block's star an outline one, the tree's filled.
  import Star from "@lucide/svelte/icons/star";
  import { t } from "../../lib/i18n.svelte";
  import { favourites, type Favourite } from "../../lib/favourites.svelte";
  import type { AccountView, FolderInfo } from "../../lib/types";

  export { count, star };
</script>

<script lang="ts">
  // One folder row of the tree. The favourites are FavouriteRow's: a removed favourite
  // fades out, and its transition only plays when its element is the loop's own row,
  // with no block in between. The CSS that keeps the counters and the stars in one column
  // is the sidebar's. The tree loop is rendered by the parent.

  import ChevronRight from "@lucide/svelte/icons/chevron-right";
  import ChevronDown from "@lucide/svelte/icons/chevron-down";
  import { app, type View } from "../../lib/store.svelte";
  import { sidebarUi, roleIcon } from "./sidebar.svelte";

  // `picked` is called when the row is chosen inside the strip's flyout.
  let { account, folder, hasChildren = false, picked = null }: {
    account: AccountView;
    folder: FolderInfo;
    hasChildren?: boolean;
    picked?: (() => void) | null;
  } = $props();

  const Icon = $derived(roleIcon(folder.role));
  const v = $derived({ kind: "folder", account_id: account.id, folder: folder.name } as View);
</script>

{#snippet count(f: FolderInfo)}
  <!-- Drafts count all of them: a draft is not «unread». -->
  {#if f.role === "drafts"}
    {#if f.total > 0}<span class="count quiet">{f.total}</span>{/if}
  {:else if f.unread > 0 && f.role !== "sent" && f.role !== "trash"}
    <span class="count">{f.unread}</span>
  {/if}
{/snippet}

{#snippet star(acc: AccountView, fav: Favourite, block = false)}
  {@const on = favourites.has(acc.id, fav.name)}
  <button
    class="star"
    class:on
    aria-pressed={on}
    title={on ? t("favourites.remove") : t("favourites.add")}
    aria-label={on ? t("favourites.remove") : t("favourites.add")}
    onclick={() => favourites.toggle(acc.id, fav)}
  ><Star size={15} fill={on && !block ? "currentColor" : "none"} /></button>
{/snippet}

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

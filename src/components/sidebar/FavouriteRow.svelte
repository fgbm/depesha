<script lang="ts">
  // One favourite of the mailbox above its tree. A folder may be gone from the server; a
  // label (#42) is Depesha's own and is always there, shown as its saved search. The row is
  // the loop's own element: Svelte plays a local `out:` transition only on the element the
  // removed loop item renders directly, so an unstarred favourite collapses instead of
  // vanishing after its fade.

  import { slide } from "svelte/transition";
  import Tag from "@lucide/svelte/icons/tag";
  import { app, type View } from "../../lib/store.svelte";
  import { t } from "../../lib/i18n.svelte";
  import { roleLabel } from "../../lib/format";
  import { favourites, splitPath, type Favourite } from "../../lib/favourites.svelte";
  import type { AccountView } from "../../lib/types";
  import { sidebarUi, roleIcon } from "./sidebar.svelte";
  import { count, star } from "./FolderRow.svelte";

  // `picked` is called when the row is chosen inside the strip's flyout.
  let { account, favourite: fav, picked = null }: {
    account: AccountView;
    favourite: Favourite;
    picked?: (() => void) | null;
  } = $props();

  const isLabel = $derived(fav.kind === "label");
  /** The folder in the mailbox, or undefined when it is gone. */
  const found = $derived(isLabel ? undefined : app.folder(account.id, fav.name));
  const gone = $derived(!isLabel && sidebarUi.listed(account) && !found?.selectable);
  const Icon = $derived(isLabel ? Tag : roleIcon(found?.role ?? null));
  const v = $derived(
    (isLabel ? { kind: "search", text: `метка:${fav.name}` } : { kind: "folder", account_id: account.id, folder: fav.name }) as View,
  );
  const where = $derived(splitPath(found?.display_name ?? fav.display, found?.delimiter ?? fav.delimiter));
  const labelColor = $derived(app.labels.of(account.id).find((l) => l.name === fav.name)?.color ?? "");

  /** The height of a removed favourite goes to zero shortly; at once when motion is reduced. */
  function closing(node: Element) {
    const reduced = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
    return slide(node, { duration: reduced ? 0 : 150 });
  }
</script>

<div class="folder-row fav-row" class:leaving={favourites.isLeaving(account.id, fav.name, fav.kind ?? "folder")} data-account={account.id} data-folder={fav.name} out:closing>
  <button
    class="item"
    class:active={!gone && sidebarUi.isActive(v)}
    class:disabled={gone}
    disabled={gone}
    role={picked ? "menuitem" : undefined}
    onclick={() => {
      picked?.();
      app.selection.setView(v);
    }}
    oncontextmenu={(e) => !isLabel && found && !gone && sidebarUi.contextMenu(e, account, found)}
    title={gone ? t("favourites.gone", { name: fav.display }) : (found?.display_name ?? fav.display)}
  >
    <span class="icon">{#if isLabel}<span class="lsw" style:--c={labelColor || "var(--muted)"}></span>{:else}<Icon size={16} />{/if}</span>
    <span class="name">{#if isLabel}{fav.name}{:else}{found?.role ? roleLabel(found.role) : where.leaf}{/if}{#if !isLabel && where.path}<span class="path">{where.path}</span>{/if}</span>
    {#if !isLabel && found && !gone}{@render count(found)}{/if}
  </button>
  {@render star(account, fav, true)}
</div>

<style>
  .lsw {
    display: inline-block;
    width: 12px;
    height: 12px;
    border-radius: 3px;
    background: var(--c, var(--muted));
  }
</style>

<script lang="ts">
  // The folder tree of one mailbox: its folders, subfolders indented, the folded ones
  // hidden. Shared folders and other people's folders sit in a group of their own under
  // a heading, by NAMESPACE (#42, frame 6Б). The rows and their CSS are FolderRow's; here
  // is only the loop, its fold state and the grouping. Used by the full sidebar and, in
  // the strip's flyout, under «All folders».

  import Users from "@lucide/svelte/icons/users";
  import User from "@lucide/svelte/icons/user";
  import { t } from "../../lib/i18n.svelte";
  import { withChildren, unfolded } from "../../lib/folders";
  import { groupFolders } from "../../lib/labels";
  import { rooms } from "../../lib/room.svelte";
  import type { AccountView } from "../../lib/types";
  import { sidebarUi } from "./sidebar.svelte";
  import FolderRow from "./FolderRow.svelte";

  let { account, picked = null }: { account: AccountView; picked?: (() => void) | null } = $props();

  const all = $derived(sidebarUi.foldersOf(account));
  const parents = $derived(withChildren(all));
  const shown = $derived(unfolded(all, (name) => sidebarUi.foldedName(account.id, name)));
  // The namespaces the account learned; without them everything stays in one list.
  const ns = $derived(rooms.infos[account.id]?.namespaces ?? null);
  const grouped = $derived(groupFolders(shown, ns));
</script>

{#each grouped.mine as f (f.name)}
  <FolderRow {account} folder={f} hasChildren={parents.has(f.name)} {picked} />
{/each}

{#if grouped.shared.length}
  <div class="subhead"><Users size={13} />{t("sidebar.shared")}</div>
  {#each grouped.shared as f (f.name)}
    <FolderRow {account} folder={f} hasChildren={parents.has(f.name)} {picked} />
  {/each}
{/if}

{#each grouped.others as group (group.owner)}
  <div class="subhead"><User size={13} />{group.owner}</div>
  {#each group.folders as f (f.name)}
    <FolderRow {account} folder={f} hasChildren={parents.has(f.name)} {picked} />
  {/each}
{/each}

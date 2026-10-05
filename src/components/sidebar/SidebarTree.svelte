<script lang="ts">
  // The folder tree of one mailbox: its folders, subfolders indented, the folded ones
  // hidden. The rows and their CSS are FolderRow's; here is only the loop and its fold
  // state. Used by the full sidebar and, in the strip's flyout, under «All folders».

  import { withChildren, unfolded } from "../../lib/folders";
  import type { AccountView } from "../../lib/types";
  import { sidebarUi } from "./sidebar.svelte";
  import FolderRow from "./FolderRow.svelte";

  let { account, picked = null }: { account: AccountView; picked?: (() => void) | null } = $props();

  const all = $derived(sidebarUi.foldersOf(account));
  const parents = $derived(withChildren(all));
  const shown = $derived(unfolded(all, (name) => sidebarUi.foldedName(account.id, name)));
</script>

{#each shown as f (f.name)}
  <FolderRow {account} folder={f} hasChildren={parents.has(f.name)} {picked} />
{/each}

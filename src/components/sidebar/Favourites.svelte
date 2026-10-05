<script lang="ts">
  // The mailbox's favourites: the block above its tree, in the order they were added,
  // whatever is folded. A favourite that is gone from the server still shows here, struck
  // through, until it is unstarred. The rows themselves and their stars are FolderRow's.

  import { t } from "../../lib/i18n.svelte";
  import { favourites } from "../../lib/favourites.svelte";
  import type { AccountView } from "../../lib/types";
  import FolderRow from "./FolderRow.svelte";

  let { account, picked = null }: { account: AccountView; picked?: (() => void) | null } = $props();
</script>

{#if favourites.of(account.id).length}
  <div class="favs" role="group" aria-label={t("favourites.title")}>
    {#each favourites.of(account.id) as fav (fav.name)}
      <FolderRow {account} favourite={fav} {picked} />
    {/each}
  </div>
{/if}

<style>
  .favs {
    display: flex;
    flex-direction: column;
  }
</style>

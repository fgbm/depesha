<script lang="ts">
  import Accounts from "../Accounts.svelte";
  import Wizard from "../Wizard.svelte";
  import AccountPage from "../account/AccountPage.svelte";
  import type { AccountView } from "../../lib/types";

  // The mailboxes' page of the settings window: the manager, a new mailbox, and one mailbox's
  // own page. Which is open is decided by the shell's `current`; a mailbox's page keeps its own
  // footer and saves apart from the rest.
  let {
    current,
    pageAccount,
    onOpen,
  }: {
    current: string;
    pageAccount: AccountView | null;
    onOpen: (page: string) => void;
  } = $props();
</script>

{#if current === "account:new"}
  <Wizard embedded onDone={() => onOpen("accounts")} />
{:else if pageAccount}
  {#key current}
    <AccountPage account={pageAccount} onDone={() => onOpen("accounts")} />
  {/key}
{:else}
  <Accounts {onOpen} />
{/if}

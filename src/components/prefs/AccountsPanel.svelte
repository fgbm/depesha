<script lang="ts">
  import { registry } from "../../plugin-host/registry.svelte";
  import Accounts from "../Accounts.svelte";
  import Plugins from "../Plugins.svelte";
  import Wizard from "../Wizard.svelte";
  import AccountPage from "../account/AccountPage.svelte";
  import type { AccountView } from "../../lib/types";

  // The mailboxes' and plugins' pages of the settings window. Which page is open is
  // decided by the shell's `current`; a mailbox's page keeps its own footer, a
  // plugin's section is rendered by the plugin's own component through the registry.
  let {
    current,
    pageAccount,
    onOpen,
  }: {
    current: string;
    pageAccount: AccountView | null;
    onOpen: (page: string) => void;
  } = $props();

  const sections = $derived(registry.lists.settingsSections);
</script>

{#if current === "accounts"}
  <Accounts {onOpen} />
{:else if current === "plugins"}
  <Plugins />
{:else if current === "account:new"}
  <Wizard embedded onDone={() => onOpen("accounts")} />
{:else if pageAccount}
  {#key current}
    <AccountPage account={pageAccount} onDone={() => onOpen("accounts")} />
  {/key}
{:else}
  {@const sec = sections[Number(current.slice(7))]}
  {#if sec}
    <section>
      <sec.item.component {...sec.item.props} />
    </section>
  {/if}
{/if}

<style>
  section {
    padding: 14px 0;
    border-bottom: 1px solid var(--line);
  }

  section:last-child {
    border-bottom: none;
  }
</style>

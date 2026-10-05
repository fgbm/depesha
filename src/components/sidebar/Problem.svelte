<script module lang="ts">
  // How a mailbox is connected, or why it is not. Shared by the sidebar's components
  // (the account row, the strip's circle) besides the Problem button itself. `t` is
  // imported once, here, and used by both scripts of this file.
  import { t } from "../../lib/i18n.svelte";
  import type { AccountView } from "../../lib/types";

  export function statusText(acc: AccountView): string {
    const s = acc.status;
    if (!s) return t("status.connecting");
    if (s.state === "online") return t("status.online");
    if (s.state === "connecting") return t("status.connecting");
    return s.error?.message ?? t("status.error");
  }
</script>

<script lang="ts">
  // The line under a mailbox's name when it could not connect: what happened, and how to
  // put it right. The same in the full sidebar and in the strip's flyout.
  import { app } from "../../lib/store.svelte";
  import { sidebarUi } from "./sidebar.svelte";

  let { account, picked = null }: { account: AccountView; picked?: (() => void) | null } = $props();
</script>

{#if account.status && (account.status.state === "error" || account.status.state === "paused")}
  <button
    class="problem"
    role={picked ? "menuitem" : undefined}
    onclick={() => {
      picked?.();
      if (account.status?.state === "paused") app.accountSettings(account);
      else sidebarUi.refresh(account);
    }}
  >
    {statusText(account)}
    <span class="fix">{account.status.state === "paused" ? t("account.fix") : t("retry")}</span>
  </button>
{/if}

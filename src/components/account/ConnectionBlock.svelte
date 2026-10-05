<script lang="ts">
  // The connection, folded: one line says where the mailbox connects and whether it does,
  // so checking it needs no unfolding. Unfolded, the fields the wizard has.
  import ChevronRight from "@lucide/svelte/icons/chevron-right";
  import { t } from "../../lib/i18n.svelte";
  import { connectionState, connectionSummary } from "../../lib/connection";
  import type { AccountForm } from "../../lib/accountForm.svelte";
  import type { AccountStatus } from "../../lib/types";
  import ConnectionFields from "./ConnectionFields.svelte";

  let { form, status, open = $bindable(false) }: { form: AccountForm; status: AccountStatus | null; open?: boolean } = $props();

  const summary = $derived(connectionSummary(form.account(), (p) => form.providerTitle(p)));
  const state = $derived(connectionState(status));
</script>

<div class="block" class:open>
  <button class="head" aria-expanded={open} aria-controls="account-connection" onclick={() => (open = !open)}>
    <ChevronRight size={15} class="chevron" />
    <b>{t("account.connection")}</b>
    <span class="summary muted" title={summary}>{summary}</span>
    {#if state}<span class="state {state.state}" title={status?.error?.message ?? state.text}>{state.text}</span>{/if}
  </button>
  {#if open}
    <div class="body" id="account-connection">
      <ConnectionFields {form} />
    </div>
  {/if}
</div>

<style>
  .block {
    border: 1px solid var(--line);
    border-radius: 8px;
  }

  .head {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    padding: 9px 12px;
    border: none;
    border-radius: 8px;
    background: none;
    color: var(--ink);
    font: inherit;
    text-align: left;
  }

  .head:hover {
    background: var(--hover);
  }

  .head:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: -2px;
  }

  .head :global(.chevron) {
    flex: none;
    color: var(--muted);
    transition: transform 0.12s;
  }

  .open .head :global(.chevron) {
    transform: rotate(90deg);
  }

  b {
    flex: none;
    font-weight: 600;
  }

  .summary {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 12px;
  }

  .state {
    flex: none;
    display: inline-flex;
    align-items: center;
    gap: 5px;
    font-size: 12px;
    color: var(--muted);
  }

  .state::before {
    content: "";
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: currentColor;
  }

  /* The sidebar's colours for the same states. */
  .state.online {
    color: var(--ok);
  }

  .state.error {
    color: var(--warn);
  }

  .state.paused {
    color: var(--accent);
  }

  .body {
    padding: 4px 12px 12px;
  }
</style>

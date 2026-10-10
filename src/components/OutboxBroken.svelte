<script lang="ts">
  import { app } from "../lib/store.svelte";
  import { api } from "../lib/api";
  import { t } from "../lib/i18n.svelte";
  import type { OutboxItem } from "../lib/types";

  let { item }: { item: OutboxItem } = $props();

  /** A letter that cannot be read is deleted only by the user's word. */
  async function discard() {
    await api.outboxDiscard(item.id).catch((e) => app.ui.fail(e));
  }
</script>

<div class="item broken">
  <div class="main">
    <b>{t("outbox.broken")}</b>
    <div class="muted small">{app.mailboxes.account(item.account_id)?.email ?? item.account_id}</div>
    <div class="small danger-text">{t("outbox.brokenAbout")}</div>
  </div>
  <div class="actions">
    <button class="btn" onclick={discard}>{t("outbox.discard")}</button>
  </div>
</div>

<style>
  .item {
    display: flex;
    gap: 16px;
    align-items: flex-start;
    border: 1px solid var(--line);
    border-left: 4px solid var(--accent);
    border-radius: 8px;
    padding: 12px 14px;
    margin-top: 10px;
    background: var(--paper);
  }

  .main {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 3px;
    user-select: text;
  }

  .small {
    font-size: 12px;
  }
</style>

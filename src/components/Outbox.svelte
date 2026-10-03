<script lang="ts">
  import { app } from "../lib/store.svelte";
  import { api } from "../lib/api";
  import { addrFull, shortDateTime } from "../lib/format";
  import type { AttachmentSource, ComposeDraft } from "../lib/types";

  async function retry(id: number) {
    await api.outboxRetry(id).catch((e) => app.fail(e));
  }

  /** Takes the message out of the queue and opens it for editing. */
  async function edit(id: number) {
    try {
      const back = await api.outboxCancel(id);
      if (!back) return;
      const attachments: AttachmentSource[] = [];
      for (const [name, , data] of back.attachments) {
        const path = await api.tempAttachment(name, data);
        attachments.push({ kind: "file", path, name, size: Math.floor((data.length * 3) / 4) });
      }
      const d = back.draft;
      const draft: ComposeDraft = {
        from: d.from,
        to: d.to,
        cc: d.cc,
        bcc: d.bcc,
        subject: d.subject,
        text: d.text,
        in_reply_to: d.in_reply_to,
        references: d.references,
        attachments,
      };
      app.compose = { account_id: back.account_id, draft, draft_id: null };
    } catch (e) {
      app.fail(e);
    }
  }
</script>

<div class="outbox">
  <h2>Исходящие</h2>
  <p class="muted">Письма ждут отправки. Временные ошибки (нет сети, лимит сервера) повторяются сами.</p>
  {#if app.outbox.length === 0}
    <p class="muted">Очередь пуста.</p>
  {/if}
  {#each app.outbox as item (item.id)}
    <div class="item" class:failed={item.failed}>
      <div class="main">
        <b>{item.draft.subject || "(без темы)"}</b>
        <div class="muted small">Кому: {item.draft.to.map(addrFull).join(", ")} · {app.account(item.account_id)?.email ?? item.account_id}</div>
        {#if item.last_error}
          <div class="small" class:danger-text={item.failed}>{item.last_error}</div>
        {/if}
        <div class="muted small">
          {#if item.failed}
            Не отправлено, нужна ваша проверка
          {:else if item.attempts > 0}
            Попытка {item.attempts + 1} около {shortDateTime(item.next_attempt)}
          {:else}
            Отправляется…
          {/if}
        </div>
      </div>
      <div class="actions">
        <button class="btn" onclick={() => retry(item.id)}>Отправить сейчас</button>
        <button class="btn ghost" onclick={() => edit(item.id)}>Изменить</button>
      </div>
    </div>
  {/each}
</div>

<style>
  .outbox {
    padding: 20px 28px;
    max-width: 900px;
  }

  h2 {
    margin: 0 0 6px;
  }

  .item {
    display: flex;
    gap: 16px;
    align-items: flex-start;
    border: 1px solid var(--line);
    border-radius: 8px;
    padding: 12px 14px;
    margin-top: 10px;
    background: var(--paper);
  }

  .item.failed {
    border-left: 4px solid var(--accent);
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

  .actions {
    display: flex;
    gap: 6px;
  }
</style>

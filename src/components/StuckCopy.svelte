<script lang="ts">
  import Pause from "@lucide/svelte/icons/pause";
  import { app } from "../lib/store.svelte";
  import { api } from "../lib/api";
  import { t } from "../lib/i18n.svelte";
  import { accountLabel } from "../lib/format";
  import { copyFileName, stuckId } from "../lib/stuckCopies";
  import type { Task } from "../lib/types";

  /** A copy of a sent letter the server refuses to keep in «Sent»: what happened and what to do. */
  let { task }: { task: Task } = $props();

  let busy = $state(false);
  const id = $derived(stuckId(task));
  const acc = $derived(task.account_id ? app.account(task.account_id) : undefined);
  // The task's label is «Copy not saved: «subject»»; the file is named after the subject.
  const subject = $derived(/«(.*)»/s.exec(task.label)?.[1] ?? "");
  // The server has the copy; what failed is the start of the wait for a reply (a local error).
  const filed = $derived(task.error?.kind === "copy-filed");

  async function retry() {
    if (id === null) return;
    busy = true;
    try {
      const attempted = await api.sentCopyRetry(id);
      // `false`: the background round already has the copy, nothing was tried here.
      app.toast(attempted ? t("stuck.retried") : t("stuck.inProgress"));
    } catch (e) {
      const reason = (e as { message?: string })?.message ?? "";
      app.toast(t("stuck.stillRefused", { reason }), true);
    } finally {
      busy = false;
    }
  }

  async function save() {
    if (id === null) return;
    try {
      const path = await api.pickSaveFile(t("stuck.saveTitle"), copyFileName(subject));
      if (!path) return;
      await api.sentCopySave(id, path);
      app.toast(t("stuck.savedFile"));
    } catch (e) {
      app.fail(e);
    }
  }

  async function drop() {
    if (id === null) return;
    try {
      await api.sentCopyDrop(id);
    } catch (e) {
      app.fail(e);
    }
  }
</script>

<div class="task stuck" data-kind={task.kind} data-copy={id}>
  <div class="line">
    <span class="icon"><Pause size={14} /></span>
    <span class="label">{task.label}</span>
    {#if acc && app.accounts.length > 1}<span class="muted small">{accountLabel(acc)}</span>{/if}
  </div>
  <p class="small text">{t(filed ? "stuck.textFiled" : "stuck.text")}</p>
  {#if task.error?.message}<div class="reason small selectable">{task.error.message}</div>{/if}
  <div class="actions">
    <button class="btn ghost small-btn" disabled={busy} onclick={retry}>{t("retry")}</button>
    <button class="btn ghost small-btn" onclick={save}>{t("stuck.save")}</button>
    <button class="btn ghost small-btn" onclick={drop}>{t("stuck.drop")}</button>
  </div>
</div>

<style>
  .stuck {
    padding: 6px 0;
  }

  .line {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
  }

  .icon {
    display: inline-flex;
    color: var(--muted);
  }

  .label {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .small {
    font-size: 12px;
  }

  .text {
    margin: 4px 0;
  }

  .reason {
    margin-bottom: 6px;
    font-family: var(--mono, ui-monospace, monospace);
    color: var(--muted);
    overflow-wrap: anywhere;
  }

  .actions {
    display: flex;
    gap: 6px;
    flex-wrap: wrap;
  }

  .small-btn {
    padding: 2px 8px;
    font-size: 12px;
    white-space: nowrap;
  }
</style>

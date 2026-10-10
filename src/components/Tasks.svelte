<script lang="ts">
  import RotateCw from "@lucide/svelte/icons/rotate-cw";
  import Pause from "@lucide/svelte/icons/pause";
  import Play from "@lucide/svelte/icons/play";
  import X from "@lucide/svelte/icons/x";
  import { onMount } from "svelte";
  import { app } from "../lib/store.svelte";
  import { api } from "../lib/api";
  import { t } from "../lib/i18n.svelte";
  import { accountLabel } from "../lib/format";
  import { when } from "../lib/later";
  import type { AccountSync, Task } from "../lib/types";
  import StuckCopy from "./StuckCopy.svelte";
  import { stuckTasks } from "../lib/stuckCopies";

  /** Background work: what runs now, what failed, and how far each account is synced. */
  let overview = $state<AccountSync[]>([]);
  let syncing = $state<Record<string, boolean>>({});

  async function loadOverview() {
    overview = await api.syncOverview().catch(() => []); // The overview is a nicety next to the tasks; an empty one is shown when it cannot be read.
  }

  onMount(() => {
    loadOverview();
  });

  // Every change of the tasks may move the counters.
  $effect(() => {
    void app.tasks;
    loadOverview();
  });

  const running = $derived(app.tasks.filter((x) => x.state === "running"));
  const failed = $derived(app.tasks.filter((x) => x.state === "failed" && x.kind !== "stuck-copy"));
  // A copy the server refuses is not a failure to dismiss: it waits for a decision.
  const stuck = $derived(stuckTasks(app.tasks));
  const offline = $derived(app.settings.offline !== "off");

  function percent(x: { done: number; total: number }): number {
    return x.total > 0 ? Math.min(100, Math.round((x.done / x.total) * 100)) : 0;
  }

  function accountName(id?: string): string {
    const acc = id ? app.account(id) : undefined;
    return acc ? accountLabel(acc) : "";
  }

  async function syncNow(id: string) {
    syncing[id] = true;
    try {
      await api.syncNow(id);
    } catch (e) {
      app.fail(e, accountName(id));
    } finally {
      syncing[id] = false;
      loadOverview();
    }
  }

  async function setPaused(id: string, paused: boolean) {
    try {
      await api.offlinePause(id, paused);
    } catch (e) {
      app.fail(e);
    }
    loadOverview();
  }

  function retry(task: Task) {
    api.taskDismiss(task.key).catch(() => {}); // A task that cannot be dismissed stays listed; the retry goes on.
    if (task.account_id && (task.kind === "sync" || task.kind === "prefetch")) syncNow(task.account_id);
  }

  function onKey(e: KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      app.tasksOpen = false;
    }
  }

  function openSettings() {
    app.tasksOpen = false;
    app.openSettings("storage");
  }
</script>

<div class="modal-backdrop" role="presentation">
  <div class="modal tasks" role="dialog" aria-label={t("tasks.title")} tabindex="-1" onkeydown={onKey}>
    <header><h3>{t("tasks.title")}</h3></header>
    <div class="content">
      <section>
        <h4>{t("tasks.running")}</h4>
        {#each running as task (task.key)}
          <div class="task" data-kind={task.kind}>
            <div class="line">
              <span class="spin"><RotateCw size={14} /></span>
              <span class="label">{task.label}</span>
              {#if task.account_id && app.accounts.length > 1}<span class="muted small">{accountName(task.account_id)}</span>{/if}
              {#if task.kind === "empty"}
                {#if task.total > 0}<span class="muted small num">{t("clear.progress", { done: task.done, total: task.total })}</span>{/if}
                <button class="btn ghost small-btn" onclick={() => api.taskStop(task.key).catch((e) => app.fail(e))}>{t("clear.stop")}</button>
              {:else if task.total > 0}<span class="muted small num">{task.done} / {task.total}</span>{/if}
            </div>
            {#if task.total > 0}<div class="bar"><span style:width="{percent(task)}%"></span></div>{/if}
          </div>
        {:else}
          <p class="muted small">{t("tasks.idle")}</p>
        {/each}
      </section>

      {#if stuck.length}
        <section>
          <h4>{t("stuck.title")}</h4>
          {#each stuck as task (task.key)}
            <StuckCopy {task} />
          {/each}
        </section>
      {/if}

      {#if failed.length}
        <section>
          <h4>{t("tasks.failed")}</h4>
          {#each failed as task (task.key)}
            <div class="task failed" data-kind={task.kind}>
              <div class="line">
                <span class="label">{task.label}</span>
                {#if task.account_id && app.accounts.length > 1}<span class="muted small">{accountName(task.account_id)}</span>{/if}
                <span class="spacer"></span>
                {#if task.account_id && (task.kind === "sync" || task.kind === "prefetch")}
                  <button class="btn ghost small-btn" onclick={() => retry(task)}>{t("retry")}</button>
                {:else if task.kind === "empty"}
                  <button class="btn ghost small-btn" onclick={() => void app.clearing.retryTask(task)}>{t("retry")}</button>
                {/if}
                <button class="btn ghost icon" onclick={() => api.taskDismiss(task.key)} title={t("close")} aria-label={t("close")}><X size={14} /></button>
              </div>
              {#if task.error}<div class="danger-text small selectable">{task.error.message}</div>{/if}
            </div>
          {/each}
        </section>
      {/if}

      <section>
        <div class="head">
          <h4>{t("tasks.accounts")}</h4>
          <button class="btn ghost small-btn" onclick={openSettings}>{t("tasks.offlineSettings")}</button>
        </div>
        {#each app.accounts as acc (acc.id)}
          {@const o = overview.find((x) => x.account_id === acc.id)}
          <div class="acc" data-account={acc.id}>
            <div class="line">
              <span class="dot {acc.status?.state ?? 'connecting'}"></span>
              <b class="label">{accountLabel(acc)}</b>
              <span class="spacer"></span>
              <button class="btn ghost small-btn" disabled={syncing[acc.id]} onclick={() => syncNow(acc.id)}>
                <RotateCw size={14} /> {syncing[acc.id] ? t("tasks.syncing") : t("tasks.syncNow")}
              </button>
            </div>
            <div class="muted small">
              {o?.last_sync ? t("tasks.lastSync", { when: when(o.last_sync) }) : t("tasks.neverSynced")}
            </div>
            {#if offline && o}
              <div class="offline">
                <span class="small">
                  {o.offline_total === 0
                    ? t("tasks.offlineEmpty")
                    : t("tasks.offlineProgress", { done: o.offline_done, total: o.offline_total })}
                </span>
                <span class="spacer"></span>
                {#if o.offline_done < o.offline_total}
                  <button class="btn ghost small-btn" onclick={() => setPaused(acc.id, !o.paused)}>
                    {#if o.paused}<Play size={14} /> {t("tasks.resume")}{:else}<Pause size={14} /> {t("tasks.pause")}{/if}
                  </button>
                {/if}
              </div>
              {#if o.offline_total > 0}<div class="bar" class:paused={o.paused}><span style:width="{percent({ done: o.offline_done, total: o.offline_total })}%"></span></div>{/if}
            {/if}
          </div>
        {/each}
      </section>
    </div>
    <footer>
      <span class="spacer"></span>
      <button class="btn primary" onclick={() => (app.tasksOpen = false)}>{t("close")}</button>
    </footer>
  </div>
</div>

<style>
  .tasks {
    width: min(620px, calc(100vw - 40px));
    max-height: calc(100vh - 60px);
  }

  header {
    padding: 14px 20px 4px;
  }

  h3 {
    margin: 0;
  }

  .content {
    overflow-y: auto;
    padding: 0 20px 10px;
  }

  section {
    padding: 12px 0;
    border-bottom: 1px solid var(--line);
  }

  section:last-child {
    border-bottom: none;
  }

  h4 {
    margin: 0 0 6px;
    font-size: 14px;
  }

  .head {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }

  .task,
  .acc {
    padding: 6px 0;
  }

  .acc + .acc {
    border-top: 1px dashed var(--line);
  }

  .line,
  .offline {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
  }

  .offline {
    margin-top: 4px;
  }

  .label {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .num {
    margin-left: auto;
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }

  .spacer {
    flex: 1;
  }

  .small {
    font-size: 12px;
  }

  .small-btn {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 2px 8px;
    font-size: 12px;
    white-space: nowrap;
  }

  .spin {
    display: inline-flex;
    color: var(--muted);
    animation: spin 1.2s linear infinite;
  }

  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .spin {
      animation: none;
    }
  }

  .bar {
    height: 4px;
    margin-top: 5px;
    border-radius: 2px;
    background: var(--paper-2);
    overflow: hidden;
  }

  .bar span {
    display: block;
    height: 100%;
    background: var(--accent);
    transition: width 0.3s;
  }

  .bar.paused span {
    background: var(--muted);
  }

  .dot {
    flex: none;
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--muted);
  }

  .dot.online {
    background: #4a9a6a;
  }

  .dot.error,
  .dot.paused {
    background: var(--accent);
  }

  footer {
    display: flex;
    padding: 10px 20px 14px;
    border-top: 1px solid var(--line);
  }
</style>

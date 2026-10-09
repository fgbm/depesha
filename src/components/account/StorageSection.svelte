<script lang="ts">
  // The mailbox's room on the server, as the server reports it (QUOTA) or as counted from
  // its folders, with the mailbox's own limit for the warnings; and, apart, what its mail
  // takes on this computer, which is never shown as the server's.
  import HardDrive from "@lucide/svelte/icons/hard-drive";
  import Search from "@lucide/svelte/icons/search";
  import Trash from "@lucide/svelte/icons/trash-2";
  import { onMount } from "svelte";
  import { t, tn } from "../../lib/i18n.svelte";
  import { when } from "../../lib/later";
  import { app } from "../../lib/store.svelte";
  import { rooms } from "../../lib/room.svelte";
  import { limitMb } from "../../lib/accountForm.svelte";
  import { gb, levelOf, levels, percent, roomOf, usedOf, wholePercent } from "../../lib/quota";
  import type { QuotaView } from "../../lib/types";
  import type { SectionProps } from "./sections";

  let { form, account }: SectionProps = $props();

  const info = $derived(rooms.infos[account.id]);
  const sizes = $derived(info?.sizes ?? null);
  const counted = $derived(sizes?.folders.filter((f) => f.bytes !== null) ?? []);
  const failed = $derived(sizes?.folders.filter((f) => f.bytes === null) ?? []);
  const view = $derived<QuotaView>({
    account_id: account.id,
    quota: info?.quota ?? null,
    estimate: sizes ? { bytes: counted.reduce((n, f) => n + (f.bytes ?? 0), 0), partial: failed.length > 0, counted: sizes.counted } : null,
  });
  // The own limit as typed: the numbers follow the field before it is saved.
  const room = $derived(roomOf(view, { quota_limit_mb: limitMb(form.quotaLimitGb), ews: account.ews }));
  const pct = $derived(room ? percent(room) : 0);
  const level = $derived(levelOf(pct, levels(app.settings.quota_levels)));
  const quota = $derived(info?.quota && info.quota.limit > 0 ? info.quota : null);
  const ownFirst = $derived(!!room && !!room.own && !!room.quota && room.own < room.quota);
  // Connecting is not offline: only a failed connection makes the numbers old.
  const offline = $derived(account.status?.state === "error" || account.status?.state === "paused");
  const largest = $derived(Math.max(1, ...counted.map((f) => f.bytes ?? 0)));
  let ownMode = $state(false);
  let ownInput = $state<HTMLInputElement>();

  $effect.pre(() => {
    ownMode = !!form.quotaLimitGb.trim();
  });

  onMount(() => {
    // The numbers are read again while the section is open; the cache shows the last ones meanwhile.
    rooms.refresh(account.id);
  });

  function folderName(name: string): string {
    return app.folder(account.id, name)?.display_name ?? name;
  }

  function useQuota() {
    ownMode = false;
    form.quotaLimitGb = "";
  }

  function useOwn() {
    ownMode = true;
    queueMicrotask(() => ownInput?.focus());
  }

  // Both close the settings: unsaved changes on the page are asked about first.
  async function findLarge() {
    if (!(await form.mayLeave())) return;
    app.settingsOpen = false;
    rooms.findLarge();
  }

  async function openTrash() {
    const trash = app.folders.find((f) => f.account_id === account.id && f.role === "trash");
    if (!trash || !(await form.mayLeave())) return;
    app.settingsOpen = false;
    app.setView({ kind: "folder", account_id: account.id, folder: trash.name });
  }
</script>

{#if account.ews && !room}
  <p class="muted line">{t("storage.exchange")}</p>
{:else}
  <div class="room" data-level={level} class:estimate={room?.estimate} class:stale={offline}>
    {#if room && room.exchange}
      <div class="figures">
        <b>≈ {t("storage.usedAlone", { used: gb(room.used) })}</b>
        <span class="tag">{t("storage.estimateBadge")}</span>
        {#if room.limit > 0}<span class="pct">{t("storage.ofOwn", { p: wholePercent(pct) })}</span>{/if}
      </div>
      {#if room.limit > 0}
        <div class="bar hatched"><span style:width="{Math.min(100, pct)}%"></span></div>
      {/if}
      <p class="line muted">{t("storage.exchangeNote", { when: when(room.at) })} · <button class="link" onclick={() => rooms.refresh(account.id)}>{t("storage.refresh")}</button></p>
    {:else if room && !room.estimate}
      <div class="figures">
        {#if ownFirst && room.own && room.quota}
          <b>{t("storage.usedAlone", { used: gb(room.used) })}</b>
          <span class="pct">{t("storage.ofOwn", { p: wholePercent(pct) })} · {t("storage.ofQuota", { p: wholePercent((room.used / room.quota) * 100) })}</span>
        {:else}
          {@const u = usedOf(room.used, room.limit)}
          <b>{t("storage.used", { used: `${u.used}`, limit: u.limit })}</b>
          <span class="pct">{wholePercent(pct)}%</span>
        {/if}
        <span class="tag">{t("storage.source")}</span>
      </div>
      <div class="bar" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(pct)} aria-label={t("account.section.storage")}>
        <span style:width="{Math.min(100, ownFirst && room.quota ? (room.used / room.quota) * 100 : pct)}%"></span>
        {#if ownFirst && room.own && room.quota}<i class="own-mark" style:left="{(room.own / room.quota) * 100}%"></i>{/if}
      </div>
      {#if ownFirst && room.own && room.quota}
        <div class="marks muted"><span style:left="{(room.own / room.quota) * 100}%">{t("storage.ownMark", { size: gb(room.own) })}</span><span class="end">{t("storage.quotaMark", { size: gb(room.quota) })}</span></div>
      {/if}
      {#if offline && quota}
        <p class="line warn-text">{t("storage.offline", { when: when(quota.checked) })} <button class="link" onclick={() => rooms.refresh(account.id)}>{t("storage.refresh")}</button></p>
      {:else if quota}
        <p class="line muted">
          {ownFirst
            ? t("storage.quotaFree", { quota: gb(quota.limit), free: gb(Math.max(0, quota.limit - quota.used)), when: when(quota.checked) })
            : t("storage.free", { free: gb(Math.max(0, room.limit - room.used)), when: when(quota.checked) })}
          · <button class="link" onclick={() => rooms.refresh(account.id)}>{t("storage.refresh")}</button>
        </p>
      {/if}
      {#if ownFirst && room.own}<p class="line muted">{t("storage.ownNote", { size: gb(room.own) })}</p>
      {:else if quota?.root}<p class="line muted">{t("storage.root", { root: quota.root })}</p>{/if}
    {:else if room}
      {@const u = usedOf(room.used, room.limit)}
      <div class="figures">
        <b>≈ {t("storage.used", { used: u.used, limit: u.limit })}</b>
        <span class="tag">{t("storage.estimateBadge")}</span>
        <span class="pct">{t("storage.ofOwn", { p: wholePercent(pct) })}</span>
      </div>
      <div class="bar hatched"><span style:width="{Math.min(100, pct)}%"></span></div>
      <p class="line muted">{t("storage.estimateNote", { when: when(room.at) })}</p>
      {#if room.partial}
        <p class="line warn-text">{t("storage.partial", { done: counted.length, total: counted.length + failed.length, names: failed.map((f) => `«${folderName(f.folder)}»`).join(", ") })}</p>
      {/if}
    {:else}
      <p class="line"><b>{t("storage.noQuota")}</b></p>
      <p class="line muted">{t("storage.noQuotaNote")}</p>
    {/if}

    {#if level === 3}
      <div class="full">
        <p class="line">{t("storage.full")}</p>
        <div class="actions">
          <button class="btn" onclick={findLarge}><Search size={14} />{t("storage.findLarge")}</button>
          <button class="btn" onclick={openTrash}><Trash size={14} />{t("storage.openTrash")}</button>
        </div>
      </div>
    {/if}
  </div>
{/if}

<div class="block">
  <h4>{t("storage.warnings")}</h4>
  <label class="check"><input type="checkbox" bind:checked={form.quotaWarn} />{t("storage.warn")}</label>
  <div class="choices" class:off={!form.quotaWarn}>
    <label class="check">
      <input type="radio" name="quota-limit-{account.id}" checked={!ownMode} disabled={!form.quotaWarn} onchange={useQuota} />
      {quota ? t("storage.byQuota", { size: gb(quota.limit) }) : t("storage.byQuotaNone")}
    </label>
    <label class="check">
      <input type="radio" name="quota-limit-{account.id}" checked={ownMode} disabled={!form.quotaWarn} onchange={useOwn} />
      {t("storage.own")}
      <input
        class="input own"
        bind:this={ownInput}
        bind:value={form.quotaLimitGb}
        inputmode="decimal"
        placeholder="—"
        disabled={!form.quotaWarn}
        onfocus={() => (ownMode = true)}
        aria-label={t("storage.own")}
      />
      {t("storage.gb")}
    </label>
    <p class="hint muted">{t("storage.ownHint")} <button class="link" onclick={() => app.openSettings("storage")}>{t("storage.levelsLink")}</button></p>
  </div>
</div>

{#if !account.ews}
  <div class="block">
    <h4>{t("storage.folders")} <span class="tag">{t("storage.estimateBadge")}</span></h4>
    {#if info?.counting}
      <div class="row">
        <span>{t("storage.counting", { done: info.counting[0], total: info.counting[1] })}</span>
        <button class="btn" data-action="sizes-stop" onclick={() => rooms.stop(account.id)}>{t("storage.stop")}</button>
      </div>
      <p class="hint muted">{t("storage.countingNote")}</p>
    {:else if sizes}
      <table class="sizes">
        <tbody>
          {#each sizes.folders as f (f.folder)}
            <tr>
              <td class="fname">{folderName(f.folder)}</td>
              {#if f.bytes !== null}
                <td class="fbar"><span style:width="{(f.bytes / largest) * 100}%"></span></td>
                <td class="num">{gb(f.bytes)}</td>
                <td class="num muted">{tn("storage.letters", f.messages ?? 0)}</td>
              {:else}
                <td class="fbar"></td>
                <td class="num">—</td>
                <td class="num warn-text" title={f.error}>{t("storage.notCounted")}</td>
              {/if}
            </tr>
          {/each}
        </tbody>
        <tfoot>
          <tr>
            <td>{t("storage.total")}</td>
            <td></td>
            <td class="num"><b>≈ {gb(counted.reduce((n, f) => n + (f.bytes ?? 0), 0))}</b></td>
            <td></td>
          </tr>
        </tfoot>
      </table>
      <div class="row">
        <span class="muted small">{sizes.method === "status" ? t("storage.countedStatus", { when: when(sizes.counted) }) : t("storage.countedFetch", { when: when(sizes.counted) })}</span>
        <span class="spacer"></span>
        <button class="btn" onclick={findLarge}><Search size={14} />{t("storage.findLarge")}</button>
        <button class="btn" data-action="sizes-count" onclick={() => rooms.count(account.id)}>{t("storage.recount")}</button>
      </div>
    {:else}
      <div class="row">
        <button class="btn" data-action="sizes-count" onclick={() => rooms.count(account.id)}>{t("storage.count")}</button>
        <span class="muted small">{t("storage.onRequest")}</span>
      </div>
      <p class="hint muted">{t("storage.countNote")}</p>
    {/if}
  </div>
{/if}

<div class="block local">
  <h4><HardDrive size={14} />{t("storage.local")}</h4>
  <div class="row"><span>{t("storage.cache")}</span><b>{gb(info?.cache_bytes ?? 0)}</b></div>
  <p class="hint muted">{t("storage.cacheNote")} <button class="link" onclick={() => app.openSettings("storage")}>{t("storage.offlineLink")}</button></p>
</div>

<style>
  .room {
    display: flex;
    flex-direction: column;
    gap: 6px;
    --fill: var(--ok);
  }

  .room[data-level="1"],
  .room[data-level="2"] {
    --fill: var(--warn);
  }

  .room[data-level="3"] {
    --fill: var(--accent);
  }

  .figures {
    display: flex;
    align-items: baseline;
    gap: 10px;
  }

  .pct {
    margin-left: auto;
    color: var(--muted);
    font-size: 12.5px;
  }

  .room[data-level="1"] .pct,
  .room[data-level="2"] .pct {
    color: var(--warn);
  }

  .room[data-level="3"] .pct {
    color: var(--accent);
    font-weight: 600;
  }

  .tag {
    padding: 0 6px;
    border: 1px solid var(--line);
    border-radius: 4px;
    color: var(--muted);
    font-size: 11px;
    font-weight: 400;
  }

  .figures .tag {
    order: 3;
  }

  .bar {
    position: relative;
    height: 8px;
    border-radius: 4px;
    background: var(--paper-2);
    box-shadow: inset 0 0 0 1px var(--line);
  }

  .bar span {
    display: block;
    height: 100%;
    border-radius: 4px;
    background: var(--fill);
  }

  .bar.hatched span {
    background: repeating-linear-gradient(135deg, var(--fill) 0 4px, color-mix(in srgb, var(--fill) 55%, transparent) 4px 8px);
  }

  .stale .bar span {
    opacity: 0.55;
  }

  .own-mark {
    position: absolute;
    top: -3px;
    bottom: -3px;
    width: 2px;
    background: var(--ink);
  }

  .marks {
    position: relative;
    height: 16px;
    font-size: 11.5px;
  }

  .marks span {
    position: absolute;
    transform: translateX(-50%);
    white-space: nowrap;
  }

  .marks .end {
    right: 0;
    transform: none;
  }

  .line {
    margin: 0;
    font-size: 12.5px;
    line-height: 1.45;
  }

  .warn-text {
    color: var(--warn);
  }

  .full {
    margin-top: 6px;
    padding: 10px 12px;
    border-radius: 8px;
    background: color-mix(in srgb, var(--accent) 8%, transparent);
  }

  .actions,
  .row {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 8px;
    margin-top: 6px;
  }

  .btn {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 5px 10px;
    font-size: 12.5px;
  }

  .block h4 {
    display: flex;
    align-items: center;
    gap: 6px;
    margin: 6px 0 6px;
    font-size: 13px;
    font-weight: 600;
    color: var(--muted);
  }

  .check {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 4px 0;
  }

  .choices {
    padding-left: 24px;
  }

  .choices.off {
    color: var(--muted);
  }

  .own {
    width: 64px;
    padding: 3px 6px;
    text-align: right;
  }

  .hint {
    margin: 4px 0 0;
    font-size: 12px;
    line-height: 1.45;
  }

  .small {
    font-size: 12px;
  }

  .spacer {
    flex: 1;
  }

  .link {
    border: none;
    background: none;
    padding: 0;
    color: var(--link);
    font: inherit;
    text-decoration: underline;
  }

  .sizes {
    width: 100%;
    border-collapse: collapse;
    font-size: 12.5px;
  }

  .sizes td {
    padding: 4px 8px 4px 0;
  }

  .fname {
    max-width: 200px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .fbar {
    width: 40%;
  }

  .fbar span {
    display: block;
    height: 6px;
    border-radius: 3px;
    background: color-mix(in srgb, var(--ink) 35%, transparent);
  }

  .num {
    text-align: right;
    white-space: nowrap;
  }

  tfoot td {
    border-top: 1px solid var(--line);
    padding-top: 6px;
  }

  .local .row {
    justify-content: flex-start;
    gap: 12px;
  }
</style>

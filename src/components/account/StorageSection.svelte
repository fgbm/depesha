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
  import Select from "../Select.svelte";
  import SettingsRow from "../prefs/SettingsRow.svelte";
  import FieldError from "./FieldError.svelte";

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
  const level = $derived(levelOf(pct, levels(app.settingsCtl.settings.quota_levels)));
  const quota = $derived(info?.quota && info.quota.limit > 0 ? info.quota : null);
  const ownFirst = $derived(!!room && !!room.own && !!room.quota && room.own < room.quota);
  // Connecting is not offline: only a failed connection makes the numbers old.
  const offline = $derived(account.status?.state === "error" || account.status?.state === "paused");
  const largest = $derived(Math.max(1, ...counted.map((f) => f.bytes ?? 0)));
  let ownMode = $derived(!!form.quotaLimitGb.trim());
  let ownInput = $state<HTMLInputElement>();

  onMount(() => {
    // The numbers are read again while the section is open; the cache shows the last ones meanwhile.
    rooms.refresh(account.id);
  });

  function folderName(name: string): string {
    return app.mailboxes.folder(account.id, name)?.display_name ?? name;
  }

  /** The list of the limit: as in the settings (the server's quota), an own one, or no warnings for the mailbox. */
  const limitChoice = $derived(!form.quotaWarn ? "off" : ownMode ? "own" : "inherit");

  function pickLimit(v: string) {
    form.quotaWarn = v !== "off";
    if (v === "inherit") {
      ownMode = false;
      form.quotaLimitGb = "";
    } else if (v === "own") {
      ownMode = true;
      queueMicrotask(() => ownInput?.focus());
    }
  }

  // Both close the settings: unsaved changes on the page are asked about first.
  async function findLarge() {
    if (!(await form.mayLeave())) return;
    app.ui.settingsOpen = false;
    rooms.findLarge();
  }

  async function openTrash() {
    const trash = app.mailboxes.folders.find((f) => f.account_id === account.id && f.role === "trash");
    if (!trash || !(await form.mayLeave())) return;
    app.ui.settingsOpen = false;
    app.selection.setView({ kind: "folder", account_id: account.id, folder: trash.name });
  }
</script>

<!-- The room and the own limit are rows of the page, as on the general pages (0.8.12, screen 8). -->
{#if account.ews && !room}
  <SettingsRow id="acc-room" kind="field" label={t("storage.exchange")} />
{:else}
  <div class="room" data-level={level} class:estimate={room?.estimate} class:stale={offline}>
    {#if room && room.exchange}
      <SettingsRow
        id="acc-room"
        kind="field"
        label="≈ {t('storage.usedAlone', { used: gb(room.used) })}"
        desc={room.limit > 0 ? `${t("storage.ofOwn", { p: wholePercent(pct) })} · ${t("storage.estimateBadge")}` : t("storage.estimateBadge")}
        hint={t("storage.exchangeNote", { when: when(room.at) })}
      >
        {#if room.limit > 0}<div class="bar hatched"><span style:width="{Math.min(100, pct)}%"></span></div>{/if}
        <button class="link" onclick={() => rooms.refresh(account.id)}>{t("storage.refresh")}</button>
      </SettingsRow>
    {:else if room && !room.estimate}
      {@const u = usedOf(room.used, room.limit)}
      <SettingsRow
        id="acc-room"
        kind="field"
        label={ownFirst ? t("storage.usedAlone", { used: gb(room.used) }) : t("storage.used", { used: `${u.used}`, limit: u.limit })}
        desc={ownFirst && room.quota
          ? `${t("storage.ofOwn", { p: wholePercent(pct) })} · ${t("storage.ofQuota", { p: wholePercent((room.used / room.quota) * 100) })}`
          : quota
            ? t("storage.quotaLine", { p: wholePercent(pct), when: when(quota.checked) })
            : `${wholePercent(pct)}%`}
        hint={ownFirst && room.own ? t("storage.ownNote", { size: gb(room.own) }) : quota?.root ? t("storage.root", { root: quota.root }) : null}
        warn={offline && quota ? t("storage.offline", { when: when(quota.checked) }) : null}
      >
        <div class="meter">
          <div class="bar" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(pct)} aria-label={t("account.section.storage")}>
            <span style:width="{Math.min(100, ownFirst && room.quota ? (room.used / room.quota) * 100 : pct)}%"></span>
            {#if ownFirst && room.own && room.quota}<i class="own-mark" style:left="{(room.own / room.quota) * 100}%"></i>{/if}
          </div>
          {#if ownFirst && room.own && room.quota}
            <div class="marks muted"><span style:left="{(room.own / room.quota) * 100}%">{t("storage.ownMark", { size: gb(room.own) })}</span><span class="end">{t("storage.quotaMark", { size: gb(room.quota) })}</span></div>
          {/if}
        </div>
        {#if offline && quota}<button class="link" onclick={() => rooms.refresh(account.id)}>{t("storage.refresh")}</button>{/if}
      </SettingsRow>
    {:else if room}
      {@const u = usedOf(room.used, room.limit)}
      <SettingsRow
        id="acc-room"
        kind="field"
        label="≈ {t('storage.used', { used: u.used, limit: u.limit })}"
        desc="{t('storage.ofOwn', { p: wholePercent(pct) })} · {t('storage.estimateBadge')}"
        hint={t("storage.estimateNote", { when: when(room.at) })}
        warn={room.partial ? t("storage.partial", { done: counted.length, total: counted.length + failed.length, names: failed.map((f) => `«${folderName(f.folder)}»`).join(", ") }) : null}
      >
        <div class="meter"><div class="bar hatched"><span style:width="{Math.min(100, pct)}%"></span></div></div>
      </SettingsRow>
    {:else}
      <SettingsRow id="acc-room" kind="field" label={t("storage.noQuota")} hint={t("storage.noQuotaNote")} />
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

<SettingsRow id="acc-limit" kind="field" label={t("storage.own")} error={form.limitError || null}>
  <Select
    class="quota-limit"
    label={t("storage.own")}
    bind:value={() => limitChoice, pickLimit}
    options={[
      { value: "inherit", label: t("storage.limitInherit") },
      { value: "own", label: t("storage.limitOwn") },
      { value: "off", label: t("storage.limitOff") },
    ]}
  />
  {#if limitChoice === "own"}
    <input
      class="input own"
      class:bad={!!form.limitError}
      aria-invalid={!!form.limitError}
      bind:this={ownInput}
      bind:value={form.quotaLimitGb}
      inputmode="decimal"
      placeholder="—"
      aria-label={t("storage.own")}
      onkeydown={(e) => {
        // Esc puts the last good limit back and keeps the window.
        if (e.key !== "Escape" || !form.limitError) return;
        e.preventDefault();
        e.stopPropagation();
        form.revertLimit();
      }}
    />
    {t("storage.gb")}
  {/if}
</SettingsRow>
<FieldError {form} keys={["quota_warn", "quota_limit_mb"]} />

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
  <p class="hint muted">{t("storage.cacheNote")} <button class="link" onclick={() => app.ui.openSettings("storage")}>{t("storage.offlineLink")}</button></p>
</div>

<style>
  .own.bad {
    border-color: var(--warn);
    box-shadow: 0 0 0 2px color-mix(in srgb, var(--warn) 25%, transparent);
  }

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
    --fill: var(--bad);
  }

  .tag {
    padding: 0 6px;
    border: 1px solid var(--line);
    border-radius: 4px;
    color: var(--muted);
    font-size: 11px;
    font-weight: 400;
  }

  /* The bar keeps to the column of the controls, as in the mockup. */
  .meter {
    width: 180px;
    max-width: 100%;
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
    background: color-mix(in srgb, var(--bad) 8%, transparent);
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

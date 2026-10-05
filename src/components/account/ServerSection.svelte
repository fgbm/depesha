<script lang="ts">
  // What the IMAP server can do and what Depesha does with it, from what the cache kept at
  // the last login: it reads the same without a network. Missing features say what the
  // user loses; the raw answers are folded below, to be copied into a bug report.
  import RotateCw from "@lucide/svelte/icons/rotate-cw";
  import Copy from "@lucide/svelte/icons/copy";
  import ChevronRight from "@lucide/svelte/icons/chevron-right";
  import { t } from "../../lib/i18n.svelte";
  import { when } from "../../lib/later";
  import { rooms } from "../../lib/room.svelte";
  import { securityLabel } from "../../lib/connection";
  import { features, grouped, protocol, report, summary, unknown, type ServerMark, type UseMark } from "../../lib/serverFeatures";
  import type { SectionProps } from "./sections";

  let { account }: SectionProps = $props();

  const info = $derived(rooms.infos[account.id]);
  const caps = $derived(info?.caps?.capabilities ?? []);
  const enable = $derived(info?.enable ?? null);
  const rows = $derived(info ? features(caps, enable, info.poll_secs, (at) => when(at)) : []);
  const groups = $derived(grouped(rows));
  // Connecting is not offline: only a failed connection makes the numbers old.
  const offline = $derived(account.status?.state === "error" || account.status?.state === "paused");
  const where = $derived(
    t("server.where", {
      host: account.imap.host,
      port: account.imap.port,
      security: securityLabel(account.imap.security),
      protocol: protocol(caps),
      login: account.username,
    }),
  );
  let copied = $state(false);

  const GOOD: ServerMark[] = ["yes", "base", "enabled"];
  const USED: UseMark[] = ["used", "notNeeded"];

  async function copy() {
    await navigator.clipboard.writeText(report(where, info?.caps?.greeting ?? "", caps, enable));
    copied = true;
    setTimeout(() => (copied = false), 2000);
  }
</script>

<div class="head">
  <div class="where">
    <div class="mono">{where}</div>
    {#if info?.caps}
      {#if offline}
        <div class="when warn-text">{t("server.offline", { when: when(info.caps.detected) })}</div>
      {:else}
        <div class="when muted">{t("server.detected", { when: when(info.caps.detected) })}</div>
      {/if}
    {/if}
  </div>
  <button class="btn" data-action="server-check" onclick={() => rooms.check(account.id)} disabled={rooms.checking[account.id]}>
    <RotateCw size={14} />{rooms.checking[account.id] ? t("server.checking") : t("server.checkAgain")}
  </button>
</div>

{#if !info?.caps}
  <p class="muted note">{t("server.never")}</p>
{:else}
  <p class="summary">{summary(rows, info.poll_secs)}</p>

  <table class="features">
    <thead>
      <tr>
        <th>{t("server.col.feature")}</th>
        <th>{t("server.col.gives")}</th>
        <th>{t("server.col.server")}</th>
        <th>{t("server.col.depesha")}</th>
      </tr>
    </thead>
    {#each groups as g (g.group)}
      <tbody data-group={g.group}>
        <tr class="group"><th colspan="4">{t(`server.group.${g.group}`)}</th></tr>
        {#each g.rows as r (r.id)}
          <tr data-feature={r.id}>
            <td class="name"><b>{r.title}</b><code>{r.names}</code></td>
            <td class="gives">
              {r.gives}
              {#if r.without}<div class="without" class:important={r.important || r.group === "refused"}>{r.without}</div>{/if}
            </td>
            <td class="mark">
              <span class="dot" class:good={GOOD.includes(r.server)} class:bad={r.server === "refused"}></span>{t(`server.mark.${r.server}`)}
              {#if r.serverNote}<small>{r.serverNote}</small>{/if}
            </td>
            <td class="mark use" class:good={r.depesha === "used"}>
              <span class="dot" class:good={USED.includes(r.depesha)} class:hollow={!USED.includes(r.depesha)}></span>{t(`server.use.${r.depesha}`)}
            </td>
          </tr>
        {/each}
      </tbody>
    {/each}
  </table>

  <details class="tech">
    <summary>
      <ChevronRight size={14} class="chevron" />{t("server.details")}
      <span class="spacer"></span>
      <button class="link-btn" onclick={(e) => (e.preventDefault(), copy())}><Copy size={13} />{copied ? t("server.copied") : t("server.copy")}</button>
    </summary>
    <p class="muted note">{t("server.detailsNote")}</p>
    {#if info.caps.greeting}
      <div class="label">{t("server.beforeLogin")}</div>
      <pre>{info.caps.greeting}</pre>
    {/if}
    <div class="label">{t("server.afterLogin")}</div>
    <pre>* CAPABILITY {caps.join(" ")}</pre>
    <div class="label">{t("server.syncSession")}</div>
    {#if enable}
      <pre>C: ENABLE QRESYNC{"\n"}S: {enable.ok ? `* ${enable.answer}` : `NO ${enable.answer}`}</pre>
    {:else}
      <p class="muted note">{t("server.noEnable")}</p>
    {/if}
    {#if unknown(caps).length}
      <div class="label">{t("server.unknown")}</div>
      <pre>{unknown(caps).join(" ")}</pre>
    {/if}
  </details>
{/if}

<style>
  .head {
    display: flex;
    align-items: flex-start;
    gap: 12px;
  }

  .where {
    flex: 1;
    min-width: 0;
    line-height: 1.45;
  }

  .mono {
    font-family: var(--mono);
    font-size: 12.5px;
    overflow-wrap: anywhere;
  }

  .when {
    font-size: 12px;
  }

  .warn-text {
    color: var(--warn);
  }

  .head .btn {
    flex: none;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 5px 10px;
    font-size: 12.5px;
  }

  .note {
    margin: 0;
    font-size: 12.5px;
    line-height: 1.45;
  }

  .summary {
    margin: 0;
    line-height: 1.45;
  }

  .features {
    width: 100%;
    border-collapse: collapse;
    font-size: 12.5px;
    line-height: 1.4;
  }

  thead th {
    padding: 6px 8px 6px 0;
    border-bottom: 1px solid var(--line);
    color: var(--muted);
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    text-align: left;
  }

  .group th {
    padding: 12px 0 4px;
    color: var(--muted);
    font-weight: 600;
    text-align: left;
  }

  td {
    padding: 8px 8px 8px 0;
    border-bottom: 1px solid var(--line);
    vertical-align: top;
  }

  tbody tr:last-child td {
    border-bottom: none;
  }

  .name {
    width: 26%;
  }

  .name b {
    display: block;
    font-weight: 600;
  }

  code {
    font-family: var(--mono);
    font-size: 11px;
    color: var(--muted);
    overflow-wrap: anywhere;
  }

  .without {
    margin-top: 4px;
    color: var(--muted);
  }

  .without.important {
    color: var(--warn);
  }

  .mark {
    width: 17%;
    white-space: nowrap;
  }

  .mark small {
    display: block;
    color: var(--muted);
    font-size: 11px;
    white-space: normal;
  }

  .use.good {
    color: var(--ok);
    font-weight: 600;
  }

  .dot {
    display: inline-block;
    width: 6px;
    height: 6px;
    margin-right: 6px;
    border-radius: 50%;
    background: var(--muted);
    vertical-align: middle;
  }

  .dot.good {
    background: var(--ok);
  }

  .dot.bad {
    background: var(--warn);
  }

  .dot.hollow {
    background: none;
    box-shadow: inset 0 0 0 1.5px var(--muted);
  }

  .tech {
    border: 1px solid var(--line);
    border-radius: 8px;
    padding: 0 12px;
  }

  .tech summary {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 9px 0;
    color: var(--muted);
    cursor: pointer;
    list-style: none;
  }

  .tech summary::-webkit-details-marker {
    display: none;
  }

  .tech :global(.chevron) {
    transition: transform 0.15s;
  }

  .tech[open] :global(.chevron) {
    transform: rotate(90deg);
  }

  .spacer {
    flex: 1;
  }

  .link-btn {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    border: none;
    background: none;
    color: var(--muted);
    font: inherit;
    font-size: 12px;
    padding: 2px 4px;
  }

  .link-btn:hover {
    color: var(--ink);
  }

  .label {
    margin: 10px 0 4px;
    color: var(--muted);
    font-size: 12px;
  }

  pre {
    margin: 0;
    padding: 8px 10px;
    border-radius: 6px;
    background: var(--paper-2);
    font-family: var(--mono);
    font-size: 11.5px;
    line-height: 1.5;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }

  .tech > :last-child {
    margin-bottom: 12px;
  }

  @media (max-width: 640px) {
    .features thead {
      display: none;
    }

    .features tr:not(.group) {
      display: grid;
      grid-template-columns: 1fr 1fr;
      border-bottom: 1px solid var(--line);
    }

    .features td {
      border: none;
      width: auto;
    }

    .features td.name,
    .features td.gives {
      grid-column: 1 / -1;
    }
  }
</style>

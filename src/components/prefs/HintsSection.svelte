<script lang="ts">
  // The section «Hints» of the page «General» (#69, frame 17А): what the app offered, what
  // was answered, and the one switch that turns every suggestion off. The list is the
  // decisions the backend keeps; «Ask them again» forgets them all.
  import { t } from "../../lib/i18n.svelte";
  import { app } from "../../lib/store.svelte";
  import { api } from "../../lib/api";
  import { hints as runtime } from "../../lib/hints.svelte";
  import type { Settings } from "../../lib/types";
  import type { HintState } from "../../lib/hints";

  let { draft }: { draft: Settings } = $props();

  let states = $state<HintState[]>([]);

  async function load() {
    try {
      states = await api.hints();
    } catch (e) {
      app.fail(e);
    }
  }

  load();

  async function clear() {
    try {
      await api.hintsClear();
      states = [];
      await runtime.refresh();
      app.toast(t("hints.forgotten"));
    } catch (e) {
      app.fail(e);
    }
  }
</script>

<p class="hint top">{t("hints.note")}</p>
<label class="option">
  <input type="checkbox" bind:checked={draft.hints} />
  <span class="text">{t("hints.enable")}</span>
</label>

{#if states.length}
  <div class="list">
    <div class="row head">
      <span>{t("hints.what")}</span>
      <span>{t("hints.who")}</span>
      <span>{t("hints.answer")}</span>
    </div>
    {#each states as s (s.id + "\u0000" + s.subject)}
      <div class="row">
        <span>{t(`hints.name.${s.id}` as "hints.name.send-format")}</span>
        <span class="muted">{s.subject || t("hints.anyone")}</span>
        <span class="state">{t(`hints.state.${s.decision}` as "hints.state.accepted")}</span>
      </div>
    {/each}
  </div>
  <button class="btn ghost small" onclick={clear}>{t("hints.forget")}</button>
{:else}
  <p class="muted small">{t("hints.none")}</p>
{/if}

<style>
  .top {
    margin-top: 0;
  }

  .option {
    display: flex;
    align-items: flex-start;
    gap: 10px;
    padding: 5px 0;
    cursor: pointer;
  }

  .option input {
    margin-top: 2px;
  }

  .hint {
    font-size: 12px;
    color: var(--muted);
    line-height: 1.45;
    margin: 0 0 8px;
  }

  .small {
    font-size: 12px;
  }

  .list {
    margin: 6px 0 10px;
  }

  .row {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) auto;
    gap: 12px;
    padding: 5px 0;
    border-bottom: 1px solid var(--line);
  }

  .row.head {
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--muted);
  }

  .state {
    white-space: nowrap;
    color: var(--muted);
  }
</style>

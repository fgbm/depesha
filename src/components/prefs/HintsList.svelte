<script lang="ts">
  // The decisions about the hints (#69, #102): what the app offered and what was answered.
  // The switches are rows of the page «Look and language»; this is the list under them, and
  // «Ask them again» forgets every decision.
  import { t } from "../../lib/i18n.svelte";
  import { app } from "../../lib/store.svelte";
  import { api } from "../../lib/api";
  import { hints as runtime } from "../../lib/hints.svelte";
  import type { HintState } from "../../lib/hints";

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
  .small {
    margin: 0;
    font-size: 12px;
  }

  .list {
    margin: 0 0 10px;
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

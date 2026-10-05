<script lang="ts">
  import { t, tn } from "../../lib/i18n.svelte";
  import Select from "../Select.svelte";
  import FolderPicker from "../FolderPicker.svelte";
  import type { Settings } from "../../lib/types";

  // The mail's own settings: «Mail» (list, new messages, reading, attachments,
  // sending) and «Notifications» with the quota warnings.
  let { current, draft }: { current: string; draft: Settings } = $props();

  /** A radio choice of the snippet below: the field and the value are its own. */
  function choose(group: "notify" | "letter_view", value: string) {
    // The snippet offers only the values each field takes.
    (draft as unknown as Record<string, string>)[group] = value;
  }
</script>

{#snippet option(group: "notify" | "letter_view", value: string, label: string, note?: string)}
  <label class="option">
    <input type="radio" name={group} {value} checked={draft[group] === value} onchange={() => choose(group, value)} />
    <span class="text">{label}{#if note}<span class="note">{note}</span>{/if}</span>
  </label>
{/snippet}

{#if current === "mail"}
  <section>
    <h4>{t("settings.list")}</h4>
    <label class="option">
      <input type="checkbox" bind:checked={draft.threads} />
      <span class="text">{t("settings.threads")}</span>
    </label>
    <label class="option">
      <input type="checkbox" bind:checked={draft.sender_logos} />
      <span class="text">{t("settings.senderLogos")}<span class="note">{t("settings.senderLogosNote")}</span></span>
    </label>
  </section>
  <section>
    <h4>{t("settings.newMessages")}</h4>
    <div class="inline">
      <span>{t("settings.composeFormat")}</span>
      <Select
        class="compose-format"
        label={t("settings.composeFormat")}
        bind:value={draft.compose_format}
        options={(["plain", "html", "markdown"] as const).map((f) => ({ value: f, label: t(`format.${f}`) }))}
      />
    </div>
    <p class="hint">{t("settings.composeFormatNote")}</p>
  </section>
  <section>
    <h4>{t("settings.reading")}</h4>
    <div class="caption" id="letter-view">{t("settings.letterView")}</div>
    <div role="radiogroup" aria-labelledby="letter-view">
      {@render option("letter_view", "sender", t("settings.letterView.sender"), t("settings.letterView.senderNote"))}
      {@render option("letter_view", "markdown", t("settings.letterView.markdown"), t("settings.letterView.markdownNote"))}
      {@render option("letter_view", "text", t("settings.letterView.text"), t("settings.letterView.textNote"))}
    </div>
    <p class="hint">{t("settings.letterView.hint")}</p>
  </section>
  <section>
    <h4>{t("settings.attachmentsDir")}</h4>
    <FolderPicker bind:value={() => draft.attachments_dir ?? "", (v) => (draft.attachments_dir = v)} label={t("settings.attachmentsDir")} placeholder={t("settings.askEveryTime")} />
    <p class="hint">{t("settings.attachmentsDirNote")}</p>
  </section>
  <section>
    <h4>{t("settings.sending")}</h4>
    <div class="inline">
      <span>{t("settings.undoSend")}</span>
      <Select
        label={t("settings.undoSend")}
        bind:value={draft.undo_send_secs}
        options={[{ value: 0, label: t("settings.noWait") }, ...[5, 10, 20, 30].map((secs) => ({ value: secs, label: tn("settings.seconds", secs) }))]}
      />
    </div>
  </section>
{:else if current === "notifications"}
  <section>
    {@render option("notify", "people", t("settings.notifyPeople"), t("settings.notifyPeopleNote"))}
    {@render option("notify", "all", t("settings.notifyAll"))}
    {@render option("notify", "none", t("settings.notifyNone"))}
    <p class="hint">{t("settings.dndNote")}</p>
  </section>
  <section data-settings="quota">
    <h4>{t("settings.quota")}</h4>
    <label class="option">
      <input type="checkbox" bind:checked={draft.quota_warn} />
      <span class="text">{t("settings.quotaWarn")}</span>
    </label>
    <div class="inline levels" class:disabled={!draft.quota_warn}>
      <span>{t("settings.quotaLevels")}</span>
      {#each [0, 1] as i (i)}
        <input class="input pct" type="number" min="1" max="99" bind:value={draft.quota_levels[i]} disabled={!draft.quota_warn} aria-label="{t('settings.quotaLevels')} {i + 1}" />
        <span>%</span>
      {/each}
      <span>{t("settings.quotaFull")}</span>
    </div>
    <div class="inline" class:disabled={!draft.quota_warn}>
      <span>{t("settings.quotaRepeat")}</span>
      <Select
        label={t("settings.quotaRepeat")}
        bind:value={draft.quota_repeat}
        options={[
          { value: "threshold", label: t("settings.quotaRepeatThreshold") },
          { value: "daily", label: t("settings.quotaRepeatDaily") },
        ]}
      />
    </div>
    <p class="hint">{t("settings.quotaNote")}</p>
  </section>
{/if}

<style>
  section {
    padding: 14px 0;
    border-bottom: 1px solid var(--line);
  }

  section:last-child {
    border-bottom: none;
  }

  h4 {
    margin: 0 0 10px;
    font-size: 13px;
    font-weight: 600;
    color: var(--muted);
  }

  /* The name of a group of choices under its section's heading. */
  .caption {
    margin-bottom: 2px;
  }

  /* A choice: the control, then its name with an explanation under it. */
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

  .text {
    display: flex;
    flex-direction: column;
    gap: 2px;
    line-height: 1.4;
  }

  .note,
  .hint {
    font-size: 12px;
    color: var(--muted);
    line-height: 1.45;
  }

  .hint {
    margin: 8px 0 0;
  }

  .inline {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 4px 0;
  }

  .inline.disabled {
    color: var(--muted);
  }

  .pct {
    width: 56px;
    padding: 4px 6px;
    text-align: right;
  }
</style>

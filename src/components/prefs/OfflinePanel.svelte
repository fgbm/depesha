<script lang="ts">
  import { t, tn } from "../../lib/i18n.svelte";
  import Select from "../Select.svelte";
  import type { Settings } from "../../lib/types";

  /** The «Offline» page: how much mail is kept on the machine. */
  let { draft }: { draft: Settings } = $props();
</script>

<section>
  <div class="inline">
    <span>{t("settings.offlineKeep")}</span>
    <Select
      label={t("settings.offlineKeep")}
      bind:value={draft.offline}
      options={[
        { value: "off", label: t("settings.offlineOff") },
        { value: "30", label: tn("settings.offlineDays", 30) },
        { value: "90", label: tn("settings.offlineDays", 90) },
        { value: "365", label: t("settings.offlineYear") },
        { value: "all", label: t("settings.offlineAll") },
      ]}
    />
  </div>
  <label class="option" class:disabled={draft.offline === "off"}>
    <input type="checkbox" bind:checked={draft.offline_attachments} disabled={draft.offline === "off"} />
    <span class="text">{t("settings.offlineAttachments")}</span>
  </label>
  <p class="hint">{t("settings.offlineNote")}</p>
</section>

<style>
  section {
    padding: 14px 0;
    border-bottom: 1px solid var(--line);
  }

  section:last-child {
    border-bottom: none;
  }

  .inline {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 4px 0;
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

  .option.disabled {
    cursor: default;
    color: var(--muted);
  }

  .text {
    display: flex;
    flex-direction: column;
    gap: 2px;
    line-height: 1.4;
  }

  .hint {
    margin: 8px 0 0;
    font-size: 12px;
    color: var(--muted);
    line-height: 1.45;
  }
</style>

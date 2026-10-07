<script lang="ts">
  // "After an answer" (#59): an answer to a letter of the inbox takes it, with its
  // conversation, to a folder on the server until the reply brings it back. The folder is
  // made at the first answer unless one is chosen; "Stop waiting" takes it back or to the archive.
  import Select from "../Select.svelte";
  import { app } from "../../lib/store.svelte";
  import { t } from "../../lib/i18n.svelte";
  import type { Waiting } from "../../lib/types";

  let { waiting = $bindable(), accountId }: { waiting: Waiting; accountId: string } = $props();

  /** Folders of the mailbox a letter can wait in: not the ones with a role of their own. */
  const folders = $derived(
    app.folders
      .filter((f) => f.account_id === accountId && f.selectable && !f.role)
      .map((f) => ({ value: f.name, label: f.display_name })),
  );
  const options = $derived([{ value: "", label: t("account.waiting.folderNew") }, ...folders]);
</script>

<section class="waiting">
  <h4>{t("account.waiting.title")}</h4>
  <label class="check">
    <input type="checkbox" bind:checked={waiting.park} />
    <span>{t("account.waiting.park")}<span class="hint">{t("account.waiting.hint")}</span></span>
  </label>
  {#if waiting.park}
    <div class="row">
      <span class="k">{t("account.waiting.folder")}</span>
      <Select class="waiting-folder" bind:value={waiting.folder} label={t("account.waiting.folder")} {options} />
    </div>
    <div class="row">
      <span class="k">{t("account.waiting.stop")}</span>
      <Select
        bind:value={() => (waiting.stop_to_archive ? "archive" : "inbox"), (v) => (waiting.stop_to_archive = v === "archive")}
        label={t("account.waiting.stop")}
        options={[
          { value: "inbox", label: t("account.waiting.stopInbox") },
          { value: "archive", label: t("account.waiting.stopArchive") },
        ]}
      />
    </div>
  {/if}
</section>

<style>
  h4 {
    margin: 0 0 6px;
    font-size: 13px;
    font-weight: 650;
  }

  .check {
    display: flex;
    align-items: flex-start;
    gap: 8px;
  }

  .check input {
    margin-top: 3px;
  }

  .hint {
    display: block;
    font-size: 12px;
    color: var(--muted);
    line-height: 1.45;
    margin-top: 2px;
  }

  .row {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 8px;
    margin: 8px 0 0 23px;
  }

  .k {
    font-size: 12px;
    color: var(--muted);
  }
</style>

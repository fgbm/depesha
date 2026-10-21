<script lang="ts">
  // "After an answer" (#59): an answer to a letter of the inbox takes it, with its
  // conversation, to a folder on the server until the reply brings it back. The folder is
  // made at the first answer unless one is chosen; "Stop waiting" takes it back or to the archive.
  import Select from "../Select.svelte";
  import SettingsRow from "../prefs/SettingsRow.svelte";
  import Switch from "../prefs/controls/Switch.svelte";
  import { app } from "../../lib/store.svelte";
  import { t } from "../../lib/i18n.svelte";
  import type { Waiting } from "../../lib/types";

  let { waiting = $bindable(), accountId }: { waiting: Waiting; accountId: string } = $props();

  /** Folders of the mailbox a letter can wait in: not the ones with a role of their own. */
  const folders = $derived(
    app.mailboxes.folders
      .filter((f) => f.account_id === accountId && f.selectable && !f.role)
      .map((f) => ({ value: f.name, label: f.display_name })),
  );
  const options = $derived([{ value: "", label: t("account.waiting.folderNew") }, ...folders]);
</script>

<SettingsRow id="acc-waiting" kind="toggle" label={t("account.waiting.park")}>
  <Switch checked={waiting.park} label={t("account.waiting.park")} onchange={(on) => (waiting.park = on)} />
</SettingsRow>
{#if waiting.park}
  <div class="depg">
    <SettingsRow id="acc-waiting-folder" kind="field" label={t("account.waiting.folder")} dep>
      <Select class="waiting-folder" bind:value={waiting.folder} label={t("account.waiting.folder")} {options} />
    </SettingsRow>
    <SettingsRow id="acc-waiting-stop" kind="field" label={t("account.waiting.stop")} dep>
      <Select
        bind:value={() => (waiting.stop_to_archive ? "archive" : "inbox"), (v) => (waiting.stop_to_archive = v === "archive")}
        label={t("account.waiting.stop")}
        options={[
          { value: "inbox", label: t("account.waiting.stopInbox") },
          { value: "archive", label: t("account.waiting.stopArchive") },
        ]}
      />
    </SettingsRow>
  </div>
{/if}

<style>
  /* The strip of the rows under the switch, as on the general pages. */
  .depg {
    margin-left: 4px;
    border-left: 2px solid var(--line);
  }
</style>

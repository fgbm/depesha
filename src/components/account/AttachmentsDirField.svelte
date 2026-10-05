<script lang="ts">
  import FolderPicker from "../FolderPicker.svelte";
  import { app } from "../../lib/store.svelte";
  import { t } from "../../lib/i18n.svelte";

  let { value = $bindable("") }: { value: string } = $props();
</script>

<div class="field"><span>{t("wizard.attachmentsDir")}</span>
  <!-- The settings' folder is a hint, not the value: what is inherited stays visible as such. -->
  <FolderPicker bind:value label={t("wizard.attachmentsDir")} placeholder={app.settings.attachments_dir || t("settings.askEveryTime")} />
  <p class="muted small">{t("wizard.attachmentsDirInherit", { dir: app.settings.attachments_dir ? `: ${app.settings.attachments_dir}` : "" })}</p>
</div>

<style>
  p {
    margin: 0;
  }

  .small {
    font-size: 12px;
  }
</style>

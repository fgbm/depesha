<script lang="ts">
  import FolderPicker from "../FolderPicker.svelte";
  import { app } from "../../lib/store.svelte";
  import { t } from "../../lib/i18n.svelte";

  let { value = $bindable("") }: { value: string } = $props();
</script>

<div class="field"><span>{t("wizard.attachmentsDir")}</span>
  <!-- The settings' folder is what an empty value means: it shows as the placeholder, the cross beside it goes back to it (#102, 3.1 В). -->
  <FolderPicker bind:value label={t("wizard.attachmentsDir")} placeholder={app.settings.attachments_dir || t("settings.askEveryTime")} />
</div>

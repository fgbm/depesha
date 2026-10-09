<script lang="ts">
  import FolderPicker from "../FolderPicker.svelte";
  import LayerMark from "../prefs/LayerMark.svelte";
  import { app } from "../../lib/store.svelte";
  import { t } from "../../lib/i18n.svelte";

  let { value = $bindable("") }: { value: string } = $props();
</script>

<div class="field"><span>{t("wizard.attachmentsDir")}</span>
  <!-- The settings' folder is what an empty value means: it shows as the placeholder, and the mark says so (#102, 3.1 В). -->
  <div class="withmark">
    <FolderPicker bind:value label={t("wizard.attachmentsDir")} placeholder={app.settings.attachments_dir || t("settings.askEveryTime")} />
    <LayerMark own={!!value} word={t("settings.layerAsGeneral")} onreset={() => (value = "")} />
  </div>
</div>

<style>
  .withmark {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .withmark > :global(.folder) {
    flex: 1;
    min-width: 0;
  }
</style>

<script lang="ts">
  // The mailbox's own folder of attachments, or the one from the settings: a list like the format's,
  // its first item saying what it means now (0.8.12, screen 8). A folder is not typed: the last item
  // opens the system dialog, the backend saves files only into a folder the user picked there.
  import Select from "../Select.svelte";
  import { api } from "../../lib/api";
  import { app } from "../../lib/store.svelte";
  import { t } from "../../lib/i18n.svelte";

  let { value = $bindable("") }: { value: string } = $props();

  /** The item that opens the dialog: no path is ever this. */
  const PICK = "\u0000pick";

  const options = $derived([
    { value: "", label: t("account.attachmentsInherit", { dir: app.settingsCtl.settings.attachments_dir || t("settings.askEveryTime") }) },
    ...(value ? [{ value, label: value }] : []),
    { value: PICK, label: t("account.attachmentsPick") },
  ]);

  async function pick(v: string) {
    if (v !== PICK) {
      value = v;
      return;
    }
    try {
      const dir = await api.pickFolder("save", t("wizard.attachmentsDir"), value || null);
      if (dir) value = dir;
    } catch (e) {
      app.ui.fail(e);
    }
  }
</script>

<!-- The dialog's item is never the value: the list goes on saying the folder in use. -->
<Select class="attachments-dir" label={t("wizard.attachmentsDir")} bind:value={() => value, pick} {options} />

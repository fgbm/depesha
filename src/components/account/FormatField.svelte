<script lang="ts">
  // The mailbox's own format of new letters and replies, or the one from the settings,
  // shown in brackets for what it means now.
  import Select from "../Select.svelte";
  import { app } from "../../lib/store.svelte";
  import { t } from "../../lib/i18n.svelte";
  import type { BodyFormat } from "../../lib/types";

  let { value = $bindable("") }: { value: BodyFormat | "" } = $props();
</script>

<div class="field"><span>{t("wizard.composeFormat")}</span>
  <Select
    class="compose-format"
    label={t("wizard.composeFormat")}
    bind:value
    options={[
      { value: "" as const, label: t("wizard.composeFormatInherit", { format: t(`format.${app.settings.compose_format ?? "plain"}`) }) },
      ...(["plain", "html", "markdown"] as const).map((f) => ({ value: f, label: t(`format.${f}`) })),
    ]}
  />
</div>

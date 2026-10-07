<script lang="ts">
  // The mailbox's own form of its letters, or the one from the settings, shown in brackets
  // for what it means now (#44, frame 15). Overridden by a person's own rule (#66).
  import Select from "../Select.svelte";
  import { app } from "../../lib/store.svelte";
  import { t } from "../../lib/i18n.svelte";
  import type { ViewRule } from "../../lib/types";

  let { value = $bindable("") }: { value: ViewRule } = $props();

  /** What «as in the settings» means now, named as the settings page itself names it. */
  const inherited = $derived(app.settings.letter_view === "sender" ? t("settings.letterView.sender") : t(`letterView.${app.settings.letter_view}`));
</script>

<div class="field"><span>{t("settings.letterView")}</span>
  <Select
    class="letter-view"
    label={t("settings.letterView")}
    bind:value
    options={[
      { value: "" as const, label: t("settings.letterViewInherit", { view: inherited }) },
      ...(["html", "markdown", "text"] as const).map((v) => ({ value: v, label: t(`letterView.${v}`) })),
    ]}
  />
</div>

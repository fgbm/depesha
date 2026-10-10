<script lang="ts">
  // The «do not disturb» button of the sidebar's footer, with its menu of durations.
  // Shown in both the full sidebar and the strip; open state is sidebarUi's.
  import Bell from "@lucide/svelte/icons/bell";
  import BellOff from "@lucide/svelte/icons/bell-off";
  import { app } from "../../lib/store.svelte";
  import { t } from "../../lib/i18n.svelte";
  import { when } from "../../lib/later";
  import Popover from "../Popover.svelte";
  import { sidebarUi } from "./sidebar.svelte";

  let { align = "left" }: { align?: "left" | "right" } = $props();

  function setDnd(until: number) {
    sidebarUi.dndMenu = false;
    app.settingsCtl.patchSettings({ dnd_until: until });
  }

  function dndOptions(): { label: string; until: number }[] {
    const now = Date.now() / 1000;
    const morning = new Date();
    morning.setDate(morning.getDate() + (morning.getHours() >= 9 ? 1 : 0));
    morning.setHours(9, 0, 0, 0);
    return [
      { label: t("dnd.hour"), until: Math.floor(now + 3600) },
      { label: t("dnd.morning"), until: Math.floor(morning.getTime() / 1000) },
      { label: t("dnd.forever"), until: 4_102_444_800 },
    ];
  }
</script>

<div class="dnd-wrap">
  <button
    class="foot-btn"
    class:on={sidebarUi.dnd}
    onclick={() => (sidebarUi.dnd ? setDnd(0) : (sidebarUi.dndMenu = !sidebarUi.dndMenu))}
    title={sidebarUi.dnd ? t("dnd.until", { when: when(app.settingsCtl.settings.dnd_until) }) : t("dnd.title")}
    aria-label={t("dnd.title")}
  >
    {#if sidebarUi.dnd}<BellOff size={16} />{:else}<Bell size={16} />{/if}
  </button>
  <Popover bind:open={sidebarUi.dndMenu} {align}>
    <div class="mt">{t("dnd.title")}</div>
    {#each dndOptions() as o (o.label)}<button class="mi" onclick={() => setDnd(o.until)}>{o.label}</button>{/each}
  </Popover>
</div>

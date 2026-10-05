<script lang="ts">
  // The tasks button of the sidebar's footer: idle, spinning while something synсs, a dot
  // when a task failed. A click opens the tasks pane. Shown in both halves of the sidebar.
  import Activity from "@lucide/svelte/icons/activity";
  import RotateCw from "@lucide/svelte/icons/rotate-cw";
  import { app } from "../../lib/store.svelte";
  import { t } from "../../lib/i18n.svelte";
  import { sidebarUi } from "./sidebar.svelte";

  const title = $derived(
    sidebarUi.tasksFailed ? t("tasks.hintFailed") : sidebarUi.tasksRunning > 0 ? t("tasks.hintRunning", { n: sidebarUi.tasksRunning }) : t("tasks.title"),
  );
</script>

<button class="foot-btn tasks-btn" class:busy={sidebarUi.tasksRunning > 0} class:failed={sidebarUi.tasksFailed} onclick={() => (app.tasksOpen = true)} title={title} aria-label={t("tasks.title")}>
  <span class="idle"><Activity size={16} /></span>
  {#if sidebarUi.tasksRunning > 0}<span class="spin"><RotateCw size={16} /></span>{/if}
</button>

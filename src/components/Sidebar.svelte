<script lang="ts">
  // The sidebar: the strip of icons (#38) when the window is narrow or it is folded by
  // hand, the full tree otherwise. Its two halves live in components/sidebar/; the view
  // state they share is sidebarUi, and their CSS travels with them as one file, scoped
  // under `.side` — the strip and the full sidebar render the same rows and the same
  // stars, so the rules stay in one place instead of being copied per component.

  import { layout } from "../lib/layout.svelte";
  import { sidebarUi } from "./sidebar/sidebar.svelte";
  import "./sidebar/sidebar.css";
  import SidebarFull from "./sidebar/SidebarFull.svelte";
  import SidebarFolded from "./sidebar/SidebarFolded.svelte";

  let { onCompose }: { onCompose: () => void } = $props();

  // The full sidebar shows the folders itself: an open flyout does not come back with the strip.
  $effect(() => {
    if (!layout.strip) sidebarUi.flyout = null;
  });

  $effect(() => {
    void sidebarUi.flyout;
    sidebarUi.flyoutTree = false;
  });
</script>

{#if layout.strip}
  <SidebarFolded {onCompose} />
{:else}
  <SidebarFull {onCompose} />
{/if}

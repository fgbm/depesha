<script lang="ts">
  import { registry } from "../../plugin-host/registry.svelte";
  import Plugins from "../Plugins.svelte";

  // The plugins' page: the manager (`Plugins.svelte`) and a page per plugin section.
  // The section's own component is rendered from the registry, in its own style.
  let { current }: { current: string } = $props();

  const sections = $derived(registry.lists.settingsSections);
</script>

{#if current === "plugins"}
  <Plugins />
{:else}
  {@const sec = sections[Number(current.slice(7))]}
  {#if sec}
    <section>
      <sec.item.component {...sec.item.props} />
    </section>
  {/if}
{/if}

<style>
  section {
    padding: 14px 0;
    border-bottom: 1px solid var(--line);
  }

  section:last-child {
    border-bottom: none;
  }
</style>

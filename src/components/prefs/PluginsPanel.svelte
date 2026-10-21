<script lang="ts">
  import { t } from "../../lib/i18n.svelte";
  import type { Owned, SettingsSection } from "../../plugin-host/registry.svelte";
  import Plugins from "../Plugins.svelte";

  // The page «Plugins» is the list of them all with their switches (0.8.12, 6.3 Б). A plugin with
  // settings of its own has a page of its own under it in the menu (6.1 Б): what it does, then its
  // groups, each drawn by the plugin's component; a search hit lights a group by its owner.
  let {
    owner = null,
    about = null,
    sections,
    flash = null,
  }: { owner?: string | null; about?: string | null; sections: Owned<SettingsSection>[]; flash?: string | null } = $props();
</script>

{#if owner === null}
  <Plugins />
{:else}
  {#if about}<p class="muted about">{about}</p>{/if}
  {#each sections.filter((s) => s.owner === owner) as sec (sec)}
    <section data-plugin={sec.owner} data-g="plugin" class:flash={flash === `plugin:${sec.owner}`}>
      <h4>{sec.item.title()}</h4>
      <sec.item.component {...sec.item.props} />
    </section>
  {:else}
    <p class="muted">{t("settings.pluginNoSettings")}</p>
  {/each}
{/if}

<style>
  .about {
    margin: 4px 0 14px;
    font-size: 13px;
  }

  section {
    margin-bottom: 22px;
  }

  section.flash {
    box-shadow: 0 0 0 2px var(--accent-text);
    border-radius: 6px;
  }

  h4 {
    margin: 0 0 4px;
    padding: 4px 0 6px;
    border-bottom: 1px solid var(--line);
    font-size: 15px;
    font-weight: 600;
  }
</style>

<script lang="ts">
  import { t } from "../../lib/i18n.svelte";
  import type { Owned, SettingsSection } from "../../plugin-host/registry.svelte";
  import Plugins from "../Plugins.svelte";

  // The plugins' page: the manager (`Plugins.svelte`), then the groups of all the plugins, built-in
  // or not (#168). A group is drawn by the plugin's component; a search hit lights it by its owner.
  let { sections, flash = null }: { sections: Owned<SettingsSection>[]; flash?: string | null } = $props();
</script>

<Plugins />
{#each sections as sec (sec)}
  <section data-plugin={sec.owner} class:flash={flash === `plugin:${sec.owner}`}>
    <h4>{sec.item.title()}<span class="tagp">{t("settings.pluginTag")}</span></h4>
    <sec.item.component {...sec.item.props} />
  </section>
{/each}

<style>
  section {
    margin-top: 22px;
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

  .tagp {
    margin-left: 8px;
    padding: 0 5px;
    border: 1px solid var(--line);
    border-radius: 4px;
    background: var(--paper);
    font-size: 10.5px;
    font-weight: 600;
    color: var(--muted);
    vertical-align: 1px;
  }
</style>

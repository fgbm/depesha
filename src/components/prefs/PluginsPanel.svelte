<script lang="ts">
  import { t } from "../../lib/i18n.svelte";
  import type { Owned, SettingsSection } from "../../plugin-host/registry.svelte";
  import Plugins from "../Plugins.svelte";

  // The plugins' page: the manager (`Plugins.svelte`), then the groups of the plugins that name
  // no page of their own to stand on (#102, 2.4). A group is drawn by the plugin's component.
  let { sections }: { sections: Owned<SettingsSection>[] } = $props();
</script>

<Plugins />
{#each sections as sec (sec)}
  <section>
    <h4>{sec.item.title()}<span class="tagp">{t("settings.pluginTag")}</span></h4>
    <sec.item.component {...sec.item.props} />
  </section>
{/each}

<style>
  section {
    margin-top: 22px;
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

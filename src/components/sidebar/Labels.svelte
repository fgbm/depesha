<script lang="ts">
  // Метки ящика в сайдбаре (#42, кадр 6Б): сохранённый поиск `метка:Имя`, а не папка:
  // письмо остаётся на месте. Метку можно добавить в избранное, как папку.
  import { onMount } from "svelte";
  import Tag from "@lucide/svelte/icons/tag";
  import { app, type View } from "../../lib/store.svelte";
  import { t } from "../../lib/i18n.svelte";
  import type { Favourite } from "../../lib/favourites.svelte";
  import type { AccountView, Label } from "../../lib/types";
  import { sidebarUi } from "./sidebar.svelte";
  import { star } from "./FolderRow.svelte";

  let { account, picked = null }: { account: AccountView; picked?: (() => void) | null } = $props();

  onMount(() => void app.labels.loadCounts(account.id));

  const labels = $derived(app.labels.of(account.id));
  const view = (name: string): View => ({ kind: "search", text: `метка:${name}` });
  const fav = (l: Label): Favourite => ({ name: l.name, display: l.name, delimiter: null, kind: "label" });
</script>

{#if labels.length}
  <div class="labels" role="group" aria-label={t("sidebar.labels")}>
    <div class="subhead"><Tag size={12} /> {t("sidebar.labels")}</div>
    {#each labels as l (l.keyword)}
      <div class="folder-row label-row" data-label={l.name}>
        <button
          class="item"
          class:active={sidebarUi.isActive(view(l.name))}
          role={picked ? "menuitem" : undefined}
          onclick={() => {
            picked?.();
            app.setView(view(l.name));
          }}
          title={l.name}
        >
          <span class="icon"><span class="lsw" style:--c={l.color || "var(--muted)"}></span></span>
          <span class="name">{l.name}</span>
          <span class="count quiet">≈{app.labels.count(account.id, l.keyword)}</span>
        </button>
        {@render star(account, fav(l), true)}
      </div>
    {/each}
  </div>
{/if}

<style>
  .labels {
    display: flex;
    flex-direction: column;
  }

  .lsw {
    display: inline-block;
    width: 12px;
    height: 12px;
    border-radius: 3px;
    background: var(--c, var(--muted));
  }
</style>

<script lang="ts">
  import { onDestroy, onMount } from "svelte";
  import Trash from "@lucide/svelte/icons/trash-2";
  import Plus from "@lucide/svelte/icons/plus";
  import type { PluginContext } from "@depesha/plugin-api";
  import type { Template } from "./index";
  import { S } from "./strings";

  let { ctx }: { ctx: PluginContext } = $props();

  // Edited locally; saved when a field is left, when a template is added or removed,
  // and when Settings close.
  let list = $state<Template[]>([]);
  onMount(() => (list = structuredClone(ctx.settings.get<Template[]>("list", []))));
  let dirty = false;

  function save() {
    if (!dirty) return;
    dirty = false;
    ctx.settings.set("list", $state.snapshot(list).filter((t) => t.name.trim() || t.text.trim()));
  }

  function changed() {
    dirty = true;
  }

  onDestroy(save);
</script>

<p class="muted small">{ctx.t(S.note)}</p>
{#each list as tpl, i (i)}
  <div class="tpl">
    <div class="tpl-head">
      <input class="input" bind:value={tpl.name} oninput={changed} onchange={save} placeholder={ctx.t(S.namePlaceholder)} />
      <button class="btn ghost" onclick={() => { list.splice(i, 1); changed(); save(); }} aria-label={ctx.t(S.remove)}><Trash size={15} /></button>
    </div>
    <textarea class="input" rows="3" bind:value={tpl.text} oninput={changed} onchange={save} placeholder={ctx.t(S.textPlaceholder)}></textarea>
  </div>
{/each}
<button class="btn" onclick={() => list.push({ name: "", text: "" })}><Plus size={15} /> {ctx.t(S.add)}</button>

<style>
  .small {
    font-size: 12px;
  }

  .tpl {
    display: flex;
    flex-direction: column;
    gap: 6px;
    margin-bottom: 10px;
  }

  .tpl-head {
    display: flex;
    gap: 6px;
  }

  .tpl-head .input {
    flex: 1;
  }

  textarea {
    resize: vertical;
    font: inherit;
  }
</style>

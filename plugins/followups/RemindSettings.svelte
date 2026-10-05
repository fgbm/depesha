<script lang="ts">
  import ArrowUp from "@lucide/svelte/icons/arrow-up";
  import ArrowDown from "@lucide/svelte/icons/arrow-down";
  import Trash from "@lucide/svelte/icons/trash-2";
  import type { PluginContext } from "@depesha/plugin-api";
  import type { Remind } from "./due";
  import { S } from "./strings";

  let { ctx }: { ctx: PluginContext } = $props();

  // Each change is saved at once: there is nothing to confirm.
  const list = $derived(ctx.settings.get<Remind[]>("presets", []));
  const save = (next: Remind[]) => ctx.settings.set("presets", next);

  function move(i: number, to: number) {
    if (to < 0 || to >= list.length) return;
    const next = [...list];
    const [p] = next.splice(i, 1);
    next.splice(to, 0, p);
    save(next);
  }

  function rename(i: number, label: string) {
    if (!label.trim() || label === list[i].label) return;
    save(list.map((p, k) => (k === i ? { ...p, label: label.trim() } : p)));
  }
</script>

<p class="muted small">{ctx.t(S.settingsNote)}</p>
{#each list as p, i (p.id)}
  <div class="preset">
    <input class="input" value={p.label} aria-label={ctx.t(S.settings)} onchange={(e) => rename(i, e.currentTarget.value)} />
    <button class="btn ghost icon" disabled={i === 0} onclick={() => move(i, i - 1)} title={ctx.t(S.up)} aria-label={ctx.t(S.up)}><ArrowUp size={14} /></button>
    <button class="btn ghost icon" disabled={i === list.length - 1} onclick={() => move(i, i + 1)} title={ctx.t(S.down)} aria-label={ctx.t(S.down)}><ArrowDown size={14} /></button>
    <button class="btn ghost icon" onclick={() => save(list.filter((x) => x.id !== p.id))} title={ctx.t(S.remove)} aria-label={ctx.t(S.remove)}><Trash size={14} /></button>
  </div>
{:else}
  <p class="muted small">{ctx.t(S.none)}</p>
{/each}

<style>
  .small {
    font-size: 12px;
  }

  .preset {
    display: flex;
    align-items: center;
    gap: 4px;
    margin-bottom: 6px;
  }

  .preset .input {
    flex: 1;
  }
</style>

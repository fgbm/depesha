<script lang="ts">
  import ArrowUp from "@lucide/svelte/icons/arrow-up";
  import ArrowDown from "@lucide/svelte/icons/arrow-down";
  import Trash from "@lucide/svelte/icons/trash-2";
  import type { PluginContext } from "@depesha/plugin-api";
  import { edit, labelOf, type Remind, type Unit } from "./due";
  import { LABEL, S } from "./strings";

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

  const label = (amount: number, unit: Unit) => ctx.plural(amount, LABEL[unit]);

  /** The field shows what was kept: a cleared name gives the made-up one back, a zero amount the old one. */
  function change(i: number, c: Parameters<typeof edit>[1], field: HTMLInputElement | HTMLSelectElement) {
    const next = edit(list[i], c, label);
    save(list.map((p, k) => (k === i ? next : p)));
    field.value = "label" in c ? labelOf(next, label) : "amount" in c ? String(next.amount) : next.unit;
  }
</script>

<p class="muted small">{ctx.t(S.settingsNote)}</p>
{#each list as p, i (p.id)}
  <div class="preset">
    <input class="input name" value={labelOf(p, label)} aria-label={ctx.t(S.presetName)} onchange={(e) => change(i, { label: e.currentTarget.value }, e.currentTarget)} />
    <input class="input num" type="number" min="1" value={p.amount} aria-label={ctx.t(S.amount)} onchange={(e) => change(i, { amount: e.currentTarget.valueAsNumber }, e.currentTarget)} />
    <select class="input" value={p.unit} aria-label={ctx.t(S.unitLabel)} onchange={(e) => change(i, { unit: e.currentTarget.value as Unit }, e.currentTarget)}>
      {#each ["minutes", "hours", "days", "workdays"] as const as u (u)}<option value={u}>{ctx.t(S.unit[u])}</option>{/each}
    </select>
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

  .preset .name {
    flex: 1;
    min-width: 0;
  }

  .preset .num {
    width: 64px;
  }
</style>

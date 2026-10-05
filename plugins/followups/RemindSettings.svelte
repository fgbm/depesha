<script lang="ts">
  // Settings → "Reminders": the saved choices as cards (name and order; when it reminds;
  // the repeat), and how long closed waits are kept.
  import ArrowUp from "@lucide/svelte/icons/arrow-up";
  import ArrowDown from "@lucide/svelte/icons/arrow-down";
  import Plus from "@lucide/svelte/icons/plus";
  import Repeat2 from "@lucide/svelte/icons/repeat-2";
  import Trash from "@lucide/svelte/icons/trash-2";
  import type { PluginContext } from "@depesha/plugin-api";
  import { DAY_UNITS, EVERY, UNITS, kindOf, type Every, type Kind, type Unit } from "./due";
  import { labelMaker } from "./labels";
  import { edit, fresh, labelOf, type Change, type Remind } from "./presets";
  import { S } from "./strings";
  import { KEEP_DAYS } from "./view";

  let { ctx }: { ctx: PluginContext } = $props();

  // Each change is saved at once: there is nothing to confirm.
  const list = $derived(ctx.settings.get<Remind[]>("presets", []));
  const save = (next: Remind[]) => ctx.settings.set("presets", next);
  const label = $derived(labelMaker(ctx));
  const keepDays = $derived(ctx.settings.get<number>("keep_days", KEEP_DAYS));

  function move(i: number, to: number) {
    if (to < 0 || to >= list.length) return;
    const next = [...list];
    const [p] = next.splice(i, 1);
    next.splice(to, 0, p);
    save(next);
  }

  /** The field shows what was kept: a cleared name gives the made-up one back, a zero amount the old one. */
  function change(i: number, c: Change, field?: HTMLInputElement) {
    const next = edit(list[i], c, label);
    save(list.map((p, k) => (k === i ? next : p)));
    if (!field) return;
    if ("label" in c) field.value = labelOf(next, label);
    else if ("amount" in c) field.value = String(next.amount);
    else if ("time" in c) field.value = next.time ?? "";
    else if ("repeat" in c) field.value = String(next.repeat?.amount ?? "");
  }

  /** Repeating as often as it first comes, when that is a fixed time. */
  const repeatOf = (p: Remind) => ({ amount: kindOf(p) === "after" && p.unit !== "workdays" ? p.amount : 1, unit: (kindOf(p) === "after" && p.unit !== "workdays" ? p.unit : "days") as Every });

  function setKeep(field: HTMLInputElement) {
    const n = field.valueAsNumber;
    if (Number.isInteger(n) && n >= 1 && n <= 3650) ctx.settings.set("keep_days", n);
    else field.value = String(keepDays);
  }
</script>

<p class="muted small">{ctx.t(S.settingsNote)}</p>
{#each list as p, i (p.id)}
  {@const kind = kindOf(p)}
  <div class="card">
    <div class="line">
      <input class="input name" value={labelOf(p, label)} aria-label={ctx.t(S.presetName)} onchange={(e) => change(i, { label: e.currentTarget.value }, e.currentTarget)} />
      <button class="btn ghost icon" disabled={i === 0} onclick={() => move(i, i - 1)} title={ctx.t(S.up)} aria-label={ctx.t(S.up)}><ArrowUp size={14} /></button>
      <button class="btn ghost icon" disabled={i === list.length - 1} onclick={() => move(i, i + 1)} title={ctx.t(S.down)} aria-label={ctx.t(S.down)}><ArrowDown size={14} /></button>
      <button class="btn ghost icon" onclick={() => save(list.filter((x) => x.id !== p.id))} title={ctx.t(S.remove)} aria-label={ctx.t(S.remove)}><Trash size={14} /></button>
    </div>
    <div class="line">
      <select class="input" value={kind} aria-label={ctx.t(S.kindLabel)} title={ctx.t(S.kindLabel)} onchange={(e) => change(i, { kind: e.currentTarget.value as Kind })}>
        {#each ["after", "weekday", "before"] as const as k (k)}<option value={k}>{ctx.t(S.kinds[k])}</option>{/each}
      </select>
      {#if kind === "weekday"}
        <select class="input" value={p.weekday ?? 1} aria-label={ctx.t(S.modes.weekday)} onchange={(e) => change(i, { weekday: Number(e.currentTarget.value) })}>
          {#each [1, 2, 3, 4, 5, 6, 0] as d (d)}<option value={d}>{ctx.t(S.weekdays[d])}</option>{/each}
        </select>
      {:else}
        <input class="input num" type="number" min="1" value={p.amount} aria-label={ctx.t(S.amount)} onchange={(e) => change(i, { amount: e.currentTarget.valueAsNumber }, e.currentTarget)} />
        <select class="input" value={p.unit} aria-label={ctx.t(S.unitLabel)} onchange={(e) => change(i, { unit: e.currentTarget.value as Unit })}>
          {#each kind === "before" ? DAY_UNITS : UNITS as u (u)}<option value={u}>{ctx.t(S.unit[u])}</option>{/each}
        </select>
      {/if}
      {#if kind !== "after"}
        <span>{ctx.t(S.atTime)}</span>
        <input class="input" type="time" value={p.time ?? "09:00"} aria-label={ctx.t(S.atTime)} onchange={(e) => change(i, { time: e.currentTarget.value }, e.currentTarget)} />
      {/if}
      <span class="spacer"></span>
      <label class="repeat" title={ctx.t(S.repeatLabel)}>
        <input type="checkbox" checked={!!p.repeat} aria-label={ctx.t(S.repeatLabel)} onchange={(e) => change(i, { repeat: e.currentTarget.checked ? repeatOf(p) : null })} />
        <Repeat2 size={13} />
        <span>{ctx.t(S.every)}</span>
      </label>
      <input class="input num" type="number" min="1" value={p.repeat?.amount ?? repeatOf(p).amount} disabled={!p.repeat} aria-label={ctx.t(S.amount)} onchange={(e) => change(i, { repeat: { amount: e.currentTarget.valueAsNumber, unit: p.repeat!.unit } }, e.currentTarget)} />
      <select class="input" value={p.repeat?.unit ?? repeatOf(p).unit} disabled={!p.repeat} aria-label={ctx.t(S.unitLabel)} onchange={(e) => change(i, { repeat: { amount: p.repeat!.amount, unit: e.currentTarget.value as Every } })}>
        {#each EVERY as u (u)}<option value={u}>{ctx.t(S.unit[u])}</option>{/each}
      </select>
    </div>
  </div>
{:else}
  <p class="muted small">{ctx.t(S.none)}</p>
{/each}
<button class="btn" onclick={() => save([...list, fresh(crypto.randomUUID(), label)])}><Plus size={14} /> {ctx.t(S.add)}</button>

<label class="line keep">
  <span>{ctx.t(S.keepClosed)}</span>
  <input class="input num" type="number" min="1" max="3650" value={keepDays} onchange={(e) => setKeep(e.currentTarget)} />
  <span>{ctx.t(S.keepDays)}</span>
</label>

<style>
  .small {
    font-size: 12px;
  }

  .card {
    display: flex;
    flex-direction: column;
    gap: 6px;
    margin-bottom: 8px;
    padding: 8px;
    border: 1px solid var(--line);
    border-radius: 7px;
  }

  .line {
    display: flex;
    align-items: center;
    gap: 4px;
    flex-wrap: wrap;
  }

  .name {
    flex: 1;
    min-width: 0;
  }

  .num {
    width: 64px;
  }

  .spacer {
    flex: 1;
  }

  .repeat {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    font-size: 13px;
  }

  .keep {
    margin-top: 16px;
    font-size: 13px;
  }
</style>

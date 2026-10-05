<script lang="ts">
  // "In 2 working days" or "on 9 October, 10:00": the form of "Custom…" when writing and
  // of "Set a new date" on a letter still without an answer.
  import { fromLocalInput, toLocalInput, type PluginContext, type Text } from "@depesha/plugin-api";
  import type { Due, Unit } from "./due";
  import { S } from "./strings";

  let {
    ctx,
    title,
    keepable = false,
    onDone,
    onCancel,
  }: { ctx: PluginContext; title: string; keepable?: boolean; onDone: (due: Due) => void; onCancel: () => void } = $props();
  const say = (s: Text) => ctx.t(s);

  let mode = $state<"amount" | "date">("amount");
  let amount = $state(2);
  let unit = $state<Unit>("workdays");
  let date = $state(toLocalInput(Math.floor(Date.now() / 1000) + 2 * 86_400));
  let keep = $state(false);
  const dateAt = $derived(fromLocalInput(date));
  const valid = $derived(mode === "amount" ? amount > 0 : !!dateAt && dateAt * 1000 > Date.now());

  function apply() {
    if (valid) onDone(mode === "amount" ? { amount, unit, keep: keepable && keep } : { at: dateAt! });
  }
</script>

<div class="mt">{title}</div>
<div class="custom">
  <label class="row">
    <input type="radio" bind:group={mode} value="amount" />
    <span>{say(S.inAmount)}</span>
    <input class="input num" type="number" min="1" bind:value={amount} onfocus={() => (mode = "amount")} />
    <select class="input" bind:value={unit} onfocus={() => (mode = "amount")}>
      {#each ["minutes", "hours", "days", "workdays"] as const as u (u)}<option value={u}>{say(S.unit[u])}</option>{/each}
    </select>
  </label>
  <label class="row">
    <input type="radio" bind:group={mode} value="date" />
    <span>{say(S.onDate)}</span>
    <input class="input" type="datetime-local" bind:value={date} onfocus={() => (mode = "date")} />
  </label>
  {#if keepable && mode === "amount"}
    <label class="row keep"><input type="checkbox" bind:checked={keep} /> {say(S.keep)}</label>
  {/if}
  <div class="buttons">
    <button class="btn ghost" onclick={onCancel}>{say(S.cancel)}</button>
    <button class="btn primary" disabled={!valid} onclick={apply}>{say(S.apply)}</button>
  </div>
</div>

<style>
  .custom {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 4px 8px 8px;
    min-width: 300px;
  }

  .row {
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .num {
    width: 64px;
  }

  .keep {
    font-size: 13px;
  }

  .buttons {
    display: flex;
    justify-content: flex-end;
    gap: 6px;
  }
</style>

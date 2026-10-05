<script lang="ts">
  // "In 2 working days", "on 9 October, 10:00" or "on Monday at 9:00": the form of
  // "Custom…" when writing, with a repeat and keeping it in the list; "Set a new date" and
  // "Wait for a reply again" on a letter take the date alone.
  import { fromLocalInput, toLocalInput, when, type PluginContext, type Text } from "@depesha/plugin-api";
  import { EVERY, UNITS, goodTime, nextWeekday, type Due, type Every, type Unit } from "./due";
  import { S } from "./strings";

  let {
    ctx,
    title,
    full = false,
    onDone,
    onCancel,
  }: {
    ctx: PluginContext;
    title: string;
    /** "Custom…" when writing: a repeat, and keeping the choice in the list. */
    full?: boolean;
    onDone: (due: Due) => void;
    onCancel: () => void;
  } = $props();
  const say = (s: Text) => ctx.t(s);

  type Mode = "amount" | "date" | "weekday";
  let mode = $state<Mode>("amount");
  let amount = $state(2);
  let unit = $state<Unit>("workdays");
  let date = $state(toLocalInput(Math.floor(Date.now() / 1000) + 2 * 86_400));
  let weekday = $state(1);
  let time = $state("09:00");
  let repeating = $state(false);
  let every = $state(3);
  let everyUnit = $state<Every>("days");
  let keep = $state(false);
  const dateAt = $derived(fromLocalInput(date));
  const weekdayAt = $derived(goodTime(time) ? Math.floor(nextWeekday(new Date(), weekday, time).getTime() / 1000) : null);
  const valid = $derived(
    (mode === "amount" ? amount > 0 : mode === "date" ? !!dateAt && dateAt * 1000 > Date.now() : weekdayAt !== null) && (!repeating || every > 0),
  );

  function apply() {
    if (!valid) return;
    const repeat = full && repeating ? { amount: every, unit: everyUnit } : null;
    const kept = full && keep;
    if (mode === "date") onDone({ at: dateAt!, repeat });
    else if (mode === "amount") onDone({ spec: { kind: "after", amount, unit, repeat }, keep: kept });
    else onDone({ spec: { kind: "weekday", amount: 1, unit: "days", weekday, time, repeat }, keep: kept });
  }
</script>

<div class="mt">{title}</div>
<div class="custom">
  <div class="modes" role="tablist">
    {#each ["amount", "date", "weekday"] as const as m (m)}
      <button class="mode" class:on={mode === m} role="tab" aria-selected={mode === m} onclick={() => (mode = m)}>{say(S.modes[m])}</button>
    {/each}
  </div>
  {#if mode === "amount"}
    <div class="row">
      <input class="input num" type="number" min="1" bind:value={amount} aria-label={say(S.amount)} />
      <select class="input" bind:value={unit} aria-label={say(S.unitLabel)}>
        {#each UNITS as u (u)}<option value={u}>{say(S.unit[u])}</option>{/each}
      </select>
    </div>
  {:else if mode === "date"}
    <div class="row"><input class="input" type="datetime-local" bind:value={date} aria-label={say(S.modes.date)} /></div>
  {:else}
    <div class="row">
      <select class="input" bind:value={weekday} aria-label={say(S.modes.weekday)}>
        {#each [1, 2, 3, 4, 5, 6, 0] as d (d)}<option value={d}>{say(S.weekdays[d])}</option>{/each}
      </select>
      <span>{say(S.atTime)}</span>
      <input class="input" type="time" bind:value={time} aria-label={say(S.atTime)} />
      {#if weekdayAt}<span class="muted">→ {when(weekdayAt)}</span>{/if}
    </div>
  {/if}
  {#if full}
    <label class="row option">
      <input type="checkbox" bind:checked={repeating} />
      <span>{say(S.repeatOnce)}</span>
      <input class="input num" type="number" min="1" bind:value={every} disabled={!repeating} aria-label={say(S.amount)} />
      <select class="input" bind:value={everyUnit} disabled={!repeating} aria-label={say(S.unitLabel)}>
        {#each EVERY as u (u)}<option value={u}>{say(S.unit[u])}</option>{/each}
      </select>
      <span>{say(S.repeatTail)}</span>
    </label>
    {#if mode !== "date"}
      <label class="row option keep"><input type="checkbox" bind:checked={keep} /> {say(S.keep)}</label>
    {/if}
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
    min-width: 320px;
  }

  .modes {
    display: flex;
    background: var(--paper-2);
    border-radius: 7px;
    padding: 2px;
  }

  .mode {
    flex: 1;
    border: none;
    background: none;
    font: inherit;
    font-size: 12px;
    color: var(--muted);
    padding: 4px 0;
    border-radius: 6px;
    cursor: pointer;
  }

  .mode.on {
    background: var(--selected);
    color: var(--ink);
    font-weight: 600;
  }

  .row {
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .num {
    width: 64px;
  }

  .option {
    font-size: 13px;
  }

  .buttons {
    display: flex;
    justify-content: flex-end;
    gap: 6px;
  }
</style>

<script lang="ts">
  import { Popover, Select, fromLocalInput, toLocalInput, when, type ComposeContext, type PluginContext, type Text } from "@depesha/plugin-api";
  import { secondsAfter, type Remind, type Unit } from "./due";
  import { LABEL, S } from "./strings";

  let { compose, ctx }: { compose: ComposeContext; ctx: PluginContext } = $props();
  const say = (s: Text) => ctx.t(s);

  /** The choice: "0" none, "d<N>" N days, "p:<id>" a saved one, "c" the one set with "Custom…". */
  let value = $state("0");
  let shown = $state("0");
  /** "Custom…" not saved: an amount or a date of its own. */
  let custom = $state<{ amount: number; unit: Unit } | { at: number } | null>(null);
  const saved = $derived(ctx.settings.get<Remind[]>("presets", []));

  const label = (amount: number, unit: Unit) => ctx.plural(amount, LABEL[unit]);

  // Seconds from sending: a scheduled letter is reminded about from its own time.
  $effect(() => {
    const sendAt = compose.options.at ? new Date(compose.options.at * 1000) : new Date();
    const p = value.startsWith("p:") ? saved.find((x) => `p:${x.id}` === value) : null;
    let secs: number | null = null;
    if (value.startsWith("d")) secs = Number(value.slice(1)) * 86_400;
    else if (p) secs = secondsAfter(sendAt, p.amount, p.unit);
    else if (value === "c" && custom)
      secs = "at" in custom ? Math.max(60, custom.at - Math.floor(sendAt.getTime() / 1000)) : secondsAfter(sendAt, custom.amount, custom.unit);
    compose.options.followupSecs = secs;
  });

  // The list keeps showing the choice; "Custom…" opens the form instead of becoming one.
  let open = $state(false);
  $effect(() => {
    if (shown === "custom") {
      open = true;
      shown = value;
    } else value = shown;
  });

  let mode = $state<"amount" | "date">("amount");
  let amount = $state(2);
  let unit = $state<Unit>("workdays");
  let date = $state(toLocalInput(Math.floor(Date.now() / 1000) + 2 * 86_400));
  let keep = $state(false);
  const dateAt = $derived(fromLocalInput(date));
  const valid = $derived(mode === "amount" ? amount > 0 : !!dateAt && dateAt * 1000 > Date.now());

  function apply() {
    if (!valid) return;
    if (mode === "amount" && keep) {
      const p: Remind = { id: crypto.randomUUID(), label: label(amount, unit), amount, unit };
      ctx.settings.set("presets", [...saved, p]);
      shown = `p:${p.id}`;
    } else {
      custom = mode === "amount" ? { amount, unit } : { at: dateAt! };
      shown = "c";
    }
    open = false;
  }

  const options = $derived([
    { value: "0", label: say(S.remind0) },
    { value: "d1", label: say(S.remind1) },
    { value: "d3", label: say(S.remind3) },
    { value: "d7", label: say(S.remind7) },
    ...saved.map((p) => ({ value: `p:${p.id}`, label: p.label })),
    ...(custom
      ? [{ value: "c", label: "at" in custom ? ctx.t(S.untilDate, { when: when(custom.at) }) : label(custom.amount, custom.unit) }]
      : []),
    { value: "custom", label: say(S.custom) },
  ]);
</script>

<span class="remind-anchor">
  <Select class="remind" bind:value={shown} title={say(S.remindHint)} label={say(S.remindHint)} {options} />
  <Popover bind:open align="left">
    <div class="mt">{say(S.customTitle)}</div>
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
      {#if mode === "amount"}
        <label class="row keep"><input type="checkbox" bind:checked={keep} /> {say(S.keep)}</label>
      {/if}
      <div class="buttons">
        <button class="btn ghost" onclick={() => (open = false)}>{say(S.cancel)}</button>
        <button class="btn primary" disabled={!valid} onclick={apply}>{say(S.apply)}</button>
      </div>
    </div>
  </Popover>
</span>

<style>
  .remind-anchor {
    position: relative;
    display: inline-flex;
  }

  :global(.select.remind) {
    max-width: 260px;
    font-size: 13px;
  }

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

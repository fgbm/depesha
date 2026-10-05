<script lang="ts">
  import { Popover, Select, when, type ComposeContext, type PluginContext, type Text } from "@depesha/plugin-api";
  import DueForm from "./DueForm.svelte";
  import { labelOf, secondsAfter, type Due, type Remind, type Unit } from "./due";
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

  function apply(due: Due) {
    if ("amount" in due && due.keep) {
      const p: Remind = { id: crypto.randomUUID(), label: label(due.amount, due.unit), amount: due.amount, unit: due.unit, auto: true };
      ctx.settings.set("presets", [...saved, p]);
      shown = `p:${p.id}`;
    } else {
      custom = "amount" in due ? { amount: due.amount, unit: due.unit } : { at: due.at };
      shown = "c";
    }
    open = false;
  }

  const options = $derived([
    { value: "0", label: say(S.remind0) },
    { value: "d1", label: say(S.remind1) },
    { value: "d3", label: say(S.remind3) },
    { value: "d7", label: say(S.remind7) },
    ...saved.map((p) => ({ value: `p:${p.id}`, label: labelOf(p, label) })),
    ...(custom
      ? [{ value: "c", label: "at" in custom ? ctx.t(S.untilDate, { when: when(custom.at) }) : label(custom.amount, custom.unit) }]
      : []),
    { value: "custom", label: say(S.custom) },
  ]);
</script>

<span class="remind-anchor">
  <Select class="remind" bind:value={shown} title={say(S.remindHint)} label={say(S.remindHint)} {options} />
  <Popover bind:open align="left">
    <DueForm {ctx} title={say(S.customTitle)} keepable onDone={apply} onCancel={() => (open = false)} />
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
</style>

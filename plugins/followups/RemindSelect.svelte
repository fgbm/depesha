<script lang="ts">
  // "Remind me if nobody replies" beside Send: one click for a standard or saved choice;
  // "Custom…" opens the form. Sets what the letter asks of the backend.
  import { Popover, Select, when, type ComposeContext, type PluginContext, type Text } from "@depesha/plugin-api";
  import { choiceOf, resolve, withDeadline } from "./choice.svelte";
  import DueForm from "./DueForm.svelte";
  import { planOf, type Due } from "./due";
  import { labelMaker } from "./labels";
  import { labelOf, type Remind } from "./presets";
  import { S } from "./strings";
  import { awaitable } from "./wait";

  let { compose, ctx }: { compose: ComposeContext; ctx: PluginContext } = $props();
  const say = (s: Text) => ctx.t(s);

  const c = $derived(choiceOf(compose));
  /** What the list shows; "custom" opens the form instead of becoming the choice. */
  let shown = $state("0");
  const saved = $derived(ctx.settings.get<Remind[]>("presets", []));
  const label = $derived(labelMaker(ctx));
  const sendAt = () => (compose.options.at ? new Date(compose.options.at * 1000) : new Date());

  const made = $derived(resolve(c, saved, label, ctx, when));
  const recipients = $derived(awaitable(compose.draft.to, compose.draft.cc));
  const awaited = $derived(recipients.some((r) => r.email === c.expect) ? c.expect : "");

  // Counted from sending: a scheduled letter is reminded about from its own time.
  $effect(() => {
    withDeadline(c, made?.spec ?? null, sendAt());
    const plan = made ? planOf(made.choice, sendAt(), awaited, made.name) : null;
    compose.options.followupSecs = plan?.secs ?? null;
    compose.options.followup = plan?.plan ?? null;
  });

  let open = $state(false);
  $effect(() => {
    if (shown === "custom") {
      open = true;
      shown = c.value;
    } else if (shown !== c.value) {
      c.value = shown;
      c.deadline = null;
    }
  });

  function apply(due: Due) {
    if ("spec" in due && due.keep) {
      const p: Remind = { id: crypto.randomUUID(), label: label(due.spec), ...due.spec, auto: true };
      ctx.settings.set("presets", [...saved, p]);
      shown = `p:${p.id}`;
    } else {
      c.custom = "spec" in due ? { spec: due.spec } : due;
      shown = "c";
      if (c.value === "c") c.deadline = null;
    }
    open = false;
  }

  const options = $derived([
    { value: "0", label: say(S.remind0) },
    { value: "d1", label: say(S.remind1) },
    { value: "d3", label: say(S.remind3) },
    { value: "d7", label: say(S.remind7) },
    ...saved.map((p) => ({ value: `p:${p.id}`, label: labelOf(p, label) })),
    ...(c.custom ? [{ value: "c", label: "at" in c.custom ? ctx.t(S.untilDate, { when: when(c.custom.at) }) : label(c.custom.spec) }] : []),
    { value: "custom", label: say(S.custom) },
  ]);
</script>

<span class="remind-anchor">
  <Select class="remind" bind:value={shown} title={say(S.remindHint)} label={say(S.remindHint)} {options} />
  <Popover bind:open align="left">
    <DueForm {ctx} title={say(S.customTitle)} full onDone={apply} onCancel={() => (open = false)} />
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

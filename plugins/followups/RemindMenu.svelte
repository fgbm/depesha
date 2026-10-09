<script lang="ts">
  // "Remind me if nobody replies" in the line of state (#103, 4.4 А): a chip with the chosen time that
  // opens the menu of "Snooze" (#95) — the line that reads "Fri 9:00", the moments, the working days, the
  // calendar — with two rows more, "No reminder" and "Set up…". The time picked is a date, not "so long
  // after sending": a letter that leaves later keeps it. "Set up…" opens the form (a repeat, "before
  // a deadline", keeping the choice) and the saved choices. Alt+R opens the menu from the keyboard.
  import AlarmClock from "@lucide/svelte/icons/alarm-clock";
  import ChevronDown from "@lucide/svelte/icons/chevron-down";
  import { Popover, closeWhenMenu, openWhenMenu, when, whenMenu, type ComposeContext, type PluginContext, type Text } from "@depesha/plugin-api";
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
  const saved = $derived(ctx.settings.get<Remind[]>("presets", []));
  const label = $derived(labelMaker(ctx));
  const sendAt = () => (compose.options.at ? new Date(compose.options.at * 1000) : new Date());

  const made = $derived(resolve(c, saved, label, ctx, when));
  const recipients = $derived(awaitable(compose.draft.to, compose.draft.cc));
  const awaited = $derived(recipients.some((r) => r.email === c.expect) ? c.expect : "");
  /** What the chip says: the time picked, or the name of a choice made in the form. */
  const text = $derived(!made ? say(S.remind0) : "at" in made.choice ? when(made.choice.at) : made.name);

  // Counted from sending: a scheduled letter is reminded about from its own time.
  $effect(() => {
    withDeadline(c, made?.spec ?? null, sendAt());
    const plan = made ? planOf(made.choice, sendAt(), awaited, made.name) : null;
    compose.options.followupSecs = plan?.secs ?? null;
    compose.options.followup = plan?.plan ?? null;
  });

  let button = $state<HTMLButtonElement | null>(null);
  let menu = $state(false);
  let form = $state(false);
  /** Where the caret was: the menu gives it back, so the text goes on being typed. */
  let back: HTMLElement | null = null;

  function close() {
    menu = false;
    requestAnimationFrame(() => back?.isConnected && back.focus());
  }

  function open() {
    if (!button) return;
    // Without the plugin that draws the menu there is only the form.
    if (!whenMenu.available) {
      form = true;
      return;
    }
    back = document.activeElement as HTMLElement | null;
    const r = button.getBoundingClientRect();
    menu = true;
    openWhenMenu({
      anchor: { x: Math.round(r.left), y: Math.round(r.top), h: Math.round(r.height) },
      extras: { none: !made, noneLabel: say(S.remind0), setupLabel: say(S.custom) },
      texts: { placeholder: say(S.remindPlaceholder), title: say(S.remindHint), pick: say(S.remindPick) },
      onpick: pick,
      onnone: none,
      onsetup: () => (form = true),
      onclose: close,
    });
  }

  function toggle() {
    if (!menu) return open();
    closeWhenMenu();
    close();
  }

  $effect(() => compose.onAction("remind", toggle));

  function pick(at: number) {
    c.custom = { at, repeat: null };
    c.value = "c";
    c.deadline = null;
  }

  function none() {
    c.value = "0";
    c.deadline = null;
  }

  function choose(id: string) {
    c.value = `p:${id}`;
    c.deadline = null;
    form = false;
  }

  function apply(due: Due) {
    if ("spec" in due && due.keep) {
      const p: Remind = { id: crypto.randomUUID(), label: label(due.spec), ...due.spec, auto: true };
      ctx.settings.set("presets", [...saved, p]);
      c.value = `p:${p.id}`;
    } else {
      c.custom = "spec" in due ? { spec: due.spec } : due;
      c.value = "c";
    }
    c.deadline = null;
    form = false;
  }
</script>

<span class="remind-anchor">
  <button
    bind:this={button}
    class="chip-btn remind"
    class:on={!!made}
    data-snooze-button
    onclick={toggle}
    title={say(S.remindHint)}
    aria-label={say(S.remindHint)}
    aria-haspopup="menu"
    aria-expanded={menu}
  >
    <AlarmClock size={13} /><span class="text">{text}</span><ChevronDown size={12} />
  </button>
  <Popover bind:open={form} align="left">
    <DueForm {ctx} title={say(S.customTitle)} full onDone={apply} onCancel={() => (form = false)} />
    {#if saved.length}
      <div class="mt">{say(S.savedChoices)}</div>
      {#each saved as p (p.id)}
        <button class="mi" role="menuitemradio" aria-checked={c.value === `p:${p.id}`} onclick={() => choose(p.id)}>{labelOf(p, label)}</button>
      {/each}
    {/if}
  </Popover>
</span>

<style>
  .remind-anchor {
    position: relative;
    display: inline-flex;
  }

  .chip-btn {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    max-width: 260px;
    border: none;
    border-radius: 6px;
    background: none;
    padding: 3px 4px;
    font: inherit;
    color: var(--muted);
    cursor: pointer;
  }

  .chip-btn.on {
    color: var(--ink);
  }

  .chip-btn:hover,
  .chip-btn:focus-visible {
    background: var(--hover);
    color: var(--ink);
  }

  .text {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
</style>

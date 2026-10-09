<script lang="ts">
  // The quiet line above the buttons while a reminder is chosen: "I will remind you 8 Oct,
  // 10:14, then every 3 days until a reply, if no reply comes from [anyone ▾]"; for a choice
  // before a deadline, "Reply needed by [date] · I will remind you …".
  import AlarmClock from "@lucide/svelte/icons/alarm-clock";
  import CalendarDays from "@lucide/svelte/icons/calendar-days";
  import { Select, addrName, when, type ComposeContext, type PluginContext } from "@depesha/plugin-api";
  import { choiceOf, resolve } from "./choice.svelte";
  import { dayOf, firstAt, kindOf, repeatSecs, type Repeat } from "./due";
  import { labelMaker } from "./labels";
  import type { Remind } from "./presets";
  import { LINE_REPEAT, S } from "./strings";
  import { awaitable } from "./wait";

  let { compose, ctx }: { compose: ComposeContext; ctx: PluginContext } = $props();

  const c = $derived(choiceOf(compose));
  const saved = $derived(ctx.settings.get<Remind[]>("presets", []));
  const made = $derived(resolve(c, saved, labelMaker(ctx), ctx, when));
  // The clock: a reminder some time after sending moves while the letter is written, and
  // so does what the line says; one at a time of the clock stays, as the backend keeps it.
  let now = $state(Date.now());
  $effect(() => {
    const tick = setInterval(() => (now = Date.now()), 30_000);
    return () => clearInterval(tick);
  });
  const sendAt = $derived(compose.options.at ? new Date(compose.options.at * 1000) : new Date(now));
  const first = $derived(made ? firstAt(made.choice, sendAt) : null);
  const firstDay = $derived(dayOf(Math.floor(sendAt.getTime() / 1000)));
  const before = $derived(!!made?.spec && kindOf(made.spec) === "before");
  const repeat = $derived<Repeat | null>(made ? (("at" in made.choice ? made.choice.repeat : made.choice.spec.repeat) ?? null) : null);
  const recipients = $derived(awaitable(compose.draft.to, compose.draft.cc));
  const fromOptions = $derived([
    { value: "", label: ctx.t(S.fromAnyone) },
    ...recipients.map((r) => ({ value: r.email, label: addrName(r) })),
  ]);
  $effect(() => {
    if (c.expect && !recipients.some((r) => r.email === c.expect)) c.expect = "";
  });

  /** The date field speaks YYYY-MM-DD in local time. */
  const iso = (day: number) => {
    const d = new Date(day * 1000);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  };
  function setDeadline(value: string) {
    const [y, m, d] = value.split("-").map(Number);
    if (!y || !m || !d) return;
    const day = dayOf(Math.floor(new Date(y, m - 1, d).getTime() / 1000));
    // Not before the day the letter leaves: a scheduled one would be overdue at once.
    if (day >= firstDay) c.deadline = day;
  }
</script>

{#if made && first}
  <div class="remind-line">
    {#if before}
      <CalendarDays size={13} />
      <span>{ctx.t(S.lineBy)}</span>
      <input class="input deadline" type="date" value={c.deadline ? iso(c.deadline) : ""} min={iso(firstDay)} aria-label={ctx.t(S.lineBy)} onchange={(e) => setDeadline(e.currentTarget.value)} />
      <span>{ctx.t(S.lineThen, { when: when(first) })}{repeat && repeatSecs(repeat) ? ctx.plural(repeat.amount, LINE_REPEAT[repeat.unit]) : ""},</span>
    {:else}
      <AlarmClock size={13} />
      <span>{ctx.t(S.lineWhen, { when: when(first) })}{repeat && repeatSecs(repeat) ? ctx.plural(repeat.amount, LINE_REPEAT[repeat.unit]) : ""},</span>
    {/if}
    {#if recipients.length > 1}
      <span>{ctx.t(S.lineIf)}</span>
      <Select class="remind-from" bind:value={c.expect} title={ctx.t(S.fromTitle)} label={ctx.t(S.fromTitle)} options={fromOptions} />
    {:else}
      <span>{ctx.t(S.lineIfNone)}</span>
    {/if}
  </div>
{/if}

<style>
  /* After the chips of the wait (WaitLine), on a line of its own: quiet, no rule. */
  .remind-line {
    display: flex;
    flex: 1 0 100%;
    align-items: center;
    flex-wrap: wrap;
    gap: 5px;
    padding: 0 0 4px;
    font-size: 12px;
    color: var(--muted);
  }

  .deadline {
    font-size: 12px;
    padding: 1px 4px;
  }

  :global(.select.remind-from) {
    max-width: 220px;
    font-size: 12px;
  }
</style>

<script lang="ts">
  // The quiet line of #44 in the compose window (frames 12А, 13А): what the rules of the
  // recipients do to this letter. A letter is one for everyone, so its parts are those of the
  // strictest rule among «To», «Cc» and «Bcc». While the letter has no words of its own the
  // window takes the stricter format silently (frame 12А) and the line says so, with the way
  // back; once there is text it only offers the switch. An untouched format is what the
  // mailbox writes in, so a change made by hand is never fought by the rule.
  import { t } from "../lib/i18n.svelte";
  import { app } from "../lib/store.svelte";
  import { autoFormat, formatMark, recipientParts } from "../lib/people";
  import { peopleBook } from "../lib/peopleBook.svelte";
  import type { Addr, BodyFormat } from "../lib/types";
  import Info from "@lucide/svelte/icons/info";
  import X from "@lucide/svelte/icons/x";

  let {
    accountId,
    to,
    cc,
    bcc,
    format,
    empty,
    quote,
    onFormat,
    onBack,
  }: {
    accountId: string;
    to: Addr[];
    cc: Addr[];
    bcc: Addr[];
    format: BodyFormat;
    /** The letter has no words of its own yet: signature and quote aside (#44, frame 12А). */
    empty: boolean;
    /** The letter already carries an HTML quote (a reply or a forward): the rule never takes it over silently. */
    quote: boolean;
    onFormat: (f: BodyFormat) => void;
    /** Back to the mailbox's own format, the letter restored as it was before the rule took it. */
    onBack: (mailbox: BodyFormat) => void;
  } = $props();

  /** The format the rule made the window take; null when nothing was switched by a rule. */
  let byRule = $state<BodyFormat | null>(null);
  /** The user sent the rule's format back or closed the line: it does not take over again. */
  let optedOut = $state(false);
  let closed = $state(false);

  peopleBook.load();

  const mailbox = $derived(app.account(accountId)?.compose_format ?? app.settings.compose_format);
  const emails = $derived([...to, ...cc, ...bcc].map((a) => a.email).filter(Boolean));
  const rule = $derived(recipientParts(peopleBook.list, emails, mailbox));
  const who = $derived(
    (() => {
      const email = rule.by;
      if (!email) return "";
      const person = peopleBook.find(email);
      return person?.name || email;
    })(),
  );

  /** The format named in the line's button: the mailbox's own, for the way back. */
  const mailboxName = $derived(t(`format.${mailbox}`));

  /** A rule narrower than the letter is written in, and no rule switch was taken yet. */
  const narrows = $derived(rule.parts !== format && byRule !== format);
  /** The window was taken to the rule's format and the letter is still in it. */
  const returned = $derived(byRule !== null && format === byRule);

  // The silent switch of frame 12А: only while the letter has no words of its own, only
  // from the mailbox's own format (so a change made by hand is left alone), and only once.
  // A letter that already carries a quote is never taken over: `autoFormat` leaves it alone.
  $effect(() => {
    if (optedOut || byRule !== null || !empty || format !== mailbox) return;
    const next = autoFormat(format, rule.parts, quote);
    if (next) {
      byRule = next;
      onFormat(next);
    }
  });

  function take() {
    byRule = rule.parts;
    onFormat(rule.parts);
  }

  function back() {
    optedOut = true;
    closed = true;
    byRule = null;
    onBack(mailbox);
  }
</script>

{#if !closed && ((narrows && rule.parts !== "markdown") || returned)}
  <div class="ruleline">
    <Info size={14} />
    {#if returned}
      <span class="tx">{t("compose.rule.writing", { format: t(`format.${format}`) })}{#if who} <span class="muted">{t("compose.rule.because", { who })}</span>{/if}</span>
      <span class="mark" aria-hidden="true">{formatMark(format)}</span>
      <button class="btn ghost small" onclick={back}>{t("compose.rule.return", { format: mailboxName })}</button>
    {:else}
      <span class="tx">{t("compose.rule.narrow", { format: t(`format.${rule.parts}`) })}{#if who} <span class="muted">{t("compose.rule.because", { who })}</span>{/if}</span>
      <button class="btn small" onclick={take}>{t("compose.rule.write", { format: t(`format.${rule.parts}`) })}</button>
    {/if}
    <button class="hb2" onclick={() => (closed = true)} title={t("close")} aria-label={t("close")}><X size={14} /></button>
  </div>
{/if}

<style>
  .ruleline {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 5px 14px;
    font-size: 12.5px;
    border-bottom: 1px solid var(--line);
    background: var(--paper-2);
    color: var(--muted);
    flex: none;
  }

  .ruleline .tx {
    min-width: 0;
  }

  .ruleline :global(svg) {
    flex: none;
  }

  .mark {
    font: 600 9.5px/14px inherit;
    letter-spacing: 0.03em;
    padding: 0 4px;
    border-radius: 3px;
    background: var(--selected, var(--hover));
    color: var(--ink);
  }

  .ruleline .btn {
    margin-left: auto;
  }

  .hb2 {
    flex: none;
    width: 22px;
    height: 22px;
    border: none;
    border-radius: 6px;
    background: none;
    color: var(--muted);
    display: inline-flex;
    align-items: center;
    justify-content: center;
  }

  .hb2:hover {
    background: var(--hover);
  }
</style>

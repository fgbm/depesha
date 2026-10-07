<script lang="ts">
  // The quiet line of #44 in the compose window (frames 12А, 13А): what the rules of the
  // recipients do to this letter. A letter is one for everyone, so its parts are those of the
  // strictest rule among «To», «Cc» and «Bcc»; when that is less than the letter is written
  // in, the line says so and offers to write in the narrower format — never changing the
  // letter silently once there is text. Written in the narrower format by the rule, the line
  // offers the way back to the mailbox's own format.
  import { t } from "../lib/i18n.svelte";
  import { app } from "../lib/store.svelte";
  import { formatMark, recipientParts } from "../lib/people";
  import { peopleBook } from "../lib/peopleBook.svelte";
  import type { Addr, BodyFormat } from "../lib/types";
  import Info from "@lucide/svelte/icons/info";

  let {
    accountId,
    to,
    cc,
    bcc,
    format,
    onFormat,
  }: {
    accountId: string;
    to: Addr[];
    cc: Addr[];
    bcc: Addr[];
    format: BodyFormat;
    onFormat: (f: BodyFormat) => void;
  } = $props();

  /** The format the rule made the window take; null when nothing was switched by a rule. */
  let byRule = $state<BodyFormat | null>(null);

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

  function take() {
    byRule = rule.parts;
    onFormat(rule.parts);
  }

  function back() {
    byRule = null;
    onFormat(mailbox);
  }
</script>

{#if narrows && rule.parts !== "markdown"}
  <div class="ruleline">
    <Info size={14} />
    <span class="tx">{t("compose.rule.narrow", { format: t(`format.${rule.parts}`) })}{#if who} <span class="muted">{t("compose.rule.because", { who })}</span>{/if}</span>
    <button class="btn small" onclick={take}>{t("compose.rule.write", { format: t(`format.${rule.parts}`) })}</button>
  </div>
{:else if returned}
  <div class="ruleline">
    <Info size={14} />
    <span class="tx">{t("compose.rule.writing", { format: t(`format.${format}`) })}{#if who} <span class="muted">{t("compose.rule.because", { who })}</span>{/if}</span>
    <span class="mark" aria-hidden="true">{formatMark(format)}</span>
    <button class="btn ghost small" onclick={back}>{t("compose.rule.return", { format: mailboxName })}</button>
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
</style>

<script lang="ts">
  // The letter's text in the form chosen above it: the switch (HTML · Markdown · Текст),
  // the sandboxed frame or the plain column. The choice belongs to the letter open now:
  // another letter, or the same one opened again after leaving it, shows the form the
  // setting asks for. The frame is recreated when the letter or the trust changes —
  // WebKitGTK does not reload an iframe when srcdoc changes.
  import LetterViewSwitch from "../LetterViewSwitch.svelte";
  import MailFrame from "../MailFrame.svelte";
  import { app } from "../../lib/store.svelte";
  import { MARKDOWN_CSS } from "../../lib/prose";
  import { preferredView, switchViews } from "../../lib/letterView";
  import { linkify } from "../../lib/format";
  import type { BodyView, OpenedMessage } from "../../lib/types";

  let {
    msg,
    viewing,
  }: {
    msg: OpenedMessage;
    /** An attachment is shown in place of the letter. */
    viewing: boolean;
  } = $props();

  /** The form picked above this letter: it holds while the letter is open and is not kept. */
  let picked = $state<{ id: number; view: BodyView } | null>(null);
  // The choice belongs to the letter open now: another letter, or the same one opened
  // again after leaving it, shows the form the setting asks for.
  let shownId: number | null = null;
  $effect(() => {
    const id = msg.row.id;
    if (id !== shownId) {
      shownId = id;
      picked = null;
    }
  });
  const switchable = $derived(switchViews(msg.view, app.settings.letter_view));
  const shown = $derived<BodyView>(picked?.id === msg.row.id ? picked.view : preferredView(msg.view, app.settings.letter_view));

  /** A `mailto:` link becomes a new letter; any other link opens after a confirmation. */
  async function link(href: string) {
    if (href.toLowerCase().startsWith("mailto:")) {
      app.openMailto(href);
      return;
    }
    await app.openLink(href);
  }
</script>

{#if switchable.length && !viewing}
  <LetterViewSwitch views={switchable} bind:value={() => shown, (view) => (picked = { id: msg.row.id, view })} />
{/if}
<!-- Hidden, not removed, while an attachment is shown: the letter keeps its scroll and pictures. -->
<div class="body" hidden={viewing}>
  {#if shown === "markdown" && msg.view.markdown}
    {#key `${msg.row.id}:md:${app.allowRemote || msg.trusted_sender}`}
      <MailFrame themed html={MARKDOWN_CSS + msg.view.markdown} allowRemote={app.allowRemote || msg.trusted_sender} onLink={link} />
    {/key}
  {:else if shown === "html" && msg.view.html}
    <!-- WebKitGTK does not reload an iframe when srcdoc changes: recreate it instead. -->
    {#key `${msg.row.id}:${app.allowRemote || msg.trusted_sender}`}
      <MailFrame html={msg.view.html} allowRemote={app.allowRemote || msg.trusted_sender} onLink={link} />
    {/key}
  {:else}
    <div class="plain selectable">
      {#each linkify(msg.view.text ?? "") as part, i (i)}
        {#if part.href}<a href={part.href} onclick={(e) => { e.preventDefault(); link(part.href!); }}>{part.text}</a>{:else}{part.text}{/if}
      {/each}
    </div>
  {/if}
</div>

<style>
  .body[hidden] {
    display: none;
  }

  /* One card for every form of the letter, so switching the form changes only the text.
     Grows with plain text, so a long letter scrolls instead of running under the answer bar. */
  .body {
    flex: 1 0 auto;
    min-height: 420px;
    display: flex;
    margin: 0 16px 16px;
    border: 1px solid var(--line);
    border-radius: 8px;
    background: var(--paper);
    overflow: hidden;
  }

  /* The card's corners are the frame's. */
  .body :global(iframe) {
    border-radius: 0;
  }

  /* Plain text in the theme's colours, with the frame's margins; lines stay readable on a wide card. */
  .plain {
    flex: 1;
    max-width: calc(72ch + 44px);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    padding: 18px 22px 24px;
    line-height: 1.6;
  }

  .plain a {
    color: var(--link);
  }
</style>

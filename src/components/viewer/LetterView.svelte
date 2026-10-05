<script lang="ts">
  // A letter attached to a letter (.eml): read as in the reader, remote images blocked.
  import Paperclip from "@lucide/svelte/icons/paperclip";
  import { api } from "../../lib/api";
  import { addrFull, linkify, longDate, size } from "../../lib/format";
  import { t } from "../../lib/i18n.svelte";
  import type { MessageView } from "../../lib/types";
  import type { ViewedFile } from "../../lib/viewer";
  import MailFrame from "../MailFrame.svelte";

  let { file }: { file: ViewedFile } = $props();

  let view = $state<MessageView | null>(null);

  $effect(() => {
    let gone = false;
    file
      .bytes()
      .then((b) => api.letterView(b))
      .then((v) => !gone && (view = v))
      .catch((e) => !gone && file.fail(e));
    return () => {
      gone = true;
    };
  });

  const files = $derived(view ? view.attachments.filter((a) => !(a.inline && a.content_id)) : []);
</script>

{#if view}
  {@const s = view.summary}
  <div class="letter">
    <div class="head selectable">
      <h2>{s.subject || t("noSubject")}</h2>
      {#if s.from}<div><b>{addrFull(s.from)}</b></div>{/if}
      {#if s.to.length}<div class="muted small">{t("compose.fwd.to")}: {s.to.map(addrFull).join(", ")}</div>{/if}
      {#if s.cc.length}<div class="muted small">{t("compose.fwd.cc")}: {s.cc.map(addrFull).join(", ")}</div>{/if}
      {#if s.date}<div class="muted small">{longDate(s.date)}</div>{/if}
      {#if files.length}
        <div class="files muted small">
          {#each files as a (a.index)}<span><Paperclip size={12} /> {a.name} · {size(a.size)}</span>{/each}
        </div>
      {/if}
    </div>
    <div class="body">
      {#if view.html}
        <MailFrame html={view.html} allowRemote={false} onLink={(href) => file.openLink(href)} />
      {:else}
        <div class="plain selectable">
          {#each linkify(view.text ?? "") as part, i (i)}
            {#if part.href}<a href={part.href} onclick={(e) => { e.preventDefault(); file.openLink(part.href!); }}>{part.text}</a>{:else}{part.text}{/if}
          {/each}
        </div>
      {/if}
    </div>
  </div>
{/if}

<style>
  .letter {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
    overflow-y: auto;
  }

  .head {
    padding: 8px 22px 12px;
    line-height: 1.5;
  }

  h2 {
    margin: 0 0 8px;
    font-size: 18px;
    font-weight: 650;
  }

  .small {
    font-size: 12px;
  }

  .files {
    display: flex;
    flex-wrap: wrap;
    gap: 4px 14px;
    margin-top: 6px;
  }

  .files span {
    display: inline-flex;
    align-items: center;
    gap: 4px;
  }

  .body {
    flex: 1;
    min-height: 420px;
    display: flex;
    margin: 0 16px 16px;
  }

  .plain {
    flex: 1;
    max-width: 72ch;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    padding: 4px 6px 24px;
    line-height: 1.6;
  }

  .plain a {
    color: var(--link);
  }
</style>

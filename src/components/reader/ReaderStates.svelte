<script lang="ts">
  // The reader's states that are not the letter itself: several chosen rows (the panel above
  // holds the actions, the reader only says how many), the same set for the reader of a narrow
  // window, a failure, the letter still on its way, and the resting placeholder. The pane
  // (Reader.svelte) keeps one place for them; the letter, its title and its toolbar make the
  // other component.
  import { app } from "../../lib/store.svelte";
  import { addrName, longDate, size } from "../../lib/format";
  import { t, tn } from "../../lib/i18n.svelte";
  import { shortcuts } from "../../lib/shortcuts.svelte";
  import Keys from "../Keys.svelte";
  import BulkActions from "./BulkActions.svelte";
  import { arrivals } from "../../lib/arrivals.svelte";

  let {
    which,
    waited,
  }: {
    /** Which state is shown: none of them is the letter. */
    which: "bare" | "bulk" | "error" | "opening" | "placeholder";
    /** How far the opening has gone: 0 at once, then a blink, then seconds. */
    waited: 0 | 1 | 2 | 3;
  } = $props();

  const selectedSize = $derived(app.selection.selectedSize());
</script>

{#if which === "bare"}
  <div class="bare muted">{tn("bulk.selected", app.selection.selected.size, { n: app.selection.selected.size, size: size(selectedSize) })}</div>
{:else if which === "bulk"}
  <div class="center">
    <h3>{tn("bulk.selected", app.selection.selected.size, { n: app.selection.selected.size, size: size(selectedSize) })}</h3>
    <div class="bulk-row"><BulkActions /></div>
  </div>
{:else if which === "error"}
  <div class="center">
    <p class="danger-text">{app.reader.openError?.message}</p>
    {#if app.reader.opened === null && app.selection.selected.size === 1}
      <button class="btn" onclick={() => app.reader.open([...app.selection.selected][0])}>{t("retry")}</button>
    {/if}
  </div>
{:else if which === "opening"}
  {@const r = app.reader.openingRow}
  <div class="opening" aria-busy="true" aria-live="polite">
    <div class="progress" role="progressbar" aria-label={t("reader.loading")}><span></span></div>
    {#if r}
      <div class="head">
        <p class="title">{r.subject || t("noSubject")}</p>
        <div class="muted">{addrName(r.from) || t("list.noSender")} · {longDate(r.date)}</div>
      </div>
    {/if}
    <div class="skeleton" aria-hidden="true"><i></i><i></i><i></i><i></i></div>
    {#if waited >= 2}
      <div class="slow muted">
        {waited === 3 ? t("reader.stuck") : t("reader.downloading")}
        {#if waited === 3 && r}<button class="btn" onclick={() => app.reader.open(r.id)}>{t("retry")}</button>{/if}
      </div>
    {/if}
  </div>
{:else}
  <!-- One way in instead of a wall of keys: the palette lists every command with its key. -->
  {@const fresh = arrivals.freshCount(app.list.view)}
  <!-- The palette's key as the keymap has it; a palette without a key says nothing of it. -->
  {@const palette = shortcuts.key("command-palette.open")}
  <div class="center muted">
    <div class="hint">
      {#if fresh}
        <!-- A summary notification opened the list: how many new ones, and the way in. -->
        <p>{tn("arrivals.fresh", fresh, { n: fresh })}</p>
        <p class="small"><kbd>Enter</kbd> — {t("arrivals.openFirst")}</p>
      {:else}
        <p>{t("reader.choose")}</p>
        {#if palette}<p class="small"><Keys key={palette} cap /> — {t("keys.all")}</p>{/if}
      {/if}
    </div>
  </div>
{/if}

<style>
  .opening {
    flex: 1;
    display: flex;
    flex-direction: column;
    min-height: 0;
  }

  .head {
    padding: 16px 22px 10px;
  }

  /* The same place and size as the opened message's title: nothing jumps when it arrives. */
  .opening .title {
    margin: 0 0 12px;
    font-size: 20px;
    font-weight: 650;
    line-height: 1.3;
  }

  /* An indeterminate line: work is going on, its length is unknown. */
  .progress {
    height: 2px;
    overflow: hidden;
    background: transparent;
  }

  .progress span {
    display: block;
    width: 30%;
    height: 100%;
    background: var(--accent);
    animation: slide 1.1s ease-in-out infinite;
  }

  @keyframes slide {
    from {
      transform: translateX(-100%);
    }
    to {
      transform: translateX(340%);
    }
  }

  .skeleton {
    display: flex;
    flex-direction: column;
    gap: 10px;
    padding: 16px 22px;
  }

  .skeleton i {
    height: 10px;
    border-radius: 5px;
    background: var(--hover);
  }

  .skeleton i:nth-child(1) {
    width: 72%;
  }

  .skeleton i:nth-child(2) {
    width: 90%;
  }

  .skeleton i:nth-child(3) {
    width: 64%;
  }

  .skeleton i:nth-child(4) {
    width: 40%;
  }

  .slow {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 4px 22px;
  }

  @media (prefers-reduced-motion: reduce) {
    .progress span {
      animation-duration: 3s;
    }
  }

  .center {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 12px;
    padding: 24px;
    text-align: center;
  }

  /* Several chosen rows in the main window (question 1.4 «Б»): the panel above holds the
     actions, the reader only says how many. */
  .bare {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 24px;
    text-align: center;
  }

  .bulk-row {
    display: flex;
    width: 100%;
    min-width: 0;
  }

  .hint .small {
    max-width: 380px;
    line-height: 1.9;
  }
</style>

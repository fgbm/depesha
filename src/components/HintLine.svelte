<script lang="ts">
  // The quiet line of a hint (#69, frames 14А, 15): where the suggestion is about what is on
  // the screen — under the formatting row in a letter, under the view switch in the reader.
  // The accepting button names the action («Write in Markdown»), «Not now» puts it off, and
  // the «⋯» menu holds «don't offer it for this person», «don't offer this to anyone» and
  // the way to the list. After the answer the line turns into what changed, with «Undo».
  import { t } from "../lib/i18n.svelte";
  import type { Hint } from "../lib/hints";
  import Popover from "./Popover.svelte";
  import Lightbulb from "@lucide/svelte/icons/lightbulb";
  import Ellipsis from "@lucide/svelte/icons/ellipsis";

  let {
    hint,
    onAccept,
    onNotNow,
    onNeverThis,
    onNeverAnyone,
    onAll,
    onUndo,
  }: {
    hint: Hint;
    onAccept: () => void | Promise<void>;
    onNotNow: () => void | Promise<void>;
    onNeverThis: () => void | Promise<void>;
    onNeverAnyone: () => void | Promise<void>;
    onAll: () => void;
    onUndo?: () => void | Promise<void>;
  } = $props();

  /** The hint was accepted: the line now says what changed and offers the way back. */
  let done = $state(false);
  let menu = $state(false);

  async function accept() {
    await onAccept();
    done = true;
  }

  async function undo() {
    done = false;
    await onUndo?.();
  }
</script>

{#if done}
  <div class="hline">
    <Lightbulb size={14} />
    <span class="ht">{t("hint.applied", { who: hint.who })}</span>
    <button class="link" onclick={undo}>{t("undo")}</button>
  </div>
{:else}
  <div class="hline">
    <Lightbulb size={14} />
    <span class="ht">{t(hint.text, { who: hint.who })}</span>
    <button class="btn small" onclick={accept}>{t(hint.accept)}</button>
    <button class="btn ghost small" onclick={onNotNow}>{t("hint.notNow")}</button>
    <span class="anchor">
      <button class="hb2" onclick={() => (menu = !menu)} title={t("hint.more")} aria-label={t("hint.more")} aria-haspopup="menu" aria-expanded={menu}>
        <Ellipsis size={15} />
      </button>
      <Popover bind:open={menu}>
        <button class="mi" role="menuitem" onclick={() => { menu = false; onNeverThis(); }}>{t("hint.neverThis", { name: hint.who })}</button>
        <button class="mi" role="menuitem" onclick={() => { menu = false; onNeverAnyone(); }}>{t("hint.neverAnyone")}</button>
        <hr />
        <button class="mi" role="menuitem" onclick={() => { menu = false; onAll(); }}>{t("hint.allHints")}</button>
      </Popover>
    </span>
  </div>
{/if}

<style>
  .hline {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 5px 14px;
    font-size: 12.5px;
    border-bottom: 1px solid var(--line);
    background: var(--paper-2);
    color: var(--ink);
    flex: none;
  }

  .hline :global(svg) {
    flex: none;
    color: var(--warn);
  }

  .ht {
    min-width: 0;
  }

  .hline .btn {
    flex: none;
  }

  .hline .btn.ghost {
    color: var(--muted);
  }

  .anchor {
    display: inline-flex;
    margin-left: auto;
  }

  .hb2 {
    width: 24px;
    height: 24px;
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

  .link {
    border: none;
    background: none;
    padding: 0;
    color: var(--link);
    font: inherit;
  }

  .link:hover {
    text-decoration: underline;
  }
</style>

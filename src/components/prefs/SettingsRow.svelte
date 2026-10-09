<script lang="ts">
  // One row of the settings (#102): the name with its lines under it, and the control. Every
  // row of every page is this shell; what differs is the control in it. The row is one stop of
  // the keyboard: ↑/↓ walk the rows, ← / → change the value, Enter opens or enters it.
  import type { Snippet } from "svelte";
  import { t } from "../../lib/i18n.svelte";
  import type { Mark } from "../../lib/settingsAutosave.svelte";

  let {
    id,
    kind,
    label,
    desc = null,
    hint = null,
    warn = null,
    error = null,
    mark,
    dis = false,
    dep = false,
    block = false,
    quiet = false,
    tab = false,
    flash = false,
    children,
  }: {
    id: string;
    kind: string;
    label: string;
    /** About the chosen option only. */
    desc?: string | null;
    hint?: string | null;
    warn?: string | null;
    /** Why the typed value was not saved. */
    error?: string | null;
    mark?: Mark;
    dis?: boolean;
    /** Stands under a switch above it. */
    dep?: boolean;
    /** The control takes the row's whole width, under the name. */
    block?: boolean;
    /** The name is for a screen reader only: the control says it in full (a link, a table). */
    quiet?: boolean;
    /** The cursor of the page is here: the row is where Tab arrives. */
    tab?: boolean;
    flash?: boolean;
    children?: Snippet;
  } = $props();
</script>

<!-- The roving focus of a page of rows: the row is a stop of its own, the controls in it are not. -->
<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
<div
  class="rw"
  class:dis
  class:dep
  class:block
  class:flash
  role="group"
  aria-labelledby="lbl-{id}"
  aria-disabled={dis}
  tabindex={tab ? 0 : -1}
  data-settings={id}
  data-row={id}
  data-kind={kind}
>
  <div class="lab">
    <div class="t" class:quiet id="lbl-{id}">
      {label}
      {#if mark}<span class="mark" class:undone={mark === "undone"} role="status">{mark === "saved" ? t("settings.saved") : t("settings.reverted")}</span>{/if}
    </div>
    {#if desc}<div class="h">{desc}</div>{/if}
    {#if hint}<div class="h">{hint}</div>{/if}
    {#if warn}<div class="h warn">{warn}</div>{/if}
    {#if error}<div class="h warn" role="alert">{error}</div>{/if}
  </div>
  {#if children}<div class="c">{@render children()}</div>{/if}
</div>

<style>
  /* A grid: the name takes 250 px, the control starts level at its left (#102, 1.2 Б). */
  .rw {
    display: grid;
    grid-template-columns: 250px minmax(0, 1fr);
    gap: 16px;
    align-items: start;
    min-height: 44px;
    padding: 9px 0;
    border-radius: 6px;
    outline: none;
  }

  /* The strip takes 14 px at the left; the name gives them up, so the controls keep their column. */
  .rw.dep {
    grid-template-columns: 236px minmax(0, 1fr);
    padding-left: 14px;
  }

  .rw.block {
    grid-template-columns: minmax(0, 1fr);
    gap: 8px;
  }

  /* A disabled dependent row stays where it is, dimmed (#102, 1.6 А). */
  .rw.dis {
    opacity: 0.5;
  }

  .rw:focus-visible {
    box-shadow: 0 0 0 2px var(--link);
    background: color-mix(in srgb, var(--link) 6%, transparent);
  }

  .rw.flash {
    box-shadow: 0 0 0 2px var(--accent);
  }

  .t {
    line-height: 1.35;
  }

  .t.quiet {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }

  .h {
    margin-top: 2px;
    font-size: 12px;
    line-height: 1.45;
    color: var(--muted);
  }

  .h.warn {
    color: var(--warn);
  }

  .mark {
    margin-left: 8px;
    font-size: 11.5px;
    font-weight: 400;
    color: var(--ok);
  }

  .mark.undone {
    color: var(--muted);
  }

  .c {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
    min-width: 0;
  }

  /* In a narrow window the control goes under the name. */
  @container (max-width: 470px) {
    .rw,
    .rw.dep {
      grid-template-columns: minmax(0, 1fr);
      gap: 5px;
    }
  }
</style>

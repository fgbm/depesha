<script lang="ts">
  import { untrack } from "svelte";

  // A typed value of a row: a number, a time (#102, 1.7). It is kept as it is typed; Enter or
  // leaving the field saves it, a wrong one is lit and not saved, Esc puts the saved one back.
  let {
    value,
    label,
    width = 72,
    align = "right",
    disabled = false,
    oncommit,
    onerror,
    onleave,
  }: {
    value: string;
    label: string;
    width?: number;
    align?: "left" | "right" | "center";
    disabled?: boolean;
    /** The message when the text is not fit to be saved, else null. */
    oncommit: (text: string) => Promise<string | null>;
    onerror: (message: string | null) => void;
    /** Enter and Esc hand the focus back to the row. */
    onleave: () => void;
  } = $props();

  let text = $state("");
  let bad = $state(false);
  let focused = false;
  let seen: string | null = null;

  // What is saved shows when it changes, unless the field is being typed in: leaving the field
  // does not put the saved value back over a typed one that was refused. A value that changed
  // from outside (taken back, set elsewhere) clears the refusal that was about the old one.
  $effect.pre(() => {
    const saved = value;
    const was = untrack(() => seen);
    seen = saved;
    if (was !== null && was !== saved) {
      untrack(() => {
        bad = false;
        onerror(null);
      });
    }
    if (!untrack(() => focused)) text = saved;
  });

  async function commit() {
    if (text.trim() === value) {
      bad = false;
      onerror(null);
      return;
    }
    const message = await oncommit(text);
    bad = message !== null;
    onerror(message);
    if (!bad) text = value;
  }

  function revert() {
    text = value;
    bad = false;
    onerror(null);
  }

  async function onKey(e: KeyboardEvent) {
    if (e.key === "Enter") {
      e.preventDefault();
      e.stopPropagation();
      await commit();
      if (!bad) onleave();
    } else if (e.key === "Escape") {
      // The row is left first; a second Esc closes the window.
      e.preventDefault();
      e.stopPropagation();
      revert();
      onleave();
    }
  }
</script>

<input
  class="input field"
  class:bad
  style:width="{width}px"
  style:text-align={align}
  inputmode="numeric"
  spellcheck="false"
  autocomplete="off"
  aria-label={label}
  aria-invalid={bad}
  tabindex="-1"
  {disabled}
  bind:value={text}
  onfocus={() => (focused = true)}
  onblur={async () => {
    focused = false;
    await commit();
  }}
  onkeydown={onKey}
/>

<style>
  .field {
    padding: 4px 8px;
    font-size: 13px;
  }

  .field.bad {
    border-color: var(--warn);
    box-shadow: 0 0 0 2px color-mix(in srgb, var(--warn) 25%, transparent);
  }
</style>

<script lang="ts">
  // The toolbar above the letter in a narrow window and in a letter opened in a window of its
  // own: the way back and the neighbours, and the letter's own actions — LetterActions, the same
  // copy the action panel above the list uses, in the look of main (compact labels and the
  // container queries). While another letter is being opened the toolbar stays where it is and
  // only the buttons stand aside, so the header does not jump before the skeleton arrives.
  import { layout } from "../../lib/layout.svelte";
  import { app } from "../../lib/store.svelte";
  import LetterActions from "./LetterActions.svelte";
  import type { ExtMessage } from "../../lib/extensions.svelte";
  import type { AccountView, OpenedMessage } from "../../lib/types";
  import type { Snippet } from "svelte";

  let {
    msg,
    account,
    isDraft,
    message,
    nav,
    inactive = false,
  }: {
    msg: OpenedMessage;
    /** The letter's mailbox; the draft opens a window from it. */
    account: AccountView | undefined;
    /** The letter is a draft: it offers "continue" instead of the actions of a letter. */
    isDraft: boolean;
    /** The letter as a plugin sees it; the menuitems of extensions act on it. */
    message: ExtMessage | null;
    /** The way back and the neighbours in a narrow window; the pane's own. */
    nav: Snippet;
    /** Another letter is being opened: the buttons stand aside, they must not act on this one. */
    inactive?: boolean;
  } = $props();
</script>

<div class="toolbar" class:compact={layout.single && app.windowOf === null} data-tauri-drag-region>
  {@render nav()}
  <LetterActions {msg} {account} {isDraft} {message} compact {inactive} />
  <!-- The rest of the strip drags the window. -->
  <span class="sep" data-tauri-drag-region></span>
</div>

<style>
  .toolbar {
    display: flex;
    align-items: center;
    gap: 4px;
    /* The right edge stays clear for the window controls (WindowControls.svelte); the
       buttons stand at their height, the subject comes up right under them. */
    padding: 4px 144px 0 12px;
    flex-wrap: wrap;
  }

  /* A narrow window: the way back and the neighbours come first, the actions keep only their icons. */
  .toolbar.compact :global(.lbl),
  .toolbar.compact :global(.lbl2) {
    display: none;
  }

  /* A narrow reader keeps one toolbar row: secondary labels go, tooltips stay. */
  /* Plugins' toolbar buttons use the same classes, hence :global. */
  @container (max-width: 720px) {
    .toolbar :global(.lbl) {
      display: none;
    }
  }

  @container (max-width: 520px) {
    .toolbar :global(.lbl2) {
      display: none;
    }
  }

  .sep {
    flex: 1;
  }
</style>

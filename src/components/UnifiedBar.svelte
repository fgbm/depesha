<script lang="ts">
  // The action panel over the list and the letter (0.8.3, decision 1.1 В, settled by the operator
  // in step 2): one row above both columns, as in Yandex Mail, instead of the reader's own
  // toolbar. The search stands in the same row, over the list column (question 1.2 «Б»), and is
  // rendered by the app before the list; this is the actions to its right.
  //
  // The letter's set and the set for several chosen rows live in their own components — one copy
  // for the panel and for the reader's own toolbar (LetterActions, BulkActions). An empty strip
  // when no letter is open (1.3 Б); the set for several chosen rows (1.4 Б); every button with
  // its label (1.6 Б); the panel on the reader's ground with a line under it (1.7 В); «Ещё» at
  // the right edge (1.8 Б); the row never wraps — what does not fit goes into «Ещё» (1.9 Б).
  //
  // The buttons stand only for the letter actually on screen (app.reader.showsLetter): while
  // another letter is being opened, the one leaving the pane shows none of its own.
  import LetterActions from "./reader/LetterActions.svelte";
  import BulkActions from "./reader/BulkActions.svelte";
  import { app } from "../lib/store.svelte";
  import { t } from "../lib/i18n.svelte";
  import { fromRow } from "../lib/extensions.svelte";
  import type { ExtMessage } from "../lib/extensions.svelte";
  import type { AccountView } from "../lib/types";

  const msg = $derived(app.reader.opened);
  const account = $derived<AccountView | undefined>(msg ? app.mailboxes.account(msg.row.account_id) : undefined);
  const isDraft = $derived(msg ? app.mailboxes.folder(msg.row.account_id, msg.row.folder)?.role === "drafts" : false);
  const message = $derived<ExtMessage | null>(msg ? fromRow(msg.row, account?.email ?? "", msg.view.text) : null);

  /** Several chosen rows: the panel switches to the set for many (1.4 Б). */
  const multi = $derived(app.selection.selected.size > 1);
  /** One letter on screen and no explicit choice of several: the panel shows its actions. */
  const single = $derived(!multi && app.reader.showsLetter);
</script>

<div class="unibar" data-tauri-drag-region>
  <div class="actions" data-tauri-drag-region role="group" aria-label={t("label.actions")}>
    {#if multi}
      <BulkActions />
    {:else if single && msg}
      <LetterActions {msg} {account} {isDraft} {message} />
    {/if}
  </div>
</div>

<style>
  /* The panel stands on the reader's ground with a line under it (1.7 В), so it reads as a
     layer of its own above the letter, not as its header. It takes the columns right of the
     list; the search (rendered by the app) takes the list's own column. */
  .unibar {
    grid-row: 1;
    grid-column: 4 / -1;
    display: flex;
    align-items: center;
    min-width: 0;
    background: var(--paper-2);
    border-bottom: 1px solid var(--line);
    /* The right edge stays clear for the window controls (WindowControls.svelte). */
    padding: 6px 144px 6px 6px;
  }

  .actions {
    display: flex;
    align-items: center;
    gap: 4px;
    min-width: 0;
    flex: 1;
  }
</style>

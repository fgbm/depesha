// The quick answer under the conversation: write without leaving it, unfold into a window
// when it grows. The state, the effects and the order are the component's of old;
// QuickReply.svelte brings the markup, so every `t("…")` of this answer stays in a component.
//
// A composable in the plain sense: it keeps no markup and no wording, only the state and
// the actions, and returns from `useQuickReply()`.

import { untrack } from "svelte";
import { api } from "../../lib/api";
import { app } from "../../lib/store.svelte";
import { formatFor, reply } from "../../lib/compose";
import { replySignature, withSignature } from "../../lib/signatures";
import { htmlLetterText, paragraphsHtml } from "../../lib/richtext";
import { sendWarnings } from "../../lib/sendChecks";
import { composeAction } from "../../lib/composeKeys";
import type { ComposeDraft } from "../../lib/types";

/** What the answer needs from its component: the wording. */
export interface QuickReplyHost {
  /** An answer left behind was kept as a draft; `open` brings it back in a window, null when the saved copy is not known. */
  keptAsDraft(open: (() => void) | null): void;
}

export class QuickReplyState {
  /** The letter being read; the answer is built from it. */
  readonly msg = $derived(app.reader.opened);
  /** The letter's mailbox: the answer comes from its address, in its format. */
  readonly account = $derived(this.msg ? app.mailboxes.account(this.msg.row.account_id) : undefined);
  /** "All" is offered only when it reaches someone a plain reply does not. */
  readonly manyRecipients = $derived.by(() => {
    const msg = this.msg;
    const account = this.account;
    if (!msg || !account) return false;
    const me = { name: account.display_name, email: account.email };
    const one = reply(msg, me, false);
    const all = reply(msg, me, true);
    return all.to.length + all.cc.length > one.to.length + one.cc.length;
  });

  /** The answer being typed: built from the letter when the box opened. */
  quick = $state<{ account_id: string; email: string; draft: ComposeDraft; all: boolean; to: number } | null>(null);
  text = $state("");
  box = $state<HTMLTextAreaElement | null>(null);
  busy = $state(false);

  constructor(private host: QuickReplyHost) {
    // Another letter opened with an answer half-written: it is kept in the drafts.
    $effect(() => {
      void this.msg?.row.id;
      untrack(() => this.leaveIfMoved());
    });
  }

  /**
   * The answer belongs to a letter no longer open: it is saved as a draft, no window opens
   * over the next letter. Not while it is being sent, or it would be sent and kept as a
   * draft too; `send` looks again.
   */
  private leaveIfMoved() {
    if (!this.quick || this.busy || this.quick.to === this.msg?.row.id) return;
    if (this.text.trim()) this.keep(this.quick.account_id, this.draft(this.quick));
    this.quick = null;
    this.text = "";
  }

  /** Saves an answer left behind; when the server refuses, it waits folded in a window that says why. */
  private async keep(account_id: string, draft: ComposeDraft) {
    try {
      const saved = await api.draftSave(account_id, draft, null, null);
      // Without the saved copy's id a window would save a second draft beside it.
      this.host.keptAsDraft(saved === null ? null : () => app.openCompose({ account_id, draft, draft_id: saved.id, draft_message_id: saved.message_id }));
    } catch {
      // The draft could not be kept: the text goes to a window, unsaved, so nothing is lost.
      app.openCompose({ account_id, draft, draft_id: null, unsaved: true }, "min");
    }
  }

  openQuick(all: boolean) {
    const msg = this.msg;
    const account = this.account;
    if (!msg || !account) return;
    const me = { name: account.display_name, email: account.email };
    // No format switch here: the answer goes in the mailbox's format.
    const draft = withSignature(reply(msg, me, all, formatFor(account, app.settingsCtl.settings)), replySignature(account));
    this.quick = { account_id: account.id, email: account.email, draft, all, to: msg.row.id };
    queueMicrotask(() => this.box?.focus());
  }

  /** "All" in the open box: the recipients change, what was typed stays. */
  setAll(all: boolean) {
    const msg = this.msg;
    const account = this.account;
    if (!msg || !account || !this.quick) return;
    const me = { name: account.display_name, email: account.email };
    this.quick = { ...this.quick, all, draft: withSignature(reply(msg, me, all, this.quick.draft.format), replySignature(account)) };
    this.box?.focus();
  }

  private draft(q: NonNullable<typeof this.quick>): ComposeDraft {
    if (q.draft.format !== "html") return { ...q.draft, text: this.text.trimEnd() + q.draft.text };
    // In an HTML mailbox: paragraphs by empty lines, addresses as links, above the empty line
    // the reply keeps over its signature — not instead of it, or the caret has nowhere to go (#61).
    const html = paragraphsHtml(this.text) + (q.draft.html ?? "");
    return { ...q.draft, html, text: htmlLetterText(html) };
  }

  /** Moves what was typed into a composition window; nothing typed is lost. */
  toWindow(mode: "open" | "min" = "open") {
    if (this.quick) app.openCompose({ account_id: this.quick.account_id, draft: this.draft(this.quick), draft_id: null, unsaved: true }, mode);
    this.quick = null;
    this.text = "";
  }

  async send() {
    const q = this.quick;
    if (!q || !this.text.trim() || this.busy) return;
    const draft = this.draft(q);
    this.busy = true;
    try {
      const found = await sendWarnings(draft, q.email);
      // Warnings are read and answered in the full window.
      if (found.length) return this.toWindow();
      await app.send(q.account_id, draft, null, null, null, null);
      this.quick = null;
      this.text = "";
    } catch (e) {
      app.ui.fail(e);
    } finally {
      this.busy = false;
      // Not sent and another letter opened meanwhile: the answer is kept in a window.
      this.leaveIfMoved();
    }
  }

  onKey(e: KeyboardEvent) {
    // The keys of the composition window: Ctrl+Enter sends, Esc folds, unless changed.
    const action = composeAction(e);
    if (action === "send") {
      e.preventDefault();
      this.send();
    } else if (action === "fold") {
      e.preventDefault();
      e.stopPropagation();
      if (this.text.trim()) this.toWindow("min");
      else this.quick = null;
    }
  }
}

/** The quick answer under the conversation: the state and the actions, no markup. */
export function useQuickReply(host: QuickReplyHost): QuickReplyState {
  return new QuickReplyState(host);
}

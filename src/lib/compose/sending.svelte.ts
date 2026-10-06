// Sending a letter: the checks before it goes, the send options plugins set, the keys of
// the window, closing, discarding and folding. The window (Compose.svelte) owns the
// wording of its messages and its markup, so every `t("…")` stays in a component.

import { api } from "../api";
import { sendWarnings } from "../sendChecks";
import { composeAction } from "../composeKeys";
import { isDirty } from "../compose";
import { registry } from "../../plugin-host/registry.svelte";
import type { ComposeWindow } from "../composes.svelte";
import type { AccountView, ComposeDraft } from "../types";
import type { ComposeContext, FollowupPlan } from "../../plugin-api";
import type { ComposeFormat } from "./format.svelte";
import type { ComposeAutosave } from "./autosave.svelte";

/** What sending and the window's own keys need from the component. */
export interface ComposeSendHost {
  readonly win: ComposeWindow;
  /** The letter's body: where text goes in, and the format the keys depend on. */
  readonly format: ComposeFormat;
  /** The draft saves itself; sending waits for the save it started. */
  readonly autosave: ComposeAutosave;
  account(id: string): AccountView | undefined;
  fail(e: unknown, prefix?: string): void;
  toast(text: string): void;
  /** Sends the letter through the outbox and closes the window when it is queued. */
  sendApp(accountId: string, draft: ComposeDraft, draftId: number | null, at: number | null, followupSecs: number | null, followup: FollowupPlan | null): Promise<void>;
  closeCompose(id: number): void;
  showCompose(id: number, mode?: "open" | "max"): void;
  /** The address fields were committed; false when something could not be parsed. */
  commitAll(): boolean;
  /** A failed send shows its message in the window; a new send clears it. */
  setError(message: string): void;
  clearError(): void;
  badAddresses(): string;
  noRecipients(): string;
  draftSaved(): string;
  /** Asks before closing with unsaved changes; true when the user keeps the draft. */
  confirmClose(): Promise<boolean>;
  /** Asks before discarding the draft; true when the user agreed. */
  confirmDiscard(): Promise<boolean>;
}

export class ComposeSending {
  busy = $state(false);
  /** Warnings the user has to look at before the message goes; null when not checked yet. */
  warnings = $state<string[] | null>(null);
  /** The time the warnings wait for, when the send was scheduled. */
  pendingAt: number | null = null;
  /** What plugins see of this window; they set the send options. */
  followupDays = $state<number | null>(null);
  followupSecs = $state<number | null>(null);
  followup = $state<FollowupPlan | null>(null);
  /** The controls plugins put in this window, in their order. */
  readonly controls = $derived([...registry.items("composeControls")].sort((a, b) => (a.order ?? 50) - (b.order ?? 50)));

  /** What plugins see of the window; the component passes it to their controls. */
  options!: ComposeContext["options"];
  composeCtx!: ComposeContext;

  /** One send at a time: Ctrl+Enter pressed again while the checks run must not queue twice. */
  private sending = false;

  constructor(private host: ComposeSendHost) {
    this.options = makeOptions(host, this);
    this.composeCtx = makeContext(host, this);
  }

  private get win() {
    return this.host.win;
  }

  /** `at`: scheduled time; `force`: the warnings were seen and accepted. */
  async send(at: number | null = null, force = false) {
    if (this.sending) return;
    this.sending = true;
    try {
      await this.sendOnce(at, force);
    } finally {
      this.sending = false;
    }
  }

  private async sendOnce(at: number | null, force: boolean) {
    const { win } = this.host;
    this.host.clearError();
    if (!this.host.commitAll()) {
      this.host.setError(this.host.badAddresses());
      return;
    }
    if (win.draft.to.length + win.draft.cc.length + win.draft.bcc.length === 0) {
      this.host.setError(this.host.noRecipients());
      return;
    }
    if (!force) {
      const email = this.host.account(win.account_id)?.email ?? "";
      const draft = $state.snapshot(win.draft);
      this.busy = true;
      let found: string[];
      try {
        // A plugin's check may throw: the window must not stay busy and unclosable.
        found = await sendWarnings(draft, email);
      } finally {
        this.busy = false;
      }
      if (found.length) {
        this.warnings = found;
        this.pendingAt = at;
        return;
      }
    }
    this.warnings = null;
    this.busy = true;
    try {
      // The saved draft goes away once the letter is sent: the latest copy must be known.
      this.host.autosave.cancel();
      await this.host.autosave.settled();
      await this.host.sendApp(win.account_id, $state.snapshot(win.draft), win.draft_id, at ?? this.options.at, this.options.followupSecs ?? (this.options.followupDays ? this.options.followupDays * 86_400 : null), this.options.followup);
      this.host.closeCompose(win.id);
    } catch (e) {
      this.host.setError((e as { message: string }).message);
    } finally {
      this.busy = false;
    }
  }

  async close() {
    const { win } = this.host;
    if (this.busy) return;
    this.host.commitAll();
    if (this.host.autosave.changed() && !(await this.host.autosave.save())) {
      if (!(await this.host.confirmClose())) return;
    }
    if (win.draft_id !== null) this.host.toast(this.host.draftSaved());
    this.host.closeCompose(win.id);
  }

  async discard() {
    const { win } = this.host;
    if (this.busy) return;
    if (isDirty(win.draft)) {
      if (!(await this.host.confirmDiscard())) return;
    }
    this.host.autosave.cancel();
    await this.host.autosave.settled();
    if (win.draft_id !== null) api.draftDiscard(win.draft_id).catch((e) => this.host.fail(e));
    this.host.closeCompose(win.id);
  }

  minimize() {
    this.host.commitAll();
    this.host.win.mode = "min";
    void this.host.autosave.save();
  }

  toggleMax() {
    if (this.host.win.mode === "max") this.host.win.mode = "open";
    else this.host.showCompose(this.host.win.id, "max");
  }

  /** The window's keys come from one table (lib/composeKeys.ts); Ctrl+K is left to the palette. */
  onKey(e: KeyboardEvent) {
    const { win, format } = this.host;
    const action = composeAction(e);
    if (action === "send") {
      e.preventDefault();
      void this.send(null, this.warnings !== null);
    } else if (action === "fold") {
      // Gmail's way: Esc leaves full screen, then folds the window; the draft stays.
      e.preventDefault();
      if (win.mode === "max") win.mode = "open";
      else this.minimize();
    } else if (action === "link" && format.format !== "plain") {
      e.preventDefault();
      format.bar?.startLink();
    } else if (action === "preview" && format.format === "markdown") {
      e.preventDefault();
      format.preview = !format.preview;
    } else if ((action === "bold" || action === "italic" || action === "underline") && format.format === "markdown" && !format.preview) {
      // The HTML editor does these itself; in Markdown they type the markup.
      e.preventDefault();
      format.bar?.run(action);
    }
  }
}

/** The send options plugins set: the time and the followup of this letter. */
function makeOptions(host: ComposeSendHost, me: ComposeSending): ComposeContext["options"] {
  return {
    get at() {
      return host.win.draft.send_at ?? null;
    },
    set at(v) {
      host.win.draft.send_at = v;
    },
    get followupDays() {
      return me.followupDays;
    },
    set followupDays(v) {
      me.followupDays = v;
    },
    get followupSecs() {
      return me.followupSecs;
    },
    set followupSecs(v) {
      me.followupSecs = v;
    },
    get followup() {
      return me.followup;
    },
    set followup(v) {
      me.followup = v;
    },
  };
}

/** What plugins see of the window: the draft, the account, the options and `send`. */
function makeContext(host: ComposeSendHost, me: ComposeSending): ComposeContext {
  return {
    get draft() {
      return host.win.draft;
    },
    accountEmail: () => host.account(host.win.account_id)?.email ?? "",
    insertText: (text: string) => host.format.insertText(text),
    options: me.options,
    send: (at) => void me.send(at ?? null),
  };
}

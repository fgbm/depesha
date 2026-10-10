// Sending a letter: the checks before it goes, the send options plugins set, the keys of
// the window, closing, discarding and folding. The window (Compose.svelte) hands over only
// what is its own: the letter, the fields and the error line; the store and the words are
// reached directly.

import { api } from "../api";
import { app } from "../store.svelte";
import { t } from "../i18n.svelte";
import { hints } from "../hints.svelte";
import { sendWarnings } from "../sendChecks";
import { composeAction } from "../composeKeys";
import { isDirty } from "../compose";
import { registry } from "../../plugin-host/registry.svelte";
import type { ComposeWindow } from "../composes.svelte";
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
  /** The address fields were committed; false when something could not be parsed. */
  commitAll(): boolean;
  /** A failed send shows its message in the window; a new send clears it. */
  setError(message: string): void;
  clearError(): void;
  /** The Alt keys of the window (#103): open or switch the part of the letter the key stands for. */
  openPart(part: WindowPart): void;
}

/** What the window's own Alt keys open: the fields, the menus and the strips of the letter. */
export type WindowPart = "cc" | "bcc" | "from" | "files" | "quote" | "format" | "more";
const PARTS: ReadonlySet<string> = new Set<WindowPart>(["cc", "bcc", "from", "files", "quote", "format", "more"]);

/** A save that would hold a close is waited for this long, then let go (#71). */
const CLOSE_SAVE_MS = 4000;

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
  /** The answer takes its letter to wait in the folder; null: as the mailbox says. */
  park = $state<boolean | null>(null);
  /** The controls plugins put in this window, in their order. */
  readonly controls = $derived([...registry.items("composeControls")].sort((a, b) => (a.order ?? 50) - (b.order ?? 50)));

  /** What plugins see of the window; the component passes it to their controls. */
  options!: ComposeContext["options"];
  composeCtx!: ComposeContext;

  /** One send at a time: Ctrl+Enter pressed again while the checks run must not queue twice. */
  private sending = false;

  /** The Alt keys that belong to a plugin's control (the wait line): who answers each, and how. */
  private pluginKeys = new Map<"park" | "remind", { owner: string; run: () => void }>();

  /** The context each plugin's controls get: the same window, its own name on what it registers. */
  private contexts = new Map<string, ComposeContext>();

  /** A plugin's control answers the key of its action; one owner for each action. A key already
   *  answered by another, or asked for without a name, is refused with a warning, and the way to
   *  stop answering does nothing. Returns the way to stop answering. */
  onAction(action: "park" | "remind", run: () => void, owner = ""): () => void {
    const taken = this.pluginKeys.get(action);
    if (!owner || (taken && taken.owner !== owner)) {
      console.warn(`The key of «${action}» is not given to ${owner || "a caller without a name"}: ${taken ? `${taken.owner} answers it` : "the owner is not known"}`);
      return () => {};
    }
    const mine = { owner, run };
    this.pluginKeys.set(action, mine);
    return () => {
      if (this.pluginKeys.get(action) === mine) this.pluginKeys.delete(action);
    };
  }

  /** What `item`'s plugin sees of the window. The same object each time: plugins key their state by it. */
  contextFor(item: unknown): ComposeContext {
    const owner = registry.lists.composeControls.find((x) => x.item === item)?.owner ?? "";
    let ctx = this.contexts.get(owner);
    if (!ctx) {
      // Inherits the getters of the window's context (the draft is live), overrides one call.
      ctx = Object.create(this.composeCtx, { onAction: { value: (action: "park" | "remind", run: () => void) => this.onAction(action, run, owner) } }) as ComposeContext;
      this.contexts.set(owner, ctx);
    }
    return ctx;
  }

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
      this.host.setError(t("compose.badAddresses"));
      return;
    }
    if (win.draft.to.length + win.draft.cc.length + win.draft.bcc.length === 0) {
      this.host.setError(t("compose.noRecipients"));
      return;
    }
    if (!force) {
      const email = app.mailboxes.account(win.account_id)?.email ?? "";
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
      const draft = $state.snapshot(win.draft);
      // The detector of #69 counts a Markdown letter sent to a person without a rule.
      void hints.recordSend(draft);
      await app.compose.send(win.account_id, draft, win.draft_id, win.draft_message_id ?? null, at ?? this.options.at, this.options.followupSecs ?? (this.options.followupDays ? this.options.followupDays * 86_400 : null), withArchive(this.options.followup, this.park));
      // The letter left: its local copy is done with.
      await this.host.autosave.forgetLocal("sent");
      app.compose.close(win.id);
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
    // The draft is kept before the window goes; a slow server is not waited for past the limit.
    if (this.host.autosave.changed() && !(await within(this.host.autosave.save(true), CLOSE_SAVE_MS))) {
      if (!(await app.ui.confirm({ text: t("compose.closeAnyway"), okLabel: t("close"), cancelLabel: t("compose.goBack"), danger: true }))) return;
    }
    if (win.draft_id !== null) app.ui.toast(t("compose.draftSaved"));
    app.compose.close(win.id);
  }

  async discard() {
    const { win } = this.host;
    if (this.busy) return;
    if (isDirty(win.draft)) {
      if (!(await app.ui.confirm({ text: t("compose.discardConfirm"), okLabel: t("act.delete"), danger: true }))) return;
    }
    this.host.autosave.cancel();
    await this.host.autosave.settled();
    await this.host.autosave.forgetLocal("discard");
    if (win.draft_id !== null) api.draftDiscard(win.account_id, win.draft_id, win.draft_message_id ?? null).catch((e) => app.ui.fail(e));
    app.compose.close(win.id);
  }

  minimize() {
    this.host.commitAll();
    this.host.win.mode = "min";
    // Folding keeps the letter: it is written to the server and to the local copy at once.
    void within(this.host.autosave.save(true), CLOSE_SAVE_MS);
  }

  /** Saves the draft now, without waiting for the autosave: «⋯» → «Сохранить черновик», Ctrl+S. */
  saveDraft() {
    this.host.commitAll();
    void this.host.autosave.save();
  }

  /** «High importance» (#72, 4.1 А): the letter asks to be read first. The other levels are not offered. */
  toggleImportance() {
    const { draft } = this.host.win;
    // Off removes the field: a letter put back to normal is the draft it was, not a changed one.
    if (draft.importance === "high") delete draft.importance;
    else draft.importance = "high";
  }

  toggleMax() {
    if (this.host.win.mode === "max") this.host.win.mode = "open";
    else app.compose.show(this.host.win.id, "max");
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
    } else if (action === "save") {
      e.preventDefault();
      this.saveDraft();
    } else if (action === "importance") {
      e.preventDefault();
      this.toggleImportance();
    } else if (action && PARTS.has(action)) {
      e.preventDefault();
      this.host.openPart(action as WindowPart);
    } else if (action === "park" || action === "remind") {
      // Only when the wait line has the control: a letter that cannot wait lets the key go.
      const run = this.pluginKeys.get(action)?.run;
      if (run) {
        e.preventDefault();
        run();
      }
    } else if (action === "link" && format.format !== "plain") {
      e.preventDefault();
      format.bar?.startLink();
    } else if (action === "preview" && format.format === "markdown") {
      e.preventDefault();
      format.markup = !format.markup;
    } else if (action && format.format === "markdown" && this.markdownKey(action)) {
      e.preventDefault();
    }
  }

  /** The keys that type markup: bold, italic, underline (the HTML editor does these itself), headings and code (#45, frame 16 В). */
  private markdownKey(action: string): boolean {
    const bar = this.host.format.bar;
    if (action === "bold" || action === "italic" || action === "underline" || action === "code") bar?.run(action);
    else if (action.startsWith("heading")) bar?.heading(Number(action.slice(-1)));
    else return false;
    return true;
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
    get park() {
      return me.park;
    },
    set park(v) {
      me.park = v;
    },
  };
}

/**
 * The box "Take the letter out of the inbox" is a request to archive it (#106). It adds no
 * wait: the plan keeps the deadline and the reminder the user chose, "No reminder" none.
 */
export function withArchive(plan: FollowupPlan | null, archive: boolean | null): FollowupPlan | null {
  if (archive === null) return plan;
  return { ...(plan ?? { deadline_secs: 0, repeat_secs: 0, expect: "", kind: "" }), archive };
}

/** `p`, or `undefined` once `ms` passed: a save that would hold a close is let go (#71). */
function within<T>(p: Promise<T>, ms: number): Promise<T | undefined> {
  return Promise.race([p, new Promise<undefined>((r) => setTimeout(r, ms))]);
}

/** What plugins see of the window: the draft, the account, the options and `send`. */
function makeContext(host: ComposeSendHost, me: ComposeSending): ComposeContext {
  return {
    get draft() {
      return host.win.draft;
    },
    accountEmail: () => app.mailboxes.account(host.win.account_id)?.email ?? "",
    accountId: () => host.win.account_id,
    accountColor: () => app.mailboxes.accountColor(host.win.account_id),
    insertText: (text: string) => host.format.insertText(text),
    options: me.options,
    onAction: (action, run) => me.onAction(action, run),
    send: (at) => void me.send(at ?? null),
  };
}

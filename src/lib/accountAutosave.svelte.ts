// A mailbox's page saves what does not touch the connection as it is changed (#102, 1.7 Б): the
// format, the view, the signatures, the folder of attachments, the limits, the name and the
// colour. The row says «saved», a toast offers to take it back, Ctrl+Z does the same. What
// reaches the server (the server, the ports, the login, the password, the sign-in) waits for
// «Check and save»: it cannot be reconnected with every letter typed.

import { api, asError } from "./api";
import type { AccountForm } from "./accountForm.svelte";
import { t, type Key } from "./i18n.svelte";
import { SettingsAutosave } from "./settingsAutosave.svelte";
import { app } from "./store.svelte";
import type { Account } from "./types";

/** How long typing may pause before what is typed is saved. */
const PAUSE_MS = 600;

/** The fields of a mailbox that do not reach the server, with the name the toast gives them. */
const OWN: Record<string, Key> = {
  label: "account.section.general",
  color: "account.section.general",
  display_name: "account.section.general",
  save_sent_copy: "account.section.general",
  signatures: "account.signatures.title",
  default_signature: "account.signatures.title",
  reply_signature: "account.signatures.title",
  attachments_dir: "wizard.attachmentsDir",
  compose_format: "wizard.composeFormat",
  letter_view: "settings.letterView",
  waiting: "account.waiting.title",
  quota_warn: "storage.warnings",
  quota_limit_mb: "storage.warnings",
};

/** The own fields of a mailbox in one shape, so what is saved and what is typed compare by value. */
export function ownOf(a: Account): Record<string, unknown> {
  const w = a.waiting;
  return {
    label: (a.label ?? "").trim(),
    color: a.color ?? "",
    display_name: a.display_name.trim(),
    save_sent_copy: a.save_sent_copy,
    signatures: a.signatures ?? [],
    default_signature: a.default_signature ?? null,
    reply_signature: a.reply_signature ?? null,
    attachments_dir: (a.attachments_dir ?? "").trim(),
    compose_format: a.compose_format ?? "",
    letter_view: a.letter_view ?? "",
    waiting: { park: !!w?.park, folder: w?.folder ?? "", stop_to_archive: !!w?.stop_to_archive },
    quota_warn: a.quota_warn !== false,
    quota_limit_mb: a.quota_limit_mb ?? 0,
  };
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export class AccountAutosave {
  readonly auto: SettingsAutosave;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private chain: Promise<void> = Promise.resolve();
  /**
   * What the fields said when they were last in step with the saved mailbox. A field that still
   * says it is not a change: opening the page saves nothing, and a value the backend wrote down
   * in its own shape is not saved again and again.
   */
  private baseline: Record<string, unknown>;

  constructor(
    private form: AccountForm,
    private id: string,
  ) {
    this.auto = new SettingsAutosave({
      settings: () => ownOf(this.saved()),
      patch: (patch) => this.write(patch),
      toast: (text, action) => app.toast(text, false, action),
      dismiss: (toast) => app.dismiss(toast),
      // Taken back: the fields show what the mailbox is now.
      restored: () => {
        form.adopt(this.saved());
        this.baseline = ownOf(form.account());
      },
    });
    this.baseline = ownOf(form.account());
    form.settle = () => this.settled();
  }

  /** The mailbox as it is saved. */
  private saved(): Account {
    return app.accounts.find((a) => a.id === this.id) ?? this.form.existing!;
  }

  /** What the fields say that is not saved yet; null when nothing. */
  private diff(): Record<string, unknown> | null {
    const mine = ownOf(this.form.account());
    const saved = ownOf(this.saved());
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(OWN)) if (!same(mine[key], this.baseline[key]) && !same(mine[key], saved[key])) out[key] = mine[key];
    return Object.keys(out).length ? out : null;
  }

  /** The fields changed: save when the typing pauses. */
  touch() {
    clearTimeout(this.timer);
    if (this.diff()) this.timer = setTimeout(() => void this.flush(), PAUSE_MS);
  }

  /** Saves what is not saved now, one write after another. */
  flush(): Promise<void> {
    clearTimeout(this.timer);
    this.chain = this.chain.then(async () => {
      const patch = this.diff();
      if (!patch) return;
      const names = [...new Set(Object.keys(patch).map((k) => t(OWN[k])))].join(", ");
      if (await this.auto.commit("account", patch, t("account.autosaved", { names }), names)) Object.assign(this.baseline, patch);
    });
    return this.chain;
  }

  /** Everything typed is written and every write is done. */
  async settled(): Promise<void> {
    await this.flush();
    await this.auto.settled();
  }

  undo(): Promise<boolean> {
    return this.auto.undo();
  }

  private async write(patch: Record<string, unknown>) {
    const acc = { ...this.saved() } as Account & { status?: unknown };
    delete acc.status;
    Object.assign(acc, patch);
    // As `AccountForm.account()` leaves them out: no own format, view or queue is no key.
    if (!acc.compose_format) delete acc.compose_format;
    if (!acc.letter_view) delete acc.letter_view;
    const w = acc.waiting;
    if (w && !w.park && !w.folder && !w.stop_to_archive) delete acc.waiting;
    try {
      await api.accountSave(acc, null, null);
      await app.loadAccounts();
    } catch (e) {
      this.form.error = asError(e);
    }
  }
}

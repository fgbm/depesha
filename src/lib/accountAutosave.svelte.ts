// A mailbox's page saves what does not touch the connection as it is changed (#102, 1.7 Б): the
// format, the view, the signatures, the folder of attachments, the limits, the name and the
// colour. A pick (a list, a box, the colour) is saved at once, a text when its field is left or
// Enter is pressed. It goes through `account_patch_own`, which does not restart the mailbox's worker. The row says «saved», a toast offers to take it back, Ctrl+Z does the same. What
// reaches the server (the server, the ports, the login, the password, the sign-in) waits for
// «Check and save»: it cannot be reconnected with every letter typed.

import { api, asError } from "./api";
import type { AccountForm } from "./accountForm.svelte";
import { t, type Key } from "./i18n.svelte";
import { SettingsAutosave } from "./settingsAutosave.svelte";
import { app } from "./store.svelte";
import type { Account } from "./types";

/** How long a pick waits for the keys it changes together. */
const BATCH_MS = 40;

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

/** The patch in the groups its keys were changed in; keys no group names go last, together. */
function split(patch: Record<string, unknown>, groups: string[][]): Record<string, unknown>[] {
  const left = new Set(Object.keys(patch));
  const parts: Record<string, unknown>[] = [];
  for (const group of [...groups, [...left]]) {
    const part: Record<string, unknown> = {};
    for (const key of group) {
      if (!left.delete(key)) continue;
      part[key] = patch[key];
    }
    if (Object.keys(part).length) parts.push(part);
  }
  return parts;
}

export class AccountAutosave {
  readonly auto: SettingsAutosave;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private chain: Promise<void> = Promise.resolve();
  /** A text is being typed: it is saved when the field is left or Enter is pressed, not at every pause. */
  private typingNow = $state(false);
  /**
   * The keys in the order they were changed, one group for the keys one change moved: a check of
   * the connection holds the writes back, and what piled up goes in the same groups, so each is
   * one change to take back.
   */
  private batches: string[][] = [];
  /** The value each key had when it joined a group: a key changed again leaves its group for a new, last one. */
  private seen: Record<string, unknown> = {};
  /** The writes started and not done: while there are any, the text is still «not saved» to a quit. */
  private inflight = $state(0);
  /**
   * What the fields said when they were last in step with the saved mailbox. A field that still
   * says it is not a change: opening the page saves nothing, and a value the backend wrote down
   * in its own shape is not saved again and again.
   */
  private baseline: Record<string, unknown>;
  /** What the backend refused, by key: not sent again until the field says something else. */
  private refused: Record<string, unknown> = {};

  constructor(
    private form: AccountForm,
    private id: string,
  ) {
    this.auto = new SettingsAutosave({
      settings: () => ownOf(this.saved()),
      patch: (patch) => this.write(patch),
      toast: (text, action) => app.ui.toast(text, false, action),
      dismiss: (toast) => app.ui.dismiss(toast),
      // Taken back: the fields it concerned show what the mailbox is now, the others stay as typed.
      restored: (keys) => {
        form.adopt(this.saved(), keys);
        const now = ownOf(form.account());
        for (const key of keys) {
          this.baseline[key] = now[key];
          this.clear(key);
        }
      },
    });
    this.baseline = ownOf(form.account());
    form.settle = () => this.settled();
    form.afterConnection = () => this.flush(true);
    form.resume = () => this.touch();
  }

  /** The mailbox as it is saved. */
  private saved(): Account {
    return app.accounts.find((a) => a.id === this.id) ?? this.form.existing!;
  }

  private clear(key: string) {
    delete this.refused[key];
    delete this.form.fieldErrors[key];
  }

  /** What the fields say that is not saved yet; null when nothing. */
  private diff(): Record<string, unknown> | null {
    const mine = ownOf(this.form.account());
    const saved = ownOf(this.saved());
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(OWN)) {
      // A limit that is not a number yet («5,») is not a limit: the form would give the last good one back.
      if (key === "quota_limit_mb" && this.form.limitError) continue;
      if (key in this.refused) {
        if (same(mine[key], this.refused[key])) continue;
        this.clear(key);
      }
      if (!same(mine[key], this.baseline[key]) && !same(mine[key], saved[key])) out[key] = mine[key];
    }
    return Object.keys(out).length ? out : null;
  }

  /** A text is typed in a field of the page and not yet left. */
  get typing(): boolean {
    return this.typingNow || this.inflight > 0;
  }

  /** A text is typed in a field of the page. */
  typed() {
    this.typingNow = true;
  }

  /** The field was left or Enter was pressed: what was typed is saved now. */
  commit() {
    this.typingNow = false;
    void this.flush();
  }

  /** The fields changed: a pick is saved at once, a text when it is committed. */
  touch() {
    clearTimeout(this.timer);
    const changed = this.diff();
    if (changed) {
      const fresh: string[] = [];
      for (const [key, value] of Object.entries(changed)) {
        if (key in this.seen && same(this.seen[key], value)) continue;
        for (const group of this.batches) {
          const at = group.indexOf(key);
          if (at >= 0) group.splice(at, 1);
        }
        this.seen[key] = value;
        fresh.push(key);
      }
      if (fresh.length) this.batches.push(fresh);
    }
    if (this.typingNow || !changed) return;
    // A moment, so the keys one pick changes together go in one write.
    this.timer = setTimeout(() => void this.flush(), BATCH_MS);
  }

  /** Saves what is not saved now, one write after another; not during a check of the connection, which sends it after. */
  flush(force = false): Promise<void> {
    clearTimeout(this.timer);
    this.inflight++;
    // One failed write is told and is not the next one's: the chain goes on.
    this.chain = this.chain
      .then(async () => {
        if (this.form.busy && !force) return;
        const patch = this.diff();
        if (!patch) {
          this.batches = [];
          this.seen = {};
          return;
        }
        const groups = this.batches;
        this.batches = [];
        this.seen = {};
        for (const part of split(patch, groups)) await this.save(part);
      })
      .catch((e) => app.ui.fail(e))
      .finally(() => this.inflight--);
    return this.chain;
  }

  /** One change: written, said, and the fields that stand as written are in step with the mailbox. */
  private async save(patch: Record<string, unknown>) {
    const names = (keys: string[]) => [...new Set(keys.map((k) => t(OWN[k])))].join(", ");
    await this.auto.commitWords("account", patch, (keys) => t("account.autosaved", { names: names(keys) }), names);
    for (const key of Object.keys(patch)) {
      if (key in this.refused) continue;
      // Written, or turned into something else by the backend (a name left empty is the address):
      // the field still says what it said, which is not a change to send again at every focusout.
      this.baseline[key] = patch[key];
    }
  }

  /** Everything typed is written and every write is done. */
  async settled(): Promise<void> {
    // Typing ends only when the text is written: a quit that sees it end lets the window go.
    await this.flush(true);
    await this.auto.settled();
    this.typingNow = false;
  }

  /** Takes the last change back, after what is typed is written: the last change is the one the user just made. */
  async undo(): Promise<boolean> {
    await this.settled();
    return this.auto.undo();
  }

  private async send(patch: Record<string, unknown>) {
    // The wire has no null: «no signature» is an empty id.
    const wire = { ...patch };
    for (const k of ["default_signature", "reply_signature"]) if (k in wire && wire[k] === null) wire[k] = "";
    await api.accountPatchOwn(this.id, wire);
  }

  /** Writes the patch; answers the keys the backend refused. */
  private async write(patch: Record<string, unknown>): Promise<string[]> {
    const refused: string[] = [];
    try {
      await this.send(patch);
    } catch (e) {
      const keys = Object.keys(patch);
      // One refused field must not hold the rest back: each is sent by itself to find which.
      if (keys.length === 1) {
        this.refuse(keys[0], patch[keys[0]], e);
        refused.push(keys[0]);
      } else {
        for (const key of keys) {
          try {
            await this.send({ [key]: patch[key] });
          } catch (err) {
            this.refuse(key, patch[key], err);
            refused.push(key);
          }
        }
      }
    }
    await app.loadAccounts();
    return refused;
  }

  private refuse(key: string, value: unknown, e: unknown) {
    this.refused[key] = value;
    this.form.fieldErrors[key] = asError(e).message;
  }
}

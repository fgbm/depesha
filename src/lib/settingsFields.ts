// What the settings search finds (#68, #102): the pages of the menu and every row of them,
// read off the catalog, so a row added there is found with no second list to keep; the fields of
// a mailbox's page (0.8.12, 4.2 А). The mailboxes, the commands of «Keys» and the plugins' groups
// join the index in the window, which knows them.

import { t } from "./i18n.svelte";
import type { Key } from "./i18n.svelte";
import { accountLabel } from "./format";
import { MENU, PAGES, pageTitle, type RowContext } from "./settingsCatalog";
import type { SearchEntry } from "./settingsSearch";
import type { AccountView } from "./types";

const NONE: RowContext = { accounts: [], noTray: false };

/** The fields of a person's card: the card is not a page of the settings any more (#104), but a hit on one of its fields leads to the book. */
const PEOPLE_FIELDS: { anchor: string; label: Key; also?: Key[] }[] = [
  { anchor: "people-name", label: "people.name" },
  { anchor: "people-send", label: "people.sendFormat", also: ["format.html", "format.markdown", "format.plain", "people.asUsual"] },
  { anchor: "people-view", label: "people.view", also: ["letterView.html", "letterView.markdown", "letterView.text"] },
  { anchor: "people-note", label: "people.note" },
  { anchor: "people-hide", label: "people.hide" },
  { anchor: "people-addresses", label: "people.addresses" },
];

/** One entry per page (so its name alone finds it) and one per row, with the words that also find it. */
export function buildSettingsIndex(): SearchEntry[] {
  const out: SearchEntry[] = [];
  for (const id of MENU.flatMap((g) => g.pages)) {
    const title = pageTitle(id);
    out.push({ page: id, group: title, section: "", label: title, anchor: null });
  }
  for (const page of PAGES) {
    for (const g of page.groups) {
      for (const row of g.rows) {
        if (row.kind === "layer" || row.visible) continue;
        const words = [...(row.also?.() ?? []), ...(row.kind === "choice" ? row.options(NONE).map((o) => o.label()) : [])];
        out.push({ page: page.id, group: page.title(), section: g.title?.() ?? "", label: row.label(), synonyms: words.join(" "), anchor: row.id });
      }
    }
  }
  out.push({ page: "people", group: t("people.title"), section: "", label: t("people.title"), synonyms: t("cmd.peopleAlso"), anchor: null });
  for (const f of PEOPLE_FIELDS) {
    out.push({ page: "people", group: t("people.title"), section: t("people.card"), label: t(f.label), synonyms: f.also?.map((k) => t(k)).join(" ") ?? "", anchor: f.anchor });
  }
  return out;
}

/** The fields of a mailbox's page, by section; the anchor is the row's `data-settings`. */
const MAILBOX_FIELDS: { anchor: string; section: Key; label: Key; also?: Key[]; imap?: boolean; ews?: boolean }[] = [
  { anchor: "acc-label", section: "account.section.general", label: "wizard.mailboxName" },
  { anchor: "acc-name", section: "account.section.general", label: "account.senderName" },
  { anchor: "acc-color", section: "account.section.general", label: "account.colorRow" },
  { anchor: "acc-format", section: "account.section.letters", label: "wizard.composeFormat", also: ["format.html", "format.markdown", "format.plain"] },
  { anchor: "acc-view", section: "account.section.letters", label: "settings.letterView" },
  { anchor: "acc-attachments", section: "account.section.letters", label: "wizard.attachmentsDir" },
  { anchor: "acc-signatures", section: "account.section.letters", label: "account.signatures.title" },
  { anchor: "acc-waiting", section: "account.section.letters", label: "account.waiting.park", also: ["account.waiting.title"] },
  { anchor: "acc-login", section: "account.connection", label: "wizard.login" },
  { anchor: "acc-password", section: "account.connection", label: "wizard.password" },
  { anchor: "acc-imap", section: "account.connection", label: "wizard.incoming", also: ["wizard.server", "wizard.port", "wizard.security"], imap: true },
  { anchor: "acc-smtp", section: "account.connection", label: "wizard.outgoing", also: ["wizard.server", "wizard.port", "wizard.security"], imap: true },
  { anchor: "acc-ews", section: "account.connection", label: "wizard.ewsUrl", ews: true },
  { anchor: "acc-sent", section: "account.connection", label: "account.saveSent", imap: true },
  { anchor: "acc-storage", section: "account.section.storage", label: "account.section.storage", also: ["storage.own", "storage.cache"] },
  { anchor: "acc-server", section: "account.section.server", label: "account.section.server", imap: true },
  { anchor: "acc-labels", section: "account.section.labels", label: "account.section.labels" },
  { anchor: "acc-remove", section: "account.danger", label: "wizard.remove" },
];

/** The fields of every mailbox's page, under the mailbox's name. */
export function mailboxIndex(accounts: AccountView[]): SearchEntry[] {
  return accounts.flatMap((a) =>
    MAILBOX_FIELDS.filter((f) => !(f.imap && a.ews) && !(f.ews && !a.ews)).map((f) => ({
      page: `account:${a.id}`,
      group: accountLabel(a),
      section: t(f.section),
      label: t(f.label),
      synonyms: f.also?.map((k) => t(k)).join(" ") ?? "",
      anchor: f.anchor,
    })),
  );
}

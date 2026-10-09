// The layers of a setting (#102, 3.1 В): the general value, the mailbox's own and the person's
// own. The general setting says where the other layers differ from it («Own at 2 people, 1
// mailbox ›»), and the mailbox and the person say whether their value is their own or the
// next layer's, with a way back. Pure: the rows and the pages that carry the marks read these.

import { t, tn } from "./i18n.svelte";
import type { Person } from "./people";
import type { AccountView } from "./types";

export type Layer = "format" | "view";

export interface Exceptions {
  people: Person[];
  accounts: AccountView[];
}

type Owner = Pick<AccountView, "compose_format" | "letter_view">;

/** Whose value of this setting differs from the general one: set by hand, not left to the next layer. */
export function exceptions(layer: Layer, people: Person[], accounts: AccountView[]): Exceptions {
  const own = (a: Owner) => (layer === "format" ? !!a.compose_format : !!a.letter_view);
  return {
    people: people.filter((p) => (layer === "format" ? p.send_format !== "" : p.view !== "")),
    accounts: accounts.filter(own),
  };
}

export function exceptionCount(ex: Exceptions): number {
  return ex.people.length + ex.accounts.length;
}

/** «Own at 1 person, 2 mailboxes»; empty when nothing differs. */
export function layerSummary(ex: Exceptions): string {
  const parts: string[] = [];
  if (ex.people.length) parts.push(tn("settings.layerPeople", ex.people.length));
  if (ex.accounts.length) parts.push(tn("settings.layerMailboxes", ex.accounts.length));
  return parts.length ? t("settings.layerOwn", { list: parts.join(", ") }) : "";
}

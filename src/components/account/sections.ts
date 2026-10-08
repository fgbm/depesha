// The sections of a mailbox's page, in order. Each is a component of its own that gets the
// mailbox's form and the mailbox as it is now; a feature fills its section, the page and the
// table of contents follow this list.

import type { Component } from "svelte";
import { t } from "../../lib/i18n.svelte";
import type { AccountForm } from "../../lib/accountForm.svelte";
import type { AccountView } from "../../lib/types";
import { rooms } from "../../lib/room.svelte";
import { needsAttention } from "../../lib/serverFeatures";
import GeneralSection from "./GeneralSection.svelte";
import LettersSection from "./LettersSection.svelte";
import StorageSection from "./StorageSection.svelte";
import ServerSection from "./ServerSection.svelte";
import LabelsSection from "./LabelsSection.svelte";

export interface SectionProps {
  /** The fields saved by the page's buttons. */
  form: AccountForm;
  /** The saved mailbox with its connection's state. */
  account: AccountView;
}

export interface AccountSection {
  id: string;
  title: () => string;
  component: Component<SectionProps>;
  /** IMAP's own: an Exchange mailbox has no such section. */
  imapOnly?: boolean;
  /** Something in the section deserves a look: a dot beside its name in the contents. */
  attention?: (account: AccountView) => boolean;
}

export const ACCOUNT_SECTIONS: AccountSection[] = [
  { id: "general", title: () => t("account.section.general"), component: GeneralSection },
  { id: "letters", title: () => t("account.section.letters"), component: LettersSection },
  { id: "storage", title: () => t("account.section.storage"), component: StorageSection },
  {
    id: "server",
    title: () => t("account.section.server"),
    component: ServerSection,
    imapOnly: true,
    // No IDLE or no MOVE: the server slows Depesha down where the user sees it.
    attention: (a) => needsAttention(rooms.infos[a.id]?.caps?.capabilities),
  },
  // Labels are Depesha's own, on IMAP as an IMAP keyword and on Exchange as a category,
  // so the section stands for both (#42, frame 1A and 7).
  { id: "labels", title: () => t("account.section.labels"), component: LabelsSection },
];

export function sectionsFor(account: AccountView): AccountSection[] {
  return ACCOUNT_SECTIONS.filter((s) => !(s.imapOnly && account.ews));
}

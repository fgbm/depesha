import { registry } from "../plugin-host/registry.svelte";
import { accountLabel, roleLabel } from "./format";
import { t } from "./i18n.svelte";
import { app, type View } from "./store.svelte";

/** The name of a list: its heading, and the way back to it from a letter in a narrow window. */
export function viewTitle(v: View): string {
  if (v.kind === "search") return t("search.title");
  if (v.kind === "plugin") return registry.view(v.id)?.title() ?? "";
  if (v.kind === "unified") {
    if (v.unread) return t("nav.unread");
    if (v.flagged) return t("nav.flagged");
    return v.role === "drafts" ? t("nav.allDrafts") : t("nav.allInboxes");
  }
  if (v.kind === "folder") {
    const f = app.mailboxes.folder(v.account_id, v.folder);
    const acc = app.mailboxes.account(v.account_id);
    const name = f?.role ? roleLabel(f.role) : (f?.display_name ?? v.folder);
    return `${name}${app.mailboxes.accounts.length > 1 && acc ? ` · ${accountLabel(acc)}` : ""}`;
  }
  return "";
}

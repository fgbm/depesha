// Commands of the core: what any command UI (the palette plugin, menus) can offer.
// Plugins add their own through `ui.command`; the host merges both lists. Keys are not
// here: the palette shows each command's key from keyCommands.ts and Settings → Keys.

import type { Command } from "../plugin-api";
import { registry } from "../plugin-host/registry.svelte";
import { api } from "./api";
import { extensions, fromRow } from "./extensions.svelte";
import { accountLabel, roleLabel } from "./format";
import { t } from "./i18n.svelte";
import { readyQueries } from "./largeMail";
import { recentSearches } from "./recentSearches.svelte";
import { printOpened } from "./print";
import { PRESETS, RELEVANCE, reversed } from "./sort";
import { app, type View } from "./store.svelte";

const go = (v: View) => () => app.setView(v);

/** "Largest letters" in the middle of a phrase; "MB" stays as it is. */
const lowerFirst = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);

/** What needs the main window's list, folders or settings: a letter's own window has none of them. */
const MAIN_ONLY = /^core\.(search|ready\.|go\.|open\.|people$|sort\.|show\.|empty-folder$|settings$|plugins$|add-account$)/;

export function coreCommands(): Command[] {
  const msg = app.opened;
  const target = app.selectedIds();
  const list: Command[] = [{ id: "core.compose", title: () => t("cmd.compose"), run: () => app.newMessage() }];
  if (msg) {
    list.push(
      { id: "core.reply", title: () => t("act.reply"), run: () => app.replyTo(false) },
      { id: "core.reply-all", title: () => t("cmd.replyAll"), run: () => app.replyTo(true) },
      { id: "core.forward", title: () => t("act.forward"), run: () => app.forwardOpened() },
      { id: "core.print", title: () => t("act.print"), run: printOpened },
    );
  }
  if (target.length) {
    list.push(
      { id: "core.archive", title: () => t("cmd.done"), run: () => app.archive() },
      { id: "core.delete", title: () => t("act.delete"), run: () => app.remove() },
      { id: "core.spam", title: () => t("act.spam"), run: () => app.spam() },
      { id: "core.flag", title: () => t("cmd.flag"), run: () => msg && app.flag("flagged", !msg.row.flags.flagged) },
      { id: "core.unread", title: () => t("act.markUnread"), run: () => app.flag("seen", false) },
    );
    const account = msg?.row.account_id ?? app.messages.find((m) => m.id === target[0])?.account_id;
    for (const f of app.folders.filter((f) => f.account_id === account && f.selectable && !f.hidden)) {
      const folder = f.role ? roleLabel(f.role) : f.display_name;
      list.push({ id: `core.move.${f.name}`, title: () => t("cmd.moveTo", { folder }), run: () => app.moveTo(f.name) });
    }
  }
  // «Clear» (#74): one command, only in Trash, Spam and Drafts.
  const clear = app.clearing.here();
  if (clear) {
    list.push({
      id: "core.empty-folder",
      title: () => app.clearing.title(clear.role),
      run: () => void app.clearing.begin(clear.account_id, clear.folder.name),
    });
  }
  // Labels (#42, frame 10): on the selected rows, or on the open letter.
  if (target.length || msg) {
    const ids = target.length ? target : [msg!.row.id];
    list.push({ id: "core.labels", title: () => t("act.labels"), run: () => app.labels.openPick(ids) });
  }
  for (const c of extensions.commands()) {
    if (c.message && !msg) continue;
    const message = c.message && msg ? fromRow(msg.row, app.account(msg.row.account_id)?.email ?? "", msg.view.text) : null;
    list.push({ id: `ext.${c.ext.id}.${c.id}`, title: () => c.title, run: () => extensions.command(c.ext, c.id, message) });
  }
  const undo = app.lastUndo;
  if (undo) list.push({ id: "core.undo", title: () => t("cmd.undo", { what: undo.text }), run: () => app.undo() });

  if (app.listKey()) {
    // Search results keep an order of their own: the rank means nothing elsewhere.
    const search = app.view.kind === "search";
    for (const p of search ? [RELEVANCE, ...PRESETS] : PRESETS) {
      const how = t(`sort.preset.${p.id}`).toLowerCase();
      list.push({ id: `core.sort.${p.id}`, title: () => t("sort.cmd", { how }), run: () => app.setSort(p.sort, search || app.ownSort()) });
    }
    list.push({ id: "core.sort.reverse", title: () => t("sort.cmdReverse"), run: () => app.setSort(reversed(app.sort()), search || app.ownSort()) });
  }
  const lf = app.listFilter();
  if (lf) {
    for (const o of lf.filter.options()) {
      list.push({ id: `core.show.${o.id}`, title: () => t("sort.show", { what: o.title.toLowerCase() }), run: () => lf.filter.select(lf.list, o.id) });
    }
  }

  const where = (s: string) => () => t("cmd.go", { where: s.toLowerCase() });
  list.push(
    { id: "core.search", title: () => t("cmd.search"), run: () => app.focusSearch() },
  );
  // Ready queries, as the search box suggests them: each opens as a search, its text in
  // the search box; the hint shows that text. In a folder, also its large mail with subfolders.
  const v = app.view;
  for (const q of readyQueries(app.settings.large_mb, new Date(), v.kind === "folder" ? v.folder : null)) {
    list.push({
      id: `core.ready.${q.id}`,
      title: () => t("cmd.find", { what: lowerFirst(q.title) }),
      hint: () => q.text,
      run: () => {
        recentSearches.remember(q.text);
        app.setView({ kind: "search", text: q.text });
      },
    });
  }
  list.push(
    app.accounts.length > 1
      ? { id: "core.go.inboxes", title: where(t("nav.allInboxes")), run: go({ kind: "unified", role: "inbox" }) }
      : { id: "core.go.inboxes", title: where(roleLabel("inbox")), run: () => app.setView(app.home()) },
    { id: "core.go.unread", title: where(t("nav.unread")), run: go({ kind: "unified", role: "inbox", unread: true }) },
    { id: "core.go.flagged", title: where(t("nav.flagged")), run: go({ kind: "unified", role: "inbox", flagged: true }) },
  );
  if (app.accounts.length > 1) {
    list.push({ id: "core.go.drafts", title: where(t("nav.allDrafts")), run: go({ kind: "unified", role: "drafts" }) });
  }
  for (const v of registry.items("views")) {
    list.push({ id: `core.go.${v.id}`, title: where(v.title()), run: go({ kind: "plugin", id: v.id }) });
  }
  list.push({ id: "core.go.outbox", title: where(t("nav.outbox")), run: go({ kind: "outbox" }) });
  // The address book (#104): the folder, this command and, when the user gives it, a key.
  list.push({ id: "core.people", title: where(t("nav.people")), synonyms: () => t("cmd.peopleAlso"), run: () => void app.openPeople() });
  if (msg?.view.summary.from?.email) {
    list.push({ id: "core.sender-card", title: () => t("cmd.senderCard"), run: () => app.openSenderCard() });
  }

  const many = app.accounts.length > 1;
  for (const f of app.folders.filter((f) => f.selectable && !f.hidden)) {
    const acc = app.account(f.account_id);
    const name = f.role ? roleLabel(f.role) : f.display_name;
    const suffix = many && acc ? ` · ${accountLabel(acc)}` : "";
    list.push({
      id: `core.open.${f.account_id}.${f.name}`,
      title: () => t("cmd.openFolder", { folder: name }) + suffix,
      run: go({ kind: "folder", account_id: f.account_id, folder: f.name }),
    });
  }
  const dnd = app.settings.dnd_until > Date.now() / 1000;
  list.push(
    dnd
      ? { id: "core.dnd", title: () => t("cmd.dndOff"), run: () => void app.patchSettings({ dnd_until: 0 }) }
      : {
          id: "core.dnd",
          title: () => t("cmd.dndHour"),
          run: () => void app.patchSettings({ dnd_until: Math.floor(Date.now() / 1000) + 3600 }),
        },
    { id: "core.sync", title: () => t("cmd.sync"), run: () => api.syncNow().catch((e) => app.fail(e)) },
    { id: "core.settings", title: () => t("settings.title"), run: () => app.openSettings() },
    { id: "core.plugins", title: () => t("cmd.plugins"), run: () => app.openSettings("plugins") },
    { id: "core.add-account", title: () => t("cmd.addAccount"), run: () => app.accountSettings(null) },
  );
  return app.windowOf === null ? list : list.filter((c) => !MAIN_ONLY.test(c.id));
}

// Mail rules of extensions: what they decide for newly arrived mail is applied here.

import { api } from "./api";
import { extensions, textOf, type MailAction } from "./extensions.svelte";
import { t, tn } from "./i18n.svelte";
import type { AppStore } from "./store.svelte";
import type { MessageRow } from "./types";

type RulesHost = Pick<AppStore, "folders" | "account" | "toast" | "fail" | "reload">;

/** Mail rules of extensions on newly arrived mail. */
export async function applyRules(app: RulesHost, ids: number[]) {
  if (!extensions.enabled().some((e) => e.hooks.includes("newMail"))) return;
  const rows = await api.messagesById(ids).catch((e) => (app.fail(e), [] as MessageRow[]));
  if (!rows.length) return;
  const results = await extensions.newMail(rows, (id) => app.account(id)?.email ?? "");
  for (const { ext, actions } of results) {
    let done = 0;
    for (const a of actions) {
      try {
        await applyMailAction(app, a, rows.find((r) => r.id === a.id)!);
        done++;
      } catch (e) {
        app.fail(e, textOf(ext.name));
      }
    }
    if (done) app.toast(tn("ext.ruleApplied", done, { name: textOf(ext.name) }));
  }
  app.reload();
}

async function applyMailAction(app: RulesHost, a: MailAction, row: MessageRow) {
  const ids = [a.id];
  switch (a.do) {
    case "archive":
      return void (await api.archive(ids));
    case "read":
    case "unread":
      return api.setFlag(ids, { flag: "seen", value: a.do === "read" });
    case "flag":
      return api.setFlag(ids, { flag: "flagged", value: true });
    case "delete":
      return void (await api.remove(ids));
    case "spam":
      return void (await api.spam(ids));
    case "move": {
      const want = a.folder.toLowerCase();
      const f = app.folders.find(
        (x) => x.account_id === row.account_id && (x.name.toLowerCase() === want || x.display_name.toLowerCase() === want),
      );
      if (!f) throw new Error(t("ext.noFolder", { folder: a.folder }));
      return void (await api.move(ids, f.name));
    }
  }
}

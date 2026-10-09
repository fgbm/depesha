import { describe, expect, it } from "vitest";
import type { ActsOn, FolderInfo } from "@depesha/plugin-api";
import { sayIn } from "./fixtures";
import { queueBox, waitChosen } from "./queue";

const ru = sayIn("ru");
const folder = (name: string, display: string, role: FolderInfo["role"]): FolderInfo => ({ account_id: "a", name, display_name: display, delimiter: "/", role, selectable: true, hidden: false, total: 0, unread: 0 });
const folders = [folder("INBOX", "Входящие", "inbox"), folder("Archive", "Архив", "archive"), folder("INBOX/Проекты", "Проекты", null)];
const on = [{ id: "a", waiting: { park: true, folder: "", stop_to_archive: false } }];
const off = [{ id: "a" }];
const acts = (over: Partial<ActsOn> = {}): ActsOn => ({ account_id: "a", message_id: "m@x", folder: "INBOX", act: "reply", waiting: false, ...over });

describe("the checkbox «out of the inbox» of the compose window", () => {
  it("is on an answer to a letter of the inbox, ticked as the mailbox says, the window's choice first", () => {
    expect(queueBox(acts(), "a", on, folders, null, ru)).toEqual({ checked: true, disabled: false, text: "Убрать письмо из входящих", title: "Вместе с прочитанными письмами этой переписки" });
    expect(queueBox(acts({ act: "reply_all" }), "a", on, folders, false, ru)).toMatchObject({ checked: false, disabled: false });
  });

  it("is not there where the mailbox does not do it, for a forward, a new letter or another mailbox", () => {
    expect(queueBox(acts(), "a", off, folders, null, ru)).toBeNull();
    expect(queueBox(acts({ act: "forward" }), "a", on, folders, null, ru)).toBeNull();
    expect(queueBox(null, "a", on, folders, null, ru)).toBeNull();
    expect(queueBox(acts(), "b", [...on, { id: "b", waiting: { park: true, folder: "", stop_to_archive: false } }], folders, null, ru)).toBeNull();
  });

  it("an answer to a letter of another folder says it stays there", () => {
    expect(queueBox(acts({ folder: "Archive" }), "a", on, folders, null, ru)).toEqual({
      checked: false,
      disabled: true,
      text: "Письмо в папке «Архив», останется там",
      title: "Убираются только письма из «Входящих». Это письмо останется в папке «Архив».",
    });
    // A subfolder of the inbox is another folder.
    expect(queueBox(acts({ folder: "INBOX/Проекты" }), "a", on, folders, null, ru)).toMatchObject({ disabled: true, text: "Письмо в папке «Проекты», останется там" });
  });

  it("an answer to a letter already waiting says so", () => {
    expect(queueBox(acts({ waiting: true, folder: "INBOX/Ждут ответа" }), "a", on, folders, null, ru)).toEqual({ checked: true, disabled: true, text: "Письмо уже ждёт ответа" });
  });

  it("with a reminder chosen is greyed: the letter goes to «Ждут ответа» instead of the archive", () => {
    expect(queueBox(acts(), "a", on, folders, null, ru, true)).toEqual({ checked: false, disabled: true, text: "Убрать письмо из входящих", title: "Письмо уйдёт в «Ждут ответа»" });
    expect(queueBox(acts(), "a", on, folders, null, ru, false)).toMatchObject({ checked: true, disabled: false });
  });

  it("is greyed with the reason where the mailbox has no archive folder", () => {
    const noArchive = folders.filter((f) => f.role !== "archive");
    expect(queueBox(acts(), "a", on, noArchive, null, ru)).toEqual({ checked: false, disabled: true, text: "Убрать письмо из входящих", title: "У ящика нет папки архива" });
  });
});

describe("a wait chosen in the compose window", () => {
  const options = (over: Partial<Parameters<typeof waitChosen>[0]> = {}) => ({ at: null, followupDays: null, followupSecs: null, followup: null, park: null, ...over });
  it("is a reminder or a deadline; «Без напоминания» is none", () => {
    expect(waitChosen(options())).toBe(false);
    expect(waitChosen(options({ followupSecs: 0 }))).toBe(false);
    expect(waitChosen(options({ followupSecs: 86_400 }))).toBe(true);
    expect(waitChosen(options({ followupDays: 3 }))).toBe(true);
    expect(waitChosen(options({ followup: { deadline_secs: 3_600, repeat_secs: 0, expect: "", kind: "" } }))).toBe(true);
    expect(waitChosen(options({ followup: { deadline_secs: 0, repeat_secs: 0, expect: "", kind: "", archive: true } }))).toBe(false);
  });
});

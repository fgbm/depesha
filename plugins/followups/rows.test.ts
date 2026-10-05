import { describe, expect, it } from "vitest";
import { listDate } from "@depesha/plugin-api";
import { letter, sayIn, wait } from "./fixtures";
import { rowTag } from "./rows";

const ru = sayIn("ru");
const day = 86_400;
const now = 100 * day;

describe("a row of Waiting for reply", () => {
  it("says what is left in grey and how late in red, the choice's name in the first line", () => {
    const left = rowTag(letter(wait({ due: now + 2 * day, deadline: now + 2 * day, kind: "Через 2 рабочих дня" })), now, ru, true)!;
    expect(left).toMatchObject({ text: "осталось 2 дня", alert: false, note: { text: "Через 2 рабочих дня" } });
    const late = rowTag(letter(wait({ due: now - 3 * day, deadline: now - 3 * day })), now, ru, true)!;
    expect(late).toMatchObject({ text: "просрочено на 3 дня", alert: true });
    expect(late.note).toBeUndefined();
  });

  it("a deadline of its own is the note, and the time left counts to it", () => {
    const tag = rowTag(letter(wait({ due: now + day, deadline: now + 3 * day, own_deadline: true, kind: "За сутки до срока" })), now, ru, true)!;
    expect(tag.text).toBe("осталось 3 дня");
    expect(tag.note!.text).toBe(`срок ${listDate(now + 3 * day)}`);
  });

  it("an answer in green with its author and date; closed by hand in grey", () => {
    const answered = wait({ status: "answered", ended: now - day, answered_by: { name: "Иван Петров", email: "ivan@example.org" } });
    expect(rowTag(letter(answered), now, ru, true)).toMatchObject({ text: `ответ: Иван Петров, ${listDate(now - day)}`, good: true });
    const anon = wait({ status: "answered", ended: now - day });
    expect(rowTag(letter(anon), now, ru, true)!.text).toBe(`ответили ${listDate(now - day)}`);
    const closed = rowTag(letter(wait({ status: "closed", ended: now - 2 * day })), now, ru, true)!;
    expect(closed.text).toBe(`закрыто вручную ${listDate(now - 2 * day)}`);
    expect(closed.alert || closed.good).toBeFalsy();
  });

  it("ended waits are tagged only in the view: Sent does not fill up with them", () => {
    expect(rowTag(letter(wait({ status: "closed", ended: now })), now, ru, false)).toBeNull();
    expect(rowTag(letter(wait({ due: now + day, deadline: now + day })), now, ru, false)).not.toBeNull();
    expect(rowTag(letter(null), now, ru, true)).toBeNull();
  });
});

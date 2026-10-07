import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { listDate, when } from "@depesha/plugin-api";
import { incoming, letter, sayIn, wait } from "./fixtures";
import { rowTag } from "./rows";

const ru = sayIn("ru");
const day = 86_400;
// Noon of a fixed local day: "today" and "yesterday" are read in the runner's
// timezone, so a timestamp on a day boundary would drift with TZ (it did: the old
// `now = 100 * day` is midnight UTC, "yesterday" at TZ=UTC, "today" east of it).
const now = Math.floor(new Date(2026, 3, 10, 12, 0).getTime() / 1000);

// The clock is frozen at `now` as well, so listDate's default "now" is fixed too.
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(now * 1000);
});
afterEach(() => vi.useRealTimers());

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

describe("a row of the inbox whose answer takes it to wait", () => {
  const going = (scheduled: boolean, at = now + 60) => incoming({ outgoing: { act: "reply", at, park: true, scheduled } });

  it("says in blue where it goes while the answer leaves", () => {
    expect(rowTag(going(false), now, ru, false)).toMatchObject({ text: "в «Ждут ответа»", info: true });
    // The move is under way after sending too.
    const pending = incoming({ followup: wait({ due: 0, deadline: 0, park: "pending" }) });
    expect(rowTag(pending, now, ru, false)).toMatchObject({ text: "в «Ждут ответа»", info: true });
  });

  it("an answer sent later says when the letter goes", () => {
    const tag = rowTag(going(true, now + 3_600), now, ru, false)!;
    expect(tag).toMatchObject({ text: `уйдёт в «Ждут ответа» ${when(now + 3_600)}`, info: true });
  });

  it("an answer that is not going to wait is not told", () => {
    expect(rowTag(incoming({ outgoing: { act: "reply", at: now, park: false, scheduled: false } }), now, ru, false)).toBeNull();
    expect(rowTag(incoming({ outgoing: { act: "forward", at: now, park: false, scheduled: false } }), now, ru, false)).toBeNull();
  });

  it("back with the answer: green until opened", () => {
    expect(rowTag(incoming({ answer_came: true }), now, ru, false)).toMatchObject({ text: "пришёл ответ", good: true });
    expect(rowTag(incoming({ answer_came: false }), now, ru, false)).toBeNull();
  });
});

describe("a row of Waiting for reply that waits in the folder", () => {
  it("without a reminder says since when it waits", () => {
    const f = (sent: number) => incoming({ followup: wait({ due: 0, deadline: 0, park: "parked", sent }) });
    expect(rowTag(f(now - 600), now, ru, true)).toMatchObject({ text: "ждём с сегодня" });
    expect(rowTag(f(now - day), now, ru, true)).toMatchObject({ text: "ждём со вчера" });
    expect(rowTag(f(now - 5 * day), now, ru, true)).toMatchObject({ text: `ждём с ${listDate(now - 5 * day)}` });
    expect(rowTag(f(now - 600), now, ru, true)!.alert).toBeFalsy();
  });

  it("tells an auto-reply that did not count, or why the letter still waits is not seen", () => {
    const row = incoming({ followup: wait({ due: 0, deadline: 0, park: "parked", sent: now - 5 * day, auto_reply: now - 3 * day }) });
    expect(rowTag(row, now, ru, true)).toMatchObject({ text: `автоответ ${listDate(now - 3 * day)} — не в счёт` });
    // Overdue says it louder.
    const late = incoming({ followup: wait({ due: now - day, deadline: now - day, park: "parked", auto_reply: now - 3 * day }) });
    expect(rowTag(late, now, ru, true)).toMatchObject({ text: "просрочено на 1 день", alert: true });
  });

  it("a reminder of its own counts down as before", () => {
    const row = incoming({ followup: wait({ due: now + 2 * day, deadline: now + 2 * day, park: "parked" }) });
    expect(rowTag(row, now, ru, true)!.text).toBe("осталось 2 дня");
  });
});

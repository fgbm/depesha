import { describe, expect, it, vi } from "vitest";
import { when } from "@depesha/plugin-api";
import { bannerOf, type Actions } from "./banner";
import { letter, sayIn, wait } from "./fixtures";

const ru = sayIn("ru");
const day = 86_400;
const now = 100 * day;
const actions = (): Actions => ({ again: vi.fn(), later: vi.fn(), repick: vi.fn(), stop: vi.fn(), waitAgain: vi.fn(), openAnswer: vi.fn() });
const titles = (b: ReturnType<typeof bannerOf>) => b!.actions!.map((a) => a.title);

describe("the banner of a letter waiting for a reply", () => {
  it("overdue: write again first, then a new date, tomorrow, stop; the history of reminders", () => {
    const f = wait({ due: now + day, deadline: now - day, repeat_secs: day, reminded: [now - day, now - 10], kind: "Через день, потом каждый день", expect: "ivan@example.org" });
    const b = bannerOf(letter(f), now, ru, actions())!;
    expect(b.tone).toBe("warn");
    expect(b.text).toBe(`Ответа так и нет: напоминание было ${when(now - 10)}. Засчитается только ответ от получателя Иван Петров.`);
    expect(titles(b)).toEqual(["Написать ещё раз", "Назначить новый срок", "Напомнить завтра", "Не ждать"]);
    expect(b.actions![0].primary).toBe(true);
    expect(b.detailsTitle).toBe("История напоминаний");
    expect(b.details).toEqual([
      { label: "Напоминали 2 раза", value: `${when(now - day)}, ${when(now - 10)}` },
      { label: "Следующее", value: `${when(now + day)}, и так до ответа` },
      { label: "Вариант", value: "Через день, потом каждый день" },
    ]);
  });

  it("waiting: when it reminds, the deadline of its own", () => {
    const b = bannerOf(letter(wait({ due: now + day, deadline: now + 3 * day, own_deadline: true })), now, ru, actions())!;
    expect(b.tone).toBe("info");
    expect(b.text).toBe(`Ответ нужен к ${when(now + 3 * day)}. Напомню ${when(now + day)}, если его не будет.`);
    expect(titles(b)).toEqual(["Назначить новый срок", "Не ждать"]);
    expect(b.details![0]).toEqual({ label: "Напоминали", value: "ещё нет" });
  });

  it("answered: green, who and when, the answer a click away, and waiting again", () => {
    const act = actions();
    const f = wait({ status: "answered", ended: now - day, answered_by: { name: "Иван Петров", email: "ivan@example.org" }, answer: 42 });
    const b = bannerOf(letter(f), now, ru, act)!;
    expect(b.tone).toBe("good");
    expect(b.text).toBe(`Ответ получен ${when(now - day)}: Иван Петров.`);
    expect(titles(b)).toEqual(["Открыть ответ", "Снова ждать ответа"]);
    b.actions![0].run();
    expect(act.openAnswer).toHaveBeenCalledWith(42);
    // Where letters cannot be opened, or the answer is not cached: no button for it.
    expect(titles(bannerOf(letter(f), now, ru, { ...act, openAnswer: undefined }))).toEqual(["Снова ждать ответа"]);
    expect(titles(bannerOf(letter({ ...f, answer: null }), now, ru, act))).toEqual(["Снова ждать ответа"]);
  });

  it("closed by hand: when, and waiting again", () => {
    const act = actions();
    const b = bannerOf(letter(wait({ status: "closed", ended: now - day })), now, ru, act)!;
    expect(b.text).toBe(`Ожидание ответа закрыто вручную ${when(now - day)}.`);
    expect(titles(b)).toEqual(["Снова ждать ответа"]);
    b.actions![0].run();
    expect(act.waitAgain).toHaveBeenCalled();
  });

  it("nothing for a letter without a wait", () => {
    expect(bannerOf(letter(null), now, ru, actions())).toBeNull();
  });
});

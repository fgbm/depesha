// The book of people is read once and kept (#71): a card in a letter, the compose window
// and the settings page share the same cache, so showing a letter does not read the whole
// address book again. It is read anew only when it changed elsewhere.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/event", () => import("./testing").then((m) => m.eventModule));
vi.mock("./api", async (orig) => ({ ...(await orig<object>()), api: (await import("./testing")).api }));

import { PeopleBook } from "./peopleBook.svelte";
import { blankPerson } from "./people";
import { api, deferred, resetFakes } from "./testing";
import type { Person } from "./people";

beforeEach(() => resetFakes());

describe("the book of people", () => {
  it("is read once however often it is shown", async () => {
    api.people.mockResolvedValue([blankPerson("ivan@x")]);
    const book = new PeopleBook();
    for (let i = 0; i < 10; i++) await book.load();
    expect(api.people).toHaveBeenCalledTimes(1);
    expect(book.list).toHaveLength(1);
  });

  it("shares the read that is already on its way", async () => {
    const read = deferred<Person[]>();
    api.people.mockReturnValue(read.promise);
    const book = new PeopleBook();
    const first = book.load();
    const second = book.load();
    read.resolve([blankPerson("ivan@x")]);
    await Promise.all([first, second]);
    expect(api.people).toHaveBeenCalledTimes(1);
  });

  it("reads again when asked to refresh", async () => {
    api.people.mockResolvedValue([blankPerson("ivan@x")]);
    const book = new PeopleBook();
    await book.load();
    await book.refresh();
    expect(api.people).toHaveBeenCalledTimes(2);
  });
});

describe("the changes of a person's addresses", () => {
  const two = (): Person => ({
    ...blankPerson("olga@x"),
    id: 7,
    emails: [
      { email: "olga@x", primary: true, uses: 3, name: "" },
      { email: "o@y", primary: false, uses: 1, name: "" },
    ],
  });

  it("saves a person into the cache at once and with the key the backend gave", async () => {
    api.people.mockResolvedValue([]);
    const book = new PeopleBook();
    await book.load();
    api.personSave.mockResolvedValue({ ...blankPerson("ivan@x"), id: 9, send_format: "plain" });
    const saved = await book.save({ ...blankPerson("ivan@x"), send_format: "plain" });
    expect(saved.id).toBe(9);
    expect(book.list).toHaveLength(1);
    expect(book.list[0].id).toBe(9);
    // The next save finds the record by its key, not by being a second one.
    api.personSave.mockResolvedValue({ ...saved, hidden: true });
    await book.save({ ...saved, hidden: true });
    expect(book.list).toHaveLength(1);
    expect(book.find("IVAN@x")?.hidden).toBe(true);
  });

  it("reads the book back after an address is added, and does not when it is another person's", async () => {
    api.people.mockResolvedValue([two()]);
    const book = new PeopleBook();
    await book.load();
    const before = api.people.mock.calls.length;
    api.personAddAddress.mockResolvedValue({ person: null, owner: { ...blankPerson("ivan@x"), id: 2 } });
    const clash = await book.addAddress(two(), "ivan@x");
    expect(clash.owner?.id).toBe(2);
    expect(api.people.mock.calls.length).toBe(before);
    api.personAddAddress.mockResolvedValue({ person: two(), owner: null });
    await book.addAddress(two(), "new@x");
    expect(api.people.mock.calls.length).toBe(before + 1);
    expect(api.personAddAddress).toHaveBeenLastCalledWith("olga@x", "new@x");
  });

  it("remembers a refused pair and keeps those the backend knows", async () => {
    api.people.mockResolvedValue([]);
    api.hints.mockResolvedValue([
      { id: "same-person", subject: "a@x|b@x", decision: "never", shows: 0, refusals: 1, decided: 1, shown: 0 },
      { id: "send-format", subject: "c@x", decision: "never", shows: 0, refusals: 1, decided: 1, shown: 0 },
    ]);
    const book = new PeopleBook();
    await book.load();
    expect([...book.refused]).toEqual(["a@x|b@x"]);
    await book.refuse(blankPerson("D@x"), blankPerson("c@x"));
    expect(book.refused.has("c@x|d@x")).toBe(true);
    expect(api.hintSave).toHaveBeenCalledWith(expect.objectContaining({ id: "same-person", subject: "c@x|d@x", decision: "never" }));
  });

  it("does not echo its own re-read to the other windows twice", async () => {
    api.people.mockResolvedValue([two()]);
    const book = new PeopleBook();
    await book.load();
    // A read after another window's change tells nobody: that would pass the news back and forth.
    book.changed();
    await Promise.resolve();
    const { emit } = await import("@tauri-apps/api/event");
    expect(emit).not.toHaveBeenCalled();
  });
});

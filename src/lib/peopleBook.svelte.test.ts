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

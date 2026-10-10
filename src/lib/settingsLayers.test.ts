import { beforeEach, describe, expect, it } from "vitest";
import { i18n } from "./i18n.svelte";
import { exceptionCount, exceptions, layerSummary, layerText } from "./settingsLayers";
import { blankPerson } from "./people";
import type { AccountView } from "./types";

const person = (email: string, over: object = {}) => ({ ...blankPerson(email), ...over });
const account = (id: string, over: object = {}) => ({ id, email: `${id}@x`, ...over }) as unknown as AccountView;

beforeEach(() => {
  i18n.lang = "ru";
});

describe("whose value differs from the general one (#102, 3.1 В)", () => {
  const people = [person("a@x", { send_format: "plain" }), person("b@x", { view: "text" }), person("c@x")];
  const accounts = [account("w", { compose_format: "markdown" }), account("h", { letter_view: "html" }), account("o")];

  it("lists the people and the mailboxes with their own format", () => {
    const ex = exceptions("format", people, accounts);
    expect(ex.people.map((p) => p.email)).toEqual(["a@x"]);
    expect(ex.accounts.map((a) => a.id)).toEqual(["w"]);
  });

  it("lists the ones with their own view apart from those with their own format", () => {
    const ex = exceptions("view", people, accounts);
    expect(ex.people.map((p) => p.email)).toEqual(["b@x"]);
    expect(ex.accounts.map((a) => a.id)).toEqual(["h"]);
  });

  it("counts them", () => {
    expect(exceptionCount(exceptions("format", people, accounts))).toBe(2);
    expect(exceptionCount(exceptions("format", [], []))).toBe(0);
  });
});

describe("the line on the general setting", () => {
  it("names the people and the mailboxes by number, with the right word for each", () => {
    expect(layerSummary({ people: [person("a@x")], accounts: [account("w"), account("h")] })).toBe("Своё у 1 контакта, 2 ящиков");
    expect(layerSummary({ people: [person("a"), person("b"), person("c")], accounts: [] })).toBe("Своё у 3 контактов");
  });

  it("is empty when nothing differs", () => {
    expect(layerSummary({ people: [], accounts: [] })).toBe("");
  });

  it("still names the way when nothing differs: to set the value for individual people", () => {
    expect(layerText({ people: [], accounts: [] })).toBe("Задать для отдельных контактов");
    expect(layerText({ people: [person("a@x")], accounts: [] })).toBe("Своё у 1 контакта");
  });
});

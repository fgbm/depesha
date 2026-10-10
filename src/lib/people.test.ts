import { describe, expect, it } from "vitest";
import {
  addressesOf,
  allMailQuery,
  autoFormat,
  blankPerson,
  filterPeople,
  findPerson,
  formatMark,
  hasAddress,
  letterViewFor,
  matchPerson,
  recipientParts,
  sendFormatFor,
  strictestFormat,
  type Person,
} from "./people";
import type { BodyFormat } from "./types";

const person = (email: string, fields: Partial<Person> = {}): Person => ({ ...blankPerson(email), ...fields });

describe("the format of what is written to several recipients", () => {
  it("orders the formats by how much they keep: plain < html < markdown", () => {
    expect(strictestFormat(["markdown", "html"])).toBe("html");
    expect(strictestFormat(["html", "plain"])).toBe("plain");
    expect(strictestFormat(["markdown", "markdown"])).toBe("markdown");
    // No recipient with a rule constrains nothing.
    expect(strictestFormat([])).toBe("markdown");
  });

  it("writes to a person by their rule, else by the mailbox's format", () => {
    const down = person("ivan@x", { send_format: "plain" });
    expect(sendFormatFor(down, "html")).toBe("plain");
    expect(sendFormatFor(undefined, "html")).toBe("html");
    expect(sendFormatFor(person("b@x"), "markdown")).toBe("markdown");
  });

  it("carries what the strictest recipient allows, and names them", () => {
    const people = [person("ivan@x", { send_format: "plain" }), person("olga@x", { send_format: "html" })];
    // Ivan's plain text is the strictest of the two, and of the mailbox's HTML.
    expect(recipientParts(people, ["olga@x", "ivan@x"], "markdown")).toEqual({ parts: "plain", by: "ivan@x" });
    expect(recipientParts(people, ["olga@x"], "markdown")).toEqual({ parts: "html", by: "olga@x" });
  });

  it("does not name the mailbox's format as anyone's rule", () => {
    const people = [person("olga@x", { send_format: "html" })];
    expect(recipientParts(people, ["olga@x", "not@x"], "html")).toEqual({ parts: "html", by: "olga@x" });
    // Nobody's own rule is the mailbox's; the window says nothing about a cause.
    expect(recipientParts([], ["a@x", "b@x"], "plain")).toEqual({ parts: "plain", by: null });
  });

  it("switches the window's format on its own only for plain text", () => {
    expect(autoFormat("html", "plain")).toBe("plain");
    expect(autoFormat("markdown", "plain")).toBe("plain");
    // The Markdown part leaving is not the letter's formatting: the window stays as it is.
    expect(autoFormat("markdown", "html")).toBeNull();
    expect(autoFormat("html", "html")).toBeNull();
    expect(autoFormat("plain", "plain")).toBeNull();
  });

  it("leaves a letter that already carries a quote alone: the line only offers the switch", () => {
    // A reply or a forward has no words of its own either, but its quote is not the rule's
    // to rewrite silently: the format would lose the quoted letter's formatting and pictures.
    expect(autoFormat("html", "plain", true)).toBeNull();
    expect(autoFormat("markdown", "plain", true)).toBeNull();
    // A new letter without a quote is still switched silently.
    expect(autoFormat("html", "plain", false)).toBe("plain");
  });

  it("reads a format mark for an address", () => {
    const formats: BodyFormat[] = ["markdown", "html", "plain"];
    expect(formats.map(formatMark)).toEqual(["MD", "HTML", "T"]);
  });
});

describe("the form of what is shown", () => {
  it("goes message → sender → mailbox → app", () => {
    // Nothing of the two first: the app's setting decides.
    expect(letterViewFor("", "", "sender")).toBe("sender");
    // The mailbox's rule beats the app's.
    expect(letterViewFor("", "text", "markdown")).toBe("text");
    // The sender's rule beats the mailbox's.
    expect(letterViewFor("html", "text", "sender")).toBe("html");
  });

  it("keeps the app's «sender» when neither the person nor the mailbox says", () => {
    expect(letterViewFor("", "", "markdown")).toBe("markdown");
  });
});

describe("the address book", () => {
  it("finds a person without their address's case", () => {
    const people = [person("Ivan@X", { name: "Иван" })];
    expect(findPerson(people, "ivan@x")?.name).toBe("Иван");
    expect(findPerson(people, "nobody@x")).toBeUndefined();
  });

  it("searches the name, the address and the note", () => {
    const p = person("ivan@x", { name: "Иван Петров", note: "зал у Ольги" });
    expect(matchPerson(p, "петров")).toBe(true);
    expect(matchPerson(p, "IVAN@")).toBe(true);
    expect(matchPerson(p, "ольги")).toBe(true);
    expect(matchPerson(p, "")).toBe(true);
    expect(matchPerson(p, "сидоров")).toBe(false);
  });

  it("filters by rule, by hand and by hiding", () => {
    const ruled = person("a@x", { send_format: "plain" });
    const plain = person("b@x");
    const manual = person("c@x", { manual: true });
    const hidden = person("d@x", { hidden: true });
    const people = [ruled, plain, manual, hidden];
    expect(filterPeople(people, "all")).toHaveLength(4);
    expect(filterPeople(people, "ruled")).toEqual([ruled]);
    expect(filterPeople(people, "manual")).toEqual([manual]);
    expect(filterPeople(people, "hidden")).toEqual([hidden]);
  });
});

describe("a person with several addresses", () => {
  const olga = person("olga@example.org", {
    name: "Ольга Смирнова",
    emails: [
      { email: "olga@example.org", primary: true, uses: 31, name: "Ольга" },
      { email: "O.Smirnova@example.com", primary: false, uses: 9, name: "Смирнова Ольга" },
    ],
  });

  it("is found by any of its addresses, wherever they are spelled with case", () => {
    expect(findPerson([olga], "o.smirnova@EXAMPLE.com")).toBe(olga);
    expect(findPerson([olga], "olga@example.org")).toBe(olga);
    expect(findPerson([olga], "other@example.org")).toBeUndefined();
    expect(hasAddress(olga, " O.SMIRNOVA@example.com ")).toBe(true);
    expect(addressesOf(olga)).toEqual(["olga@example.org", "O.Smirnova@example.com"]);
  });

  it("searches the letters of every address at once", () => {
    expect(allMailQuery(olga)).toBe("from:olga@example.org|O.Smirnova@example.com");
    expect(allMailQuery(blankPerson("ivan@x"))).toBe("from:ivan@x");
  });

  it("keeps an address with a space in one token, and no quote of its own breaks the search", () => {
    const q = allMailQuery({ email: '"a b"@x', emails: [{ email: '"a b"@x' }, { email: "c@y" }] } as never);
    expect(q).toBe('from:"a b@x|c@y"');
    // Quotes open and close the value once; the address's own are gone.
    expect(q.match(/"/g)?.length).toBe(2);
  });

  it("is matched by the search through any address", () => {
    expect(matchPerson(olga, "smirnova@ex")).toBe(true);
    expect(matchPerson(olga, "nope")).toBe(false);
  });

  it("gives one rule to every address when a letter goes to two of them", () => {
    const rule = { ...olga, send_format: "plain" as const };
    // Both addresses of one person: one rule, and it is the person who forced it.
    expect(recipientParts([rule], ["olga@example.org", "o.smirnova@example.com"], "markdown")).toEqual({
      parts: "plain",
      by: "olga@example.org",
    });
    expect(recipientParts([rule], ["o.smirnova@example.com"], "markdown")).toEqual({ parts: "plain", by: "o.smirnova@example.com" });
  });
});

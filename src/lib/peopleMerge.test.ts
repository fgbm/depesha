import { describe, expect, it } from "vitest";
import { blankPerson, type Person } from "./people";
import {
  defaultChoice,
  duplicateOf,
  findDuplicates,
  localPart,
  mergeRequest,
  nameKey,
  pairSubject,
  planMerge,
} from "./peopleMerge";

let next = 1;
/** A person with the addresses given, the first the primary; `uses` is the letters of the first. */
const person = (name: string, emails: string[], fields: Partial<Person> = {}): Person => ({
  ...blankPerson(emails[0]),
  id: next++,
  name,
  emails: emails.map((email, i) => ({ email, primary: i === 0, uses: i === 0 ? (fields.uses ?? 0) : 0, name: "" })),
  ...fields,
});

describe("telling one person from two", () => {
  it("reads a name as its words, whatever their order, case, ё and punctuation", () => {
    expect(nameKey("Смирнова Ольга")).toBe(nameKey("Ольга  Смирнова"));
    expect(nameKey("Пётр Волков")).toBe(nameKey("петр, ВОЛКОВ"));
    expect(nameKey("Anna K.")).not.toBe(nameKey("Anna Kozlova"));
    expect(nameKey("")).toBe("");
    expect(localPart("O.Smirnova@Example.com")).toBe("o.smirnova");
  });

  it("offers the same name first, then the same first part of an address at other domains", () => {
    const olga = person("Ольга Смирнова", ["olga@example.org"]);
    const olga2 = person("Смирнова Ольга", ["o.smirnova@example.com"]);
    const anna = person("Анна Козлова", ["anna.k@example.org"]);
    const anna2 = person("Anna K.", ["anna.k@example.net"]);
    const stranger = person("Иван Петров", ["ivan.petrov@example.org"]);
    const found = findDuplicates([anna, stranger, olga2, anna2, olga]);
    expect(found.map((d) => [d.a.name, d.b.name, d.why])).toEqual([
      ["Смирнова Ольга", "Ольга Смирнова", "name"],
      ["Анна Козлова", "Anna K.", "address"],
    ]);
    expect(found[1].local).toBe("anna.k");
  });

  it("does not take a role address shared by many senders, or a short part, for one person", () => {
    const shared = ["a", "b", "c", "d", "e"].map((n) => person(n.toUpperCase(), [`booking@${n}.example.com`]));
    expect(findDuplicates(shared)).toEqual([]);
    // Four letters or more only: «ab@» says nothing.
    expect(findDuplicates([person("Один", ["ab@x.org"]), person("Другой", ["ab@y.org"])])).toEqual([]);
  });

  it("does not offer a pair the user refused, by any of their addresses", () => {
    const olga = person("Ольга Смирнова", ["olga@example.org"]);
    const olga2 = person("Смирнова Ольга", ["o.smirnova@example.com", "second@example.com"]);
    expect(findDuplicates([olga, olga2])).toHaveLength(1);
    const refused = new Set([pairSubject("SECOND@example.com", "Olga@example.org")]);
    expect(findDuplicates([olga, olga2], refused)).toEqual([]);
  });

  it("finds the pair a person is in and names the other", () => {
    const olga = person("Ольга Смирнова", ["olga@example.org"]);
    const olga2 = person("Смирнова Ольга", ["o.smirnova@example.com"]);
    const ivan = person("Иван", ["ivan@example.org"]);
    expect(duplicateOf([olga, olga2, ivan], olga2)?.other).toBe(olga);
    expect(duplicateOf([olga, olga2, ivan], ivan)).toBeNull();
  });

  it("keeps a pair of addresses in one order, whatever the case", () => {
    expect(pairSubject("B@x.org", "a@x.org")).toBe("a@x.org|b@x.org");
    expect(pairSubject("a@x.org", "B@x.org")).toBe("a@x.org|b@x.org");
  });
});

describe("what a merge offers", () => {
  const olga = person("Ольга Смирнова", ["olga@example.org"], { uses: 31, send_format: "plain", note: "Заказывает залы" });
  const olga2 = person("Смирнова Ольга", ["o.smirnova@example.com"], {
    uses: 9,
    send_format: "markdown",
    view: "markdown",
    note: "Личная почта",
    hidden: true,
  });

  it("takes by default the name with the most letters and the strictest format", () => {
    const plan = planMerge([olga2, olga]);
    expect(plan.people.map((p) => p.name)).toEqual(["Ольга Смирнова", "Смирнова Ольга"]);
    expect(plan.names).toEqual([
      { name: "Ольга Смирнова", uses: 31 },
      { name: "Смирнова Ольга", uses: 9 },
    ]);
    // Plain text keeps the least: the letter can carry only that.
    expect(plan.format).toEqual({ values: ["plain", "markdown"], value: "plain", conflict: true });
    // One has a view rule and the other none: what there is stays, no conflict.
    expect(plan.view).toEqual({ values: ["markdown"], value: "markdown", conflict: false });
    expect(plan.notes).toBe(2);
    expect(plan.hidden).toEqual({ some: true, all: false });
    expect(defaultChoice(plan)).toEqual({
      name: "Ольга Смирнова",
      primary: "olga@example.org",
      format: "plain",
      view: "markdown",
      hidden: true,
    });
  });

  it("hides if anyone was hidden, and does not hide if nobody was", () => {
    expect(planMerge([olga, person("Другая", ["d@example.org"])]).hidden.some).toBe(false);
    expect(defaultChoice(planMerge([olga, olga2])).hidden).toBe(true);
  });

  it("takes the view of the person whose name stays when they differ", () => {
    const a = person("А", ["a@x.org"], { uses: 5, view: "html" });
    const b = person("Б", ["b@x.org"], { uses: 1, view: "text" });
    const plan = planMerge([b, a]);
    expect(plan.view.conflict).toBe(true);
    expect(plan.view.value).toBe("html");
  });

  it("asks the backend for one address of each person, then what was settled", () => {
    const plan = planMerge([olga, olga2]);
    const choice = { ...defaultChoice(plan), primary: "o.smirnova@example.com", format: "markdown" as const };
    expect(mergeRequest(plan, choice)).toEqual({
      emails: ["olga@example.org", "o.smirnova@example.com"],
      name: "Ольга Смирнова",
      primary: "o.smirnova@example.com",
      send_format: "markdown",
      view: "markdown",
      hidden: true,
    });
  });
});

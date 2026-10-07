import { describe, expect, it } from "vitest";
import {
  answer,
  hintAbout,
  HINTS,
  HINT_POLICY,
  markShown,
  mayShow,
  nextHint,
  settled,
  shownToday,
  type HintContext,
  type HintState,
} from "./hints";

const DAY = 86_400;
/** A moment long after the install, so the week of quiet is behind us. */
const NOW = 1_000 * DAY;
const spec = HINTS[0];
const ivan = hintAbout(spec, "Ivan@X", "Иван");
const olga = hintAbout(spec, "olga@x", "Ольга");

function ctx(over: Partial<HintContext> = {}): HintContext {
  return { now: NOW, typing: false, installedAt: 0, ...over };
}

describe("whether a hint may be shown", () => {
  it("shows the first one, and only one at a time by the caller", () => {
    expect(mayShow(ivan, [], ctx())).toBe(true);
    // The engine offers one; the window draws that one and marks it shown.
    expect(nextHint([ivan, olga], [], ctx())).toBe(ivan);
  });

  it("is silent while the user is typing", () => {
    expect(mayShow(ivan, [], ctx({ typing: true }))).toBe(false);
  });

  it("keeps a week of quiet after the install", () => {
    expect(mayShow(ivan, [], ctx({ installedAt: NOW - 3 * DAY }))).toBe(false);
    expect(mayShow(ivan, [], ctx({ installedAt: NOW - 7 * DAY }))).toBe(true);
  });

  it("stops after the day's limit of three", () => {
    let states: HintState[] = [];
    for (let i = 0; i < 3; i++) {
      const h = hintAbout(spec, `p${i}@x`, `P${i}`);
      expect(mayShow(h, states, ctx())).toBe(true);
      states = markShown(states, h, NOW);
    }
    expect(shownToday(states, NOW)).toBe(3);
    expect(mayShow(hintAbout(spec, "four@x", "Четвёртый"), states, ctx())).toBe(false);
    // The next day starts over.
    expect(mayShow(hintAbout(spec, "four@x", "Четвёртый"), states, ctx({ now: NOW + DAY }))).toBe(true);
  });

  it("goes off altogether with the one switch", () => {
    const off = { ...HINT_POLICY, enabled: false };
    expect(mayShow(ivan, [], ctx({ policy: off }))).toBe(false);
  });
});

describe("the pauses after an answer", () => {
  it("keeps «not now» away for fourteen days, then asks again", () => {
    const states = answer([], ivan, "not-now", NOW);
    expect(mayShow(ivan, states, ctx({ now: NOW + 13 * DAY }))).toBe(false);
    expect(mayShow(ivan, states, ctx({ now: NOW + 14 * DAY }))).toBe(true);
    // Another person is asked throughout: the pause is about this one.
    expect(mayShow(olga, states, ctx({ now: NOW + DAY }))).toBe(true);
  });

  it("goes quiet for good after two refusals", () => {
    let states = answer([], ivan, "not-now", NOW);
    expect(mayShow(ivan, states, ctx({ now: NOW + 14 * DAY }))).toBe(true);
    states = answer(states, ivan, "not-now", NOW + 14 * DAY);
    expect(mayShow(ivan, states, ctx({ now: NOW + 100 * DAY }))).toBe(false);
    expect(settled(states, ivan)).toBe("quiet");
  });

  it("goes quiet after three showings without an answer", () => {
    let states: HintState[] = [];
    for (const at of [NOW, NOW + DAY, NOW + 2 * DAY]) {
      expect(mayShow(ivan, states, ctx({ now: at }))).toBe(true);
      states = markShown(states, ivan, at);
    }
    expect(mayShow(ivan, states, ctx({ now: NOW + 3 * DAY }))).toBe(false);
    expect(settled(states, ivan)).toBe("quiet");
  });

  it("stays answered once accepted", () => {
    const states = answer([], ivan, "accepted", NOW);
    expect(mayShow(ivan, states, ctx({ now: NOW + 100 * DAY }))).toBe(false);
    expect(settled(states, ivan)).toBe("accepted");
  });
});

describe("refusing for one person and for everyone", () => {
  it("refuses the hint about one address alone", () => {
    const states = answer([], ivan, "never-this", NOW);
    expect(mayShow(ivan, states, ctx({ now: NOW + 100 * DAY }))).toBe(false);
    // The same hint about another person is still asked.
    expect(mayShow(olga, states, ctx({ now: NOW + 100 * DAY }))).toBe(true);
  });

  it("refuses the hint about everybody", () => {
    const states = answer([], ivan, "never-anyone", NOW);
    for (const h of [ivan, olga]) expect(mayShow(h, states, ctx({ now: NOW + 100 * DAY }))).toBe(false);
    // Another hint of the registry is untouched.
    expect(mayShow(hintAbout(HINTS[1], "olga@x", "Ольга"), states, ctx())).toBe(true);
  });
});

describe("the mark of a showing", () => {
  it("counts showings without undoing an answer", () => {
    let states = answer([], ivan, "accepted", NOW);
    states = markShown(states, ivan, NOW + DAY);
    expect(settled(states, ivan)).toBe("accepted");
    const s = states[0];
    expect(s.shows).toBe(1);
    expect(s.decision).toBe("accepted");
  });
});

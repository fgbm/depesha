import { beforeEach, describe, expect, it } from "vitest";
import { i18n } from "./i18n.svelte";
import { gb, largeMailSearch, levelOf, levels, percent, roomOf, usedOf, warning, wholePercent } from "./quota";
import { limitMb } from "./accountForm.svelte";
import type { QuotaView } from "./types";

const GB = 1024 ** 3;
const MB = 1024 ** 2;

function view(used: number, limit: number): QuotaView {
  return { account_id: "a", quota: { root: "User quota", used, limit, checked: 100 }, estimate: null };
}

beforeEach(() => {
  i18n.lang = "ru";
});

describe("room", () => {
  it("is half full at 2 GB of 4 GB and fine", () => {
    const r = roomOf(view(2 * GB, 4 * GB), {})!;
    expect(percent(r)).toBe(50);
    expect(levelOf(percent(r), [90, 95])).toBe(0);
    expect(r.estimate).toBe(false);
  });

  it("warns by the nearer of the quota and the own limit, and keeps both", () => {
    const r = roomOf(view(7.6 * GB, 10 * GB), { quota_limit_mb: 8 * 1024 })!;
    expect(r.limit).toBe(8 * GB);
    expect(r.quota).toBe(10 * GB);
    expect(wholePercent(percent(r))).toBe(95);
    // An own limit above the quota does not hide the quota.
    expect(roomOf(view(9 * GB, 10 * GB), { quota_limit_mb: 20 * 1024 })!.limit).toBe(10 * GB);
  });

  it("without a quota, counts the folders against the own limit only", () => {
    const counted: QuotaView = { account_id: "a", quota: null, estimate: { bytes: 3.4 * GB, partial: true, counted: 5 } };
    expect(roomOf(counted, {})).toBeNull();
    const r = roomOf(counted, { quota_limit_mb: 4 * 1024 })!;
    expect(r.estimate && r.partial).toBe(true);
    expect(wholePercent(percent(r))).toBe(85);
    // A root without a storage limit is no quota either.
    expect(roomOf(view(5, 0), {})).toBeNull();
  });

  it("never takes the local cache for the server", () => {
    expect(roomOf({ account_id: "a", quota: null, estimate: null }, { quota_limit_mb: 1024 })).toBeNull();
  });

  it("shows an Exchange mailbox's occupied space against the own limit", () => {
    const ews = { account_id: "a", quota: { root: "", used: 3.8 * GB, limit: 0, checked: 100 }, estimate: null };
    // No server limit and no own limit: the volume alone, nothing to compare.
    const r = roomOf(ews, { quota_limit_mb: 0, ews: { url: "https://x" } })!;
    expect(r.used).toBe(3.8 * GB);
    expect(r.limit).toBe(0);
    expect(r.exchange).toBe(true);
    expect(percent(r)).toBe(0);
    // With the user's own limit the bar follows it.
    const own = roomOf(ews, { quota_limit_mb: 4 * 1024, ews: { url: "https://x" } })!;
    expect(own.limit).toBe(4 * GB);
    expect(wholePercent(percent(own))).toBe(95);
    // A limit 0 quota on an IMAP mailbox is still no room (a root without STORAGE).
    expect(roomOf(ews, { quota_limit_mb: 4 * 1024 })).toBeNull();
  });

  it("shows a counted zero for Exchange instead of hiding it", () => {
    const zero = { account_id: "a", quota: { root: "", used: 0, limit: 0, checked: 100 }, estimate: null };
    // "Counted and got zero" is a real answer, not "not counted yet": the room stands.
    const r = roomOf(zero, { quota_limit_mb: 0, ews: { url: "https://x" } })!;
    expect(r.exchange).toBe(true);
    expect(r.used).toBe(0);
  });

  it("prefers the Exchange count over a stale folder_sizes estimate", () => {
    const ews = {
      account_id: "a",
      quota: { root: "", used: 2 * GB, limit: 0, checked: 100 },
      estimate: { bytes: 9 * GB, partial: false, counted: 50 },
    };
    // The same account id may have been IMAP before: the old estimate must not win.
    const r = roomOf(ews, { quota_limit_mb: 4 * 1024, ews: { url: "https://x" } })!;
    expect(r.used).toBe(2 * GB);
    expect(r.exchange).toBe(true);
    // Exchange with only the stale estimate and no count yet: nothing, not the estimate.
    const stale = { account_id: "a", quota: null, estimate: { bytes: 9 * GB, partial: false, counted: 50 } };
    expect(roomOf(stale, { quota_limit_mb: 4 * 1024, ews: { url: "https://x" } })).toBeNull();
  });
});

describe("levels", () => {
  it("90, 95 and full", () => {
    expect(levelOf(89.9, [90, 95])).toBe(0);
    expect(levelOf(90, [90, 95])).toBe(1);
    expect(levelOf(95, [95, 90])).toBe(2);
    expect(levelOf(100, [90, 95])).toBe(3);
    expect(levelOf(120, [90, 95])).toBe(3);
  });

  it("settings out of range fall back", () => {
    expect(levels([80, 95])).toEqual([80, 95]);
    expect(levels([0, 150])).toEqual([90, 95]);
    expect(levels(undefined)).toEqual([90, 95]);
  });

  it("does not round up to 100 before the mailbox is full", () => {
    expect(wholePercent(99.7)).toBe(99);
    expect(wholePercent(100)).toBe(100);
  });
});

describe("warnings", () => {
  const day = 86_400_000;

  it("once per level crossed, again after space was freed", () => {
    let w = warning(undefined, 1, 0, "threshold");
    expect(w.warn).toBe(true);
    // The next sync at the same level: quiet.
    w = warning(w.next, 1, 1000, "threshold");
    expect(w.warn).toBe(false);
    w = warning(w.next, 2, 2000, "threshold");
    expect(w.warn).toBe(true);
    w = warning(w.next, 3, 3000, "threshold");
    expect(w.warn).toBe(true);
    // Freed below 95%: crossing it again warns again.
    w = warning(w.next, 1, 4000, "threshold");
    expect(w.warn).toBe(false);
    expect(warning(w.next, 2, 5000, "threshold").warn).toBe(true);
    // Below every level: forgotten.
    expect(warning(w.next, 0, 6000, "threshold").next).toBeUndefined();
  });

  it("daily repeats a level after a day, not before", () => {
    const first = warning(undefined, 1, 0, "daily").next;
    expect(warning(first, 1, day - 1, "daily").warn).toBe(false);
    expect(warning(first, 1, day, "daily").warn).toBe(true);
    expect(warning(first, 1, day, "threshold").warn).toBe(false);
  });
});

describe("figures", () => {
  it("say the used part in the limit's unit", () => {
    expect(usedOf(3.1 * GB, 10 * GB)).toEqual({ used: "3,1", limit: "10 ГБ" });
    expect(usedOf(300 * MB, 500 * MB)).toEqual({ used: "300", limit: "500 МБ" });
    expect(gb(1.4 * GB)).toBe("1,4 ГБ");
    // A 5 TB quota is 5 TB, not "5 120 ГБ".
    expect(usedOf(0, 5 * 1024 * GB)).toEqual({ used: "0", limit: "5 ТБ" });
    expect(usedOf(512 * GB, 2 * 1024 * GB)).toEqual({ used: "0,5", limit: "2 ТБ" });
    i18n.lang = "en";
    expect(usedOf(9.2 * GB, 10 * GB)).toEqual({ used: "9.2", limit: "10 GB" });
  });

  it("the own limit typed in GB", () => {
    expect(limitMb("4")).toBe(4096);
    expect(limitMb("2,5")).toBe(2560);
    expect(limitMb("")).toBe(0);
    expect(limitMb("много")).toBe(0);
    // Digit groups as the app shows them (a no-break space in ru-RU) or as typed.
    expect(limitMb("5 120")).toBe(5120 * 1024);
    expect(limitMb("5 120")).toBe(5120 * 1024);
    expect(limitMb("5 120,5")).toBe(5120.5 * 1024);
  });

  it("finds large mail with the threshold", () => {
    expect(largeMailSearch()).toBe("larger:25M");
    expect(largeMailSearch(10)).toBe("larger:10M");
    expect(largeMailSearch(0)).toBe("larger:25M");
  });
});

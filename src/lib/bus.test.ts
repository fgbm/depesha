import { describe, expect, it, vi } from "vitest";
import { bus, createBus } from "./bus";

interface Events {
  ping: void;
  page: { page: string };
}

describe("the channel of the interface", () => {
  it("hands the payload to the subscriber", () => {
    const b = createBus<Events>();
    const seen: string[] = [];
    b.on("page", (at) => seen.push(at.page));
    b.emit("page", { page: "keys" });
    expect(seen).toEqual(["keys"]);
  });

  it("tells every subscriber of an event, in the order they came, and no one of another", () => {
    const b = createBus<Events>();
    const order: string[] = [];
    b.on("ping", () => order.push("first"));
    b.on("ping", () => order.push("second"));
    b.on("page", () => order.push("other"));
    b.emit("ping");
    expect(order).toEqual(["first", "second"]);
  });

  it("stops telling a subscriber that took itself back, and only that one", () => {
    const b = createBus<Events>();
    const a = vi.fn();
    const c = vi.fn();
    const off = b.on("ping", a);
    b.on("ping", c);
    off();
    off();
    b.emit("ping");
    expect(a).not.toHaveBeenCalled();
    expect(c).toHaveBeenCalledTimes(1);
  });

  it("keeps the same function subscribed twice as two subscriptions", () => {
    const b = createBus<Events>();
    const h = vi.fn();
    const off = b.on("ping", h);
    b.on("ping", h);
    off();
    b.emit("ping");
    expect(h).toHaveBeenCalledTimes(1);
    expect(b.count("ping")).toBe(1);
  });

  it("drops an event nobody hears", () => {
    const b = createBus<Events>();
    expect(() => b.emit("ping")).not.toThrow();
    const late = vi.fn();
    b.on("ping", late);
    expect(late).not.toHaveBeenCalled();
  });

});

describe("a round of the channel", () => {
  it("lets a subscriber take back another one in the round: the other no longer hears it", () => {
    const b = createBus<Events>();
    const second = vi.fn();
    let offSecond = () => {};
    b.on("ping", () => offSecond());
    offSecond = b.on("ping", second);
    b.emit("ping");
    expect(second).not.toHaveBeenCalled();
    expect(b.count("ping")).toBe(1);
  });

  it("does not tell a subscriber that came in the round", () => {
    const b = createBus<Events>();
    const late = vi.fn();
    b.on("ping", () => b.on("ping", late));
    b.emit("ping");
    expect(late).not.toHaveBeenCalled();
  });

  it("tells the rest when one throws, then throws the first error", () => {
    const b = createBus<Events>();
    const rest = vi.fn();
    b.on("ping", () => {
      throw new Error("boom");
    });
    b.on("ping", rest);
    expect(() => b.emit("ping")).toThrow("boom");
    expect(rest).toHaveBeenCalledTimes(1);
  });

  it("counts the subscribers, and none are left after all took themselves back", () => {
    const b = createBus<Events>();
    const offs = [b.on("ping", () => {}), b.on("ping", () => {}), b.on("page", () => {})];
    expect(b.count("ping")).toBe(2);
    offs.forEach((off) => off());
    expect([b.count("ping"), b.count("page")]).toEqual([0, 0]);
  });

  it("gathers the answers the subscribers owe", async () => {
    const answers: Promise<boolean>[] = [];
    const offs = [bus.on("compose.save-all", (all) => all.add(Promise.resolve(true))), bus.on("compose.save-all", (all) => all.add(Promise.resolve(false)))];
    bus.emit("compose.save-all", { add: (p) => answers.push(p) });
    expect(await Promise.all(answers)).toEqual([true, false]);
    offs.forEach((off) => off());
    expect(bus.count("compose.save-all")).toBe(0);
  });
});

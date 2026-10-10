import { beforeEach, describe, expect, it, vi } from "vitest";
import { tick } from "svelte";

const { avatar } = vi.hoisted(() => ({ avatar: vi.fn() }));
vi.mock("./api", () => ({ api: { avatar } }));

import { avatarOf } from "./avatars.svelte";

beforeEach(() => avatar.mockReset());

describe("the pictures of senders (#108)", () => {
  it("asks once for an address however many letters of it ask, with the id of the first", async () => {
    avatar.mockResolvedValue("data:x");
    for (const id of [11, 12, 13, 14]) avatarOf("a", "ozon@one.example", id);
    await tick();
    expect(avatar).toHaveBeenCalledTimes(1);
    expect(avatar).toHaveBeenCalledWith("a", "ozon@one.example", 11);
    await tick();
    expect(avatarOf("a", "OZON@one.example", 99)).toBe("data:x");
    expect(avatar).toHaveBeenCalledTimes(1);
  });

  it("keeps the asks with a logo and without one apart", async () => {
    avatar.mockResolvedValue(null);
    avatarOf("a", "kate@two.example", null);
    avatarOf("a", "kate@two.example", 5);
    avatarOf("a", "kate@two.example", 6);
    await tick();
    expect(avatar).toHaveBeenCalledTimes(2);
    expect(avatar).toHaveBeenCalledWith("a", "kate@two.example", null);
    expect(avatar).toHaveBeenCalledWith("a", "kate@two.example", 5);
  });
});

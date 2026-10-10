// Switching the format of a letter (#140): HTML → text asks first, any change is undone by a toast.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("svelte", async (orig) => ({ ...(await orig<object>()), onMount: () => {} }));
vi.mock("../api", async (orig) => ({ ...(await orig<object>()), api: (await import("../testing")).api }));
const { confirm, toast, fail } = vi.hoisted(() => ({ confirm: vi.fn(), toast: vi.fn(), fail: vi.fn() }));
vi.mock("../store.svelte", async () => ({
  app: (await import("../testing")).appMock({ ui: { confirm, toast, fail }, mailboxes: { account: () => undefined } }),
}));

import { emptyDraft } from "../compose";
import type { ComposeWindow } from "../composes.svelte";
import { ComposeFormat } from "./format.svelte";

function letter(): { fmt: ComposeFormat; win: ComposeWindow } {
  const draft = { ...emptyDraft({ name: "Me", email: "me@example.com" }, "html"), html: "<p>Hello <b>bold</b></p>", text: "Hello bold" };
  const win = { id: 1, mode: "open", savedAt: null, local_id: "k", account_id: "a", draft, draft_id: null } as unknown as ComposeWindow;
  return { fmt: new ComposeFormat({ win }), win };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("setFormat", () => {
  it("asks before formatting is lost, and leaves the letter alone when the user stays", async () => {
    confirm.mockResolvedValue(false);
    const { fmt, win } = letter();
    await fmt.setFormat("plain");
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(win.draft.format).toBe("html");
    expect(toast).not.toHaveBeenCalled();
    expect(fmt.switching).toBe(false);
  });

  it("converts when the user agrees, and the toast's «undo» puts the HTML back", async () => {
    confirm.mockResolvedValue(true);
    const { fmt, win } = letter();
    await fmt.setFormat("plain");
    expect(win.draft.format).toBe("plain");
    expect(toast).toHaveBeenCalledTimes(1);
    const action = toast.mock.calls[0][2] as { label: string; run: () => void };
    expect(action.label).toBeTruthy();
    action.run();
    expect(win.draft.format).toBe("html");
    expect(win.draft.html).toBe("<p>Hello <b>bold</b></p>");
  });

  it("asks nothing when nothing is lost, and still offers to undo", async () => {
    const { fmt, win } = letter();
    await fmt.setFormat("markdown");
    expect(confirm).not.toHaveBeenCalled();
    expect(win.draft.format).toBe("markdown");
    expect(toast).toHaveBeenCalledTimes(1);
  });
});

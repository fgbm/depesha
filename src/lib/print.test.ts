// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/event", () => import("./testing").then((m) => m.eventModule));
vi.mock("@tauri-apps/api/window", () => import("./testing").then((m) => m.windowModule));
vi.mock("@tauri-apps/api/app", () => import("./testing").then((m) => m.appModule));
vi.mock("./api", async (orig) => ({ ...(await orig<object>()), api: (await import("./testing")).api }));
vi.mock("./theme", () => ({ applyTheme: () => {} }));

import { printHtml, printKey, printOpened, printRow, rememberForm } from "./print";
import { shortcuts } from "./shortcuts.svelte";
import { app } from "./store.svelte";
import { api, flush, resetFakes } from "./testing";
import type { OpenedMessage } from "./types";

const frames = () => [...document.querySelectorAll<HTMLIFrameElement>("iframe.print-frame")];

function key(init: KeyboardEventInit): KeyboardEvent {
  return new KeyboardEvent("keydown", { cancelable: true, ...init });
}

const message = (id: number, over: Partial<OpenedMessage["view"]> = {}): OpenedMessage =>
  ({
    row: { id, account_id: "a", folder: "INBOX", date: 1_790_000_000, flags: {} },
    trusted_sender: false,
    view: {
      summary: { subject: `Письмо ${id}`, from: { name: "Анна", email: "anna@x.org" }, to: [], cc: [], date: 1_790_000_000 },
      text: `текст ${id}`,
      html: `<p>html ${id}</p>`,
      markdown: null,
      attachments: [{ index: 0, name: "счёт.pdf", mime: "application/pdf", size: 1, content_id: null, inline: false }],
      ...over,
    },
  }) as unknown as OpenedMessage;

beforeEach(() => {
  resetFakes();
  api.people.mockResolvedValue([]);
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  frames().forEach((f) => f.remove());
  app.reader.opened = null;
});

describe("the print frame", () => {
  it("is a frame of its own, off the screen but laid out, and prints itself when loaded", () => {
    printHtml("<p>лист</p>");
    const [f] = frames();
    expect(frames()).toHaveLength(1);
    expect(f.getAttribute("sandbox")).toBe("allow-same-origin allow-modals");
    expect(f.srcdoc).toBe("<p>лист</p>");
    expect(f.style.display).not.toBe("none");
    expect(f.getAttribute("aria-hidden")).toBe("true");
    const print = vi.fn();
    Object.defineProperty(f, "contentWindow", { value: { print } });
    f.dispatchEvent(new Event("load"));
    expect(print).toHaveBeenCalledOnce();
  });

  it("prints once even when the picture that never loads is given up on", () => {
    const done = printHtml("<p>x</p>");
    const [f] = frames();
    const print = vi.fn();
    Object.defineProperty(f, "contentWindow", { value: { print } });
    vi.advanceTimersByTime(8000);
    f.dispatchEvent(new Event("load"));
    expect(print).toHaveBeenCalledOnce();
    return expect(done).resolves.toBeUndefined();
  });

  it("replaces the frame of the last print, and goes away by itself", () => {
    printHtml("<p>1</p>");
    printHtml("<p>2</p>");
    expect(frames().map((f) => f.srcdoc)).toEqual(["<p>2</p>"]);
    const [f] = frames();
    Object.defineProperty(f, "contentWindow", { value: { print: () => {} } });
    f.dispatchEvent(new Event("load"));
    vi.advanceTimersByTime(5 * 60 * 1000);
    expect(frames()).toHaveLength(0);
  });

  it("reports a print that throws", async () => {
    const done = printHtml("<p>x</p>");
    const [f] = frames();
    Object.defineProperty(f, "contentWindow", {
      value: {
        print: () => {
          throw new Error("no printer");
        },
      },
    });
    f.dispatchEvent(new Event("load"));
    await expect(done).rejects.toThrow("no printer");
    expect(frames()).toHaveLength(0);
  });
});

describe("Ctrl+P", () => {
  it("is taken from the browser wherever it is pressed, and prints the open letter", async () => {
    app.reader.opened = message(7);
    const e = key({ key: "p", code: "KeyP", ctrlKey: true });
    expect(printKey(e)).toBe(true);
    expect(e.defaultPrevented).toBe(true);
    await vi.advanceTimersByTimeAsync(0);
    const [f] = frames();
    expect(f.srcdoc).toContain("<h1>Письмо 7</h1>");
    expect(f.srcdoc).toContain("счёт.pdf");
  });

  it("works on the Russian layout and with Cmd", () => {
    expect(printKey(key({ key: "з", code: "KeyP", ctrlKey: true }))).toBe(true);
    expect(printKey(key({ key: "p", code: "KeyP", metaKey: true }))).toBe(true);
  });

  it("is taken from the browser even where nothing is printed", () => {
    app.reader.opened = message(7);
    const e = key({ key: "p", code: "KeyP", ctrlKey: true });
    expect(printKey(e, true)).toBe(true);
    expect(e.defaultPrevented).toBe(true);
    expect(frames()).toHaveLength(0);
  });

  it("prints nothing when no letter is open", () => {
    expect(printKey(key({ key: "p", code: "KeyP", ctrlKey: true }))).toBe(true);
    expect(frames()).toHaveLength(0);
  });

  it("leaves other keys alone", () => {
    for (const init of [{ key: "p", code: "KeyP" }, { key: "p", code: "KeyP", ctrlKey: true, shiftKey: true }, { key: "o", code: "KeyO", ctrlKey: true }]) {
      const e = key(init);
      expect(printKey(e)).toBe(false);
      expect(e.defaultPrevented).toBe(false);
    }
  });
});

describe("the print key on each system", () => {
  const cmd = (init: KeyboardEventInit) => key({ key: "p", code: "KeyP", ...init });

  it("on macOS is Cmd+P: it prints, and the browser's own is cancelled", async () => {
    app.reader.opened = message(7);
    const e = cmd({ metaKey: true });
    expect(printKey(e, false, true)).toBe(true);
    expect(e.defaultPrevented).toBe(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(frames()).toHaveLength(1);
  });

  /** The key as it arrives from `target`: the handler sees `e.target` only once the event is dispatched. */
  const from = (target: HTMLElement, init: KeyboardEventInit, mac: boolean) => {
    let settled: boolean | undefined;
    target.addEventListener("keydown", (e) => (settled = printKey(e, false, mac)), { once: true });
    const e = cmd(init);
    target.dispatchEvent(e);
    return { settled, prevented: e.defaultPrevented };
  };

  it("on macOS leaves Ctrl+P to a text field: no print, no cancel", () => {
    app.reader.opened = message(7);
    for (const tag of ["input", "textarea"]) {
      const field = document.body.appendChild(document.createElement(tag));
      const r = from(field, { ctrlKey: true, bubbles: true }, true);
      field.remove();
      expect(r).toEqual({ settled: true, prevented: false });
    }
    expect(frames()).toHaveLength(0);
  });

  it("on macOS Ctrl+P outside a text field is the ordinary key of the command", async () => {
    app.reader.opened = message(7);
    const r = from(document.body, { ctrlKey: true, bubbles: true }, true);
    expect(r).toEqual({ settled: true, prevented: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(frames()).toHaveLength(1);
  });

  it("elsewhere is Ctrl+P", () => {
    const e = cmd({ ctrlKey: true });
    expect(printKey(e, true, false)).toBe(true);
    expect(e.defaultPrevented).toBe(true);
  });
});

describe("the print key beside the other commands and the other print", () => {
  const cmd = (init: KeyboardEventInit) => key({ key: "p", code: "KeyP", ...init });

  it("cancels the browser's print even when the key of «Print» is another", async () => {
    shortcuts.use(() => ({ custom: { "core.print": ["Mod+Alt+x"] }, dismissed: [] }));
    try {
      app.reader.opened = message(7);
      const own = cmd({ ctrlKey: true });
      expect(printKey(own, false, false)).toBe(true);
      expect(own.defaultPrevented).toBe(true);
      expect(frames()).toHaveLength(0);
      const set = key({ key: "x", code: "KeyX", ctrlKey: true, altKey: true });
      expect(printKey(set, false, false)).toBe(true);
      await vi.advanceTimersByTimeAsync(0);
      expect(frames()).toHaveLength(1);
    } finally {
      shortcuts.use(() => undefined);
    }
  });

  it("cancels the browser's print but lets another command that took the key run", () => {
    shortcuts.use(() => ({ custom: { "core.print": [], "core.flag": ["Mod+p"] }, dismissed: [] }));
    try {
      const e = cmd({ ctrlKey: true });
      expect(printKey(e, false, false)).toBe(false);
      expect(e.defaultPrevented).toBe(true);
    } finally {
      shortcuts.use(() => undefined);
    }
  });
});

describe("printing on macOS", () => {
  it("on macOS a print another print took the place of shows no error; a real failure does", async () => {
    Object.defineProperty(navigator, "platform", { value: "MacIntel", configurable: true });
    const fail = vi.spyOn(app, "fail").mockImplementation(() => {});
    try {
      app.reader.opened = message(7);
      rememberForm(7, "html");
      api.printSheet.mockRejectedValueOnce({ kind: "superseded", message: "печать заменена другой" });
      printOpened();
      await vi.advanceTimersByTimeAsync(0);
      expect(api.printSheet).toHaveBeenCalledOnce();
      expect(fail).not.toHaveBeenCalled();
      // From a row, too.
      api.printSheet.mockRejectedValueOnce({ kind: "superseded", message: "печать заменена другой" });
      printRow(7);
      await vi.advanceTimersByTimeAsync(0);
      expect(api.printSheet).toHaveBeenCalledTimes(2);
      expect(fail).not.toHaveBeenCalled();
      // Anything else is shown.
      const broken = { kind: "print", message: "панель печати не открылась" };
      api.printSheet.mockRejectedValueOnce(broken);
      printOpened();
      await vi.advanceTimersByTimeAsync(0);
      expect(fail).toHaveBeenCalledWith(broken);
    } finally {
      fail.mockRestore();
      Object.defineProperty(navigator, "platform", { value: "", configurable: true });
    }
  });

  it("on macOS the sheet goes to the backend, not to a frame", async () => {
    Object.defineProperty(navigator, "platform", { value: "MacIntel", configurable: true });
    try {
      await printHtml("<p>лист</p>");
      expect(api.printSheet).toHaveBeenCalledWith("<p>лист</p>");
      expect(frames()).toHaveLength(0);
    } finally {
      Object.defineProperty(navigator, "platform", { value: "", configurable: true });
    }
  });
});

describe("the sheet follows the screen", () => {
  it("prints the form picked above the letter", async () => {
    const m = message(8, { markdown: "<h1>Из Markdown</h1>", views: ["text", "markdown"] });
    app.reader.opened = m;
    rememberForm(8, "text");
    printOpened();
    await vi.advanceTimersByTimeAsync(0);
    expect(frames()[0].srcdoc).toContain('<div class="plain">текст 8</div>');
    rememberForm(8, "html");
    printOpened();
    await vi.advanceTimersByTimeAsync(0);
    expect(frames()[0].srcdoc).toContain("<p>html 8</p>");
  });

  it("lets the pictures in only for a trusted sender or the ones shown", async () => {
    app.reader.opened = message(9);
    rememberForm(9, "html");
    printOpened();
    await vi.advanceTimersByTimeAsync(0);
    expect(frames()[0].srcdoc).toMatch(/img-src data:\s*;/);
    app.reader.opened = { ...message(9), trusted_sender: true };
    printOpened();
    await vi.advanceTimersByTimeAsync(0);
    expect(frames()[0].srcdoc).toMatch(/img-src data: https: http:;/);
  });
});

describe("printing a row without opening it", () => {
  it("fetches the letter, leaves the reader as it is, and prints", async () => {
    vi.useRealTimers();
    app.reader.opened = message(1);
    api.open.mockResolvedValue(message(2));
    printRow(2);
    await flush();
    await vi.waitFor(() => expect(frames()).toHaveLength(1));
    expect(api.open).toHaveBeenCalledWith(2, false);
    expect(frames()[0].srcdoc).toContain("<h1>Письмо 2</h1>");
    expect(app.opened?.row.id).toBe(1);
  });

  it("does not fetch the letter that is open", async () => {
    vi.useRealTimers();
    app.reader.opened = message(3);
    rememberForm(3, "html");
    printRow(3);
    await vi.waitFor(() => expect(frames()).toHaveLength(1));
    expect(api.open).not.toHaveBeenCalled();
  });
});

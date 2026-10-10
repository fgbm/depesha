import { describe, expect, it } from "vitest";
import { pasteKey } from "./platform";
import { t } from "./i18n.svelte";

describe("the key that pastes", () => {
  it("is Cmd on macOS and Ctrl elsewhere, and the toast tells it", () => {
    expect(pasteKey(true)).toBe("⌘V");
    expect(pasteKey(false)).toBe("Ctrl+V");
    expect(t("compose.picture.useCtrlV", { key: pasteKey(true) })).toContain("⌘V");
    expect(t("compose.picture.useCtrlV", { key: pasteKey(false) })).toContain("Ctrl+V");
  });
});

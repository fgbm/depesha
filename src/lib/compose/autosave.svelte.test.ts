// One save at a time (#71): the local copy is written inside the save, so a send or a discard
// that waits for the save also waits for the file, and nothing is left behind.
import { describe, expect, it, vi } from "vitest";

vi.mock("svelte", async (orig) => ({ ...(await orig<object>()), onDestroy: () => {} }));
vi.mock("../api", async (orig) => ({ ...(await orig<object>()), api: (await import("../testing")).api }));

import { emptyDraft } from "../compose";
import type { ComposeWindow } from "../composes.svelte";
import { api } from "../testing";
import { ComposeAutosave, type ComposeAutosaveHost } from "./autosave.svelte";

const fail = vi.fn();

function setup() {
  const draft = { ...emptyDraft({ name: "Me", email: "me@example.com" }), subject: "Привет" };
  const win = { id: 1, mode: "open", savedAt: null, local_id: "k", account_id: "a", draft, draft_id: null, unsaved: true } as unknown as ComposeWindow;
  const host: ComposeAutosaveHost = { win, setError: () => {}, clearError: () => {}, draftNotSaved: (e) => e, fail };
  // Vitest runs Svelte as on the server: the constructor's $effect is a no-op there.
  const autosave = new ComposeAutosave(host);
  return autosave;
}

describe("the draft saves one at a time", () => {
  it("leaves no server copy and no file after a send that came during the local write", async () => {
    vi.clearAllMocks();
    let release!: () => void;
    api.draftCachePut.mockImplementationOnce(() => new Promise<void>((r) => (release = r)));
    api.draftSave.mockResolvedValue({ id: 7, message_id: "m7@depesha.local" });
    const autosave = setup();
    const pending = autosave.save(false);
    // The send: nothing new may start, and the file goes even though it is still being written.
    autosave.cancel();
    const settled = autosave.settled();
    release();
    await settled;
    await pending;
    await autosave.forgetLocal();
    expect(api.draftSave).not.toHaveBeenCalled();
    expect(api.draftCacheDrop).toHaveBeenCalledWith("k");
  });

  it("tells the backend which window a saved draft belongs to (#74)", async () => {
    vi.clearAllMocks();
    api.draftCachePut.mockResolvedValue(undefined);
    api.draftSave.mockResolvedValue({ id: 7, message_id: "m7@depesha.local" });
    await setup().save(true);
    expect(api.draftSave).toHaveBeenCalledWith("a", expect.anything(), null, null, "k");
  });

  it("never runs two server saves at once", async () => {
    vi.clearAllMocks();
    let running = 0;
    let most = 0;
    api.draftCachePut.mockImplementation(() => new Promise<void>((r) => setTimeout(r, 5)));
    api.draftSave.mockImplementation(async () => {
      most = Math.max(most, ++running);
      await new Promise((r) => setTimeout(r, 5));
      running--;
      return { id: 7, message_id: "m7@depesha.local" };
    });
    const autosave = setup();
    await Promise.all([autosave.save(), autosave.save()]);
    expect(most).toBe(1);
  });
});

describe("a local copy that cannot be dropped (#147)", () => {
  it("is told: it would be offered for restore again, and the letter could go twice", async () => {
    const boom = new Error("disk locked");
    api.draftCacheDrop.mockRejectedValue(boom);
    const autosave = setup();
    (autosave as unknown as { localStored: boolean }).localStored = true;
    await autosave.forgetLocal();
    expect(fail).toHaveBeenCalledWith(boom, expect.any(String));
  });
});

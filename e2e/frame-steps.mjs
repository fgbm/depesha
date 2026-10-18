// The relay of a letter's frame (#124) against the real engine, without a mail server. The
// Windows run is the one that needs it: WebView2 is the engine that injects the app's scripts
// into sub-frames, and the one the operator uses every day. Used by e2e/drops.mjs.

/**
 * What a script played inside the letter's frame reaches. WebDriver's own script bypasses the
 * page's policy, so this is the letter's script the policy is meant to stop. The frame calls an
 * e2e-only command that keeps a marker; its own promise may never settle — a frame's answer is
 * delivered into the top document, and `connect-src 'none'` closes the other way — so the verdict
 * is the app's state, read from the page afterwards.
 */
async function frameProbe(d, marker) {
  return d.inFrame(".reader iframe", () =>
    d.req("POST", d.s("/execute/async"), {
      script: `const done = arguments[arguments.length - 1];
        const marker = arguments[0];
        const out = { internals: typeof window.__TAURI_INTERNALS__, ipc: typeof window.ipc, call: "silent", error: null };
        if (!window.__TAURI_INTERNALS__ || typeof window.__TAURI_INTERNALS__.invoke !== "function") return done(out);
        const late = setTimeout(() => done(out), 2500);
        window.__TAURI_INTERNALS__.invoke("e2e_frame_probe", { marker }).then(
          (v) => { clearTimeout(late); done({ ...out, call: "ok", error: JSON.stringify(v).slice(0, 300) }); },
          (e) => { clearTimeout(late); done({ ...out, call: "refused", error: String(e && e.message ? e.message : e).slice(0, 300) }); },
        );`,
      args: [marker],
    }),
  );
}

/**
 * The frame of a letter: the page reads nothing of it, the relay it carries — the only script its
 * policy allows — brings a hover, a click and a key of the letter to the app, and a script that
 * played in the frame anyway does not reach the app's commands (WebView2 runs Tauri's own scripts
 * in every frame, so there the policy and the ACL are what keep it out).
 */
export async function frameSteps({ d, step, inLetterWindow, closeCompose, invoke }) {
  await step("0.4", "кадр письма (#124): страница его не читает, а наведение, щелчок по ссылке и клавиша из кадра доходят до приложения", async () => {
    return inLetterWindow(
      async () => {
        await d.until("letter frame", async () => (await d.findAll(".reader iframe")).length === 1);
        // The point of the change: the page cannot read one byte of the letter's document.
        if (!(await d.exec("const f = document.querySelector('.reader iframe'); try { return f.contentDocument === null } catch { return true }")))
          throw new Error("страница читает документ кадра письма");
        // A policy that blocked the relay would leave every link, hover and key of the letter dead.
        await d.until("the letter drawn", () => d.inFrame(".reader iframe", () => d.exec("return !!document.querySelector('a')")), 20000);
        await d.inFrame(".reader iframe", () => d.exec("document.querySelector('a').dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))"));
        await d.until("hover shown", async () => (await d.text(await d.find(".reader .status"))).includes("example.com/frame"));
        await d.inFrame(".reader iframe", () => d.exec("document.querySelector('a').dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))"));
        await d.until("link asks first", async () => (await d.findAll(".confirm")).length === 1);
        await d.pressKey("\uE00C");
        await d.until("question closed", async () => (await d.findAll(".confirm")).length === 0);
        // A key pressed inside the frame: the relay posts it, and the app answers with a reply.
        // The frame is focused from the page, not clicked: at a page scale of 2 the reader clips it,
        // and a click WebDriver aims inside the window lands on what covers the frame there. The key
        // itself is a real one, delivered to the focused frame.
        await d.exec("document.querySelector('.reader iframe').focus()");
        if ((await d.exec("return document.activeElement?.tagName")) !== "IFRAME") throw new Error("фокус не в кадре письма");
        await d.pressKey("r");
        await d.until("reply by a key of the frame", async () => (await d.findAll(".compose .rich")).length === 1, 20000);
        await closeCompose();

        // What a letter's script would reach on this engine. wry puts Tauri's init scripts into every
        // frame on Windows (`AddScriptToExecuteOnDocumentCreated`, webview2/mod.rs), so the bridge is
        // in the frame; the ACL is the door, and wry hands Tauri the frame's own URL as the request's
        // (`args.Source()`), so an `about:srcdoc` source is Remote with no capability. The verdict is
        // the app's own state: a marker the run reads back from the page, never from the frame.
        const marker = `frame-${Date.now()}-${Math.round(Math.random() * 1e6)}`;
        const probe = await frameProbe(d, marker);
        let seen = [];
        for (let i = 0; i < 6 && !seen.includes(marker); i++) {
          await new Promise((r) => setTimeout(r, 500));
          seen = await invoke("e2e_frame_probe", {});
        }
        console.log(`    мост в кадре письма: ${JSON.stringify({ ...probe, seen })}`);
        if (seen.includes(marker)) throw new Error(`critical: кадр письма зовёт команды приложения (${probe.call})`);
        return { probe: { ...probe, marker, seen } };
      },
      { html: true },
    );
  });
}

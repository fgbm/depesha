// Dropping files on a letter being written (#79). WebDriver cannot drag a file in from the
// desktop, so a test build (`e2e` feature) has a command, `e2e_drop`, that makes the window
// report a drop the way the system does: through `drops::window_event`, then the page's
// `files-dropped`, `activeCompose`, the zone under the pointer, `file_info` and the check of
// the path. Used by e2e/run.mjs (a reply, a letter's own window) and e2e/drops.mjs (Windows CI).

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PDF = Buffer.from("%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n");
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

/** Real files in a folder of their own, outside every folder the test build trusts, with a
 *  Cyrillic name and a space in it: only a drop can make them attachable. */
export function dropFixtures() {
  const dir = mkdtempSync(join(tmpdir(), "depesha-drop-"));
  const pdf = join(dir, "Договор №1 (копия).pdf");
  const png = join(dir, "Фото отпуска.png");
  const stray = join(dir, "чужой файл.txt");
  writeFileSync(pdf, PDF);
  writeFileSync(png, PNG);
  writeFileSync(stray, "x");
  return { dir, pdf, png, stray, clean: () => rmSync(dir, { recursive: true, force: true }) };
}

async function invoke(d, cmd, args = {}) {
  const r = await d.req("POST", d.s("/execute/async"), {
    script:
      "const done = arguments[arguments.length - 1]; window.__TAURI_INTERNALS__.invoke(arguments[0], arguments[1]).then((v) => done({ ok: v ?? null }), (e) => done({ err: String(e?.message ?? e) }));",
    args: [cmd, args],
  });
  if (r.err) throw new Error(`${cmd}: ${r.err}`);
  return r.ok;
}

/** The centre of `css` in the physical pixels of the window, where a drop reports its place. */
async function physicalCentre(d, css) {
  return d.exec(
    `const r = document.querySelector(arguments[0])?.getBoundingClientRect();
     if (!r) return null;
     const k = window.devicePixelRatio;
     return { x: Math.round((r.left + r.width / 2) * k), y: Math.round((r.top + r.height / 2) * k), dpr: k };`,
    css,
  );
}

/**
 * Drags `paths` over the window and drops them on the centre of `css`. With `zone` set the
 * zones must come up first (the drag enters the window), and the drop is on that zone.
 * Returns the device pixel ratio the position was scaled by.
 */
export async function dropOn(d, paths, { css, zone = null }) {
  const at = (await physicalCentre(d, css ?? ".compose")) ?? { x: 1, y: 1 };
  await invoke(d, "e2e_drop", { paths, x: at.x, y: at.y, phase: "enter" });
  let place = at;
  if (zone) {
    place = await d.until(`zone ${zone}`, () => physicalCentre(d, `[data-drop-zone='${zone}']`));
  }
  await invoke(d, "e2e_drop", { paths, x: place.x, y: place.y, phase: "drop" });
  return place.dpr ?? at.dpr;
}

/** Where a zone lies in physical pixels: the drag is made to enter for a moment, then to leave. */
async function zonePlace(d, paths, zone) {
  await invoke(d, "e2e_drop", { paths, x: 1, y: 1, phase: "enter" });
  try {
    return await d.until(`zone ${zone}`, () => physicalCentre(d, `[data-drop-zone='${zone}']`));
  } finally {
    await invoke(d, "e2e_drop", { paths, x: 1, y: 1, phase: "leave" });
    await d.until("zones gone", async () => (await d.findAll("[data-drop-zone]")).length === 0);
  }
}

const names = (d) => d.exec("return [...document.querySelectorAll('.compose .files .file')].map((f) => f.innerText.trim())");

/**
 * The steps. `openCompose()` leaves a letter in HTML open in the current window and
 * `closeCompose()` discards it; `fix` is `dropFixtures()`. `expectDpr` (a number or null)
 * is the scale the run was started for: the step fails if the page sees another.
 */
export async function dropSteps({ d, step, refused, openCompose, closeCompose, fix, expectDpr = null, minDpr = null, nativeDrop = null, log = console.log }) {
  await step("2.9", "перетаскивание: масштаб окна и файл вне доверенных папок", async () => {
    const dpr = await d.exec("return window.devicePixelRatio");
    log(`    devicePixelRatio=${dpr}`);
    if (expectDpr && Math.abs(dpr - expectDpr) > 0.01) throw new Error(`масштаб ${dpr}, а ждали ${expectDpr}`);
    if (minDpr && dpr < minDpr) throw new Error(`масштаб ${dpr}, а ждали не меньше ${minDpr}`);
    // Without a drop the file is not attachable, so every pass below is the drop's doing.
    await refused("file_info", { path: fix.stray });
  });

  await step("2.9", "бросок PDF и картинки на «Прикрепить»: оба файла во вложениях", async () => {
    await openCompose();
    await dropOn(d, [fix.pdf, fix.png], { zone: "attach" });
    const got = await d.until("attachments", async () => {
      const n = await names(d);
      return n.length >= 2 ? n : null;
    }, 10000);
    if (!got.some((n) => n.includes("Договор №1 (копия).pdf")) || !got.some((n) => n.includes("Фото отпуска.png"))) {
      throw new Error(`вложения: ${JSON.stringify(got)}`);
    }
    if ((await d.findAll("[data-drop-zone]")).length) throw new Error("зоны остались после броска");
    await closeCompose();
  });

  await step("2.9", "бросок PDF мимо зон: вложение появилось", async () => {
    await openCompose();
    await dropOn(d, [fix.pdf], { css: ".compose" });
    await d.until("attachment", async () => (await names(d)).some((n) => n.includes("Договор №1 (копия).pdf")), 10000);
    await closeCompose();
  });

  await step("2.9", "бросок картинки на «Вставить в текст»: картинка в тексте, вложений нет", async () => {
    await openCompose();
    const before = await d.exec("return document.querySelectorAll('.compose .rich img').length");
    await dropOn(d, [fix.png], { zone: "inline" });
    await d.until("picture in the text", async () => (await d.exec("return document.querySelectorAll('.compose .rich img').length")) > before, 10000);
    if ((await names(d)).length) throw new Error(`картинка ушла во вложения: ${JSON.stringify(await names(d))}`);
    await closeCompose();
  });

  // The system's own drag (Windows CI only): files carried by the mouse from another window.
  // The zone is found first by making the page lay it out, then the drag goes there for real.
  if (nativeDrop) {
    await step("2.9", "настоящий бросок (OLE) PDF и картинки на «Прикрепить»: оба файла во вложениях", async () => {
      await openCompose();
      const paths = [fix.pdf, fix.png];
      const to = await zonePlace(d, paths, "attach");
      const hover = await physicalCentre(d, ".compose");
      await nativeDrop({ paths, hover, to });
      const got = await d.until("attachments", async () => {
        const n = await names(d);
        return n.length >= 2 ? n : null;
      }, 10000);
      if (!got.some((n) => n.includes("Договор №1 (копия).pdf")) || !got.some((n) => n.includes("Фото отпуска.png"))) {
        throw new Error(`вложения: ${JSON.stringify(got)}`);
      }
      await closeCompose();
    });

    await step("2.9", "настоящий бросок (OLE) картинки на «Вставить в текст»: картинка в тексте", async () => {
      await openCompose();
      const before = await d.exec("return document.querySelectorAll('.compose .rich img').length");
      const to = await zonePlace(d, [fix.png], "inline");
      const hover = await physicalCentre(d, ".compose");
      await nativeDrop({ paths: [fix.png], hover, to });
      await d.until("picture in the text", async () => (await d.exec("return document.querySelectorAll('.compose .rich img').length")) > before, 10000);
      await closeCompose();
    });
  }
}

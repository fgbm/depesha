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

/**
 * With a signed Markdown letter open, long enough to scroll, and its text scrolled down, the zones of a drag are in
 * view: they lie on the frame of the text, not in the scrolled area (the scroll carried them away).
 * The scroll is back where it was once the drag leaves.
 */
export async function zonesStayInView(d, fix) {
  const top = await d.until("text scrolled", async () => {
    const n = await d.exec("const a = document.querySelector('.compose .body-area.signed'); a.scrollTop = a.scrollHeight; return a.scrollTop;");
    return n > 0 ? n : null;
  });
  const scroller = "document.querySelector('.compose .scroll')";
  const was = await d.exec(`return ${scroller}.scrollTop`);
  await invoke(d, "e2e_drop", { paths: [fix.png], x: 1, y: 1, phase: "enter" });
  try {
    const place = await d.until("zones", () => physicalCentre(d, "[data-drop-zone='attach']"));
    const box = await d.exec(
      `const f = document.querySelector('.compose .body-frame').getBoundingClientRect();
       const z = document.querySelector('[data-drop-zone=attach]').getBoundingClientRect();
       return { inside: z.top >= f.top - 1 && z.bottom <= f.bottom + 1 && z.height > 0, f: [f.top, f.bottom], z: [z.top, z.bottom] };`,
    );
    if (!box.inside) throw new Error(`зоны уехали вместе с прокруткой текста: ${JSON.stringify(box)} (место ${JSON.stringify(place)})`);
  } finally {
    await invoke(d, "e2e_drop", { paths: [fix.png], x: 1, y: 1, phase: "leave" });
  }
  await d.until("zones gone", async () => (await d.findAll("[data-drop-zone]")).length === 0);
  const after = await d.exec(`return ${scroller}.scrollTop`);
  if (Math.abs(after - was) > 1) throw new Error(`прокрутка письма не вернулась: было ${was}, стало ${after}`);
  return top;
}

/**
 * The names of the attachments. The strip shows the files that fit one line and «+N ещё» for
 * the rest (#103): in a narrow window, as the browser at scale 2 is, the others are read from
 * the list that button opens.
 */
const names = async (d) => {
  const chips = await d.exec("return [...document.querySelectorAll('.compose .files .file')].map((f) => f.innerText.trim())");
  if (!(await d.findAll(".compose .files .more")).length) return chips;
  await d.exec("document.querySelector('.compose .files .more').click()");
  await d.until("list of files", async () => (await d.findAll(".compose [data-att]")).length > 0, 3000);
  const all = await d.exec("return [...document.querySelectorAll('.compose [data-att] .fname')].map((f) => f.innerText.trim())");
  await d.exec("document.querySelector('.compose [data-att]').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))");
  return [...chips, ...all];
};

/**
 * The steps. `openCompose()` leaves a letter in HTML open in the current window and
 * `closeCompose()` discards it; `fix` is `dropFixtures()`. `expectDpr` (a number or null)
 * is the scale the run was started for: the step fails if the page sees another.
 */
export async function dropSteps({ d, step, refused, openCompose, closeCompose, fix, expectDpr = null, minDpr = null, nativeDrop = null, inLetterWindow = null, log = console.log }) {
  await step("2.9-d1", "перетаскивание: масштаб окна и файл вне доверенных папок", async () => {
    const dpr = await d.exec("return window.devicePixelRatio");
    log(`    devicePixelRatio=${dpr}`);
    if (expectDpr && Math.abs(dpr - expectDpr) > 0.01) throw new Error(`масштаб ${dpr}, а ждали ${expectDpr}`);
    if (minDpr && dpr < minDpr) throw new Error(`масштаб ${dpr}, а ждали не меньше ${minDpr}`);
    // Without a drop the file is not attachable, so every pass below is the drop's doing.
    await refused("file_info", { path: fix.stray });
  });

  await step("2.9-d2", "бросок PDF и картинки на «Прикрепить»: оба файла во вложениях", async () => {
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

  await step("2.9-d3", "бросок PDF мимо зон: вложение появилось", async () => {
    await openCompose();
    await dropOn(d, [fix.pdf], { css: ".compose" });
    await d.until("attachment", async () => (await names(d)).some((n) => n.includes("Договор №1 (копия).pdf")), 10000);
    await closeCompose();
  });

  await step("2.9-d4", "бросок картинки на «Вставить в текст»: картинка в тексте, вложений нет", async () => {
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
    await step("2.9-d5", "настоящий бросок (OLE) PDF и картинки на «Прикрепить»: оба файла во вложениях", async () => {
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

    await step("2.9-d6", "настоящий бросок (OLE) картинки на «Вставить в текст»: картинка в тексте", async () => {
      await openCompose();
      const before = await d.exec("return document.querySelectorAll('.compose .rich img').length");
      const to = await zonePlace(d, [fix.png], "inline");
      const hover = await physicalCentre(d, ".compose");
      await nativeDrop({ paths: [fix.png], hover, to });
      await d.until("picture in the text", async () => (await d.exec("return document.querySelectorAll('.compose .rich img').length")) > before, 10000);
      await closeCompose();
    });
  }

  // A reply written in a letter's own window (`message-*`): it hears drops by itself (#107).
  if (inLetterWindow) {
    await step("2.9-d7", "бросок в ответ в окне письма (message-*): оба файла во вложениях", async () => {
      await inLetterWindow(async ({ openReply }) => {
        await openReply();
        await dropOn(d, [fix.pdf, fix.png], { zone: "attach" });
        await d.until("attachments", async () => (await names(d)).length >= 2, 10000);
        await closeCompose();
      });
    });

    if (nativeDrop) {
      await step("2.9-d8", "настоящий бросок (OLE) в ответ в окне письма: оба файла во вложениях", async () => {
        await inLetterWindow(async ({ openReply, title }) => {
          await openReply();
          const paths = [fix.pdf, fix.png];
          const to = await zonePlace(d, paths, "attach");
          const hover = await physicalCentre(d, ".compose");
          await nativeDrop({ paths, hover, to, title });
          await d.until("attachments", async () => (await names(d)).length >= 2, 10000);
          await closeCompose();
        });
      });
    }
  }
}

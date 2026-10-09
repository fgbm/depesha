// Printing a letter (#70): the one function behind Ctrl+P, the palette, the «More» menu of the
// letter and the context menu of a row, in the main window and in a window of its own.
// `window.print()` of the app would print the whole interface, so the sheet (printPage.ts) is
// put into a hidden frame and that frame is printed: the system's own print dialog opens, and
// a PDF is made from it. Neither Tauri's `print()` nor wry's does this: they print the web
// view, i.e. the interface.

import { api } from "./api";
import { longDate } from "./format";
import { t } from "./i18n.svelte";
import { effectivePref, preferredView } from "./letterView";
import { peopleBook } from "./peopleBook.svelte";
import { isMac } from "./platform";
import { letterOf, printPage, type PrintLabels } from "./printPage";
import { shortcuts } from "./shortcuts.svelte";
import { app } from "./store.svelte";
import type { BodyView, OpenedMessage } from "./types";

/** The form the reader shows for the letter now (it is picked above the letter and not kept). */
let shown: { id: number; view: BodyView } | null = null;

/** The reader tells which form of the open letter is on screen; the sheet prints that one. */
export function rememberForm(id: number, view: BodyView) {
  shown = { id, view };
}

/** The form on screen; for a letter that is not open, the one the settings would show. */
async function formOf(msg: OpenedMessage): Promise<BodyView> {
  if (shown?.id === msg.row.id) return shown.view;
  await peopleBook.load().catch(() => {});
  const person = peopleBook.find(msg.view.summary.from?.email ?? "");
  return preferredView(msg.view, effectivePref(person?.view, app.account(msg.row.account_id)?.letter_view, app.settings.letter_view));
}

const labels = (): PrintLabels => ({
  from: t("print.from"),
  to: t("print.to"),
  cc: t("print.cc"),
  date: t("print.date"),
  attachments: t("print.attachments"),
  noSubject: t("noSubject"),
});

/** Pictures from the network wait for the page; a hung one must not hold the print for good. */
const LOAD_MS = 8000;
/** The frame is kept after the dialog: WebKitGTK reads the pages from it once the dialog is answered. */
const KEEP_MS = 5 * 60 * 1000;

let frame: HTMLIFrameElement | null = null;
let drop: ReturnType<typeof setTimeout> | null = null;

function clear() {
  if (drop) clearTimeout(drop);
  drop = null;
  frame?.remove();
  frame = null;
}

/**
 * Prints a finished document through the system's dialog. Elsewhere from a frame the user never
 * sees; on macOS the page's `window.print()` does nothing (the web view does not answer it), so
 * the backend prints the sheet from a web view of its own (`print_mac.rs`).
 */
export function printHtml(html: string): Promise<void> {
  if (isMac()) return api.printSheet(html);
  clear();
  const f = document.createElement("iframe");
  // No scripts in the letter; `allow-modals` lets the frame's own print() open the dialog.
  f.setAttribute("sandbox", "allow-same-origin allow-modals");
  f.setAttribute("aria-hidden", "true");
  f.className = "print-frame";
  f.tabIndex = -1;
  // Not `display: none`: a frame that is not laid out prints blank. A sheet's width, off screen.
  f.style.cssText = "position:fixed;left:-10000px;top:0;width:210mm;height:297mm;border:0;visibility:hidden;pointer-events:none";
  frame = f;
  return new Promise((resolve, reject) => {
    let done = false;
    const go = () => {
      if (done) return;
      done = true;
      clearTimeout(late);
      try {
        f.contentWindow?.print();
        resolve();
      } catch (e) {
        clear();
        reject(e);
      }
      drop = setTimeout(() => frame === f && clear(), KEEP_MS);
    };
    const late = setTimeout(go, LOAD_MS);
    f.onload = go;
    f.srcdoc = html;
    document.body.append(f);
  });
}

/** Prints an opened letter in the form the reader shows it. */
export async function printMessage(msg: OpenedMessage): Promise<void> {
  const form = await formOf(msg);
  // The same rule as the reading frame: remote pictures only when the screen shows them.
  const allowRemote = (app.opened?.row.id === msg.row.id && app.allowRemote) || msg.trusted_sender;
  let marked: string | undefined;
  const source = msg.view.markdown;
  if (form === "markdown" && source) {
    // The code coloured as on screen; the highlighter is a lazy chunk, without it the plain one prints.
    marked = await import("./syntax").then(({ highlightDocument, HL_CSS }) => HL_CSS + highlightDocument(source)).catch(() => undefined);
  }
  const date = longDate(msg.view.summary.date ?? msg.row.date);
  await printHtml(printPage(letterOf(msg, form, allowRemote, date, marked), labels()));
}

/** Ctrl+P, the palette, «More»: the open letter. Nothing is open: nothing to print. */
export function printOpened() {
  const msg = app.opened;
  if (msg) printMessage(msg).catch((e) => app.fail(e));
}

/** The context menu of a row: the letter is printed without being opened in the reader. */
export function printRow(id: number) {
  const open = app.opened;
  const msg = open?.row.id === id ? Promise.resolve(open) : api.open(id, false);
  msg.then(printMessage).catch((e) => app.fail(e));
}

/** The key the browser prints the whole interface with: Cmd+P on macOS, Ctrl+P elsewhere. */
function browserPrint(e: KeyboardEvent, mac: boolean): boolean {
  const mod = mac ? e.metaKey && !e.ctrlKey : e.ctrlKey || e.metaKey;
  return mod && !e.altKey && !e.shiftKey && (e.code === "KeyP" || e.key.toLowerCase() === "p" || e.key.toLowerCase() === "з");
}

/**
 * The print key in a window's key handler. The browser's own accelerator prints the whole
 * interface (WebView2 and WebKitGTK alike), so it is cancelled wherever the focus is, a text
 * field and a composition included, and whatever the key of «Print» is set to. The letter
 * prints only where there is one to print (`blocked`: not here). On macOS only Cmd+P is the
 * print key; Ctrl+P is the text field's own «previous line» and is left alone.
 * Returns whether the key is settled here, so the window's handler goes no further.
 */
export function printKey(e: KeyboardEvent, blocked = false, mac = isMac()): boolean {
  if (mac && e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey && e.code === "KeyP") return true;
  const browser = browserPrint(e, mac);
  if (browser) e.preventDefault();
  const id = (mac ? e.metaKey : e.ctrlKey || e.metaKey) ? shortcuts.find(e, "main") : undefined;
  if (id === "core.print") {
    e.preventDefault();
    if (!blocked) printOpened();
    return true;
  }
  // Cancelled, and no command has the key: nothing else to run.
  return browser && !id;
}

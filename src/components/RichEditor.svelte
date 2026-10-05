<script lang="ts">
  // The visual editor of a letter: an editable block, formatting by the browser's own
  // editing commands. What comes in is cleaned (lib/sanitize.ts); the HTML goes out as typed.
  // A picture in the text is picked by a click and gets a small panel: two sizes, delete.
  import { onMount } from "svelte";
  import { cleanEditorHtml, cleanPastedHtml } from "../lib/sanitize";
  import { escapeHtml } from "../lib/richtext";
  import { isPictureType } from "../lib/images";
  import { t } from "../lib/i18n.svelte";

  let {
    html = $bindable(""),
    label,
    placeholder = "",
    class: cls = "",
    onselection,
    onpictures,
  }: {
    html?: string;
    label: string;
    placeholder?: string;
    class?: string;
    /** The caret moved inside: the toolbar shows what is on under it. */
    onselection?: () => void;
    /** Pictures pasted from the clipboard: the window decides how they go in. */
    onpictures?: (pictures: Blob[]) => void;
  } = $props();

  let el = $state<HTMLDivElement | null>(null);
  let wrap = $state<HTMLDivElement | null>(null);
  /**
   * The value the block shows: as given, or as read after an edit. A change from outside
   * differs from it. What is given is not read back: the browser's way of writing the same
   * HTML is no edit, and an untouched letter must stay unchanged.
   */
  let shown: string | null = null;
  let empty = $state(true);
  /** Where the caret was last in the block: a picture or a link from a menu goes there. */
  let lastRange: Range | null = null;

  function measure() {
    // The browser leaves a lone <br> in a block that was cleared.
    empty = !!el && !el.textContent?.trim() && !el.querySelector("img, li, blockquote, hr");
  }

  function read() {
    if (!el) return;
    shown = el.innerHTML;
    measure();
    if (html !== shown) html = shown;
    place();
  }

  $effect(() => {
    const value = html;
    if (!el || value === shown) return;
    el.innerHTML = cleanEditorHtml(value);
    shown = value;
    picked = null;
    measure();
  });

  onMount(() => {
    // Enter makes a line of its own, as in the text field.
    document.execCommand("defaultParagraphSeparator", false, "div");
    const changed = () => {
      const sel = window.getSelection();
      if (el && sel?.rangeCount && el.contains(sel.anchorNode)) lastRange = sel.getRangeAt(0).cloneRange();
      if (el && document.activeElement === el) onselection?.();
    };
    document.addEventListener("selectionchange", changed);
    const click = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      // A link in the letter being written is text to edit, never a way out of the app.
      if (target.closest("a")) e.preventDefault();
      picked = target instanceof HTMLImageElement ? target : null;
      place();
    };
    el?.addEventListener("click", click);
    const resized = new ResizeObserver(() => place());
    if (el) resized.observe(el);
    return () => {
      document.removeEventListener("selectionchange", changed);
      el?.removeEventListener("click", click);
      resized.disconnect();
    };
  });

  /** Puts the caret back where it was in the block, when the focus is elsewhere (a menu). */
  function backIn() {
    if (!el || document.activeElement === el) return;
    el.focus();
    if (lastRange && el.contains(lastRange.startContainer)) {
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(lastRange);
    }
  }

  /** Runs an editing command on the selection and takes the result. */
  export function exec(command: string, value?: string) {
    if (!el) return;
    backIn();
    document.execCommand(command, false, value);
    read();
  }

  /** The block was changed by hand (not by a command): take what it shows now. */
  export function changed() {
    read();
  }

  export function insertHtml(fragment: string) {
    exec("insertHTML", fragment);
  }

  export function insertText(text: string) {
    // Lines of a template stay lines.
    insertHtml(text.split("\n").map(escapeHtml).join("<br>"));
  }

  export function focus(start = false) {
    if (!el) return;
    el.focus();
    if (start) {
      const range = document.createRange();
      range.setStart(el, 0);
      range.collapse(true);
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(range);
      el.scrollTop = 0;
    }
  }

  export function element(): HTMLDivElement | null {
    return el;
  }

  /** The selection as it was last in the block, for a link typed in a form outside it. */
  export function selection(): Range | null {
    return lastRange ? lastRange.cloneRange() : null;
  }

  function pasted(data: DataTransfer | null): string | null {
    if (!data) return null;
    const rich = data.getData("text/html");
    if (rich) return cleanPastedHtml(rich);
    const plain = data.getData("text/plain");
    return plain ? plain.split(/\r?\n/).map(escapeHtml).join("<br>") : null;
  }

  function pictures(data: DataTransfer | null): Blob[] {
    return [...(data?.files ?? [])].filter((f) => isPictureType(f.type));
  }

  function onpaste(e: ClipboardEvent) {
    e.preventDefault();
    const found = pictures(e.clipboardData);
    if (found.length && onpictures) return onpictures(found);
    const fragment = pasted(e.clipboardData);
    if (fragment) insertHtml(fragment);
  }

  function ondrop(e: DragEvent) {
    // Files are taken by the window (its drop zones); text is cleaned like a paste.
    e.preventDefault();
    if (e.dataTransfer?.types.includes("Files")) return;
    const fragment = pasted(e.dataTransfer);
    if (!fragment) return;
    const at = document.caretRangeFromPoint?.(e.clientX, e.clientY);
    if (at) {
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(at);
    }
    insertHtml(fragment);
  }

  function onkeydown(e: KeyboardEvent) {
    if (picked && (e.key === "Delete" || e.key === "Backspace")) {
      e.preventDefault();
      removePicked();
      return;
    }
    picked = null;
  }

  // The picked picture: a frame around it and the panel under it.
  let picked = $state<HTMLImageElement | null>(null);
  let frame = $state<{ left: number; top: number; width: number; height: number } | null>(null);
  const fits = $derived(!!picked && frame !== null && picked.style.width === "100%");

  function place() {
    if (!picked || !wrap || !el?.contains(picked)) {
      picked = null;
      frame = null;
      return;
    }
    const r = picked.getBoundingClientRect();
    const w = wrap.getBoundingClientRect();
    frame = { left: r.left - w.left, top: r.top - w.top, width: r.width, height: r.height };
  }

  function setSize(fit: boolean) {
    if (!picked) return;
    if (fit) {
      picked.style.width = "100%";
      picked.style.height = "auto";
    } else {
      picked.style.removeProperty("width");
      picked.style.removeProperty("height");
      if (!picked.getAttribute("style")?.trim()) picked.removeAttribute("style");
      picked.removeAttribute("width");
      picked.removeAttribute("height");
    }
    read();
  }

  function removePicked() {
    picked?.remove();
    picked = null;
    read();
  }
</script>

<div class="rich-wrap {cls}" bind:this={wrap}>
  <div
    bind:this={el}
    class="rich"
    class:empty
    contenteditable="true"
    role="textbox"
    tabindex="0"
    aria-multiline="true"
    aria-label={label}
    data-placeholder={placeholder}
    spellcheck="true"
    oninput={read}
    onscroll={place}
    {onpaste}
    {ondrop}
    {onkeydown}
  ></div>
  {#if picked && frame}
    <div class="frame" style="left:{frame.left}px;top:{frame.top}px;width:{frame.width}px;height:{frame.height}px" aria-hidden="true"></div>
    <div class="picture-bar" role="toolbar" aria-label={t("compose.picture.title")} style="left:{frame.left}px;top:{frame.top + frame.height + 6}px">
      <button class:on={fits} aria-pressed={fits} onmousedown={(e) => e.preventDefault()} onclick={() => setSize(true)}>{t("compose.picture.fit")}</button>
      <button class:on={!fits} aria-pressed={!fits} onmousedown={(e) => e.preventDefault()} onclick={() => setSize(false)}>{t("compose.picture.natural")}</button>
      <button onmousedown={(e) => e.preventDefault()} onclick={removePicked}>{t("act.delete")}</button>
    </div>
  {/if}
</div>

<style>
  .rich-wrap {
    position: relative;
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
    /* The letter stays inside its box, whatever its styles say. */
    contain: layout paint;
    isolation: isolate;
  }

  .rich {
    flex: 1;
    min-height: 0;
    overflow: auto;
    padding: 14px 18px;
    background: var(--paper);
    line-height: 1.55;
    outline: none;
    user-select: text;
    overflow-wrap: anywhere;
  }

  .rich.empty::before {
    content: attr(data-placeholder);
    color: var(--muted);
    pointer-events: none;
    position: absolute;
  }

  .rich :global(blockquote) {
    margin: 0 0 0 0.8ex;
    border-left: 2px solid var(--line);
    padding-left: 1ex;
    color: var(--muted);
  }

  .rich :global(ul),
  .rich :global(ol) {
    padding-left: 1.6em;
    margin: 0.3em 0;
  }

  .rich :global(p) {
    margin: 0 0 0.6em;
  }

  .rich :global(img) {
    max-width: 100%;
    height: auto;
    cursor: default;
  }

  .rich :global(a) {
    color: var(--accent);
  }

  /* The signature apart from the text, as the recipient sees it under "-- ". */
  .rich :global(.depesha-signature) {
    margin-top: 0.6em;
    padding-top: 0.6em;
    border-top: 1px dashed var(--line);
  }

  .rich :global(.depesha-quote) {
    margin-top: 0.8em;
  }

  .frame {
    position: absolute;
    border: 2px solid var(--accent);
    pointer-events: none;
    margin: -2px 0 0 -2px;
    box-sizing: content-box;
  }

  .picture-bar {
    position: absolute;
    display: flex;
    gap: 2px;
    padding: 3px;
    background: var(--paper);
    border: 1px solid var(--line);
    border-radius: 8px;
    box-shadow: 0 4px 16px rgb(0 0 0 / 14%);
    z-index: 1;
  }

  .picture-bar button {
    border: none;
    background: none;
    color: var(--ink);
    padding: 4px 9px;
    border-radius: 6px;
    font-size: 13px;
    white-space: nowrap;
  }

  .picture-bar button:hover {
    background: var(--hover);
  }

  .picture-bar button.on {
    background: color-mix(in srgb, var(--accent) 12%, transparent);
  }
</style>

<script lang="ts">
  // The visual editor of a letter: an editable block, formatting by the browser's own
  // editing commands. What comes in is cleaned (lib/sanitize.ts); the HTML goes out as typed.
  // A picture in the text is picked by a click and gets a small panel: two sizes, delete.
  import { onMount, type Snippet } from "svelte";
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
    locked = "",
    lockedBar,
    readonly = false,
  }: {
    html?: string;
    label: string;
    placeholder?: string;
    class?: string;
    /** The caret moved inside: the toolbar shows what is on under it. */
    onselection?: () => void;
    /** Pictures pasted from the clipboard: the window decides how they go in. */
    onpictures?: (pictures: Blob[]) => void;
    /**
     * The class of a block that is not edited in place (the signature of a letter): the
     * caret does not go in, it is put or taken away whole by the window.
     */
    locked?: string;
    /** Shown at the top right corner of that block when it is pointed at or focused: its menu. */
    lockedBar?: Snippet;
    /** Shown but not edited for a while: the letter is being rewritten. */
    readonly?: boolean;
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
  /** A caret asked for just above a block, put once the letter is rendered (#61). */
  let beforeSelector: string | null = null;

  function measure() {
    // The browser leaves a lone <br> in a block that was cleared.
    empty = !!el && !el.textContent?.trim() && !el.querySelector("img, li, blockquote, hr");
  }

  /** The block's mark of being locked is the editor's, not the letter's. */
  function unlocked(value: string): string {
    return locked ? value.replace(/ contenteditable="false"/g, "") : value;
  }

  function lock() {
    if (!el || !locked) return;
    for (const b of el.querySelectorAll<HTMLElement>(`.${locked}`)) b.contentEditable = "false";
  }

  function read() {
    if (!el) return;
    shown = unlocked(el.innerHTML);
    measure();
    if (html !== shown) html = shown;
    place();
  }

  $effect(() => {
    const value = html;
    if (!el || value === shown) return;
    el.innerHTML = cleanEditorHtml(value);
    lock();
    shown = value;
    picked = null;
    measure();
    place();
    placeBefore();
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
      // A picture of the locked block is not the letter's to resize or delete.
      picked = target instanceof HTMLImageElement && !(locked && target.closest(`.${locked}`)) ? target : null;
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

  /**
   * Puts the caret in the empty line just above the first block matching `selector`: an
   * answer unfolded with words already typed goes on there, its signature and quote below
   * (#61). Nothing when that empty line is not there. The letter is rendered by an effect
   * that may run after this call, so the attempt is remade once it has been.
   */
  export function focusBefore(selector: string) {
    beforeSelector = selector;
    placeBefore();
  }

  /** Applies the pending placement, if the block is rendered by now. */
  function placeBefore() {
    if (!beforeSelector || !el) return;
    const node = el.querySelector<Element>(beforeSelector);
    if (!node) return;
    // The block is rendered: this was the one attempt, whatever it finds.
    beforeSelector = null;
    const gap = node.previousElementSibling;
    // A lone <br> is the browser's mark of an empty block; a picture or a list item is no line.
    if (!gap || gap.textContent?.trim() || gap.querySelector("img, li, blockquote, hr")) return;
    el.focus();
    const range = document.createRange();
    range.setStart(gap, 0);
    range.collapse(true);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
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

  // The locked block: where it stands, and whether the pointer is over it.
  let block = $state<{ left: number; top: number; width: number; height: number; right: number } | null>(null);
  let overBlock = $state(false);

  function placeBlock() {
    const b = locked && el ? el.querySelector<HTMLElement>(`.${locked}`) : null;
    if (!b || !wrap || !el) {
      block = null;
      return;
    }
    const r = b.getBoundingClientRect();
    const w = wrap.getBoundingClientRect();
    const e = el.getBoundingClientRect();
    // Out of sight in a scrolled letter: no bar floating over the text.
    if (r.bottom < e.top || r.top > e.bottom) {
      block = null;
      return;
    }
    block = { left: r.left - w.left, top: r.top - w.top, width: r.width, height: r.height, right: w.right - r.right };
  }

  function onpointermove(e: PointerEvent) {
    if (!locked) return;
    const over = !!(e.target as Element | null)?.closest?.(`.${locked}`);
    if (over !== overBlock) {
      overBlock = over;
      placeBlock();
    }
  }

  function place() {
    placeBlock();
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

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="rich-wrap {cls}" bind:this={wrap} onpointerleave={() => (overBlock = false)}>
  <!-- A letter is always the sender's own white sheet, laid on the window's card with a frame
       and a rounded corner — the way the reading view shows it (#62, ReaderBody.svelte:79-103). -->
  <div class="card">
    <div
      bind:this={el}
      class="rich"
      class:empty
      contenteditable={readonly ? "false" : "true"}
      aria-readonly={readonly}
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
      {onpointermove}
    ></div>
  </div>
  {#if lockedBar && block}
    {#if overBlock}
      <div class="block-hover" style="left:{block.left}px;top:{block.top}px;width:{block.width}px;height:{block.height}px" aria-hidden="true"></div>
    {/if}
    <div class="block-bar" class:shown={overBlock} style="right:{block.right}px;top:{block.top - 11}px">
      {@render lockedBar()}
    </div>
  {/if}
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
    /* The margin the sheet's card keeps from the window, as the reading card does (#62). */
    padding: 10px 14px 12px;
  }

  /* The card the sheet lies on: the theme's own paper, with a frame and a rounded corner —
     ReaderBody.svelte:79-88. The white sheet inside it does not round its own corners. */
  .card {
    flex: 1;
    min-height: 0;
    display: flex;
    border: 1px solid var(--line);
    border-radius: 8px;
    background: var(--paper);
    overflow: hidden;
  }

  .rich {
    flex: 1;
    min-height: 0;
    overflow: auto;
    padding: 14px 18px;
    /* The letter is the sender's own sheet: always white and dark-inked, as it will be read —
       the very values MailFrame shows it with (MailFrame.svelte:40). Everything here that is
       not the theme's is the recipient's white page, so no theme colour lands on it. */
    background: #fff;
    color: #1d232b;
    border-radius: 0;
    caret-color: #1d232b;
    line-height: 1.55;
    outline: none;
    user-select: text;
    overflow-wrap: anywhere;
    /* The letter stays inside its box, whatever its styles say. The bars beside it are
       outside: a menu of theirs is laid over the window, not cut by the box. */
    contain: layout paint;
    isolation: isolate;
  }

  /* The theme's own highlight is made for the theme's paper, not for this white sheet. */
  .rich::selection,
  .rich :global(*)::selection {
    background: #b9d7f5;
    color: #1d232b;
  }

  .rich.empty::before {
    content: attr(data-placeholder);
    color: #6b7480;
    pointer-events: none;
    position: absolute;
  }

  .rich :global(blockquote) {
    margin: 0 0 0 0.8ex;
    border-left: 2px solid #d8cfbd;
    padding-left: 1ex;
    /* As the recipient sees it on white (MailFrame.svelte:45), not the theme's muted. */
    color: #55606c;
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
    /* As the recipient sees a link on white (MailFrame.svelte:46), not the theme's accent. */
    color: #1f5fa8;
  }

  /* The signature apart from the text, as the recipient sees it under "-- ". */
  .rich :global(.depesha-signature) {
    margin-top: 0.6em;
    padding-top: 0.6em;
    border-top: 1px dashed #d8cfbd;
  }

  .rich :global(.depesha-signature img) {
    cursor: default;
  }

  .rich :global(.depesha-quote) {
    margin-top: 0.8em;
  }

  /* The locked block pointed at: a tint under the pointer, its menu at the corner. The block
     lies on the letter's white sheet, so its frame and tint are the recipient's own — the same
     warm line the quote and the signature carry (MailFrame.svelte:45), not the theme's, which
     would read grey over the white sheet in the dark themes (#62). */
  .block-hover {
    position: absolute;
    pointer-events: none;
    border-radius: 4px;
    outline: 1px solid #d8cfbd;
    outline-offset: 3px;
    background: color-mix(in srgb, #d8cfbd 45%, transparent);
  }

  .block-bar {
    position: absolute;
    z-index: 1;
    opacity: 0;
    transition: opacity 0.12s;
  }

  .block-bar.shown,
  .block-bar:hover,
  .block-bar:focus-within,
  .block-bar:has(:global(.open)) {
    opacity: 1;
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

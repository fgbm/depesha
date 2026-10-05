<script lang="ts">
  // The formatting row of a letter under its subject: the browser's editing commands for
  // an HTML letter, typed markup for a Markdown one. In a narrow window the rarer buttons
  // move into "⋯", with the same names and keys as their tooltips.
  import type { Component } from "svelte";
  import Bold from "@lucide/svelte/icons/bold";
  import Italic from "@lucide/svelte/icons/italic";
  import Underline from "@lucide/svelte/icons/underline";
  import List from "@lucide/svelte/icons/list";
  import ListOrdered from "@lucide/svelte/icons/list-ordered";
  import LinkIcon from "@lucide/svelte/icons/link";
  import TextQuote from "@lucide/svelte/icons/text-quote";
  import ImageIcon from "@lucide/svelte/icons/image";
  import RemoveFormatting from "@lucide/svelte/icons/remove-formatting";
  import Ellipsis from "@lucide/svelte/icons/ellipsis";
  import Eye from "@lucide/svelte/icons/eye";
  import Popover from "./Popover.svelte";
  import type RichEditor from "./RichEditor.svelte";
  import { t } from "../lib/i18n.svelte";
  import { escapeHtml } from "../lib/richtext";
  import { keyLabel } from "../lib/composeKeys";
  import { clearEdit, linesEdit, linkEdit, wrapEdit, type Edit, type LineKind } from "../lib/mdedit";

  let {
    format,
    width,
    rich,
    field,
    preview = $bindable(false),
    onpicturefile,
    onpictureclipboard,
  }: {
    format: "html" | "markdown";
    /** The window's width: what does not fit goes into "⋯". */
    width: number;
    rich: RichEditor | null;
    field: HTMLTextAreaElement | null;
    /** Markdown shown as the recipient will see it. */
    preview?: boolean;
    onpicturefile: () => void;
    onpictureclipboard: () => void;
  } = $props();

  interface Tool {
    id: string;
    icon: Component<{ size?: number }>;
    label: string;
    keys?: string;
    /** Buttons of one group stand together, groups apart. */
    group: number;
    run: () => void;
  }

  /** Formatting on under the caret, for the pressed buttons (HTML only). */
  let active = $state<Set<string>>(new Set());

  const html = $derived(format === "html");

  const tools = $derived<Tool[]>([
    { id: "bold", icon: Bold, label: t("compose.format.bold"), keys: keyLabel("bold"), group: 0, run: () => (html ? command("bold") : wrap("**")) },
    { id: "italic", icon: Italic, label: t("compose.format.italic"), keys: keyLabel("italic"), group: 0, run: () => (html ? command("italic") : wrap("*")) },
    { id: "underline", icon: Underline, label: t("compose.format.underline"), keys: keyLabel("underline"), group: 0, run: () => (html ? command("underline") : wrap("<u>", "</u>")) },
    { id: "bullets", icon: List, label: t("compose.format.bullets"), group: 1, run: () => (html ? command("insertUnorderedList") : lines("bullets")) },
    { id: "numbers", icon: ListOrdered, label: t("compose.format.numbers"), group: 1, run: () => (html ? command("insertOrderedList") : lines("numbers")) },
    { id: "link", icon: LinkIcon, label: t("compose.format.link"), keys: keyLabel("link"), group: 2, run: () => startLink() },
    { id: "quote", icon: TextQuote, label: t("compose.format.quote"), group: 2, run: () => (html ? toggleQuote() : lines("quote")) },
    ...(html ? [{ id: "picture", icon: ImageIcon, label: t("compose.picture.button"), group: 2, run: () => (pictureMenu = !pictureMenu) }] : []),
    { id: "clear", icon: RemoveFormatting, label: t("compose.format.clear"), group: 3, run: () => (html ? clearHtml() : markdown(clearEdit)) },
  ]);

  /** What stays in the row by the window's width (frame 6 of the mockup); the rest goes into "⋯". */
  const shown = $derived(
    width >= 460
      ? tools.map((x) => x.id)
      : width >= 360
        ? ["bold", "italic", "underline", "bullets", "numbers", "link"]
        : ["bold", "italic", "link"],
  );
  const inRow = $derived(tools.filter((x) => shown.includes(x.id)));
  const inMore = $derived(tools.filter((x) => !shown.includes(x.id)));
  let moreOpen = $state(false);
  let pictureMenu = $state(false);

  /** A button's action by its id, for its key. */
  export function run(id: string) {
    tools.find((x) => x.id === id)?.run();
  }

  function command(name: string) {
    rich?.exec(name);
    refresh();
  }

  /** Called as the caret moves in the editor. */
  export function refresh() {
    if (!html) return;
    const on = new Set<string>();
    for (const [id, name] of [["bold", "bold"], ["italic", "italic"], ["underline", "underline"], ["bullets", "insertUnorderedList"], ["numbers", "insertOrderedList"]]) {
      if (document.queryCommandState(name)) on.add(id);
    }
    if (quoteAtCaret()) on.add("quote");
    active = on;
  }

  function quoteAtCaret(): HTMLElement | null {
    const node = window.getSelection()?.anchorNode;
    const el = node instanceof HTMLElement ? node : node?.parentElement;
    const quote = el?.closest("blockquote") ?? null;
    return quote && rich?.element()?.contains(quote) ? (quote as HTMLElement) : null;
  }

  /** A quote on the lines under the caret, or off when they are quoted. */
  function toggleQuote() {
    const q = quoteAtCaret();
    if (!q) {
      rich?.exec("formatBlock", "blockquote");
    } else {
      q.replaceWith(...q.childNodes);
      rich?.changed();
    }
    refresh();
  }

  function clearHtml() {
    rich?.exec("removeFormat");
    rich?.exec("unlink");
    refresh();
  }

  /** Types an edit into the Markdown field, as if typed: the field and Ctrl+Z follow. */
  function markdown(make: (text: string, start: number, end: number) => Edit) {
    if (!field || preview) return;
    const e = make(field.value, field.selectionStart, field.selectionEnd);
    field.focus();
    field.setSelectionRange(e.from, e.to);
    if (!document.execCommand("insertText", false, e.insert)) {
      field.setRangeText(e.insert, e.from, e.to, "end");
      field.dispatchEvent(new Event("input", { bubbles: true }));
    }
    field.setSelectionRange(e.select[0], e.select[1]);
  }

  function wrap(open: string, close = open) {
    markdown((text, s, e) => wrapEdit(text, s, e, open, close));
  }

  function lines(kind: LineKind) {
    markdown((text, s, e) => linesEdit(text, s, e, kind));
  }

  // The link being made: the selection it goes on and the address typed.
  let linking = $state<{ range: Range | null; start: number; end: number; url: string } | null>(null);
  let linkInput = $state<HTMLInputElement | null>(null);

  export function startLink() {
    if (preview) return;
    if (html) {
      const range = rich?.selection() ?? null;
      const node = range?.startContainer;
      const a = (node instanceof HTMLElement ? node : node?.parentElement)?.closest("a");
      linking = { range, start: 0, end: 0, url: a?.getAttribute("href") ?? "" };
    } else {
      linking = { range: null, start: field?.selectionStart ?? 0, end: field?.selectionEnd ?? 0, url: "" };
    }
    queueMicrotask(() => linkInput?.focus());
  }

  /** What may stand in a link: a web or mail address; "example.com" is taken as a site. */
  function linkTarget(raw: string): string | null {
    const url = raw.trim();
    if (!url) return null;
    if (/^(https?:\/\/|mailto:)/i.test(url)) return url;
    if (/^[^\s@/]+@[^\s@/]+\.[^\s@/]+$/.test(url)) return `mailto:${url}`;
    if (/^[^\s:/]+\.[^\s:/]+/.test(url) && !/^[a-z][a-z0-9+.-]*:/i.test(url)) return `https://${url}`;
    return null;
  }

  function backTo(l: NonNullable<typeof linking>) {
    if (html) {
      rich?.focus();
      if (l.range) {
        const sel = window.getSelection();
        sel?.removeAllRanges();
        sel?.addRange(l.range);
      }
    } else {
      field?.focus();
      field?.setSelectionRange(l.start, l.end);
    }
  }

  function applyLink() {
    if (!linking) return;
    const url = linkTarget(linking.url);
    if (!url) {
      linkInput?.setCustomValidity(t("compose.format.badLink"));
      linkInput?.reportValidity();
      return;
    }
    const l = linking;
    linking = null;
    backTo(l);
    if (!html) return markdown((text, s, e) => linkEdit(text, s, e, url));
    if (!l.range || l.range.collapsed) rich?.insertHtml(`<a href="${escapeHtml(url)}">${escapeHtml(url.replace(/^mailto:/i, ""))}</a>`);
    else rich?.exec("createLink", url);
  }

  function removeLink() {
    const l = linking;
    linking = null;
    if (!l) return;
    backTo(l);
    if (html) rich?.exec("unlink");
  }

  function onLinkKey(e: KeyboardEvent) {
    if (e.key === "Enter") {
      e.preventDefault();
      applyLink();
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      const l = linking;
      linking = null;
      if (l) backTo(l);
    }
  }

  function title(x: Tool): string {
    return x.keys ? `${x.label} (${x.keys})` : x.label;
  }
</script>

<div class="bar" role="toolbar" aria-label={t("compose.format.toolbar")}>
  {#each inRow as x, i (x.id)}
    {#if i > 0 && inRow[i - 1].group !== x.group}<span class="sep" aria-hidden="true"></span>{/if}
    <span class="anchor">
      <button
        class="tb"
        class:on={active.has(x.id) || (x.id === "link" && !!linking) || (x.id === "picture" && pictureMenu)}
        aria-pressed={x.id === "picture" ? undefined : active.has(x.id)}
        aria-haspopup={x.id === "picture" ? "menu" : undefined}
        title={title(x)}
        aria-label={x.label}
        disabled={preview}
        onmousedown={(e) => e.preventDefault()}
        onclick={x.run}><x.icon size={15} /></button>
      {#if x.id === "picture"}
        <Popover bind:open={pictureMenu} align="left">
          <button class="mi" onclick={() => { pictureMenu = false; onpicturefile(); }}>{t("compose.picture.fromFile")}</button>
          <button class="mi" onclick={() => { pictureMenu = false; onpictureclipboard(); }}>{t("compose.picture.fromClipboard")}<span class="hint">Ctrl+V</span></button>
        </Popover>
      {/if}
    </span>
  {/each}
  {#if inMore.length}
    <span class="anchor">
      <button class="tb" class:on={moreOpen} title={t("compose.format.more")} aria-label={t("compose.format.more")} aria-haspopup="menu" disabled={preview} onmousedown={(e) => e.preventDefault()} onclick={() => (moreOpen = !moreOpen)}><Ellipsis size={15} /></button>
      <Popover bind:open={moreOpen} align="left">
        {#each inMore as x, i (x.id)}
          {#if i > 0 && inMore[i - 1].group !== x.group}<div class="msep" role="separator"></div>{/if}
          <button
            class="mi"
            onclick={() => {
              moreOpen = false;
              if (x.id === "picture") onpicturefile();
              else x.run();
            }}>{x.id === "picture" ? t("compose.picture.menu") : x.label}{#if x.keys}<span class="hint">{x.keys}</span>{/if}</button>
        {/each}
      </Popover>
    </span>
  {/if}
  {#if !html}
    <span class="spacer"></span>
    <button class="tb preview" class:on={preview} aria-pressed={preview} title={`${t("compose.markdown.preview")} (${keyLabel("preview")})`} onclick={() => (preview = !preview)}>
      <Eye size={15} />{#if width >= 360}<span>{t("compose.markdown.preview")}</span>{/if}
    </button>
  {/if}
  {#if linking}
    <span class="link-form">
      <input
        bind:this={linkInput}
        class="input"
        bind:value={linking.url}
        oninput={() => linkInput?.setCustomValidity("")}
        onkeydown={onLinkKey}
        placeholder={t("compose.format.linkPlaceholder")}
        aria-label={t("compose.format.linkAddress")}
      />
      <button class="btn small" onclick={applyLink}>{t("compose.format.linkApply")}</button>
      {#if html}<button class="btn ghost small" onclick={removeLink}>{t("compose.format.unlink")}</button>{/if}
    </span>
  {/if}
</div>

<style>
  /* Quiet until used, as the app's toolbars. */
  .bar {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 2px;
    padding: 4px 14px;
    border-bottom: 1px solid var(--line);
  }

  .anchor {
    position: relative;
    display: inline-flex;
  }

  .sep {
    width: 1px;
    height: 16px;
    margin: 0 5px;
    background: var(--line);
  }

  .msep {
    height: 1px;
    margin: 4px 0;
    background: var(--line);
  }

  .spacer {
    flex: 1;
  }

  .tb {
    height: 28px;
    min-width: 28px;
    border: none;
    border-radius: 6px;
    background: none;
    color: var(--muted);
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 5px;
  }

  .tb.preview {
    padding: 0 8px;
    font-size: 13px;
  }

  .tb:hover:not(:disabled) {
    background: var(--hover);
    color: var(--ink);
  }

  .tb:disabled {
    opacity: 0.4;
  }

  .tb.on {
    background: color-mix(in srgb, var(--accent) 14%, transparent);
    color: var(--accent);
  }

  .link-form {
    display: flex;
    align-items: center;
    gap: 6px;
    flex: 1 1 100%;
    padding: 4px 0 2px;
  }

  .link-form input {
    flex: 1;
    min-width: 0;
    padding: 4px 8px;
  }
</style>

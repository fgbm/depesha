<script lang="ts">
  // One signature open in its card (#25, frames 2–3): its name, whether new letters get
  // it, and the same editor as a letter's (#24) without the format switch: a signature is
  // HTML, its text version is made from it. Pictures from a file or the clipboard are
  // copied into it, so the file they came from is not needed afterwards.
  import ChevronUp from "@lucide/svelte/icons/chevron-up";
  import ChevronDown from "@lucide/svelte/icons/chevron-down";
  import ChevronRight from "@lucide/svelte/icons/chevron-right";
  import TriangleAlert from "@lucide/svelte/icons/triangle-alert";
  import RichEditor from "../RichEditor.svelte";
  import FormatBar from "../FormatBar.svelte";
  import { api } from "../../lib/api";
  import { app } from "../../lib/store.svelte";
  import { t } from "../../lib/i18n.svelte";
  import { size as sizeLabel } from "../../lib/format";
  import { composeAction } from "../../lib/composeKeys";
  import { isPictureName, shrinkToWidth } from "../../lib/images";
  import { clipboardPictures, picturesFromBlobs, picturesFromFiles, picturesHtml, type FoundPicture } from "../../lib/pictureInput";
  import { SIGNATURE_WARN, isHeavy, sigBlock, signatureSize, signatureText } from "../../lib/signatures";
  import type { Signature } from "../../lib/types";

  let {
    sig = $bindable(),
    defaultId = $bindable(),
    oncollapse,
  }: {
    sig: Signature;
    defaultId: string | null;
    oncollapse: () => void;
  } = $props();

  let rich = $state<RichEditor | null>(null);
  let bar = $state<FormatBar | null>(null);
  let width = $state(520);
  let showText = $state(false);
  let shrinking = $state(false);

  const weight = $derived(signatureSize(sig.html));
  const plain = $derived(sigBlock(sig).replace(/^\n\n/, ""));

  function setHtml(html: string) {
    sig.html = html;
    sig.text = signatureText(html);
  }

  async function addPictures(found: FoundPicture[]) {
    const { html, tooBig, failed } = await picturesHtml(found);
    for (const p of tooBig) app.ui.toast(t("account.signatures.pictureTooBig", { name: p.name }), true);
    for (const e of failed) app.ui.fail(e);
    if (html) rich?.insertHtml(html);
  }

  async function fromFile() {
    try {
      const files = await api.pickFiles(t("compose.picture.pickTitle"), true);
      for (const f of files.filter((f) => !isPictureName(f.name))) app.ui.toast(t("account.signatures.notAPicture", { name: f.name }), true);
      const { found, refused } = await picturesFromFiles(files.filter((f) => isPictureName(f.name)).map((f) => f.path));
      for (const path of refused) app.ui.toast(t("account.signatures.pictureTooBig", { name: path.split(/[\\/]/).pop() ?? path }), true);
      await addPictures(found);
    } catch (e) {
      app.ui.fail(e);
    }
  }

  async function fromClipboard() {
    const blobs = await clipboardPictures();
    if (blobs === null) return app.ui.toast(t("compose.picture.useCtrlV"));
    if (!blobs.length) return app.ui.toast(t("compose.picture.noneInClipboard"));
    await addPictures(await picturesFromBlobs(blobs));
  }

  /** Draws every picture no wider than it is shown: the signature goes with every letter. */
  async function shrink() {
    const el = rich?.element();
    if (!el || shrinking) return;
    shrinking = true;
    try {
      for (const img of el.querySelectorAll("img")) {
        if (!img.src.startsWith("data:")) continue;
        const shown = img.getBoundingClientRect().width;
        if (shown > 0 && img.naturalWidth > shown) img.src = await shrinkToWidth(img.src, shown);
      }
      rich?.changed();
    } catch (e) {
      app.ui.fail(e);
    } finally {
      shrinking = false;
    }
  }

  function onKey(e: KeyboardEvent) {
    if (composeAction(e) === "link") {
      e.preventDefault();
      bar?.startLink();
    } else if (e.key === "Escape" && (e.target as HTMLElement).closest(".rich")) {
      // The page's own Escape closes the settings: here it folds the card first.
      e.preventDefault();
      e.stopPropagation();
      oncollapse();
    }
  }
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="editor" bind:clientWidth={width} onkeydown={onKey}>
  <div class="top">
    <input class="input name" bind:value={sig.name} aria-label={t("account.signatures.name")} placeholder={t("account.signatures.name")} />
    <label class="check">
      <input type="checkbox" checked={defaultId === sig.id} onchange={(e) => (defaultId = e.currentTarget.checked ? sig.id : null)} />
      {t("account.signatures.isDefault")}
    </label>
    <span class="spacer"></span>
    <button class="btn ghost small" onclick={oncollapse}>{t("account.signatures.collapse")} <ChevronUp size={14} /></button>
  </div>
  <FormatBar bind:this={bar} format="html" {width} {rich} field={null} onpicturefile={fromFile} onpictureclipboard={fromClipboard} />
  <RichEditor
    bind:this={rich}
    bind:html={() => sig.html, setHtml}
    class="sig-rich"
    label={t("account.signatures.body")}
    placeholder={t("account.signatures.placeholder")}
    onselection={() => bar?.refresh()}
    onpictures={async (blobs) => addPictures(await picturesFromBlobs(blobs))}
  />
  {#if isHeavy(sig.html)}
    <div class="warn" role="status">
      <TriangleAlert size={16} />
      <span>{t("account.signatures.heavy", { size: sizeLabel(weight), limit: sizeLabel(SIGNATURE_WARN) })}</span>
      <button class="btn small" onclick={shrink} disabled={shrinking}>{t("account.signatures.shrink")}</button>
    </div>
  {/if}
  <div class="foot">
    <button class="disclose" aria-expanded={showText} onclick={() => (showText = !showText)}>
      {#if showText}<ChevronDown size={13} />{:else}<ChevronRight size={13} />{/if}
      {t("account.signatures.textVersion")}
    </button>
    <span class="spacer"></span>
    {#if weight}<span>{t("account.signatures.pictures", { size: sizeLabel(weight) })}</span>{/if}
  </div>
  {#if showText}
    <div class="text" class:muted={!plain}>{plain || t("account.signatures.textEmpty")}</div>
  {/if}
</div>

<style>
  .editor {
    display: flex;
    flex-direction: column;
    border-radius: 8px;
    overflow: hidden;
    box-shadow: 0 2px 10px rgb(0 0 0 / 6%);
  }

  .top {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 8px 10px;
    border-bottom: 1px solid var(--line);
    flex-wrap: wrap;
  }

  .name {
    flex: 0 1 220px;
    min-width: 120px;
  }

  .check {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    white-space: nowrap;
  }

  .spacer {
    flex: 1;
  }

  .small {
    font-size: 12px;
  }

  /* `.rich-wrap` carries the default inset; this wins by naming both classes, whatever the
     order the two components' stylesheets end up in (#62). */
  .editor :global(.sig-rich.rich-wrap) {
    flex: none;
    min-height: 120px;
    max-height: 320px;
    /* The same card of the letter's editor, kept a touch tighter in the settings (#62). */
    padding: 8px 10px;
  }

  /* The sheet is white everywhere, from RichEditor itself (RichEditor.svelte); here only the
     signature's own size. */
  .editor :global(.sig-rich .rich) {
    min-height: 120px;
    padding: 12px 14px;
  }

  .warn {
    display: flex;
    align-items: center;
    gap: 10px;
    margin: 0 10px 8px;
    padding: 8px 10px;
    border-radius: 8px;
    font-size: 13px;
    line-height: 1.4;
    background: color-mix(in srgb, var(--warn) 12%, var(--paper));
    border: 1px solid color-mix(in srgb, var(--warn) 40%, var(--paper));
  }

  .warn :global(svg) {
    flex: none;
    color: var(--warn);
  }

  .warn span {
    flex: 1;
  }

  .foot {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 10px;
    border-top: 1px solid var(--line);
    font-size: 12px;
    color: var(--muted);
  }

  .disclose {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    border: none;
    background: none;
    padding: 0;
    font: inherit;
    color: inherit;
  }

  .disclose:hover,
  .disclose:focus-visible {
    color: var(--ink);
  }

  .text {
    margin: 0 10px 10px;
    padding: 8px 10px;
    border-radius: 6px;
    background: var(--paper-2, var(--hover));
    white-space: pre-wrap;
    font-size: 13px;
    line-height: 1.45;
    user-select: text;
  }
</style>

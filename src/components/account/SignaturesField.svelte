<script lang="ts">
  // The mailbox's signatures (#25, frame 1): a list of cards with the name, the default mark
  // and the first line; everything else in the "⋯" menu of a card, as with letters in the list.
  // A card opens in place into the signature's editor. Saved with the page's buttons.
  import { tick } from "svelte";
  import Plus from "@lucide/svelte/icons/plus";
  import Ellipsis from "@lucide/svelte/icons/ellipsis";
  import GripVertical from "@lucide/svelte/icons/grip-vertical";
  import Popover from "../Popover.svelte";
  import SignatureEditor from "./SignatureEditor.svelte";
  import { app } from "../../lib/store.svelte";
  import { t } from "../../lib/i18n.svelte";
  import { addSignature, moveSignature, previewLine, removeSignature, type SignatureList } from "../../lib/signatures";
  import type { AccountForm } from "../../lib/accountForm.svelte";

  let { form }: { form: AccountForm } = $props();

  /** The signature open in its editor. */
  let editing = $state<string | null>(null);
  /** The signature whose menu is open. */
  let menu = $state<string | null>(null);
  let box = $state<HTMLElement | null>(null);

  function current(): SignatureList {
    return { list: form.signatures, defaultId: form.defaultSignature, replyId: form.replySignature };
  }

  function apply(next: SignatureList) {
    form.signatures = next.list;
    form.defaultSignature = next.defaultId;
    form.replySignature = next.replyId;
  }

  async function add() {
    const next = addSignature(current(), t("account.signatures.newName", { n: form.signatures.length + 1 }));
    apply(next);
    editing = next.id;
    await tick();
    box?.querySelector<HTMLInputElement>(`[data-signature="${next.id}"] input.name`)?.select();
  }

  async function edit(id: string, rename = false) {
    menu = null;
    editing = id;
    await tick();
    const card = box?.querySelector<HTMLElement>(`[data-signature="${id}"]`);
    if (rename) card?.querySelector<HTMLInputElement>("input.name")?.select();
    else card?.querySelector<HTMLElement>(".rich")?.focus();
  }

  function remove(id: string) {
    menu = null;
    const before = current();
    const name = form.signatures.find((s) => s.id === id)?.name ?? "";
    apply(removeSignature(before, id));
    if (editing === id) editing = null;
    app.ui.toast(t("account.signatures.deleted", { name }), false, { label: t("undo"), run: () => apply(before) });
  }

  async function move(id: string, delta: -1 | 1) {
    menu = null;
    form.signatures = moveSignature(form.signatures, id, delta);
    await tick();
    box?.querySelector<HTMLElement>(`[data-signature="${id}"] .row`)?.focus();
  }

  // Dragging a card by its grip: it moves among the others as the pointer goes.
  let dragging = $state<string | null>(null);

  function grab(e: PointerEvent, id: string) {
    e.preventDefault();
    menu = null;
    dragging = id;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }

  function drag(e: PointerEvent) {
    if (!dragging || !box) return;
    const cards = [...box.querySelectorAll<HTMLElement>("[data-signature]")];
    const from = form.signatures.findIndex((s) => s.id === dragging);
    // Before the first card whose middle is below the pointer; after the last one otherwise.
    let to = cards.findIndex((c) => {
      const r = c.getBoundingClientRect();
      return e.clientY < r.top + r.height / 2;
    });
    if (to < 0) to = cards.length - 1;
    else if (to > from) to -= 1;
    if (from < 0 || to === from) return;
    const list = [...form.signatures];
    const [moved] = list.splice(from, 1);
    list.splice(to, 0, moved);
    form.signatures = list;
  }

  function onRowKey(e: KeyboardEvent, id: string) {
    if (e.altKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
      e.preventDefault();
      move(id, e.key === "ArrowUp" ? -1 : 1);
    } else if (e.key === "Enter" && e.target === e.currentTarget) {
      e.preventDefault();
      edit(id);
    } else if (e.key === "F2") {
      e.preventDefault();
      edit(id, true);
    } else if (e.key === "Delete" && e.target === e.currentTarget) {
      e.preventDefault();
      remove(id);
    }
  }
</script>

<div class="field signatures" bind:this={box}>
  <span class="label">{t("account.signatures.title")}</span>
  {#if form.signatures.length === 0}
    <p class="muted empty">{t("account.signatures.empty")}</p>
  {/if}
  {#each form.signatures as sig, i (sig.id)}
    <div class="card" class:dragging={dragging === sig.id} data-signature={sig.id}>
      {#if editing === sig.id}
        <SignatureEditor bind:sig={form.signatures[i]} bind:defaultId={form.defaultSignature} oncollapse={() => (editing = null)} />
      {:else}
        <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
        <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
        <div class="row" role="group" aria-label={sig.name} tabindex="0" onkeydown={(e) => onRowKey(e, sig.id)} ondblclick={() => edit(sig.id)}>
          <!-- svelte-ignore a11y_no_static_element_interactions -->
          <span
            class="grip"
            aria-hidden="true"
            title={t("account.signatures.drag")}
            onpointerdown={(e) => grab(e, sig.id)}
            onpointermove={drag}
            onpointerup={() => (dragging = null)}
            onpointercancel={() => (dragging = null)}><GripVertical size={15} /></span>
          <button class="name" onclick={() => edit(sig.id)}>{sig.name.trim() || t("compose.signature.unnamed")}</button>
          {#if form.defaultSignature === sig.id}<span class="default">{t("account.signatures.default")}</span>{/if}
          <span class="preview">{previewLine(sig)}</span>
          <span class="anchor">
            <button class="btn ghost icon" aria-haspopup="menu" aria-expanded={menu === sig.id} title={t("account.signatures.menu", { name: sig.name })} aria-label={t("account.signatures.menu", { name: sig.name })} onclick={() => (menu = menu === sig.id ? null : sig.id)}><Ellipsis size={15} /></button>
            <Popover bind:open={() => menu === sig.id, (v) => (menu = v ? sig.id : menu === sig.id ? null : menu)}>
              <button class="mi" onclick={() => edit(sig.id)}>{t("account.signatures.edit")}</button>
              <button class="mi" onclick={() => edit(sig.id, true)}>{t("account.signatures.rename")}</button>
              <button class="mi" disabled={form.defaultSignature === sig.id} onclick={() => { menu = null; form.defaultSignature = sig.id; }}>{t("account.signatures.makeDefault")}</button>
              <button class="mi" disabled={form.replySignature === sig.id} onclick={() => { menu = null; form.replySignature = sig.id; }}>{t("account.signatures.makeReplyDefault")}</button>
              <hr />
              <button class="mi" disabled={i === 0} onclick={() => move(sig.id, -1)}>{t("account.signatures.up")}</button>
              <button class="mi" disabled={i === form.signatures.length - 1} onclick={() => move(sig.id, 1)}>{t("account.signatures.down")}</button>
              <hr />
              <button class="mi danger-text" onclick={() => remove(sig.id)}>{t("act.delete")}</button>
            </Popover>
          </span>
        </div>
      {/if}
    </div>
  {/each}
  <div class="add">
    <button class="btn" onclick={add}><Plus size={15} /> {t("account.signatures.add")}</button>
  </div>
  <p class="muted hint">{t("account.signatures.hint")}</p>
</div>

<style>
  .signatures {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .label {
    font-size: 13px;
    color: var(--muted);
  }

  .empty,
  .hint {
    margin: 0;
    font-size: 12px;
    line-height: 1.45;
  }

  .card {
    border: 1px solid var(--line);
    border-radius: 8px;
    background: var(--paper);
  }

  .row {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 6px 6px 6px 10px;
    min-width: 0;
    border-radius: 8px;
    outline: none;
  }

  .row:hover,
  .row:focus-visible {
    background: var(--hover);
  }

  .grip {
    display: inline-flex;
    color: var(--muted);
    cursor: grab;
    touch-action: none;
  }

  .card.dragging {
    box-shadow: 0 4px 16px rgb(0 0 0 / 14%);
  }

  .card.dragging .grip {
    cursor: grabbing;
  }

  .name {
    border: none;
    background: none;
    padding: 0;
    font: inherit;
    font-weight: 600;
    color: var(--ink);
    white-space: nowrap;
  }

  .default {
    font-size: 11px;
    font-weight: 600;
    padding: 0 7px;
    border-radius: 9px;
    white-space: nowrap;
    background: color-mix(in srgb, var(--accent) 12%, var(--paper));
    color: var(--accent);
  }

  .preview {
    flex: 1;
    min-width: 0;
    font-size: 12px;
    color: var(--muted);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .anchor {
    position: relative;
    display: inline-flex;
  }

  .icon {
    min-width: 32px;
    justify-content: center;
  }

  .add {
    display: flex;
  }
</style>

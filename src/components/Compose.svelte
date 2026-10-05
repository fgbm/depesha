<script lang="ts">
  import { onDestroy, onMount, untrack } from "svelte";
  import { open as openDialog } from "@tauri-apps/plugin-dialog";
  import { api } from "../lib/api";
  import ChevronDown from "@lucide/svelte/icons/chevron-down";
  import Paperclip from "@lucide/svelte/icons/paperclip";
  import FileText from "@lucide/svelte/icons/file-text";
  import TriangleAlert from "@lucide/svelte/icons/triangle-alert";
  import Minus from "@lucide/svelte/icons/minus";
  import Maximize from "@lucide/svelte/icons/maximize-2";
  import Minimize from "@lucide/svelte/icons/minimize-2";
  import X from "@lucide/svelte/icons/x";
  import Trash from "@lucide/svelte/icons/trash-2";
  import Clock from "@lucide/svelte/icons/clock";
  import { app, type ComposeWindow } from "../lib/store.svelte";
  import { isDirty, swapSignature } from "../lib/compose";
  import { accountLabel, listDate, shortDateTime, size } from "../lib/format";
  import { t } from "../lib/i18n.svelte";
  import { extensions } from "../lib/extensions.svelte";
  import AddressInput from "./AddressInput.svelte";
  import Select from "./Select.svelte";
  import { registry } from "../plugin-host/registry.svelte";
  import type { ComposeContext } from "../plugin-api";

  let { c }: { c: ComposeWindow } = $props();
  // A window keeps its composition for life (keyed by id in App.svelte).
  let showCc = $state(untrack(() => c.draft.cc.length > 0 || c.draft.bcc.length > 0));
  let busy = $state(false);
  let error = $state("");
  let toInput = $state<AddressInput | null>(null);
  let ccInput = $state<AddressInput | null>(null);
  let bccInput = $state<AddressInput | null>(null);
  let body = $state<HTMLTextAreaElement | null>(null);

  const total = $derived(c.draft.attachments.reduce((n, a) => n + a.size, 0));
  /** Warnings the user has to look at before the message goes; null when not checked yet. */
  let warnings = $state<string[] | null>(null);
  let pendingAt: number | null = null;

  /** What plugins see of this window; they set the send options. */
  const options = $state<ComposeContext["options"]>({ at: null, followupDays: null });
  const composeCtx: ComposeContext = {
    get draft() {
      return c.draft;
    },
    accountEmail: () => app.account(c.account_id)?.email ?? "",
    insertText,
    options,
    send: (at) => send(at ?? null),
  };
  const controls = $derived(
    [...registry.items("composeControls")].sort((a, b) => (a.order ?? 50) - (b.order ?? 50)),
  );

  function insertText(text: string) {
    const at = body ? body.selectionStart : 0;
    c.draft.text = c.draft.text.slice(0, at) + text + c.draft.text.slice(at);
    queueMicrotask(() => {
      body?.focus();
      body?.setSelectionRange(at + text.length, at + text.length);
    });
  }

  // Entering the body of a fresh message puts the caret above the signature, once.
  let placed = false;
  function onBodyFocus() {
    if (placed || !body) return;
    placed = true;
    if (c.draft.text.startsWith("\n\n")) body.setSelectionRange(0, 0);
  }

  // Replies start typing above the quote and signature. Once, when the window opens:
  // an effect would rerun on every keystroke and throw the caret back to the start.
  // The field opens at its top, not at the end of a long quote: setting the value and
  // focusing scroll it to the end in WebKit, and moving the caret does not scroll back.
  onMount(() => {
    if (!body) return;
    if (c.draft.text.startsWith("\n\n") && c.draft.to.length) {
      placed = true;
      body.focus();
      body.setSelectionRange(0, 0);
    }
    body.scrollTop = 0;
    const field = body;
    requestAnimationFrame(() => (field.scrollTop = 0));
  });

  function setAccount(id: string) {
    const acc = app.account(id);
    if (!acc) return;
    c.draft.text = swapSignature(c.draft.text, app.account(c.account_id)?.signature, acc.signature);
    c.account_id = id;
    c.draft.from = { name: acc.display_name, email: acc.email };
  }

  async function attach() {
    const picked = await openDialog({ multiple: true, title: t("compose.attachTitle") });
    if (!picked) return;
    for (const path of Array.isArray(picked) ? picked : [picked]) {
      try {
        const info = await api.fileInfo(path);
        c.draft.attachments.push({ kind: "file", path, name: info.name, size: info.size });
      } catch (e) {
        app.fail(e);
      }
    }
  }

  function commitAll(): boolean {
    const ok = [toInput, ccInput, bccInput].map((i) => i?.commit() ?? true);
    return ok.every(Boolean);
  }

  /** `at`: scheduled time; `force`: the warnings were seen and accepted. */
  async function send(at: number | null = null, force = false) {
    error = "";
    if (!commitAll()) {
      error = t("compose.badAddresses");
      return;
    }
    if (c.draft.to.length + c.draft.cc.length + c.draft.bcc.length === 0) {
      error = t("compose.noRecipients");
      return;
    }
    if (!force) {
      const email = app.account(c.account_id)?.email ?? "";
      const draft = $state.snapshot(c.draft);
      const found: string[] = [];
      for (const check of registry.items("sendChecks")) {
        try {
          found.push(...check(draft, email));
        } catch (err) {
          console.error("send check failed:", err);
        }
      }
      busy = true;
      found.push(...(await extensions.beforeSend(draft, email)));
      busy = false;
      if (found.length) {
        warnings = found;
        pendingAt = at;
        return;
      }
    }
    warnings = null;
    busy = true;
    try {
      // The saved draft goes away once the letter is sent: the latest copy must be known.
      cancelAutosave();
      await saving;
      await app.send(c.account_id, $state.snapshot(c.draft), c.draft_id, at ?? options.at, options.followupDays);
      app.closeCompose(c.id);
    } catch (e) {
      error = (e as { message: string }).message;
    } finally {
      busy = false;
    }
  }

  // Drafts save themselves a moment after typing stops, as in Gmail and Yandex Mail:
  // closing or folding the window never loses the letter.
  const AUTOSAVE_MS = 3000;
  /** The content as it was last saved; the opening content counts as saved unless it is kept nowhere. */
  let lastSaved = untrack(() => (c.unsaved ? "" : JSON.stringify($state.snapshot(c.draft))));
  let saving: Promise<boolean> | null = null;
  let savingNow = $state(false);
  let timer: ReturnType<typeof setTimeout> | null = null;

  function cancelAutosave() {
    if (timer) clearTimeout(timer);
    timer = null;
  }

  $effect(() => {
    const now = JSON.stringify($state.snapshot(c.draft));
    cancelAutosave();
    if (now !== lastSaved) timer = setTimeout(() => saveDraft(), AUTOSAVE_MS);
  });
  onDestroy(cancelAutosave);

  /** Saves the draft on the server unless nothing changed; one save at a time. */
  async function saveDraft(): Promise<boolean> {
    cancelAutosave();
    while (saving) await saving;
    const draft = $state.snapshot(c.draft);
    const text = JSON.stringify(draft);
    if (text === lastSaved) return true;
    if (!isDirty(draft, app.account(c.account_id)?.signature) && c.draft_id === null) return true;
    savingNow = true;
    saving = (async () => {
      try {
        c.draft_id = await api.draftSave(c.account_id, draft, c.draft_id);
        lastSaved = text;
        c.unsaved = false;
        c.savedAt = Date.now();
        error = "";
        return true;
      } catch (e) {
        error = t("compose.draftNotSaved", { error: (e as { message: string }).message });
        return false;
      } finally {
        saving = null;
        savingNow = false;
      }
    })();
    return saving;
  }

  async function close() {
    if (busy) return;
    commitAll();
    const changed = JSON.stringify($state.snapshot(c.draft)) !== lastSaved;
    if (changed && !(await saveDraft())) {
      const drop = await app.confirm({ text: t("compose.closeAnyway"), okLabel: t("close"), cancelLabel: t("compose.goBack"), danger: true });
      if (!drop) return;
    }
    if (c.draft_id !== null) app.toast(t("compose.draftSaved"));
    app.closeCompose(c.id);
  }

  async function discard() {
    if (busy) return;
    if (isDirty(c.draft, app.account(c.account_id)?.signature)) {
      const ok = await app.confirm({ text: t("compose.discardConfirm"), okLabel: t("act.delete"), danger: true });
      if (!ok) return;
    }
    cancelAutosave();
    await saving;
    if (c.draft_id !== null) api.draftDiscard(c.draft_id).catch((e) => app.fail(e));
    app.closeCompose(c.id);
  }

  function minimize() {
    commitAll();
    c.mode = "min";
    saveDraft();
  }

  function toggleMax() {
    if (c.mode === "max") c.mode = "open";
    else app.showCompose(c.id, "max");
  }

  const savedText = $derived(c.savedAt ? t("compose.savedAt", { time: listDate(Math.floor(c.savedAt / 1000)) }) : "");

  function onKey(e: KeyboardEvent) {
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
      e.preventDefault();
      send(null, warnings !== null);
    } else if (e.key === "Escape") {
      // Gmail's way: Esc leaves full screen, then folds the window; the draft stays.
      e.preventDefault();
      if (c.mode === "max") c.mode = "open";
      else minimize();
    }
  }
</script>

{#if c.mode === "max"}
  <div class="backdrop" role="presentation" onclick={() => (c.mode = "open")}></div>
{/if}
<div
  class="compose"
  class:min={c.mode === "min"}
  class:max={c.mode === "max"}
  role="dialog"
  aria-label={c.draft.subject.trim() || t("compose.newMessage")}
  tabindex="-1"
  onkeydown={onKey}
>
  <header>
    <button class="title" onclick={() => (c.mode === "min" ? app.showCompose(c.id) : minimize())} title={c.mode === "min" ? "" : t("compose.minimize")}>
      {c.draft.subject.trim() || t("compose.newMessage")}
    </button>
    {#if c.mode !== "min"}<span class="saved" aria-live="polite">{savingNow ? t("compose.saving") : savedText}</span>{/if}
    <button class="hb" onclick={() => (c.mode === "min" ? app.showCompose(c.id) : minimize())} title={c.mode === "min" ? t("compose.restore") : t("compose.minimize")} aria-label={c.mode === "min" ? t("compose.restore") : t("compose.minimize")}>
      <Minus size={15} />
    </button>
    <button class="hb" onclick={toggleMax} title={c.mode === "max" ? t("compose.restore") : t("compose.maximize")} aria-label={c.mode === "max" ? t("compose.restore") : t("compose.maximize")}>
      {#if c.mode === "max"}<Minimize size={14} />{:else}<Maximize size={14} />{/if}
    </button>
    <button class="hb" onclick={close} title={t("compose.closeHint")} aria-label={t("close")}><X size={15} /></button>
  </header>

  <div class="panel" hidden={c.mode === "min"}>
    <div class="fields">
      <div class="row">
        <span class="label">{t("compose.fwd.from")}</span>
        <Select
          class="from"
          label={t("compose.fwd.from")}
          value={c.account_id}
          options={app.accounts.map((a) => ({
            value: a.id,
            label: (a.label?.trim() ? `${accountLabel(a)} — ` : "") + (a.display_name ? `${a.display_name} <${a.email}>` : a.email),
          }))}
          onchange={setAccount}
        />
        {#if !showCc}<button class="btn ghost small" onclick={() => (showCc = true)}>{t("compose.fwd.cc")}</button>{/if}
      </div>
      <AddressInput label={t("compose.fwd.to")} bind:value={c.draft.to} bind:this={toInput} autofocus={c.draft.to.length === 0} />
      {#if showCc}
        <AddressInput label={t("compose.fwd.cc")} bind:value={c.draft.cc} bind:this={ccInput} />
        <AddressInput label={t("compose.bcc")} bind:value={c.draft.bcc} bind:this={bccInput} />
      {/if}
      <div class="row">
        <span class="label">{t("compose.fwd.subject")}</span>
        <input class="subject" bind:value={c.draft.subject} />
      </div>
    </div>

    <textarea bind:this={body} bind:value={c.draft.text} onfocus={onBodyFocus} spellcheck="true" placeholder={t("compose.bodyPlaceholder")}></textarea>

    {#if c.draft.attachments.length}
      <div class="files">
        {#each c.draft.attachments as a, i (i)}
          <span class="file"><Paperclip size={12} /> {a.name} <span class="muted">{size(a.size)}</span>
            <button onclick={() => c.draft.attachments.splice(i, 1)} aria-label={t("remove")}>×</button></span>
        {/each}
        <span class="muted total" class:danger-text={total > 25 * 1024 * 1024}>
          {t("compose.total", { size: size(total) })}{total > 25 * 1024 * 1024 ? t("compose.tooBig") : ""}
        </span>
      </div>
    {/if}

    {#if error}<div class="error danger-text selectable">{error}</div>{/if}

    {#if warnings}
      <div class="warnings" role="alert">
        <TriangleAlert size={18} />
        <div class="list">
          {#each warnings as w, i (i)}<div>{w}</div>{/each}
        </div>
        <button class="btn" onclick={() => (warnings = null)}>{t("compose.fix")}</button>
        <button class="btn primary" onclick={() => send(pendingAt, true)}>{t("compose.sendAnyway")}</button>
      </div>
    {/if}

    <footer>
      <span class="split-btn anchor">
        <button class="btn primary main" onclick={() => send()} disabled={busy}>{options.at ? t("compose.schedule") : t("compose.send")} <kbd>Ctrl+Enter</kbd></button>
        {#each controls.filter((x) => x.slot === "send") as x (x)}<x.component {...x.props} compose={composeCtx} />{/each}
      </span>
      {#if options.at}
        <span class="scheduled">
          <Clock size={14} />
          {t("compose.scheduledFor", { when: shortDateTime(options.at) })}
          <button class="btn ghost icon" onclick={() => (options.at = null)} title={t("compose.unschedule")} aria-label={t("compose.unschedule")}><X size={13} /></button>
        </span>
      {/if}
      <button class="btn" onclick={attach} disabled={busy} title={t("compose.attachHint")}><Paperclip size={15} /> {t("compose.files")}</button>
      {#each controls.filter((x) => x.slot !== "send") as x (x)}<x.component {...x.props} compose={composeCtx} />{/each}
      <span class="spacer"></span>
      <button class="btn ghost icon" onclick={discard} disabled={busy} title={t("compose.discardDraft")} aria-label={t("compose.discardDraft")}><Trash size={15} /></button>
    </footer>
  </div>
</div>

<style>
  .compose {
    display: flex;
    flex-direction: column;
    width: min(640px, calc(100vw - 32px));
    height: min(640px, calc(100vh - 56px));
    background: var(--paper);
    border-radius: 10px 10px 0 0;
    box-shadow: 0 8px 40px rgb(0 0 0 / 28%), 0 0 0 1px rgb(0 0 0 / 6%);
    overflow: hidden;
  }

  .compose.min {
    width: 280px;
    height: auto;
  }

  .compose.max {
    position: fixed;
    inset: 32px max(32px, calc((100vw - 1040px) / 2));
    width: auto;
    height: auto;
    border-radius: 12px;
    z-index: 1;
  }

  .backdrop {
    position: fixed;
    inset: 0;
    background: rgb(10 14 20 / 45%);
  }

  .panel {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
  }

  .panel[hidden] {
    display: none;
  }

  /* The dark bar of Gmail's composer: folded windows are told apart by it. */
  header {
    display: flex;
    align-items: center;
    gap: 2px;
    padding: 4px 6px 4px 4px;
    background: var(--side);
    color: var(--side-ink);
    flex: none;
  }

  .title {
    flex: 1;
    min-width: 0;
    border: none;
    background: none;
    color: inherit;
    text-align: left;
    padding: 6px 10px;
    font-size: 14px;
    font-weight: 600;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .hb {
    border: none;
    background: none;
    color: var(--side-muted);
    width: 28px;
    height: 28px;
    border-radius: 6px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex: none;
  }

  .hb:hover {
    background: rgb(255 255 255 / 12%);
    color: var(--side-ink);
  }

  .saved {
    font-size: 12px;
    white-space: nowrap;
    color: var(--side-muted);
    padding: 0 6px;
  }

  .icon {
    min-width: 32px;
    justify-content: center;
  }

  .fields {
    padding: 4px 18px 0;
  }

  .row {
    display: flex;
    align-items: center;
    gap: 8px;
    border-bottom: 1px solid var(--line);
    padding: 4px 0;
  }

  .label {
    width: 64px;
    color: var(--muted);
    flex: none;
  }

  .row :global(.from) {
    flex: 1;
  }

  .row :global(.from .trigger) {
    border-color: transparent;
    padding-left: 0;
  }

  .row :global(.from .trigger:focus) {
    box-shadow: none;
  }

  .subject {
    flex: 1;
    border: none;
    outline: none;
    background: transparent;
    padding: 6px 2px;
    font-weight: 600;
  }

  .small {
    font-size: 12px;
  }

  textarea {
    flex: 1;
    margin: 0;
    border: none;
    outline: none;
    resize: none;
    padding: 14px 18px;
    background: var(--paper);
    line-height: 1.55;
    user-select: text;
  }

  .files {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    padding: 8px 18px;
    border-top: 1px solid var(--line);
    align-items: center;
  }

  .file {
    background: var(--hover);
    border-radius: 6px;
    padding: 3px 4px 3px 8px;
    font-size: 13px;
  }

  .file button {
    border: none;
    background: none;
    color: var(--muted);
  }

  .total {
    font-size: 12px;
  }

  .error {
    padding: 6px 18px;
  }

  footer {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 10px 18px 14px;
    border-top: 1px solid var(--line);
  }

  footer kbd {
    border-color: rgb(255 255 255 / 40%);
    color: var(--accent-ink);
  }

  .anchor {
    position: relative;
    display: inline-flex;
  }

  .split-btn .main {
    border-top-right-radius: 0;
    border-bottom-right-radius: 0;
  }



  .warnings {
    display: flex;
    align-items: center;
    gap: 10px;
    margin: 0 18px 8px;
    padding: 10px 12px;
    border-radius: 8px;
    background: color-mix(in srgb, var(--warn) 12%, var(--paper));
    border: 1px solid color-mix(in srgb, var(--warn) 40%, var(--paper));
    color: var(--ink);
  }

  .warnings :global(svg) {
    color: var(--warn);
    flex: none;
  }

  .warnings .list {
    flex: 1;
    line-height: 1.45;
  }

  .spacer {
    flex: 1;
  }

  .scheduled {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    color: var(--accent);
    font-size: 13px;
    white-space: nowrap;
  }
</style>

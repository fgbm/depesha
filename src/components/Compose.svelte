<script lang="ts">
  import { onMount } from "svelte";
  import { ask, open as openDialog } from "@tauri-apps/plugin-dialog";
  import { app } from "../lib/store.svelte";
  import { api } from "../lib/api";
  import ChevronDown from "@lucide/svelte/icons/chevron-down";
  import Paperclip from "@lucide/svelte/icons/paperclip";
  import FileText from "@lucide/svelte/icons/file-text";
  import TriangleAlert from "@lucide/svelte/icons/triangle-alert";
  import { isDirty, swapSignature } from "../lib/compose";
  import { size } from "../lib/format";
  import { sendLaterPresets } from "../lib/later";
  import { preflight, type Warning } from "../lib/preflight";
  import AddressInput from "./AddressInput.svelte";
  import Popover from "./Popover.svelte";
  import LaterMenu from "./LaterMenu.svelte";

  const c = app.compose!;
  let showCc = $state(c.draft.cc.length > 0 || c.draft.bcc.length > 0);
  let busy = $state(false);
  let error = $state("");
  let toInput = $state<AddressInput | null>(null);
  let ccInput = $state<AddressInput | null>(null);
  let bccInput = $state<AddressInput | null>(null);
  let body = $state<HTMLTextAreaElement | null>(null);

  const total = $derived(c.draft.attachments.reduce((n, a) => n + a.size, 0));
  let laterOpen = $state(false);
  let templatesOpen = $state(false);
  /** Remind if nobody answers within this many days; 0 for no reminder. */
  let remindDays = $state(0);
  /** Warnings the user has to look at before the message goes; null when not checked yet. */
  let warnings = $state<Warning[] | null>(null);
  let pendingAt: number | null = null;

  function insertTemplate(text: string) {
    templatesOpen = false;
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
  onMount(() => {
    if (body && c.draft.text.startsWith("\n\n") && c.draft.to.length) {
      placed = true;
      body.focus();
      body.setSelectionRange(0, 0);
    }
  });

  function setAccount(id: string) {
    const acc = app.account(id);
    if (!acc) return;
    c.draft.text = swapSignature(c.draft.text, app.account(c.account_id)?.signature, acc.signature);
    c.account_id = id;
    c.draft.from = { name: acc.display_name, email: acc.email };
  }

  async function attach() {
    const picked = await openDialog({ multiple: true, title: "Прикрепить файлы" });
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
    laterOpen = false;
    if (!commitAll()) {
      error = "Проверьте адреса: некоторые не похожи на почтовые.";
      return;
    }
    if (c.draft.to.length + c.draft.cc.length + c.draft.bcc.length === 0) {
      error = "Укажите хотя бы одного получателя.";
      return;
    }
    if (!force) {
      const found = preflight(c.draft, app.account(c.account_id)?.email ?? "");
      if (found.length) {
        warnings = found;
        pendingAt = at;
        return;
      }
    }
    warnings = null;
    busy = true;
    try {
      await app.send(c.account_id, $state.snapshot(c.draft), c.draft_id, at, remindDays || null);
      app.compose = null;
    } catch (e) {
      error = (e as { message: string }).message;
    } finally {
      busy = false;
    }
  }

  async function saveDraft(): Promise<boolean> {
    commitAll();
    busy = true;
    error = "";
    try {
      await api.draftSave(c.account_id, $state.snapshot(c.draft), c.draft_id);
      return true;
    } catch (e) {
      error = `Черновик не сохранён: ${(e as { message: string }).message}`;
      return false;
    } finally {
      busy = false;
    }
  }

  async function close() {
    if (busy) return;
    if (isDirty(c.draft, app.account(c.account_id)?.signature)) {
      if (!(await saveDraft())) {
        const drop = await ask("Черновик не удалось сохранить на сервере. Закрыть и потерять письмо?", {
          title: "Депеша",
          kind: "warning",
          okLabel: "Закрыть",
          cancelLabel: "Вернуться",
        });
        if (!drop) return;
      } else {
        app.toast("Черновик сохранён");
      }
    }
    app.compose = null;
  }

  async function discard() {
    if (isDirty(c.draft, app.account(c.account_id)?.signature)) {
      const ok = await ask("Удалить это письмо без сохранения?", { title: "Депеша", kind: "warning", okLabel: "Удалить", cancelLabel: "Отмена" });
      if (!ok) return;
    }
    app.compose = null;
  }

  function onKey(e: KeyboardEvent) {
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
      e.preventDefault();
      send(null, warnings !== null);
    } else if (e.key === "Escape") {
      e.preventDefault();
      close();
    }
  }
</script>

<div class="modal-backdrop" role="presentation">
  <div class="modal compose" role="dialog" aria-label="Новое письмо" tabindex="-1" onkeydown={onKey}>
    <header>
      <h3>{c.draft.subject.trim() || "Новое письмо"}</h3>
      <button class="btn ghost" onclick={close} title="Закрыть (Esc), черновик сохранится">×</button>
    </header>

    <div class="fields">
      <div class="row">
        <span class="label">От</span>
        <select class="input from" value={c.account_id} onchange={(e) => setAccount(e.currentTarget.value)}>
          {#each app.accounts as a (a.id)}
            <option value={a.id}>{a.display_name ? `${a.display_name} <${a.email}>` : a.email}</option>
          {/each}
        </select>
        {#if !showCc}<button class="btn ghost small" onclick={() => (showCc = true)}>Копия</button>{/if}
      </div>
      <AddressInput label="Кому" bind:value={c.draft.to} bind:this={toInput} autofocus={c.draft.to.length === 0} />
      {#if showCc}
        <AddressInput label="Копия" bind:value={c.draft.cc} bind:this={ccInput} />
        <AddressInput label="Скрытая" bind:value={c.draft.bcc} bind:this={bccInput} />
      {/if}
      <div class="row">
        <span class="label">Тема</span>
        <input class="subject" bind:value={c.draft.subject} />
      </div>
    </div>

    <textarea bind:this={body} bind:value={c.draft.text} onfocus={onBodyFocus} spellcheck="true" placeholder="Текст письма"></textarea>

    {#if c.draft.attachments.length}
      <div class="files">
        {#each c.draft.attachments as a, i (i)}
          <span class="file"><Paperclip size={12} /> {a.name} <span class="muted">{size(a.size)}</span>
            <button onclick={() => c.draft.attachments.splice(i, 1)} aria-label="Убрать">×</button></span>
        {/each}
        <span class="muted total" class:danger-text={total > 25 * 1024 * 1024}>
          всего {size(total)}{total > 25 * 1024 * 1024 ? " — многие серверы не примут больше 25 МБ" : ""}
        </span>
      </div>
    {/if}

    {#if error}<div class="error danger-text selectable">{error}</div>{/if}

    {#if warnings}
      <div class="warnings" role="alert">
        <TriangleAlert size={18} />
        <div class="list">
          {#each warnings as w (w.kind)}<div>{w.text}</div>{/each}
        </div>
        <button class="btn" onclick={() => (warnings = null)}>Исправить</button>
        <button class="btn primary" onclick={() => send(pendingAt, true)}>Отправить всё равно</button>
      </div>
    {/if}

    <footer>
      <span class="split-btn anchor">
        <button class="btn primary main" onclick={() => send()} disabled={busy}>Отправить <kbd>Ctrl+Enter</kbd></button>
        <button class="btn primary more" onclick={() => (laterOpen = !laterOpen)} disabled={busy} title="Отправить позже" aria-label="Отправить позже">
          <ChevronDown size={15} />
        </button>
        <Popover bind:open={laterOpen} align="left">
          <LaterMenu title="Отправить позже" presets={sendLaterPresets()} action="Запланировать" onPick={(at) => send(at)} />
        </Popover>
      </span>
      <select class="input remind" bind:value={remindDays} title="Напомнить, если не ответят">
        <option value={0}>Без напоминания</option>
        <option value={1}>Напомнить через день без ответа</option>
        <option value={3}>Напомнить через 3 дня без ответа</option>
        <option value={7}>Напомнить через неделю без ответа</option>
      </select>
      <button class="btn" onclick={attach} disabled={busy} title="Прикрепить файлы или перетащить их в окно"><Paperclip size={15} /> Файлы</button>
      {#if app.settings.templates.length}
        <span class="anchor">
          <button class="btn" onclick={() => (templatesOpen = !templatesOpen)}><FileText size={15} /> Шаблоны</button>
          <Popover bind:open={templatesOpen} align="left">
            <div class="mt">Вставить шаблон</div>
            {#each app.settings.templates as t, i (i)}
              <button class="mi" onclick={() => insertTemplate(t.text)}>{t.name}</button>
            {/each}
          </Popover>
        </span>
      {/if}
      <span class="spacer"></span>
      <button class="btn ghost" onclick={async () => { if (await saveDraft()) { app.compose = null; app.toast("Черновик сохранён"); } }} disabled={busy}>Сохранить черновик</button>
      <button class="btn ghost" onclick={discard} disabled={busy}>Удалить</button>
    </footer>
  </div>
</div>

<style>
  .compose {
    width: min(860px, calc(100vw - 40px));
    height: min(720px, calc(100vh - 40px));
  }

  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 10px 12px 6px 18px;
  }

  h3 {
    margin: 0;
    font-size: 15px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .fields {
    padding: 0 18px;
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

  .from {
    flex: 1;
    border: none;
    padding-left: 0;
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

  .split-btn .more {
    border-top-left-radius: 0;
    border-bottom-left-radius: 0;
    border-left: 1px solid rgb(255 255 255 / 25%);
    padding: 5px 6px;
  }

  .remind {
    max-width: 230px;
    font-size: 13px;
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
</style>

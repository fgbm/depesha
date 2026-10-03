<script lang="ts">
  import { ask, open as openDialog, save } from "@tauri-apps/plugin-dialog";
  import { app } from "../lib/store.svelte";
  import { api } from "../lib/api";
  import { addrFull, addrName, linkify, longDate, size } from "../lib/format";
  import { emptyDraft, fromDraft, withSignature } from "../lib/compose";
  import MailFrame from "./MailFrame.svelte";
  import type { Addr, AttachmentInfo } from "../lib/types";

  let { onReply, onForward }: { onReply: (all: boolean) => void; onForward: () => void } = $props();

  const msg = $derived(app.opened);
  const account = $derived(msg ? app.account(msg.row.account_id) : undefined);
  const folders = $derived(
    msg ? app.folders.filter((f) => f.account_id === msg.row.account_id && f.selectable && !f.hidden && f.name !== msg.row.folder) : [],
  );
  const isDraft = $derived(msg ? app.folder(msg.row.account_id, msg.row.folder)?.role === "drafts" : false);
  const files = $derived(msg ? msg.view.attachments.filter((a) => !(a.inline && a.content_id)) : []);
  const showRemoteBanner = $derived(!!msg && msg.view.has_remote_content && !app.allowRemote && !msg.trusted_sender);
  const bulk = $derived(app.selected.size > 1);
  const bulkAccount = $derived.by(() => {
    const ids = [...app.selected];
    const accs = new Set(app.messages.filter((m) => ids.includes(m.id)).map((m) => m.account_id));
    return accs.size === 1 ? [...accs][0] : null;
  });
  const bulkFolders = $derived(bulkAccount ? app.folders.filter((f) => f.account_id === bulkAccount && f.selectable && !f.hidden) : []);

  async function link(href: string) {
    if (href.toLowerCase().startsWith("mailto:")) {
      const acc = account ?? app.accounts[0];
      if (!acc) return;
      const to = decodeURIComponent(href.slice(7).split("?")[0]);
      const draft = emptyDraft({ name: acc.display_name, email: acc.email });
      draft.to = to ? to.split(",").map((email) => ({ name: null, email: email.trim() })) : [];
      const subject = new URLSearchParams(href.split("?")[1] ?? "").get("subject");
      if (subject) draft.subject = subject;
      app.compose = { account_id: acc.id, draft: withSignature(draft, acc.signature), draft_id: null };
      return;
    }
    const ok = await ask(`Открыть ссылку в браузере?\n\n${href}`, { title: "Депеша", okLabel: "Открыть", cancelLabel: "Отмена" });
    if (ok) api.openLink(href).catch((e) => app.fail(e));
  }

  async function openAttachment(a: AttachmentInfo) {
    if (!msg) return;
    try {
      await api.attachmentOpen(msg.row.id, a.index);
    } catch (e) {
      app.fail(e);
    }
  }

  async function saveAttachment(a: AttachmentInfo) {
    if (!msg) return;
    const path = await save({ defaultPath: a.name, title: "Сохранить вложение" });
    if (!path) return;
    try {
      await api.attachmentSave(msg.row.id, a.index, path);
      app.toast(`Сохранено: ${a.name}`);
    } catch (e) {
      app.fail(e);
    }
  }

  async function saveAll() {
    if (!msg) return;
    const dir = await openDialog({ directory: true, title: "Куда сохранить вложения" });
    if (!dir || Array.isArray(dir)) return;
    try {
      const n = await api.attachmentsSaveAll(msg.row.id, dir);
      app.toast(`Сохранено вложений: ${n}`);
    } catch (e) {
      app.fail(e);
    }
  }

  async function trustSender() {
    const email = msg?.view.summary.from?.email;
    if (!email || !msg) return;
    await api.trustSender(email).catch((e) => app.fail(e));
    app.open(msg.row.id, true);
  }

  function editDraft() {
    if (!msg || !account) return;
    app.compose = {
      account_id: account.id,
      draft: fromDraft(msg, { name: account.display_name, email: account.email }),
      draft_id: msg.row.id,
    };
  }

  function list(addrs: Addr[]): string {
    return addrs.map(addrFull).join(", ");
  }
</script>

<section class="reader">
  {#if bulk}
    <div class="center">
      <h3>Выбрано писем: {app.selected.size}</h3>
      <div class="actions">
        <button class="btn" onclick={() => app.flag("seen", true)}>Прочитано</button>
        <button class="btn" onclick={() => app.flag("seen", false)}>Не прочитано</button>
        <button class="btn" onclick={() => app.flag("flagged", true)}>⚑ Флаг</button>
        <button class="btn" onclick={() => app.remove()}>🗑 Удалить</button>
        {#if bulkFolders.length}
          <select class="input" onchange={(e) => { const v = e.currentTarget.value; e.currentTarget.value = ""; if (v) app.moveTo(v); }}>
            <option value="">В папку…</option>
            {#each bulkFolders as f (f.name)}<option value={f.name}>{f.display_name}</option>{/each}
          </select>
        {/if}
      </div>
    </div>
  {:else if app.openError}
    <div class="center">
      <p class="danger-text">{app.openError.message}</p>
      {#if app.opened === null && app.selected.size === 1}
        <button class="btn" onclick={() => app.open([...app.selected][0])}>Повторить</button>
      {/if}
    </div>
  {:else if msg}
    <div class="toolbar">
      {#if isDraft}
        <button class="btn primary" onclick={editDraft}>✎ Продолжить черновик</button>
      {:else}
        <button class="btn" onclick={() => onReply(false)} title="Ответить (r)">↩ Ответить</button>
        <button class="btn" onclick={() => onReply(true)} title="Ответить всем (a)">↩↩ Всем</button>
        <button class="btn" onclick={onForward} title="Переслать (f)">↪ Переслать</button>
      {/if}
      <span class="sep"></span>
      <button
        class="btn ghost icon"
        class:on={msg.row.flags.flagged}
        onclick={() => app.flag("flagged", !msg.row.flags.flagged)}
        title={msg.row.flags.flagged ? "Снять флаг (s)" : "Поставить флаг (s)"}
        aria-label="Флаг">{msg.row.flags.flagged ? "⚑" : "⚐"}</button
      >
      <button
        class="btn ghost icon"
        onclick={() => app.flag("seen", !msg.row.flags.seen)}
        title={msg.row.flags.seen ? "Отметить непрочитанным (u)" : "Отметить прочитанным (u)"}
        aria-label="Прочитано">{msg.row.flags.seen ? "✉" : "●"}</button
      >
      {#if folders.length}
        <select class="input move" onchange={(e) => { const v = e.currentTarget.value; e.currentTarget.value = ""; if (v) app.moveTo(v); }}>
          <option value="">В папку…</option>
          {#each folders as f (f.name)}<option value={f.name}>{f.display_name}</option>{/each}
        </select>
      {/if}
      <button class="btn ghost" onclick={() => app.remove()} title="Удалить (Delete)">🗑</button>
    </div>

    <div class="head selectable">
      <h1>{msg.view.summary.subject || "(без темы)"}</h1>
      <div class="from">
        <span class="avatar">{(addrName(msg.view.summary.from) || "?").slice(0, 1).toUpperCase()}</span>
        <div class="who">
          <div>
            <b>{msg.view.summary.from?.name ?? msg.view.summary.from?.email ?? "(без отправителя)"}</b>
            {#if msg.view.summary.from?.name}<span class="muted">&lt;{msg.view.summary.from.email}&gt;</span>{/if}
          </div>
          {#if msg.view.summary.to.length}<div class="muted small">Кому: {list(msg.view.summary.to)}</div>{/if}
          {#if msg.view.summary.cc.length}<div class="muted small">Копия: {list(msg.view.summary.cc)}</div>{/if}
        </div>
        <div class="date muted small">
          {longDate(msg.view.summary.date ?? msg.row.date)}
          {#if app.accounts.length > 1 && account}<div>{account.display_name || account.email}</div>{/if}
        </div>
      </div>
    </div>

    {#if showRemoteBanner}
      <div class="banner">
        <span>Внешние картинки скрыты: по ним отправитель узнаёт, что вы открыли письмо.</span>
        <button class="btn" onclick={() => app.open(msg.row.id, true)}>Показать</button>
        {#if msg.view.summary.from}
          <button class="btn ghost" onclick={trustSender}>Всегда для {msg.view.summary.from.email}</button>
        {/if}
      </div>
    {/if}

    {#if files.length}
      <div class="files">
        {#each files as a (a.index)}
          <div class="file">
            <button class="file-name" onclick={() => openAttachment(a)} title="Открыть">📎 {a.name}</button>
            <span class="muted small">{size(a.size)}</span>
            <button class="btn ghost small-btn" onclick={() => saveAttachment(a)} title="Сохранить">⤓</button>
          </div>
        {/each}
        {#if files.length > 1}<button class="btn ghost small-btn" onclick={saveAll}>Сохранить все</button>{/if}
      </div>
    {/if}

    <div class="body">
      {#if msg.view.html}
        <!-- WebKitGTK does not reload an iframe when srcdoc changes: recreate it instead. -->
        {#key `${msg.row.id}:${app.allowRemote || msg.trusted_sender}`}
          <MailFrame html={msg.view.html} allowRemote={app.allowRemote || msg.trusted_sender} onLink={link} />
        {/key}
      {:else}
        <div class="plain selectable">
          {#each linkify(msg.view.text ?? "") as part, i (i)}
            {#if part.href}<a href={part.href} onclick={(e) => { e.preventDefault(); link(part.href!); }}>{part.text}</a>{:else}{part.text}{/if}
          {/each}
        </div>
      {/if}
    </div>
  {:else if app.opening}
    <div class="center muted">Загрузка письма…</div>
  {:else}
    <div class="center muted">
      <div class="hint">
        <p>Выберите письмо</p>
        <p class="small"><kbd>j</kbd>/<kbd>k</kbd> — следующее/предыдущее, <kbd>r</kbd> — ответить, <kbd>a</kbd> — всем, <kbd>f</kbd> — переслать, <kbd>c</kbd> — написать, <kbd>/</kbd> — поиск</p>
      </div>
    </div>
  {/if}
</section>

<style>
  .reader {
    display: flex;
    flex-direction: column;
    min-width: 0;
    min-height: 0;
    background: var(--paper-2);
  }

  .center {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 12px;
    padding: 24px;
    text-align: center;
  }

  .hint .small {
    max-width: 380px;
    line-height: 1.9;
  }

  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    justify-content: center;
  }

  .toolbar {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 10px 16px;
    border-bottom: 1px solid var(--line);
    background: var(--paper);
    flex-wrap: wrap;
  }

  .sep {
    flex: 1;
  }

  .move {
    max-width: 150px;
  }

  .icon {
    min-width: 32px;
    justify-content: center;
    font-size: 15px;
  }

  .icon.on {
    color: var(--accent);
  }

  .head {
    padding: 16px 22px 10px;
  }

  h1 {
    margin: 0 0 12px;
    font-size: 20px;
    font-weight: 650;
    line-height: 1.3;
  }

  .from {
    display: flex;
    gap: 12px;
    align-items: flex-start;
  }

  .avatar {
    width: 36px;
    height: 36px;
    border-radius: 50%;
    background: var(--side);
    color: var(--side-ink);
    display: flex;
    align-items: center;
    justify-content: center;
    font-weight: 700;
    flex: none;
  }

  .who {
    flex: 1;
    min-width: 0;
    line-height: 1.45;
  }

  .who > div {
    overflow-wrap: anywhere;
  }

  .date {
    text-align: right;
    white-space: nowrap;
  }

  .small {
    font-size: 12px;
  }

  .banner {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
    margin: 0 22px 10px;
    padding: 8px 12px;
    background: color-mix(in srgb, var(--warn) 12%, var(--paper));
    border: 1px solid color-mix(in srgb, var(--warn) 35%, var(--paper));
    border-radius: 6px;
    font-size: 13px;
  }

  .banner span {
    flex: 1;
    min-width: 200px;
  }

  .files {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin: 0 22px 10px;
    align-items: center;
  }

  .file {
    display: flex;
    align-items: center;
    gap: 4px;
    border: 1px solid var(--line);
    background: var(--paper);
    border-radius: 6px;
    padding: 2px 4px 2px 8px;
    max-width: 320px;
  }

  .file-name {
    background: none;
    border: none;
    padding: 2px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--link);
  }

  .small-btn {
    padding: 2px 6px;
    font-size: 12px;
  }

  .body {
    flex: 1;
    min-height: 0;
    display: flex;
    margin: 0 16px 16px;
  }

  .plain {
    flex: 1;
    overflow: auto;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    background: var(--paper);
    border-radius: 6px;
    padding: 18px 22px;
    line-height: 1.55;
  }

  .plain a {
    color: var(--link);
  }
</style>

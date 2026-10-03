<script lang="ts">
  import { ask, open as openDialog, save } from "@tauri-apps/plugin-dialog";
  import Reply from "@lucide/svelte/icons/reply";
  import ReplyAll from "@lucide/svelte/icons/reply-all";
  import Forward from "@lucide/svelte/icons/forward";
  import Archive from "@lucide/svelte/icons/archive";
  import AlarmClock from "@lucide/svelte/icons/alarm-clock";
  import Trash from "@lucide/svelte/icons/trash-2";
  import Ellipsis from "@lucide/svelte/icons/ellipsis";
  import Flag from "@lucide/svelte/icons/flag";
  import Mail from "@lucide/svelte/icons/mail";
  import MailOpen from "@lucide/svelte/icons/mail-open";
  import ShieldAlert from "@lucide/svelte/icons/shield-alert";
  import ListX from "@lucide/svelte/icons/list-x";
  import Folder from "@lucide/svelte/icons/folder";
  import Paperclip from "@lucide/svelte/icons/paperclip";
  import Download from "@lucide/svelte/icons/download";
  import Pencil from "@lucide/svelte/icons/pencil";
  import MessageSquareReply from "@lucide/svelte/icons/message-square-reply";
  import { app } from "../lib/store.svelte";
  import { api } from "../lib/api";
  import { addrFull, avatarColor, initials, linkify, listDate, longDate, size } from "../lib/format";
  import { emptyDraft, fromDraft, withSignature } from "../lib/compose";
  import { snoozePresets, when } from "../lib/later";
  import MailFrame from "./MailFrame.svelte";
  import Popover from "./Popover.svelte";
  import LaterMenu from "./LaterMenu.svelte";
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

  let moreOpen = $state(false);
  let bulkSnooze = $state(false);
  let moveOpen = $state(false);

  function snoozeTo(until: number) {
    app.snoozeOpen = false;
    bulkSnooze = false;
    app.snooze(until);
  }

  /** Every letter of this sender, wherever it lies. */
  function fromSender() {
    const email = msg?.view.summary.from?.email;
    if (email) app.setView({ kind: "search", text: `from:${email}` });
  }

  let confirmUnsub = $state(false);
  const listName = $derived(msg?.view.summary.from?.name ?? msg?.view.summary.from?.email ?? "рассылки");

  async function unsubscribe() {
    if (!msg) return;
    confirmUnsub = false;
    const who = listName;
    try {
      const r = await api.unsubscribe(msg.row.id);
      if (r.kind === "done") app.toast(`Вы отписаны от «${who}».`);
      else if (r.kind === "mail-sent") app.toast(`Запрос на отписку отправлен на ${r.to}.`);
      else link(r.url);
    } catch (e) {
      app.fail(e, "Отписаться не удалось");
    }
  }

  async function stopWaiting() {
    if (!msg) return;
    await api.followupCancel(msg.row.id).catch((e) => app.fail(e));
    msg.row.followup_due = null;
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
        <button class="btn" onclick={() => app.archive()}><Archive size={15} /> Готово</button>
        <span class="anchor">
          <button class="btn" onclick={() => (bulkSnooze = !bulkSnooze)}><AlarmClock size={15} /> Отложить</button>
          <Popover bind:open={bulkSnooze} align="left">
            <LaterMenu title="Вернуть во входящие" presets={snoozePresets()} action="Отложить" onPick={snoozeTo} />
          </Popover>
        </span>
        <button class="btn" onclick={() => app.flag("seen", true)}>Прочитано</button>
        <button class="btn" onclick={() => app.flag("seen", false)}>Не прочитано</button>
        <button class="btn" onclick={() => app.flag("flagged", true)}><Flag size={15} /> Флаг</button>
        <button class="btn" onclick={() => app.remove()}><Trash size={15} /> Удалить</button>
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
        <button class="btn primary" onclick={editDraft}><Pencil size={15} /> Продолжить черновик</button>
      {:else}
        <button class="btn" onclick={() => onReply(false)} title="Ответить (r)"><Reply size={15} /> Ответить</button>
        <button class="btn" onclick={() => onReply(true)} title="Ответить всем (a)"><ReplyAll size={15} /><span class="lbl">Всем</span></button>
        <button class="btn" onclick={onForward} title="Переслать (f)"><Forward size={15} /><span class="lbl">Переслать</span></button>
      {/if}
      <span class="sep"></span>
      <button class="btn ghost" onclick={() => app.archive()} title="Готово: убрать в архив (e)"><Archive size={16} /><span class="lbl2">Готово</span></button>
      <span class="anchor">
        <button class="btn ghost" onclick={() => (app.snoozeOpen = !app.snoozeOpen)} title="Отложить: вернётся во входящие позже (h)">
          <AlarmClock size={16} /><span class="lbl2">Отложить</span>
        </button>
        <Popover bind:open={app.snoozeOpen}>
          <LaterMenu title="Вернуть во входящие" presets={snoozePresets()} action="Отложить" onPick={snoozeTo} />
        </Popover>
      </span>
      <button class="btn ghost icon" onclick={() => app.remove()} title="Удалить (Delete)" aria-label="Удалить"><Trash size={16} /></button>
      <span class="anchor">
        <button class="btn ghost icon" onclick={() => (moreOpen = !moreOpen)} title="Ещё" aria-label="Ещё"><Ellipsis size={16} /></button>
        <Popover bind:open={moreOpen}>
          <button class="mi" onclick={() => { moreOpen = false; app.flag("flagged", !msg.row.flags.flagged); }}>
            <Flag size={15} /> {msg.row.flags.flagged ? "Снять флаг" : "Поставить флаг"}<span class="hint">s</span>
          </button>
          <button class="mi" onclick={() => { moreOpen = false; app.flag("seen", !msg.row.flags.seen); }}>
            {#if msg.row.flags.seen}<Mail size={15} /> Отметить непрочитанным{:else}<MailOpen size={15} /> Отметить прочитанным{/if}<span class="hint">u</span>
          </button>
          {#if folders.length}
            <button class="mi" onclick={() => { moreOpen = false; moveOpen = true; }}><Folder size={15} /> Переместить в папку…</button>
          {/if}
          <hr />
          <button class="mi" onclick={() => { moreOpen = false; app.spam(); }}><ShieldAlert size={15} /> Это спам<span class="hint">!</span></button>
          {#if msg.view.summary.unsubscribe}
            <button class="mi" onclick={() => { moreOpen = false; confirmUnsub = true; }}><ListX size={15} /> Отписаться</button>
          {/if}
        </Popover>
        <Popover bind:open={moveOpen}>
          <div class="mt">Переместить в папку</div>
          <div class="folder-list">
            {#each folders as f (f.name)}
              <button class="mi" onclick={() => { moveOpen = false; app.moveTo(f.name); }}><Folder size={15} /> {f.display_name}</button>
            {/each}
          </div>
        </Popover>
      </span>
    </div>

    <div class="scroll">
      {#if app.conversation.length > 1}
        <div class="conversation" aria-label="Цепочка писем">
          {#each app.conversation as m (m.id)}
            {#if m.id === msg.row.id}
              <div class="conv current"><span class="dot"></span>{m.from?.name ?? m.from?.email ?? ""}<span class="muted">· открыто</span></div>
            {:else}
              <button class="conv" class:unread={!m.flags.seen} onclick={() => app.open(m.id)}>
                <span class="mini" style:background={avatarColor(m.from?.email ?? "")}>{initials(m.from)}</span>
                <span class="who">{m.from?.name ?? m.from?.email ?? ""}</span>
                {#if app.folder(m.account_id, m.folder)?.role === "sent"}<span class="muted">· вы ответили</span>{/if}
                <span class="when muted">{listDate(m.date)}</span>
              </button>
            {/if}
          {/each}
        </div>
      {/if}

      <div class="head selectable">
        <h1>{msg.view.summary.subject || "(без темы)"}</h1>
        <div class="from">
          <span class="avatar" style:background={avatarColor(msg.view.summary.from?.email ?? "")}>{initials(msg.view.summary.from)}</span>
          <div class="who">
            <div>
              <button class="sender" onclick={fromSender} title="Все письма от этого отправителя">
                {msg.view.summary.from?.name ?? msg.view.summary.from?.email ?? "(без отправителя)"}
              </button>
              {#if msg.view.summary.from?.name}<span class="muted">&lt;{msg.view.summary.from.email}&gt;</span>{/if}
              {#if msg.view.summary.unsubscribe}
                <button class="chip" onclick={() => (confirmUnsub = true)} title="Больше не получать эту рассылку"><ListX size={13} /> Отписаться</button>
              {/if}
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

      {#if confirmUnsub}
        <div class="banner info">
          <ListX size={15} />
          <span>Больше не получать письма «{listName}»? Депеша отпишется тем способом, который указал отправитель.</span>
          <button class="btn primary" onclick={unsubscribe}>Отписаться</button>
          <button class="btn ghost" onclick={() => (confirmUnsub = false)}>Отмена</button>
        </div>
      {/if}
      {#if msg.row.snoozed_until}
        <div class="banner info"><AlarmClock size={15} /><span>Отложено: вернётся во входящие {when(msg.row.snoozed_until)}.</span></div>
      {/if}
      {#if msg.row.followup_due}
        <div class="banner info">
          <MessageSquareReply size={15} />
          <span>Вы ждёте ответа. Напомню {when(msg.row.followup_due)}, если его не будет.</span>
          <button class="btn ghost" onclick={stopWaiting}>Не ждать</button>
        </div>
      {/if}
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
              <button class="file-name" onclick={() => openAttachment(a)} title="Открыть"><Paperclip size={13} /> {a.name}</button>
              <span class="muted small">{size(a.size)}</span>
              <button class="btn ghost small-btn" onclick={() => saveAttachment(a)} title="Сохранить" aria-label="Сохранить"><Download size={14} /></button>
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
    </div>
  {:else if app.opening}
    <div class="center muted">Загрузка письма…</div>
  {:else}
    <div class="center muted">
      <div class="hint">
        <p>Выберите письмо</p>
        <p class="small">
          <kbd>j</kbd>/<kbd>k</kbd> — следующее/предыдущее, <kbd>e</kbd> — готово, <kbd>h</kbd> — отложить, <kbd>r</kbd> — ответить,
          <kbd>c</kbd> — написать, <kbd>/</kbd> — поиск, <kbd>z</kbd> — отменить, <kbd>Ctrl</kbd>+<kbd>K</kbd> — все команды
        </p>
      </div>
    </div>
  {/if}
</section>

<style>
  .reader {
    container-type: inline-size;
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
    gap: 4px;
    padding: 8px 12px;
    border-bottom: 1px solid var(--line);
    background: var(--paper);
    flex-wrap: wrap;
  }

  .anchor {
    position: relative;
    display: inline-flex;
  }

  /* A narrow reader keeps one toolbar row: secondary labels go, tooltips stay. */
  @container (max-width: 720px) {
    .toolbar .lbl {
      display: none;
    }
  }

  @container (max-width: 520px) {
    .toolbar .lbl2 {
      display: none;
    }
  }

  .scroll {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
    overflow-y: auto;
  }

  .conversation {
    margin: 12px 22px 0;
    border: 1px solid var(--line);
    border-radius: 8px;
    background: var(--paper);
    overflow: hidden;
  }

  .conv {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    padding: 6px 10px;
    border: none;
    border-bottom: 1px solid var(--line);
    background: none;
    text-align: left;
    font-size: 13px;
  }

  .conv:last-child {
    border-bottom: none;
  }

  .conv:hover {
    background: var(--hover);
  }

  .conv.current {
    background: var(--paper-2);
    font-weight: 600;
  }

  .conv.unread .who {
    font-weight: 650;
  }

  .conv .dot {
    width: 20px;
    display: inline-flex;
    justify-content: center;
  }

  .conv .dot::before {
    content: "";
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--accent);
  }

  .conv .when {
    margin-left: auto;
    font-size: 12px;
  }

  .mini {
    width: 20px;
    height: 20px;
    border-radius: 50%;
    color: #fff;
    font-size: 9px;
    font-weight: 700;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex: none;
  }

  .sender {
    border: none;
    background: none;
    padding: 0;
    font-weight: 700;
    color: inherit;
  }

  .sender:hover {
    text-decoration: underline;
  }

  .chip {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    margin-left: 6px;
    border: 1px solid var(--line);
    background: var(--paper);
    border-radius: 10px;
    padding: 0 8px;
    font-size: 12px;
    color: var(--muted);
    vertical-align: 1px;
  }

  .chip:hover {
    color: var(--ink);
    border-color: var(--muted);
  }

  .banner.info {
    background: color-mix(in srgb, var(--link) 9%, var(--paper));
    border-color: color-mix(in srgb, var(--link) 28%, var(--paper));
  }

  .folder-list {
    max-height: 320px;
    overflow-y: auto;
  }

  .sep {
    flex: 1;
  }

  .icon {
    min-width: 32px;
    justify-content: center;
    font-size: 15px;
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
    color: #fff;
    font-size: 13px;
    letter-spacing: 0.02em;
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
    display: inline-flex;
    align-items: center;
    gap: 4px;
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
    min-height: 420px;
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

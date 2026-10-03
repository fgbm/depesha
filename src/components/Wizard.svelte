<script lang="ts">
  import { ask } from "@tauri-apps/plugin-dialog";
  import { app } from "../lib/store.svelte";
  import { api, asError } from "../lib/api";
  import { longDate } from "../lib/format";
  import type { Account, CmdError, Security, ServerConfig } from "../lib/types";

  const existing = app.wizard?.account ?? null;

  let step = $state<"start" | "settings">(existing ? "settings" : "start");
  let name = $state(existing?.display_name ?? "");
  let email = $state(existing?.email ?? "");
  let password = $state("");
  let username = $state(existing?.username ?? "");
  let imap = $state<ServerConfig>(existing ? { ...existing.imap } : { host: "", port: 993, security: "tls" });
  let smtp = $state<ServerConfig>(existing ? { ...existing.smtp } : { host: "", port: 587, security: "starttls" });
  let saveSent = $state(existing?.save_sent_copy ?? true);
  let signature = $state(existing?.signature ?? "");
  let source = $state("");
  let notes = $state<string[]>([]);
  let busy = $state(false);
  let status = $state("");
  let error = $state<CmdError | null>(null);
  let errorProto = $state<"IMAP" | "SMTP" | null>(null);

  const DEFAULT_PORT: Record<"imap" | "smtp", Record<Security, number>> = {
    imap: { tls: 993, starttls: 143, plain: 143 },
    smtp: { tls: 465, starttls: 587, plain: 25 },
  };

  function setSecurity(which: "imap" | "smtp", s: Security) {
    const server = which === "imap" ? imap : smtp;
    const wasDefault = Object.values(DEFAULT_PORT[which]).includes(server.port);
    server.security = s;
    if (wasDefault) server.port = DEFAULT_PORT[which][s];
    server.trusted_cert = undefined;
  }

  async function next() {
    error = null;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
      error = { kind: "input", message: "Введите адрес почты целиком, например ivanov@company.ru" };
      return;
    }
    if (!password) {
      error = { kind: "input", message: "Введите пароль (для Gmail, Яндекса и Mail.ru — пароль приложения)" };
      return;
    }
    busy = true;
    status = "Ищем настройки сервера…";
    try {
      const d = await api.detect(email.trim());
      username = d.username || email.trim();
      if (d.imap) imap = d.imap;
      else imap = { host: `mail.${email.split("@")[1]}`, port: 993, security: "tls" };
      if (d.smtp) smtp = d.smtp;
      else smtp = { host: imap.host, port: 587, security: "starttls" };
      source = d.source;
      notes = d.notes;
      step = "settings";
    } finally {
      busy = false;
      status = "";
    }
  }

  function account(): Account {
    return {
      id: existing?.id ?? "",
      display_name: name.trim(),
      email: email.trim(),
      username: username.trim(),
      imap: { ...imap, host: imap.host.trim(), port: Number(imap.port) },
      smtp: { ...smtp, host: smtp.host.trim(), port: Number(smtp.port) },
      save_sent_copy: saveSent,
      signature,
    };
  }

  async function checkAndSave() {
    error = null;
    errorProto = null;
    busy = true;
    status = "Проверяем вход по IMAP и SMTP…";
    try {
      const acc = account();
      await api.accountCheck(acc, password || null);
      status = "Сохраняем…";
      await api.accountSave(acc, password || null);
      await app.loadAccounts();
      app.wizard = null;
      app.toast(existing ? "Настройки сохранены" : `Ящик ${acc.email} добавлен, загружаем почту`);
      app.scheduleFolders();
    } catch (e) {
      error = asError(e);
      errorProto = error.message.startsWith("SMTP") ? "SMTP" : error.message.startsWith("IMAP") ? "IMAP" : null;
    } finally {
      busy = false;
      status = "";
    }
  }

  function trustCert() {
    if (!error?.cert) return;
    const target = errorProto === "SMTP" ? smtp : imap;
    target.trusted_cert = error.cert.sha256;
    checkAndSave();
  }

  async function allowPlain() {
    const ok = await ask(
      "Без шифрования пароль и письма идут по сети открытым текстом. Включайте это только для сервера во внутренней сети, которому доверяете, и попросите администратора включить TLS.",
      { title: "Подключение без шифрования", kind: "warning", okLabel: "Всё равно разрешить", cancelLabel: "Отмена" },
    );
    if (!ok) return;
    const target = errorProto === "SMTP" ? smtp : imap;
    target.security = "plain";
    checkAndSave();
  }

  async function removeAccount() {
    if (!existing) return;
    const ok = await ask(`Удалить ящик ${existing.email} из Депеши? Письма на сервере останутся.`, {
      title: "Депеша",
      kind: "warning",
      okLabel: "Удалить",
      cancelLabel: "Отмена",
    });
    if (!ok) return;
    try {
      await api.accountRemove(existing.id);
      await Promise.all([app.loadAccounts(), app.loadFolders()]);
      app.wizard = null;
      app.setView({ kind: "unified", role: "inbox" });
    } catch (e) {
      error = asError(e);
    }
  }

  function fingerprint(sha: string): string {
    return sha.toUpperCase().match(/.{1,2}/g)?.join(":") ?? sha;
  }

  const authHint = $derived(
    error?.kind === "auth" && !username.includes("\\")
      ? "Для Exchange попробуйте логин в виде ДОМЕН\\пользователь. Для Gmail, Яндекса и Mail.ru нужен пароль приложения, а не обычный пароль."
      : "",
  );
</script>

<div class="modal-backdrop" role="presentation">
  <div class="modal wizard" role="dialog" aria-label="Почтовый ящик">
    <header>
      <h3>{existing ? `Настройки: ${existing.email}` : "Добавить почтовый ящик"}</h3>
      {#if app.accounts.length > 0 || existing}
        <button class="btn ghost" onclick={() => (app.wizard = null)} disabled={busy}>×</button>
      {/if}
    </header>

    <div class="content">
      {#if step === "start"}
        <p class="muted lead">Депеша работает с любым сервером по IMAP и SMTP: Exchange, Яндекс, Mail.ru, Gmail и другими.</p>
        <label class="field"><span>Ваше имя (видят получатели)</span><input class="input" bind:value={name} placeholder="Иван Петров" /></label>
        <label class="field"><span>Адрес почты</span>
          <!-- svelte-ignore a11y_autofocus -->
          <input class="input" bind:value={email} type="email" autofocus placeholder="ivanov@company.ru" onkeydown={(e) => e.key === "Enter" && next()} />
        </label>
        <label class="field"><span>Пароль</span><input class="input" bind:value={password} type="password" onkeydown={(e) => e.key === "Enter" && next()} /></label>
      {:else}
        {#if source}<p class="muted lead">Настройки найдены: {source}. Проверьте и при необходимости исправьте.</p>{/if}
        {#each notes as n (n)}<p class="note">⚠ {n}</p>{/each}

        <div class="grid">
          <label class="field"><span>Имя</span><input class="input" bind:value={name} /></label>
          <label class="field"><span>Адрес</span><input class="input" bind:value={email} disabled={!!existing} /></label>
          <label class="field"><span>Логин</span><input class="input" bind:value={username} placeholder="адрес или ДОМЕН\пользователь" /></label>
          <label class="field"><span>{existing ? "Пароль (пусто — не менять)" : "Пароль"}</span><input class="input" type="password" bind:value={password} /></label>
        </div>

        {#each [["imap", "Входящая почта (IMAP)", imap], ["smtp", "Исходящая почта (SMTP)", smtp]] as [key, title, server] (key)}
          {@const s = server as ServerConfig}
          <fieldset>
            <legend>{title}</legend>
            <div class="server">
              <label class="field host"><span>Сервер</span><input class="input" bind:value={s.host} /></label>
              <label class="field port"><span>Порт</span><input class="input" type="number" bind:value={s.port} /></label>
              <label class="field sec"><span>Шифрование</span>
                <select class="input" value={s.security} onchange={(e) => setSecurity(key as "imap" | "smtp", e.currentTarget.value as Security)}>
                  <option value="tls">SSL/TLS</option>
                  <option value="starttls">STARTTLS</option>
                  <option value="plain">Без шифрования</option>
                </select>
              </label>
            </div>
            {#if s.security === "plain"}<p class="note">⚠ Пароль и письма пойдут открытым текстом.</p>{/if}
            {#if s.trusted_cert}<p class="muted small">Доверенный сертификат: {fingerprint(s.trusted_cert).slice(0, 23)}…
              <button class="link" onclick={() => (s.trusted_cert = undefined)}>забыть</button></p>{/if}
          </fieldset>
        {/each}

        <label class="field"><span>Подпись (добавляется к новым письмам и ответам)</span>
          <textarea class="input sig" bind:value={signature} rows="3" placeholder="С уважением,&#10;Иван Петров"></textarea>
        </label>

        <label class="check"><input type="checkbox" bind:checked={saveSent} /> Сохранять копию отправленных писем в «Отправленные» (нужно для Exchange; Gmail делает это сам)</label>
      {/if}

      {#if error}
        <div class="error selectable">
          <p><b>{error.message}</b></p>
          {#if authHint}<p>{authHint}</p>{/if}
          {#if error.kind === "certificate" && error.cert}
            <dl>
              <dt>Сервер</dt><dd>{error.cert.host}</dd>
              <dt>Кому выдан</dt><dd>{error.cert.subject || "—"}</dd>
              <dt>Кем выдан</dt><dd>{error.cert.issuer || "—"}</dd>
              <dt>Действует до</dt><dd>{error.cert.not_after ? longDate(error.cert.not_after) : "—"}</dd>
              <dt>SHA-256</dt><dd class="mono">{fingerprint(error.cert.sha256)}</dd>
            </dl>
            <p class="muted small">Доверяйте, только если сверили отпечаток с администратором сервера. Если сертификат сменится, Депеша спросит снова.</p>
            <button class="btn" onclick={trustCert} disabled={busy}>Доверять этому сертификату</button>
          {:else if error.kind === "no-tls"}
            <p class="muted small">Попросите администратора включить TLS на сервере. Для Exchange: сертификат на receive-коннекторе «Client Frontend» и служба IMAP4.</p>
            <button class="btn ghost" onclick={allowPlain} disabled={busy}>Разрешить без шифрования…</button>
          {:else if error.kind === "imap-unavailable"}
            <p class="muted small">Это настраивает администратор Exchange: Set-CASMailbox -ImapEnabled $true и запуск служб MSExchangeIMAP4 и MSExchangeIMAP4BE.</p>
          {/if}
        </div>
      {/if}
      {#if status}<p class="muted">{status}</p>{/if}
    </div>

    <footer>
      {#if existing}<button class="btn ghost danger-text" onclick={removeAccount} disabled={busy}>Удалить ящик</button>{/if}
      <span class="spacer"></span>
      {#if step === "start"}
        <button class="btn primary" onclick={next} disabled={busy}>Далее</button>
      {:else}
        {#if !existing}<button class="btn ghost" onclick={() => (step = "start")} disabled={busy}>Назад</button>{/if}
        <button class="btn primary" onclick={checkAndSave} disabled={busy}>{busy ? "Проверяем…" : "Проверить и сохранить"}</button>
      {/if}
    </footer>
  </div>
</div>

<style>
  .wizard {
    width: min(640px, calc(100vw - 40px));
  }

  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 14px 14px 4px 22px;
  }

  h3 {
    margin: 0;
    font-size: 17px;
  }

  .content {
    padding: 8px 22px 12px;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 12px;
  }

  .lead {
    margin: 0;
    line-height: 1.45;
  }

  .note {
    margin: 0;
    padding: 8px 10px;
    background: color-mix(in srgb, var(--warn) 12%, var(--paper));
    border-radius: 6px;
    font-size: 13px;
    line-height: 1.4;
  }

  .grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 10px;
  }

  fieldset {
    border: 1px solid var(--line);
    border-radius: 8px;
    padding: 8px 12px 10px;
    margin: 0;
  }

  legend {
    font-size: 12px;
    font-weight: 600;
    color: var(--muted);
    padding: 0 4px;
  }

  .server {
    display: flex;
    gap: 8px;
  }

  .host {
    flex: 1;
  }

  .port {
    width: 84px;
  }

  .sec {
    width: 200px;
  }

  .sig {
    resize: vertical;
    font: inherit;
  }

  .check {
    display: flex;
    gap: 8px;
    align-items: flex-start;
    font-size: 13px;
    line-height: 1.4;
  }

  .error {
    border-left: 4px solid var(--accent);
    background: color-mix(in srgb, var(--accent) 7%, var(--paper));
    padding: 10px 14px;
    border-radius: 6px;
    line-height: 1.45;
  }

  .error p {
    margin: 0 0 6px;
  }

  dl {
    display: grid;
    grid-template-columns: 110px 1fr;
    gap: 3px 10px;
    margin: 6px 0 8px;
    font-size: 13px;
  }

  dt {
    color: var(--muted);
  }

  dd {
    margin: 0;
    overflow-wrap: anywhere;
  }

  .mono {
    font-family: var(--mono);
    font-size: 12px;
  }

  .small {
    font-size: 12px;
  }

  .link {
    border: none;
    background: none;
    color: var(--link);
    padding: 0;
    text-decoration: underline;
  }

  footer {
    display: flex;
    gap: 8px;
    padding: 12px 22px 16px;
    border-top: 1px solid var(--line);
  }

  .spacer {
    flex: 1;
  }
</style>

<script lang="ts">
  import { app } from "../lib/store.svelte";
  import { registry } from "../plugin-host/registry.svelte";
  import { t, tn } from "../lib/i18n.svelte";
  import { applyTheme, THEMES } from "../lib/theme";
  import Select from "./Select.svelte";
  import type { OAuthClient, OAuthProvider, Settings } from "../lib/types";

  let draft = $state<Settings>(structuredClone($state.snapshot(app.settings)));

  const OAUTH: { provider: OAuthProvider; title: () => string; secret: boolean }[] = [
    { provider: "google", title: () => "Google", secret: true },
    { provider: "yandex", title: () => t("wizard.yandex"), secret: true },
    { provider: "microsoft", title: () => "Microsoft", secret: false },
  ];
  let clients = $state<Record<OAuthProvider, OAuthClient>>({
    google: { client_id: "", client_secret: "", ...draft.oauth_clients?.google },
    yandex: { client_id: "", client_secret: "", ...draft.oauth_clients?.yandex },
    microsoft: { client_id: "", ...draft.oauth_clients?.microsoft },
  });

  /** Filled clients only; an empty Client ID removes the user's own client. */
  function oauthClients(): Settings["oauth_clients"] {
    const out: Settings["oauth_clients"] = {};
    for (const { provider } of OAUTH) {
      const c = clients[provider];
      const id = c.client_id.trim();
      if (!id) continue;
      const secret = c.client_secret?.trim();
      out[provider] = secret ? { client_id: id, client_secret: secret } : { client_id: id };
    }
    return out;
  }

  // A theme is easier to pick by seeing it: it applies at once and goes back on Cancel.
  $effect(() => applyTheme(draft.theme));

  /** Only the core's fields: plugins save their own sections as they go. */
  async function save() {
    const { language, notify, undo_send_secs, threads, updates, theme, offline, offline_attachments, sender_logos } =
      $state.snapshot(draft);
    await app.saveSettings({
      ...$state.snapshot(app.settings),
      language,
      notify,
      undo_send_secs,
      threads,
      updates,
      theme,
      offline,
      offline_attachments,
      sender_logos,
      oauth_clients: oauthClients(),
    });
    app.settingsOpen = false;
  }

  function cancel() {
    applyTheme(app.settings.theme);
    app.settingsOpen = false;
  }

  function onKey(e: KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      cancel();
    }
  }
</script>

<div class="modal-backdrop" role="presentation">
  <div class="modal prefs" role="dialog" aria-label={t("settings.title")} tabindex="-1" onkeydown={onKey}>
    <header><h3>{t("settings.title")}</h3></header>
    <div class="content">
      <section>
        <h4>{t("settings.language")}</h4>
        <label class="radio"><input type="radio" bind:group={draft.language} value="auto" /> {t("settings.languageAuto")}</label>
        <label class="radio"><input type="radio" bind:group={draft.language} value="en" /> English</label>
        <label class="radio"><input type="radio" bind:group={draft.language} value="ru" /> Русский</label>
      </section>

      <section>
        <h4>{t("settings.appearance")}</h4>
        <div class="themes" role="radiogroup" aria-label={t("settings.appearance")}>
          {#each THEMES as theme (theme)}
            <label class="theme" class:on={draft.theme === theme}>
              <input type="radio" bind:group={draft.theme} value={theme} />
              <span class="swatch {theme}" aria-hidden="true"><i></i><b></b></span>
              {t(`settings.theme.${theme}`)}
            </label>
          {/each}
        </div>
        {#if draft.theme === "system"}<p class="muted small">{t("settings.theme.systemNote")}</p>{/if}
      </section>

      <section>
        <h4>{t("settings.notifications")}</h4>
        <label class="radio"><input type="radio" bind:group={draft.notify} value="people" /> {t("settings.notifyPeople")} <span class="muted">{t("settings.notifyPeopleNote")}</span></label>
        <label class="radio"><input type="radio" bind:group={draft.notify} value="all" /> {t("settings.notifyAll")}</label>
        <label class="radio"><input type="radio" bind:group={draft.notify} value="none" /> {t("settings.notifyNone")}</label>
        <p class="muted small">{t("settings.dndNote")}</p>
      </section>

      <section>
        <h4>{t("settings.sending")}</h4>
        <div class="row">
          {t("settings.undoSend")}
          <Select
            label={t("settings.undoSend")}
            bind:value={draft.undo_send_secs}
            options={[{ value: 0, label: t("settings.noWait") }, ...[5, 10, 20, 30].map((secs) => ({ value: secs, label: tn("settings.seconds", secs) }))]}
          />
        </div>
      </section>


      <section>
        <h4>{t("settings.updates")}</h4>
        <label class="radio"><input type="radio" bind:group={draft.updates} value="auto" /> {t("settings.updatesAuto")} <span class="muted">{t("settings.updatesAutoNote")}</span></label>
        <label class="radio"><input type="radio" bind:group={draft.updates} value="notify" /> {t("settings.updatesNotify")}</label>
        <label class="radio"><input type="radio" bind:group={draft.updates} value="off" /> {t("settings.updatesOff")}</label>
        <div class="row update-row">
          <div class="muted small status">
            <div>{t("settings.installed", { version: app.update?.current ?? "—" })}</div>
            {#if app.update?.state === "checking"}<div>{t("settings.checking")}</div>
            {:else if app.update?.state === "error"}<div class="danger-text">{app.update.error}</div>
            {:else if app.update?.version}<div>{t("update.available", { version: app.update.version })}.</div>
            {/if}
            {#if app.update?.install === "package"}<div>{t("settings.packageNote")}</div>{/if}
            {#if app.update?.install === "unsupported"}<div>{t("settings.unsupportedNote")}</div>{/if}
          </div>
          <button class="btn" onclick={() => app.checkUpdates()} disabled={app.update?.state === "checking"}>{t("settings.checkNow")}</button>
        </div>
        <p class="muted small">{t("settings.signedNote")}</p>
      </section>

      <section>
        <h4>{t("settings.list")}</h4>
        <label class="radio"><input type="checkbox" bind:checked={draft.threads} /> {t("settings.threads")}</label>
        <label class="radio"><input type="checkbox" bind:checked={draft.sender_logos} /> {t("settings.senderLogos")}</label>
        <p class="muted small">{t("settings.senderLogosNote")}</p>
      </section>

      <section>
        <h4>{t("settings.offline")}</h4>
        <div class="row">
          {t("settings.offlineKeep")}
          <Select
            label={t("settings.offlineKeep")}
            bind:value={draft.offline}
            options={[
              { value: "off", label: t("settings.offlineOff") },
              { value: "30", label: tn("settings.offlineDays", 30) },
              { value: "90", label: tn("settings.offlineDays", 90) },
              { value: "365", label: t("settings.offlineYear") },
              { value: "all", label: t("settings.offlineAll") },
            ]}
          />
        </div>
        <label class="radio" class:disabled={draft.offline === "off"}>
          <input type="checkbox" bind:checked={draft.offline_attachments} disabled={draft.offline === "off"} /> {t("settings.offlineAttachments")}
        </label>
        <p class="muted small">{t("settings.offlineNote")}</p>
      </section>

      <section>
        <h4>{t("settings.oauthClients")}</h4>
        <p class="muted small">{t("settings.oauthClientsNote")}</p>
        {#each OAUTH as o (o.provider)}
          <div class="client">
            <span class="client-name">{o.title()}</span>
            <input class="input" bind:value={clients[o.provider].client_id} placeholder={t("settings.clientId")} aria-label="{o.title()}: {t('settings.clientId')}" />
            {#if o.secret}
              <input class="input" type="password" bind:value={clients[o.provider].client_secret} placeholder={t("settings.clientSecret")} aria-label="{o.title()}: {t('settings.clientSecret')}" />
            {:else}<span></span>{/if}
          </div>
        {/each}
      </section>

      {#each registry.lists.settingsSections as sec (sec)}
        <section>
          <h4>{sec.item.title()}</h4>
          <sec.item.component {...sec.item.props} />
        </section>
      {/each}
    </div>
    <footer>
      <span class="spacer"></span>
      <button class="btn ghost" onclick={cancel}>{t("cancel")}</button>
      <button class="btn primary" onclick={save}>{t("file.save")}</button>
    </footer>
  </div>
</div>

<style>
  .prefs {
    width: min(640px, calc(100vw - 40px));
    max-height: calc(100vh - 60px);
  }

  header {
    padding: 14px 20px 4px;
  }

  h3 {
    margin: 0;
  }

  .content {
    overflow-y: auto;
    padding: 0 20px 10px;
  }

  .client {
    display: grid;
    grid-template-columns: 90px 1fr 1fr;
    gap: 8px;
    align-items: center;
    margin-top: 6px;
  }

  .client-name {
    font-size: 13px;
  }

  section {
    padding: 12px 0;
    border-bottom: 1px solid var(--line);
  }

  section:last-child {
    border-bottom: none;
  }

  h4 {
    margin: 0 0 8px;
    font-size: 14px;
  }

  .radio {
    display: block;
    padding: 3px 0;
  }

  .row {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .small {
    font-size: 12px;
  }

  .update-row {
    justify-content: space-between;
    align-items: flex-start;
    margin-top: 6px;
  }

  .status {
    display: flex;
    flex-direction: column;
    gap: 2px;
    line-height: 1.4;
  }





  .themes {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }

  .theme {
    position: relative;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 6px;
    padding: 6px;
    border: 1px solid transparent;
    border-radius: 8px;
    font-size: 12px;
    cursor: pointer;
  }

  .theme:hover {
    background: var(--hover);
  }

  .theme.on {
    border-color: var(--accent);
  }

  /* The radio stays for the keyboard and screen readers; the swatch is what one sees. */
  .theme input {
    position: absolute;
    opacity: 0;
    pointer-events: none;
  }

  .theme:has(input:focus-visible) {
    outline: 2px solid var(--accent);
  }

  /* Swatch colours repeat --side and --paper of each theme in app.css. */
  .swatch {
    display: flex;
    width: 64px;
    height: 40px;
    border-radius: 6px;
    overflow: hidden;
    box-shadow: inset 0 0 0 1px rgb(0 0 0 / 12%);
  }

  .swatch i {
    width: 35%;
    background: var(--s);
  }

  .swatch b {
    flex: 1;
    background: var(--p);
  }

  .swatch.paper {
    --s: #1f2a37;
    --p: #faf7f1;
  }

  .swatch.night {
    --s: #11161c;
    --p: #171a1f;
  }

  .swatch.snow {
    --s: #f3f4f6;
    --p: #ffffff;
  }

  .swatch.graphite {
    --s: #26272b;
    --p: #1c1c1e;
  }

  .swatch.system {
    --s: #1f2a37;
    --p: linear-gradient(135deg, #faf7f1 50%, #171a1f 50%);
  }

  footer {
    display: flex;
    gap: 8px;
    padding: 10px 20px 14px;
    border-top: 1px solid var(--line);
  }

  .spacer {
    flex: 1;
  }
</style>

<script lang="ts">
  import Settings2 from "@lucide/svelte/icons/settings-2";
  import Mail from "@lucide/svelte/icons/mail";
  import Bell from "@lucide/svelte/icons/bell";
  import CloudOff from "@lucide/svelte/icons/cloud-off";
  import Download from "@lucide/svelte/icons/download";
  import Puzzle from "@lucide/svelte/icons/puzzle";
  import Inbox from "@lucide/svelte/icons/inbox";
  import type { Component } from "svelte";
  import { app } from "../lib/store.svelte";
  import { registry } from "../plugin-host/registry.svelte";
  import { t, tn } from "../lib/i18n.svelte";
  import { applyTheme, THEMES } from "../lib/theme";
  import Select from "./Select.svelte";
  import Accounts from "./Accounts.svelte";
  import Plugins from "./Plugins.svelte";
  import Wizard from "./Wizard.svelte";
  import FolderPicker from "./FolderPicker.svelte";
  import { accountLabel } from "../lib/format";
  import type { Settings } from "../lib/types";

  let draft = $state<Settings>(structuredClone($state.snapshot(app.settings)));

  /**
   * Every setting in one window: the app's pages, the mailboxes (one page each),
   * the plugins and a page per plugin section.
   */
  const CORE: { id: string; title: () => string; icon: Component }[] = [
    { id: "general", title: () => t("settings.page.general"), icon: Settings2 },
    { id: "mail", title: () => t("settings.page.mail"), icon: Mail },
    { id: "notifications", title: () => t("settings.notifications"), icon: Bell },
    { id: "offline", title: () => t("settings.offline"), icon: CloudOff },
    { id: "updates", title: () => t("settings.updates"), icon: Download },
  ];
  const sections = $derived(registry.lists.settingsSections);
  const pages = $derived([
    ...CORE.map((p) => p.id),
    "accounts",
    ...app.accounts.map((a) => `account:${a.id}`),
    "plugins",
    ...sections.map((_, i) => `plugin:${i}`),
  ]);

  let page = $state(app.settingsPage);
  // A page that went away (its plugin or mailbox) falls back to the first one.
  const current = $derived(pages.includes(page) || page === "account:new" ? page : "general");
  const pageAccount = $derived(
    current.startsWith("account:") ? (app.accounts.find((a) => `account:${a.id}` === current) ?? null) : null,
  );
  const title = $derived(
    CORE.find((p) => p.id === current)?.title() ??
      (current === "accounts"
        ? t("accounts.title")
        : current === "plugins"
          ? t("ext.title")
          : current === "account:new"
            ? t("cmd.addAccount")
            : pageAccount
              ? `${accountLabel(pageAccount)}`
              : (sections[Number(current.slice(7))]?.item.title() ?? "")),
  );
  /** A mailbox's page has its own buttons: it is checked and saved apart from the rest. */
  const ownButtons = $derived(current.startsWith("account:"));

  /** A radio choice of the snippet below: the field and the value are its own. */
  function choose(group: "language" | "notify" | "updates", value: string) {
    // The snippet offers only the values each field takes.
    (draft as unknown as Record<string, string>)[group] = value;
  }

  // A theme is easier to pick by seeing it: it applies at once and goes back on Cancel.
  $effect(() => applyTheme(draft.theme));

  /** Only the core's fields: plugins save their own sections as they go. */
  async function save() {
    const { language, notify, undo_send_secs, threads, updates, theme, offline, offline_attachments, sender_logos, attachments_dir } =
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
      attachments_dir: (attachments_dir ?? "").trim(),
    });
    close();
  }

  function cancel() {
    applyTheme(app.settings.theme);
    close();
  }

  function close() {
    app.settingsOpen = false;
    app.settingsPage = "general";
  }

  function onKey(e: KeyboardEvent) {
    // A menu or a question on top closes first.
    if (e.key === "Escape" && !app.confirmation && !document.querySelector(".pop")) {
      e.preventDefault();
      cancel();
    }
  }

  /** ↑/↓ move between pages, as in any list of tabs. */
  function onNavKey(e: KeyboardEvent) {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const i = pages.indexOf(current) + (e.key === "ArrowDown" ? 1 : -1);
    page = pages[(i + pages.length) % pages.length];
    (e.currentTarget as HTMLElement).querySelector<HTMLElement>(`[data-page="${page}"]`)?.focus();
  }
</script>

{#snippet option(group: "language" | "notify" | "updates", value: string, label: string, note?: string)}
  <label class="option">
    <input type="radio" name={group} {value} checked={draft[group] === value} onchange={() => choose(group, value)} />
    <span class="text">{label}{#if note}<span class="note">{note}</span>{/if}</span>
  </label>
{/snippet}

<div class="modal-backdrop" role="presentation">
  <div class="modal prefs" role="dialog" aria-label={t("settings.title")} tabindex="-1" onkeydown={onKey}>
    <nav class="pages" aria-label={t("settings.title")}>
      <h3>{t("settings.title")}</h3>
      <div role="tablist" aria-orientation="vertical" tabindex="-1" onkeydown={onNavKey}>
        {#snippet tab(id: string, label: string, Icon: Component | null, sub = false)}
          <button class="tab" class:sub role="tab" data-page={id} aria-selected={current === id} tabindex={current === id ? 0 : -1} onclick={() => (page = id)}>
            {#if Icon}<Icon size={16} />{/if}<span>{label}</span>
          </button>
        {/snippet}
        {#each CORE as p (p.id)}{@render tab(p.id, p.title(), p.icon)}{/each}
        <div class="group">{t("accounts.title")}</div>
        {@render tab("accounts", t("accounts.manageTitle"), Inbox)}
        {#each app.accounts as acc (acc.id)}{@render tab(`account:${acc.id}`, accountLabel(acc), null, true)}{/each}
        <div class="group">{t("settings.page.plugins")}</div>
        {@render tab("plugins", t("ext.manageTitle"), Puzzle)}
        {#each sections as sec, i (sec)}{@render tab(`plugin:${i}`, sec.item.title(), null, true)}{/each}
      </div>
    </nav>

    <div class="pane">
      <header><h2>{title}</h2></header>
      <div class="content" class:flush={ownButtons} role="tabpanel" aria-label={title}>
        {#if current === "general"}
          <section>
            <h4>{t("settings.language")}</h4>
            {@render option("language", "auto", t("settings.languageAuto"))}
            {@render option("language", "en", "English")}
            {@render option("language", "ru", "Русский")}
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
            {#if draft.theme === "system"}<p class="hint">{t("settings.theme.systemNote")}</p>{/if}
          </section>
        {:else if current === "mail"}
          <section>
            <h4>{t("settings.list")}</h4>
            <label class="option">
              <input type="checkbox" bind:checked={draft.threads} />
              <span class="text">{t("settings.threads")}</span>
            </label>
            <label class="option">
              <input type="checkbox" bind:checked={draft.sender_logos} />
              <span class="text">{t("settings.senderLogos")}<span class="note">{t("settings.senderLogosNote")}</span></span>
            </label>
          </section>
          <section>
            <h4>{t("settings.attachmentsDir")}</h4>
            <FolderPicker bind:value={() => draft.attachments_dir ?? "", (v) => (draft.attachments_dir = v)} label={t("settings.attachmentsDir")} placeholder={t("settings.askEveryTime")} />
            <p class="hint">{t("settings.attachmentsDirNote")}</p>
          </section>
          <section>
            <h4>{t("settings.sending")}</h4>
            <div class="inline">
              <span>{t("settings.undoSend")}</span>
              <Select
                label={t("settings.undoSend")}
                bind:value={draft.undo_send_secs}
                options={[{ value: 0, label: t("settings.noWait") }, ...[5, 10, 20, 30].map((secs) => ({ value: secs, label: tn("settings.seconds", secs) }))]}
              />
            </div>
          </section>
        {:else if current === "notifications"}
          <section>
            {@render option("notify", "people", t("settings.notifyPeople"), t("settings.notifyPeopleNote"))}
            {@render option("notify", "all", t("settings.notifyAll"))}
            {@render option("notify", "none", t("settings.notifyNone"))}
            <p class="hint">{t("settings.dndNote")}</p>
          </section>
        {:else if current === "offline"}
          <section>
            <div class="inline">
              <span>{t("settings.offlineKeep")}</span>
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
            <label class="option" class:disabled={draft.offline === "off"}>
              <input type="checkbox" bind:checked={draft.offline_attachments} disabled={draft.offline === "off"} />
              <span class="text">{t("settings.offlineAttachments")}</span>
            </label>
            <p class="hint">{t("settings.offlineNote")}</p>
          </section>
        {:else if current === "updates"}
          <section>
            {@render option("updates", "auto", t("settings.updatesAuto"), t("settings.updatesAutoNote"))}
            {@render option("updates", "notify", t("settings.updatesNotify"))}
            {@render option("updates", "off", t("settings.updatesOff"))}
          </section>
          <section>
            <div class="inline update-row">
              <div class="status">
                <div>{t("settings.installed", { version: app.update?.current ?? "—" })}</div>
                {#if app.update?.state === "checking"}<div class="hint">{t("settings.checking")}</div>
                {:else if app.update?.state === "error"}<div class="danger-text small">{app.update.error}</div>
                {:else if app.update?.version}<div class="hint">{t("update.available", { version: app.update.version })}.</div>
                {/if}
                {#if app.update?.install === "package"}<div class="hint">{t("settings.packageNote")}</div>{/if}
                {#if app.update?.install === "unsupported"}<div class="hint">{t("settings.unsupportedNote")}</div>{/if}
              </div>
              <button class="btn" onclick={() => app.checkUpdates()} disabled={app.update?.state === "checking"}>{t("settings.checkNow")}</button>
            </div>
            <p class="hint">{t("settings.signedNote")}</p>
          </section>
        {:else if current === "accounts"}
          <Accounts onOpen={(p) => (page = p)} />
        {:else if current === "plugins"}
          <Plugins />
        {:else if current === "account:new" || pageAccount}
          {#key current}
            <Wizard embedded mailbox={pageAccount} onDone={() => (page = "accounts")} />
          {/key}
        {:else}
          {@const sec = sections[Number(current.slice(7))]}
          {#if sec}
            <section>
              <sec.item.component {...sec.item.props} />
            </section>
          {/if}
        {/if}
      </div>
      {#if !ownButtons}
        <footer>
          <span class="spacer"></span>
          <button class="btn ghost" onclick={cancel}>{t("cancel")}</button>
          <button class="btn primary" onclick={save}>{t("file.save")}</button>
        </footer>
      {/if}
    </div>
  </div>
</div>

<style>
  /* One size for every page: switching pages never makes the window jump. */
  .prefs {
    width: min(820px, calc(100vw - 40px));
    height: min(600px, calc(100vh - 60px));
    display: flex;
    flex-direction: row;
    padding: 0;
    overflow: hidden;
  }

  .pages {
    flex: none;
    width: 200px;
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: 16px 10px;
    background: var(--paper-2);
    border-right: 1px solid var(--line);
    overflow-y: auto;
  }

  .pages h3 {
    margin: 0 8px 12px;
    font-size: 15px;
  }

  [role="tablist"] {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .tab {
    display: flex;
    align-items: center;
    gap: 10px;
    width: 100%;
    padding: 7px 10px;
    border: none;
    border-radius: 6px;
    background: none;
    color: var(--ink);
    font: inherit;
    font-size: 13px;
    text-align: left;
  }

  .tab span {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .tab :global(svg) {
    flex: none;
    color: var(--muted);
  }

  .tab:hover {
    background: var(--hover);
  }

  /* A mailbox or a plugin section: under its group's page, without an icon. */
  .tab.sub {
    padding-left: 36px;
  }

  /* The open page: a quiet fill and the accent bar the sidebar uses. */
  .tab[aria-selected="true"] {
    background: var(--selected);
    font-weight: 600;
    box-shadow: inset 3px 0 0 var(--accent);
  }

  .tab[aria-selected="true"] :global(svg) {
    color: var(--ink);
  }

  .tab:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: -2px;
  }

  .group {
    margin: 14px 10px 4px;
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: var(--muted);
  }

  .pane {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
  }

  header {
    padding: 18px 24px 6px;
  }

  h2 {
    margin: 0;
    font-size: 18px;
  }

  .content {
    flex: 1;
    overflow-y: auto;
    padding: 0 24px 12px;
  }

  /* A mailbox's page scrolls inside and keeps its own buttons in sight. */
  .content.flush {
    padding: 0;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }

  section {
    padding: 14px 0;
    border-bottom: 1px solid var(--line);
  }

  section:last-child {
    border-bottom: none;
  }

  h4 {
    margin: 0 0 10px;
    font-size: 13px;
    font-weight: 600;
    color: var(--muted);
  }

  /* A choice: the control, then its name with an explanation under it. */
  .option {
    display: flex;
    align-items: flex-start;
    gap: 10px;
    padding: 5px 0;
    cursor: pointer;
  }

  .option input {
    margin-top: 2px;
  }

  .option.disabled {
    cursor: default;
    color: var(--muted);
  }

  .text {
    display: flex;
    flex-direction: column;
    gap: 2px;
    line-height: 1.4;
  }

  .note,
  .hint {
    font-size: 12px;
    color: var(--muted);
    line-height: 1.45;
  }

  .hint {
    margin: 8px 0 0;
  }

  .inline {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 4px 0;
  }

  .small {
    font-size: 12px;
  }

  .update-row {
    justify-content: space-between;
    align-items: flex-start;
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
    padding: 10px 24px 14px;
    border-top: 1px solid var(--line);
  }

  .spacer {
    flex: 1;
  }

  /* A narrow window: the pages become a row of tabs above the page. */
  @media (max-width: 640px) {
    .prefs {
      flex-direction: column;
    }

    .pages {
      width: auto;
      flex-direction: column;
      border-right: none;
      border-bottom: 1px solid var(--line);
      padding: 10px;
    }

    [role="tablist"] {
      flex-direction: row;
      overflow-x: auto;
    }

    .tab {
      width: auto;
      flex: none;
    }

    .group {
      display: none;
    }
  }
</style>

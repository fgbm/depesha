<script lang="ts">
  import Settings2 from "@lucide/svelte/icons/settings-2";
  import Mail from "@lucide/svelte/icons/mail";
  import Bell from "@lucide/svelte/icons/bell";
  import CloudOff from "@lucide/svelte/icons/cloud-off";
  import Download from "@lucide/svelte/icons/download";
  import Puzzle from "@lucide/svelte/icons/puzzle";
  import Inbox from "@lucide/svelte/icons/inbox";
  import { untrack, type Component } from "svelte";
  import { app } from "../lib/store.svelte";
  import { registry } from "../plugin-host/registry.svelte";
  import { t } from "../lib/i18n.svelte";
  import { applyTheme } from "../lib/theme";
  import { accountLabel } from "../lib/format";
  import { threshold } from "../lib/largeMail";
  import { levels } from "../lib/quota";
  import type { Settings } from "../lib/types";
  import GeneralPanel from "./prefs/GeneralPanel.svelte";
  import MailPanel from "./prefs/MailPanel.svelte";
  import OfflinePanel from "./prefs/OfflinePanel.svelte";
  import AccountsPanel from "./prefs/AccountsPanel.svelte";
  import PluginsPanel from "./prefs/PluginsPanel.svelte";

  /** What the window edits: a copy of the settings, and the large-letter threshold as a number and its unit. */
  function start(s: Settings) {
    const mb = threshold(s.large_mb);
    const inGb = mb >= 1024 && mb % 1024 === 0;
    return { draft: structuredClone(s), unit: (inGb ? "gb" : "mb") as "mb" | "gb", value: inGb ? mb / 1024 : mb };
  }

  const first = start($state.snapshot(app.settings));
  let draft = $state<Settings>(first.draft);
  /** The large-letter threshold as typed: a number and its unit; saved in megabytes. */
  let largeUnit = $state(first.unit);
  let largeValue = $state(first.value);
  /** The settings the window started from, to tell whether anything was changed in it. */
  let base = JSON.stringify(first);

  // Opened before the settings were read (Ctrl+, at startup), the window would save the
  // defaults over them: it takes them when they come, unless something was changed already.
  $effect(() => {
    const next = start($state.snapshot(app.settings));
    untrack(() => {
      if (JSON.stringify({ draft: $state.snapshot(draft), unit: largeUnit, value: largeValue }) !== base) return;
      base = JSON.stringify(next);
      draft = next.draft;
      largeUnit = next.unit;
      largeValue = next.value;
    });
  });

  /**
   * Every setting in one window: the app's pages, the mailboxes (one page each),
   * the plugins and a page per plugin section. The shell keeps the tabs, the page
   * title and the footer; the pages themselves are the panels under `prefs/`.
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
  // A link inside the settings (a mailbox's «Storage» to «Notifications») turns the page.
  $effect(() => {
    void app.settingsTurn;
    untrack(() => turn(app.settingsPage));
  });
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

  // A theme is easier to pick by seeing it: it applies at once and goes back on Cancel.
  $effect(() => applyTheme(draft.theme));

  /** Only the core's fields: plugins save their own sections as they go. */
  async function save() {
    const {
      language,
      notify,
      undo_send_secs,
      threads,
      updates,
      theme,
      offline,
      offline_attachments,
      sender_logos,
      attachments_dir,
      compose_format,
      letter_view,
      quota_warn,
      quota_levels,
      quota_repeat,
    } = $state.snapshot(draft);
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
      large_mb: threshold(largeValue * (largeUnit === "gb" ? 1024 : 1), app.settings.large_mb),
      compose_format,
      letter_view,
      quota_warn,
      quota_levels: levels(quota_levels).sort((a, b) => a - b) as [number, number],
      quota_repeat,
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

  /** The open page's say before it goes: a mailbox's page keeps its unsaved changes and its check. */
  function mayLeave(): Promise<boolean> {
    return app.settingsLeave?.() ?? Promise.resolve(true);
  }

  async function turn(next: string) {
    if (next === current || !(await mayLeave())) return;
    page = next;
  }

  function onKey(e: KeyboardEvent) {
    // A menu or a question on top closes first.
    if (e.key === "Escape" && !app.confirmation && !document.querySelector(".pop")) {
      e.preventDefault();
      mayLeave().then((ok) => ok && cancel());
    }
  }

  /** ↑/↓ move between pages, as in any list of tabs. */
  function onNavKey(e: KeyboardEvent) {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const i = pages.indexOf(current) + (e.key === "ArrowDown" ? 1 : -1);
    const list = e.currentTarget as HTMLElement;
    turn(pages[(i + pages.length) % pages.length]).then(() => list.querySelector<HTMLElement>(`[data-page="${current}"]`)?.focus());
  }
</script>

<div class="modal-backdrop" role="presentation">
  <div class="modal prefs" role="dialog" aria-label={t("settings.title")} tabindex="-1" onkeydown={onKey}>
    <nav class="pages" aria-label={t("settings.title")}>
      <h3>{t("settings.title")}</h3>
      <div role="tablist" aria-orientation="vertical" tabindex="-1" onkeydown={onNavKey}>
        {#snippet tab(id: string, label: string, Icon: Component | null, sub = false)}
          <button class="tab" class:sub role="tab" data-page={id} aria-selected={current === id} tabindex={current === id ? 0 : -1} onclick={() => turn(id)}>
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
      <header>
        <h2>{title}</h2>
        {#if pageAccount}<span class="muted sub">{pageAccount.email}{pageAccount.ews ? " · Exchange" : ""}</span>{/if}
      </header>
      <div class="content" class:flush={ownButtons} role="tabpanel" aria-label={title}>
        {#if current === "general" || current === "updates"}
          <GeneralPanel {current} {draft} bind:largeValue bind:largeUnit />
        {:else if current === "mail" || current === "notifications"}
          <MailPanel {current} {draft} />
        {:else if current === "offline"}
          <OfflinePanel {draft} />
        {:else if current === "accounts" || current === "account:new" || current.startsWith("account:")}
          <AccountsPanel {current} {pageAccount} onOpen={(p) => (page = p)} />
        {:else}
          <PluginsPanel {current} />
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
    /* Under the row of tabs in a narrow window: the page scrolls, its buttons stay in the window. */
    min-height: 0;
    display: flex;
    flex-direction: column;
  }

  header {
    display: flex;
    align-items: baseline;
    gap: 10px;
    min-width: 0;
    padding: 18px 24px 6px;
  }

  /* A mailbox's address beside its name. */
  .sub {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 12px;
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

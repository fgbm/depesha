<script lang="ts">
  import Settings2 from "@lucide/svelte/icons/settings-2";
  import Mail from "@lucide/svelte/icons/mail";
  import Bell from "@lucide/svelte/icons/bell";
  import Keyboard from "@lucide/svelte/icons/keyboard";
  import CloudOff from "@lucide/svelte/icons/cloud-off";
  import Download from "@lucide/svelte/icons/download";
  import Puzzle from "@lucide/svelte/icons/puzzle";
  import Inbox from "@lucide/svelte/icons/inbox";
  import Power from "@lucide/svelte/icons/power";
  import Users from "@lucide/svelte/icons/users";
  import Search from "@lucide/svelte/icons/search";
  import { tick, untrack, type Component } from "svelte";
  import { app } from "../lib/store.svelte";
  import { registry } from "../plugin-host/registry.svelte";
  import { t, tn } from "../lib/i18n.svelte";
  import { applyTheme } from "../lib/theme";
  import { accountLabel } from "../lib/format";
  import { threshold } from "../lib/largeMail";
  import { levels } from "../lib/quota";
  import { buildSettingsIndex } from "../lib/settingsFields";
  import { searchSettings } from "../lib/settingsSearch";
  import { ownFooter, pageChanged, pageKeys, resolveLeave, widePage } from "../lib/settingsWindow";
  import type { Settings } from "../lib/types";
  import GeneralPanel from "./prefs/GeneralPanel.svelte";
  import MailPanel from "./prefs/MailPanel.svelte";
  import PeoplePanel from "./prefs/PeoplePanel.svelte";
  import OfflinePanel from "./prefs/OfflinePanel.svelte";
  import BackgroundPanel from "./prefs/BackgroundPanel.svelte";
  import AccountsPanel from "./prefs/AccountsPanel.svelte";
  import PluginsPanel from "./prefs/PluginsPanel.svelte";
  import KeysPanel from "./prefs/KeysPanel.svelte";

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
   * the plugins and a page per plugin section. The shell keeps the menu, the page
   * title, the search and the footer; the pages themselves are the panels under `prefs/`.
   */
  const CORE: { id: string; title: () => string; icon: Component }[] = [
    { id: "general", title: () => t("settings.page.general"), icon: Settings2 },
    { id: "background", title: () => t("settings.page.background"), icon: Power },
    { id: "mail", title: () => t("settings.page.mail"), icon: Mail },
    { id: "people", title: () => t("people.title"), icon: Users },
    { id: "notifications", title: () => t("settings.notifications"), icon: Bell },
    { id: "keys", title: () => t("keys.title"), icon: Keyboard },
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

  // A theme is easier to pick by seeing it: it applies at once and goes back on Cancel.
  $effect(() => applyTheme(draft.theme));

  // ---- The search over the settings (#68): it looks in the declared descriptions, not the
  // drawn window, so a new page joins it by adding its fields to settingsFields.ts. ----
  let query = $state("");
  let searchInput = $state<HTMLInputElement | null>(null);
  let contentEl = $state<HTMLElement | null>(null);

  const coreTitle = (p: string) => CORE.find((c) => c.id === p)?.title() ?? t("settings.title");
  const index = $derived([
    ...buildSettingsIndex(coreTitle, t),
    { page: "accounts", group: t("accounts.title"), section: "", label: t("accounts.manageTitle"), anchor: null },
    ...app.accounts.map((a) => ({ page: `account:${a.id}`, group: t("accounts.title"), section: "", label: accountLabel(a), anchor: null })),
    { page: "plugins", group: t("settings.page.plugins"), section: "", label: t("ext.manageTitle"), anchor: null },
    ...sections.map((s, i) => ({ page: `plugin:${i}`, group: t("settings.page.plugins"), section: "", label: s.item.title(), anchor: null })),
  ]);
  const hits = $derived(query.trim() ? searchSettings(index, query) : []);

  /** Opens a hit: the page it is on, then scrolls to the field and lights it a moment. */
  async function openHit(hit: { page: string; anchor: string | null }) {
    if (!(await confirmLeave())) return;
    query = "";
    page = hit.page;
    if (!hit.anchor) return;
    await tick();
    const el = contentEl?.querySelector<HTMLElement>(`[data-settings="${hit.anchor}"]`);
    if (!el) return;
    el.scrollIntoView({ block: "start" });
    el.classList.add("flash");
    setTimeout(() => el.classList.remove("flash"), 1500);
  }

  // ---- The current page's save (#68): «Save / Cancel» is the page's own, not the window's. ----
  const hideFooter = $derived(ownFooter(current));
  const dirty = $derived(
    pageChanged(current, $state.snapshot(draft) as unknown as Record<string, unknown>, $state.snapshot(app.settings) as unknown as Record<string, unknown>) ||
      (current === "general" && threshold(largeValue * (largeUnit === "gb" ? 1024 : 1), app.settings.large_mb) !== app.settings.large_mb),
  );

  /** Writes only the current page's own fields over what is saved; the rest is left as it is. */
  async function savePage(p: string) {
    const keys = pageKeys(p);
    if (!keys) return;
    const d = $state.snapshot(draft);
    // A patch, not the whole settings from this window's memory: a save from elsewhere
    // (the tray, another window) is not rolled back by a page's «Save».
    const patch: Record<string, unknown> = {};
    for (const k of keys) patch[k] = (d as unknown as Record<string, unknown>)[k];
    if (p === "mail") patch.attachments_dir = String(patch.attachments_dir ?? "").trim();
    if (p === "general") patch.large_mb = threshold(largeValue * (largeUnit === "gb" ? 1024 : 1), app.settings.large_mb);
    if (p === "notifications") patch.quota_levels = levels(d.quota_levels).sort((a, b) => a - b) as [number, number];
    await app.patchSettings(patch);
  }

  /** Puts the current page's fields back to what is saved, without touching the others. */
  function revertPage(p: string) {
    const keys = pageKeys(p);
    if (!keys) return;
    const saved = $state.snapshot(app.settings);
    const d = structuredClone($state.snapshot(draft));
    for (const k of keys) (d as unknown as Record<string, unknown>)[k] = (saved as unknown as Record<string, unknown>)[k];
    draft = d;
    if (p === "general") {
      const mb = threshold(saved.large_mb);
      const inGb = mb >= 1024 && mb % 1024 === 0;
      largeUnit = inGb ? "gb" : "mb";
      largeValue = inGb ? mb / 1024 : mb;
    }
  }

  async function save() {
    await savePage(current);
    close();
  }

  function cancel() {
    revertPage(current);
    applyTheme(app.settings.theme);
    close();
  }

  function close() {
    app.settingsOpen = false;
    app.settingsPage = "general";
  }

  /**
   * The page's say before it goes. A mailbox's page keeps its own (its check, its changes);
   * an ordinary page with unsaved changes asks: save them, leave them, or stay.
   */
  async function confirmLeave(): Promise<boolean> {
    if (!(await (app.settingsLeave?.() ?? Promise.resolve(true)))) return false;
    if (!dirty) return true;
    const { answer } = await app.choose({
      title: t("settings.leaveTitle"),
      text: t("settings.leaveText"),
      okLabel: t("file.save"),
      cancelLabel: t("account.leaveDiscard"),
      altLabel: t("cancel"),
    });
    const what = resolveLeave(answer);
    if (what === "stay") return false;
    if (what === "save") await savePage(current);
    else revertPage(current);
    return true;
  }

  async function turn(next: string) {
    if (next === current || !(await confirmLeave())) return;
    page = next;
  }

  function onKey(e: KeyboardEvent) {
    // Esc clears the search first, closes the window second; a menu or a question on top goes before both.
    if (e.key === "Escape" && !app.confirmation && !document.querySelector(".pop")) {
      if (query) {
        e.preventDefault();
        query = "";
        return;
      }
      e.preventDefault();
      confirmLeave().then((ok) => ok && cancel());
    }
  }

  // Ctrl+F inside the window puts the cursor in the search box, as in any application.
  function onWindowKey(e: KeyboardEvent) {
    if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === "f") {
      e.preventDefault();
      searchInput?.focus();
      searchInput?.select();
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

<svelte:window onkeydown={onWindowKey} />

<div class="modal-backdrop" role="presentation">
  <div class="modal prefs" role="dialog" aria-label={t("settings.title")} tabindex="-1" onkeydown={onKey}>
    <nav class="pages" aria-label={t("settings.title")}>
      <h3>{t("settings.title")}</h3>
      <!-- The search over the settings sits above the menu of pages (#68, frame 2А). -->
      <div class="psearch" class:on={!!query.trim()}>
        <Search size={14} />
        <input
          class="q"
          type="search"
          bind:this={searchInput}
          bind:value={query}
          placeholder={t("settings.find")}
          aria-label={t("settings.find")}
        />
        <kbd>Ctrl+F</kbd>
      </div>
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
      {#if query.trim()}
        <!-- The results stand in place of the page; a click opens the page at the field (#68, frame 4А). -->
        <header>
          <h2>{t("settings.find")}</h2>
          <span class="muted sub">{hits.length ? tn("settings.found", hits.length, { q: query.trim() }) : t("settings.findNone")}</span>
        </header>
        <div class="content results">
          <ul class="rlist">
            {#each hits as h, i (h.page + ":" + (h.anchor ?? "") + ":" + i)}
              <li>
                <button class="hit" onclick={() => openHit(h)}>
                  <span class="grp">{h.group}{#if h.section}<span class="muted"> · {h.section}</span>{/if}</span>
                  <span class="lbl">{h.label}</span>
                </button>
              </li>
            {/each}
          </ul>
        </div>
      {:else}
        <header>
          <h2>{title}</h2>
          {#if pageAccount}<span class="muted sub">{pageAccount.email}{pageAccount.ews ? " · Exchange" : ""}</span>{/if}
        </header>
        <div class="content" class:flush={current.startsWith("account:")} class:wide={widePage(current)} bind:this={contentEl} role="tabpanel" aria-label={title}>
          {#if current === "general" || current === "updates"}
            <GeneralPanel {current} {draft} bind:largeValue bind:largeUnit />
          {:else if current === "mail" || current === "notifications"}
            <MailPanel {current} {draft} onOpen={(p) => void turn(p)} />
          {:else if current === "people"}
            <PeoplePanel />
          {:else if current === "background"}
            <BackgroundPanel {draft} />
          {:else if current === "offline"}
            <OfflinePanel {draft} />
          {:else if current === "keys"}
            <KeysPanel {draft} />
          {:else if current === "accounts" || current === "account:new" || current.startsWith("account:")}
            <AccountsPanel {current} {pageAccount} onOpen={(p) => (page = p)} />
          {:else}
            <PluginsPanel {current} />
          {/if}
        </div>
        {#if !hideFooter}
          <footer>
            <span class="spacer"></span>
            <button class="btn ghost" onclick={cancel}>{t("cancel")}</button>
            <button class="btn primary" onclick={save}>{t("file.save")}</button>
          </footer>
        {/if}
      {/if}
    </div>
  </div>
</div>

<style>
  /* One size for every page, the one the expanded letter has: switching pages never makes
     the window jump, and the window does not jump between the settings and a letter (#68). */
  .prefs {
    width: min(var(--win-max), calc(100vw - 2 * var(--win-gap)));
    height: calc(100vh - 2 * var(--win-gap));
    display: flex;
    flex-direction: row;
    padding: 0;
    overflow: hidden;
  }

  .pages {
    flex: none;
    width: var(--menu-width);
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

  /* «Find a setting» over the menu of pages (#68, frame 2А). */
  .psearch {
    display: flex;
    align-items: center;
    gap: 7px;
    height: 30px;
    margin: 0 0 10px;
    padding: 0 8px;
    border: 1px solid var(--line);
    border-radius: 6px;
    background: var(--paper);
    color: var(--muted);
  }

  .psearch:focus-within,
  .psearch.on {
    border-color: var(--accent);
    color: var(--ink);
    box-shadow: 0 0 0 2px color-mix(in srgb, var(--accent) 22%, transparent);
  }

  .psearch :global(svg) {
    flex: none;
  }

  .psearch .q {
    flex: 1;
    min-width: 0;
    border: none;
    background: none;
    color: var(--ink);
    font: inherit;
    font-size: 13px;
    outline: none;
  }

  .psearch kbd {
    flex: none;
    font-size: 10px;
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

  /* A page's fields keep to one column; a table takes the whole width (#68, frame 5А).
     A mailbox's page (flush) lays itself out and is left alone. */
  .content:not(.flush) :global(section) {
    max-width: var(--column-max);
  }

  .content.wide :global(section) {
    max-width: none;
  }

  /* The field a search opened the page at: lit a moment, as a list row in #63. */
  .content :global([data-settings].flash) {
    border-radius: 6px;
    box-shadow: 0 0 0 2px var(--accent);
    transition: box-shadow 0.3s;
  }

  /* A mailbox's page scrolls inside and keeps its own buttons in sight. */
  .content.flush {
    padding: 0;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }

  /* The search results stand in place of the page (#68, frame 4А). */
  .results {
    padding: 4px 24px 12px;
  }

  .rlist {
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .hit {
    display: flex;
    flex-direction: column;
    gap: 2px;
    width: 100%;
    max-width: var(--column-max);
    padding: 8px 10px;
    border: none;
    border-radius: 6px;
    background: none;
    color: var(--ink);
    font: inherit;
    text-align: left;
    cursor: pointer;
  }

  .hit:hover,
  .hit:focus-visible {
    background: var(--hover);
  }

  .hit:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: -2px;
  }

  .grp {
    font-size: 12px;
    color: var(--muted);
  }

  .lbl {
    font-size: 13.5px;
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

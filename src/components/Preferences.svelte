<script lang="ts">
  import Search from "@lucide/svelte/icons/search";
  import { tick, untrack } from "svelte";
  import { app } from "../lib/store.svelte";
  import { registry } from "../plugin-host/registry.svelte";
  import { t, tn } from "../lib/i18n.svelte";
  import { accountLabel } from "../lib/format";
  import { MENU, PAGES, menuPages, pageIcon, pageSpec, pageTitle, resolvePage } from "../lib/settingsCatalog";
  import { SettingsAutosave } from "../lib/settingsAutosave.svelte";
  import { buildSettingsIndex } from "../lib/settingsFields";
  import { searchSettings } from "../lib/settingsSearch";
  import { isRowPage, widePage } from "../lib/settingsWindow";
  import SettingsPage from "./prefs/SettingsPage.svelte";
  import PeoplePanel from "./prefs/PeoplePanel.svelte";
  import AccountsPanel from "./prefs/AccountsPanel.svelte";
  import PluginsPanel from "./prefs/PluginsPanel.svelte";
  import KeysPanel from "./prefs/KeysPanel.svelte";

  /**
   * Every setting in one window (#68, #102): the pages of the menu (two axes, «Mail» and
   * «App»), the mailboxes and the plugins. The shell keeps the menu, the page title, the
   * search and the line at the foot; a page of rows is SettingsPage, the rest draw themselves.
   * Everything is saved at once, so the window has no «Save» and closes without a question.
   */
  const auto = new SettingsAutosave({
    settings: () => $state.snapshot(app.settings) as unknown as Record<string, unknown>,
    patch: (patch) => app.patchSettings(patch),
    toast: (text, action) => app.toast(text, false, action),
    dismiss: (id) => app.dismiss(id),
  });

  const sections = $derived(registry.lists.settingsSections);
  const pages = menuPages();

  let page = $state(resolvePage(app.settingsPage));
  // A link inside the settings (a mailbox's «Storage» to «Hints») turns the page.
  $effect(() => {
    void app.settingsTurn;
    untrack(() => void turn(resolvePage(app.settingsPage)));
  });
  // A page that went away (its mailbox) falls back to the first one.
  const pageAccount = $derived(page.startsWith("account:") ? (app.accounts.find((a) => `account:${a.id}` === page) ?? null) : null);
  const current = $derived(pages.includes(page) || page === "account:new" || pageAccount ? page : pages[0]);
  /** The menu entry that is lit: a mailbox's page belongs to «Mailboxes». */
  const lit = $derived(current.startsWith("account:") ? "accounts" : current);
  const spec = $derived(pageSpec(current));
  const title = $derived(pageAccount ? accountLabel(pageAccount) : current === "account:new" ? t("cmd.addAccount") : pageTitle(current));

  /** The plugins' groups that stand on a page; those that name no page, or none that is there, stand on the plugins' page. */
  const sectionsOn = (id: string) =>
    sections.filter((s) => (id === "plugins" ? !PAGES.some((p) => p.id === s.item.page) : s.item.page === id));

  // ---- The search over the settings (#68): it looks in the declared catalog, not the drawn window. ----
  let query = $state("");
  let searchInput = $state<HTMLInputElement | null>(null);
  let contentEl = $state<HTMLElement | null>(null);
  /** The row a hit opened the page at, lit a moment. */
  let flash = $state<string | null>(null);

  const index = $derived([
    ...buildSettingsIndex(),
    ...app.accounts.map((a) => ({ page: `account:${a.id}`, group: pageTitle("accounts"), section: "", label: accountLabel(a), anchor: null })),
    ...sections.map((s) => {
      const home = PAGES.some((p) => p.id === s.item.page) ? (s.item.page as string) : "plugins";
      return { page: home, group: pageTitle(home), section: t("settings.pluginTag"), label: s.item.title(), anchor: null };
    }),
  ]);
  const hits = $derived(query.trim() ? searchSettings(index, query) : []);

  /** Opens a hit: the page it is on, then the row, lit a moment and with the focus on it (#102, 4.4 А). */
  async function openHit(hit: { page: string; anchor: string | null }) {
    query = "";
    await turn(hit.page);
    if (!hit.anchor) return;
    await reveal(hit.anchor);
  }

  /** The row with this id on the open page; none for the first one. */
  const rowEl = (id: string | null) => contentEl?.querySelector<HTMLElement>(id ? `.rw[data-row="${CSS.escape(id)}"]` : ".rw[data-row]") ?? null;

  /** Scrolled to, lit a moment and given the focus: found, so the value can be changed from the keyboard (#102, 4.4 А). */
  async function reveal(id: string) {
    await tick();
    const el = rowEl(id);
    if (!el) return;
    el.scrollIntoView({ block: "center" });
    el.focus();
    flash = id;
    setTimeout(() => flash === id && (flash = null), 1500);
  }

  function close() {
    app.settingsOpen = false;
    app.settingsPage = "reading";
  }

  /** A mailbox's page keeps its own say before it goes (its check, its changes); the others ask nothing. */
  async function mayLeave(): Promise<boolean> {
    return (await (app.settingsLeave?.() ?? Promise.resolve(true))) !== false;
  }

  async function turn(next: string): Promise<boolean> {
    if (next === current) return true;
    if (!(await mayLeave())) return false;
    page = next;
    return true;
  }

  /** A mailbox's page finishing (saved, deleted) goes back to the list by itself: it has said its own, so the window asks nothing. */
  const backToList = (p: string) => (page = p);

  /** From a row: another page, a mailbox's at a section, or a person in the book. */
  function go(next: string, opts: { section?: string; person?: string } = {}) {
    if (opts.person) app.settingsPerson = opts.person;
    app.openSettings(next, opts.section ?? null);
  }

  function onKey(e: KeyboardEvent) {
    // Esc clears the search first, closes the window second; a menu or a question on top goes before both.
    if (e.key === "Escape" && !app.confirmation && !document.querySelector(".pop")) {
      e.preventDefault();
      if (query) query = "";
      else mayLeave().then((ok) => ok && close());
      return;
    }
    if ((e.ctrlKey || e.metaKey) && (e.key === "PageDown" || e.key === "PageUp")) {
      e.preventDefault();
      const i = pages.indexOf(lit) + (e.key === "PageDown" ? 1 : -1);
      turn(pages[(i + pages.length) % pages.length]).then(() => focusPage());
      return;
    }
    if (e.altKey && e.key === "ArrowLeft") {
      e.preventDefault();
      focusMenu();
      return;
    }
    // Ctrl+Z takes the last change back, unless the cursor is in a field whose own undo it is.
    if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "z" && isRowPage(current)) {
      if ((e.target as HTMLElement).matches("input, textarea, [contenteditable]") || !auto.canUndo) return;
      e.preventDefault();
      void auto.undo();
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

  function focusMenu() {
    document.querySelector<HTMLElement>(`.prefs .tab[data-page="${lit}"]`)?.focus();
  }

  /** From the menu into the page: the first row of a page of rows, else the first thing in it that takes the focus. */
  async function focusPage() {
    await tick();
    (spec ? rowEl(null) : contentEl?.querySelector<HTMLElement>("input, button, select, [tabindex='0']"))?.focus();
  }

  /** ↑/↓ move between pages, as in any list of tabs; →/Enter go into the page. */
  function onNavKey(e: KeyboardEvent) {
    if (e.key === "ArrowRight" || e.key === "Enter") {
      e.preventDefault();
      void focusPage();
      return;
    }
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const i = pages.indexOf(lit) + (e.key === "ArrowDown" ? 1 : -1);
    const next = pages[(i + pages.length) % pages.length];
    turn(next).then(() => document.querySelector<HTMLElement>(`.prefs .tab[data-page="${next}"]`)?.focus());
  }

  function onSearchKey(e: KeyboardEvent) {
    if (e.key === "ArrowDown" && query.trim()) {
      e.preventDefault();
      document.querySelector<HTMLElement>(".prefs .hit")?.focus();
    }
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
          onkeydown={onSearchKey}
        />
        <kbd>Ctrl+F</kbd>
      </div>
      <div role="tablist" aria-orientation="vertical" tabindex="-1" onkeydown={onNavKey}>
        {#each MENU as g (g.pages[0])}
          <div class="group">{g.title()}</div>
          {#each g.pages as id (id)}
            {@const Icon = pageIcon(id)}
            <button class="tab" role="tab" data-page={id} aria-selected={lit === id} tabindex={lit === id ? 0 : -1} onclick={() => turn(id)}>
              {#if Icon}<Icon size={16} />{/if}<span>{pageTitle(id)}</span>
            </button>
          {/each}
        {/each}
      </div>
    </nav>

    <div class="pane">
      {#if query.trim()}
        <!-- The results stand in place of the page; a click opens the page at the row (#68, frame 4А). -->
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
          {#if spec}
            {#key spec.id}
              <SettingsPage page={spec} {auto} sections={sectionsOn(spec.id)} {flash} {go} />
            {/key}
          {:else if current === "keys"}
            <KeysPanel draft={app.settings} />
          {:else if current === "people"}
            <PeoplePanel />
          {:else if current === "plugins"}
            <PluginsPanel sections={sectionsOn("plugins")} />
          {:else}
            <AccountsPanel {current} {pageAccount} onOpen={backToList} />
          {/if}
        </div>
        {#if isRowPage(current)}
          <footer>{t("settings.applied")}</footer>
        {/if}
      {/if}
    </div>
  </div>
</div>

<style>
  /* One size for every page, its own limit (wider than the letter since 0.7.1): switching
     pages never makes the window jump, and the window does not jump between the settings
     and a letter (#68). */
  .prefs {
    width: min(var(--prefs-max), calc(100vw - 2 * var(--win-gap)));
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
    gap: 6px;
    height: 30px;
    margin: 0 0 10px;
    padding: 0 7px;
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
    /* The search field's own decorations would reserve room the placeholder needs. */
    appearance: none;
  }

  .psearch .q::-webkit-search-cancel-button,
  .psearch .q::-webkit-search-decoration {
    appearance: none;
  }

  /* A small cap: the «Ctrl+F» and the placeholder «Find a setting» both fit the menu's width. */
  .psearch kbd {
    flex: none;
    font-size: 9.5px;
    padding: 0 2px;
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

  /* No buttons: a change is saved at once (#102, 1.7), the line says so. */
  footer {
    padding: 10px 24px 14px;
    border-top: 1px solid var(--line);
    font-size: 12px;
    color: var(--muted);
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

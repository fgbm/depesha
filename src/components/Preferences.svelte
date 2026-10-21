<script lang="ts">
  import Search from "@lucide/svelte/icons/search";
  import ChevronDown from "@lucide/svelte/icons/chevron-down";
  import ChevronRight from "@lucide/svelte/icons/chevron-right";
  import CloseButton from "./CloseButton.svelte";
  import { onMount, tick } from "svelte";
  import { app } from "../lib/store.svelte";
  import { bus } from "../lib/bus";
  import { registry } from "../plugin-host/registry.svelte";
  import { host } from "../plugin-host/host.svelte";
  import { extensions, textOf } from "../lib/extensions.svelte";
  import { i18n, t, tn } from "../lib/i18n.svelte";
  import { accountColor, accountLabel } from "../lib/format";
  import { shortcuts } from "../lib/shortcuts.svelte";
  import { MENU, pageIcon, pageSpec, pageTitle, resolvePage, rowOf, type GroupSpec, type PageSpec, type RowSpec } from "../lib/settingsCatalog";
  import { SettingsAutosave } from "../lib/settingsAutosave.svelte";
  import { buildSettingsIndex, mailboxIndex } from "../lib/settingsFields";
  import { searchSettings, type SearchHit } from "../lib/settingsSearch";
  import { isRowPage, widePage } from "../lib/settingsWindow";
  import SettingsPage from "./prefs/SettingsPage.svelte";
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
    settings: () => $state.snapshot(app.settingsCtl.settings) as unknown as Record<string, unknown>,
    patch: (patch) => app.settingsCtl.patchSettings(patch),
    toast: (text, action) => app.ui.toast(text, false, action),
    dismiss: (id) => app.ui.dismiss(id),
  });

  const sections = $derived(registry.lists.settingsSections);

  // ---- The menu: the entries, and under «Mailboxes» and «Plugins» one per mailbox and per plugin with settings (0.8.12, screen 7). ----

  /** The plugins that have settings of their own, in the order their groups came (6.1 Б). */
  const pluginOwners = $derived([...new Set(sections.map((s) => s.owner))]);
  const kidsOf = (entry: string): string[] =>
    entry === "accounts" ? app.mailboxes.accounts.map((a) => `account:${a.id}`) : entry === "plugins" ? pluginOwners.map((o) => `plugin:${o}`) : [];
  const parentOf = (p: string): string | null => (p.startsWith("account:") ? "accounts" : p.startsWith("plugin:") ? "plugins" : null);

  let page = $state(resolvePage(app.ui.settingsPage));
  // A link inside the settings (a mailbox's «Storage» to «Hints») turns the page.
  $effect(() => bus.on("settings.open", (at) => void turn(resolvePage(at.page))));
  const pageAccount = $derived(page.startsWith("account:") ? (app.mailboxes.accounts.find((a) => `account:${a.id}` === page) ?? null) : null);
  const pagePlugin = $derived(page.startsWith("plugin:") && pluginOwners.includes(page.slice(7)) ? page.slice(7) : null);
  // A page that went away (its mailbox, its plugin) falls back to the first one.
  const current = $derived(MENU.some((g) => g.pages.includes(page)) || page === "account:new" || pageAccount || pagePlugin ? page : MENU[0].pages[0]);
  /** The entry that is lit: a mailbox's own page lights its sub-entry, a new mailbox «Mailboxes». */
  const lit = $derived(current === "account:new" ? "accounts" : current);
  /** The entry whose page or sub-entry's page is open: it is unfolded while so (6.2 А). */
  const litParent = $derived(parentOf(lit) ?? lit);

  /** Folded by ← though open, and unfolded by → though not: the hand's say over 6.2 А. */
  let folded = $state<string[]>([]);
  let unfolded = $state<string[]>([]);
  const isOpen = (entry: string) => kidsOf(entry).length > 0 && ((!searching && litParent === entry && !folded.includes(entry)) || unfolded.includes(entry));
  /** Every entry of the menu as it is drawn now, top to bottom: ↑/↓ and Ctrl+PgUp/PgDn walk it. */
  const pages = $derived(MENU.flatMap((g) => g.pages.flatMap((p) => [p, ...(isOpen(p) ? kidsOf(p) : [])])));

  const spec = $derived(pageSpec(current));
  const pluginTitle = (owner: string): string => {
    const p = host.plugins.find((x) => x.manifest.id === owner);
    if (p) return i18n.lang === "ru" ? p.manifest.name.ru : p.manifest.name.en;
    const ext = extensions.list.find((e) => e.id === owner);
    return ext ? textOf(ext.name) : (sections.find((s) => s.owner === owner)?.item.title() ?? owner);
  };
  const pluginAbout = (owner: string): string | null => {
    const p = host.plugins.find((x) => x.manifest.id === owner);
    if (p) return i18n.lang === "ru" ? p.manifest.description.ru : p.manifest.description.en;
    const ext = extensions.list.find((e) => e.id === owner);
    return ext?.description ? textOf(ext.description) : null;
  };
  const entryTitle = (p: string): string => {
    if (p.startsWith("account:")) {
      const a = app.mailboxes.accounts.find((x) => `account:${x.id}` === p);
      return a ? accountLabel(a) : "";
    }
    return p.startsWith("plugin:") ? pluginTitle(p.slice(7)) : pageTitle(p);
  };
  const title = $derived(current === "account:new" ? t("cmd.addAccount") : entryTitle(current));
  const sub = $derived(
    pageAccount
      ? `${pageAccount.email}${pageAccount.ews ? " · Exchange" : ""}`
      : pagePlugin
        ? host.plugins.some((x) => x.manifest.id === pagePlugin) ? t("settings.pluginBuiltIn") : t("settings.pluginExternal")
        : null,
  );

  // ---- The search over the settings (#68): it looks in the declared catalog, not the drawn window. ----
  let query = $state("");
  /** While the search is on, the rows found stand in place of the open page: no entry is lit or unfolded for it. */
  const searching = $derived(!!query.trim());
  let searchInput = $state<HTMLInputElement | null>(null);
  let contentEl = $state<HTMLElement | null>(null);
  /** The row a hit opened the page at, lit a moment. */
  let flash = $state<string | null>(null);

  const index = $derived([
    ...buildSettingsIndex(),
    ...app.mailboxes.accounts.map((a) => ({ page: `account:${a.id}`, group: pageTitle("accounts"), section: "", label: accountLabel(a), anchor: null })),
    ...mailboxIndex(app.mailboxes.accounts),
    ...sections.map((s) => ({ page: `plugin:${s.owner}`, group: pluginTitle(s.owner), section: "", label: s.item.title(), anchor: `plugin:${s.owner}` })),
    // The commands of «Keys» (4.2 А): a hit opens the page at the command, lit.
    ...shortcuts.commands().map((c) => ({ page: "keys", group: pageTitle("keys"), section: "", label: c.title(), anchor: `key:${c.id}` })),
  ]);
  const hits = $derived(query.trim() ? searchSettings(index, query) : []);

  /** A hit on a row of a page of rows: the row itself, alive (4.1 Б). */
  function liveRow(h: SearchHit): RowSpec | null {
    const at = h.anchor ? rowOf(h.anchor) : null;
    // The strip of a dependent row is its page's: alone among the hits it would mean nothing.
    return at && at.page.id === h.page ? { ...at.row, dep: false } : null;
  }

  /** A hit with no row here: a way to its place, with what it is under; a mailbox's group says that itself. */
  const wayRow = (h: SearchHit, i: number): RowSpec => ({
    id: `hit:${i}`,
    kind: "go",
    label: () => h.label,
    hint: () => (h.page.startsWith("account:") ? null : h.section || null),
    text: () => (h.page.startsWith("account:") ? t("settings.openAtMailbox") : t("settings.open")),
    open: () => void openHit(h),
  });

  /** The address beside a mailbox's group of hits, when its name is not the address already. */
  function addressOf(h: SearchHit): string | null {
    const a = h.page.startsWith("account:") ? app.mailboxes.accounts.find((x) => `account:${x.id}` === h.page) : null;
    return a && h.group === accountLabel(a) && a.email !== h.group ? a.email : null;
  }

  /** The hits as a page of rows, grouped by the page they are on, in the order found. */
  const found = $derived.by((): PageSpec => {
    const groups: GroupSpec[] = [];
    hits.forEach((h, i) => {
      let g = groups.find((x) => x.id === `found:${h.group}`);
      if (!g) groups.push((g = { id: `found:${h.group}`, title: () => h.group, sub: addressOf(h), rows: [] }));
      g.rows.push(liveRow(h) ?? wayRow(h, i));
    });
    return { id: "search", title: () => t("settings.find"), icon: Search, groups };
  });

  /** Opens a hit: the page it is on, then the row, lit a moment and with the focus on it (#102, 4.4 А). */
  async function openHit(hit: { page: string; anchor: string | null; label: string }) {
    query = "";
    // What was a page of the settings is the book now (#104): a hit on a person's field leads there.
    if (hit.page === "people") return void (await go("people"));
    // «Keys» finds and lights its command itself (#46).
    if (hit.anchor?.startsWith("key:")) app.ui.settingsKeys = { id: hit.anchor.slice(4), title: hit.label };
    await turn(hit.page);
    if (!hit.anchor || hit.anchor.startsWith("key:")) return;
    await reveal(hit.anchor);
  }

  /** The row with this id on the open page; none for the first one. */
  const rowEl = (id: string | null) => contentEl?.querySelector<HTMLElement>(id ? `.rw[data-row="${CSS.escape(id)}"]` : ".rw[data-row]") ?? null;

  /** Where an anchor that is no row stands: a field of a page of its own, or a plugin's group. */
  const fieldSelector = (id: string) =>
    id.startsWith("plugin:") ? `section[data-plugin="${CSS.escape(id.slice(7))}"]` : `[data-settings="${CSS.escape(id)}"]`;

  /** Scrolled to, lit a moment and given the focus: found, so the value can be changed from the keyboard (#102, 4.4 А). */
  async function reveal(id: string) {
    await tick();
    // A page of its own (a mailbox's, a plugin's) marks its fields with `data-settings`.
    const el = rowEl(id) ?? contentEl?.querySelector<HTMLElement>(fieldSelector(id)) ?? null;
    if (!el) return;
    el.scrollIntoView({ block: "center" });
    // A row of a mailbox's page is no stop of the keyboard: its field is.
    const own = !!el.closest(".account-page");
    const into = el.matches("input, button, select, textarea") ? el : el.querySelector<HTMLElement>("input:not([type=radio]), input:checked, button, select, textarea");
    ((el.matches(".rw") && !own) || !into ? el : into).focus();
    flash = id;
    // The rows of a mailbox's page are not the window's to light: the mark goes on the row itself.
    if (own) el.classList.add("flash");
    setTimeout(() => {
      if (flash === id) flash = null;
      if (own) el.classList.remove("flash");
    }, 1500);
  }

  function close() {
    app.ui.settingsOpen = false;
    app.ui.settingsPage = "reading";
  }

  /** A mailbox's page keeps its own say before it goes (its check, its changes); the others ask nothing. */
  async function mayLeave(): Promise<boolean> {
    return (await (app.ui.settingsLeave?.() ?? Promise.resolve(true))) !== false;
  }

  /** A field being typed in keeps what is typed: it is left, and the writes under way are waited for. */
  async function settle() {
    const el = document.activeElement;
    if (el instanceof HTMLElement && contentEl?.contains(el) && el.matches("input, textarea")) el.blur();
    await auto.settled();
  }

  async function turn(next: string): Promise<boolean> {
    if (next === current) return true;
    await settle();
    if (!(await mayLeave())) return false;
    // Another entry's page: what the hand folded comes back to the rule (6.2 А).
    if ((parentOf(next) ?? next) !== litParent) folded = [];
    page = next;
    return true;
  }

  /** A mailbox's page finishing (saved, deleted) goes back to the list by itself: it has said its own, so the window asks nothing. */
  const backToList = (p: string) => (page = p);

  /** From a row: another page, a mailbox's at a section, or a person in the book. */
  async function go(next: string, opts: { section?: string; person?: string } = {}) {
    // The people live in the main window (#104): the settings give way to the book, with the
    // list narrowed to the people who differ when a person is asked for.
    if (next === "people") {
      await settle();
      if (!(await mayLeave())) return;
      void app.openPeople({ email: opts.person, filter: "ruled" });
      return;
    }
    app.ui.openSettings(next, opts.section ?? null);
  }

  /** The fields that have an undo of their own. */
  const TEXT_FIELD = "input:not([type=checkbox], [type=radio], [type=button], [type=color]), textarea, [contenteditable]";

  /** The cross and the click on the dimmed ground go the way Esc goes: a mailbox's page has its say first. */
  const leave = async () => {
    await settle();
    if (await mayLeave()) close();
  };

  /** Esc leaves a menu or a question on top alone; so does a press on the ground. */
  const covered = () => !!app.ui.confirmation || app.ui.tasksOpen || !!document.querySelector(".pop");

  function onKey(e: KeyboardEvent) {
    // Esc clears the search first, closes the window second; a menu or a question on top goes before both.
    if (e.key === "Escape" && !covered() && !e.isComposing) {
      e.preventDefault();
      if (query) query = "";
      else void leave();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && (e.key === "PageDown" || e.key === "PageUp")) {
      e.preventDefault();
      // The sub-entries of an open entry come in their turn.
      const i = pages.indexOf(lit) + (e.key === "PageDown" ? 1 : -1);
      turn(pages[(i + pages.length) % pages.length]).then(() => focusPage());
      return;
    }
    if (e.altKey && e.key === "ArrowLeft") {
      e.preventDefault();
      focusMenu();
      return;
    }
    if (undoKey(e)) return;
    tabOutKey(e);
  }

  /**
   * Ctrl+Z takes back the last change of this page, unless the cursor is in a field whose own undo it is,
   * or in a plugin's group, whose changes are not the page's. A mailbox's page keeps its own changes.
   */
  function undoKey(e: KeyboardEvent): boolean {
    if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey || e.key.toLowerCase() !== "z") return false;
    const mailbox = !query.trim() && current.startsWith("account:") && current !== "account:new";
    // The rows found are changed as the search's own page.
    const at = query.trim() ? "search" : current;
    if (!mailbox && !isRowPage(at)) return false;
    const el = e.target as HTMLElement;
    // A box or a button has no undo of its own: the key takes back the change it made.
    if (el.matches(TEXT_FIELD) || el.closest("[data-g='plugin']")) return true;
    if (mailbox ? !app.ui.settingsUndo : !auto.canUndo(at)) return true;
    e.preventDefault();
    void (mailbox ? app.ui.settingsUndo?.() : auto.undo(at));
    return true;
  }

  /** Tab past the last stop of the page goes to the menu, not out of the window: the foot is only a line of text. */
  function tabOutKey(e: KeyboardEvent) {
    if (e.key !== "Tab" || e.shiftKey || e.defaultPrevented || e.ctrlKey || e.altKey || e.metaKey || !contentEl?.contains(e.target as Node)) return;
    const stops = [...contentEl.querySelectorAll<HTMLElement>("a[href], button, input, select, textarea, [tabindex]")].filter((x) => x.tabIndex >= 0 && !(x as HTMLInputElement).disabled);
    if (stops.at(-1) !== e.target) return;
    e.preventDefault();
    focusMenu();
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
    document.querySelector<HTMLElement>(`.prefs .tab[data-page="${CSS.escape(lit)}"]`)?.focus();
  }

  const focusTab = (p: string) => document.querySelector<HTMLElement>(`.prefs .tab[data-page="${CSS.escape(p)}"]`)?.focus();

  /** From the menu into the page: the first row of a page of rows, else the first thing in it that takes the focus. */
  async function focusPage() {
    await tick();
    (spec ? rowEl(null) : contentEl?.querySelector<HTMLElement>("input:not(:disabled), button:not(:disabled), select, [tabindex='0']"))?.focus();
  }

  const fold = (entry: string) => {
    if (!folded.includes(entry)) folded = [...folded, entry];
    unfolded = unfolded.filter((x) => x !== entry);
  };

  /** The keys of the menu, by the table of screen 7 (0.8.12); → on a folded entry unfolds it, not 0.8.0's 4.3 А. */
  function onNavKey(e: KeyboardEvent) {
    const at = (e.target as HTMLElement).closest<HTMLElement>(".tab")?.dataset.page ?? lit;
    const parent = parentOf(at);
    if (e.key === "ArrowRight") {
      e.preventDefault();
      if (kidsOf(at).length && !isOpen(at)) {
        folded = folded.filter((x) => x !== at);
        if (litParent !== at) unfolded = [...unfolded, at];
      } else void focusPage();
      return;
    }
    if (e.key === "ArrowLeft") {
      e.preventDefault();
      const entry = parent ?? (isOpen(at) ? at : null);
      if (!entry) return;
      fold(entry);
      if (parent) turn(parent).then(() => focusTab(parent));
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      turn(at).then((ok) => void (ok && focusPage()));
      return;
    }
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const i = pages.indexOf(at) + (e.key === "ArrowDown" ? 1 : -1);
    const next = pages[(i + pages.length) % pages.length];
    turn(next).then(() => tick()).then(() => focusTab(next));
  }

  function onSearchKey(e: KeyboardEvent) {
    // ↓ from the search: to the first row found, or to the first row of the page when nothing is asked (4.3 А).
    if (e.key !== "ArrowDown") return;
    e.preventDefault();
    if (query.trim()) contentEl?.querySelector<HTMLElement>(".rw[data-row]")?.focus();
    else void focusPage();
  }

  // The cursor is in the search when the window opens (4.3 А); opened at a row, it is on the row.
  const openedAtRow = !!(app.ui.settingsSection || app.ui.settingsKeys);
  onMount(() => {
    if (!openedAtRow) void tick().then(() => searchInput?.focus());
  });
</script>

<svelte:window onkeydown={onWindowKey} />

<div class="modal-backdrop" role="presentation" onpointerdown={(e) => e.target === e.currentTarget && !covered() && void leave()}>
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
      </div>
      <div role="tablist" aria-orientation="vertical" tabindex="-1" onkeydown={onNavKey}>
        {#each MENU as g (g.pages[0])}
          <!-- A group of one entry has no heading, only the room above it (0.8.12, 2.2 А). -->
          {#if g.title}<div class="group">{g.title()}</div>{:else}<div class="gap"></div>{/if}
          {#each g.pages as id (id)}
            {@const Icon = pageIcon(id)}
            {@const kids = kidsOf(id)}
            {@const open = isOpen(id)}
            <button
              class="tab"
              role="tab"
              data-page={id}
              aria-selected={!searching && lit === id}
              aria-expanded={kids.length ? open : undefined}
              tabindex={lit === id ? 0 : -1}
              onclick={() => turn(id)}
            >
              {#if Icon}<Icon size={16} />{/if}<span>{pageTitle(id)}</span>
              {#if kids.length}<span class="chv">{#if open}<ChevronDown size={14} />{:else}<ChevronRight size={14} />{/if}</span>{/if}
            </button>
            {#if open}
              {#each kids as kid, i (kid)}
                {@const acc = kid.startsWith("account:") ? app.mailboxes.accounts.find((a) => `account:${a.id}` === kid) : undefined}
                <button class="tab kid" role="tab" data-page={kid} aria-selected={!searching && lit === kid} tabindex={lit === kid ? 0 : -1} onclick={() => turn(kid)}>
                  {#if acc}<span class="kdot" style:background={accountColor(acc, i)}></span>{/if}<span>{entryTitle(kid)}</span>
                </button>
              {/each}
            {/if}
          {/each}
        {/each}
      </div>
    </nav>

    <CloseButton corner onclick={() => void leave()} />

    <div class="pane">
      {#if query.trim()}
        <!-- The rows found stand in place of the page, alive: a value is changed where it is found (0.8.12, 4.1 Б). -->
        <header>
          <h2>{t("settings.find")}</h2>
          <span class="muted sub">{hits.length ? tn("settings.found", hits.length, { q: query.trim() }) : t("settings.findNone")}</span>
        </header>
        <div class="content results" bind:this={contentEl} role="tabpanel" aria-label={t("settings.find")}>
          {#key "search"}
            <SettingsPage page={found} {auto} flash={null} {go} />
          {/key}
        </div>
      {:else}
        <header>
          <h2>{title}</h2>
          {#if sub}<span class="muted sub">{sub}</span>{/if}
        </header>
        <div class="content" class:flush={current.startsWith("account:")} class:wide={widePage(current)} bind:this={contentEl} role="tabpanel" aria-label={title}>
          {#if spec}
            {#key spec.id}
              <SettingsPage page={spec} {auto} {flash} {go} />
            {/key}
          {:else if current === "keys"}
            <KeysPanel draft={app.settingsCtl.settings} />
          {:else if current === "plugins" || pagePlugin}
            {#key current}
              <PluginsPanel owner={pagePlugin} about={pagePlugin ? pluginAbout(pagePlugin) : null} {sections} {flash} />
            {/key}
          {:else}
            <AccountsPanel {current} {pageAccount} onOpen={backToList} />
          {/if}
        </div>
      {/if}
    </div>
  </div>
</div>

<style>
  /* One size for every page, the expanded letter's since 0.8.12 (5.1 А): switching pages never
     makes the window jump, and the window does not jump between the settings and a letter (#68). */
  .prefs {
    width: min(var(--prefs-max), calc(100vw - 2 * var(--win-gap)));
    height: calc(100vh - 2 * var(--win-gap));
    display: flex;
    flex-direction: row;
    padding: 0;
    overflow: hidden;
    position: relative;
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
    border-color: var(--accent-text);
    color: var(--ink);
    box-shadow: 0 0 0 2px color-mix(in srgb, var(--accent-text) 22%, transparent);
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

  /* The open page: a quiet fill, no bar (#165). */
  .tab[aria-selected="true"] {
    background: var(--selected);
    font-weight: 600;
  }

  .tab[aria-selected="true"] :global(svg) {
    color: var(--ink);
  }

  .tab:focus-visible {
    outline: 2px solid var(--accent-text);
    outline-offset: -2px;
  }

  /* The sub-entries: a mailbox with the dot of its colour, a plugin; the open one by the ground alone. */
  .tab.kid {
    gap: 8px;
    padding: 6px 10px 6px 36px;
    font-size: 12.5px;
  }

  .kdot {
    flex: none;
    width: 8px;
    height: 8px;
    border-radius: 50%;
  }

  .chv {
    display: flex;
    margin-left: auto;
    color: var(--muted);
  }

  .gap {
    height: 14px;
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
    padding: 18px 56px 6px 24px;
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

    .group,
    .gap {
      display: none;
    }
  }
</style>

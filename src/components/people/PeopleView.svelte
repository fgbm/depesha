<script lang="ts">
  // The address book (#104): «People» of the main window, beside the folders. On the left the
  // people with a search, the filters and the suggestion «maybe one person»; on the right the card
  // of the one under the cursor — the same card as in a letter. Everything is reached from the
  // keyboard: the arrows walk the list, Space marks, M joins the marked (or the suggested pair),
  // N says «two people», Enter goes into the card, Esc comes back, «/» is the search. A change
  // in the card is saved as it is made.
  import { t } from "../../lib/i18n.svelte";
  import { app } from "../../lib/store.svelte";
  import { avatarColor, initials, parseAddr } from "../../lib/format";
  import { pressName } from "../../lib/keymap";
  import { blankPerson, filterPeople, formatMark, matchPerson, type PeopleFilter, type Person } from "../../lib/people";
  import { personKey } from "../../lib/peopleMerge";
  import { peopleBook } from "../../lib/peopleBook.svelte";
  import { peopleOps } from "../../lib/peopleOps.svelte";
  import { allMailQuery } from "../../lib/people";
  import { tick, untrack } from "svelte";
  import PersonCard from "../reader/PersonCard.svelte";
  import Search from "@lucide/svelte/icons/search";
  import UserPlus from "@lucide/svelte/icons/user-plus";

  const FILTERS: PeopleFilter[] = ["all", "ruled", "manual", "hidden"];

  let query = $state("");
  let filter = $state<PeopleFilter>("all");
  /** An address of the person under the cursor; it stays theirs when the primary one changes. */
  let cursor = $state("");
  let marked = $state<Set<string>>(new Set());
  let adding = $state(false);
  let draft = $state("");
  let problem = $state<string | null>(null);

  let listEl = $state<HTMLDivElement | null>(null);
  let paneEl = $state<HTMLDivElement | null>(null);
  let searchEl = $state<HTMLInputElement | null>(null);

  peopleBook.load();

  const shown = $derived(filterPeople(peopleBook.list.filter((p) => matchPerson(p, query)), filter));
  const current = $derived(peopleBook.find(cursor) ?? null);
  const at = $derived(current ? shown.findIndex((p) => personKey(p) === personKey(current)) : -1);
  // The suggestion stands only when both people are in the list as it is filtered now.
  const suggested = $derived.by(() => {
    const keys = new Set(shown.map(personKey));
    return peopleBook.duplicates.find((d) => keys.has(personKey(d.a)) && keys.has(personKey(d.b))) ?? null;
  });
  const markedPeople = $derived(shown.filter((p) => marked.has(personKey(p))));

  // Where the book was asked to open: a person and a filter, once; a book already open turns to it.
  $effect(() => {
    void app.peopleTurn;
    untrack(() => {
      const want = app.peopleFocus;
      app.peopleFocus = null;
      if (want?.filter) filter = want.filter;
      if (want?.email) {
        query = "";
        cursor = want.email;
      }
    });
  });

  // The cursor stays on a person the list shows; otherwise it goes to the first.
  $effect(() => {
    if (!shown.length) return;
    if (current && at >= 0) return;
    cursor = shown[0].email;
  });

  // Marks of people who are no longer in the list go.
  $effect(() => {
    const keys = new Set(shown.map(personKey));
    untrack(() => {
      if ([...marked].some((k) => !keys.has(k))) marked = new Set([...marked].filter((k) => keys.has(k)));
    });
  });

  // A merge done gives the focus back to the list, from the dialog and from the choice of the second person.
  $effect(() => {
    peopleOps.done = () => listEl?.focus();
    return () => (peopleOps.done = null);
  });

  // «/» in the main window reaches the search of the book while it is shown.
  $effect(() => {
    app.focusPeople = () => searchEl?.focus();
    return () => (app.focusPeople = () => {});
  });

  // The list takes the focus when the book opens, unless something in it already has it.
  $effect(() => {
    void tick().then(() => {
      if (!document.activeElement || document.activeElement === document.body) listEl?.focus({ preventScroll: true });
    });
  });

  $effect(() => {
    if (current) listEl?.querySelector(`[data-key="${CSS.escape(personKey(current))}"]`)?.scrollIntoView?.({ block: "nearest" });
  });

  function select(p: Person) {
    cursor = p.email;
  }

  function move(delta: number, to?: number) {
    if (!shown.length) return;
    const i = to ?? Math.max(0, Math.min(shown.length - 1, (at < 0 ? 0 : at) + delta));
    select(shown[i]);
  }

  function toggleMark(p: Person) {
    const key = personKey(p);
    const next = new Set(marked);
    if (!next.delete(key)) next.add(key);
    marked = next;
  }

  /** Follows the person that came of a merge or a split. */
  function follow(p: Person) {
    marked = new Set();
    cursor = p.email;
  }

  function mergeMarked() {
    if (markedPeople.length >= 2) peopleOps.merge(markedPeople, follow);
    else if (suggested) peopleOps.merge([suggested.a, suggested.b], follow);
    else if (current) peopleOps.pick(current);
  }

  async function notSame() {
    if (suggested) await peopleOps.refuse(suggested.a, suggested.b);
  }

  function intoCard() {
    (paneEl?.querySelector<HTMLElement>("[data-r='all']") ?? paneEl?.querySelector<HTMLElement>("[data-r='name']"))?.focus();
  }

  /** What a key does in the list; none for the keys that are not the list's. */
  function listAction(e: KeyboardEvent): (() => void) | null {
    const key = pressName(e);
    if (e.key === "ArrowDown") return () => move(1);
    if (e.key === "ArrowUp") return () => move(-1);
    if (e.key === "Home") return () => move(0, 0);
    if (e.key === "End") return () => move(0, shown.length - 1);
    if (e.key === " " && current) return () => toggleMark(current);
    if (e.key === "Enter" && current) return intoCard;
    if (key === "m") return mergeMarked;
    if (key === "n") return () => void notSame();
    if (key === "/") return () => searchEl?.focus();
    return null;
  }

  function onListKey(e: KeyboardEvent) {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const act = listAction(e);
    if (!act) return;
    e.preventDefault();
    e.stopPropagation();
    act();
  }

  function onSearchKey(e: KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      if (query) query = "";
      else listEl?.focus();
    } else if (e.key === "ArrowDown" || e.key === "Enter") {
      e.preventDefault();
      e.stopPropagation();
      listEl?.focus();
    }
  }

  function onPaneKey(e: KeyboardEvent) {
    if (e.key !== "Escape" || e.defaultPrevented) return;
    e.preventDefault();
    e.stopPropagation();
    listEl?.focus();
  }

  // ---- A person added by hand ----

  async function startAdd() {
    adding = true;
    problem = null;
    draft = "";
    await tick();
    document.getElementById("people-new")?.focus();
  }

  async function add() {
    const parsed = parseAddr(draft);
    if (!parsed) {
      problem = t("people.notAddress");
      return;
    }
    const known = peopleBook.find(parsed.email);
    try {
      if (known) {
        follow(known);
      } else {
        const fresh = { ...blankPerson(parsed.email), manual: true, name: parsed.name ?? "" };
        follow(await peopleBook.save(fresh));
      }
      adding = false;
      query = "";
      filter = "all";
      await tick();
      listEl?.focus();
    } catch (e) {
      app.fail(e);
    }
  }

  function onAddKey(e: KeyboardEvent) {
    e.stopPropagation();
    if (e.key === "Escape") {
      e.preventDefault();
      adding = false;
      listEl?.focus();
    } else if (e.key === "Enter") {
      e.preventDefault();
      void add();
    }
  }

  function allMail(p: Person) {
    void app.setView({ kind: "search", text: allMailQuery(p) });
  }
</script>

<div class="people">
  <div class="pl">
    <div class="pl-top">
      <div class="inp">
        <Search size={14} />
        <input
          type="search"
          bind:this={searchEl}
          bind:value={query}
          onkeydown={onSearchKey}
          placeholder={t("people.search")}
          aria-label={t("people.search")}
        />
      </div>
      <div class="chips">
        {#each FILTERS as f (f)}
          <button class="fchip" class:on={filter === f} aria-pressed={filter === f} onclick={() => (filter = f)}>{t(`people.filter.${f}`)}</button>
        {/each}
      </div>
    </div>

    {#if markedPeople.length >= 2}
      <div class="banner">
        <div>{t("people.marked", { n: markedPeople.length })}</div>
        <div class="ba"><button class="btn small" onclick={mergeMarked}>{t("people.mergeThem")}</button></div>
      </div>
    {:else if suggested}
      <div class="banner">
        <div>{t("people.maybeSame", { name: `${suggested.a.name || suggested.a.email} · ${suggested.b.name || suggested.b.email}` })}</div>
        <div class="muted small">{suggested.a.email} · {suggested.b.email} — {suggested.why === "name" ? t("people.why.name") : t("people.why.address", { local: suggested.local })}</div>
        <div class="ba">
          <button class="btn small" onclick={mergeMarked}>{t("people.mergeThem")}</button>
          <button class="btn ghost small" onclick={notSame}>{t("people.notSame")}</button>
        </div>
      </div>
    {/if}

    <div
      class="pl-list"
      role="listbox"
      tabindex="0"
      aria-label={t("people.title")}
      aria-multiselectable="true"
      aria-activedescendant={at >= 0 ? `person-${at}` : undefined}
      bind:this={listEl}
      onkeydown={onListKey}
    >
      {#each shown as p, i (personKey(p))}
        {@const on = i === at}
        {@const flagged = marked.has(personKey(p))}
        <!-- The keys of the row are the list's own (onListKey): the row is only a target for the pointer. -->
        <!-- svelte-ignore a11y_click_events_have_key_events -->
        <div
          class="pr"
          class:on
          class:flagged
          role="option"
          id={`person-${i}`}
          data-key={personKey(p)}
          aria-selected={on}
          tabindex="-1"
          onclick={() => (select(p), listEl?.focus())}
        >
          <span class="mark" aria-hidden="true">{flagged ? "✓" : ""}</span>
          <span class="av" style:background={avatarColor(p.email)}>{initials({ name: p.name, email: p.email })}</span>
          <span class="who">
            <span class="nm">{p.name || p.email}</span>
            <span class="em">{p.email}{p.emails.length > 1 ? ` +${p.emails.length - 1}` : ""}</span>
          </span>
          <span class="meta">
            {#if p.send_format}<span class="cmark">{formatMark(p.send_format)}</span>{/if}
            {#if p.hidden}<span class="muted small">{t("people.hidden")}</span>{:else if p.manual}<span class="muted small">{t("people.manual")}</span>{/if}
            {#if p.uses}<span class="muted small">{p.uses}</span>{/if}
          </span>
        </div>
      {/each}
      {#if !shown.length}
        <p class="empty muted">{peopleBook.list.length ? t("people.noneFound") : t("people.empty")}</p>
      {/if}
    </div>

    {#if adding}
      <div class="newp">
        <input
          id="people-new"
          class="input"
          bind:value={draft}
          onkeydown={onAddKey}
          onblur={() => !draft.trim() && (adding = false)}
          placeholder={t("people.addressPlaceholder")}
          aria-label={t("people.addPerson")}
          spellcheck="false"
          autocomplete="off"
        />
        {#if problem}<p class="problem" role="alert">{problem}</p>{/if}
      </div>
    {:else}
      <button class="btn ghost add" onclick={startAdd}><UserPlus size={14} /> {t("people.add")}</button>
    {/if}
  </div>

  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="pd" bind:this={paneEl} onkeydown={onPaneKey}>
    {#if current}
      {#key cursor}
        <PersonCard
          email={current.email}
          name={current.name}
          inBook
          onAllMail={() => allMail(current)}
          onSplit={(origin) => (cursor = origin.email)}
          onGone={() => {
            cursor = "";
            listEl?.focus();
          }}
        />
      {/key}
    {:else}
      <p class="empty muted">{shown.length ? t("people.pick") : ""}</p>
    {/if}
  </div>
</div>

<style>
  .people {
    display: flex;
    gap: 20px;
    align-items: stretch;
    min-height: 0;
    height: 100%;
    padding: 14px 20px;
    box-sizing: border-box;
  }

  .pl {
    flex: none;
    width: 340px;
    display: flex;
    flex-direction: column;
    min-height: 0;
  }

  .pl-top {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding-bottom: 8px;
  }

  .inp {
    display: flex;
    align-items: center;
    gap: 7px;
    height: 30px;
    padding: 0 9px;
    border: 1px solid var(--line);
    border-radius: 6px;
    background: var(--paper);
    color: var(--muted);
  }

  .inp input {
    flex: 1;
    min-width: 0;
    border: none;
    background: none;
    color: var(--ink);
    font: inherit;
    font-size: 13px;
    outline: none;
  }

  .inp input::-webkit-search-cancel-button,
  .inp input::-webkit-search-decoration {
    appearance: none;
  }

  .chips {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }

  .fchip {
    font-size: 12px;
    padding: 2px 9px;
    border-radius: 12px;
    border: 1px solid var(--line);
    background: none;
    color: var(--muted);
  }

  .fchip.on {
    background: var(--selected, var(--hover));
    color: var(--ink);
    border-color: transparent;
    font-weight: 600;
  }

  .banner {
    margin-bottom: 8px;
    padding: 7px 9px;
    border-radius: 6px;
    background: var(--selected, var(--hover));
    font-size: 12.5px;
    line-height: 1.4;
  }

  .ba {
    display: flex;
    gap: 6px;
    margin-top: 6px;
  }

  .pl-list {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    border-radius: 6px;
    outline: none;
  }

  .pl-list:focus-visible {
    box-shadow: 0 0 0 1.5px var(--accent);
  }

  .pr {
    display: flex;
    gap: 10px;
    align-items: center;
    width: 100%;
    padding: 6px 10px 6px 4px;
    border-radius: 6px;
    background: none;
    color: inherit;
    text-align: left;
    cursor: default;
  }

  .pr.on {
    background: var(--selected, var(--hover));
  }

  .mark {
    flex: none;
    width: 14px;
    text-align: center;
    color: var(--accent);
    font-weight: 700;
    font-size: 12px;
  }

  .av {
    flex: none;
    width: 28px;
    height: 28px;
    border-radius: 50%;
    color: #fff;
    font-size: 11px;
    font-weight: 700;
    display: inline-flex;
    align-items: center;
    justify-content: center;
  }

  .who {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
  }

  .nm,
  .em {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .nm {
    font-weight: 600;
  }

  .em {
    font-size: 12px;
    color: var(--muted);
  }

  .meta {
    flex: none;
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    gap: 3px;
  }

  .cmark {
    font: 600 9.5px/14px inherit;
    letter-spacing: 0.03em;
    padding: 0 4px;
    border-radius: 3px;
    background: var(--selected, var(--hover));
    color: var(--ink);
  }

  .add {
    margin-top: 8px;
    justify-content: center;
  }

  .newp {
    margin-top: 8px;
  }

  .input {
    width: 100%;
    border: 1px solid var(--accent);
    border-radius: 6px;
    padding: 6px 9px;
    background: var(--paper);
    color: var(--ink);
    font: inherit;
    font-size: 13.5px;
    box-sizing: border-box;
  }

  .problem {
    margin: 4px 2px 0;
    color: var(--accent);
    font-size: 12px;
  }

  .pd {
    flex: 1;
    min-width: 0;
    overflow-y: auto;
  }

  .empty {
    padding: 14px 4px;
  }

  .small {
    font-size: 11px;
  }
</style>

<script lang="ts">
  // The card of a person (#66, #104): what the app knows about the sender of a letter, opened by
  // a click on their name or by the key of the open letter, and the same card in the address book
  // of the main window. The name and the note are written in it (Enter or F2 opens the line,
  // Enter saves, Esc leaves it), a person has several addresses — one primary, others added,
  // made primary or let go as a person of their own — and the rules of #44 (the format to write
  // in, the form to show their letters) and hiding from completion are set in rows that turn on
  // Enter, Space or the arrows. A change is saved as it is made. The first button stands in
  // focus in a popover and runs the search a click on a name used to run. An address without
  // a record gets the same card: changing anything in it makes the record.
  import { t, tn } from "../../lib/i18n.svelte";
  import { app } from "../../lib/store.svelte";
  import { api } from "../../lib/api";
  import { tick } from "svelte";
  import { avatarColor, initials, listDate, parseAddr } from "../../lib/format";
  import { pressName } from "../../lib/keymap";
  import { allMailQuery, blankPerson, type Person } from "../../lib/people";
  import { duplicateIn } from "../../lib/peopleMerge";
  import { peopleBook } from "../../lib/peopleBook.svelte";
  import { peopleOps } from "../../lib/peopleOps.svelte";
  import type { BodyFormat, MessageRow, ViewRule } from "../../lib/types";
  import Trash2 from "@lucide/svelte/icons/trash-2";
  import EyeOff from "@lucide/svelte/icons/eye-off";
  import Check from "@lucide/svelte/icons/check";

  let {
    email,
    name,
    onAllMail,
    onClose,
    short = false,
    inBook = false,
    onGone,
    onSplit,
  }: {
    email: string;
    name: string;
    onAllMail: () => void;
    onClose?: () => void;
    /** The short card of the compose window (frame 13): no recent letters, no «Write». */
    short?: boolean;
    /** The card of the address book: no focus grab on «All mail», and a person added by hand can be removed. */
    inBook?: boolean;
    /** The person left the book (removed): the book picks another. */
    onGone?: () => void;
    /** An address left the person as a person of its own: the book stays with the one it left. */
    onSplit?: (origin: Person) => void;
  } = $props();

  let recent = $state<MessageRow[]>([]);
  let root = $state<HTMLDivElement | null>(null);
  /** The first button stands in focus, as the frame 12А asks: Enter runs «All mail». The
   *  focus waits a frame: the popover is not focusable until its place is set. */
  let allMail = $state<HTMLButtonElement | null>(null);
  $effect(() => {
    const el = allMail;
    if (!el || inBook) return;
    const id = requestAnimationFrame(() => el.focus({ preventScroll: true }));
    return () => cancelAnimationFrame(id);
  });

  peopleBook.load();

  const person = $derived(peopleBook.find(email));
  const shownName = $derived(person?.name || name || email);
  const addresses = $derived(person?.emails ?? [{ email, primary: true, uses: 0, name: "" }]);
  const uses = $derived(person?.uses ?? 0);
  const maybe = $derived(person && !short ? duplicateIn(peopleBook.duplicates, person) : null);

  const SEND: { value: BodyFormat | ""; label: string }[] = [
    { value: "", label: t("people.asUsual") },
    { value: "html", label: t("format.html") },
    { value: "markdown", label: t("format.markdown") },
    { value: "plain", label: t("format.plain") },
  ];
  const VIEW: { value: ViewRule; label: string }[] = [
    { value: "", label: t("people.asUsual") },
    { value: "html", label: t("letterView.html") },
    { value: "markdown", label: t("letterView.markdown") },
    { value: "text", label: t("letterView.text") },
  ];
  const labelOf = <T extends string>(list: { value: T; label: string }[], v: T) => list.find((o) => o.value === v)?.label ?? "";

  // The latest letters of this person, from any of their addresses; read again when the
  // addresses change (a merge, an address added). The short card does not read them.
  const mailQuery = $derived(allMailQuery(person ?? blankPerson(email)));
  $effect(() => {
    if (short) return;
    const query = mailQuery;
    let current = true;
    api
      .search(query)
      .then((rows) => current && (recent = rows.slice(0, 4)))
      .catch(() => current && (recent = []));
    return () => (current = false);
  });

  /** A change in the card is a record: the one kept, or a new one for the address. */
  async function setRule(patch: Partial<Person>) {
    const base = person ?? blankPerson(email);
    try {
      await peopleBook.save({ ...base, ...patch });
    } catch (e) {
      app.fail(e);
    }
  }

  function cycle<T extends string>(list: { value: T }[], now: T, dir: number): T {
    const at = Math.max(0, list.findIndex((o) => o.value === now));
    return list[(at + dir + list.length) % list.length].value;
  }

  function write() {
    app.openMailto(`mailto:${email}`);
    onClose?.();
  }

  /** The short card of the compose window copies the address instead of writing to it. */
  async function copy() {
    try {
      await navigator.clipboard.writeText(email);
      app.toast(t("person.copied"));
    } catch {
      /* the clipboard is closed to the page: nothing to say */
    }
    onClose?.();
  }

  // ---- The lines written in the card: the name, the note, a new address ----

  type Line = "name" | "note" | "add";
  let editing = $state<Line | null>(null);
  let draft = $state("");
  /** What stands in the way of a new address: a word, or the person who already has it. */
  let problem = $state<string | null>(null);
  let taken = $state<Person | null>(null);

  /** The row with this mark, to give the focus back to after a line is closed. */
  const row = (r: string) => root?.querySelector<HTMLElement>(`[data-r="${CSS.escape(r)}"]`) ?? null;

  function begin(line: Line) {
    problem = null;
    taken = null;
    draft = line === "name" ? (person?.name || name) : line === "note" ? (person?.note ?? "") : "";
    editing = line;
  }

  function focusIn(node: HTMLElement) {
    node.focus();
    if (node instanceof HTMLInputElement) node.select();
  }

  /** Closes the line and gives the focus back to its row. */
  async function leave(mark: string) {
    editing = null;
    await tick();
    row(mark)?.focus();
  }

  async function commit() {
    const line = editing;
    if (!line) return;
    const text = draft;
    if (line === "name") {
      editing = null;
      if (text.trim() !== shownName) await setRule({ name: text.trim() });
      await tick();
      row("name")?.focus();
    } else if (line === "note") {
      editing = null;
      if (text.trim() !== (person?.note ?? "").trim()) await setRule({ note: text.replace(/\s+$/, "") });
      await tick();
      row("note")?.focus();
    } else if (!text.trim()) {
      await leave("add");
    } else {
      await addAddress(text);
    }
  }

  function cancel() {
    const line = editing;
    if (line) void leave(line);
  }

  function onEdit(e: KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      cancel();
    } else if (e.key === "Enter" && !(editing === "note" && e.shiftKey)) {
      e.preventDefault();
      e.stopPropagation();
      void commit();
    }
  }

  // ---- The addresses ----

  async function addAddress(text: string) {
    const parsed = parseAddr(text);
    if (!parsed) {
      problem = t("people.notAddress");
      await leave("add");
      return;
    }
    const owner = peopleBook.find(parsed.email);
    if (owner && person && owner !== person && owner.id !== person.id) return clash(owner);
    if (owner && (owner === person || (person && owner.id === person.id && owner.id))) {
      problem = t("people.addressHere");
      await leave("add");
      return;
    }
    try {
      const added = await peopleBook.addAddress(person ?? blankPerson(email), parsed.email);
      if (added.owner) return clash(added.owner);
      editing = null;
      await tick();
      row(`a:${parsed.email.toLowerCase()}`)?.focus();
    } catch (e) {
      app.fail(e);
      editing = null;
    }
  }

  /** The address is another person's: a merge is offered, not a refusal (the decision 2.5). */
  async function clash(owner: Person) {
    editing = null;
    taken = owner;
    await tick();
    row("clash")?.focus();
  }

  function mergeWithTaken() {
    const other = taken;
    taken = null;
    if (!other || !person) return;
    joinWith(other);
  }

  async function makePrimary(address: string) {
    try {
      await peopleBook.setPrimary(address);
      await tick();
      row(`a:${address.toLowerCase()}`)?.focus();
    } catch (e) {
      app.fail(e);
    }
  }

  async function unlink(address: string) {
    if (!person || person.emails.length < 2) return;
    await peopleOps.split(person, address, (s) => (onClose?.(), onSplit?.(s.origin)));
  }

  /** Joins this person with another: the dialog is always shown (the decision 3.7). */
  function joinWith(other: Person) {
    if (!person) return;
    onClose?.();
    peopleOps.merge([person, other]);
  }

  function pickOther() {
    if (!person) return;
    onClose?.();
    peopleOps.pick(person);
  }

  async function notSame() {
    if (!person || !maybe) return;
    await peopleOps.refuse(person, maybe.other);
  }

  async function removePerson() {
    if (!person) return;
    // With an address in the correspondence the person stays and only the mark comes off: the question says which.
    const kept = person.emails.some((a) => a.uses > 0);
    const who = person.name || person.email;
    const { answer } = await app.choose({
      title: t(kept ? "people.unmarkTitle" : "people.deleteTitle", { name: who }),
      text: t(kept ? "people.unmarkText" : "people.deleteText"),
      okLabel: t(kept ? "people.unmark" : "people.delete"),
      cancelLabel: t("cancel"),
    });
    if (!answer) return;
    try {
      const done = await peopleBook.forget(person.email);
      if (!done.removed && !done.unmarked) return;
      app.offerUndo(t(done.removed ? "people.removed" : "people.unmarked", { name: who }), () => peopleBook.restore(done.undo));
      if (done.removed) onGone?.();
    } catch (e) {
      app.fail(e);
    }
  }

  // ---- Keys of the card ----

  /** The rows of the card, in the order of the arrows. */
  const rows = () => (root ? [...root.querySelectorAll<HTMLElement>("button[role='menuitem']:not(:disabled), button[role='menuitemcheckbox']")] : []);

  /** The arrows between the rows, F2 on a line, and ←/→ on the two rules. True when the key was one of these. */
  function rowKey(e: KeyboardEvent, target: HTMLElement, current: string): boolean {
    // The card is a menu in a letter and a pane in the book; the popover moves the arrows itself.
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      const list = rows();
      const at = list.indexOf(target.closest<HTMLElement>("[data-r]") ?? target);
      if (list.length && at >= 0) list[(at + (e.key === "ArrowDown" ? 1 : list.length - 1)) % list.length].focus();
      return at >= 0;
    }
    if (e.key === "F2" && (current === "name" || current === "note")) {
      begin(current);
      return true;
    }
    if ((e.key === "ArrowLeft" || e.key === "ArrowRight") && (current === "fmt" || current === "view")) {
      const dir = e.key === "ArrowRight" ? 1 : -1;
      if (current === "fmt") void setRule({ send_format: cycle(SEND, person?.send_format ?? "", dir) });
      else void setRule({ view: cycle(VIEW, person?.view ?? "", dir) });
      return true;
    }
    return false;
  }

  /** The letters of the card: its own while it has the focus, the letter's keys are not. */
  function letterKey(key: string | null, address: string): boolean {
    if (key === "a") begin("add");
    else if (key === "p") {
      if (address && !addresses.find((a) => a.email === address)?.primary) void makePrimary(address);
    } else if (key === "u") {
      if (address) void unlink(address);
    } else if (key === "m") {
      if (maybe) joinWith(maybe.other);
      else pickOther();
    } else if (key === "n") void notSame();
    else if (key === "Escape" && taken) {
      taken = null;
      void tick().then(() => row("add")?.focus());
    } else return false;
    return true;
  }

  function onKey(e: KeyboardEvent) {
    const target = e.target as HTMLElement;
    if (target.closest("[data-own]") || e.ctrlKey || e.metaKey || e.altKey) return;
    const current = target.closest<HTMLElement>("[data-r]")?.dataset.r ?? "";
    const address = target.closest<HTMLElement>("[data-address]")?.dataset.address ?? "";
    if (rowKey(e, target, current) || letterKey(pressName(e), address)) {
      e.preventDefault();
      e.stopPropagation();
    }
  }
</script>

<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<div class="pcard" class:book={inBook} bind:this={root} onkeydown={onKey} role="group" aria-label={shownName}>
  <div class="pc-head">
    <span class="av" style:background={avatarColor(email)}>{initials({ name: shownName, email })}</span>
    <div class="who">
      {#if editing === "name"}
        <input class="edit" data-own use:focusIn bind:value={draft} onkeydown={onEdit} onblur={commit} aria-label={t("people.name")} placeholder={t("people.namePlaceholder")} />
      {:else}
        <button class="nm line" role="menuitem" data-r="name" onclick={() => begin("name")} title={t("people.rename")}>{shownName}</button>
      {/if}
      <div class="nt">{[shownName !== email ? email : "", uses ? tn("people.letters", uses) : ""].filter(Boolean).join(" · ")}</div>
    </div>
  </div>

  {#if maybe}
    <div class="pc-dup">
      <div>{t("people.maybeSame", { name: maybe.other.name || maybe.other.email })} <span class="muted">({maybe.other.email}, {maybe.pair.why === "name" ? t("people.why.name") : t("people.why.address", { local: maybe.pair.local })})</span></div>
      <div class="dup-acts">
        <button class="btn small" role="menuitem" data-r="dup" onclick={() => joinWith(maybe.other)}>{t("people.mergeThem")}</button>
        <button class="btn ghost small" role="menuitem" data-r="notsame" onclick={notSame}>{t("people.notSame")}</button>
      </div>
    </div>
  {/if}

  <div class="pc-acts">
    <button class="btn primary" role="menuitem" data-r="all" bind:this={allMail} onclick={onAllMail}>{t("person.allMail")}</button>
    {#if short}
      <button class="btn" role="menuitem" data-r="write" onclick={copy}>{t("person.copy")}</button>
    {:else}
      <button class="btn" role="menuitem" data-r="write" onclick={write}>{t("person.write")}</button>
    {/if}
  </div>

  <div class="pc-sec">
    <h5>{t("people.note")}</h5>
    {#if editing === "note"}
      <textarea class="edit" data-own use:focusIn bind:value={draft} onkeydown={onEdit} onblur={commit} aria-label={t("people.note")} placeholder={t("people.notePlaceholder")}></textarea>
    {:else}
      <button class="line note" class:empty={!person?.note} role="menuitem" data-r="note" onclick={() => begin("note")}>{person?.note || t("people.noteEmpty")}</button>
    {/if}
  </div>

  <div class="pc-sec">
    <h5>{t("people.addresses")}</h5>
    {#each addresses as a (a.email.toLowerCase())}
      <div class="addr" data-address={a.email}>
        <button class="line" role="menuitem" data-r={`a:${a.email.toLowerCase()}`}>
          <span class="radio" class:on={a.primary} aria-hidden="true"></span>
          <span class="em">{a.email}</span>
          <span class="m">{a.primary ? t("people.primary") : a.uses ? tn("people.letters", a.uses) : ""}</span>
        </button>
        {#if !a.primary}
          <button class="mini" onclick={() => makePrimary(a.email)} title={t("people.makePrimary")} aria-label={t("people.makePrimary")}><Check size={13} /></button>
        {/if}
        {#if addresses.length > 1}
          <button class="mini" onclick={() => unlink(a.email)} title={t("people.unlink")} aria-label={t("people.unlink")}>⤴</button>
        {/if}
      </div>
    {/each}
    {#if editing === "add"}
      <input class="edit" data-own use:focusIn bind:value={draft} onkeydown={onEdit} onblur={commit} aria-label={t("people.newAddress")} placeholder={t("people.addressPlaceholder")} spellcheck="false" autocomplete="off" />
    {:else}
      <button class="line add" role="menuitem" data-r="add" onclick={() => begin("add")}>+ {t("people.addAddress")}</button>
    {/if}
    {#if problem}<p class="problem" role="alert">{problem}</p>{/if}
    {#if taken}
      <div class="pc-dup" role="alert">
        <div>{t("people.addressTaken", { name: taken.name || taken.email })}</div>
        <div class="dup-acts">
          <button class="btn small" role="menuitem" data-r="clash" onclick={mergeWithTaken}>{t("people.mergeThem")}</button>
          <button class="btn ghost small" role="menuitem" data-r="clash-no" onclick={() => (taken = null)}>{t("cancel")}</button>
        </div>
      </div>
    {/if}
  </div>

  <div class="pc-sec">
    <button class="line rule" role="menuitem" data-r="fmt" onclick={() => setRule({ send_format: cycle(SEND, person?.send_format ?? "", 1) })}>
      <span>{t("people.sendFormat")}</span><span class="v">{labelOf(SEND, person?.send_format ?? "")}</span>
    </button>
    <button class="line rule" role="menuitem" data-r="view" onclick={() => setRule({ view: cycle(VIEW, person?.view ?? "", 1) })}>
      <span>{t("people.view")}</span><span class="v">{labelOf(VIEW, person?.view ?? "")}</span>
    </button>
    <button class="line hide" role="menuitemcheckbox" data-r="hide" aria-checked={!!person?.hidden} onclick={() => setRule({ hidden: !person?.hidden })}>
      <span class="box" class:on={person?.hidden}>{#if person?.hidden}<Check size={12} />{/if}</span>
      <span><EyeOff size={13} /> {t("people.hide")}</span>
    </button>
    {#if person?.via}<p class="hint">{t("people.viaHint")}</p>{/if}
  </div>

  {#if !short}
    <div class="pc-sec">
      <h5>{t("person.recent")}</h5>
      {#each recent as m (m.id)}
        <button class="mail" role="menuitem" data-r={`m:${m.id}`} onclick={() => (app.open(m.id), onClose?.())}>
          <span class="s">{m.subject || t("noSubject")}</span>
          <span class="d">{listDate(m.date)}</span>
        </button>
      {/each}
      {#if !recent.length}<p class="muted small">{t("person.none")}</p>{/if}
    </div>

    {#if inBook && person?.manual}
      <div class="pc-foot">
        <button class="link danger" role="menuitem" data-r="delete" onclick={removePerson}><Trash2 size={13} /> {t("people.delete")}</button>
      </div>
    {/if}
  {/if}
</div>

<style>
  .pcard {
    width: 340px;
    max-width: calc(100vw - 24px);
    font-size: 13px;
  }

  .pcard.book {
    width: auto;
    max-width: 460px;
  }

  .pc-head {
    display: flex;
    gap: 12px;
    align-items: center;
    padding: 8px 10px 6px;
  }

  .av {
    flex: none;
    width: 34px;
    height: 34px;
    border-radius: 50%;
    color: #fff;
    font-weight: 700;
    display: inline-flex;
    align-items: center;
    justify-content: center;
  }

  .who {
    min-width: 0;
    flex: 1;
  }

  .nm {
    font-weight: 700;
    font-size: 15px;
  }

  .nt {
    font-size: 12px;
    color: var(--muted);
    padding: 0 6px;
  }

  /* A row of the card: a button that looks like text and shows where the focus is. */
  .line {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    padding: 3px 6px;
    border: none;
    border-radius: 5px;
    background: none;
    color: inherit;
    font: inherit;
    text-align: left;
  }

  .line:hover,
  .line:focus-visible,
  .mini:focus-visible {
    background: var(--hover);
    outline: none;
  }

  .line:focus-visible {
    box-shadow: inset 0 0 0 1.5px var(--accent);
  }

  .nm.line {
    padding: 1px 6px;
  }

  .edit {
    width: 100%;
    border: 1px solid var(--accent);
    border-radius: 6px;
    padding: 4px 8px;
    background: var(--paper);
    color: var(--ink);
    font: inherit;
    font-size: 13.5px;
  }

  textarea.edit {
    min-height: 58px;
    line-height: 1.45;
    resize: vertical;
  }

  .pc-acts {
    display: flex;
    gap: 6px;
    padding: 0 10px 10px;
  }

  .pc-dup {
    margin: 0 10px 8px;
    padding: 7px 9px;
    border-radius: 6px;
    background: var(--selected, var(--hover));
    font-size: 12.5px;
    line-height: 1.4;
  }

  .dup-acts {
    display: flex;
    gap: 6px;
    margin-top: 6px;
  }

  .pc-sec {
    border-top: 1px solid var(--line);
    padding: 8px 10px;
  }

  .pc-sec h5 {
    margin: 0 0 4px;
    font-size: 11px;
    font-weight: 600;
    color: var(--muted);
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }

  .note {
    white-space: pre-wrap;
    align-items: flex-start;
  }

  .empty,
  .add {
    color: var(--muted);
  }

  .add {
    color: var(--link);
  }

  .addr {
    display: flex;
    align-items: center;
    gap: 2px;
  }

  .addr .line {
    flex: 1;
    min-width: 0;
  }

  .em {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .m {
    margin-left: auto;
    font-size: 11.5px;
    color: var(--muted);
    white-space: nowrap;
  }

  .mini {
    flex: none;
    width: 22px;
    height: 22px;
    padding: 0;
    border: none;
    border-radius: 5px;
    background: none;
    color: var(--muted);
    font-size: 13px;
    opacity: 0;
  }

  .addr:hover .mini,
  .addr:focus-within .mini {
    opacity: 1;
  }

  .mini:hover {
    background: var(--hover);
    color: var(--ink);
  }

  .problem {
    margin: 4px 6px 0;
    color: var(--accent);
    font-size: 12px;
  }

  .radio {
    flex: none;
    width: 15px;
    height: 15px;
    border-radius: 50%;
    border: 1.5px solid var(--line);
  }

  .radio.on {
    border-color: var(--accent);
    background: var(--accent);
    box-shadow: inset 0 0 0 3px var(--paper);
  }

  .rule {
    justify-content: space-between;
  }

  .v {
    color: var(--muted);
  }

  .box {
    flex: none;
    width: 15px;
    height: 15px;
    border: 1.5px solid var(--line);
    border-radius: 4px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
  }

  .box.on {
    background: var(--accent);
    border-color: var(--accent);
    color: var(--accent-ink);
  }

  .hint {
    margin: 4px 6px 0;
    font-size: 12px;
    color: var(--muted);
    line-height: 1.45;
  }

  .mail {
    display: flex;
    gap: 8px;
    align-items: baseline;
    width: 100%;
    padding: 3px 6px;
    border: none;
    border-radius: 5px;
    background: none;
    color: inherit;
    text-align: left;
  }

  .mail:focus-visible {
    background: var(--hover);
    outline: none;
    box-shadow: inset 0 0 0 1.5px var(--accent);
  }

  .mail .s {
    flex: 1;
    min-width: 0;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .mail .d {
    flex: none;
    font-size: 11.5px;
    color: var(--muted);
    white-space: nowrap;
  }

  .mail:hover .s {
    text-decoration: underline;
  }

  .pc-foot {
    display: flex;
    justify-content: space-between;
    border-top: 1px solid var(--line);
    padding: 8px 10px;
  }

  .link {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    border: none;
    background: none;
    color: var(--link);
    padding: 0;
    font: inherit;
  }

  .link.danger {
    color: var(--accent);
  }

  .link:hover {
    text-decoration: underline;
  }

  .small {
    font-size: 12px;
  }
</style>

<script lang="ts">
  // The address book (#66): the page «People» of the settings window. The list on the left is
  // every address of the correspondence — and every one added by hand — with its own search
  // and the filters of frame 10; the editor on the right is the person of frame 11: name,
  // address, the format to write in, the form to show their letters, a note, and hiding from
  // address suggestions. A person's record is saved as it is changed, and the page draws no
  // «Save» of its own (its traits say it saves as it goes). One person is one address in 0.7.
  import { t, tn } from "../../lib/i18n.svelte";
  import { app } from "../../lib/store.svelte";
  import { api } from "../../lib/api";
  import { avatarColor, initials, parseAddr } from "../../lib/format";
  import { blankPerson, filterPeople, formatMark, matchPerson, type PeopleFilter, type Person } from "../../lib/people";
  import type { BodyFormat } from "../../lib/types";
  import Select from "../Select.svelte";
  import LayerMark from "./LayerMark.svelte";
  import Search from "@lucide/svelte/icons/search";
  import EyeOff from "@lucide/svelte/icons/eye-off";
  import UserPlus from "@lucide/svelte/icons/user-plus";
  import Trash2 from "@lucide/svelte/icons/trash-2";

  /** The address of a person not yet saved; it is not an address anyone could have. */
  const NEW = "\u0000new";

  let people = $state<Person[]>([]);
  let query = $state("");
  let filter = $state<PeopleFilter>("all");
  /** The address the editor is open on; empty shows the list's own invitation. */
  let selected = $state("");

  const shown = $derived(filterPeople(people.filter((p) => matchPerson(p, query)), filter));
  const person = $derived(people.find((p) => p.email === selected) ?? null);

  const SEND: { value: Person["send_format"]; label: string }[] = [
    { value: "", label: t("people.asUsual") },
    { value: "html", label: t("format.html") },
    { value: "markdown", label: t("format.markdown") },
    { value: "plain", label: t("format.plain") },
  ];
  const VIEW: { value: Person["view"]; label: string }[] = [
    { value: "", label: t("people.asUsual") },
    { value: "html", label: t("letterView.html") },
    { value: "markdown", label: t("letterView.markdown") },
    { value: "text", label: t("letterView.text") },
  ];

  async function load() {
    try {
      people = await api.people("");
    } catch (e) {
      app.fail(e);
    }
    // «Own at 2 people ›» on a general setting opens the page at that person (until the book of #104).
    const want = app.settingsPerson;
    app.settingsPerson = null;
    if (want && people.some((p) => p.email === want)) selected = want;
  }

  load();

  async function save(p: Person) {
    try {
      await api.personSave(p);
    } catch (e) {
      app.fail(e);
    }
  }

  /** A field changed by hand: the list shows it at once, and the record follows. A person
   *  without an address yet has no record to save: their fields are kept until it has one. */
  async function edit(patch: Partial<Person>) {
    if (!person) return;
    const next = { ...person, ...patch };
    people = people.map((p) => (p.email === person.email ? next : p));
    if (next.email === NEW) return;
    await save(next);
  }

  function addPerson() {
    const fresh = blankPerson(NEW);
    fresh.manual = true;
    people = [fresh, ...people];
    selected = NEW;
  }

  /** Gives a person added by hand their address; the record is saved only with one. */
  async function setAddress(value: string) {
    if (!person) return;
    const parsed = parseAddr(value);
    if (!parsed) return;
    const created = { ...person, email: parsed.email };
    people = people.map((p) => (p.email === person.email ? created : p));
    selected = parsed.email;
    await save(created);
  }

  async function forget() {
    if (!person) return;
    const { answer } = await app.choose({
      title: t("people.deleteTitle", { name: person.name || person.email }),
      text: t("people.deleteText"),
      okLabel: t("people.delete"),
      cancelLabel: t("cancel"),
    });
    if (!answer) return;
    try {
      await api.personForget(person.email);
      people = people.filter((p) => p.email !== person.email);
      selected = "";
    } catch (e) {
      app.fail(e);
    }
  }
</script>

<div class="people">
  <div class="pl">
    <div class="pl-top">
      <div class="inp">
        <Search size={14} />
        <input type="search" bind:value={query} placeholder={t("people.search")} aria-label={t("people.search")} />
      </div>
      <div class="chips">
        {#each (["all", "ruled", "manual", "hidden"] as const) as f (f)}
          <button class="fchip" class:on={filter === f} onclick={() => (filter = f)}>{t(`people.filter.${f}`)}</button>
        {/each}
      </div>
    </div>
    <div class="pl-list" role="listbox" aria-label={t("people.title")}>
      {#each shown as p (p.email)}
        <button class="pr" class:on={p.email === selected} role="option" aria-selected={p.email === selected} onclick={() => (selected = p.email)}>
          <span class="av" style:background={avatarColor(p.email === NEW ? "?" : p.email)}>{initials({ name: p.name, email: p.email === NEW ? "?" : p.email })}</span>
          <span class="who">
            <span class="nm">{p.name || (p.email === NEW ? t("people.newPerson") : p.email)}</span>
            <span class="em">{p.email === NEW ? "" : p.email}</span>
          </span>
          <span class="meta">
            {#if p.send_format}<span class="cmark">{formatMark(p.send_format)}</span>{/if}
            {#if p.hidden}<span class="muted small">{t("people.hidden")}</span>{:else if p.manual}<span class="muted small">{t("people.manual")}</span>{/if}
          </span>
        </button>
      {/each}
      {#if !shown.length}
        <p class="empty muted">{t("people.empty")}</p>
      {/if}
    </div>
    <button class="btn ghost add" onclick={addPerson}><UserPlus size={14} /> {t("people.add")}</button>
  </div>

  <div class="pd">
    {#if person}
      <div class="pd-head">
        <span class="nm">{person.name || (person.email === NEW ? t("people.newPerson") : person.email)}</span>
        {#if person.email !== NEW}<span class="nt">{tn("people.letters", person.uses)}</span>{/if}
        <span class="sp"></span>
        {#if person.manual && person.email !== NEW}
          <span class="acts"><button class="btn ghost small" onclick={forget}><Trash2 size={13} /> {t("people.delete")}</button></span>
        {/if}
      </div>

      <div class="field" data-settings="people-name">
        <label class="fl" for="person-name">{t("people.name")}</label>
        <input id="person-name" class="input" value={person.name} placeholder={t("people.namePlaceholder")} onchange={(e) => edit({ name: e.currentTarget.value })} />
      </div>
      <p class="hint">{t("people.nameNote")}</p>

      <div class="field" data-settings="people-addresses">
        <span class="fl">{t("people.addresses")}</span>
        <div>
          {#if person.email === NEW}
            <div class="addr">
              <span class="radio on" aria-hidden="true"></span>
              <div class="afield">
                <input class="input" placeholder={t("people.addressPlaceholder")} onchange={(e) => setAddress(e.currentTarget.value)} />
                <span class="m">{t("people.primary")}</span>
              </div>
            </div>
          {:else}
            <div class="addr">
              <span class="radio on" aria-hidden="true"></span>
              <div class="afield">
                <input class="input" value={person.email} readonly />
                <span class="m">{t("people.primary")}</span>
              </div>
            </div>
          {/if}
        </div>
      </div>

      <div class="field" data-settings="people-send">
        <span class="fl">{t("people.sendFormat")}</span>
        <div class="stackcol">
          <div class="withmark">
            <Select label={t("people.sendFormat")} value={person.send_format} onchange={(v) => edit({ send_format: v as BodyFormat | "" })} options={SEND} />
            <LayerMark own={!!person.send_format} word={t("settings.layerAsMailbox")} onreset={() => edit({ send_format: "" })} />
          </div>
        </div>
      </div>

      <div class="field" data-settings="people-view">
        <span class="fl">{t("people.view")}</span>
        <div class="stackcol">
          <div class="withmark">
            <Select label={t("people.view")} value={person.view} onchange={(v) => edit({ view: v as Person["view"] })} options={VIEW} />
            <LayerMark own={!!person.view} word={t("settings.layerAsMailbox")} onreset={() => edit({ view: "" })} />
          </div>
        </div>
      </div>

      <div class="field" data-settings="people-note">
        <label class="fl" for="person-note">{t("people.note")}</label>
        <textarea id="person-note" class="area" value={person.note} placeholder={t("people.notePlaceholder")} onchange={(e) => edit({ note: e.currentTarget.value })}></textarea>
      </div>

      <div class="field" data-settings="people-hide">
        <span class="fl"></span>
        <label class="option">
          <input type="checkbox" checked={person.hidden} onchange={(e) => edit({ hidden: e.currentTarget.checked })} />
          <span><EyeOff size={13} /> {t("people.hide")}</span>
        </label>
      </div>

      {#if person.via}
        <p class="hint origin">{t("people.viaHint")}</p>
      {/if}
    {:else}
      <p class="empty muted">{t("people.pick")}</p>
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
    padding-top: 6px;
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

  .pl-list {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
  }

  .pr {
    display: flex;
    gap: 10px;
    align-items: center;
    width: 100%;
    padding: 7px 10px;
    border: none;
    border-radius: 6px;
    background: none;
    color: inherit;
    text-align: left;
  }

  .pr.on {
    background: var(--selected, var(--hover));
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

  .pd {
    flex: 1;
    min-width: 0;
    overflow-y: auto;
    /* The card is a container: its labels move above their fields when it is narrow. */
    container: personcard / inline-size;
  }

  .pd-head {
    display: flex;
    flex-wrap: wrap;
    gap: 4px 12px;
    align-items: baseline;
    margin-bottom: 10px;
  }

  .pd-head .nm {
    font-size: 17px;
    font-weight: 700;
    /* A long name wraps rather than being cut. */
    white-space: normal;
    overflow: visible;
    text-overflow: clip;
  }

  .pd-head .nt {
    font-size: 12px;
    color: var(--muted);
  }

  .sp {
    flex: 1;
  }

  .acts {
    display: flex;
  }

  /* A narrow card: the delete button goes under the name instead of crowding it. */
  @container personcard (max-width: 520px) {
    .pd-head .sp {
      display: none;
    }

    .pd-head .acts {
      flex-basis: 100%;
    }
  }

  .field {
    display: grid;
    grid-template-columns: 150px minmax(0, 1fr);
    gap: 16px;
    padding: 6px 0;
  }

  .field .fl {
    padding-top: 7px;
    color: var(--muted);
  }

  /* A narrow card: the label goes above its field, so the field (an address) takes the
     whole width of the card instead of what the label leaves. */
  @container personcard (max-width: 520px) {
    .field {
      grid-template-columns: minmax(0, 1fr);
      gap: 4px;
      padding: 8px 0 6px;
    }

    .field .fl {
      padding-top: 0;
      font-size: 12px;
      font-weight: 600;
    }
  }

  .stackcol {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .addr {
    display: flex;
    align-items: flex-start;
    gap: 8px;
  }

  .afield {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 3px;
  }

  .addr .input {
    width: 100%;
    min-width: 0;
    height: 30px;
  }

  /* «primary» under the address, small: it never crowds the field. */
  .addr .m {
    font-size: 11px;
    color: var(--muted);
  }

  .radio {
    flex: none;
    width: 15px;
    height: 15px;
    margin-top: 8px;
    border-radius: 50%;
    border: 1.5px solid var(--line);
  }

  .radio.on {
    border-color: var(--accent);
    background: var(--accent);
    box-shadow: inset 0 0 0 3px var(--paper);
  }

  .input,
  .area {
    border: 1px solid var(--line);
    border-radius: 6px;
    padding: 6px 9px;
    background: var(--paper);
    color: var(--ink);
    font: inherit;
    font-size: 13.5px;
  }

  .area {
    min-height: 62px;
    line-height: 1.45;
    resize: vertical;
  }

  .option {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 0;
  }

  .hint {
    margin: 2px 0 0;
    font-size: 12px;
    color: var(--muted);
    line-height: 1.45;
  }

  .empty {
    padding: 14px 4px;
  }

  .small {
    font-size: 11px;
  }

  .stackcol :global(.select) {
    width: 100%;
  }

  .withmark {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
  }
</style>

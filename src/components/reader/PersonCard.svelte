<script lang="ts">
  // The card of a person (#66, frames 12А, 13): what the app knows about the sender of a
  // letter, opened by a click on their name. The first button «All mail» stands in focus and
  // runs the search a click on a name used to run; the rest sets the rules of #44 — the
  // format to write in and the form to show their letters — and writes to them. An address
  // without a record gets the same card: changing anything in it makes the record.
  import { t } from "../../lib/i18n.svelte";
  import { app } from "../../lib/store.svelte";
  import { api } from "../../lib/api";
  import { untrack } from "svelte";
  import { avatarColor, initials, listDate } from "../../lib/format";
  import { blankPerson, type Person } from "../../lib/people";
  import { peopleBook } from "../../lib/peopleBook.svelte";
  import type { BodyFormat, MessageRow } from "../../lib/types";
  import Select from "../Select.svelte";
  import Mail from "@lucide/svelte/icons/mail";

  let {
    email,
    name,
    onAllMail,
    onClose,
    short = false,
  }: {
    email: string;
    name: string;
    onAllMail: () => void;
    onClose?: () => void;
    /** The short card of the compose window (frame 13): no recent letters, no «Write». */
    short?: boolean;
  } = $props();

  let recent = $state<MessageRow[]>([]);

  peopleBook.load();

  const person = $derived(peopleBook.find(email));
  const shownName = $derived(person?.name || name || email);

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

  // The letters of this sender, read once when the card opens; the card is made anew for
  // another address, so the read does not follow the prop. The short card does not read them.
  untrack(() => {
    if (short) return;
    api
      .search(`from:${email}`)
      .then((rows) => (recent = rows.slice(0, 4)))
      .catch(() => (recent = []));
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
</script>

<div class="pcard">
  <div class="pc-head">
    <span class="av" style:background={avatarColor(email)}>{initials({ name, email })}</span>
    <div class="who">
      <div class="nm">{shownName}</div>
      {#if shownName !== email}<div class="nt">{email}</div>{/if}
    </div>
  </div>

  <div class="pc-acts">
    <button class="btn primary" role="menuitem" onclick={onAllMail}>{t("person.allMail")}</button>
    {#if short}
      <button class="btn" role="menuitem" onclick={copy}>{t("person.copy")}</button>
    {:else}
      <button class="btn" role="menuitem" onclick={write}>{t("person.write")}</button>
    {/if}
  </div>

  <div class="pc-sec">
    <h5>{t("people.addresses")}</h5>
    <div class="addr">
      <span class="radio on" aria-hidden="true"></span>
      <span class="em">{email}</span>
      <span class="m">{t("people.primary")}</span>
    </div>
  </div>

  <div class="pc-sec">
    <div class="row">
      <span>{t("people.sendFormat")}</span>
      <Select label={t("people.sendFormat")} value={person?.send_format ?? ""} onchange={(v) => setRule({ send_format: v as BodyFormat | "" })} options={SEND} />
    </div>
    <div class="row">
      <span>{t("people.view")}</span>
      <Select label={t("people.view")} value={person?.view ?? ""} onchange={(v) => setRule({ view: v as Person["view"] })} options={VIEW} />
    </div>
  </div>

  {#if !short}
    <div class="pc-sec">
      <h5>{t("person.recent")}</h5>
      {#each recent as m (m.id)}
        <button class="mail" onclick={() => (app.open(m.id), onClose?.())}>
          <span class="s">{m.subject || t("noSubject")}</span>
          <span class="d">{listDate(m.date)}</span>
        </button>
      {/each}
      {#if !recent.length}<p class="muted small">{t("person.none")}</p>{/if}
    </div>

    <div class="pc-foot">
      <button class="link" role="menuitem" onclick={write}><Mail size={13} /> {t("person.write")}</button>
    </div>
  {/if}
</div>

<style>
  .pcard {
    width: 340px;
    max-width: calc(100vw - 24px);
    font-size: 13px;
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

  .nm {
    font-weight: 700;
    font-size: 15px;
  }

  .nt {
    font-size: 12px;
    color: var(--muted);
  }

  .pc-acts {
    display: flex;
    gap: 6px;
    padding: 0 10px 10px;
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

  .addr {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 2px 0;
  }

  .addr .em {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .addr .m {
    margin-left: auto;
    font-size: 11.5px;
    color: var(--muted);
    white-space: nowrap;
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

  .row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    padding: 3px 0;
  }

  .row :global(.select) {
    width: 150px;
  }

  .mail {
    display: flex;
    gap: 8px;
    align-items: baseline;
    width: 100%;
    padding: 3px 0;
    border: none;
    background: none;
    color: inherit;
    text-align: left;
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

  .link:hover {
    text-decoration: underline;
  }

  .small {
    font-size: 12px;
  }
</style>

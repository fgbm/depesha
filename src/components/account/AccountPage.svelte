<script lang="ts">
  // A mailbox's page in the settings window: one page of sections under a table of contents
  // that stays in sight and marks the section being read. What does not reach the server is saved
  // as it is changed; the connection waits for the page's «Check and save».
  import { onMount, tick, untrack } from "svelte";
  import { t } from "../../lib/i18n.svelte";
  import { app } from "../../lib/store.svelte";
  import { rooms } from "../../lib/room.svelte";
  import { AccountForm } from "../../lib/accountForm.svelte";
  import { AccountAutosave, ownOf } from "../../lib/accountAutosave.svelte";
  import { currentSection } from "../../lib/toc";
  import type { AccountView } from "../../lib/types";
  import { sectionsFor } from "./sections";
  import CheckError from "./CheckError.svelte";

  let { account, onDone }: { account: AccountView; onDone: () => void } = $props();

  // The page is opened for one mailbox: the settings window opens a new one for another.
  // svelte-ignore state_referenced_locally
  const form = new AccountForm(account, () => onDone());
  // svelte-ignore state_referenced_locally
  const own = new AccountAutosave(form, account.id);
  const sections = $derived(sectionsFor(account));

  let scroller = $state<HTMLElement>();
  let current = $state(0);

  function track() {
    if (!scroller) return;
    const tops = [...scroller.querySelectorAll<HTMLElement>("section[data-section]")].map((s) => s.offsetTop);
    const atBottom = scroller.scrollTop > 0 && scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 2;
    current = currentSection(tops, scroller.scrollTop, atBottom);
  }

  function go(e: MouseEvent, id: string) {
    e.preventDefault();
    scrollTo(id, "smooth");
  }

  function scrollTo(id: string, behavior: ScrollBehavior) {
    const target = scroller?.querySelector<HTMLElement>(`section[data-section="${id}"]`);
    if (!scroller || !target) return;
    scroller.scrollTo({ top: target.offsetTop, behavior });
  }

  onMount(() => {
    // What the server can do and its room, from the cache: the sections and the contents' dot read it.
    rooms.loadInfo(account.id);
    // What is typed is written, and a connection changed and not checked is asked about, before the settings turn elsewhere.
    const leave = () => form.mayLeave();
    const undo = () => own.undo();
    const settle = () => own.settled();
    app.settingsLeave = leave;
    app.settingsUndo = undo;
    app.settingsSettle = settle;
    return () => {
      if (app.settingsLeave === leave) app.settingsLeave = null;
      if (app.settingsUndo === undo) app.settingsUndo = null;
      if (app.settingsSettle === settle) app.settingsSettle = null;
      app.settingsTyping = false;
      void own.flush();
    };
  });

  // A quit asks the window first while a text is typed and not left (App.svelte reports it to the backend).
  $effect(() => {
    app.settingsTyping = own.typing;
  });

  /** A text field: saved when it is left or Enter is pressed. A list, a box or a colour is a pick: saved at once. */
  const TEXT = "input:not([type=checkbox], [type=radio], [type=button], [type=color]), textarea, [contenteditable]";

  function onInput(e: Event) {
    if (e.target instanceof HTMLElement && e.target.matches(TEXT)) own.typed();
  }

  function onKeydown(e: KeyboardEvent) {
    if (e.key === "Enter" && e.target instanceof HTMLInputElement && e.target.matches(TEXT)) own.commit();
  }

  // The fields that do not reach the server are saved when they change.
  $effect(() => {
    void JSON.stringify(ownOf(form.account()));
    untrack(() => own.touch());
  });

  // Opened for one of its sections (the quota line opens «Storage», a letter the signatures),
  // also when this page is open already. Only this mailbox's page takes the section.
  $effect(() => {
    void app.settingsTurn;
    untrack(() => {
      const section = app.settingsSection;
      if (!section || app.settingsPage !== `account:${account.id}`) return;
      app.settingsSection = null;
      tick().then(() => scrollTo(section, "instant"));
    });
  });
</script>

<!-- The window losing the focus (hidden, switched away from) leaves the field like a click elsewhere does. -->
<svelte:window onblur={() => own.commit()} />

<!-- The events of the fields bubble here: the page decides when a text is committed. -->
<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<div class="account-page" role="group" aria-label={account.email} oninput={onInput} onkeydown={onKeydown} onfocusout={() => own.commit()}>
  <nav class="toc" aria-label={t("account.contents")}>
    {#each sections as s, i (s.id)}
      {@const look = s.attention?.(account) ?? false}
      <a href="#account-{s.id}" data-toc={s.id} aria-current={current === i ? "location" : undefined} onclick={(e) => go(e, s.id)}
        >{s.title()}{#if look}<span class="look" role="img" aria-label={t("account.attention")} title={t("account.attention")}></span>{/if}</a
      >
    {/each}
  </nav>

  <div class="scroller" bind:this={scroller} onscroll={track}>
    {#each sections as s (s.id)}
      <section id="account-{s.id}" data-section={s.id} aria-labelledby="account-{s.id}-title">
        <h3 id="account-{s.id}-title">{s.title()}</h3>
        <div class="body">
          <s.component {form} {account} />
        </div>
      </section>
    {/each}
  </div>

  {#if form.error || form.status}
    <div class="outcome">
      <CheckError {form} />
      {#if form.status}<p class="muted">{form.status}
        {#if form.waitingBrowser}<button class="link" onclick={() => form.cancelSignIn()}>{t("cancel")}</button>{/if}</p>{/if}
    </div>
  {/if}

  <footer>
    <button class="btn ghost danger-text" onclick={() => form.remove()} disabled={form.busy}>{t("wizard.remove")}</button>
    {#if own.auto.marks.account}
      <span class="mark" class:undone={own.auto.marks.account === "undone"} role="status">{own.auto.marks.account === "saved" ? t("settings.saved") : t("settings.reverted")}</span>
    {/if}
    <span class="spacer"></span>
    {#if form.connectionDirty}
      <span class="muted pending">{t("account.connectionPending")}</span>
      <button class="btn ghost" onclick={() => form.revertConnection()} disabled={form.busy}>{t("cancel")}</button>
    {/if}
    <button class="btn primary" onclick={() => form.checkAndSave()} disabled={form.busy || !form.connectionDirty}>
      {form.busy ? t("wizard.checkingShort") : t("wizard.checkAndSave")}
    </button>
  </footer>
</div>

<style>
  .account-page {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
  }

  /* Anchors, not tabs: the page is one, a section hides none of the others. */
  .toc {
    flex: none;
    display: flex;
    gap: 4px;
    padding: 4px 24px 10px;
    border-bottom: 1px solid var(--line);
    overflow-x: auto;
  }

  .toc a {
    flex: none;
    padding: 4px 9px;
    border-radius: 6px;
    color: var(--muted);
    font-size: 13px;
    text-decoration: none;
    white-space: nowrap;
  }

  .toc a:hover {
    background: var(--hover);
    color: var(--ink);
  }

  .toc a[aria-current="location"] {
    background: var(--selected);
    color: var(--ink);
    font-weight: 600;
  }

  /* Something in the section deserves a look; nowhere else does it show. */
  .look {
    display: inline-block;
    width: 6px;
    height: 6px;
    margin-left: 5px;
    border-radius: 50%;
    background: var(--warn);
    vertical-align: middle;
  }

  .toc a:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: -2px;
  }

  /* Offsets of the sections are counted from here. */
  .scroller {
    position: relative;
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding: 0 24px;
  }

  section {
    padding: 16px 0 20px;
    border-bottom: 1px solid var(--line);
  }

  section:last-child {
    border-bottom: none;
    /* The last section can still be scrolled to the top, as the others. */
    min-height: 100%;
  }

  h3 {
    margin: 0 0 12px;
    font-size: 15px;
  }

  .body {
    display: flex;
    flex-direction: column;
    gap: 12px;
  }

  .outcome {
    flex: none;
    max-height: 40%;
    overflow-y: auto;
    padding: 10px 24px 0;
    border-top: 1px solid var(--line);
  }

  .outcome p {
    margin: 0 0 6px;
  }

  .link {
    border: none;
    background: none;
    color: var(--link);
    padding: 0;
    text-decoration: underline;
  }

  footer {
    flex: none;
    display: flex;
    gap: 8px;
    padding: 12px 24px 16px;
    border-top: 1px solid var(--line);
  }

  .spacer {
    flex: 1;
  }

  footer {
    align-items: center;
  }

  .mark {
    font-size: 12px;
    color: var(--ok);
  }

  .mark.undone {
    color: var(--muted);
  }

  .pending {
    font-size: 12px;
  }

  @media (max-width: 640px) {
    .toc {
      padding: 4px 16px 8px;
    }

    .scroller {
      padding: 0 16px;
    }

    footer {
      padding: 10px 16px 12px;
    }
  }
</style>

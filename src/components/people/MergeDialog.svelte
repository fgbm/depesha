<script lang="ts">
  // The merge of people (#104, frame 3): which name stays, which address is the primary, and what
  // happens to the rules where the people differ. The dialog is always shown, and Enter takes
  // what it offers: the name of the one with the most letters, the strictest format (plain text
  // < HTML < Markdown), «Hide» if anyone had it, the notes joined by an empty line. Tab goes
  // between the groups, the arrows inside a group, Enter joins, Esc leaves.
  import { t, tn } from "../../lib/i18n.svelte";
  import { peopleOps } from "../../lib/peopleOps.svelte";
  import type { BodyFormat, ViewRule } from "../../lib/types";

  const open = $derived(peopleOps.dialog);
  const plan = $derived(open?.plan);
  const choice = $derived(open?.choice);

  let box = $state<HTMLDivElement | null>(null);
  const before = document.activeElement as HTMLElement | null;

  const FORMAT: Record<string, string> = {
    "": t("people.asUsual"),
    plain: t("format.plain"),
    html: t("format.html"),
    markdown: t("format.markdown"),
  };
  const VIEW: Record<string, string> = {
    "": t("people.asUsual"),
    html: t("letterView.html"),
    markdown: t("letterView.markdown"),
    text: t("letterView.text"),
  };

  /** The names, by the people who have them: «at "Ольга Смирнова"». */
  const owners = (pick: (p: NonNullable<typeof plan>["people"][number]) => boolean) =>
    plan ? plan.people.filter(pick).map((p) => p.name || p.email).join(", ") : "";

  $effect(() => {
    // The first group takes the focus: the default name is already chosen.
    if (box) box.querySelector<HTMLElement>("input:checked")?.focus();
  });

  function close() {
    peopleOps.cancel();
    before?.focus();
  }

  function go() {
    void peopleOps.confirm();
  }

  function onKey(e: KeyboardEvent) {
    // No key reaches the dialogs and shortcuts underneath.
    e.stopPropagation();
    if (e.key === "Escape") {
      e.preventDefault();
      close();
    } else if (e.key === "Enter" && !(e.target instanceof HTMLButtonElement && e.target.dataset.no !== undefined)) {
      e.preventDefault();
      go();
    } else if (e.key === "Tab") {
      const all = [...(box?.querySelectorAll<HTMLElement>("input:checked, button") ?? [])];
      const i = all.indexOf(document.activeElement as HTMLElement);
      if (i < 0) return;
      e.preventDefault();
      all[(i + (e.shiftKey ? all.length - 1 : 1)) % all.length]?.focus();
    }
  }
</script>

<svelte:window onkeydowncapture={onKey} />
{#if open && plan && choice}
  <div class="modal-backdrop merge-backdrop" role="presentation" onpointerdown={(e) => e.target === e.currentTarget && close()}>
    <div class="modal merge" role="dialog" aria-modal="true" aria-labelledby="merge-title" bind:this={box}>
      <h3 id="merge-title">{tn("people.merge.title", plan.people.length)}</h3>
      <div class="muted small">{plan.people.map((p) => p.name || p.email).join(" · ")}</div>

      <fieldset>
        <legend>{t("people.merge.name")}</legend>
        {#each plan.names as n, i (n.name)}
          <label class="opt">
            <input type="radio" name="merge-name" value={n.name} bind:group={choice.name} />
            <span><b>{n.name}</b> <span class="why">{tn("people.letters", n.uses)}{i === 0 && n.uses > 0 ? `, ${t("people.merge.mostLetters")}` : ""}</span></span>
          </label>
        {/each}
      </fieldset>

      <fieldset>
        <legend>{t("people.merge.primary")}</legend>
        {#each plan.addresses as a (a.email)}
          <label class="opt">
            <input type="radio" name="merge-primary" value={a.email} bind:group={choice.primary} />
            <span>{a.email} <span class="why">{tn("people.letters", a.uses)}</span></span>
          </label>
        {/each}
      </fieldset>

      <h4>{t("people.merge.rules")}</h4>

      {#if plan.format.conflict}
        <fieldset class="conf">
          <legend>{t("people.merge.formatClash")}</legend>
          {#each plan.format.values as v (v)}
            <label class="opt">
              <input type="radio" name="merge-format" value={v} bind:group={choice.format} />
              <span><b>{FORMAT[v]}</b> <span class="why">{t("people.merge.at", { who: owners((p) => p.send_format === v) })}{v === plan.format.value ? ` · ${t("people.merge.strictest")}` : ""}</span></span>
            </label>
          {/each}
        </fieldset>
      {:else}
        <div class="agree">{t("people.sendFormat")}: {FORMAT[plan.format.value as BodyFormat | ""]}{plan.format.values.length ? "" : ` (${t("people.merge.noRule")})`}</div>
      {/if}

      {#if plan.view.conflict}
        <fieldset class="conf">
          <legend>{t("people.merge.viewClash")}</legend>
          {#each plan.view.values as v (v)}
            <label class="opt">
              <input type="radio" name="merge-view" value={v} bind:group={choice.view} />
              <span><b>{VIEW[v]}</b> <span class="why">{t("people.merge.at", { who: owners((p) => p.view === v) })}{v === plan.view.value ? ` · ${t("people.merge.kept")}` : ""}</span></span>
            </label>
          {/each}
        </fieldset>
      {:else}
        <div class="agree">{t("people.view")}: {VIEW[plan.view.value as ViewRule]}{plan.view.values.length ? "" : ` (${t("people.merge.noRule")})`}</div>
      {/if}

      {#if !plan.hidden.some}
        <div class="agree">{t("people.merge.hideNo")}</div>
      {:else if plan.hidden.all}
        <div class="agree">{t("people.merge.hideYes")}</div>
      {:else}
        <fieldset class="conf">
          <legend>{t("people.merge.hideClash")}</legend>
          <label class="opt">
            <input type="radio" name="merge-hidden" value={true} bind:group={choice.hidden} />
            <span><b>{t("people.merge.hide")}</b> <span class="why">{t("people.merge.at", { who: owners((p) => p.hidden) })} · {t("people.merge.hideWins")}</span></span>
          </label>
          <label class="opt">
            <input type="radio" name="merge-hidden" value={false} bind:group={choice.hidden} />
            <span><b>{t("people.merge.show")}</b> <span class="why">{t("people.merge.at", { who: owners((p) => !p.hidden) })}</span></span>
          </label>
        </fieldset>
      {/if}

      {#if plan.notes > 1}<div class="agree">{t("people.merge.notes")}</div>{/if}

      <div class="prev">
        {t("people.merge.result", { name: choice.name, primary: choice.primary })}
        <br />{t("people.sendFormat")}: {FORMAT[choice.format]} · {t("people.view")}: {VIEW[choice.view]} · {choice.hidden ? t("people.merge.resultHidden") : t("people.merge.resultShown")}
      </div>

      <div class="buttons">
        <button class="btn" data-no onclick={close}>{t("cancel")}</button>
        <button class="btn primary" onclick={go}>{t("people.mergeThem")}</button>
      </div>
    </div>
  </div>
{/if}

<style>
  .merge-backdrop {
    z-index: 55;
  }

  .merge {
    width: min(480px, calc(100vw - 40px));
    max-height: calc(100vh - 60px);
    overflow-y: auto;
    padding: 18px 20px 16px;
    gap: 8px;
  }

  h3 {
    margin: 0;
    font-size: 15px;
  }

  h4 {
    margin: 6px 0 0;
    font-size: 11px;
    font-weight: 600;
    color: var(--muted);
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }

  fieldset {
    margin: 0;
    padding: 6px 0 2px;
    border: none;
  }

  legend {
    padding: 0;
    font-size: 11px;
    font-weight: 600;
    color: var(--muted);
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }

  .conf {
    padding: 6px 10px 4px;
    border-left: 3px solid var(--warn);
    background: var(--paper-2);
    border-radius: 0 6px 6px 0;
  }

  .opt {
    display: flex;
    gap: 8px;
    align-items: baseline;
    padding: 3px 0;
  }

  .why {
    color: var(--muted);
    font-size: 12px;
  }

  .agree {
    font-size: 12.5px;
    color: var(--muted);
  }

  .prev {
    margin-top: 4px;
    padding: 8px 10px;
    border-radius: 6px;
    background: var(--paper-2);
    border: 1px solid var(--line);
    font-size: 12.5px;
    line-height: 1.5;
  }

  .buttons {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    margin-top: 6px;
  }

  .small {
    font-size: 12px;
  }
</style>

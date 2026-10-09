<script lang="ts">
  // A page of the settings made of rows (#102): the groups of the catalog with their rows, the
  // plugins' groups that stand on the page, and the keyboard of the page. A row is one stop:
  // ↑/↓ walk the rows, ← / → change the value, Enter opens or enters it. Every change is
  // saved at once through the editor; the page keeps no draft and asks nothing on leaving.
  import { onMount } from "svelte";
  import { api } from "../../lib/api";
  import { app } from "../../lib/store.svelte";
  import { peopleBook } from "../../lib/peopleBook.svelte";
  import { accountLabel } from "../../lib/format";
  import { t } from "../../lib/i18n.svelte";
  import type { SettingsAutosave } from "../../lib/settingsAutosave.svelte";
  import { isEnabled, rowKind, type PageSpec, type RowContext, type RowSpec } from "../../lib/settingsCatalog";
  import { RowEditor } from "../../lib/settingsEdit";
  import { exceptionCount, exceptions, layerSummary } from "../../lib/settingsLayers";
  import { dependentRuns, moveCursor, rowKeyAction, type RowAction } from "../../lib/settingsRows";
  import type { Owned, SettingsSection } from "../../plugin-host/registry.svelte";
  import Popover from "../Popover.svelte";
  import HintsList from "./HintsList.svelte";
  import RowControl from "./RowControl.svelte";
  import SettingsRow from "./SettingsRow.svelte";

  let {
    page,
    auto,
    sections,
    flash = null,
    go,
  }: {
    page: PageSpec;
    auto: SettingsAutosave;
    sections: Owned<SettingsSection>[];
    /** The row a search hit just opened the page at: lit a moment (the window sets it and takes it away). */
    flash?: string | null;
    /** Opens another page of the window: a mailbox's page at a section, or a person. */
    go: (page: string, opts?: { section?: string; person?: string }) => void;
  } = $props();

  const s = $derived(app.settings);
  let noTray = $state(false);
  const ctx = $derived<RowContext>({ accounts: app.accounts, noTray });
  const editor = new RowEditor({ settings: () => app.settings, ctx: () => ctx, auto: { commit: (...a) => auto.forPage(page.id).commit(...a) } });

  let box = $state<HTMLElement | null>(null);
  /** The row that has the stop of Tab; null until the page is entered: the first one. */
  let cursor = $state<string | null>(null);
  let errors = $state<Record<string, string | null>>({});
  let dayCursor = $state<number | null>(null);
  let menuFor = $state<string | null>(null);
  let controls = $state<Record<string, ReturnType<typeof RowControl> | undefined>>({});

  onMount(() => {
    void peopleBook.load();
    if (page.id === "start") api.backgroundStatus().then((b) => (noTray = b.tray === "absent"), () => {});
  });

  const exc = (layer: "format" | "view") => exceptions(layer, peopleBook.list, app.accounts);

  /** A layer row is drawn only where some mailbox or person differs from the general value. */
  function shown(spec: RowSpec): boolean {
    return spec.kind !== "layer" || exceptionCount(exc(spec.layer)) > 0;
  }

  const groups = $derived(page.groups.map((g) => ({ ...g, rows: g.rows.filter(shown) })).filter((g) => g.rows.length));
  const firstId = $derived(groups[0]?.rows[0]?.id ?? null);
  const specs = $derived(groups.flatMap((g) => g.rows));
  /** The stop of Tab: the row the hand was on, or the first one when that row went away. */
  const stop = $derived(specs.some((x) => x.id === cursor) ? cursor : firstId);

  const rowEls = () => [...(box?.querySelectorAll<HTMLElement>(".rw[data-row]") ?? [])];

  /** The row the hand is on: the stop of Tab follows the focus. */
  function onFocusIn(e: FocusEvent) {
    const row = (e.target as HTMLElement).closest<HTMLElement>(".rw[data-row]");
    if (row) cursor = row.dataset.row ?? null;
  }

  /** Enter and Esc in a field, or a pick from a list: the focus goes back to the row. */
  function leave(id: string) {
    box?.querySelector<HTMLElement>(`.rw[data-row="${CSS.escape(id)}"]`)?.focus();
  }

  function onError(id: string, message: string | null) {
    errors[id] = message;
  }

  // ---- The links of a row: a mailbox, or a place a layer differs in ----

  interface Item {
    /** What tells it from the others: two mailboxes or two people may carry one name. */
    key: string;
    label: string;
    open: () => void;
  }

  function items(spec: RowSpec): Item[] {
    if (spec.kind === "link") {
      return app.accounts.map((a) => ({ key: `account:${a.id}`, label: accountLabel(a), open: () => go(`account:${a.id}`, { section: spec.section }) }));
    }
    if (spec.kind !== "layer") return [];
    const ex = exc(spec.layer);
    return [
      ...ex.accounts.map((a) => ({ key: `account:${a.id}`, label: accountLabel(a), open: () => go(`account:${a.id}`, { section: "letters" }) })),
      ...ex.people.map((p) => ({ key: `person:${p.email}`, label: p.name || p.email, open: () => go("people", { person: p.email }) })),
    ];
  }

  /** One mailbox or one place goes there at once; several are chosen from a menu. */
  function follow(spec: RowSpec) {
    const list = items(spec);
    if (list.length === 1) list[0].open();
    else if (list.length > 1) menuFor = spec.id;
  }

  function pickItem(item: Item) {
    menuFor = null;
    item.open();
  }

  // ---- The update row ----

  const updateHint = $derived.by(() => {
    const u = app.update;
    const lines: string[] = [];
    if (u?.state === "checking") lines.push(t("settings.checking"));
    else if (u?.version) lines.push(`${t("update.available", { version: u.version })}.`);
    if (u?.install === "package") lines.push(t("settings.packageNote"));
    if (u?.install === "unsupported") lines.push(t("settings.unsupportedNote"));
    return lines.join(" ") || null;
  });

  const labelOf = (spec: RowSpec) =>
    spec.kind === "action" ? t("settings.installed", { version: app.update?.current ?? "—" }) : spec.kind === "layer" ? layerSummary(exc(spec.layer)) : spec.label();

  function hintOf(spec: RowSpec): string | null {
    if (spec.kind === "action") return updateHint;
    return spec.hint?.(s, ctx) ?? null;
  }

  function warnOf(spec: RowSpec): string | null {
    if (spec.kind === "action") return app.update?.state === "error" ? (app.update.error ?? null) : null;
    return spec.warn?.(s, ctx) ?? null;
  }

  // ---- The keys of a row ----

  function stepDay(dir: 1 | -1) {
    dayCursor = Math.min(7, Math.max(1, (dayCursor ?? (dir === 1 ? 0 : 8)) + dir));
  }

  function enterRow(spec: RowSpec) {
    if (spec.kind === "link" || spec.kind === "layer") follow(spec);
    else if (spec.kind === "action") void app.checkUpdates();
    // The first press only puts the cursor on the first day: nothing is switched by a key that did not choose it.
    else if (spec.kind === "days") {
      if (dayCursor === null) dayCursor = 1;
      else void editor.toggleDay(spec, dayCursor);
    }
    else controls[spec.id]?.enter();
  }

  function perform(spec: RowSpec, row: HTMLElement, act: RowAction) {
    if (act.type === "move") {
      const rows = rowEls();
      rows[moveCursor(rows.length, rows.indexOf(row), act.to)]?.focus();
      return;
    }
    // A dimmed row is walked past, not changed.
    if (isEnabled(spec, s)) change(spec, act);
  }

  function change(spec: RowSpec, act: RowAction) {
    if (act.type === "step") {
      if (spec.kind === "days") stepDay(act.dir);
      else void editor.step(spec, act.dir, act.big);
    } else if (act.type === "set" && spec.kind === "toggle") void editor.toggle(spec, act.on);
    else if (act.type === "toggle" && spec.kind === "toggle") void editor.toggle(spec, !s[spec.key]);
    else if (act.type === "enter") enterRow(spec);
    else if (act.type === "clear" && spec.kind === "folder") void editor.setFolder(spec, "");
    else if (act.type === "day" && spec.kind === "days") void editor.toggleDay(spec, act.n);
  }

  /** Tab in a row that is open walks its controls; at the ends it goes on as it would. */
  function tabInRow(e: KeyboardEvent): boolean {
    if (e.ctrlKey || e.altKey || e.metaKey || !(e.target instanceof HTMLElement)) return false;
    const row = e.target.closest<HTMLElement>(".rw[data-row]");
    if (!row || row === e.target) return false;
    const controls = [...row.querySelectorAll<HTMLElement>("input:not(:disabled), button:not(:disabled):not(.mi)")];
    const next = controls[controls.indexOf(e.target) + (e.shiftKey ? -1 : 1)];
    if (!next || !controls.includes(e.target)) return false;
    e.preventDefault();
    next.focus();
    if (next instanceof HTMLInputElement) next.select();
    return true;
  }

  /**
   * The keys pressed on a row, or on a control in it after a click left the focus there; the
   * text being typed in a field, and a list that is open, are theirs.
   */
  function onKey(e: KeyboardEvent) {
    if (e.key === "Tab") return void tabInRow(e);
    const target = e.target instanceof HTMLElement ? e.target : null;
    if (!target || e.defaultPrevented || target.matches("input, textarea") || target.closest(".pop") || target.getAttribute("aria-expanded") === "true") return;
    const row = target.closest<HTMLElement>(".rw[data-row]");
    const spec = specs.find((x) => x.id === row?.dataset.row);
    if (!row || !spec) return;
    const act = rowKeyAction(rowKind(spec), e);
    if (!act) return;
    e.preventDefault();
    perform(spec, row, act);
  }
</script>

<!-- The keys of the rows are caught where they bubble: each row is a stop, the controls are not. -->
<div class="page" bind:this={box} role="presentation" onkeydown={onKey} onfocusin={onFocusIn}>
  {#snippet rowView(spec: RowSpec)}
    {@const kind = spec.kind}
    <SettingsRow
      id={spec.id}
      {kind}
      label={labelOf(spec)}
      hint={hintOf(spec)}
      desc={spec.kind === "choice" ? (editor.chosenOption(spec)?.desc?.() ?? null) : null}
      warn={warnOf(spec)}
      error={errors[spec.id]}
      mark={auto.marks[spec.id]}
      dis={!isEnabled(spec, s)}
      dep={spec.dep}
      block={kind === "theme" || kind === "block" || kind === "layer"}
      quiet={kind === "block" || kind === "layer"}
      tab={stop === spec.id}
      flash={flash === spec.id}
    >
      {#if spec.kind === "block"}
        <HintsList />
      {:else if spec.kind === "action"}
        <button type="button" class="btn" tabindex="-1" disabled={app.update?.state === "checking"} onclick={() => app.checkUpdates()}>{t("settings.checkNow")}</button>
      {:else if spec.kind === "link" || spec.kind === "layer"}
        <div class="menu">
          <button type="button" class="lnk" tabindex="-1" disabled={!isEnabled(spec, s)} onclick={() => follow(spec)}>
            {spec.kind === "link" ? spec.text() : layerSummary(exc(spec.layer))} ›
          </button>
          <Popover bind:open={() => menuFor === spec.id, (v) => (menuFor = v ? spec.id : null)} align="left" role="menu">
            {#each items(spec) as item (item.key)}
              <button type="button" class="mi" role="menuitem" onclick={() => pickItem(item)}>{item.label}</button>
            {/each}
          </Popover>
        </div>
      {:else}
        <RowControl
          bind:this={controls[spec.id]}
          {spec}
          {s}
          {editor}
          dayCursor={spec.kind === "days" ? dayCursor : null}
          onerror={(m) => onError(spec.id, m)}
          onleave={() => leave(spec.id)}
        />
      {/if}
    </SettingsRow>
  {/snippet}

  {#each groups as g (g.id)}
    <section class="grp" data-g={g.id} aria-labelledby="grp-{g.id}">
      <h4 id="grp-{g.id}">{g.title()}</h4>
      <div class="gb">
        {#each dependentRuns(g.rows) as item (item.run ? `run:${item.rows[0].id}` : item.row.id)}
          {#if item.run}
            <!-- One strip for the rows that follow one another, not a line to each (#102, the rule of the strip). -->
            <div class="depg">{#each item.rows as spec (spec.id)}{@render rowView(spec)}{/each}</div>
          {:else}
            {@render rowView(item.row)}
          {/if}
        {/each}
      </div>
    </section>
  {/each}

  {#each sections as sec (sec)}
    <section class="grp" data-g="plugin">
      <h4>{sec.item.title()}<span class="tagp">{t("settings.pluginTag")}</span></h4>
      <div class="gb"><sec.item.component {...sec.item.props} /></div>
    </section>
  {/each}
</div>

<style>
  .page {
    container-type: inline-size;
  }

  .grp {
    margin: 0 0 22px;
  }

  .grp > h4 {
    margin: 0 0 4px;
    padding: 4px 0 6px;
    border-bottom: 1px solid var(--line);
    font-size: 15px;
    font-weight: 600;
  }

  .tagp {
    margin-left: 8px;
    padding: 0 5px;
    border: 1px solid var(--line);
    border-radius: 4px;
    background: var(--paper);
    font-size: 10.5px;
    font-weight: 600;
    color: var(--muted);
    vertical-align: 1px;
  }

  /* The strip at the left is one line for the whole run of dependent rows. */
  .depg {
    margin-left: 4px;
    border-left: 2px solid var(--line);
  }

  .menu {
    position: relative;
  }

  .lnk {
    padding: 2px 4px;
    border: none;
    border-radius: 5px;
    background: none;
    color: var(--link);
    font: inherit;
    font-size: 13px;
    cursor: pointer;
  }

  .lnk:hover:not(:disabled) {
    background: var(--hover);
  }

  .lnk:disabled {
    cursor: default;
  }
</style>

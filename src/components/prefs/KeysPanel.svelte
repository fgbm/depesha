<script lang="ts">
  import Search from "@lucide/svelte/icons/search";
  import Keyboard from "@lucide/svelte/icons/keyboard";
  import RotateCcw from "@lucide/svelte/icons/rotate-ccw";
  import Plus from "@lucide/svelte/icons/plus";
  import Puzzle from "@lucide/svelte/icons/puzzle";
  import TriangleAlert from "@lucide/svelte/icons/triangle-alert";
  import Lock from "@lucide/svelte/icons/lock";
  import Info from "@lucide/svelte/icons/info";
  import ArrowLeftRight from "@lucide/svelte/icons/arrow-left-right";
  import { i18n, t, tn } from "../../lib/i18n.svelte";
  import { app } from "../../lib/store.svelte";
  import { host } from "../../plugin-host/host.svelte";
  import { keyText, type Group, type Problem } from "../../lib/keymap";
  import { shortcuts, type TitledCommand } from "../../lib/shortcuts.svelte";
  import type { Settings } from "../../lib/types";
  import Keys from "../Keys.svelte";
  import { useKeyEditor, type Message, type Note, type SwapProblem } from "./useKeyEditor.svelte";

  // Settings → Keys (#46): every command with its keys, grouped by where they work.
  // A click on a key (or Enter on it) records a new one at once; a key taken already
  // asks to replace or swap. Saved with the rest of the settings.
  let { draft }: { draft: Settings } = $props();

  const k = useKeyEditor(() => draft);
  $effect(() => k.listen());

  // Opened from the palette by Alt+Enter (#46): go to the row of that command, highlight it
  // a moment; a command the page has no row for is searched for by its title instead.
  $effect(() => {
    void app.settingsTurn;
    const ask = app.settingsKeys;
    if (!ask) return;
    app.settingsKeys = null;
    k.goTo(ask);
  });

  const lang = $derived(i18n.lang);
  const text = (key: string) => keyText(key, lang);
  /** Former keys in a quiet line: Latin only, "was Delete, #". */
  const plain = (keys: string[]) => keys.map((x) => keyText(x, "en")).join(", ");

  /** The palette's own key, as the keymap has it now. */
  function paletteNote(): string {
    const key = shortcuts.hint("command-palette.open");
    return key ? t("keys.group.otherNote", { key }) : t("keys.group.otherNoteNoKey");
  }

  const GROUPS: { id: Group; title: () => string; note: () => string }[] = [
    { id: "everywhere", title: () => t("keys.group.everywhere"), note: () => t("keys.group.everywhereNote") },
    { id: "list", title: () => t("keys.group.list"), note: () => t("keys.group.listNote") },
    { id: "compose", title: () => t("keys.group.compose"), note: () => t("keys.group.composeNote") },
    { id: "other", title: () => t("keys.group.other"), note: () => paletteNote() },
  ];
  const groups = $derived(GROUPS.map((g) => ({ ...g, rows: k.rows(g.id) })).filter((g) => g.rows.length));

  function pluginName(owner: string): string | null {
    const p = host.plugins.find((p) => p.manifest.id === owner);
    return p ? (lang === "ru" ? p.manifest.name.ru : p.manifest.name.en) : null;
  }

  function problemText(p: Problem): string {
    return t(p.kind === "system" ? "keys.problem.system" : p.kind === "palette" ? "keys.problem.palette" : "keys.problem.letter");
  }

  function messageText(m: Message): string {
    return m.kind === "same" ? t("keys.same", { key: text(m.key) }) : `${text(m.key)} — ${problemText(m.problem)}`;
  }

  function noteText(n: Note): string {
    return n.kind === "elsewhere" ? t("keys.otherWindow", { key: text(n.key), other: n.other }) : t("keys.typed", { typed: n.typed, key: text(n.key) });
  }

  function swapText(p: SwapProblem): string | null {
    return p === null ? null : p.kind === "noKey" ? t("keys.swapNoKey") : t("keys.swapBad", { key: text(p.key), other: p.other });
  }

  const held = (m: string) => (m === "Mod" ? "Ctrl" : m);
</script>

<div class="tools">
  <label class="q" class:focus={k.pressing}>
    <Search size={14} />
    {#if k.pressKey}
      <span class="pressed">{t("keys.pressed", { key: "" })}<Keys cap key={k.pressKey} /></span>
      <button class="btn ghost small" onclick={() => (k.pressKey = null)} aria-label={t("cancel")}>×</button>
    {:else}
      <input bind:value={k.query} placeholder={k.pressing ? t("keys.searchPress") : t("keys.search")} aria-label={t("keys.search")} />
    {/if}
    <button class="btn small" class:on={k.pressing} title={t("keys.pressTitle")} aria-pressed={k.pressing} onclick={() => k.togglePressing()}>
      <Keyboard size={14} /> {t("keys.press")}
    </button>
  </label>
  <span class="seg" role="tablist">
    <button role="tab" class:on={!k.onlyChanged} aria-selected={!k.onlyChanged} onclick={() => (k.onlyChanged = false)}>{t("keys.filterAll")}</button>
    <button role="tab" class:on={k.onlyChanged} aria-selected={k.onlyChanged} onclick={() => (k.onlyChanged = true)}>{t("keys.filterChanged")}{#if k.changedCount}<span class="n">{k.changedCount}</span>{/if}</button>
  </span>
  <button class="btn ghost small" title={t("keys.resetAllTitle")} disabled={!k.changedCount} onclick={() => k.resetAll()}><RotateCcw size={13} /> {t("keys.resetAll")}</button>
</div>

{#if k.beforeReset}
  <div class="undo" role="status">
    {t("keys.resetDone")}
    <button class="btn small" onclick={() => k.undoReset()}>{t("keys.undoReset")}</button>
  </div>
{/if}

<div class="layout">
  <Info size={13} /> {t("keys.layout")}
  {#if lang === "ru"}<Keys cap key="e" /> {t("keys.layoutExample")}{/if}
</div>

{#each k.lost as l (`${l.id}:${l.key}`)}
  {@const c = k.byId(l.id)}
  <div class="banner">
    <Puzzle size={15} />
    <div>
      <b>{t("keys.lost.wanted", { plugin: pluginName(c?.owner ?? "") ?? "" })} <Keys cap key={l.key} /> {t("keys.lost.for", { command: c?.title() ?? l.id })}</b>
      <div class="note">{t(Object.hasOwn(k.custom, l.holder) ? "keys.lost.noteMine" : "keys.lost.note", { holder: k.byId(l.holder)?.title() ?? l.holder })}</div>
      <div class="buttons">
        <button class="btn small" onclick={() => { k.dismiss(l); k.start(l.id, 0); }}>{t("keys.lost.assign")}</button>
        <button class="btn ghost small" onclick={() => k.dismiss(l)}>{t("keys.lost.ok")}</button>
      </div>
    </div>
  </div>
{/each}

{#snippet recBox()}
  {#if k.conflict}
    <span class="combo rec pending"><Keys cap key={k.conflict.key} /></span>
  {:else if k.held.length}
    <span class="combo rec">{#each k.held as h, i (h)}{#if i}<b class="plus">+</b>{/if}<kbd class="cap">{held(h)}</kbd>{/each}<b class="plus">+</b><span class="wait">…</span></span>
  {:else}
    <span class="combo rec"><span class="wait">{t("keys.recording")}</span></span>
  {/if}
{/snippet}

{#snippet below(c: TitledCommand)}
  {#if k.note?.id === c.id}
    <div class="okline">{noteText(k.note)}</div>
  {/if}
  {#if k.rec?.id === c.id}
    {#if k.conflict}
      {@const other = k.byId(k.conflict.other)?.title() ?? ""}
      {@const rest = k.keysOf(k.conflict.other).filter((x) => x !== k.conflict?.key)}
      {@const noSwap = swapText(k.swapProblem())}
      <div class="kconf" role="alert">
        <TriangleAlert size={15} />
        <div>
          <div><Keys cap key={k.conflict.key} /> {t("keys.conflict", { other })}</div>
          <div class="buttons">
            <button class="btn small primary" onclick={() => k.settle("replace")}>{t("keys.replace")}</button>
            <button class="btn small" disabled={!!noSwap} title={noSwap ?? ""} onclick={() => k.settle("swap")}><ArrowLeftRight size={13} /> {t("keys.swap")}</button>
            <button class="btn small ghost" onclick={k.stop}>{t("cancel")}</button>
          </div>
          <div class="note">
            {rest.length ? t("keys.replaceNoteRest", { other, keys: rest.map(text).join(", ") }) : t("keys.replaceNote", { other })}
            {noSwap ?? t("keys.swapNote", { other, key: text(k.keysOf(c.id)[k.rec.idx] ?? "") })}
          </div>
        </div>
      </div>
    {:else}
      {#if k.message}
        <div class="kconf" class:err={k.message.kind === "problem"} class:info={k.message.kind === "same"} role="alert">
          {#if k.message.kind === "problem"}<Lock size={15} />{:else}<Info size={15} />{/if}
          <div>{messageText(k.message)}</div>
        </div>
      {/if}
      <div class="rechint">
        {t("keys.recCancel")}
        {#if k.rec.idx < k.keysOf(c.id).length}
          · <button class="link" onclick={() => k.removeRecorded()}>{t("keys.removeKey")}</button>
        {/if}
        ·
        {#if k.special}
          {#each ["Escape", "Enter", "Tab", "Space"] as key (key)}
            <button class="link sp" onclick={() => k.record(key, null)}>{text(key)}</button>
          {/each}
        {:else}
          <button class="link" onclick={() => (k.special = true)}>{t("keys.special")}</button>
        {/if}
      </div>
    {/if}
  {/if}
{/snippet}

<div class="list">
  {#each groups as g (g.id)}
    <div class="group">{g.title()}<span class="gnote">{g.note()}</span></div>
    {#each g.rows as c (c.id)}
      {@const keys = k.keysOf(c.id)}
      {@const mine = k.isChanged(c.id)}
      {@const plugin = c.owner !== "core" ? pluginName(c.owner) : null}
      {@const at = k.rec?.id === c.id ? k.rec.idx : -1}
      <div class="kr" class:changed={mine} class:recording={at >= 0} class:hl={k.hl === c.id} class:conflicted={k.conflict?.other === c.id} data-command={c.id}>
        <i class="dot"></i>
        <span class="kt">
          <span class="title">{c.title()}</span>
          {#if plugin}<span class="from"><Puzzle size={11} /> {plugin}</span>{/if}
          {#if mine}<span class="was">{c.keys.length ? t("keys.was", { keys: plain(c.keys) }) : t("keys.wasNone")}</span>{/if}
        </span>
        <span class="kk">
          {#each keys as key, i (key)}
            {#if i}<span class="or">{t("keys.or")}</span>{/if}
            {#if i === at}
              {@render recBox()}
            {:else if c.locked}
              <span class="combo"><Keys cap {key} /></span>
            {:else}
              <button class="combo" class:flash={k.flash === c.id} title={t("keys.change")} onclick={() => k.start(c.id, i)}><Keys cap {key} /></button>
            {/if}
          {/each}
          {#if at >= keys.length}
            {#if keys.length}<span class="or">{t("keys.or")}</span>{/if}
            {@render recBox()}
          {:else if !keys.length}
            <button class="none" onclick={() => k.start(c.id, 0)}>{t("keys.none")}</button>
          {/if}
        </span>
        <span class="ka">
          {#if !c.locked && keys.length}
            <button class="ib add" title={t("keys.add")} aria-label={t("keys.add")} onclick={() => k.start(c.id, keys.length)}><Plus size={14} /></button>
          {/if}
          {#if mine}
            {@const back = c.keys.length ? t("keys.reset", { keys: plain(c.keys) }) : t("keys.resetNone")}
            <button class="ib" title={back} aria-label={back} onclick={() => k.reset(c.id)}><RotateCcw size={14} /></button>
          {/if}
        </span>
      </div>
      {@render below(c)}
    {/each}
  {:else}
    <div class="found">
      {#if k.pressKey}<Keys cap key={k.pressKey} /> {t("keys.free", { key: "" })}{:else}{t("keys.nothing")}{/if}
    </div>
  {/each}
  {#if !k.filtering && !k.showMore && k.folded.length}
    <button class="more" onclick={() => (k.showMore = true)}>{tn("keys.more", k.folded.length)}</button>
  {/if}
</div>

<style>
  /* The search and the filters stay at the top while the list scrolls. */
  .tools {
    position: sticky;
    top: 0;
    z-index: 2;
    display: flex;
    gap: 10px;
    align-items: center;
    padding: 2px 0 10px;
    border-bottom: 1px solid var(--line);
    background: var(--paper);
  }

  .q {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 8px;
    height: 34px;
    border: 1px solid var(--line);
    border-radius: 6px;
    padding: 0 4px 0 10px;
    background: var(--paper);
    color: var(--muted);
  }

  .q:focus-within,
  .q.focus {
    border-color: var(--accent);
    box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 18%, transparent);
  }

  .q input {
    flex: 1;
    min-width: 0;
    border: none;
    outline: none;
    background: transparent;
    font: inherit;
    color: var(--ink);
  }

  .pressed {
    flex: 1;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    color: var(--ink);
    white-space: nowrap;
  }

  .small {
    padding: 3px 9px;
    font-size: 12px;
    flex: none;
  }

  .btn.on {
    border-color: var(--accent);
    color: var(--accent);
  }

  .seg {
    display: inline-flex;
    background: var(--paper-2);
    border: 1px solid var(--line);
    border-radius: 7px;
    padding: 2px;
    gap: 2px;
    flex: none;
  }

  .seg button {
    border: none;
    background: none;
    font: inherit;
    font-size: 12px;
    padding: 3px 9px;
    border-radius: 5px;
    color: var(--muted);
    white-space: nowrap;
  }

  .seg button.on {
    background: var(--paper);
    color: var(--ink);
    font-weight: 600;
    box-shadow: 0 1px 2px rgb(0 0 0 / 10%);
  }

  .seg .n {
    margin-left: 4px;
  }

  .undo {
    display: flex;
    align-items: center;
    gap: 12px;
    margin-top: 10px;
    padding: 8px 10px 8px 14px;
    border-radius: 8px;
    background: var(--paper-2);
    border: 1px solid var(--line);
    font-size: 13px;
  }

  .layout {
    font-size: 12px;
    color: var(--muted);
    padding: 10px 0 0;
    display: flex;
    gap: 6px;
    align-items: center;
  }

  .banner {
    display: flex;
    gap: 10px;
    margin: 14px 0 0;
    padding: 10px 12px;
    border-radius: 8px;
    background: var(--paper-2);
    border: 1px solid var(--line);
    font-size: 13px;
    line-height: 1.45;
  }

  .banner > :global(svg) {
    color: var(--muted);
    margin-top: 2px;
    flex: none;
  }

  .group {
    display: flex;
    align-items: baseline;
    gap: 10px;
    margin: 18px 0 4px;
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: var(--muted);
  }

  .gnote {
    font-weight: 400;
    letter-spacing: 0;
    text-transform: none;
    font-size: 12px;
    opacity: 0.85;
  }

  .kr {
    display: flex;
    align-items: center;
    gap: 10px;
    min-height: 38px;
    padding: 3px 6px 3px 0;
    border-radius: 6px;
    border-top: 1px solid color-mix(in srgb, var(--line) 70%, transparent);
  }

  .group + .kr {
    border-top-color: transparent;
  }

  .kr.recording {
    background: color-mix(in srgb, var(--accent) 5%, transparent);
  }

  /* The row the palette's Alt+Enter opened the page at: lit until the user acts on it (#46). */
  .kr.hl {
    background: var(--hover);
  }

  .kr.conflicted {
    background: color-mix(in srgb, var(--warn) 14%, transparent);
    box-shadow: inset 3px 0 0 var(--warn);
  }

  .dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    flex: none;
    margin-left: 8px;
  }

  .kr.changed .dot {
    background: var(--accent);
  }

  .kt {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 8px;
    white-space: nowrap;
    overflow: hidden;
  }

  .title {
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .from {
    display: inline-flex;
    align-items: center;
    gap: 3px;
    font-size: 11px;
    color: var(--muted);
    border: 1px solid var(--line);
    border-radius: 9px;
    padding: 0 6px;
  }

  .was {
    font-size: 12px;
    color: var(--muted);
  }

  .kk {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 6px;
    flex: none;
  }

  .or {
    font-size: 11px;
    color: var(--muted);
  }

  .none {
    border: none;
    background: none;
    font: inherit;
    font-size: 12px;
    color: var(--muted);
    font-style: italic;
    padding: 0 4px;
  }

  .ka {
    display: flex;
    gap: 2px;
    width: 56px;
    justify-content: flex-end;
    flex: none;
  }

  .ib {
    width: 26px;
    height: 26px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border: none;
    border-radius: 6px;
    background: none;
    color: var(--muted);
  }

  .ib:hover {
    background: var(--selected);
    color: var(--ink);
  }

  /* «+» shows on the row under the pointer or in focus. */
  .kr:not(:hover, :focus-within) .ib.add {
    visibility: hidden;
  }

  .combo {
    display: inline-flex;
    align-items: center;
    gap: 3px;
    padding: 3px 4px;
    border-radius: 6px;
    border: 1px solid transparent;
    background: none;
    font: inherit;
  }

  button.combo:hover,
  button.combo:focus-visible {
    border-color: var(--line);
    background: var(--paper);
  }

  .combo.rec {
    border: 1.5px dashed var(--accent);
    background: color-mix(in srgb, var(--accent) 7%, var(--paper));
    min-width: 150px;
    justify-content: center;
    padding: 3px 8px;
  }

  .combo.pending {
    min-width: 0;
    border-color: var(--warn);
    background: color-mix(in srgb, var(--warn) 10%, var(--paper));
  }

  .combo.flash {
    background: color-mix(in srgb, #f2c94c 35%, transparent);
  }

  .wait {
    font-size: 12px;
    color: var(--accent);
    font-style: italic;
  }

  .cap {
    font: 12px/1 var(--mono);
    min-width: 22px;
    height: 23px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 0 6px;
    border: 1px solid var(--line);
    border-bottom-width: 2px;
    border-radius: 5px;
    color: var(--ink);
    background: var(--paper);
  }

  .plus {
    font-weight: 400;
    color: var(--muted);
    font-size: 11px;
  }

  .rechint,
  .okline {
    font-size: 12px;
    color: var(--muted);
    text-align: right;
    padding: 2px 62px 8px 0;
  }

  .okline {
    color: var(--ok);
    padding-bottom: 6px;
  }

  .link.sp {
    margin-right: 6px;
  }

  .link {
    border: none;
    background: none;
    padding: 0;
    color: var(--link);
    font: inherit;
    text-decoration: underline;
  }

  .kconf {
    display: flex;
    gap: 10px;
    margin: 2px 6px 8px 14px;
    padding: 10px 12px;
    border-radius: 8px;
    border: 1px solid color-mix(in srgb, var(--warn) 40%, var(--paper));
    background: color-mix(in srgb, var(--warn) 10%, var(--paper));
    font-size: 13px;
    line-height: 1.45;
  }

  .kconf > :global(svg) {
    color: var(--warn);
    margin-top: 3px;
    flex: none;
  }

  .kconf.err {
    border-color: color-mix(in srgb, var(--accent) 40%, var(--paper));
    background: color-mix(in srgb, var(--accent) 8%, var(--paper));
  }

  .kconf.err > :global(svg) {
    color: var(--accent);
  }

  .kconf.info {
    border-color: var(--line);
    background: var(--paper-2);
  }

  .kconf.info > :global(svg) {
    color: var(--link);
  }

  .buttons {
    display: flex;
    gap: 6px;
    margin: 8px 0 4px;
    flex-wrap: wrap;
  }

  .note {
    font-size: 12px;
    color: var(--muted);
    line-height: 1.45;
  }

  .more {
    display: flex;
    width: 100%;
    align-items: center;
    gap: 6px;
    margin-top: 14px;
    padding: 8px 6px;
    font: inherit;
    font-size: 13px;
    color: var(--muted);
    border: none;
    border-top: 1px solid var(--line);
    background: none;
    text-align: left;
  }

  .more:hover {
    color: var(--ink);
  }

  .found {
    margin-top: 16px;
    font-size: 12px;
    color: var(--muted);
    line-height: 1.5;
  }
</style>

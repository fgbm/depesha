<script lang="ts">
  import { untrack } from "svelte";
  import { placeMenu, placeSide, type Anchor, type PluginContext, type WhenExtras } from "@depesha/plugin-api";
  import { fmtWhen } from "./format";
  import { SnoozeMenu, type KeyInfo, type MenuEnv, type Outcome } from "./menu.svelte";
  import { Picker } from "./picker.svelte";
  import { S } from "./strings";
  import { sameDay } from "./times";

  // The menu is the snooze menu's, and the reminder's of a letter in writing (#103) borrows it: whoever
  // opens it says what a chosen moment does (`onpick`), how to go away (`onclose`) and, for the
  // reminder, the two rows more (`extras`) with the words of the line and of the calendar's button.
  let {
    ctx,
    ids = [],
    anchor,
    onpick,
    onclose,
    extras,
    texts,
    notBefore,
    onnone,
    onsetup,
  }: {
    ctx: PluginContext;
    /** The messages the moment is for (the snooze menu); none for the reminder's. */
    ids?: number[];
    anchor: Anchor;
    /** The moment chosen, in unix seconds. */
    onpick: (at: number, ids: number[]) => void;
    onclose: () => void;
    extras?: WhenExtras;
    texts?: { placeholder: string; title: string; pick: string };
    /** No moment up to this one (unix seconds) is offered. */
    notBefore?: number;
    onnone?: () => void;
    onsetup?: () => void;
  } = $props();

  // One menu lives for one opening: what it was opened for is read once. The props are getters of
  // the opener's state, which is cleared the moment the menu closes, a step before its choice is
  // handed over: the choice must not read them again.
  const target = untrack(() => ({ ids, anchor, extras, texts, notBefore, onpick, onclose, onnone, onsetup }));
  const now = new Date();
  const env = (): MenuEnv => ({
    now,
    work: ctx.workTime(),
    lang: ctx.lang(),
    say: (key) => ctx.t(S[key as keyof typeof S] as { en: string; ru: string }, {}),
    extras: target.extras,
    after: target.notBefore ? new Date(target.notBefore * 1000) : undefined,
  });

  const menu = new SnoozeMenu(env);
  let picker = $state<Picker | null>(null);

  let root = $state<HTMLDivElement | null>(null);
  let mainEl = $state<HTMLDivElement | null>(null);
  let subEl = $state<HTMLDivElement | null>(null);
  let pickEl = $state<HTMLDivElement | null>(null);
  let input = $state<HTMLInputElement | null>(null);
  let timeInput = $state<HTMLInputElement | null>(null);
  let okButton = $state<HTMLButtonElement | null>(null);
  let pos = $state<{ left: number; top: number; maxHeight: number } | null>(null);
  let subPos = $state<{ left: number; top: number; maxHeight: number } | null>(null);

  const win = () => ({ w: window.innerWidth, h: window.innerHeight });
  const lang = $derived(ctx.lang());
  const work = $derived(ctx.workTime());

  /** The window the menu is in: the list of items, or the calendar. */
  function place() {
    const el = picker ? pickEl : mainEl;
    if (!el) return;
    const p = placeMenu(target.anchor, { w: el.offsetWidth, h: el.scrollHeight }, win());
    pos = { left: p.left, top: p.top, maxHeight: p.maxHeight };
  }

  $effect(() => {
    const el = picker ? pickEl : mainEl;
    if (!el) return;
    const watch = new ResizeObserver(place);
    watch.observe(el);
    place();
    return () => watch.disconnect();
  });

  // The submenu stands beside the row it belongs to, level with it; the parent stays in sight.
  $effect(() => {
    if (!menu.subOpen || !subEl || !mainEl) {
      subPos = null;
      return;
    }
    void menu.subCur;
    const parent = mainEl.getBoundingClientRect();
    const row = mainEl.querySelector<HTMLElement>("[data-row='days']")?.getBoundingClientRect() ?? parent;
    subPos = placeSide({ left: parent.left, right: parent.right, top: row.top, bottom: row.bottom }, { w: subEl.offsetWidth, h: subEl.scrollHeight }, win());
  });

  // The line is always in focus; the calendar takes the focus to the part being used.
  $effect(() => {
    if (!picker) input?.focus({ preventScroll: true });
  });

  function focusPicker() {
    if (!picker) return;
    if (picker.focus === "time") {
      timeInput?.focus();
      timeInput?.select();
    } else if (picker.focus === "ok") okButton?.focus();
    else pickEl?.focus({ preventScroll: true });
  }

  $effect(() => {
    if (picker) {
      void picker.focus;
      focusPicker();
    }
  });

  function apply(out: Outcome) {
    if (out.type === "pick") {
      target.onclose();
      target.onpick(Math.floor(out.at.getTime() / 1000), target.ids);
    } else if (out.type === "custom") picker = new Picker(env);
    else if (out.type === "none") {
      target.onclose();
      target.onnone?.();
    } else if (out.type === "setup") {
      target.onclose();
      target.onsetup?.();
    } else if (out.type === "back") picker = null;
    else if (out.type === "close") target.onclose();
  }

  // Capture: the menu takes every key before the app's own keys (j, k, h…) see it.
  function onKey(e: KeyboardEvent) {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    e.stopPropagation();
    if (e.key === "Tab" && !picker) {
      e.preventDefault();
      return;
    }
    const info: KeyInfo = {
      // A named key is its own code; a digit without one is the digit of the top row.
      code: e.code || (/^\d$/.test(e.key) ? `Digit${e.key}` : e.key),
      key: e.key,
      shift: e.shiftKey,
      atEnd: !input || (input.selectionStart === input.value.length && input.selectionEnd === input.value.length),
    };
    if (!picker && document.activeElement !== input) input?.focus({ preventScroll: true });
    const out = picker ? picker.key(info) : menu.key(info);
    if (out) {
      e.preventDefault();
      apply(out);
    }
    // A digit moves the calendar to the time field before the digit lands in it.
    if (picker?.focus === "time" && document.activeElement !== timeInput) {
      timeInput?.focus();
      timeInput?.select();
    }
  }

  function outside(e: PointerEvent) {
    const t = e.target as Element | null;
    // The button that opened the menu closes it by itself.
    if (t && !root?.contains(t) && !t.closest("[data-snooze-button]")) target.onclose();
  }

  const WEEKDAYS = [1, 2, 3, 4, 5, 6, 7];
  const weekday = (iso: number) => new Intl.DateTimeFormat(lang, { weekday: "short" }).format(new Date(2024, 0, iso));
  const title = (d: Date) => new Intl.DateTimeFormat(lang, { month: "long", year: "numeric" }).format(d).replace(/\s*г\.$/, "");
  const dayNames = $derived(WEEKDAYS.map(weekday));
  const clock = (c: { h: number; m: number }) => `${c.h}:${String(c.m).padStart(2, "0")}`;
  const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate());
</script>

<svelte:window onkeydowncapture={onKey} onpointerdowncapture={outside} onresize={place} />

<div class="snooze" bind:this={root}>
  {#if !picker}
    <div
      class="pop main"
      bind:this={mainEl}
      role="presentation"
      style:left={pos ? `${pos.left}px` : "0"}
      style:top={pos ? `${pos.top}px` : "0"}
      style:max-height={pos ? `${pos.maxHeight}px` : undefined}
      style:visibility={pos ? "visible" : "hidden"}
    >
      <div class="qrow">
        <input
          bind:this={input}
          value={menu.q}
          oninput={(e) => menu.setQuery(e.currentTarget.value)}
          placeholder={target.texts?.placeholder ?? ctx.t(S.placeholder)}
          role="combobox"
          aria-expanded="true"
          aria-controls="snooze-list"
          aria-activedescendant={menu.cur >= 0 ? `snooze-r${menu.cur}` : undefined}
          aria-label={target.texts?.title ?? ctx.t(S.menuTitle)}
          autocomplete="off"
          spellcheck="false"
        />
      </div>
      {#if menu.note}<div class="msg" class:err={menu.note.bad}>{menu.note.text}</div>{/if}
      <div class="list" id="snooze-list" role="listbox" aria-label={ctx.t(S.action)}>
        {#each menu.rows as r, i (r.id)}
          <button
            type="button"
            id="snooze-r{i}"
            class="mi"
            class:cur={i === menu.cur && !menu.subOpen}
            class:parent={i === menu.cur && menu.subOpen}
            class:dis={r.off}
            data-row={r.id}
            role="option"
            tabindex="-1"
            aria-selected={i === menu.cur}
            aria-disabled={r.off}
            onmousedown={(e) => e.preventDefault()}
            onmousemove={() => menu.hover(i)}
            onclick={() => apply(menu.click(i))}
          >
            {#if target.extras}<span class="tick">{#if r.tick}✓{/if}</span>{/if}
            <span class="lab">{r.label}</span>
            {#if r.hint}<span class="hint">{r.hint}</span>{/if}
            {#if r.key}<kbd>{r.key}</kbd>{/if}
            {#if r.kind === "sub"}<span class="chev">›</span>{/if}
          </button>
          {#if r.id === "parsed" || (r.id === "custom" && target.extras)}<hr />{/if}
        {/each}
      </div>
      <div class="foot">
        <span>{ctx.t(S.dayTimes, { day: clock(work.day), evening: clock(work.evening) })}</span>
        <span class="fk">{ctx.t(S.inSettings)}</span>
      </div>
    </div>
    {#if menu.subOpen}
      <div
        class="pop subm"
        bind:this={subEl}
        role="presentation"
        style:left={subPos ? `${subPos.left}px` : "0"}
        style:top={subPos ? `${subPos.top}px` : "0"}
        style:max-height={subPos ? `${subPos.maxHeight}px` : undefined}
        style:visibility={subPos ? "visible" : "hidden"}
      >
        <div class="mt">{ctx.t(S.days)}</div>
        {#each menu.days as d, i (d.iso)}
          <button
            type="button"
            class="mi"
            class:cur={i === menu.subCur}
            data-day={d.iso}
            role="option"
            tabindex="-1"
            aria-selected={i === menu.subCur}
            onmousedown={(e) => e.preventDefault()}
            onmousemove={() => (menu.subCur = i)}
            onclick={() => apply(menu.clickDay(i))}
          >
            <span class="lab">{new Intl.DateTimeFormat(lang, { weekday: "long" }).format(d.at).replace(/^./, (c) => c.toUpperCase())}</span>
            <span class="hint">{new Intl.DateTimeFormat(lang, { day: "numeric", month: "short" }).format(d.at).replace(/\./g, "")}</span>
            <kbd>{d.iso}</kbd>
          </button>
        {/each}
      </div>
    {/if}
  {:else}
    {@const t = picker.target}
    <div
      class="pop pick"
      bind:this={pickEl}
      tabindex="-1"
      role="dialog"
      aria-label={ctx.t(S.pickTitle)}
      style:left={pos ? `${pos.left}px` : "0"}
      style:top={pos ? `${pos.top}px` : "0"}
      style:max-height={pos ? `${pos.maxHeight}px` : undefined}
      style:visibility={pos ? "visible" : "hidden"}
    >
      <div class="ph">{ctx.t(S.pickTitle)}</div>
      <div class="cal" class:focus={picker.focus === "cal"}>
        <div class="cm">
          <button type="button" tabindex="-1" aria-label={ctx.t(S.prevMonth)} onmousedown={(e) => e.preventDefault()} onclick={() => picker?.shiftMonth(-1)}>‹</button>
          <b>{title(picker.day)}</b>
          <button type="button" tabindex="-1" aria-label={ctx.t(S.nextMonthStep)} onmousedown={(e) => e.preventDefault()} onclick={() => picker?.shiftMonth(1)}>›</button>
        </div>
        <div class="cg">
          {#each dayNames as name (name)}<div class="wh">{name}</div>{/each}
          {#each picker.weeks as d (d.getTime())}
            <button
              type="button"
              class="d"
              class:out={d.getMonth() !== picker.day.getMonth()}
              class:past={d < midnight}
              class:today={sameDay(d, now)}
              class:cur={sameDay(d, picker.day)}
              tabindex="-1"
              onmousedown={(e) => e.preventDefault()}
              onclick={() => picker?.select(d)}>{d.getDate()}</button
            >
          {/each}
        </div>
      </div>
      <div class="trow">
        <label for="snooze-time">{ctx.t(S.time)}</label>
        <input
          id="snooze-time"
          class="tin"
          bind:this={timeInput}
          value={picker.time}
          oninput={(e) => picker && (picker.time = e.currentTarget.value)}
          onfocus={() => picker && (picker.focus = "time")}
          autocomplete="off"
        />
        <span class="muted">{ctx.t(S.timeKeys)}</span>
      </div>
      <div class="prev" class:err={!!t.error}>
        {#if t.error === "format"}{ctx.t(S.timeFormat)}{:else if t.error === "passed"}{ctx.t(S.timePassed)}: {fmtWhen(t.at, lang)}{:else}→ {fmtWhen(t.at, lang)}{/if}
      </div>
      <div class="pf">
        <button type="button" class="btn small" tabindex="-1" onclick={() => apply({ type: "back" })}>{ctx.t(S.cancel)}</button>
        <button
          type="button"
          class="btn small primary"
          class:focus={picker.focus === "ok"}
          bind:this={okButton}
          disabled={!!t.error}
          tabindex="-1"
          onclick={() => picker && apply(picker.confirm())}>{target.texts?.pick ?? ctx.t(S.action)}</button
        >
      </div>
      <div class="pk">{ctx.t(S.calKeys)}</div>
    </div>
  {/if}
</div>

<style>
  .pop {
    position: fixed;
    z-index: 45;
    overflow-y: auto;
    background: var(--paper);
    color: var(--ink);
    border: 1px solid var(--line);
    border-radius: 8px;
    box-shadow: 0 10px 28px rgb(0 0 0 / 18%);
    padding: 4px;
    font-size: 14px;
    outline: none;
  }

  .main,
  .pick {
    width: 372px;
    max-width: calc(100vw - 16px);
  }

  .subm {
    width: 262px;
  }

  .mt {
    padding: 6px 10px 2px;
    font-size: 12px;
    color: var(--muted);
  }

  hr {
    border: none;
    border-top: 1px solid var(--line);
    margin: 4px 2px;
  }

  .tick {
    width: 14px;
    flex: none;
    color: var(--accent);
  }

  .mi {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    border: none;
    background: none;
    color: var(--ink);
    text-align: left;
    padding: 6px 10px;
    border-radius: 5px;
    white-space: nowrap;
    cursor: default;
  }

  .mi .lab {
    flex: 1;
  }

  .mi .hint {
    color: var(--muted);
    font-size: 12px;
  }

  .mi .chev {
    color: var(--muted);
  }

  .mi:hover {
    background: var(--hover);
  }

  .mi.cur {
    background: var(--selected);
  }

  .mi.parent {
    background: var(--selected);
    box-shadow: inset 3px 0 0 var(--accent);
  }

  .mi.dis {
    opacity: 0.45;
  }

  .mi kbd {
    min-width: 20px;
    text-align: center;
  }

  .msg {
    padding: 4px 10px 6px;
    color: var(--muted);
    font-size: 12.5px;
    line-height: 1.45;
  }

  .msg.err {
    color: var(--accent);
  }

  .qrow {
    padding: 2px 2px 4px;
  }

  .qrow input {
    width: 100%;
    font: inherit;
    font-size: 13.5px;
    color: var(--ink);
    background: var(--paper-2);
    border: 1px solid var(--line);
    border-radius: 6px;
    padding: 6px 10px;
    outline: none;
  }

  .qrow input:focus,
  .trow input:focus {
    border-color: var(--link);
    box-shadow: 0 0 0 2px color-mix(in srgb, var(--link) 25%, transparent);
  }

  .foot {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 10px 4px;
    border-top: 1px solid var(--line);
    margin-top: 4px;
    font-size: 12px;
    color: var(--muted);
  }

  .foot .fk {
    margin-left: auto;
  }

  .pick {
    padding: 8px;
  }

  .ph {
    font-weight: 600;
    padding: 0 2px 6px;
  }

  .cal {
    border: 1px solid transparent;
    border-radius: 6px;
    padding: 4px;
  }

  .cal.focus {
    border-color: var(--link);
    box-shadow: 0 0 0 2px color-mix(in srgb, var(--link) 25%, transparent);
  }

  .cm {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0 4px 6px;
  }

  .cm button {
    border: none;
    background: none;
    color: inherit;
    padding: 0 8px;
    border-radius: 4px;
    cursor: pointer;
  }

  .cm button:hover {
    background: var(--hover);
  }

  .cg {
    display: grid;
    grid-template-columns: repeat(7, 1fr);
    gap: 2px;
    text-align: center;
  }

  .wh {
    font-size: 11px;
    color: var(--muted);
    padding: 2px 0;
  }

  .d {
    border: none;
    background: none;
    color: inherit;
    font: inherit;
    padding: 5px 0;
    border-radius: 5px;
    cursor: pointer;
  }

  .d:hover {
    background: var(--hover);
  }

  .d.out {
    color: var(--muted);
    opacity: 0.55;
  }

  .d.past {
    color: var(--muted);
    opacity: 0.4;
    text-decoration: line-through;
    text-decoration-thickness: 1px;
  }

  .d.today {
    box-shadow: inset 0 0 0 1px var(--muted);
  }

  .d.cur {
    background: var(--accent);
    color: var(--accent-ink);
    opacity: 1;
    font-weight: 600;
    text-decoration: none;
  }

  .trow {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 4px 2px;
  }

  .trow input {
    width: 76px;
    font: inherit;
    font-size: 14px;
    text-align: center;
    background: var(--paper-2);
    color: var(--ink);
    border: 1px solid var(--line);
    border-radius: 6px;
    padding: 4px 6px;
    outline: none;
  }

  .muted {
    color: var(--muted);
    font-size: 12px;
  }

  .prev {
    padding: 8px 4px 4px;
    font-weight: 600;
  }

  .prev.err {
    color: var(--accent);
  }

  .pf {
    display: flex;
    justify-content: flex-end;
    gap: 6px;
    padding: 4px 2px 2px;
  }

  .btn.focus {
    box-shadow: 0 0 0 2px color-mix(in srgb, var(--link) 55%, transparent);
  }

  .pk {
    color: var(--muted);
    font-size: 12px;
    padding: 6px 4px 2px;
    border-top: 1px solid var(--line);
    margin-top: 6px;
    line-height: 1.7;
  }
</style>

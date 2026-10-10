<script lang="ts">
  import { t } from "../lib/i18n.svelte";
  import { api } from "../lib/api";
  import { addrFull, parseAddr } from "../lib/format";
  import Popover from "./Popover.svelte";
  import type { Addr } from "../lib/types";
  import type { Suggestion } from "../lib/people";
  import type { Snippet } from "svelte";

  let {
    label,
    value = $bindable(),
    autofocus = false,
    card,
    trailing,
  }: {
    label: string;
    value: Addr[];
    autofocus?: boolean;
    /** The person's card, opened by a click on the chip of an address (#66, frame 13). */
    card?: Snippet<[string]>;
    /** What stands at the end of the row: the links to «Cc» and «Bcc» beside «To» (#103). */
    trailing?: Snippet;
  } = $props();

  let text = $state("");
  let suggestions = $state<Suggestion[]>([]);
  let active = $state(0);
  /** Which address of each suggested person is on offer: the primary one until ←/→ turn to another (#104, 4.1 А). */
  let which = $state<number[]>([]);
  let invalid = $state(false);
  let input = $state<HTMLInputElement | null>(null);
  /** Which chip's card is open, by its address. */
  let cardAt = $state<string | null>(null);
  let timer: ReturnType<typeof setTimeout> | null = null;

  /** The caret goes to the field: Alt+C and Alt+B open a field and stand in it. */
  export function focus() {
    input?.focus();
  }

  /** The caret is in this field. */
  export function hasFocus(): boolean {
    return !!input && document.activeElement === input;
  }

  /** Something is typed and not yet a chip: a field with it is not folded by its key. */
  export function hasText(): boolean {
    return text.trim() !== "";
  }

  /** Turns typed text into chips; returns false when something could not be parsed. */
  export function commit(): boolean {
    const parts = text.split(/[,;\n]/).map((p) => p.trim()).filter(Boolean);
    const rest: string[] = [];
    for (const p of parts) {
      const a = parseAddr(p);
      if (a && !value.some((v) => v.email.toLowerCase() === a.email.toLowerCase())) value.push(a);
      else if (!a) rest.push(p);
    }
    text = rest.join(", ");
    invalid = rest.length > 0;
    suggestions = [];
    return rest.length === 0;
  }

  function onInput() {
    invalid = false;
    if (/[,;]\s*$/.test(text)) {
      commit();
      return;
    }
    if (timer) clearTimeout(timer);
    const prefix = text.trim();
    if (prefix.length < 2) {
      suggestions = [];
      return;
    }
    timer = setTimeout(async () => {
      try {
        const found = await api.addresses(prefix);
        suggestions = found.filter((a) => !a.emails.every((e) => value.some((v) => v.email.toLowerCase() === e.toLowerCase())));
        which = suggestions.map(() => 0);
        active = 0;
      } catch {
        // A failing lookup offers no suggestions; typing goes on.
        suggestions = [];
      }
    }, 120);
  }

  /** The address of the suggested person that is on offer now. */
  function offered(i: number): string {
    const s = suggestions[i];
    const list = s.emails.filter((e) => !value.some((v) => v.email.toLowerCase() === e.toLowerCase()));
    return list[(which[i] ?? 0) % list.length] ?? s.email;
  }

  function pick(i: number) {
    const s = suggestions[i];
    value.push({ name: s.name, email: offered(i) });
    text = "";
    suggestions = [];
    input?.focus();
  }

  function onKey(e: KeyboardEvent) {
    if (suggestions.length && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
      e.preventDefault();
      active = (active + (e.key === "ArrowDown" ? 1 : suggestions.length - 1)) % suggestions.length;
    } else if (suggestions.length && (e.key === "ArrowRight" || e.key === "ArrowLeft") && suggestions[active].emails.length > 1) {
      e.preventDefault();
      const n = suggestions[active].emails.filter((x) => !value.some((v) => v.email.toLowerCase() === x.toLowerCase())).length;
      which[active] = ((which[active] ?? 0) + (e.key === "ArrowRight" ? 1 : n - 1)) % n;
    } else if (e.key === "Enter" || e.key === "Tab") {
      if (suggestions.length && text.trim()) {
        e.preventDefault();
        pick(active);
      } else if (text.trim()) {
        if (e.key === "Enter") e.preventDefault();
        commit();
      }
    } else if (e.key === "Backspace" && text === "" && value.length) {
      value.pop();
    } else if (e.key === "Escape" && suggestions.length) {
      e.stopPropagation();
      suggestions = [];
    }
  }
</script>

<div class="row">
  <span class="label">{label}</span>
  <div class="box" class:invalid>
    {#each value as a, i (a.email)}
      <span class="chip" title={a.email}>
        {#if card}
          <button class="name" onclick={() => (cardAt = cardAt === a.email ? null : a.email)}>{addrFull(a)}</button>
          <Popover bind:open={() => cardAt === a.email, (v) => (cardAt = v ? a.email : null)}>
            {@render card(a.email)}
          </Popover>
        {:else}
          {addrFull(a)}
        {/if}
        <button onclick={() => value.splice(i, 1)} aria-label={t("remove")}>×</button>
      </span>
    {/each}
    <!-- svelte-ignore a11y_autofocus -->
    <input
      bind:this={input}
      bind:value={text}
      oninput={onInput}
      onkeydown={onKey}
      onblur={() => setTimeout(() => text.trim() && commit(), 150)}
      {autofocus}
      spellcheck="false"
    />
    {#if suggestions.length}
      <div class="suggest">
        {#each suggestions as s, i (s.email)}
          <button class:active={i === active} onmousedown={(e) => { e.preventDefault(); pick(i); }}>
            {#if s.name}<b>{s.name}</b> {/if}<span class="muted">{offered(i)}</span>
            {#if s.emails.length > 1}<span class="more muted small">+{s.emails.length - 1}</span>{/if}
          </button>
        {/each}
      </div>
    {/if}
  </div>
  {@render trailing?.()}
</div>

<style>
  .row {
    display: flex;
    align-items: flex-start;
    gap: 8px;
    border-bottom: 1px solid var(--line);
    padding: 4px 0;
  }

  .label {
    width: 64px;
    color: var(--muted);
    padding-top: 6px;
    flex: none;
  }

  .box {
    position: relative;
    flex: 1;
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    align-items: center;
    min-height: 30px;
  }

  .box.invalid input {
    color: var(--accent);
  }

  .chip {
    display: inline-flex;
    align-items: center;
    gap: 2px;
    background: var(--hover);
    border-radius: 12px;
    padding: 2px 4px 2px 10px;
    font-size: 13px;
    user-select: text;
  }

  .chip button {
    border: none;
    background: none;
    color: var(--muted);
    padding: 0 4px;
  }

  .chip .name {
    color: inherit;
    font: inherit;
    padding: 0;
  }

  .chip .name:hover {
    text-decoration: underline;
  }

  input {
    flex: 1;
    min-width: 160px;
    border: none;
    outline: none;
    background: transparent;
    padding: 5px 2px;
  }

  .suggest {
    position: absolute;
    top: 100%;
    left: 0;
    z-index: 5;
    background: var(--paper);
    border: 1px solid var(--line);
    border-radius: 8px;
    /* Drawn like Popover.svelte: one look for every drop-down. */
    box-shadow: 0 10px 28px rgb(0 0 0 / 18%);
    display: flex;
    flex-direction: column;
    min-width: 320px;
    padding: 4px;
  }

  .suggest button {
    border: none;
    background: none;
    text-align: left;
    padding: 6px 10px;
    border-radius: 5px;
  }

  .more {
    margin-left: 6px;
    font-size: 11.5px;
  }

  .suggest button.active,
  .suggest button:hover {
    background: var(--hover);
  }
</style>

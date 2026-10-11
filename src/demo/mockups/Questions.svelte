<script lang="ts">
  // The «Вопросы» panel of the live mockup: the questions of the release, their options and
  // the notes, laid over the app. The look and the logic follow `design/mockups/_kit/answers.js`
  // (the HTML mockups' panel): numbered questions, option chips, a «свой» answer, a comment,
  // notes, and «Скопировать ответы» for the operator to paste back.
  //
  // The default of every question is «как сейчас»; the recommended option is starred but not
  // chosen — an unanswered question must look unanswered. The panel is mounted by
  // `src/demo/start.ts` only in `demo` mode, so neither it nor `variants` reaches the app.

  import { onMount } from "svelte";
  import { NOW, variant, variants, type Question } from "../variants.svelte";
  import { QUESTIONS } from "./0.8.3";

  const VERSION = "0.8.3";

  let note = $state("");
  let copied = $state(false);

  /** Whether the focused element takes text: the panel's toggle key must not fire while typing. */
  function typing(target: EventTarget | null): boolean {
    const el = target as HTMLElement | null;
    if (!el) return false;
    return el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable;
  }

  function onKey(e: KeyboardEvent) {
    if (e.code !== "Backquote" || e.ctrlKey || e.altKey || e.metaKey) return;
    if (typing(e.target)) return;
    e.preventDefault();
    variants.open = !variants.open;
  }

  /** The option shown for a question: the chosen one, or `now`. */
  function shown(q: Question): string {
    return variant(q.id);
  }

  /** The panel's words for the operator: the answers, the notes, and what is unanswered. */
  function summary(): string {
    const out = [`Макет: ${VERSION}`];
    const missing: string[] = [];
    for (const q of QUESTIONS) {
      const option = shown(q);
      if (option === NOW) missing.push(q.id);
      else out.push(`${q.id} ${option} — ${q.options.find((o) => o.id === option)?.title ?? option}`);
    }
    if (missing.length) out.push(`Без ответа: ${missing.join(", ")}`);
    for (const n of variants.notes) out.push(`Заметка: ${n}`);
    return out.join("\n");
  }

  async function copy() {
    const text = summary();
    try {
      await navigator.clipboard.writeText(text);
      copied = true;
      setTimeout(() => (copied = false), 1500);
    } catch {
      // Clipboard refused: the summary is in the DOM, ready to select by hand.
    }
  }

  const answered = $derived(QUESTIONS.filter((q) => shown(q) !== NOW).length);

  onMount(() => {
    variants.init();
    if (innerWidth < 1100) variants.open = false;
  });
</script>

<svelte:window onkeydown={onKey} />

{#if variants.open}
  <aside class="qs" aria-label="Вопросы макета">
    <header class="qs-head">
      <b>Вопросы</b>
      <span class="qs-file">{VERSION}</span>
      <button type="button" onclick={() => (variants.open = false)} title="Свернуть (клавиша `)">Свернуть</button>
    </header>
    <p class="qs-hint"><kbd>`</kbd> панель · по умолчанию «как сейчас» · ★ — рекомендация, не выбранная сама</p>

    <div class="qs-scroll">
      {#if QUESTIONS.length === 0}
        <p class="qs-empty">Вопросов пока нет: этот шаг собирает механизм вариантов, вопросы 0.8.3 придут следующим.</p>
      {:else}
        <ol class="qs-list">
          {#each QUESTIONS as q (q.id)}
            <li class="qs-item" class:done={shown(q) !== NOW}>
              <div class="qs-line"><span class="qs-num">{q.id}</span><span class="qs-ttl">{q.title}</span></div>
              <div class="qs-vs">
                {#each q.options as o (o.id)}
                  <button type="button" class:on={shown(q) === o.id} onclick={() => variants.set(q.id, o.id)}>
                    {o.id}{o.recommended ? " ★" : ""}
                  </button>
                {/each}
                <button type="button" class:on={shown(q) === NOW} onclick={() => variants.clear(q.id)}>как сейчас</button>
              </div>
            </li>
          {/each}
        </ol>
      {/if}

      <div class="qs-sec">Заметки</div>
      {#if variants.notes.length === 0}
        <p class="qs-empty">Нет заметок.</p>
      {/if}
      <ul class="qs-notes">
        {#each variants.notes as n, i (i)}
          <li>{n}</li>
        {/each}
      </ul>
      <form
        class="qs-note-add"
        onsubmit={(e) => {
          e.preventDefault();
          variants.addNote(note);
          note = "";
        }}
      >
        <input bind:value={note} placeholder="Заметка…" aria-label="Новая заметка" />
        <button type="submit">Добавить</button>
      </form>
    </div>

    <footer class="qs-foot">
      <div class="qs-count">отвечено {answered} из {QUESTIONS.length}</div>
      <textarea class="qs-sum" readonly aria-label="Сводка ответов" value={summary()}></textarea>
      <button type="button" class="qs-copy" onclick={copy}>{copied ? "Скопировано" : "Скопировать ответы"}</button>
    </footer>
  </aside>
{:else}
  <button type="button" class="qs-tab" onclick={() => (variants.open = true)} title="Открыть панель (клавиша `)">
    Вопросы · {answered}/{QUESTIONS.length}
  </button>
{/if}

<style>
  .qs {
    position: fixed;
    top: 0;
    right: 0;
    z-index: 80;
    width: 372px;
    height: 100vh;
    display: flex;
    flex-direction: column;
    background: var(--paper, #fff);
    color: var(--ink, #1d232b);
    border-left: 1px solid var(--line, #d9dde3);
    box-shadow: -8px 0 24px rgba(0, 0, 0, 0.08);
    font: 13px/1.45 system-ui, "Segoe UI", Roboto, Arial, sans-serif;
  }

  .qs-head {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 10px 12px;
    border-bottom: 1px solid var(--line, #d9dde3);
  }

  .qs-head b {
    font-size: 14px;
  }

  .qs-file {
    color: var(--muted, #667);
    margin-right: auto;
  }

  .qs-head button,
  .qs-foot button,
  .qs-note-add button {
    border: 1px solid var(--line, #d9dde3);
    border-radius: 6px;
    background: var(--paper-2, #f6f7f8);
    color: inherit;
    padding: 3px 8px;
    cursor: pointer;
  }

  .qs-hint {
    margin: 0;
    padding: 8px 12px;
    color: var(--muted, #667);
    border-bottom: 1px solid var(--line, #d9dde3);
  }

  .qs-scroll {
    flex: 1;
    overflow-y: auto;
    padding: 10px 12px;
  }

  .qs-empty {
    color: var(--muted, #667);
    margin: 4px 0 12px;
  }

  .qs-list {
    list-style: none;
    margin: 0 0 12px;
    padding: 0;
  }

  .qs-item {
    padding: 8px 0;
    border-bottom: 1px solid var(--line, #d9dde3);
  }

  .qs-item.done .qs-num {
    background: var(--accent, #3d7ea6);
    color: #fff;
  }

  .qs-line {
    display: flex;
    gap: 8px;
    align-items: baseline;
  }

  .qs-num {
    flex: none;
    min-width: 28px;
    text-align: center;
    border-radius: 4px;
    background: var(--hover, #eef1f4);
    padding: 1px 5px;
    font-variant-numeric: tabular-nums;
  }

  .qs-vs {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin-top: 6px;
  }

  .qs-vs button.on {
    background: var(--accent, #3d7ea6);
    color: #fff;
    border-color: var(--accent, #3d7ea6);
  }

  .qs-sec {
    font-weight: 600;
    margin: 10px 0 4px;
  }

  .qs-notes {
    margin: 0 0 8px;
    padding-left: 18px;
  }

  .qs-note-add {
    display: flex;
    gap: 6px;
  }

  .qs-note-add input {
    flex: 1;
    min-width: 0;
    border: 1px solid var(--line, #d9dde3);
    border-radius: 6px;
    padding: 3px 8px;
  }

  .qs-foot {
    border-top: 1px solid var(--line, #d9dde3);
    padding: 8px 12px;
  }

  .qs-count {
    color: var(--muted, #667);
    margin-bottom: 6px;
  }

  .qs-sum {
    width: 100%;
    height: 84px;
    resize: vertical;
    border: 1px solid var(--line, #d9dde3);
    border-radius: 6px;
    padding: 6px 8px;
    font: inherit;
  }

  .qs-copy {
    margin-top: 6px;
    width: 100%;
  }

  .qs-tab {
    position: fixed;
    right: 12px;
    bottom: 12px;
    z-index: 80;
    border: 1px solid var(--line, #d9dde3);
    border-radius: 999px;
    background: var(--paper, #fff);
    color: var(--ink, #1d232b);
    padding: 6px 14px;
    box-shadow: 0 2px 10px rgba(0, 0, 0, 0.12);
    cursor: pointer;
  }
</style>

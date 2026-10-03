<script lang="ts">
  import Trash from "@lucide/svelte/icons/trash-2";
  import Plus from "@lucide/svelte/icons/plus";
  import { app } from "../lib/store.svelte";
  import type { Settings } from "../lib/types";

  let draft = $state<Settings>(structuredClone($state.snapshot(app.settings)));

  async function save() {
    draft.templates = draft.templates.filter((t) => t.name.trim() || t.text.trim());
    await app.saveSettings($state.snapshot(draft));
    app.settingsOpen = false;
  }

  function onKey(e: KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      app.settingsOpen = false;
    }
  }
</script>

<div class="modal-backdrop" role="presentation">
  <div class="modal prefs" role="dialog" aria-label="Настройки" tabindex="-1" onkeydown={onKey}>
    <header><h3>Настройки</h3></header>
    <div class="content">
      <section>
        <h4>Уведомления</h4>
        <label class="radio"><input type="radio" bind:group={draft.notify} value="people" /> Только о письмах от людей <span class="muted">— рассылки и роботы не отвлекают</span></label>
        <label class="radio"><input type="radio" bind:group={draft.notify} value="all" /> Обо всех новых письмах</label>
        <label class="radio"><input type="radio" bind:group={draft.notify} value="none" /> Не показывать</label>
        <p class="muted small">Режим «Не беспокоить» включается колокольчиком внизу боковой панели.</p>
      </section>

      <section>
        <h4>Отправка</h4>
        <label class="row">
          Можно отменить отправку в течение
          <select class="input" bind:value={draft.undo_send_secs}>
            <option value={0}>не ждать</option>
            <option value={5}>5 секунд</option>
            <option value={10}>10 секунд</option>
            <option value={20}>20 секунд</option>
            <option value={30}>30 секунд</option>
          </select>
        </label>
      </section>

      <section>
        <h4>Список писем</h4>
        <label class="radio"><input type="checkbox" bind:checked={draft.threads} /> Собирать переписку в цепочки</label>
      </section>

      <section>
        <h4>Шаблоны ответов</h4>
        <p class="muted small">Готовые тексты для типовых писем. Вставляются кнопкой «Шаблоны» в окне письма.</p>
        {#each draft.templates as t, i (i)}
          <div class="tpl">
            <div class="tpl-head">
              <input class="input" bind:value={t.name} placeholder="Название, например «Счёт получен»" />
              <button class="btn ghost" onclick={() => draft.templates.splice(i, 1)} aria-label="Удалить шаблон"><Trash size={15} /></button>
            </div>
            <textarea class="input" rows="3" bind:value={t.text} placeholder="Текст шаблона"></textarea>
          </div>
        {/each}
        <button class="btn" onclick={() => draft.templates.push({ name: "", text: "" })}><Plus size={15} /> Добавить шаблон</button>
      </section>
    </div>
    <footer>
      <span class="spacer"></span>
      <button class="btn ghost" onclick={() => (app.settingsOpen = false)}>Отмена</button>
      <button class="btn primary" onclick={save}>Сохранить</button>
    </footer>
  </div>
</div>

<style>
  .prefs {
    width: min(640px, calc(100vw - 40px));
    max-height: calc(100vh - 60px);
  }

  header {
    padding: 14px 20px 4px;
  }

  h3 {
    margin: 0;
  }

  .content {
    overflow-y: auto;
    padding: 0 20px 10px;
  }

  section {
    padding: 12px 0;
    border-bottom: 1px solid var(--line);
  }

  section:last-child {
    border-bottom: none;
  }

  h4 {
    margin: 0 0 8px;
    font-size: 14px;
  }

  .radio {
    display: block;
    padding: 3px 0;
  }

  .row {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .small {
    font-size: 12px;
  }

  .tpl {
    display: flex;
    flex-direction: column;
    gap: 6px;
    margin-bottom: 10px;
  }

  .tpl-head {
    display: flex;
    gap: 6px;
  }

  .tpl-head .input {
    flex: 1;
  }

  textarea {
    resize: vertical;
    font: inherit;
  }

  footer {
    display: flex;
    gap: 8px;
    padding: 10px 20px 14px;
    border-top: 1px solid var(--line);
  }

  .spacer {
    flex: 1;
  }
</style>

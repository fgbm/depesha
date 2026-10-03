<script lang="ts">
  import Trash from "@lucide/svelte/icons/trash-2";
  import Plus from "@lucide/svelte/icons/plus";
  import { app } from "../lib/store.svelte";
  import { t, tn } from "../lib/i18n.svelte";
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
  <div class="modal prefs" role="dialog" aria-label={t("settings.title")} tabindex="-1" onkeydown={onKey}>
    <header><h3>{t("settings.title")}</h3></header>
    <div class="content">
      <section>
        <h4>{t("settings.language")}</h4>
        <label class="radio"><input type="radio" bind:group={draft.language} value="auto" /> {t("settings.languageAuto")}</label>
        <label class="radio"><input type="radio" bind:group={draft.language} value="en" /> English</label>
        <label class="radio"><input type="radio" bind:group={draft.language} value="ru" /> Русский</label>
      </section>

      <section>
        <h4>{t("settings.notifications")}</h4>
        <label class="radio"><input type="radio" bind:group={draft.notify} value="people" /> {t("settings.notifyPeople")} <span class="muted">{t("settings.notifyPeopleNote")}</span></label>
        <label class="radio"><input type="radio" bind:group={draft.notify} value="all" /> {t("settings.notifyAll")}</label>
        <label class="radio"><input type="radio" bind:group={draft.notify} value="none" /> {t("settings.notifyNone")}</label>
        <p class="muted small">{t("settings.dndNote")}</p>
      </section>

      <section>
        <h4>{t("settings.sending")}</h4>
        <label class="row">
          {t("settings.undoSend")}
          <select class="input" bind:value={draft.undo_send_secs}>
            <option value={0}>{t("settings.noWait")}</option>
            {#each [5, 10, 20, 30] as secs (secs)}<option value={secs}>{tn("settings.seconds", secs)}</option>{/each}
          </select>
        </label>
      </section>

      <section>
        <h4>{t("settings.list")}</h4>
        <label class="radio"><input type="checkbox" bind:checked={draft.threads} /> {t("settings.threads")}</label>
      </section>

      <section>
        <h4>{t("settings.updates")}</h4>
        <label class="radio"><input type="radio" bind:group={draft.updates} value="auto" /> {t("settings.updatesAuto")} <span class="muted">{t("settings.updatesAutoNote")}</span></label>
        <label class="radio"><input type="radio" bind:group={draft.updates} value="notify" /> {t("settings.updatesNotify")}</label>
        <label class="radio"><input type="radio" bind:group={draft.updates} value="off" /> {t("settings.updatesOff")}</label>
        <div class="row update-row">
          <div class="muted small status">
            <div>{t("settings.installed", { version: app.update?.current ?? "—" })}</div>
            {#if app.update?.state === "checking"}<div>{t("settings.checking")}</div>
            {:else if app.update?.state === "error"}<div class="danger-text">{app.update.error}</div>
            {:else if app.update?.version}<div>{t("update.available", { version: app.update.version })}.</div>
            {/if}
            {#if app.update?.install === "package"}<div>{t("settings.packageNote")}</div>{/if}
            {#if app.update?.install === "unsupported"}<div>{t("settings.unsupportedNote")}</div>{/if}
          </div>
          <button class="btn" onclick={() => app.checkUpdates()} disabled={app.update?.state === "checking"}>{t("settings.checkNow")}</button>
        </div>
        <p class="muted small">{t("settings.signedNote")}</p>
      </section>

      <section>
        <h4>{t("settings.templates")}</h4>
        <p class="muted small">{t("settings.templatesNote")}</p>
        {#each draft.templates as tpl, i (i)}
          <div class="tpl">
            <div class="tpl-head">
              <input class="input" bind:value={tpl.name} placeholder={t("settings.templateName")} />
              <button class="btn ghost" onclick={() => draft.templates.splice(i, 1)} aria-label={t("settings.templateDelete")}><Trash size={15} /></button>
            </div>
            <textarea class="input" rows="3" bind:value={tpl.text} placeholder={t("settings.templateText")}></textarea>
          </div>
        {/each}
        <button class="btn" onclick={() => draft.templates.push({ name: "", text: "" })}><Plus size={15} /> {t("settings.templateAdd")}</button>
      </section>
    </div>
    <footer>
      <span class="spacer"></span>
      <button class="btn ghost" onclick={() => (app.settingsOpen = false)}>{t("cancel")}</button>
      <button class="btn primary" onclick={save}>{t("file.save")}</button>
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

  .update-row {
    justify-content: space-between;
    align-items: flex-start;
    margin-top: 6px;
  }

  .status {
    display: flex;
    flex-direction: column;
    gap: 2px;
    line-height: 1.4;
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

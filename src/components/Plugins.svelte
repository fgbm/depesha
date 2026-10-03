<script lang="ts">
  import { open as openDialog } from "@tauri-apps/plugin-dialog";
  import FolderOpen from "@lucide/svelte/icons/folder-open";
  import { app } from "../lib/store.svelte";
  import { api } from "../lib/api";
  import { t } from "../lib/i18n.svelte";
  import { host } from "../plugin-host/host.svelte";
  import { i18n } from "../lib/i18n.svelte";
  import { extensions, textOf } from "../lib/extensions.svelte";
  import type { Extension } from "../lib/types";

  let confirmRemove = $state<string | null>(null);

  const say = (text: { en: string; ru: string }) => (i18n.lang === "ru" ? text.ru : text.en);

  function toggleExtension(ext: Extension, on: boolean) {
    const off = app.settings.disabled_extensions.filter((m) => m !== ext.id);
    app.saveSettings({ ...app.settings, disabled_extensions: on ? off : [...off, ext.id] });
  }

  async function install() {
    const dir = await openDialog({ directory: true, title: t("ext.installTitle") });
    if (!dir || Array.isArray(dir)) return;
    try {
      const m = await api.extensionInstall(dir);
      extensions.stop(m.id);
      await extensions.load();
      app.toast(t("ext.installed", { name: textOf(m.name) }));
    } catch (e) {
      app.fail(e);
    }
  }

  async function remove(ext: Extension) {
    confirmRemove = null;
    extensions.stop(ext.id);
    try {
      await api.extensionRemove(ext.id);
      await app.loadSettings();
      await extensions.load();
    } catch (e) {
      app.fail(e);
    }
  }

  /** Permissions in words a person can judge. */
  function permission(p: string): string {
    if (p === "messages.read") return t("ext.perm.read");
    if (p === "messages.modify") return t("ext.perm.modify");
    if (p === "storage") return t("ext.perm.storage");
    if (p.startsWith("network:")) return t("ext.perm.network", { host: p.slice(8) });
    return p;
  }

  function onKey(e: KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      app.pluginsOpen = false;
    }
  }
</script>

<div class="modal-backdrop" role="presentation">
  <div class="modal plugins" role="dialog" aria-label={t("ext.title")} tabindex="-1" onkeydown={onKey}>
    <header><h3>{t("ext.title")}</h3></header>
    <div class="content">
      <section>
        <h4>{t("ext.builtIn")}</h4>
        <p class="muted small">{t("ext.builtInNote")}</p>
        {#each host.plugins as p (p.manifest.id)}
          <label class="row">
            <input
              type="checkbox"
              checked={host.enabled(p.manifest.id)}
              onchange={(e) => host.setEnabled(p.manifest.id, e.currentTarget.checked)}
              data-plugin={p.manifest.id}
            />
            <span class="text"><b>{say(p.manifest.name)}</b><span class="muted small">{say(p.manifest.description)}</span></span>
          </label>
        {/each}
      </section>

      <section>
        <div class="head">
          <h4>{t("ext.extensions")}</h4>
          <button class="btn" onclick={install}><FolderOpen size={15} /> {t("ext.install")}</button>
        </div>
        <p class="muted small">{t("ext.extensionsNote")}</p>
        {#each extensions.list as ext (ext.id)}
          {@const st = extensions.stats[ext.id]}
          <div class="ext" data-ext={ext.id}>
            <label class="row">
              <input type="checkbox" checked={ext.enabled} onchange={(e) => toggleExtension(ext, e.currentTarget.checked)} />
              <span class="text">
                <b>{textOf(ext.name)}</b> <span class="muted small">{ext.version}{ext.author ? ` · ${ext.author}` : ""}</span>
                {#if ext.description}<span class="small">{textOf(ext.description)}</span>{/if}
              </span>
            </label>
            <div class="perms">
              {#each ext.permissions as p (p)}<span class="chip">{permission(p)}</span>{:else}<span class="chip">{t("ext.perm.none")}</span>{/each}
            </div>
            <div class="muted small stats">
              {#if !st || st.startMs === null}
                {t("ext.notStarted")}
              {:else}
                {t("ext.stats", { ms: st.startMs, calls: st.calls, errors: st.errors, timeouts: st.timeouts })}
              {/if}
              {#if st?.lastError}<div class="danger-text">{st.lastError}</div>{/if}
            </div>
            <div class="actions">
              {#if confirmRemove === ext.id}
                <button class="btn danger" onclick={() => remove(ext)}>{t("ext.removeConfirm")}</button>
                <button class="btn ghost" onclick={() => (confirmRemove = null)}>{t("cancel")}</button>
              {:else}
                <button class="btn ghost" onclick={() => (confirmRemove = ext.id)}>{t("ext.remove")}</button>
              {/if}
            </div>
          </div>
        {:else}
          <p class="muted small">{t("ext.none")}</p>
        {/each}
      </section>
    </div>
    <footer>
      <span class="spacer"></span>
      <button class="btn primary" onclick={() => (app.pluginsOpen = false)}>{t("close")}</button>
    </footer>
  </div>
</div>

<style>
  .plugins {
    width: min(680px, calc(100vw - 40px));
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
    margin: 0 0 6px;
    font-size: 14px;
  }

  .head {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }

  .row {
    display: flex;
    gap: 10px;
    align-items: flex-start;
    padding: 6px 0;
  }

  .row input {
    margin-top: 3px;
  }

  .text {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .small {
    font-size: 12px;
  }

  .ext {
    border: 1px solid var(--line);
    border-radius: 8px;
    padding: 8px 12px;
    margin-top: 8px;
    background: var(--paper);
  }

  .perms {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    margin: 2px 0 4px 24px;
  }

  .chip {
    font-size: 11px;
    border: 1px solid var(--line);
    border-radius: 10px;
    padding: 0 7px;
  }

  .stats {
    margin-left: 24px;
  }

  .actions {
    display: flex;
    gap: 6px;
    justify-content: flex-end;
  }

  .btn.danger {
    color: var(--accent);
    border-color: var(--accent);
  }

  footer {
    display: flex;
    padding: 10px 20px 14px;
    border-top: 1px solid var(--line);
  }

  .spacer {
    flex: 1;
  }
</style>

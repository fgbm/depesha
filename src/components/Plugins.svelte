<script lang="ts">
  import FolderOpen from "@lucide/svelte/icons/folder-open";
  import { app } from "../lib/store.svelte";
  import { api } from "../lib/api";
  import { t } from "../lib/i18n.svelte";
  import { host } from "../plugin-host/host.svelte";
  import { i18n } from "../lib/i18n.svelte";
  import { extensions, textOf } from "../lib/extensions.svelte";
  import { grantOf, widens } from "../lib/consent";
  import ExtensionConsent from "./ExtensionConsent.svelte";
  import type { ExtManifest, ExtPreview, Extension } from "../lib/types";

  let confirmRemove = $state<string | null>(null);
  /** The plugin waiting for consent: a folder to install, or an installed copy to allow. */
  let consent = $state<{ preview: ExtPreview; path: string | null } | null>(null);

  const say = (text: { en: string; ru: string }) => (i18n.lang === "ru" ? text.ru : text.en);

  function toggleExtension(ext: Extension, on: boolean) {
    const off = app.settings.disabled_extensions.filter((m) => m !== ext.id);
    app.patchSettings({ disabled_extensions: on ? off : [...off, ext.id] });
  }

  async function install() {
    try {
      const dir = await api.pickFolder("plugin", t("ext.installTitle"));
      if (!dir) return;
      const preview = await api.extensionInspect(dir);
      // An update that asks for nothing new goes in at once; anything else waits for consent.
      if (preview.previous && !widens(preview.manifest, preview.previous.granted)) await put(dir, preview.manifest, true);
      else consent = { preview, path: dir };
    } catch (e) {
      app.ui.fail(e);
    }
  }

  /** Copies the plugin in with exactly the permissions and hooks the user saw. */
  async function put(path: string, m: ExtManifest, update: boolean) {
    const installed = await api.extensionInstall(path, grantOf(m));
    extensions.stop(installed.id);
    await extensions.load();
    const name = textOf(installed.name);
    app.ui.toast(update ? t("ext.updated", { name, version: installed.version }) : t("ext.installed", { name }));
  }

  async function answer(ok: boolean) {
    const c = consent;
    consent = null;
    if (!ok || !c) return;
    try {
      if (c.path !== null) await put(c.path, c.preview.manifest, !!c.preview.previous);
      else {
        await api.extensionApprove(c.preview.manifest.id, grantOf(c.preview.manifest));
        await extensions.load();
        app.ui.toast(t("ext.approved", { name: textOf(c.preview.manifest.name) }));
      }
    } catch (e) {
      app.ui.fail(e);
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
      app.ui.fail(e);
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
</script>

<!-- A page of the settings window. -->
<div class="plugins">
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
              <input
                type="checkbox"
                checked={ext.enabled}
                disabled={!!ext.problem || ext.review}
                onchange={(e) => toggleExtension(ext, e.currentTarget.checked)}
              />
              <span class="text">
                <b>{textOf(ext.name)}</b> <span class="muted small">{ext.version}{ext.author ? ` · ${ext.author}` : ""}</span>
                {#if ext.description}<span class="small">{textOf(ext.description)}</span>{/if}
              </span>
            </label>
            <div class="perms">
              {#each ext.permissions as p (p)}<span class="chip">{permission(p)}</span>{:else}<span class="chip">{t("ext.perm.none")}</span>{/each}
            </div>
            {#if ext.problem}
              <div class="small note danger-text" data-problem>{t("ext.problem", { reason: ext.problem })}</div>
            {:else if ext.review}
              <div class="small note" data-review>
                {t("ext.reviewNote")}
                <button class="btn" onclick={() => (consent = { preview: { manifest: ext, previous: null }, path: null })}>{t("ext.review")}</button>
              </div>
            {/if}
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
</div>

{#if consent}
  <ExtensionConsent
    preview={consent.preview}
    mode={consent.path === null ? "approve" : consent.preview.previous ? "update" : "install"}
    onanswer={answer}
  />
{/if}

<style>

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

  .note {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 6px;
    margin: 0 0 4px 24px;
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
</style>

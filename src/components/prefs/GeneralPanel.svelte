<script lang="ts">
  import { t } from "../../lib/i18n.svelte";
  import { THEMES } from "../../lib/theme";
  import { app } from "../../lib/store.svelte";
  import Select from "../Select.svelte";
  import HintsSection from "./HintsSection.svelte";
  import type { Settings } from "../../lib/types";

  // The app-wide settings: «General» (language, appearance, search) and «Updates».
  // Mail's own pages (list, reading, sending, notifications) live in MailPanel.
  let {
    current,
    draft,
    largeValue = $bindable(),
    largeUnit = $bindable(),
  }: {
    current: string;
    draft: Settings;
    largeValue: number;
    largeUnit: "mb" | "gb";
  } = $props();

  /** A radio choice of the snippet below: the field and the value are its own. */
  function choose(group: "language" | "notify" | "updates" | "letter_view", value: string) {
    // The snippet offers only the values each field takes.
    (draft as unknown as Record<string, string>)[group] = value;
  }
</script>

{#snippet option(group: "language" | "notify" | "updates" | "letter_view", value: string, label: string, note?: string)}
  <label class="option">
    <input type="radio" name={group} {value} checked={draft[group] === value} onchange={() => choose(group, value)} />
    <span class="text">{label}{#if note}<span class="note">{note}</span>{/if}</span>
  </label>
{/snippet}

{#if current === "general"}
  <section data-settings="general-language">
    <h4>{t("settings.language")}</h4>
    {@render option("language", "auto", t("settings.languageAuto"))}
    {@render option("language", "en", "English")}
    {@render option("language", "ru", "Русский")}
  </section>
  <section data-settings="general-appearance">
    <h4>{t("settings.appearance")}</h4>
    <div class="themes" role="radiogroup" aria-label={t("settings.appearance")}>
      {#each THEMES as theme (theme)}
        <label class="theme" class:on={draft.theme === theme}>
          <input type="radio" bind:group={draft.theme} value={theme} />
          <span class="swatch {theme}" aria-hidden="true"><i></i><b></b></span>
          {t(`settings.theme.${theme}`)}
        </label>
      {/each}
    </div>
    {#if draft.theme === "system"}<p class="hint">{t("settings.theme.systemNote")}</p>{/if}
  </section>
  <section data-settings="general-search">
    <h4>{t("settings.search")}</h4>
    <div class="inline">
      <span>{t("settings.largeMail")}</span>
      <input class="input large" type="number" min="1" aria-label={t("settings.largeMail")} bind:value={largeValue} />
      <Select
        label={t("settings.largeMail")}
        bind:value={largeUnit}
        options={[
          { value: "mb", label: t("unit.mb") },
          { value: "gb", label: t("unit.gb") },
        ]}
      />
    </div>
    <p class="hint">{t("settings.largeMailNote")}</p>
  </section>
  <section data-settings="general-hints">
    <h4>{t("settings.hints")}</h4>
    <HintsSection {draft} />
  </section>
{:else if current === "updates"}
  <section data-settings="updates">
    {@render option("updates", "auto", t("settings.updatesAuto"), t("settings.updatesAutoNote"))}
    {@render option("updates", "notify", t("settings.updatesNotify"))}
    {@render option("updates", "off", t("settings.updatesOff"))}
  </section>
  <section>
    <div class="inline update-row">
      <div class="status">
        <div>{t("settings.installed", { version: app.update?.current ?? "—" })}</div>
        {#if app.update?.state === "checking"}<div class="hint">{t("settings.checking")}</div>
        {:else if app.update?.state === "error"}<div class="danger-text small">{app.update.error}</div>
        {:else if app.update?.version}<div class="hint">{t("update.available", { version: app.update.version })}.</div>
        {/if}
        {#if app.update?.install === "package"}<div class="hint">{t("settings.packageNote")}</div>{/if}
        {#if app.update?.install === "unsupported"}<div class="hint">{t("settings.unsupportedNote")}</div>{/if}
      </div>
      <button class="btn" onclick={() => app.checkUpdates()} disabled={app.update?.state === "checking"}>{t("settings.checkNow")}</button>
    </div>
    <p class="hint">{t("settings.signedNote")}</p>
  </section>
{/if}

<style>
  section {
    padding: 14px 0;
    border-bottom: 1px solid var(--line);
  }

  section:last-child {
    border-bottom: none;
  }

  h4 {
    margin: 0 0 10px;
    font-size: 13px;
    font-weight: 600;
    color: var(--muted);
  }

  /* A choice: the control, then its name with an explanation under it. */
  .option {
    display: flex;
    align-items: flex-start;
    gap: 10px;
    padding: 5px 0;
    cursor: pointer;
  }

  .option input {
    margin-top: 2px;
  }

  .text {
    display: flex;
    flex-direction: column;
    gap: 2px;
    line-height: 1.4;
  }

  .note,
  .hint {
    font-size: 12px;
    color: var(--muted);
    line-height: 1.45;
  }

  .hint {
    margin: 8px 0 0;
  }

  .inline {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 4px 0;
  }

  .small {
    font-size: 12px;
  }

  .update-row {
    justify-content: space-between;
    align-items: flex-start;
  }

  .status {
    display: flex;
    flex-direction: column;
    gap: 2px;
    line-height: 1.4;
  }

  .themes {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }

  .theme {
    position: relative;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 6px;
    padding: 6px;
    border: 1px solid transparent;
    border-radius: 8px;
    font-size: 12px;
    cursor: pointer;
  }

  .theme:hover {
    background: var(--hover);
  }

  .theme.on {
    border-color: var(--accent);
  }

  /* The radio stays for the keyboard and screen readers; the swatch is what one sees. */
  .theme input {
    position: absolute;
    opacity: 0;
    pointer-events: none;
  }

  .theme:has(input:focus-visible) {
    outline: 2px solid var(--accent);
  }

  /* Swatch colours repeat --side and --paper of each theme in app.css. */
  .swatch {
    display: flex;
    width: 64px;
    height: 40px;
    border-radius: 6px;
    overflow: hidden;
    box-shadow: inset 0 0 0 1px rgb(0 0 0 / 12%);
  }

  .swatch i {
    width: 35%;
    background: var(--s);
  }

  .swatch b {
    flex: 1;
    background: var(--p);
  }

  .swatch.paper {
    --s: #1f2a37;
    --p: #faf7f1;
  }

  .swatch.night {
    --s: #11161c;
    --p: #171a1f;
  }

  .swatch.snow {
    --s: #f3f4f6;
    --p: #ffffff;
  }

  .swatch.graphite {
    --s: #26272b;
    --p: #1c1c1e;
  }

  .swatch.system {
    --s: #1f2a37;
    --p: linear-gradient(135deg, #faf7f1 50%, #171a1f 50%);
  }

  .large {
    width: 72px;
  }
</style>

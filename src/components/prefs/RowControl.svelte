<script lang="ts">
  // The control of a settings row, by the kind of the row (#102): the one set every page draws
  // from. A choice is segments or a list by the rule of 1.1; the rest are the same few
  // controls. A control only reports; saving is the editor's.
  import { t } from "../../lib/i18n.svelte";
  import { choiceMode } from "../../lib/settingsRows";
  import { THEME_LIST, isEnabled, type RowSpec } from "../../lib/settingsCatalog";
  import { largeParts, type RowEditor } from "../../lib/settingsEdit";
  import type { Settings } from "../../lib/types";
  import Select from "../Select.svelte";
  import DaysField from "./controls/DaysField.svelte";
  import FolderField from "./controls/FolderField.svelte";
  import SegChoice from "./controls/SegChoice.svelte";
  import Switch from "./controls/Switch.svelte";
  import ThemeTiles from "./controls/ThemeTiles.svelte";
  import ValueField from "./controls/ValueField.svelte";

  let {
    spec,
    s,
    editor,
    dayCursor = null,
    onerror,
    onleave,
  }: {
    spec: RowSpec;
    s: Settings;
    editor: RowEditor;
    dayCursor?: number | null;
    onerror: (message: string | null) => void;
    onleave: () => void;
  } = $props();

  let box = $state<HTMLElement | null>(null);
  let folder = $state<ReturnType<typeof FolderField> | undefined>();

  /** Enter on the row: the list opens, the field takes the cursor, the folder dialog shows. */
  export function enter() {
    if (spec.kind === "folder") return void folder?.pick();
    const el = box?.querySelector<HTMLElement>("input, .trigger");
    if (el instanceof HTMLInputElement) {
      el.focus();
      el.select();
    } else el?.click();
  }

  const dis = $derived(!isEnabled(spec, s));
  const label = $derived(spec.label());
  const large = $derived(largeParts(s.large_mb));
  const themes = $derived(THEME_LIST.map((v) => ({ value: v as string, label: t(`settings.theme.${v}`) })));
</script>

<div class="ctl" bind:this={box}>
{#if spec.kind === "toggle"}
  <Switch checked={s[spec.key]} {label} disabled={dis} onchange={(on) => editor.toggle(spec, on)} />
{:else if spec.kind === "choice"}
  {@const options = editor.options(spec).map((o) => ({ value: o.value, label: o.label() }))}
  {#if choiceMode(options.map((o) => o.label)) === "seg"}
    <SegChoice {options} value={editor.chosen(spec)} {label} disabled={dis} onpick={(v) => editor.choose(spec, v)} />
  {:else}
    <Select
      {label}
      tabindex={-1}
      disabled={dis}
      value={editor.chosen(spec)}
      {options}
      onchange={(v) => {
        void editor.choose(spec, v);
        onleave();
      }}
    />
  {/if}
{:else if spec.kind === "theme"}
  <ThemeTiles {themes} value={s.theme} {label} disabled={dis} onpick={(v) => editor.setTheme(spec, v)} />
{:else if spec.kind === "number"}
  <ValueField value={String(s[spec.key])} {label} width={72} disabled={dis} oncommit={(x) => editor.setNumber(spec, x)} {onerror} {onleave} />
  <span class="u">{spec.unit()}</span>
{:else if spec.kind === "clock"}
  <ValueField value={s[spec.key]} {label} width={76} align="center" disabled={dis} oncommit={(x) => editor.setClock(spec, x)} {onerror} {onleave} />
{:else if spec.kind === "numunit"}
  <ValueField value={String(large.n)} {label} width={72} disabled={dis} oncommit={(x) => editor.setLarge(spec, x, large.unit)} {onerror} {onleave} />
  <Select
    label={t("settings.unit")}
    tabindex={-1}
    disabled={dis}
    value={large.unit}
    options={[
      { value: "mb", label: t("unit.mb") },
      { value: "gb", label: t("unit.gb") },
    ]}
    onchange={(u) => {
      void editor.setLarge(spec, String(large.n), u as "mb" | "gb");
      onleave();
    }}
  />
{:else if spec.kind === "pair"}
  {#each [0, 1] as i (i)}
    <ValueField
      value={String(s.quota_levels[i])}
      label="{label} {i + 1}"
      width={56}
      disabled={dis}
      oncommit={(x) => editor.setLevels(spec, i === 0 ? [x, String(s.quota_levels[1])] : [String(s.quota_levels[0]), x])}
      {onerror}
      {onleave}
    />
    <span class="u">%</span>
  {/each}
  <span class="u">{t("settings.quotaFull")}</span>
{:else if spec.kind === "days"}
  <DaysField days={s.work_days} cursor={dayCursor} {label} disabled={dis} ontoggle={(d) => editor.toggleDay(spec, d)} />
{:else if spec.kind === "folder"}
  <FolderField bind:this={folder} value={s.attachments_dir ?? ""} {label} disabled={dis} onpick={(p) => editor.setFolder(spec, p)} />
{/if}
</div>

<style>
  .ctl {
    display: contents;
  }

  .u {
    font-size: 13px;
    color: var(--muted);
  }
</style>

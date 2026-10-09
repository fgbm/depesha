// Changing a setting from a row (#102): what the row shows for the saved value, what a key or
// a click makes of it, whether a typed value is fit to be saved, and the words of the toast.
// A change is written at once through `SettingsAutosave`; a value that is not fit is not
// written and the row is told why. No window in here: SettingsPage.svelte calls these.

import { levels } from "./quota";
import { t } from "./i18n.svelte";
import { threshold } from "./largeMail";
import type { SettingsAutosave } from "./settingsAutosave.svelte";
import { THEME_LIST, type Option, type RowContext, type RowSpec } from "./settingsCatalog";
import { parseWhole, stepChoice, stepClock, stepWhole } from "./settingsRows";
import { parseClock, formatClock } from "./workTime";
import type { Settings } from "./types";

type Spec<K extends RowSpec["kind"]> = Extract<RowSpec, { kind: K }>;

export interface EditHost {
  settings(): Settings;
  ctx(): RowContext;
  auto: Pick<SettingsAutosave, "commit">;
}

/** The threshold of a large letter as the row shows it: a number and its unit. */
export function largeParts(mb: number): { n: number; unit: "mb" | "gb" } {
  const v = threshold(mb);
  return v >= 1024 && v % 1024 === 0 ? { n: v / 1024, unit: "gb" } : { n: v, unit: "mb" };
}

export function largeToMb(n: number, unit: "mb" | "gb"): number {
  return unit === "gb" ? n * 1024 : n;
}

/** The most the threshold takes, in megabytes: ten terabytes is more than any mailbox. */
const LARGE_MAX = 10 * 1024 * 1024;
const LEVEL: { min: number; max: number } = { min: 1, max: 99 };

const dayName = (iso: number) => new Intl.DateTimeFormat(undefined, { weekday: "short" }).format(new Date(2024, 0, iso));

export class RowEditor {
  constructor(private host: EditHost) {}

  private get s(): Settings {
    return this.host.settings();
  }

  // ---- What a row shows ----

  /** The options of a choice row, in the order shown. */
  options(spec: Spec<"choice">): Option[] {
    return spec.options(this.host.ctx());
  }

  /** The saved value of a choice, as one of its options' values. */
  chosen(spec: Spec<"choice">): string | number {
    if (spec.read) return spec.read(this.s, this.host.ctx());
    return this.s[spec.key] as string | number;
  }

  /** The option that is saved, for its description. */
  chosenOption(spec: Spec<"choice">): Option | undefined {
    const v = this.chosen(spec);
    return this.options(spec).find((o) => o.value === v);
  }

  /** The words for a value, as the toast says it. */
  private say(spec: RowSpec, v: unknown): string {
    switch (spec.kind) {
      case "toggle":
        return v ? t("settings.on") : t("settings.off");
      case "choice":
        return this.options(spec).find((o) => o.value === v)?.label() ?? String(v);
      case "number":
        return `${v} ${spec.unit()}`;
      case "theme":
        return t(`settings.theme.${v as "paper"}`);
      case "folder":
        return String(v || "") || t("settings.askEveryTime");
      case "days":
        return (v as number[]).map(dayName).join(", ") || t("settings.off");
      case "numunit": {
        const p = largeParts(v as number);
        return `${p.n} ${t(`unit.${p.unit}`)}`;
      }
      case "pair":
        return `${(v as number[]).join(" %, ")} %`;
      default:
        return String(v);
    }
  }

  private async write(spec: RowSpec, patch: Record<string, unknown>, key: keyof Settings, to: unknown): Promise<void> {
    const from = this.s[key];
    const old = spec.kind === "choice" && spec.read ? spec.read(this.s, this.host.ctx()) : from;
    const what = t("settings.changed", { name: spec.label(), from: this.say(spec, old), to: this.say(spec, to) });
    await this.host.auto.commit(spec.id, patch, what, spec.label());
  }

  // ---- Changes ----

  async toggle(spec: Spec<"toggle">, on: boolean): Promise<void> {
    await this.write(spec, { [spec.key]: on }, spec.key, on);
  }

  async choose(spec: Spec<"choice">, value: string | number): Promise<void> {
    const saved = spec.write ? spec.write(value) : value;
    const extra = spec.extra?.(value, this.host.ctx()) ?? {};
    await this.write(spec, { [spec.key]: saved, ...extra }, spec.key, value);
  }

  async setTheme(spec: Spec<"theme">, value: string): Promise<void> {
    await this.write(spec, { theme: value }, "theme", value);
  }

  /** A typed whole number; the message when it is not fit to be saved, else null. */
  async setNumber(spec: Spec<"number">, raw: string): Promise<string | null> {
    const n = parseWhole(raw, spec.spec);
    if (n === null) return t("settings.errRange", { min: spec.spec.min, max: spec.spec.max });
    await this.write(spec, { [spec.key]: n }, spec.key, n);
    return null;
  }

  async setClock(spec: Spec<"clock">, raw: string): Promise<string | null> {
    const c = parseClock(raw);
    if (!c) return t("settings.errClock");
    await this.write(spec, { [spec.key]: formatClock(c) }, spec.key, formatClock(c));
    return null;
  }

  async setLarge(spec: Spec<"numunit">, raw: string, unit: "mb" | "gb"): Promise<string | null> {
    const n = parseWhole(raw, { min: 1, max: unit === "gb" ? LARGE_MAX / 1024 : LARGE_MAX });
    if (n === null) return t("settings.errRange", { min: 1, max: unit === "gb" ? LARGE_MAX / 1024 : LARGE_MAX });
    const mb = largeToMb(n, unit);
    await this.write(spec, { large_mb: mb }, "large_mb", mb);
    return null;
  }

  async setLevels(spec: Spec<"pair">, raws: [string, string]): Promise<string | null> {
    const pair = raws.map((r) => parseWhole(r, LEVEL));
    if (pair.some((n) => n === null)) return t("settings.errRange", LEVEL);
    const next = levels(pair as number[]).sort((a, b) => a - b) as [number, number];
    await this.write(spec, { quota_levels: next }, "quota_levels", next);
    return null;
  }

  async toggleDay(spec: Spec<"days">, day: number): Promise<void> {
    const days = this.s.work_days.includes(day) ? this.s.work_days.filter((d) => d !== day) : [...this.s.work_days, day].sort((a, b) => a - b);
    await this.write(spec, { work_days: days }, "work_days", days);
  }

  async setFolder(spec: Spec<"folder">, path: string): Promise<void> {
    await this.write(spec, { attachments_dir: path }, "attachments_dir", path);
  }

  /** The consent to work in the background with no icon in the tray: given by the one who is asked, here. */
  async grantTray(spec: Spec<"action">): Promise<void> {
    await this.host.auto.commit(spec.id, { background_without_tray: true }, t("bg.noTray.kept"), spec.label());
  }

  /** ← / → on a row that steps through values. The cursor of the weekdays is the page's. */
  async step(spec: RowSpec, dir: 1 | -1, big: boolean): Promise<void> {
    const s = this.s;
    switch (spec.kind) {
      case "choice": {
        const values = this.options(spec).map((o) => o.value);
        const next = stepChoice(values, this.chosen(spec), dir);
        if (next !== this.chosen(spec)) await this.choose(spec, next);
        return;
      }
      case "theme":
        await this.setTheme(spec, stepChoice<string>([...THEME_LIST], s.theme, dir));
        return;
      case "number":
        await this.setNumber(spec, String(stepWhole(s.image_max_px, dir, spec.spec, big)));
        return;
      case "clock": {
        const next = stepClock(s[spec.key], dir);
        if (next) await this.setClock(spec, next);
        return;
      }
      case "numunit": {
        const p = largeParts(s.large_mb);
        await this.setLarge(spec, String(stepWhole(p.n, dir, { min: 1, max: LARGE_MAX }, big)), p.unit);
        return;
      }
    }
  }
}

// Метки и свойства папок в окне (#42): сами метки по ящику, свойства папки по имени,
// и отметка отказа. Данные приходят из кэша; сервер трогает только set_label и
// folder_props. Значки в строках, карточка у папки и «Свои метки» в таблице читают это.

import { api } from "./api";
import { t } from "./i18n.svelte";
import { pickAccount } from "./labels";
import type { AppStore } from "./store.svelte";
import type { FolderProps, Label, LabelCheck, MessageRow } from "./types";

/** The saved folder properties, kept across windows and restarts (#71). */
const PROPS_KEY = "depesha.folderProps";
/** How long a saved copy is trusted before the server is asked again, seconds. */
const PROPS_TTL = 10 * 60;

class Labels {
  /** Метки каждого ящика, по id. */
  all = $state<Record<string, Label[]>>({});
  /** Число писем с меткой по кэшу, по ящику и ключу метки (#42, кадр 2). */
  counts = $state<Record<string, Record<string, number>>>({});
  /** Свойства папок, по `account\u0000folder`. */
  props = $state<Record<string, FolderProps>>({});
  /** Проверка свойств идёт: по тому же ключу. */
  checking = $state<Record<string, boolean>>({});
  /** Открытая карточка свойств папки (#42, кадр 4А): ящик и имя папки. */
  card = $state<{ accountId: string; folder: string } | null>(null);
  /** Открытый выбор меток (#42, кадр 10): письма и точка, где он открылся; null — закрыт. */
  pick = $state<{ ids: number[]; at: { x: number; y: number } | null } | null>(null);

  private app: AppStore | null = null;

  start(app: AppStore) {
    this.app = app;
  }

  key(accountId: string, folder: string): string {
    return `${accountId}\u0000${folder}`;
  }

  of(accountId: string): Label[] {
    return this.all[accountId] ?? [];
  }

  async load(accountId: string) {
    try {
      this.all[accountId] = await api.labels(accountId);
    } catch (e) {
      this.app?.fail(e);
    }
  }

  /** Перечитывает метки и число писем: после создания, правки или удаления. */
  async refresh(accountId: string) {
    await Promise.all([this.load(accountId), this.loadCounts(accountId)]);
  }

  /** Число писем с меткой по кэшу; список показывает его как «≈N». */
  async loadCounts(accountId: string) {
    try {
      const rows = await api.labelCounts(accountId);
      const byKeyword: Record<string, number> = {};
      for (const row of rows) byKeyword[row.keyword] = row.count;
      this.counts[accountId] = byKeyword;
    } catch (e) {
      this.app?.fail(e);
    }
  }

  count(accountId: string, keyword: string): number {
    return this.counts[accountId]?.[keyword] ?? 0;
  }

  async save(accountId: string, name: string, color: string): Promise<Label | null> {
    try {
      const label = await api.labelSave(accountId, name, color);
      this.all[accountId] = await api.labels(accountId);
      return label;
    } catch (e) {
      this.app?.fail(e, t("label.saveFailed"));
      return null;
    }
  }

  /** Тихая правка имени: ключ на сервере не меняется (#42, кадр 3). */
  async rename(accountId: string, from: string, to: string): Promise<Label | null> {
    try {
      const label = await api.labelRename(accountId, from, to);
      this.all[accountId] = await api.labels(accountId);
      return label;
    } catch (e) {
      this.app?.fail(e, t("label.renameFailed"));
      return null;
    }
  }

  async remove(accountId: string, name: string) {
    try {
      await api.labelRemove(accountId, name);
      await this.refresh(accountId);
    } catch (e) {
      this.app?.fail(e);
    }
  }

  /** Удаление с сервера: метка уходит из списка сразу, ключ снимается фоном (#42, кадр 4Б). */
  async strip(accountId: string, name: string) {
    try {
      await api.labelStrip(accountId, name);
      await this.refresh(accountId);
    } catch (e) {
      this.app?.fail(e, t("label.removeFailed"));
    }
  }

  /** Ставит или снимает метку у писем. */
  async set(ids: number[], name: string, value: boolean) {
    const app = this.app;
    if (!app) return;
    try {
      await api.setLabel(ids, name, value);
      app.scheduleReload();
    } catch (e) {
      app.fail(e, t(value ? "label.addFailed" : "label.removeFailed"));
    }
  }

  /** Права и метки папки из кэша; читает сервер только при `check`. */
  prop(accountId: string, folder: string): FolderProps | undefined {
    return this.props[this.key(accountId, folder)];
  }

  /** Открывает карточку свойств папки (#42): из «нет прав» и из подраздела «Папки». */
  openCard(accountId: string, folder: string) {
    this.card = { accountId, folder };
    void this.loadProps(accountId, folder);
  }

  closeCard() {
    this.card = null;
  }

  /** Открывает выбор меток (#42, кадр 10): из меню строки, панели письма и команды
   *  «Метки…». `at` — точка открытия; из разных ящиков или с известным запретом не открывается. */
  openPick(ids: number[], at: { x: number; y: number } | null = null) {
    const rows = this.rowsFor(ids);
    if (!rows.length || !pickAccount(rows) || !this.writable(rows)) return;
    this.pick = { ids: [...ids], at };
  }

  closePick() {
    this.pick = null;
  }

  /** Строки открытого выбора: из списка, а открытое письмо — если его в списке нет. */
  pickRows(): MessageRow[] {
    return this.rowsFor(this.pick?.ids ?? []);
  }

  /** Могут ли эти строки менять метки: известный запрет — нет (#42, кадр 7). */
  writable(rows: { account_id: string; folder: string }[]): boolean {
    return rows.every((m) => {
      const rights = this.prop(m.account_id, m.folder)?.rights;
      return !rights || rights.write;
    });
  }

  /** Строки этих писем: те, что есть в списке, плюс открытое письмо отдельного окна. */
  private rowsFor(ids: number[]): MessageRow[] {
    const app = this.app;
    if (!app || !ids.length) return [];
    const out = ids.map((id) => app.messages.find((m) => m.id === id)).filter((m): m is MessageRow => !!m);
    const opened = app.opened?.row;
    if (opened && ids.includes(opened.id) && !out.some((m) => m.id === opened.id)) out.push(opened);
    return out;
  }

  async loadProps(accountId: string, folder: string) {
    const key = this.key(accountId, folder);
    if (key in this.props) return;
    // The saved cache shows at once; the server is asked only when that cache grew old (#71).
    const saved = this.savedProps()[key];
    if (saved) this.props[key] = saved;
    if (saved && Date.now() / 1000 - saved.checked < PROPS_TTL) return;
    try {
      const props = await api.folderProps(accountId, folder);
      this.props[key] = props;
      this.rememberProps(key, props);
    } catch (e) {
      this.app?.fail(e, t("folder.propsFailed"));
    }
  }

  /** The folder properties saved in the window's storage. */
  private savedProps(): Record<string, FolderProps> {
    if (typeof localStorage === "undefined") return {};
    try {
      const raw = JSON.parse(localStorage.getItem(PROPS_KEY) ?? "{}");
      return raw && typeof raw === "object" ? (raw as Record<string, FolderProps>) : {};
    } catch {
      // A broken stored value starts with no properties.
      return {};
    }
  }

  private rememberProps(key: string, props: FolderProps) {
    if (typeof localStorage === "undefined") return;
    try {
      localStorage.setItem(PROPS_KEY, JSON.stringify({ ...this.savedProps(), [key]: props }));
    } catch {
      // A full storage only means the next open reads the server again.
    }
  }

  async check(accountId: string, folder: string) {
    const key = this.key(accountId, folder);
    this.checking[key] = true;
    try {
      this.props[key] = await api.folderProps(accountId, folder);
    } catch (e) {
      this.app?.fail(e, t("folder.propsFailed"));
    } finally {
      this.checking[key] = false;
    }
  }

  /** Проверка меток на тестовом письме (кадр 9): итог помнится и меняет «где хранятся». */
  async runLabelCheck(accountId: string, folder: string): Promise<LabelCheck | null> {
    const key = this.key(accountId, folder);
    this.checking[key] = true;
    try {
      const check = await api.labelCheck(accountId, folder);
      const before = this.props[key];
      if (before) this.props[key] = { ...before, label_check: check, checked: Math.floor(Date.now() / 1000) };
      return check;
    } catch (e) {
      this.app?.fail(e, t("label.check.failed", { reason: "" }));
      return null;
    } finally {
      this.checking[key] = false;
    }
  }

  /** Серверная синхронизация папок сбросила кэш свойств: перечитать открытые. */
  forget(accountId: string) {
    const prefix = `${accountId}\u0000`;
    for (const k of Object.keys(this.props)) {
      if (k.startsWith(prefix)) delete this.props[k];
    }
  }
}

export const labels = new Labels();

// Метки и свойства папок в окне (#42): сами метки по ящику, свойства папки по имени,
// и отметка отказа. Данные приходят из кэша; сервер трогает только set_label и
// folder_props. Значки в строках, карточка у папки и «Свои метки» в таблице читают это.

import { api } from "./api";
import { t } from "./i18n.svelte";
import type { AppStore } from "./store.svelte";
import type { FolderProps, Label, LabelCheck } from "./types";

class Labels {
  /** Метки каждого ящика, по id. */
  all = $state<Record<string, Label[]>>({});
  /** Свойства папок, по `account\u0000folder`. */
  props = $state<Record<string, FolderProps>>({});
  /** Проверка свойств идёт: по тому же ключу. */
  checking = $state<Record<string, boolean>>({});
  /** Открытая карточка свойств папки (#42, кадр 4А): ящик и имя папки. */
  card = $state<{ accountId: string; folder: string } | null>(null);

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

  async remove(accountId: string, name: string) {
    try {
      await api.labelRemove(accountId, name);
      this.all[accountId] = await api.labels(accountId);
    } catch (e) {
      this.app?.fail(e);
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

  async loadProps(accountId: string, folder: string) {
    const key = this.key(accountId, folder);
    if (key in this.props) return;
    try {
      this.props[key] = await api.folderProps(accountId, folder);
    } catch (e) {
      this.app?.fail(e, t("folder.propsFailed"));
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

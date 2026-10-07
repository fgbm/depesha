<script lang="ts">
  // Подраздел «Папки» страницы ящика (#42, кадр 2А): все папки списком с доступом,
  // своими метками и владельцем. Кнопки «Проверить все» нет: проверка — при открытии
  // папки и «Проверить снова» в карточке. Строка открывает ту же карточку, что ПКМ.

  import Users from "@lucide/svelte/icons/users";
  import { t } from "../../lib/i18n.svelte";
  import { when } from "../../lib/later";
  import { readOnly } from "../../lib/labels";
  import { app } from "../../lib/store.svelte";
  import type { AccountView, FolderInfo, FolderProps } from "../../lib/types";

  let { account, folders }: { account: AccountView; folders: FolderProps[] } = $props();

  // Every folder of the mailbox, in the sidebar's order; the props join by name.
  const byName = $derived(new Map(folders.map((p) => [p.folder, p])));
  const list = $derived(
    app.folders
      .filter((f) => f.account_id === account.id && !f.hidden)
      .sort((a, b) => a.display_name.localeCompare(b.display_name, undefined, { numeric: true })),
  );
  const checked = $derived(folders.filter((p) => p.checked > 0).length);

  function access(f: FolderInfo): { text: string; kind: "ok" | "lim" | "no" | "unk" } {
    const p = byName.get(f.name);
    if (!p?.rights) return { text: t("folder.unknown"), kind: "unk" };
    const r = p.rights;
    if (readOnly(r)) return { text: t("folder.readOnly"), kind: "lim" };
    if (!r.delete_messages || !r.expunge) return { text: t("folder.access.noDelete"), kind: "lim" };
    return { text: t("folder.readWrite"), kind: "ok" };
  }

  function labelsOf(p: FolderProps | undefined): { text: string; kind: "ok" | "lim" | "no" | "unk" } {
    if (!p || p.labels_on_server == null) return { text: t("folder.unknown"), kind: "unk" };
    if (p.labels_on_server) return { text: t("folder.labelsServer"), kind: "ok" };
    return { text: t("folder.labelsLocalShort"), kind: "lim" };
  }

  function ownerText(p: FolderProps | undefined): string {
    const kind = p?.owner.kind ?? "mine";
    if (kind === "shared") return t("folder.owner.shared");
    if (kind === "other" && p) return t("folder.owner.other", { name: (p.owner as { name: string }).name });
    return t("folder.owner.mine");
  }

  function open(f: FolderInfo) {
    app.checkFolderProps(account.id, f.name);
  }
</script>

<h4>{t("server.folders.title")} <span class="r small muted">{t("server.folders.checked", { n: checked, all: list.length })}</span></h4>
<table class="folders">
  <thead>
    <tr>
      <th>{t("server.folders.name")}</th>
      <th>{t("server.folders.access")}</th>
      <th>{t("server.folders.labels")}</th>
      <th>{t("server.folders.owner")}</th>
      <th>{t("server.folders.col.checked")}</th>
    </tr>
  </thead>
  <tbody>
    {#each list as f (f.name)}
      {@const p = byName.get(f.name)}
      {@const acc = access(f)}
      {@const lbl = labelsOf(p)}
      <tr>
        <td class="fname">
          <button class="link" onclick={() => open(f)} title={f.name}>{f.display_name}</button>
          {#if p?.owner.kind !== "mine" && p}<Users size={12} />{/if}
        </td>
        <td><span class="cell {acc.kind}">{acc.text}</span></td>
        <td><span class="cell {lbl.kind}">{lbl.text}</span></td>
        <td class="muted">{ownerText(p)}</td>
        <td class="muted">{p?.checked ? when(p.checked) : t("server.folders.never")}</td>
      </tr>
    {/each}
  </tbody>
</table>

<style>
  h4 {
    margin: 18px 0 6px;
  }

  .r {
    font-weight: 400;
  }

  .small {
    font-size: 11.5px;
  }

  .folders {
    width: 100%;
    border-collapse: collapse;
    font-size: 12.5px;
    line-height: 1.4;
  }

  th {
    padding: 6px 8px 6px 0;
    border-bottom: 1px solid var(--line);
    color: var(--muted);
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    text-align: left;
  }

  td {
    padding: 6px 8px 6px 0;
    border-bottom: 1px solid var(--line);
    vertical-align: top;
  }

  tbody tr:last-child td {
    border-bottom: none;
  }

  .fname {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    color: var(--muted);
  }

  .link {
    border: none;
    background: none;
    color: var(--ink);
    font: inherit;
    padding: 0;
    cursor: pointer;
  }

  .link:hover {
    text-decoration: underline;
  }

  .cell {
    display: inline-block;
    padding: 1px 7px;
    border-radius: 8px;
    border: 1px solid var(--line);
    white-space: nowrap;
  }

  .cell.ok {
    color: var(--ok);
    border-color: color-mix(in srgb, var(--ok) 45%, transparent);
  }

  .cell.lim {
    color: var(--warn);
    border-color: color-mix(in srgb, var(--warn) 45%, transparent);
  }

  .cell.no {
    color: var(--warn);
  }

  .cell.unk {
    color: var(--muted);
    border-style: dashed;
  }

  .muted {
    color: var(--muted);
  }
</style>

<script lang="ts">
  import Reply from "@lucide/svelte/icons/reply";
  import ReplyAll from "@lucide/svelte/icons/reply-all";
  import Forward from "@lucide/svelte/icons/forward";
  import Mail from "@lucide/svelte/icons/mail";
  import MailOpen from "@lucide/svelte/icons/mail-open";
  import Flag from "@lucide/svelte/icons/flag";
  import Archive from "@lucide/svelte/icons/archive";
  import Folder from "@lucide/svelte/icons/folder";
  import Tag from "@lucide/svelte/icons/tag";
  import ShieldAlert from "@lucide/svelte/icons/shield-alert";
  import Trash from "@lucide/svelte/icons/trash-2";
  import UserSearch from "@lucide/svelte/icons/user-search";
  import ChevronRight from "@lucide/svelte/icons/chevron-right";
  import AppWindow from "@lucide/svelte/icons/app-window";
  import { app } from "../lib/store.svelte";
  import { t } from "../lib/i18n.svelte";
  import { registry } from "../plugin-host/registry.svelte";
  import type { RowAction } from "../plugin-api";
  import { untrack } from "svelte";
  import Popover from "./Popover.svelte";
  import Keys from "./Keys.svelte";

  /** The context menu of list rows: what the toolbar and the keys do, at the pointer. */
  let { at, ids: given, onclose }: { at: { x: number; y: number }; ids: number[]; onclose: () => void } = $props();

  // The menu lives for one right click; closing it clears the list's state its props
  // come from, so the rows are taken once, when it opens.
  const ids = untrack(() => [...given]);

  /** A second step in place of the menu: a folder to move to, a labels picker, or a plugin's own menu. */
  let sub = $state<{ kind: "move" } | { kind: "labels" } | { kind: "plugin"; action: RowAction } | null>(null);
  let newLabel = $state("");
  let newColor = $state("#3f7fd0");

  const rows = $derived(app.messages.filter((m) => ids.includes(m.id)));
  const single = $derived(rows.length === 1 ? rows[0] : null);
  const anyUnread = $derived(rows.some((m) => !m.flags.seen));
  const allFlagged = $derived(rows.length > 0 && rows.every((m) => m.flags.flagged));
  const isDraft = $derived(!!single && app.folder(single.account_id, single.folder)?.role === "drafts");
  /** Folders to move to: those of the one account the rows belong to, minus where they all lie. */
  const folders = $derived.by(() => {
    const accounts = new Set(rows.map((m) => m.account_id));
    if (accounts.size !== 1) return [];
    const [account] = accounts;
    const from = new Set(rows.map((m) => m.folder));
    return app.folders.filter((f) => {
      if (f.account_id !== account || !f.selectable || f.hidden) return false;
      if (from.size === 1 && from.has(f.name)) return false;
      // A folder known not to take letters is not offered (#42, frame 7, note 1).
      const rights = app.labels.prop(account, f.name)?.rights;
      return !rights || rights.insert;
    });
  });
  const pluginActions = $derived(
    registry.items("rowActions").filter((a) => {
      try {
        return !a.when || a.when(ids);
      } catch {
        return false;
      }
    }),
  );

  /** The mailbox of the rows, when they all lie in one: labels belong to a mailbox. */
  const labelAccount = $derived.by(() => {
    const accounts = new Set(rows.map((m) => m.account_id));
    return accounts.size === 1 ? [...accounts][0] : null;
  });
  const knownLabels = $derived(labelAccount ? app.labels.of(labelAccount) : []);
  /** Which labels the rows carry: on all of them, on some, or none. */
  function labelState(l: { keyword: string }): "all" | "some" | "none" {
    const on = rows.filter((m) => (m.keywords ?? []).includes(l.keyword)).length;
    return on === 0 ? "none" : on === rows.length ? "all" : "some";
  }
  /** Whether the folders the rows lie in keep labels on the server. */
  const labelsLocal = $derived.by(() => {
    if (!labelAccount) return false;
    const folders = new Set(rows.map((m) => m.folder));
    return [...folders].every((f) => app.labels.prop(labelAccount, f)?.labels_on_server === false);
  });
  const labelsUnknown = $derived.by(() => {
    if (!labelAccount) return false;
    const folders = new Set(rows.map((m) => m.folder));
    return [...folders].some((f) => app.labels.prop(labelAccount, f)?.labels_on_server == null);
  });

  async function toggleLabel(keyword: string, on: boolean) {
    const l = knownLabels.find((x) => x.keyword === keyword);
    if (l) await app.setLabel(ids, l.name, on);
  }

  async function addLabel() {
    const name = newLabel.trim();
    if (!labelAccount || !name) return;
    const label = await app.labels.save(labelAccount, name, newColor);
    newLabel = "";
    if (label) await app.setLabel(ids, label.name, true);
  }

  /** The rights of the folders the rows lie in, when they all agree; unknown otherwise. */
  const rights = $derived.by(() => {
    const seen = rows.map((m) => app.labels.prop(m.account_id, m.folder)?.rights ?? null);
    if (!seen.length || seen.some((r) => r === null)) return null;
    return seen[0]!;
  });
  // A known ban turns the button off with a hint; unknown rights leave it on (#42, frame 7).
  const canDelete = $derived(!rights || rights.delete_messages);
  const canWrite = $derived(!rights || rights.write);

  function run(fn: () => void) {
    fn();
    onclose();
  }

  /** Reply and forward work on the opened message: open the row first if needed. */
  async function withOpened(fn: () => void) {
    const id = single?.id;
    onclose();
    if (id === undefined) return;
    if (app.opened?.row.id !== id) await app.select(id);
    if (app.opened?.row.id === id) fn();
  }

  function fromSender() {
    const email = single?.from?.email;
    if (email) run(() => app.setView({ kind: "search", text: `from:${email}` }));
  }
</script>

<Popover at={at} bind:open={() => sub === null, (v) => !v && sub === null && onclose()}>
  {#if single && !isDraft}
    <button class="mi" onclick={() => withOpened(() => app.replyTo(false))}><Reply size={15} /> {t("act.reply")}<span class="hint"><Keys of="core.reply" /></span></button>
    <button class="mi" onclick={() => withOpened(() => app.replyTo(true))}><ReplyAll size={15} /> {t("menu.replyAll")}<span class="hint"><Keys of="core.reply-all" /></span></button>
    <button class="mi" onclick={() => withOpened(() => app.forwardOpened())}><Forward size={15} /> {t("act.forward")}<span class="hint"><Keys of="core.forward" /></span></button>
    <button class="mi" onclick={() => single && run(() => app.openWindow(single))}><AppWindow size={15} /> {t("act.newWindow")}</button>
    <hr />
  {/if}
  <button class="mi" onclick={() => run(() => app.flag("seen", anyUnread, ids))}>
    {#if anyUnread}<MailOpen size={15} /> {t("act.markRead")}{:else}<Mail size={15} /> {t("act.markUnread")}{/if}<span class="hint"><Keys of="core.unread" /></span>
  </button>
  <button class="mi" disabled={!canWrite} title={!canWrite ? t("folder.noRightHint") : undefined} onclick={() => run(() => app.flag("flagged", !allFlagged, ids))}>
    <Flag size={15} /> {allFlagged ? t("act.unflag") : t("act.setFlag")}<span class="hint"><Keys of="core.flag" /></span>
  </button>
  {#if labelAccount && knownLabels.length}
    <button class="mi" disabled={!canWrite} title={!canWrite ? t("folder.noRightHint") : undefined} onclick={() => (sub = { kind: "labels" })}><Tag size={15} /> {t("act.labels")}<span class="hint"><ChevronRight size={13} /></span></button>
  {/if}
  {#each pluginActions as a (a.id)}
    <button class="mi" onclick={() => (a.menu ? (sub = { kind: "plugin", action: a }) : run(() => a.run?.(ids)))}>
      {#if a.icon}<a.icon size={15} />{/if} {a.title()}{#if a.menu}<span class="hint"><ChevronRight size={13} /></span>{:else if a.command}<span class="hint"><Keys of={a.command} /></span>{:else if a.hint}<span class="hint">{a.hint}</span>{/if}
    </button>
  {/each}
  <hr />
  <button class="mi" onclick={() => run(() => app.archive(ids))}><Archive size={15} /> {t("act.done")}<span class="hint"><Keys of="core.archive" /></span></button>
  {#if folders.length}
    <button class="mi" onclick={() => (sub = { kind: "move" })}><Folder size={15} /> {t("act.moveTo")}<span class="hint"><ChevronRight size={13} /></span></button>
  {/if}
  <button class="mi" onclick={() => run(() => app.spam(ids))}><ShieldAlert size={15} /> {t("act.spam")}<span class="hint"><Keys of="core.spam" /></span></button>
  <button class="mi" disabled={!canDelete} title={!canDelete ? t("folder.noRightHint") : undefined} onclick={() => run(() => app.remove(ids))}><Trash size={15} /> {t("act.delete")}<span class="hint"><Keys of="core.delete" /></span></button>
  {#if single?.from?.email}
    <hr />
    <button class="mi" onclick={fromSender}><UserSearch size={15} /> {t("reader.fromSender")}</button>
  {/if}
</Popover>

<Popover at={at} bind:open={() => sub !== null, (v) => !v && onclose()}>
  {#if sub?.kind === "move"}
    <div class="mt">{t("act.moveTitle")}</div>
    <div class="folder-list">
      {#each folders as f (f.name)}
        <button class="mi" onclick={() => run(() => app.moveTo(f.name, ids))}><Folder size={15} /> {f.display_name}</button>
      {/each}
    </div>
  {:else if sub?.kind === "labels"}
    <div class="mt">{t("label.pick")}</div>
    <div class="folder-list">
      {#each knownLabels as l (l.keyword)}
        {@const state = labelState(l)}
        <button class="mi" onclick={() => toggleLabel(l.keyword, state !== "all")}>
          <input type="checkbox" checked={state === "all"} indeterminate={state === "some"} tabindex="-1" />
          <span class="lsw" style:--c={l.color}></span>{l.name}
        </button>
      {/each}
    </div>
    <hr />
    <form class="new" onsubmit={(e) => { e.preventDefault(); addLabel(); }}>
      <span class="lsw" style:--c={newColor}></span>
      <input class="input" bind:value={newLabel} placeholder={t("label.new")} aria-label={t("label.new")} />
      <input class="color" type="color" bind:value={newColor} aria-label={t("label.color")} />
      <button class="btn primary" type="submit" disabled={!newLabel.trim()}>{t("label.create")}</button>
    </form>
    <div class="stat">
      {#if labelsUnknown}{t("label.whereUnknown")}
      {:else if labelsLocal}{t("label.whereLocal")}
      {:else}{t("label.whereServer")}{/if}
    </div>
  {:else if sub?.kind === "plugin" && sub.action.menu}
    {@const m = sub.action.menu}
    <m.component {...m.props ?? {}} {ids} done={onclose} />
  {/if}
</Popover>

<style>
  .folder-list {
    display: flex;
    flex-direction: column;
    overflow-y: auto;
    max-height: 50vh;
  }

  .mi input[type="checkbox"] {
    flex: none;
  }

  .lsw {
    display: inline-block;
    width: 11px;
    height: 11px;
    border-radius: 3px;
    background: var(--c, var(--muted));
  }

  .new {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 4px 6px 6px;
  }

  .new .input {
    flex: 1;
    min-width: 0;
  }

  .new .color {
    flex: none;
    width: 24px;
    height: 24px;
    padding: 0;
    border: 1px solid var(--line);
    border-radius: 4px;
    background: none;
  }

  .stat {
    display: flex;
    gap: 6px;
    padding: 6px 10px 8px;
    color: var(--muted);
    font-size: 11.5px;
    line-height: 1.4;
  }
</style>

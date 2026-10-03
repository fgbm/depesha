<script lang="ts">
  import Reply from "@lucide/svelte/icons/reply";
  import ReplyAll from "@lucide/svelte/icons/reply-all";
  import Forward from "@lucide/svelte/icons/forward";
  import Mail from "@lucide/svelte/icons/mail";
  import MailOpen from "@lucide/svelte/icons/mail-open";
  import Flag from "@lucide/svelte/icons/flag";
  import Archive from "@lucide/svelte/icons/archive";
  import Folder from "@lucide/svelte/icons/folder";
  import ShieldAlert from "@lucide/svelte/icons/shield-alert";
  import Trash from "@lucide/svelte/icons/trash-2";
  import UserSearch from "@lucide/svelte/icons/user-search";
  import ChevronRight from "@lucide/svelte/icons/chevron-right";
  import { app } from "../lib/store.svelte";
  import { t } from "../lib/i18n.svelte";
  import { registry } from "../plugin-host/registry.svelte";
  import type { RowAction } from "../plugin-api";
  import { untrack } from "svelte";
  import Popover from "./Popover.svelte";

  /** The context menu of list rows: what the toolbar and the keys do, at the pointer. */
  let { at, ids: given, onclose }: { at: { x: number; y: number }; ids: number[]; onclose: () => void } = $props();

  // The menu lives for one right click; closing it clears the list's state its props
  // come from, so the rows are taken once, when it opens.
  const ids = untrack(() => [...given]);

  /** A second step in place of the menu: a folder to move to, or a plugin's own menu. */
  let sub = $state<{ kind: "move" } | { kind: "plugin"; action: RowAction } | null>(null);

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
    return app.folders.filter((f) => f.account_id === account && f.selectable && !f.hidden && !(from.size === 1 && from.has(f.name)));
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
    <button class="mi" onclick={() => withOpened(() => app.replyTo(false))}><Reply size={15} /> {t("act.reply")}<span class="hint">r</span></button>
    <button class="mi" onclick={() => withOpened(() => app.replyTo(true))}><ReplyAll size={15} /> {t("menu.replyAll")}<span class="hint">a</span></button>
    <button class="mi" onclick={() => withOpened(() => app.forwardOpened())}><Forward size={15} /> {t("act.forward")}<span class="hint">f</span></button>
    <hr />
  {/if}
  <button class="mi" onclick={() => run(() => app.flag("seen", anyUnread, ids))}>
    {#if anyUnread}<MailOpen size={15} /> {t("act.markRead")}{:else}<Mail size={15} /> {t("act.markUnread")}{/if}<span class="hint">u</span>
  </button>
  <button class="mi" onclick={() => run(() => app.flag("flagged", !allFlagged, ids))}>
    <Flag size={15} /> {allFlagged ? t("act.unflag") : t("act.setFlag")}<span class="hint">s</span>
  </button>
  {#each pluginActions as a (a.id)}
    <button class="mi" onclick={() => (a.menu ? (sub = { kind: "plugin", action: a }) : run(() => a.run?.(ids)))}>
      {#if a.icon}<a.icon size={15} />{/if} {a.title()}{#if a.menu}<span class="hint"><ChevronRight size={13} /></span>{:else if a.hint}<span class="hint">{a.hint}</span>{/if}
    </button>
  {/each}
  <hr />
  <button class="mi" onclick={() => run(() => app.archive(ids))}><Archive size={15} /> {t("act.done")}<span class="hint">e</span></button>
  {#if folders.length}
    <button class="mi" onclick={() => (sub = { kind: "move" })}><Folder size={15} /> {t("act.moveTo")}<span class="hint"><ChevronRight size={13} /></span></button>
  {/if}
  <button class="mi" onclick={() => run(() => app.spam(ids))}><ShieldAlert size={15} /> {t("act.spam")}<span class="hint">!</span></button>
  <button class="mi" onclick={() => run(() => app.remove(ids))}><Trash size={15} /> {t("act.delete")}<span class="hint">#</span></button>
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
</style>

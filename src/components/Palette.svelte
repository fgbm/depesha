<script lang="ts">
  import { onMount } from "svelte";
  import { app, type View } from "../lib/store.svelte";
  import { api } from "../lib/api";
  import { matches, roleLabel } from "../lib/format";
  import { t } from "../lib/i18n.svelte";
  import { snoozePresets } from "../lib/later";

  let {
    onCompose,
    onReply,
    onForward,
    onSearch,
  }: { onCompose: () => void; onReply: (all: boolean) => void; onForward: () => void; onSearch: () => void } = $props();

  interface Command {
    label: string;
    hint?: string;
    run: () => void;
  }

  let query = $state("");
  let active = $state(0);
  let input = $state<HTMLInputElement | null>(null);


  function go(v: View): () => void {
    return () => app.setView(v);
  }

  const commands = $derived.by(() => {
    const list: Command[] = [{ label: t("cmd.compose"), hint: "c", run: onCompose }];
    const target = app.selectedIds();
    const msg = app.opened;
    if (msg) {
      list.push(
        { label: t("act.reply"), hint: "r", run: () => onReply(false) },
        { label: t("cmd.replyAll"), hint: "a", run: () => onReply(true) },
        { label: t("act.forward"), hint: "f", run: onForward },
      );
    }
    if (target.length) {
      list.push({ label: t("cmd.done"), hint: "e", run: () => app.archive() });
      for (const p of snoozePresets()) list.push({ label: t("cmd.snooze", { when: p.label.toLowerCase() }), hint: p.hint, run: () => app.snooze(p.at) });
      list.push(
        { label: t("act.delete"), hint: "Delete", run: () => app.remove() },
        { label: t("act.spam"), hint: "!", run: () => app.spam() },
        { label: t("cmd.flag"), hint: "s", run: () => msg && app.flag("flagged", !msg.row.flags.flagged) },
        { label: t("act.markUnread"), hint: "u", run: () => app.flag("seen", false) },
      );
      const account = msg?.row.account_id ?? app.messages.find((m) => m.id === target[0])?.account_id;
      for (const f of app.folders.filter((f) => f.account_id === account && f.selectable && !f.hidden)) {
        list.push({ label: t("cmd.moveTo", { folder: f.role ? roleLabel(f.role) : f.display_name }), run: () => app.moveTo(f.name) });
      }
    }
    if (app.lastUndo) list.push({ label: t("cmd.undo", { what: app.lastUndo.text }), hint: "z", run: () => app.undo() });
    list.push(
      { label: t("cmd.search"), hint: "/", run: onSearch },
      { label: t("cmd.go", { where: t("nav.allInboxes").toLowerCase() }), run: go({ kind: "unified", role: "inbox" }) },
      { label: t("cmd.go", { where: t("nav.unread").toLowerCase() }), run: go({ kind: "unified", role: "inbox", unread: true }) },
      { label: t("cmd.go", { where: t("nav.flagged").toLowerCase() }), run: go({ kind: "unified", role: "inbox", flagged: true }) },
      { label: t("cmd.go", { where: t("role.snoozed").toLowerCase() }), run: go({ kind: "snoozed" }) },
      { label: t("cmd.go", { where: t("nav.followups").toLowerCase() }), run: go({ kind: "followups" }) },
      { label: t("cmd.go", { where: t("nav.outbox").toLowerCase() }), run: go({ kind: "outbox" }) },
    );
    const many = app.accounts.length > 1;
    for (const f of app.folders.filter((f) => f.selectable && !f.hidden)) {
      const acc = app.account(f.account_id);
      const name = f.role ? roleLabel(f.role) : f.display_name;
      list.push({
        label: t("cmd.openFolder", { folder: name }) + (many && acc ? ` · ${acc.display_name || acc.email}` : ""),
        run: go({ kind: "folder", account_id: f.account_id, folder: f.name }),
      });
    }
    const dnd = app.settings.dnd_until > Date.now() / 1000;
    list.push(
      dnd
        ? { label: t("cmd.dndOff"), run: () => app.saveSettings({ ...app.settings, dnd_until: 0 }) }
        : { label: t("cmd.dndHour"), run: () => app.saveSettings({ ...app.settings, dnd_until: Math.floor(Date.now() / 1000) + 3600 }) },
      { label: t("cmd.sync"), run: () => api.syncNow().catch((e) => app.fail(e)) },
      { label: t("settings.title"), run: () => (app.settingsOpen = true) },
      { label: t("cmd.addAccount"), run: () => (app.wizard = { account: null }) },
    );
    return list;
  });

  const shown = $derived(commands.filter((c) => matches(c.label, query)).slice(0, 12));

  $effect(() => {
    void query;
    active = 0;
  });

  onMount(() => input?.focus());

  function run(c: Command | undefined) {
    if (!c) return;
    app.paletteOpen = false;
    c.run();
  }

  function onKey(e: KeyboardEvent) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      active = Math.min(shown.length - 1, active + 1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      active = Math.max(0, active - 1);
    } else if (e.key === "Enter") {
      e.preventDefault();
      run(shown[active]);
    } else if (e.key === "Escape") {
      e.preventDefault();
      app.paletteOpen = false;
    }
  }
</script>

<div class="backdrop" role="presentation" onpointerdown={(e) => e.target === e.currentTarget && (app.paletteOpen = false)}>
  <div class="palette" role="dialog" aria-label={t("cmd.title")}>
    <input class="q" bind:this={input} bind:value={query} onkeydown={onKey} placeholder={t("cmd.placeholder")} />
    <div class="items" role="listbox">
      {#each shown as c, i (c.label)}
        <button class="item" class:active={i === active} role="option" aria-selected={i === active} onpointermove={() => (active = i)} onclick={() => run(c)}>
          <span>{c.label}</span>
          {#if c.hint}<span class="hint">{c.hint}</span>{/if}
        </button>
      {:else}
        <div class="none muted">{t("cmd.none")}</div>
      {/each}
    </div>
  </div>
</div>

<style>
  .backdrop {
    position: fixed;
    inset: 0;
    background: rgb(0 0 0 / 25%);
    z-index: 60;
    display: flex;
    justify-content: center;
    align-items: flex-start;
    padding-top: 12vh;
  }

  .palette {
    width: min(620px, calc(100vw - 40px));
    background: var(--paper);
    border-radius: 10px;
    box-shadow: 0 20px 50px rgb(0 0 0 / 30%);
    overflow: hidden;
  }

  .q {
    width: 100%;
    border: none;
    border-bottom: 1px solid var(--line);
    padding: 14px 16px;
    font-size: 16px;
    outline: none;
    background: transparent;
  }

  .items {
    max-height: 60vh;
    overflow-y: auto;
    padding: 4px;
  }

  .item {
    display: flex;
    width: 100%;
    align-items: center;
    border: none;
    background: none;
    text-align: left;
    padding: 8px 12px;
    border-radius: 6px;
  }

  .item.active {
    background: var(--selected);
  }

  .hint {
    margin-left: auto;
    padding-left: 16px;
    font-size: 12px;
    color: var(--muted);
    white-space: nowrap;
  }

  .none {
    padding: 14px;
  }
</style>

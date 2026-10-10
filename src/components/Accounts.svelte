<script lang="ts">
  import ArrowUp from "@lucide/svelte/icons/arrow-up";
  import ArrowDown from "@lucide/svelte/icons/arrow-down";
  import Plus from "@lucide/svelte/icons/plus";
  import Settings from "@lucide/svelte/icons/settings";
  import { app } from "../lib/store.svelte";
  import { api } from "../lib/api";
  import { t } from "../lib/i18n.svelte";
  import { accountColor } from "../lib/format";
  import type { AccountView } from "../lib/types";

  /** The mailbox manager: the order mailboxes are shown in and their names. Changes apply at once. */
  let { onOpen }: { onOpen: (page: string) => void } = $props();
  /** Names being typed, by account id; saved on Enter or leaving the field. */
  let names = $state<Record<string, string>>({});

  async function arrange(from: number, to: number) {
    if (to < 0 || to >= app.accounts.length) return;
    const list = [...app.accounts];
    const [moved] = list.splice(from, 1);
    list.splice(to, 0, moved);
    // The sidebar follows at once; the file is written behind it.
    app.accounts = list;
    try {
      await api.accountsArrange(list.map((a) => a.id));
    } catch (e) {
      app.ui.fail(e);
    }
    await app.loadAccounts();
  }

  async function look(acc: AccountView, label: string, color: string) {
    try {
      await api.accountLook(acc.id, label, color);
    } catch (e) {
      app.ui.fail(e);
    }
    await app.loadAccounts();
  }

  function saveName(acc: AccountView) {
    const name = names[acc.id];
    if (name === undefined) return;
    delete names[acc.id];
    if (name.trim() !== (acc.label ?? "")) look(acc, name, acc.color ?? "");
  }

  function onRowKey(e: KeyboardEvent, i: number) {
    // Alt+↑/↓ in the name moves the mailbox, as lines move in editors.
    if (e.altKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
      e.preventDefault();
      arrange(i, e.key === "ArrowUp" ? i - 1 : i + 1);
    }
  }

  /** A mailbox's own page in the same window. */
  function settings(acc: AccountView | null) {
    onOpen(acc ? `account:${acc.id}` : "account:new");
  }
</script>

<!-- A page of the settings window. -->
<div class="accounts">
    <p class="muted small hint">{t("accounts.hint")}</p>
    <div class="content">
      {#each app.accounts as acc, i (acc.id)}
        {@const color = accountColor(acc, i)}
        <div class="acc" role="group" aria-label={acc.email}>
          <div class="order">
            <button class="btn ghost icon" disabled={i === 0} onclick={() => arrange(i, i - 1)} title={t("accounts.up")} aria-label={t("accounts.up")}><ArrowUp size={14} /></button>
            <button class="btn ghost icon" disabled={i === app.accounts.length - 1} onclick={() => arrange(i, i + 1)} title={t("accounts.down")} aria-label={t("accounts.down")}><ArrowDown size={14} /></button>
          </div>
          <!-- The colour is chosen on the mailbox's page. -->
          <span class="swatch" style:background={color} aria-hidden="true"></span>
          <div class="who">
            <input
              class="input name"
              value={names[acc.id] ?? acc.label ?? ""}
              placeholder={acc.email}
              aria-label={t("accounts.name")}
              oninput={(e) => (names[acc.id] = e.currentTarget.value)}
              onblur={() => saveName(acc)}
              onkeydown={(e) => (e.key === "Enter" ? e.currentTarget.blur() : onRowKey(e, i))}
            />
            <span class="muted small email">{acc.email}</span>
          </div>
          <button class="btn ghost icon" onclick={() => settings(acc)} title={t("account.settings")} aria-label={t("account.settings")}><Settings size={15} /></button>
        </div>
      {/each}
    </div>
    <button class="btn add" onclick={() => settings(null)}><Plus size={15} /> {t("account.add")}</button>
</div>

<style>
  .hint {
    margin: 14px 0 4px;
  }

  .content {
    padding: 4px 0 12px;
  }

  .add {
    margin-bottom: 14px;
  }

  .acc {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 8px 0;
  }

  .acc + .acc {
    border-top: 1px solid var(--line);
  }

  .order {
    display: flex;
    flex-direction: column;
  }

  .order :global(.btn.icon) {
    padding: 1px 4px;
  }

  .swatch {
    width: 14px;
    height: 14px;
    border-radius: 50%;
    flex: none;
    box-shadow: inset 0 0 0 1px color-mix(in srgb, #000 15%, transparent);
  }

  .who {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .name {
    width: 100%;
  }

  .email {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    padding-left: 2px;
  }
</style>

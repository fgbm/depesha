<script lang="ts">
  import ArrowUp from "@lucide/svelte/icons/arrow-up";
  import ArrowDown from "@lucide/svelte/icons/arrow-down";
  import Check from "@lucide/svelte/icons/check";
  import Plus from "@lucide/svelte/icons/plus";
  import Settings from "@lucide/svelte/icons/settings";
  import { app } from "../lib/store.svelte";
  import { api } from "../lib/api";
  import { t } from "../lib/i18n.svelte";
  import { ACCOUNT_PALETTE, accountColor } from "../lib/format";
  import type { AccountView } from "../lib/types";
  import Popover from "./Popover.svelte";

  /** The mailbox manager: the order mailboxes are shown in, their names and colours. Changes apply at once. */
  let colorFor = $state<string | null>(null);
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
      app.fail(e);
    }
    await app.loadAccounts();
  }

  async function look(acc: AccountView, label: string, color: string) {
    try {
      await api.accountLook(acc.id, label, color);
    } catch (e) {
      app.fail(e);
    }
    await app.loadAccounts();
  }

  function saveName(acc: AccountView) {
    const name = names[acc.id];
    if (name === undefined) return;
    delete names[acc.id];
    if (name.trim() !== (acc.label ?? "")) look(acc, name, acc.color ?? "");
  }

  function pick(acc: AccountView, color: string) {
    colorFor = null;
    look(acc, acc.label ?? "", color);
  }

  function onRowKey(e: KeyboardEvent, i: number) {
    // Alt+↑/↓ in the name moves the mailbox, as lines move in editors.
    if (e.altKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
      e.preventDefault();
      arrange(i, e.key === "ArrowUp" ? i - 1 : i + 1);
    }
  }

  function onKey(e: KeyboardEvent) {
    if (e.key === "Escape" && !colorFor) {
      e.preventDefault();
      app.accountsOpen = false;
    }
  }

  function settings(acc: AccountView | null) {
    app.accountsOpen = false;
    app.wizard = { account: acc };
  }
</script>

<div class="modal-backdrop" role="presentation">
  <div class="modal accounts" role="dialog" aria-label={t("accounts.title")} tabindex="-1" onkeydown={onKey}>
    <header>
      <h3>{t("accounts.title")}</h3>
      <p class="muted small">{t("accounts.hint")}</p>
    </header>
    <div class="content">
      {#each app.accounts as acc, i (acc.id)}
        {@const color = accountColor(acc, i)}
        <div class="acc" role="group" aria-label={acc.email}>
          <div class="order">
            <button class="btn ghost icon" disabled={i === 0} onclick={() => arrange(i, i - 1)} title={t("accounts.up")} aria-label={t("accounts.up")}><ArrowUp size={14} /></button>
            <button class="btn ghost icon" disabled={i === app.accounts.length - 1} onclick={() => arrange(i, i + 1)} title={t("accounts.down")} aria-label={t("accounts.down")}><ArrowDown size={14} /></button>
          </div>
          <span class="swatch-wrap">
            <button class="swatch" style:background={color} onclick={() => (colorFor = colorFor === acc.id ? null : acc.id)} title={t("accounts.color")} aria-label={t("accounts.color")}></button>
            <Popover bind:open={() => colorFor === acc.id, (v) => (colorFor = v ? acc.id : null)}>
              <div class="mt">{t("accounts.color")}</div>
              <div class="palette">
                {#each ACCOUNT_PALETTE as c (c)}
                  <button class="swatch" style:background={c} onclick={() => pick(acc, c)} aria-label={c} title={c}>
                    {#if (acc.color || "") === c}<Check size={12} />{/if}
                  </button>
                {/each}
              </div>
              <button class="mi" onclick={() => pick(acc, "")}>
                {#if !acc.color}<Check size={15} />{:else}<span class="pad"></span>{/if}
                {t("accounts.colorAuto")}
              </button>
            </Popover>
          </span>
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
    <footer>
      <button class="btn ghost" onclick={() => settings(null)}><Plus size={15} /> {t("account.add")}</button>
      <span class="spacer"></span>
      <button class="btn primary" onclick={() => (app.accountsOpen = false)}>{t("close")}</button>
    </footer>
  </div>
</div>

<style>
  .accounts {
    width: min(560px, calc(100vw - 40px));
    max-height: calc(100vh - 60px);
  }

  header {
    padding: 14px 20px 4px;
  }

  h3 {
    margin: 0 0 4px;
  }

  header p {
    margin: 0;
  }

  .content {
    overflow-y: auto;
    padding: 8px 20px 12px;
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

  .swatch-wrap {
    position: relative;
    display: inline-flex;
  }

  .swatch {
    width: 22px;
    height: 22px;
    border-radius: 50%;
    border: none;
    padding: 0;
    flex: none;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    color: #fff;
    box-shadow: inset 0 0 0 1px color-mix(in srgb, #000 15%, transparent);
  }

  .palette {
    display: grid;
    grid-template-columns: repeat(5, 22px);
    gap: 8px;
    padding: 6px 10px 8px;
  }

  .pad {
    width: 15px;
    flex: none;
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

  footer {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 10px 20px 14px;
    border-top: 1px solid var(--line);
  }

  .spacer {
    flex: 1;
  }
</style>

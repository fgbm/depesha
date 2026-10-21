<script lang="ts">
  import ArrowUp from "@lucide/svelte/icons/arrow-up";
  import ArrowDown from "@lucide/svelte/icons/arrow-down";
  import ChevronRight from "@lucide/svelte/icons/chevron-right";
  import Plus from "@lucide/svelte/icons/plus";
  import { app } from "../lib/store.svelte";
  import { api } from "../lib/api";
  import { t } from "../lib/i18n.svelte";
  import { accountColor, accountLabel } from "../lib/format";

  /**
   * The page «Mailboxes» (0.8.12, 3.4 А): the order of the mailboxes and «Add a mailbox». A row
   * opens the mailbox's own page, as its entry in the menu does; the name is changed there.
   */
  let { onOpen }: { onOpen: (page: string) => void } = $props();

  const many = $derived(app.mailboxes.accounts.length > 1);

  async function arrange(from: number, to: number) {
    if (to < 0 || to >= app.mailboxes.accounts.length) return;
    const list = [...app.mailboxes.accounts];
    const [moved] = list.splice(from, 1);
    list.splice(to, 0, moved);
    // The sidebar follows at once; the file is written behind it.
    app.mailboxes.accounts = list;
    try {
      await api.accountsArrange(list.map((a) => a.id));
    } catch (e) {
      app.ui.fail(e);
    }
    await app.mailboxes.loadAccounts();
  }

  function onRowKey(e: KeyboardEvent, i: number) {
    // Alt+↑/↓ moves the mailbox, as lines move in editors; the focus goes along with it.
    if (!e.altKey || (e.key !== "ArrowUp" && e.key !== "ArrowDown")) return;
    e.preventDefault();
    const to = e.key === "ArrowUp" ? i - 1 : i + 1;
    const id = app.mailboxes.accounts[i]?.id;
    void arrange(i, to).then(() => document.querySelector<HTMLElement>(`.accounts .mbrow[data-account="${CSS.escape(id ?? "")}"]`)?.focus());
  }
</script>

<!-- A page of the settings window. -->
<div class="accounts">
  <p class="muted hint">{t("accounts.hint")}</p>
  {#each app.mailboxes.accounts as acc, i (acc.id)}
    <div class="acc">
      <!-- Arrows are drawn from two mailboxes on: with one there is nothing to move (А18). -->
      {#if many}
        <div class="order">
          <button class="arrow" disabled={i === 0} onclick={() => arrange(i, i - 1)} title={t("accounts.up")} aria-label={t("accounts.up")}><ArrowUp size={12} /></button>
          <button class="arrow" disabled={i === app.mailboxes.accounts.length - 1} onclick={() => arrange(i, i + 1)} title={t("accounts.down")} aria-label={t("accounts.down")}><ArrowDown size={12} /></button>
        </div>
      {/if}
      <button class="mbrow" data-account={acc.id} onclick={() => onOpen(`account:${acc.id}`)} onkeydown={(e) => onRowKey(e, i)}>
        <span class="dot" style:background={accountColor(acc, i)} aria-hidden="true"></span>
        <span class="who"><span>{accountLabel(acc)}</span><span class="muted email">{acc.email}</span></span>
        <ChevronRight size={16} class="muted" />
      </button>
    </div>
  {/each}
  <button class="btn add" onclick={() => onOpen("account:new")}><Plus size={15} /> {t("account.add")}</button>
</div>

<style>
  .accounts {
    max-width: var(--column-max);
  }

  .hint {
    margin: 4px 0 10px;
    font-size: 13px;
  }

  .acc {
    display: flex;
    align-items: center;
    gap: 4px;
  }

  .order {
    display: flex;
    flex-direction: column;
  }

  .arrow {
    display: grid;
    place-items: center;
    padding: 0 2px;
    border: none;
    border-radius: 4px;
    background: none;
    color: var(--muted);
    cursor: pointer;
  }

  .arrow:hover:not(:disabled) {
    background: var(--hover);
    color: var(--ink);
  }

  .arrow:disabled {
    opacity: 0.35;
    cursor: default;
  }

  /* The cursor of the list is the ground alone (AGENTS.md: no bars, no frames). */
  .mbrow {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 8px 10px;
    border: none;
    border-radius: 6px;
    background: none;
    color: var(--ink);
    font: inherit;
    text-align: left;
    cursor: pointer;
  }

  .mbrow:hover,
  .mbrow:focus-visible {
    background: var(--hover);
    outline: none;
  }

  .dot {
    flex: none;
    width: 10px;
    height: 10px;
    border-radius: 50%;
  }

  .who {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
  }

  .email {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 12px;
  }

  .add {
    margin-top: 10px;
  }
</style>

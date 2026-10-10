<script lang="ts">
  // The second person of a merge (#104, M on a card that has no suggestion): the same search as
  // the book's list, over names and addresses. The arrows choose, Enter takes, Esc leaves.
  import { t } from "../../lib/i18n.svelte";
  import { addressesOf, hasAddress, matchPerson } from "../../lib/people";
  import { peopleBook } from "../../lib/peopleBook.svelte";
  import { peopleOps } from "../../lib/peopleOps.svelte";

  const first = $derived(peopleOps.picking);

  let query = $state("");
  // Another query starts at the first match.
  let at = $derived.by(() => {
    void query;
    return 0;
  });
  const before = document.activeElement as HTMLElement | null;

  const found = $derived(
    first
      ? peopleBook.list.filter((p) => !hasAddress(p, first.email) && matchPerson(p, query)).slice(0, 8)
      : [],
  );


  function close() {
    peopleOps.stopPicking();
    before?.focus();
  }

  function take(i: number) {
    const other = found[i];
    if (!first || !other) return;
    peopleOps.merge([first, other]);
  }

  function onKey(e: KeyboardEvent) {
    e.stopPropagation();
    if (e.key === "Escape") {
      e.preventDefault();
      close();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      at = Math.min(found.length - 1, at + 1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      at = Math.max(0, at - 1);
    } else if (e.key === "Enter") {
      e.preventDefault();
      take(at);
    }
  }

  const focusIn = (node: HTMLElement) => node.focus();
</script>

<svelte:window onkeydowncapture={onKey} />
{#if first}
  <div class="modal-backdrop pick-backdrop" role="presentation" onpointerdown={(e) => e.target === e.currentTarget && close()}>
    <div class="modal pick" role="dialog" aria-modal="true" aria-label={t("people.pickTitle", { name: first.name || first.email })}>
      <h3>{t("people.pickTitle", { name: first.name || first.email })}</h3>
      <input class="q" use:focusIn bind:value={query} placeholder={t("people.pickPlaceholder")} aria-label={t("people.pickPlaceholder")} autocomplete="off" />
      <div class="items" role="listbox">
        {#each found as p, i (p.id || p.email)}
          <button class="item" class:on={i === at} role="option" aria-selected={i === at} onpointermove={() => (at = i)} onclick={() => take(i)}>
            <b>{p.name || p.email}</b>
            <span class="muted small">{addressesOf(p)[0]}{p.emails.length > 1 ? ` +${p.emails.length - 1}` : ""}</span>
          </button>
        {:else}
          <p class="muted small">{t("people.noneFound")}</p>
        {/each}
      </div>
    </div>
  </div>
{/if}

<style>
  .pick-backdrop {
    z-index: 55;
  }

  .pick {
    width: min(420px, calc(100vw - 40px));
    padding: 18px 20px 16px;
    gap: 8px;
  }

  h3 {
    margin: 0;
    font-size: 15px;
  }

  .q {
    border: 1px solid var(--line);
    border-radius: 6px;
    padding: 6px 9px;
    background: var(--paper);
    color: var(--ink);
    font: inherit;
  }

  .items {
    display: flex;
    flex-direction: column;
    max-height: 260px;
    overflow-y: auto;
  }

  .item {
    display: flex;
    gap: 10px;
    align-items: baseline;
    padding: 6px 8px;
    border: none;
    border-radius: 6px;
    background: none;
    color: inherit;
    text-align: left;
  }

  .item.on {
    background: var(--selected);
  }

  .small {
    font-size: 12px;
  }
</style>

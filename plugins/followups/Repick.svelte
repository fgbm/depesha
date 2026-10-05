<script lang="ts">
  // "Set a new date" on a letter still without an answer, or "Wait for a reply again" on one
  // that ended: the date of "Custom…" alone. The answer is expected by then.
  import type { PluginContext } from "@depesha/plugin-api";
  import DueForm from "./DueForm.svelte";
  import { planOf, type Due } from "./due";
  import { followups } from "./state.svelte";
  import { S } from "./strings";

  let { ctx }: { ctx: PluginContext } = $props();

  const close = () => (followups.repick = null);

  function pick(due: Due) {
    const letter = followups.repick;
    if (!letter) return;
    close();
    const made = planOf("at" in due ? due : { spec: due.spec, deadline: null }, new Date(), "", "");
    if (!made) return;
    ctx
      .backend<number>("followup_postpone", { id: letter.id, secs: made.secs, deadline: true })
      .then(letter.set)
      .catch((e) => ctx.fail(e));
  }

  function onKey(e: KeyboardEvent) {
    if (!followups.repick || e.key !== "Escape") return;
    e.preventDefault();
    e.stopPropagation();
    close();
  }
</script>

<svelte:window onkeydowncapture={onKey} />

{#if followups.repick}
  <div class="modal-backdrop" role="presentation" onpointerdown={(e) => e.target === e.currentTarget && close()}>
    <div class="modal repick" role="dialog" aria-modal="true" aria-label={ctx.t(S.repickTitle)}>
      <DueForm {ctx} title={ctx.t(S.repickTitle)} onDone={pick} onCancel={close} />
    </div>
  </div>
{/if}

<style>
  .repick {
    padding: 10px 8px 4px;
  }

  /* The form's title, as in the menu of "Custom…". */
  .repick :global(.mt) {
    padding: 6px 10px 2px;
    font-size: 12px;
    color: var(--muted);
  }
</style>

<script lang="ts">
  // Answering a letter, centred on a hairline between its header and its text, as in
  // Yandex Mail; the toolbar keeps sorting. "Reply all" is offered only when it reaches
  // someone a plain reply does not. The pane (Reader.svelte) owns the actions.
  import Reply from "@lucide/svelte/icons/reply";
  import ReplyAll from "@lucide/svelte/icons/reply-all";
  import Forward from "@lucide/svelte/icons/forward";
  import { t } from "../../lib/i18n.svelte";
  import { shortcuts } from "../../lib/shortcuts.svelte";

  let {
    manyRecipients,
    reply,
    forward,
  }: {
    /** "Reply all" reaches someone a plain reply does not. */
    manyRecipients: boolean;
    reply: (all: boolean) => void;
    forward: () => void;
  } = $props();
</script>

<div class="acts">
  <button class="act" onclick={() => reply(false)} title={shortcuts.titled(t("act.replyHint"), "core.reply")}><Reply size={16} /> {t("act.reply")}</button>
  {#if manyRecipients}
    <button class="act" onclick={() => reply(true)} title={shortcuts.titled(t("act.replyAllHint"), "core.reply-all")}><ReplyAll size={16} /> {t("act.replyAllFull")}</button>
  {/if}
  <button class="act" onclick={forward} title={shortcuts.titled(t("act.forwardHint"), "core.forward")}><Forward size={16} /> {t("act.forward")}</button>
</div>

<style>
  /* Reply, reply all, forward: centred on a hairline between the header and the letter. */
  .acts {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 4px;
    margin: 2px 22px 12px;
  }

  .acts::before,
  .acts::after {
    content: "";
    flex: 1;
    min-width: 12px;
    height: 1px;
    background: var(--line);
  }

  .act {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 6px 12px;
    border: none;
    border-radius: 6px;
    background: none;
    color: var(--ink);
    font-weight: 550;
    white-space: nowrap;
  }

  .act:hover {
    background: var(--hover);
  }
</style>

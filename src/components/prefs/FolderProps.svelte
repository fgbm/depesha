<script lang="ts" module>
  // Letters of the set rights, in RFC 4314 order, for the technical details.
  import type { Rights } from "../../lib/types";
  export function rightsLetters(r: Rights): string {
    const table: [string, boolean][] = [
      ["l", r.lookup],
      ["r", r.read],
      ["s", r.seen],
      ["w", r.write],
      ["i", r.insert],
      ["p", r.post],
      ["k", r.create_child],
      ["x", r.delete_folder],
      ["t", r.delete_messages],
      ["e", r.expunge],
      ["a", r.administer],
    ];
    return table.filter(([, on]) => on).map(([c]) => c).join("") || "—";
  }
</script>

<script lang="ts">
  // Свойства папки (#42, кадр 4А): доступ действиями, свои метки, чья папка, письма.
  // Права — словами, не буквами ACL: буквы и PERMANENTFLAGS уходят в «Подробности».
  // Карточка читает сервер только по «Проверить снова»; иначе показывает кэш.
  import Users from "@lucide/svelte/icons/users";
  import User from "@lucide/svelte/icons/user";
  import X from "@lucide/svelte/icons/x";
  import { app } from "../../lib/store.svelte";
  import { t, type Key } from "../../lib/i18n.svelte";
  import { when } from "../../lib/later";
  import { actionsOf, canCheckLabels, readOnly } from "../../lib/labels";
  import type { AccountView, FolderAction, FolderInfo, LabelCheck } from "../../lib/types";
  import { untrack } from "svelte";
  import { labels } from "../../lib/labels.svelte";

  let {
    at,
    account,
    folder,
    onclose,
  }: { at: { x: number; y: number }; account: AccountView; folder: FolderInfo; onclose: () => void } = $props();

  // The card reads the cache at once and asks the server only on "Check again".
  const info = $derived(labels.prop(account.id, folder.name));
  const key = $derived(`${account.id}\u0000${folder.name}`);
  const checking = $derived(!!labels.checking[key]);
  const rights = $derived(info?.rights ?? null);
  const owner = $derived(info?.owner ?? { kind: "mine" as const });

  let details = $state(false);
  /** The "what will happen" window before the test message is put on the server (#42, frame 9). */
  let confirmCheck = $state(false);
  let checkRunning = $state(false);
  let checkResult = $state<LabelCheck | null>(null);
  const { x, y } = untrack(() => at);

  // The outcome of the last check: the card and the labels picker read it.
  const checkOutcome = $derived(checkResult ?? info?.label_check ?? null);

  async function runCheck() {
    confirmCheck = false;
    checkRunning = true;
    try {
      checkResult = await labels.runLabelCheck(account.id, folder.name);
    } finally {
      checkRunning = false;
    }
  }

  // The card follows the folder's opening too: a read of props already asked for.
  $effect(() => {
    void folder.name;
    if (!info) labels.loadProps(account.id, folder.name);
  });

  const ACTION_KEY: Record<FolderAction, Key> = {
    read: "folder.right.read",
    mark_seen: "folder.right.markSeen",
    write: "folder.right.write",
    insert: "folder.right.insert",
    delete: "folder.right.delete",
    create_child: "folder.right.createChild",
    delete_folder: "folder.right.deleteFolder",
    administer: "folder.right.administer",
  };

  /** The owner's line under "Чья папка". */
  const ownerText = $derived.by(() => {
    if (owner.kind === "shared") return t("folder.owner.shared");
    if (owner.kind === "other") return t("folder.owner.other", { name: owner.name });
    return t("folder.owner.mine");
  });

  function pos(px: number, py: number): string {
    // Keep the card inside the window.
    const w = 320;
    const h = 460;
    const left = Math.min(px, window.innerWidth - w - 8);
    const top = Math.min(py, Math.max(8, window.innerHeight - h - 8));
    return `left:${left}px;top:${top}px`;
  }
</script>

{#if confirmCheck}
  <!-- The explainer before the check writes anything (#42, frame 9, left). -->
  <div class="backdrop" role="presentation" onclick={() => (confirmCheck = false)}></div>
  <div class="cdlg" role="dialog" aria-label={t("label.check.title", { folder: folder.display_name })}>
    <h3>{t("label.check.title", { folder: folder.display_name })}</h3>
    <p>{t("label.check.lead")}</p>
    <ol>
      <li>{t("label.check.step1")}</li>
      <li>{t("label.check.step2")}</li>
      <li>{t("label.check.step3")}</li>
    </ol>
    <p class="hint">{t("label.check.note")}</p>
    <div class="acts">
      <button class="btn" onclick={() => (confirmCheck = false)}>{t("cancel")}</button>
      <button class="btn primary" onclick={runCheck}>{t("label.check.run")}</button>
    </div>
  </div>
{/if}

<div class="backdrop" role="presentation" onclick={onclose} oncontextmenu={(e) => (e.preventDefault(), onclose())}></div>
<div class="fcard" style={pos(x, y)} role="dialog" aria-label={folder.display_name}>
  <div class="fh">
    <span class="ic">{#if owner.kind === "mine"}<User size={16} />{:else}<Users size={16} />{/if}</span>
    <div class="t"><b>{folder.display_name}</b><span class="p">{folder.name}</span></div>
    <button class="x" onclick={onclose} aria-label={t("close")}><X size={15} /></button>
  </div>

  <div class="fsec">
    <div class="k">
      {t("folder.access")}
      {#if !rights}<span class="v mut">{t("folder.unknown")}</span>
      {:else if readOnly(rights)}<span class="v warn">{t("folder.readOnly")}</span>
      {:else}<span class="v">{t("folder.readWrite")}</span>{/if}
    </div>
    {#if !rights}
      <p class="hint">{t("folder.unknownHint")}</p>
    {:else}
      <ul class="rights">
        {#each actionsOf(rights) as a (a.action)}
          <li class:y={a.allowed} class:n={!a.allowed}><span class="m">{a.allowed ? "✓" : "−"}</span>{t(ACTION_KEY[a.action])}</li>
        {/each}
      </ul>
    {/if}
  </div>

  <div class="fsec">
    <div class="k">{t("folder.labels")} {#if checkOutcome}<span class="v mut">{t(`label.check.done.${checkOutcome}` as Key, { folder: folder.display_name })}</span>{:else if info?.labels_on_server == null}<span class="v mut">{t("folder.unknown")}</span>{:else if info.labels_on_server}<span class="v">{t("folder.labelsServer")}</span>{:else}<span class="v mut">{t("folder.labelsLocal")}</span>{/if}</div>
    {#if info?.labels_on_server === false && !checkOutcome}<p>{t("folder.labelsLocalHint")}</p>{/if}
    {#if account && !account.ews && rights && !rights.read}
      <p class="hint">{t("folder.labelsNoRead")}</p>
    {:else if account && !account.ews && !canCheckLabels(rights)}
      <p class="hint">{t("folder.labelsNoCheck")}</p>
    {:else if account && !account.ews}
      <p class="hint">
        <button class="link" onclick={() => (confirmCheck = true)} disabled={checking || checkRunning}>
          {checking || checkRunning ? t("label.check.running") : t("label.check.open")}
        </button>
      </p>
    {/if}
  </div>

  <div class="fsec">
    <div class="k">{t("folder.owner")} <span class="v mut">{ownerText}</span></div>
  </div>

  <div class="fsec">
    <div class="k">{t("folder.messages")} <span class="v mut">{t("folder.letters", { n: folder.total, unread: folder.unread })}</span></div>
  </div>

  {#if info?.refused === "no-rights"}
    <div class="fsec"><p class="warn-text">{t("folder.refused")}</p></div>
  {/if}

  <div class="ffoot">
    {#if info?.checked}<span>{t("folder.checked", { when: when(info.checked) })}</span>{:else}<span class="muted">{t("folder.never")}</span>{/if}
    <span class="sp"></span>
    <button class="link" onclick={() => labels.check(account.id, folder.name)} disabled={checking}>
      {checking ? t("server.checking") : t("folder.checkAgain")}
    </button>
    <button class="link" onclick={() => (details = !details)}>{t("folder.details")}</button>
  </div>

  {#if details}
    <div class="tech">
      <div class="label">{t("folder.rawRights")}</div>
      <pre>{rights ? rightsLetters(rights) : "—"}</pre>
      {#if info?.permanent?.length}
        <div class="label">{t("folder.permanent")}</div>
        <pre>{info.permanent.map((f) => `\\${f}`).join(" ")}</pre>
      {/if}
    </div>
  {/if}
</div>

<style>
  .backdrop {
    position: fixed;
    inset: 0;
    z-index: 40;
  }

  .fcard {
    position: fixed;
    z-index: 41;
    width: 320px;
    max-height: calc(100vh - 24px);
    overflow-y: auto;
    border: 1px solid var(--line);
    border-radius: 10px;
    background: var(--paper);
    box-shadow: 0 2px 4px rgb(0 0 0 / 12%), 0 12px 32px rgb(0 0 0 / 18%);
  }

  .fh {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 10px 12px;
    border-bottom: 1px solid var(--line);
  }

  .ic {
    flex: none;
    color: var(--muted);
    display: inline-flex;
  }

  .t {
    flex: 1;
    min-width: 0;
    line-height: 1.3;
  }

  .t b {
    display: block;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .t .p {
    display: block;
    color: var(--muted);
    font-size: 11px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .x {
    flex: none;
    border: none;
    background: none;
    color: var(--muted);
    padding: 2px;
  }

  .fsec {
    padding: 8px 12px;
    border-bottom: 1px solid var(--line);
    font-size: 12.5px;
    line-height: 1.45;
  }

  .fsec p {
    margin: 4px 0 0;
  }

  .k {
    display: flex;
    justify-content: space-between;
    gap: 8px;
    color: var(--muted);
  }

  .v {
    color: var(--ink);
    font-weight: 600;
  }

  .v.mut {
    color: var(--muted);
    font-weight: 400;
  }

  .v.warn {
    color: var(--warn);
  }

  .hint {
    color: var(--muted);
  }

  .warn-text {
    color: var(--warn);
  }

  .rights {
    list-style: none;
    margin: 6px 0 0;
    padding: 0;
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 3px 16px;
  }

  .rights li {
    display: flex;
    gap: 6px;
    align-items: baseline;
  }

  .rights .m {
    flex: none;
    width: 12px;
    text-align: center;
  }

  .rights li.y .m {
    color: var(--ok);
  }

  .rights li.n {
    color: var(--muted);
  }

  .ffoot {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 12px;
    color: var(--muted);
    font-size: 11.5px;
  }

  .sp {
    flex: 1;
  }

  .link {
    border: none;
    background: none;
    color: var(--link);
    font: inherit;
    font-size: 11.5px;
    padding: 0;
  }

  .tech {
    padding: 0 12px 12px;
  }

  .label {
    margin: 8px 0 4px;
    color: var(--muted);
    font-size: 11.5px;
  }

  pre {
    margin: 0;
    padding: 8px 10px;
    border-radius: 6px;
    background: var(--paper-2);
    font-family: var(--mono);
    font-size: 11.5px;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }

  /* The explainer before the label check (#42, frame 9): a small centered dialog. */
  .cdlg {
    position: fixed;
    z-index: 60;
    left: 50%;
    top: 50%;
    transform: translate(-50%, -50%);
    width: min(420px, calc(100vw - 32px));
    padding: 16px 18px;
    border: 1px solid var(--line);
    border-radius: 10px;
    background: var(--paper);
    box-shadow: 0 2px 4px rgb(0 0 0 / 12%), 0 12px 32px rgb(0 0 0 / 18%);
    font-size: 13px;
    line-height: 1.5;
  }

  .cdlg h3 {
    margin: 0 0 8px;
    font-size: 15px;
  }

  .cdlg p {
    margin: 0 0 8px;
  }

  .cdlg ol {
    margin: 0 0 8px;
    padding-left: 20px;
  }

  .cdlg .hint {
    color: var(--muted);
    font-size: 12px;
  }

  .cdlg .acts {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    margin-top: 12px;
  }
</style>

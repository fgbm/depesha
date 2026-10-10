<script lang="ts">
  // The smart sections above the mailboxes: «All inboxes», «Unread», «Flagged», «All
  // drafts», the plugins' views, «Outbox» and the address book «People» (#104). The same list in both halves of the
  // sidebar — a row with a counter in the full one, a square tile with a badge in the
  // strip — so it is rendered once here.
  import Hourglass from "@lucide/svelte/icons/hourglass";
  import Mails from "@lucide/svelte/icons/mails";
  import Mail from "@lucide/svelte/icons/mail";
  import Flag from "@lucide/svelte/icons/flag";
  import FilePen from "@lucide/svelte/icons/file-pen";
  import Users from "@lucide/svelte/icons/users";
  import type { Component } from "svelte";
  import { app, type View } from "../../lib/store.svelte";
  import { t } from "../../lib/i18n.svelte";
  import { registry } from "../../plugin-host/registry.svelte";
  import { sidebarUi } from "./sidebar.svelte";

  let { variant }: { variant: "full" | "strip" } = $props();

  // With one account «All inboxes» and «All drafts» would repeat its own folders.
  const smart = $derived<{ view: View; label: string; icon: Component; count: number; quiet: boolean }[]>([
    ...(app.accounts.length === 1 ? [] : [{ view: { kind: "unified", role: "inbox" } as View, label: t("nav.allInboxes"), icon: Mails, count: sidebarUi.totalUnread(), quiet: false }]),
    { view: { kind: "unified", role: "inbox", unread: true } as View, label: t("nav.unread"), icon: Mail, count: 0, quiet: false },
    { view: { kind: "unified", role: "inbox", flagged: true } as View, label: t("nav.flagged"), icon: Flag, count: 0, quiet: false },
    ...(app.accounts.length === 1 ? [] : [{ view: { kind: "unified", role: "drafts" } as View, label: t("nav.allDrafts"), icon: FilePen, count: sidebarUi.totalDrafts(), quiet: true }]),
  ]);
</script>

{#if variant === "strip"}
  {#each smart as s (s.label)}
    <button class="tile" class:active={sidebarUi.isActive(s.view)} onclick={() => app.selection.setView(s.view)} title={s.label} aria-label={s.label}>
      <s.icon size={18} />
      {#if s.count > 0}<span class="badge" class:quiet={s.quiet}>{sidebarUi.badge(s.count)}</span>{/if}
    </button>
  {/each}
  {#each registry.items("views") as pv (pv.id)}
    {@const n = pv.count()}
    {#if n > 0 || pv.shown?.()}
      <button class="tile" class:active={sidebarUi.isActive({ kind: "plugin", id: pv.id })} onclick={() => app.selection.setView({ kind: "plugin", id: pv.id })} title={pv.title()} aria-label={pv.title()}>
        <pv.icon size={18} />
        {#if n > 0}<span class="badge quiet">{sidebarUi.badge(n)}</span>{/if}
      </button>
    {/if}
  {/each}
  {#if app.outbox.length > 0}
    <button class="tile" class:active={sidebarUi.isActive({ kind: "outbox" })} onclick={() => app.selection.setView({ kind: "outbox" })} title={t("nav.outbox")} aria-label={t("nav.outbox")}>
      <Hourglass size={18} />
      <span class="badge" class:alert={sidebarUi.outboxFailed}>{sidebarUi.badge(app.outbox.length)}</span>
    </button>
  {/if}
  <button class="tile" class:active={sidebarUi.isActive({ kind: "people" })} onclick={() => void app.openPeople()} title={t("nav.people")} aria-label={t("nav.people")}>
    <Users size={18} />
  </button>
{:else}
  {#each smart as s (s.label)}
    <button class="item" class:active={sidebarUi.isActive(s.view)} onclick={() => app.selection.setView(s.view)}>
      <span class="icon"><s.icon size={16} /></span>
      <span class="name">{s.label}</span>
      {#if s.count > 0}<span class="count" class:quiet={s.quiet}>{s.count}</span>{/if}
    </button>
  {/each}
  {#each registry.items("views") as pv (pv.id)}
    {@const n = pv.count()}
    {#if n > 0 || pv.shown?.()}
      <button class="item" class:active={sidebarUi.isActive({ kind: "plugin", id: pv.id })} onclick={() => app.selection.setView({ kind: "plugin", id: pv.id })}>
        <span class="icon"><pv.icon size={16} /></span>
        <span class="name">{pv.title()}</span>
        {#if n > 0}<span class="count quiet">{n}</span>{/if}
      </button>
    {/if}
  {/each}
  {#if app.outbox.length > 0}
    <button class="item" class:active={sidebarUi.isActive({ kind: "outbox" })} onclick={() => app.selection.setView({ kind: "outbox" })}>
      <span class="icon"><Hourglass size={16} /></span>
      <span class="name">{t("nav.outbox")}</span>
      <span class="count" class:alert={sidebarUi.outboxFailed}>{app.outbox.length}</span>
    </button>
  {/if}
  <button class="item" class:active={sidebarUi.isActive({ kind: "people" })} onclick={() => void app.openPeople()}>
    <span class="icon"><Users size={16} /></span>
    <span class="name">{t("nav.people")}</span>
  </button>
{/if}

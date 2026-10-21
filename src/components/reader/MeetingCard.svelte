<script lang="ts">
  // The card of a meeting invitation in the reading pane (0.8.13, decisions 1.1 А, 2.1 А, 3.1 А,
  // 5.1 А, 6.1 А, 7.1 А, 8.1 А). The core parsed the calendar; here it is said in the reader's
  // own zone and language, with the actions of the file it came as. A file the core could not
  // read keeps its place among the files and says why here, so nothing of the letter is lost.
  import CalendarPlus from "@lucide/svelte/icons/calendar-plus";
  import Clock from "@lucide/svelte/icons/clock";
  import Copy from "@lucide/svelte/icons/copy";
  import Download from "@lucide/svelte/icons/download";
  import Ellipsis from "@lucide/svelte/icons/ellipsis";
  import MapPin from "@lucide/svelte/icons/map-pin";
  import Repeat from "@lucide/svelte/icons/repeat";
  import TriangleAlert from "@lucide/svelte/icons/triangle-alert";
  import Users from "@lucide/svelte/icons/users";
  import Video from "@lucide/svelte/icons/video";
  import Popover from "../Popover.svelte";
  import { app } from "../../lib/store.svelte";
  import { t, tn } from "../../lib/i18n.svelte";
  import {
    answerLabel,
    answersLine,
    changed,
    dayLabel,
    instant,
    isCancelled,
    isUpdate,
    kindLabel,
    localCaption,
    otherZone,
    repeatLabel,
    whenLabel,
  } from "../../lib/meeting";
  import { copyMeetingLink } from "../../lib/meetingActions";
  import type { Key } from "../../lib/i18n.svelte";
  import type { AttachmentInfo, Notice } from "../../lib/types";

  let {
    notice,
    attachment,
    onAdd,
    onSave,
    onOpenAsText,
  }: {
    notice: Notice;
    /** The `.ics` of the card, when the calendar came as a file; none for the letter's other form. */
    attachment: AttachmentInfo | undefined;
    /** Hands the file to the calendar of the system. */
    onAdd: (a: AttachmentInfo) => void;
    onSave: (a: AttachmentInfo) => void;
    /** Shows the file itself in place of the letter; absent where the letter has no viewer, as in
     *  the chain of a conversation, and then the card offers no way into the file's text. */
    onOpenAsText?: (a: AttachmentInfo) => void;
  } = $props();

  const meeting = $derived(notice.events[0] ?? null);
  const previous = $derived(notice.previous);
  const reply = $derived(notice.method === "reply");
  /** `STATUS:CANCELLED` of the meeting itself says it as well as the calendar's method. */
  const cancelled = $derived(isCancelled(notice));
  /** A later version of the invitation (7.1 А): the mark stands even when the earlier letter is
   *  not in the case, and only then is there nothing to compare it with. */
  const revision = $derived(isUpdate(notice));
  const update = $derived(!!previous && !!meeting && revision && changed(previous, meeting));
  const organizerZone = $derived(meeting ? otherZone(meeting) : null);
  const repeat = $derived(meeting?.repeat ? repeatLabel(meeting.repeat, meeting.start) : null);
  const where = $derived(meeting?.location ?? "");
  const from = $derived(previous?.location ?? "");
  const organizer = $derived(meeting?.organizer ? meeting.organizer.name.trim() || meeting.organizer.email : "");
  const link = $derived(meeting?.link ?? "");
  /** The earlier version put the meeting elsewhere: the old place stands beside the new one. */
  const movedFrom = $derived(previous && from !== where ? from : "");
  const startsChanged = $derived(
    update && !!previous && !!meeting && (instant(previous.start) !== instant(meeting.start) || previous.all_day !== meeting.all_day),
  );
  const later = $derived(notice.events.slice(1).map((m) => dayLabel(instant(m.start) ?? 0)));
  /** What the header of the card says it is (экран 4). */
  const kind = $derived.by(() => {
    if (notice.problem) return t("cal.attachment");
    if (reply) return t("cal.kind.reply");
    if (!meeting) return t("cal.kind.invitation");
    if (notice.events.length > 1) return tn("cal.kind.events", notice.events.length);
    if (cancelled) return t("cal.kind.meeting");
    return kindLabel(meeting, notice.method);
  });
  /** The answer of the one who wrote a `REPLY`: the pill of the card. */
  const answer = $derived(answerLabel(meeting?.attendees.find((a) => a.status && a.status !== "needs_action")?.status ?? null));

  let attendeesOpen = $state(false);
  let descriptionOpen = $state(false);
  let menu = $state(false);
</script>

{#if meeting || notice.problem}
  <div
    class="cal"
    class:off={cancelled}
    class:quiet={reply || !!notice.problem}
    role="group"
    aria-label={cancelled ? t("cal.cancelled") : t("cal.kind.invitation")}
  >
    <div class="cal-h">
      <span>{kind}</span>
      {#if cancelled}<span class="pill bad">{t("cal.cancelled")}</span>
      {:else if revision}<span class="pill warn">{t("cal.changed")}</span>
      {:else if reply && answer}<span class="pill ok">{answer}</span>{/if}
    </div>

    {#if notice.problem}
      <div class="cr bad">
        <TriangleAlert size={14} />
        <span><b>{t("cal.notRead")}.</b> {t(`cal.problem.${notice.problem}` as Key)}</span>
      </div>
    {:else if meeting}
      <div class="cal-t" title={meeting.title}>{meeting.title}</div>
      {#if startsChanged && previous}
        <div class="cr sub"><Clock size={14} /><span class="struck">{whenLabel(previous)}</span></div>
      {/if}
      <div class="cr strong" class:struck={cancelled}>
        <Clock size={14} />
        <span>{whenLabel(meeting)} <span class="tz">{localCaption(meeting)}</span></span>
      </div>
      {#if organizerZone}
        <div class="cr sub">
          <span>{t("cal.organizerTime", { range: organizerZone.range })} <span class="tz">{organizerZone.caption}</span></span>
        </div>
      {/if}
      {#if where}
        <div class="cr" class:struck={cancelled}>
          <MapPin size={14} />
          <span>{where} <span class="tz" class:moved={!!movedFrom}>{#if movedFrom}{t("cal.was", { value: movedFrom })}{/if}</span></span>
        </div>
      {/if}
      {#if link && !cancelled}
        <div class="cr">
          <Video size={14} />
          <button class="btn small" title={link} onclick={() => app.ui.openLink(link)}>{t("cal.join")}</button>
        </div>
      {/if}
      {#if organizer}
        <div class="cr"><Users size={14} /><span>{t("cal.organizer", { name: organizer })}</span></div>
      {/if}
      {#if meeting.attendees.length}
        <div class="cr">
          <Users size={14} />
          <span>
            {t("cal.attendees", { n: meeting.attendees.length })} · {answersLine(meeting.attendees)}
            <button class="link" aria-expanded={attendeesOpen} onclick={() => (attendeesOpen = !attendeesOpen)}>
              {attendeesOpen ? t("cal.hide") : t("cal.show")}
            </button>
          </span>
        </div>
        {#if attendeesOpen}
          <ul class="people">
            {#each meeting.attendees as a (a.email)}
              <li>
                <span>{a.name.trim() || a.email}</span>
                {#if a.role}<span class="tz"> · {t(`cal.role.${a.role}` as Key)}</span>{/if}
                {#if answerLabel(a.status)}<span class="tz"> · {answerLabel(a.status)}</span>{/if}
              </li>
            {/each}
          </ul>
        {/if}
      {/if}
      {#if repeat}
        <div class="cr"><Repeat size={14} /><span>{repeat}</span></div>
      {/if}
      {#if cancelled}
        <div class="cr bad"><TriangleAlert size={14} /><span>{organizer ? t("cal.cancelledBy", { name: organizer }) : t("cal.cancelledByUnknown")}</span></div>
      {/if}
      {#if meeting.description && !cancelled}
        <div class="cal-d">
          <p class:fade={!descriptionOpen}>{meeting.description}</p>
          <button class="more" aria-expanded={descriptionOpen} onclick={() => (descriptionOpen = !descriptionOpen)}>
            {descriptionOpen ? t("cal.hide") : t("act.more")}
          </button>
        </div>
      {/if}
      {#if later.length}
        <p class="note">{tn("cal.moreEvents", later.length, { dates: later.join(", ") })}</p>
      {/if}
    {/if}

    <div class="cal-a">
      {#if attachment && !cancelled && !reply && !notice.problem}
        <button class="btn primary" onclick={() => onAdd(attachment)}><CalendarPlus size={14} /> {t("cal.addToCalendar")}</button>
      {/if}
      {#if attachment}
        <button class="btn ghost save" title={t("cal.saveIcs")} aria-label={t("cal.saveIcs")} onclick={() => onSave(attachment)}><Download size={14} /><span class="lbl">{t("cal.saveIcs")}</span></button>
      {/if}
      {#if attachment && onOpenAsText && (cancelled || reply || notice.problem)}
        <button class="btn ghost" onclick={() => onOpenAsText(attachment)}>{t("cal.openAsText")}</button>
      {/if}
      {#if link && !cancelled}
        <button class="btn ghost icon" title={t("cal.copyLink")} aria-label={t("cal.copyLink")} onclick={() => void copyMeetingLink(link)}><Copy size={14} /></button>
      {/if}
      {#if attachment && onOpenAsText && !notice.problem}
        <span class="anchor">
          <button class="btn ghost icon" title={t("act.more")} aria-label={t("act.more")} onclick={() => (menu = !menu)}><Ellipsis size={14} /></button>
          <Popover bind:open={menu} align="left">
            <button class="mi" onclick={() => { menu = false; onOpenAsText(attachment); }}>{t("cal.openAsText")}</button>
          </Popover>
        </span>
      {/if}
    </div>
  </div>
{/if}

<style>
  /* The meeting stands in the letter's flow where its file's chip would be: a pale fill and a
     stripe of the accent, the week's blocks; a cancelled one takes the red frame instead of the
     fill, so it reads as a warning and not as another meeting. */
  .cal {
    margin: 12px 22px 0;
    padding: 9px 12px 10px 10px;
    border: 1px solid color-mix(in srgb, var(--accent) 25%, var(--line));
    border-left: 3px solid var(--accent);
    border-radius: 6px;
    background: color-mix(in srgb, var(--accent) 7%, var(--paper));
  }

  .cal.off {
    border-color: color-mix(in srgb, var(--bad) 38%, var(--line));
    border-left-color: var(--bad);
    background: color-mix(in srgb, var(--bad) 6%, var(--paper));
  }

  .cal.quiet {
    border-color: var(--line);
    border-left-color: color-mix(in srgb, var(--accent) 55%, var(--line));
    background: var(--paper);
  }

  .cal-h {
    display: flex;
    align-items: center;
    gap: 8px;
    margin: 0 0 3px;
    font-size: 10.5px;
    font-weight: 700;
    letter-spacing: 0.05em;
    text-transform: uppercase;
    color: var(--muted);
  }

  /* The name of the meeting is what tells one from another: it wraps to a second line and is
     cut only after that, the whole of it in the title. */
  .cal-t {
    font-size: 14px;
    font-weight: 600;
    line-height: 1.35;
    overflow: hidden;
    display: -webkit-box;
    line-clamp: 2;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
  }

  .cal.off .cal-t {
    color: var(--muted);
  }

  .cr {
    display: flex;
    gap: 7px;
    align-items: baseline;
    margin-top: 4px;
    font-size: 13px;
    line-height: 1.4;
  }

  .cr :global(svg) {
    color: var(--muted);
    align-self: center;
    flex: none;
  }

  .cr.strong {
    font-weight: 600;
  }

  .cr.sub {
    margin-top: 1px;
    font-size: 12px;
    color: var(--muted);
  }

  .cr.bad,
  .cr.bad :global(svg) {
    color: var(--bad);
  }

  .struck {
    color: var(--muted);
    text-decoration: line-through;
    text-decoration-thickness: 1px;
  }

  .tz {
    color: var(--muted);
    font-weight: 400;
    font-size: 12px;
  }

  /* «было: …» under a place the update changed: quiet, and no space when there is none. */
  .tz.moved {
    white-space: nowrap;
  }

  .note {
    margin: 6px 0 0;
    font-size: 12px;
    color: var(--muted);
  }

  .cal-d {
    margin-top: 8px;
    padding-top: 7px;
    border-top: 1px solid color-mix(in srgb, var(--accent) 18%, var(--line));
    font-size: 12.5px;
    line-height: 1.5;
  }

  .cal-d p {
    margin: 0;
    white-space: pre-wrap;
  }

  /* The first lines and «Ещё» (2.1 А): the rest is a click away, not a scroll. */
  .cal-d p.fade {
    overflow: hidden;
    display: -webkit-box;
    line-clamp: 3;
    -webkit-line-clamp: 3;
    -webkit-box-orient: vertical;
  }

  .cal-d .more,
  .cr .link {
    border: none;
    background: none;
    padding: 0;
    font: inherit;
    font-size: 12px;
    color: var(--link);
    text-align: left;
  }

  .cal-d .more {
    margin-top: 4px;
  }

  .cr .link {
    margin-left: 5px;
    overflow-wrap: anywhere;
  }

  .cr .btn.small {
    height: 24px;
    font-size: 12px;
    padding: 0 9px;
  }

  .cal-d .more:hover,
  .cal-d .more:focus-visible,
  .cr .link:hover,
  .cr .link:focus-visible {
    text-decoration: underline;
  }

  .people {
    margin: 4px 0 0;
    padding: 0 0 0 21px;
    font-size: 12.5px;
    line-height: 1.5;
  }

  .cal-a {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    align-items: center;
    margin-top: 9px;
  }

  .anchor {
    position: relative;
    display: inline-flex;
  }

  .pill {
    display: inline-flex;
    align-items: center;
    height: 18px;
    padding: 0 7px;
    border-radius: 9px;
    font-size: 10.5px;
    font-weight: 700;
    letter-spacing: 0.03em;
    text-transform: uppercase;
  }

  .pill.bad {
    background: color-mix(in srgb, var(--bad) 16%, var(--paper));
    color: var(--bad);
  }

  .pill.warn {
    background: color-mix(in srgb, var(--warn) 18%, var(--paper));
    color: var(--warn);
  }

  .pill.ok {
    background: color-mix(in srgb, var(--ok) 15%, var(--paper));
    color: var(--ok);
  }

  /* A narrow pane: the one button that adds the meeting takes the row and the icons stay beside
     it; the title and the time wrap rather than lose their words. */
  @container (max-width: 560px) {
    .cal {
      margin: 10px 12px 0;
    }

    .cal-a .btn.primary {
      flex: 1;
      justify-content: center;
    }

    /* The file becomes an icon: the one button that adds the meeting takes the row, and «⋯»
       stays beside it (экран 8). */
    .cal-a .btn.save {
      width: 30px;
      padding: 0;
      justify-content: center;
    }

    .cal-a .btn.save .lbl {
      display: none;
    }

    .cal-t {
      line-clamp: 3;
      -webkit-line-clamp: 3;
    }
  }
</style>

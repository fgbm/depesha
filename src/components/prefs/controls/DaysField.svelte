<script lang="ts">
  // The weekdays that count as working (#102): seven buttons, Monday first. The cursor is the
  // day that ← / → stopped on and Space or Enter switches; the digits 1–7 switch a day at once.
  import { i18n } from "../../../lib/i18n.svelte";

  let {
    days,
    cursor,
    label,
    disabled = false,
    ontoggle,
  }: { days: number[]; cursor: number | null; label: string; disabled?: boolean; ontoggle: (day: number) => void } = $props();

  const WEEK = [1, 2, 3, 4, 5, 6, 7];

  /** «Пн», «Mon»: ISO day 1 is a Monday; 1 January 2024 was one. */
  function weekday(iso: number): string {
    const name = new Intl.DateTimeFormat(i18n.lang, { weekday: "short" }).format(new Date(2024, 0, iso));
    return name.charAt(0).toUpperCase() + name.slice(1);
  }
</script>

<div class="days" role="group" aria-label={label}>
  {#each WEEK as day (day)}
    <button
      type="button"
      class="day"
      class:cur={cursor === day}
      role="checkbox"
      aria-checked={days.includes(day)}
      tabindex="-1"
      {disabled}
      onclick={() => ontoggle(day)}>{weekday(day)}</button
    >
  {/each}
</div>

<style>
  .days {
    display: flex;
    gap: 4px;
  }

  .day {
    width: 34px;
    height: 28px;
    padding: 0;
    border: 1px solid var(--line);
    border-radius: 6px;
    background: var(--paper);
    color: var(--muted);
    font: inherit;
    font-size: 12.5px;
    cursor: pointer;
  }

  .day[aria-checked="true"] {
    background: var(--selected);
    color: var(--ink);
    border-color: color-mix(in srgb, var(--link) 50%, var(--line));
    font-weight: 600;
  }

  .day.cur {
    box-shadow: 0 0 0 2px var(--link);
  }

  .day:disabled {
    cursor: default;
  }
</style>

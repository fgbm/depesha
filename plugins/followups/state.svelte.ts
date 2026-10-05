/** `repick`: the letter "Set a new date" was asked for, and how to show the new date on it. */
export const followups = $state<{ count: number; repick: { id: number; set: (due: number) => void } | null }>({ count: 0, repick: null });

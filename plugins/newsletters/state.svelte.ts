import type { Plan } from "./confirm";

/** The message whose unsubscribe is being confirmed, how it would go, and why one click did not. */
export const unsub = $state<{ confirm: number | null; plan: Plan | null; reason: string | null }>({ confirm: null, plan: null, reason: null });

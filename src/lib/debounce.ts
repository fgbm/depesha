// Waiting for a burst of events to end, but not forever: under a steady stream
// (a first sync filling many folders) the work still runs every `maxWait`.

export interface Debounced {
  (): void;
  cancel(): void;
}

/** Runs `fn` once calls stop for `wait` ms, and at the latest `maxWait` ms after the first of them. */
export function debounce(fn: () => void, wait: number, maxWait: number): Debounced {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let first: number | null = null;
  const run = () => {
    timer = null;
    first = null;
    fn();
  };
  const call = (() => {
    const now = Date.now();
    first ??= now;
    if (timer) clearTimeout(timer);
    timer = setTimeout(run, Math.max(0, Math.min(wait, first + maxWait - now)));
  }) as Debounced;
  call.cancel = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    first = null;
  };
  return call;
}

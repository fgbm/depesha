// The step runner of e2e/run.mjs, apart from the driver so that its retry rule can be tested.

/** Failed steps in a row: past this many the rest only waits out its timeouts, so the run stops. */
export const CASCADE = 3;

export class Abort extends Error {}

/**
 * DEPESHA_E2E_FAIL_FIRST=6.4,7.21: the first try of these steps fails after the input (a test of
 * the retry). `unused()` names what the run never reached: a typo, or a step of another part.
 */
export function createFailFirst(spec) {
  const asked = (spec ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const left = new Set(asked);
  return {
    inject(id) {
      if (left.delete(id)) throw new Error(`DEPESHA_E2E_FAIL_FIRST: ${id}`);
    },
    unused: () => asked.filter((id) => left.has(id)),
  };
}

/**
 * Closes what a failed step left open (menus, the viewer, dialogs): the Escape starts at the settings
 * window, the focused element or the body (these listen on themselves, not on the window). It goes to the
 * window too only if it did not get there by itself, for a handler that stopped it on the way: a second
 * one would close a second layer. The listener on the window is the bubbling one, the phase in which the
 * app's own handlers on the window run, so "got there" means what the app would have seen.
 */
export const ESCAPE_SCRIPT = `const t = document.querySelector('.modal.prefs') ?? document.activeElement ?? document.body;
  const escape = () => new KeyboardEvent('keydown', { key: 'Escape', bubbles: true });
  let reached = false;
  const seen = () => { reached = true; };
  window.addEventListener('keydown', seen);
  t.dispatchEvent(escape());
  window.removeEventListener('keydown', seen);
  if (!reached) window.dispatchEvent(escape());`;

/**
 * `hooks`: `screenshot(name)`, `tidyUp()` and `log(line)`. `results` gets one record per step,
 * `retried` the names of the steps that passed on the second try.
 *
 * A step is restarted once only when it says `retry: true` — that is for steps that read and
 * navigate. A step that sends, moves, deletes or saves a draft, or that checks time, does not
 * get a second try: the repeat would run the action again or hide a slow answer.
 */
export function createStepRunner({ screenshot, tidyUp, log, results, retried }) {
  let failedInRow = 0;
  const slug = (name) => name.replace(/[^\p{L}\d]+/gu, "_");

  /** `critical`: the steps after it cannot pass without it (the account is not set up). */
  return async function step(criteria, name, fn, { critical = false, retry = false } = {}) {
    const started = Date.now();
    const record = {};
    try {
      try {
        await fn();
      } catch (first) {
        if (!retry) throw first;
        log(`  ↻ [${criteria}] ${name}: перезапуск после «${first.message}»`);
        await screenshot(`RETRY-${slug(name)}`).catch(() => {});
        await tidyUp();
        record.retried = true;
        record.firstError = first.message;
        await fn();
        retried.push(name);
      }
      failedInRow = 0;
      results.push({ criteria, name, ok: true, ms: Date.now() - started, ...record });
      log(`  ✓ [${criteria}] ${name} (${Date.now() - started} мс)`);
    } catch (e) {
      results.push({ criteria, name, ok: false, error: e.message, ms: Date.now() - started, ...record });
      log(`  ✗ [${criteria}] ${name}: ${e.message}`);
      await screenshot(`FAIL-${slug(name)}`).catch(() => {});
      if (critical) throw new Abort(`без шага «${name}» дальше идти нельзя`);
      if (++failedInRow >= CASCADE) throw new Abort(`${CASCADE} шага подряд не прошли, остальные упадут по таймаутам`);
      await tidyUp();
    }
  };
}

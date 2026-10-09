// The step runner of e2e/run.mjs, apart from the driver so that its retry rule can be tested.

/** Failed steps in a row: past this many the rest only waits out its timeouts, so the run stops. */
export const CASCADE = 3;

export class Abort extends Error {}

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

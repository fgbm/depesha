// Sections of the e2e run and their split into parts that run on separate machines.
//
// run.mjs marks the start of each section with `section(name)`; the steps after the mark belong to it.
// Steps before the first mark are the `setup` (the mailbox is added, the first sync is through): every
// part runs it. `DEPESHA_E2E_SHARD` picks what else a part runs:
//
//   2/3                    the 2nd of 3 parts: sections in a row, the parts of about the same length
//   list,send              the named sections (and the setup)
//
// Without the variable the whole run goes in a row, as before.

/** In the order of run.mjs. `weight`: seconds a section takes on a CI machine, for splitting by time. */
export const SECTIONS = [
  { name: "list", weight: 75 },
  { name: "send", weight: 154 },
  { name: "triage", weight: 101 },
  { name: "sendlater", weight: 21 },
  { name: "reminders", weight: 139 },
  { name: "settings", weight: 40 },
  { name: "second", weight: 125 },
];

export const SETUP = "setup";

/** `parts` runs of sections in a row with the smallest longest part. */
export function split(sections, parts) {
  const n = sections.length;
  const sum = (a, b) => sections.slice(a, b).reduce((s, x) => s + x.weight, 0);
  // best[k][i]: the smallest longest part when the first i sections go into k parts.
  const best = Array.from({ length: parts + 1 }, () => Array(n + 1).fill(Infinity));
  const cut = Array.from({ length: parts + 1 }, () => Array(n + 1).fill(0));
  best[0][0] = 0;
  for (let k = 1; k <= parts; k++) {
    for (let i = 0; i <= n; i++) {
      for (let j = 0; j <= i; j++) {
        const longest = Math.max(best[k - 1][j], sum(j, i));
        if (longest < best[k][i]) {
          best[k][i] = longest;
          cut[k][i] = j;
        }
      }
    }
  }
  const out = [];
  for (let k = parts, i = n; k >= 1; k--) {
    const j = cut[k][i];
    out.unshift(sections.slice(j, i).map((s) => s.name));
    i = j;
  }
  return out;
}

/** The names of the sections the spec asks for, or `null` for the whole run. */
export function selectSections(spec, sections = SECTIONS) {
  if (!spec) return null;
  const names = new Set(sections.map((s) => s.name));
  const part = /^(\d+)\/(\d+)$/.exec(spec);
  if (part) {
    const [k, n] = [Number(part[1]), Number(part[2])];
    if (k < 1 || k > n || n > sections.length) throw new Error(`DEPESHA_E2E_SHARD=${spec}: part ${k} of ${n} (sections: ${sections.length})`);
    return new Set(split(sections, n)[k - 1]);
  }
  const picked = spec.split(",").map((s) => s.trim()).filter(Boolean);
  const unknown = picked.filter((s) => !names.has(s));
  if (unknown.length) throw new Error(`DEPESHA_E2E_SHARD=${spec}: no such section: ${unknown.join(", ")} (there are ${[...names].join(", ")})`);
  return new Set(picked);
}

/**
 * `selected`: from `selectSections`. `section(name)` switches the current section; `gate(step)` wraps
 * the step runner so that a step outside the selected sections is not run and leaves no record.
 */
export function createSectionGate(selected, sections = SECTIONS, log = console.log) {
  let current = SETUP;
  const names = new Set(sections.map((s) => s.name));
  const active = () => selected === null || current === SETUP || selected.has(current);
  return {
    section(name) {
      if (!names.has(name)) throw new Error(`no such section: ${name}`);
      current = name;
      if (selected !== null) log(`\n== раздел «${name}»${active() ? "" : " (пропущен: его прогоняет другая часть)"}`);
    },
    gate(step) {
      const ids = new Set();
      return (...args) => {
        // The id names the step in the results, in FAIL_FIRST and in the acceptance list; a part that
        // does not run the step still takes the id, so the same id twice is found by every part.
        if (ids.has(args[0])) return Promise.reject(new Error(`step id used twice: ${args[0]}`));
        ids.add(args[0]);
        return active() ? step(...args) : Promise.resolve();
      };
    },
    get current() {
      return current;
    },
  };
}

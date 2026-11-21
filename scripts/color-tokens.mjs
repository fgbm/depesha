#!/usr/bin/env node
// Guard of the theme's tokens (#183): a colour in `src/**/*.svelte` and `src/**/*.css` is a token
// (`var(--…)`), `transparent` or `currentColor`. A literal — `#hex`, `rgb()`, `hsl()` and the other
// colour functions, a named colour — does not follow the theme. `src/app.css` and `src/themes/` set
// the tokens, so they are not checked. Named colours are looked for in CSS values only: in a script
// `red` is a word.
//
//   node scripts/color-tokens.mjs                 check every file against the exceptions
//   node scripts/color-tokens.mjs --guard FILE    the exceptions against an older copy (main's):
//                                                 a new line without a reason fails
//
// An exception is a line `path literal`, or `path literal # reason` for a colour that is not the
// theme's on purpose. A line without a reason is old debt: the list of those may only shrink.
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(fileURLToPath(import.meta.url), "..", "..");
export const EXCEPTIONS_FILE = "docs/color-tokens-exceptions.txt";

/** Files that set the tokens. */
const UNCHECKED = [/^src\/app\.css$/, /^src\/themes\//];

/** The named colours of CSS Color 4; `transparent` and `currentColor` are allowed and not here. */
const NAMED = new Set(
  (
    "aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue blueviolet brown burlywood " +
    "cadetblue chartreuse chocolate coral cornflowerblue cornsilk crimson cyan darkblue darkcyan darkgoldenrod darkgray " +
    "darkgreen darkgrey darkkhaki darkmagenta darkolivegreen darkorange darkorchid darkred darksalmon darkseagreen " +
    "darkslateblue darkslategray darkslategrey darkturquoise darkviolet deeppink deepskyblue dimgray dimgrey dodgerblue " +
    "firebrick floralwhite forestgreen fuchsia gainsboro ghostwhite gold goldenrod gray green greenyellow grey honeydew " +
    "hotpink indianred indigo ivory khaki lavender lavenderblush lawngreen lemonchiffon lightblue lightcoral lightcyan " +
    "lightgoldenrodyellow lightgray lightgreen lightgrey lightpink lightsalmon lightseagreen lightskyblue lightslategray " +
    "lightslategrey lightsteelblue lightyellow lime limegreen linen magenta maroon mediumaquamarine mediumblue " +
    "mediumorchid mediumpurple mediumseagreen mediumslateblue mediumspringgreen mediumturquoise mediumvioletred " +
    "midnightblue mintcream mistyrose moccasin navajowhite navy oldlace olive olivedrab orange orangered orchid " +
    "palegoldenrod palegreen paleturquoise palevioletred papayawhip peachpuff peru pink plum powderblue purple " +
    "rebeccapurple red rosybrown royalblue saddlebrown salmon sandybrown seagreen seashell sienna silver skyblue " +
    "slateblue slategray slategrey snow springgreen steelblue tan teal thistle tomato turquoise violet wheat white " +
    "whitesmoke yellow yellowgreen"
  ).split(" "),
);

/** Properties whose values are names of something else: a font, an animation, a grid area. */
const NOT_COLOUR = /^(font|font-family|animation|animation-name|grid|grid-area|grid-template|grid-template-areas|counter-reset|counter-increment|content|will-change|transition|transition-property|view-transition-name|container-name)$/;

const HEX = /#(?:[0-9a-f]{8}|[0-9a-f]{6}|[0-9a-f]{3,4})(?![0-9a-z_-])/gi;
const FUNCTION = /\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\(/gi;
/** A declaration: after `{`, `;` or the start, up to `;` or `}`. A selector ends at `{` and is not one. */
const DECLARATION = /(^|[{;])(\s*)(-{0,2}[a-z][\w-]*)(\s*:)([^;{}]*)(?=[;}]|$)/gi;
const IDENT = /-*[a-z_][\w-]*/gi;

/** The text with every comment turned into spaces, its line breaks kept: offsets stay true. */
export function blankComments(text, { html = false, script = false } = {}) {
  const blank = (m) => m.replace(/[^\n]/g, " ");
  let out = text.replace(/\/\*[\s\S]*?\*\//g, blank);
  if (html) out = out.replace(/<!--[\s\S]*?-->/g, blank);
  // `//` after `:` is a URL, inside quotes a string.
  if (script) out = out.replace(/(^|[^:"'`\\])(\/\/[^\n]*)/gm, (_, before, comment) => before + blank(comment));
  return out;
}

/** The text with quoted strings and `url(…)` turned into spaces: a font name or a picture is no colour. */
function blankStrings(text) {
  const blank = (m) => m.replace(/[^\n]/g, " ");
  return text.replace(/"[^"\n]*"|'[^'\n]*'/g, blank).replace(/url\([^)]*\)/gi, blank);
}

/** The colour function that opens at `start`, closing parentheses counted. */
function functionAt(text, start) {
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    if (text[i] === "(") depth++;
    else if (text[i] === ")" && --depth === 0) return text.slice(start, i + 1);
  }
  return text.slice(start);
}

/** The literal as the exceptions name it: lower case, one space between words. */
export function normal(literal) {
  return literal.toLowerCase().replace(/\s+/g, " ").replace(/\(\s/g, "(").replace(/\s\)/g, ")");
}

/** Hex colours and colour functions in `text`, as `{ at, literal }`. */
function hexAndFunctions(text) {
  const found = [];
  for (const m of text.matchAll(HEX)) found.push({ at: m.index, literal: m[0] });
  for (const m of text.matchAll(FUNCTION)) found.push({ at: m.index, literal: functionAt(text, m.index) });
  return found;
}

/** Every colour literal in the CSS `css`, which starts at `offset` of its file. */
function cssLiterals(css, offset) {
  const text = blankStrings(css);
  const found = [];
  for (const m of text.matchAll(DECLARATION)) {
    const [, lead, space, property, colon, value] = m;
    const start = m.index + lead.length + space.length + property.length + colon.length;
    for (const hit of hexAndFunctions(value)) found.push({ at: offset + start + hit.at, literal: hit.literal });
    if (NOT_COLOUR.test(property.toLowerCase())) continue;
    for (const word of value.matchAll(IDENT)) {
      if (NAMED.has(word[0].toLowerCase())) found.push({ at: offset + start + word.index, literal: word[0] });
    }
  }
  return found;
}

/** Every colour literal of a file, as `{ line, literal }`, the literal in its normal form. */
export function literalsOf(path, source) {
  const found = [];
  if (path.endsWith(".css")) {
    found.push(...cssLiterals(blankComments(source), 0));
  } else {
    const text = blankComments(source, { html: true, script: true });
    const styles = [...text.matchAll(/(<style[^>]*>)([\s\S]*?)<\/style>/gi)];
    for (const s of styles) found.push(...cssLiterals(s[2], s.index + s[1].length));
    let rest = text;
    for (const s of styles) rest = rest.slice(0, s.index) + s[0].replace(/[^\n]/g, " ") + rest.slice(s.index + s[0].length);
    found.push(...hexAndFunctions(rest));
    // A style attribute is CSS too, so a named colour counts there.
    for (const a of rest.matchAll(/\sstyle=(["'])([^"']*)\1/gi)) {
      const at = a.index + a[0].indexOf(a[2]);
      found.push(...cssLiterals(a[2], at).filter((hit) => NAMED.has(hit.literal.toLowerCase())));
    }
  }
  const lines = (at) => source.slice(0, at).split("\n").length;
  const seen = new Set();
  return found
    .map((hit) => ({ line: lines(hit.at), literal: normal(hit.literal) }))
    .filter((hit) => {
      const key = `${hit.line} ${hit.literal}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => a.line - b.line);
}

/** The exceptions of a file's text: `{ path, literal, reason }`; `#` at the start of a line is a comment. */
export function parseExceptions(text) {
  const list = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const [entry, ...why] = line.split(/\s+#\s+/);
    const space = entry.search(/\s/);
    if (space < 0) throw new Error(`exception without a literal: ${line}`);
    list.push({ path: entry.slice(0, space), literal: normal(entry.slice(space + 1).trim()), reason: why.join(" # ").trim() });
  }
  return list;
}

const keyOf = (e) => `${e.path} ${e.literal}`;

/** What the check reports: literals without an exception fail, exceptions without a literal only warn. */
export function problemsOf(found, exceptions) {
  const allowed = new Set(exceptions.map(keyOf));
  const used = new Set();
  const errors = [];
  for (const [path, hits] of found) {
    for (const hit of hits) {
      const key = `${path} ${hit.literal}`;
      if (allowed.has(key)) used.add(key);
      else errors.push(`${path}:${hit.line}: colour literal ${hit.literal}: use a token of the theme (var(--…))`);
    }
  }
  const stale = exceptions.filter((e) => !used.has(keyOf(e))).map((e) => `exception not needed: ${keyOf(e)}`);
  return { errors, stale };
}

/** Lines of `head` that `base` does not have and that give no reason: old debt may only shrink. */
export function guardProblems(base, head) {
  const before = new Set(base.map(keyOf));
  return head.filter((e) => !before.has(keyOf(e)) && !e.reason).map((e) => `new exception without a reason: ${keyOf(e)} (add "# why" or use a token)`);
}

function* sources(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* sources(path);
    else if (/\.(svelte|css)$/.test(entry.name)) yield relative(ROOT, path).split("\\").join("/");
  }
}

/** Every checked file of `src/` and its literals. */
export function scan() {
  const found = new Map();
  for (const path of sources(join(ROOT, "src"))) {
    if (UNCHECKED.some((re) => re.test(path))) continue;
    const hits = literalsOf(path, readFileSync(join(ROOT, path), "utf8"));
    if (hits.length) found.set(path, hits);
  }
  return found;
}

function main(args) {
  const exceptions = parseExceptions(readFileSync(join(ROOT, EXCEPTIONS_FILE), "utf8"));
  if (args[0] === "--guard") {
    if (!args[1]) throw new Error("--guard FILE");
    const errors = guardProblems(parseExceptions(readFileSync(args[1], "utf8")), exceptions);
    for (const e of errors) console.error(e);
    console.log(`colour tokens: ${errors.length ? "the exceptions grew" : "the exceptions did not grow"}`);
    return errors.length ? 1 : 0;
  }
  const { errors, stale } = problemsOf(scan(), exceptions);
  for (const e of errors) console.error(e);
  for (const s of stale) console.log(`warning: ${s}`);
  console.log(`colour tokens: ${errors.length} literal(s) without an exception, ${exceptions.length} exception(s)`);
  return errors.length ? 1 : 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === join(process.argv[1])) process.exitCode = main(process.argv.slice(2));

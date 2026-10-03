// Логотип Депеши — «печать-собака»: сургучная печать, на ней открытое кольцо «@» и «Д» внутри.
// node design/logo/build.mjs → design/logo/depesha*.svg и design/logo/preview.html
// Иконки приложения из этих исходников собирает design/logo/icons.sh.
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

const C = {
  red: "#b3261e", // --accent
  letter: "#fff8f0", // --accent-ink
};

const f = (n) => +n.toFixed(1);
const rad = (deg) => (deg * Math.PI) / 180;
const at = (cx, cy, r, deg) => [cx + Math.cos(rad(deg)) * r, cy + Math.sin(rad(deg)) * r];

// Край печати: девять одинаковых мягких лепестков, верхний — по оси, поэтому знак симметричен.
// depth — глубина волны в долях радиуса.
function sealPath(cx, cy, r, depth) {
  const n = 216;
  const pts = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    const k = 1 + depth * Math.cos(9 * (a + Math.PI / 2));
    pts.push([cx + Math.cos(a) * r * k, cy + Math.sin(a) * r * k]);
  }
  const mid = (p, q) => [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2];
  let d = `M${mid(pts[n - 1], pts[0]).map(f).join(" ")}`;
  for (let i = 0; i < n; i++) {
    const p = pts[i];
    const m = mid(p, pts[(i + 1) % n]);
    d += `Q${f(p[0])} ${f(p[1])} ${f(m[0])} ${f(m[1])}`;
  }
  return d + "Z";
}

// Кольцо «@»: начинается справа внизу, обходит букву по часовой и справа плавно уходит внутрь спиралью, как хвост «@».
// Углы — по часовой от оси X (SVG, ось Y вниз).
function ringPath(cx, cy, R) {
  const start = 50; // нижний конец
  const turn = 325; // где кольцо начинает сворачиваться
  const end = 382; // верхний конец, уже внутри кольца
  const inward = 0.21; // насколько конец ближе к центру, в долях R
  const p0 = at(cx, cy, R, start);
  const p1 = at(cx, cy, R, turn);
  let d = `M${f(p0[0])} ${f(p0[1])}A${f(R)} ${f(R)} 0 1 1 ${f(p1[0])} ${f(p1[1])}`;
  // спираль: радиус убывает по t², поэтому в точке схода она касается окружности, а к концу закручивается всё круче
  const n = 40;
  for (let i = 1; i <= n; i++) {
    const t = i / n;
    const p = at(cx, cy, R * (1 - inward * t * t), turn + (end - turn) * t);
    d += `L${f(p[0])} ${f(p[1])}`;
  }
  return d;
}

// «Д» антиквенная, как в Times и Old Standard: правая мачта отвесная и толстая,
// левая нога — сабля, тонкая вверху и раскрывающаяся влево к основанию.
// Перекладина свисает засечкой только влево; правый верхний угол — большой дугой, по ходу кольца.
// Координаты в долях высоты h от верха буквы; cx — ось, top — верх.
function letterD(cx, top, h) {
  const X = (x) => f(cx + x * h);
  const Y = (y) => f(top + y * h);
  const pt = ([x, y]) => `${X(x)} ${Y(y)}`;
  const fill = (d) => `<path d="${d}" fill="${C.letter}"/>`;
  const baseTop = 0.72;
  const W = 0.5; // полуширина основания
  // основание: ножки сходят на нет, снизу между ними — одна вогнутая арка
  const tip = 0.035; // ширина кончика ножки
  const arch = 0.86; // верх арки
  const base =
    `M${pt([-W, baseTop])}H${X(W)}V${Y(1)}H${X(W - tip)}` +
    `C${pt([W - tip - 0.02, 0.9])} ${pt([0.38, arch])} ${pt([0.26, arch])}H${X(-0.26)}` +
    `C${pt([-0.38, arch])} ${pt([-(W - tip - 0.02), 0.9])} ${pt([-(W - tip), 1])}H${X(-W)}Z`;
  const bar = 0.11;
  const sR = 0.37; // внешний край мачты
  const sL = 0.165; // внутренний
  const rr = 0.17; // скругление правого верхнего угла
  const k = 0.55; // кубика, близкая к четверти окружности
  const stem = `M${pt([-0.27, 0])}H${X(sR - rr)}C${pt([sR - rr * (1 - k), 0])} ${pt([sR, rr * (1 - k)])} ${pt([sR, rr])}V${Y(baseTop + 0.02)}H${X(sL)}V${Y(bar)}H${X(-0.27)}Z`;
  const leg =
    `M${pt([-0.175, bar - 0.02])}H${X(-0.06)}` +
    `C${pt([-0.06, 0.4])} ${pt([-0.12, 0.62])} ${pt([-0.27, baseTop + 0.02])}H${X(-0.45)}` +
    `C${pt([-0.27, 0.58])} ${pt([-0.175, 0.4])} ${pt([-0.175, bar - 0.02])}Z`;
  return fill(stem) + fill(leg) + fill(base);
}

// r — радиус печати на холсте 1024; ring — радиус кольца и толщина его линии в долях r;
// letter — высота «Д» в долях r (0 — без буквы); depth — глубина волны края.
function icon({ r, depth = 0.05, ring = [0.66, 0.105], letter = 0.77, letterDy = 0 }) {
  const cx = 512;
  const cy = 512;
  let s = `<path d="${sealPath(cx, cy, r, depth)}" fill="${C.red}"/>`;
  if (ring) {
    const [R, w] = ring;
    s += `<path d="${ringPath(cx, cy, r * R)}" fill="none" stroke="${C.letter}" stroke-width="${f(r * w)}" stroke-linecap="round"/>`;
  }
  if (letter) {
    const h = r * letter;
    s += letterD(cx, cy - h / 2 + r * letterDy, h);
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024">${s}</svg>\n`;
}

const masters = {
  // 48 px и больше: печать почти во весь квадрат
  depesha: icon({ r: 470 }),
  // macOS: тело круглой иконки по сетке Apple — около 824 из 1024
  "depesha-macos": icon({ r: 392 }),
  // 24–32 px: кольцо и буква толще, волна мельче
  "depesha-small": icon({ r: 480, depth: 0.04, ring: [0.7, 0.13], letter: 0.78 }),
  // 16 px: кольцо уже шум — остаётся печать с крупной «Д»
  "depesha-16": icon({ r: 490, depth: 0.035, ring: null, letter: 1.02 }),
};
for (const [name, src] of Object.entries(masters)) writeFileSync(join(here, `${name}.svg`), src);

const v = Date.now();
const srcFor = (s) => (s <= 16 ? "depesha-16" : s <= 32 ? "depesha-small" : "depesha");
const sizes = [256, 128, 64, 48, 32, 24, 16];
const backgrounds = [
  ["Светлый", "#f4f4f2"],
  ["Тёмный", "#1c1c1e"],
  ["Боковая панель", "#1f2a37"],
  ["Обои", "linear-gradient(135deg,#3a7bd5 0%,#8e44ad 50%,#e67e22 100%)"],
];
const img = (s, cls = "") => `<img${cls ? ` class="${cls}"` : ""} src="${srcFor(s)}.svg?${v}" width="${s}" height="${s}" alt="">`;

const html = `<!doctype html>
<html lang="ru"><head><meta charset="utf-8"><title>Депеша — печать</title>
<style>
  body{margin:0;padding:32px;background:#ece8df;font:15px/1.45 system-ui,sans-serif;color:#1d232b}
  h1{margin:0 0 4px;font-size:26px} .lead{margin:0 0 24px;color:#6b7480}
  .card{background:#fff;border-radius:14px;padding:24px;display:inline-block}
  .hero{display:flex;gap:28px;align-items:flex-end;margin-bottom:18px}
  figure{margin:0;text-align:center} figcaption{font-size:12px;color:#6b7480;margin-top:6px}
  .gray{filter:grayscale(1)} .blur{filter:blur(3px)}
  .row{display:flex;align-items:center;gap:12px;margin-top:8px} .row>span{width:130px;font-size:13px;color:#6b7480;flex:none}
  .strip{display:flex;align-items:center;gap:22px;padding:14px 20px;border-radius:10px}
  .brand{display:flex;align-items:center;gap:10px;padding:14px 16px;background:#1f2a37;color:#d5dde6;font-weight:600;border-radius:10px;width:200px}
</style></head><body>
<h1>Депеша — печать-собака</h1>
<p class="lead">48 px и больше — depesha.svg (в .icns — depesha-macos.svg), 24–32 px — depesha-small.svg, 16 px — depesha-16.svg.</p>
<section class="card">
  <div class="hero">
    <figure>${img(320)}<figcaption>Мастер</figcaption></figure>
    <figure>${img(96, "gray")}<figcaption>Без цвета</figcaption></figure>
    <figure>${img(96, "blur")}<figcaption>Издалека</figcaption></figure>
    <figure><div class="brand"><img src="depesha-small.svg?${v}" width="26" height="26" alt=""><span>Депеша</span></div><figcaption>Боковая панель, 26 px</figcaption></figure>
  </div>
  ${backgrounds.map(([label, bg]) => `<div class="row"><span>${label}</span><div class="strip" style="background:${bg}">${sizes.map((s) => img(s)).join("")}</div></div>`).join("")}
</section>
</body></html>
`;
writeFileSync(join(here, "preview.html"), html);
console.log(`ok: ${Object.keys(masters).join(", ")}`);

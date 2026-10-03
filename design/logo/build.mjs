// Логотип Депеши — «плитка-конверт»: сама плитка — оборот конверта, тёмный клапан, сургучная печать с «Д».
// node design/logo/build.mjs → design/logo/depesha*.svg и design/logo/preview.html
// Иконки приложения из этих исходников собирает design/logo/icons.sh.

import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

const C = {
  navy: "#1f2a37", // --side
  cream: "#f6eedd",
  fold: "#dfd0b0",
  red: "#b3261e", // --accent
  redDark: "#8a1a14",
  letter: "#fff8f0", // --accent-ink
};

const f = (n) => +n.toFixed(1);

// Капля сургуча: неровный круг, сглаженный квадратичными кривыми через середины.
function sealPath(cx, cy, r) {
  const n = 60;
  const pts = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    // несколько несоразмерных гармоник, чтобы край был живым, а не зубчатым
    const k = 1 + 0.03 * Math.sin(3 * a) + 0.018 * Math.sin(5 * a + 2.1) + 0.014 * Math.sin(9 * a + 0.7) + 0.008 * Math.sin(14 * a + 1.3);
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

// Буква «Д» из прямоугольников: основание с выносными элементами, правая ножка, косая левая.
function letterD(cx, cy, h) {
  const W = h * 0.42;
  const t = h * 0.19;
  const i = t * 0.55;
  const top = cy - h * 0.46;
  const base = cy + h * 0.3;
  const desc = cy + h * 0.52;
  const lt = cx - W + i + t * 0.95;
  const rect = (x0, y0, x1, y1) => `M${f(x0)} ${f(y0)}H${f(x1)}V${f(y1)}H${f(x0)}Z`;
  const d = [
    rect(cx - W, base - t, cx + W, base),
    rect(cx - W, base - 1, cx - W + t * 0.9, desc),
    rect(cx + W - t * 0.9, base - 1, cx + W, desc),
    rect(cx + W - i - t, top, cx + W - i, base - t + 1),
    rect(lt, top, cx + W - i - 1, top + t),
    `M${f(lt)} ${f(top)}H${f(lt + t)}L${f(cx - W + i + t)} ${f(base - t + 1)}H${f(cx - W + i)}Z`,
  ].join("");
  return `<path d="${d}" fill="${C.letter}"/>`;
}

// margin — поле вокруг плитки на холсте 1024; edge и tip — где клапан касается боков и где его вершина (доли плитки);
// r — радиус печати в долях плитки. Флаги убирают детали, которые в мелких размерах превращаются в шум.
function icon({ margin, edge, tip, r, folds = true, shadow = true, sealRim = true, letter = true }) {
  const S = 1024 - 2 * margin;
  const R = f(S * 0.2245); // скругление как у плитки macOS (185 из 824)
  const x0 = margin;
  const x1 = 1024 - margin;
  const ey = margin + S * edge;
  const ty = margin + S * tip;
  const sr = S * r;
  const cy = ty + sr * 0.08;
  const dx = S * 0.06;

  let s = `<defs><clipPath id="t"><rect x="${x0}" y="${x0}" width="${S}" height="${S}" rx="${R}"/></clipPath></defs>`;
  s += `<g clip-path="url(#t)">`;
  s += `<rect x="${x0}" y="${x0}" width="${S}" height="${S}" fill="${C.cream}"/>`;
  if (folds) {
    const w = f(S * 0.022);
    s += `<path d="M${f(x0 + S * 0.08)} ${f(x1 - S * 0.06)}L${f(512 - sr * 0.55)} ${f(cy + sr * 0.75)}M${f(x1 - S * 0.08)} ${f(x1 - S * 0.06)}L${f(512 + sr * 0.55)} ${f(cy + sr * 0.75)}" stroke="${C.fold}" stroke-width="${w}" stroke-linecap="round"/>`;
  }
  // клапан: прямые стороны и скруглённая вершина
  s += `<path d="M${x0 - 10} ${x0 - 10}H${x1 + 10}V${f(ey)}L${f(512 + dx)} ${f(ty - dx * 0.62)}Q512 ${f(ty + dx * 0.3)} ${f(512 - dx)} ${f(ty - dx * 0.62)}L${x0 - 10} ${f(ey)}Z" fill="${C.navy}"/>`;
  s += `</g>`;
  if (shadow) s += `<path d="${sealPath(512 + sr * 0.04, cy + sr * 0.07, sr)}" fill="#000" fill-opacity=".2"/>`;
  s += `<path d="${sealPath(512, cy, sr)}" fill="${C.red}"/>`;
  if (sealRim) s += `<circle cx="512" cy="${f(cy)}" r="${f(sr * 0.76)}" fill="none" stroke="${C.redDark}" stroke-width="${f(sr * 0.06)}"/>`;
  if (letter) s += letterD(512, cy + sr * 0.02, sr * 0.92);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024">${s}</svg>\n`;
}

const masters = {
  // 48 px и больше: плитка во весь квадрат, все детали
  depesha: icon({ margin: 16, edge: 0.243, tip: 0.558, r: 0.182 }),
  // то же для macOS: Dock ждёт поле по сетке Apple (тело 824 из 1024), иначе иконка крупнее соседних
  "depesha-macos": icon({ margin: 100, edge: 0.243, tip: 0.558, r: 0.182 }),
  // 24–32 px и логотип в боковой панели: плитка почти во весь квадрат, печать крупнее, без сгибов и теней
  "depesha-small": icon({ margin: 24, edge: 0.26, tip: 0.5, r: 0.25, folds: false, shadow: false, sealRim: false }),
  // 16 px: буква в 5 пикселей — уже шум, остаётся силуэт клапана и красная печать
  "depesha-16": icon({ margin: 16, edge: 0.28, tip: 0.5, r: 0.27, folds: false, shadow: false, sealRim: false, letter: false }),
};
for (const [name, src] of Object.entries(masters)) writeFileSync(join(here, `${name}.svg`), src);

// Страница проверки: каждый размер — своим исходником, как он попадёт в иконки.
const v = Date.now();
const srcFor = (s) => (s <= 16 ? "depesha-16" : s <= 32 ? "depesha-small" : "depesha");
const sizes = [256, 128, 64, 48, 32, 24, 16];
const backgrounds = [
  ["Светлый", "#f4f4f2"],
  ["Тёмный", "#1c1c1e"],
  ["Боковая панель", C.navy],
  ["Обои", "linear-gradient(135deg,#3a7bd5 0%,#8e44ad 50%,#e67e22 100%)"],
];
const img = (s, cls = "") => `<img${cls ? ` class="${cls}"` : ""} src="${srcFor(s)}.svg?${v}" width="${s}" height="${s}" alt="">`;

const html = `<!doctype html>
<html lang="ru"><head><meta charset="utf-8"><title>Депеша — логотип</title>
<style>
  body{margin:0;padding:32px;background:#ece8df;font:15px/1.45 system-ui,sans-serif;color:#1d232b}
  h1{margin:0 0 4px;font-size:26px} .lead{margin:0 0 24px;color:#6b7480}
  .card{background:#fff;border-radius:14px;padding:24px;display:inline-block}
  .hero{display:flex;gap:28px;align-items:flex-end;margin-bottom:18px}
  figure{margin:0;text-align:center} figcaption{font-size:12px;color:#6b7480;margin-top:6px}
  .gray{filter:grayscale(1)} .blur{filter:blur(3px)}
  .row{display:flex;align-items:center;gap:12px;margin-top:8px} .row>span{width:130px;font-size:13px;color:#6b7480;flex:none}
  .strip{display:flex;align-items:center;gap:22px;padding:14px 20px;border-radius:10px}
  .brand{display:flex;align-items:center;gap:10px;padding:14px 16px;background:${C.navy};color:#d5dde6;font-weight:600;border-radius:10px;width:200px}
</style></head><body>
<h1>Депеша — плитка-конверт</h1>
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

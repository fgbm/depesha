// Картинки для опроса тестировщиков: снимает из HTML-макетов по poll.md.
//
//   node scripts/poll-shots.mjs 0.7
//
// Ищет в design/mockups/<версия>/poll.md строки вида
//   Картинка: `poll/02-tray-badge.png` (01, кадр 6).
// и для каждой картинки снимает кадр `#sN` из макета `NN-*.html` в светлой
// теме, deviceScaleFactor 2. Прячет редакторские пометки: ul.notes, p.cap,
// span.num, .rec и элементы с текстом «рекомендую», «не советую»,
// «Рекомендация». PNG в репозиторий не попадают (см. .gitignore), их собирают
// на месте перед публикацией опроса.
//
// Playwright не в зависимостях проекта: скрипт берёт уже установленный
// (локально или из кэша npx). Если его нет, поставьте браузер:
//   npx --yes playwright@1.63 install chromium
import { readFileSync, readdirSync, existsSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Playwright не в зависимостях проекта: берём локальный или из кэша npx. */
async function loadChromium() {
  try {
    return (await import('playwright')).chromium;
  } catch {}
  const require = createRequire(import.meta.url);
  try {
    return require('playwright').chromium;
  } catch {}
  const npx = path.join(homedir(), '.npm', '_npx');
  if (existsSync(npx)) {
    for (const dir of readdirSync(npx)) {
      const req = createRequire(path.join(npx, dir, 'noop.js'));
      try {
        return req('playwright').chromium;
      } catch {}
    }
  }
  throw new Error('Playwright не найден: npx --yes playwright@1.63 install chromium');
}

const chromium = await loadChromium();

const version = process.argv[2];
if (!version) {
  console.error('укажите версию: node scripts/poll-shots.mjs 0.7');
  process.exit(2);
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = path.join(root, 'design', 'mockups', version);
const outDir = path.join(dir, 'poll');
mkdirSync(outDir, { recursive: true });
const pollMd = readFileSync(path.join(dir, 'poll.md'), 'utf8');

/** Разбирает poll.md: имя картинки → { file, frame }. */
function plan() {
  const jobs = [];
  for (const line of pollMd.split('\n')) {
    const images = [...line.matchAll(/poll\/([A-Za-z0-9._-]+\.png)/g)].map((m) => m[1]);
    if (!images.length) continue;
    // Каждая ссылка «(NN, кадр M)» или «(NN, кадры M и K)» даёт кадр(ы) по порядку.
    const refs = [];
    for (const m of line.matchAll(/\((\d+),\s*кадр[аы]?\s*([^)]*)\)/g)) {
      for (const n of m[2].matchAll(/\d+/g)) refs.push({ mockup: m[1], frame: n[0] });
    }
    if (refs.length !== images.length) {
      throw new Error(`строку не разобрать (картинок ${images.length}, кадров ${refs.length}): ${line.trim()}`);
    }
    images.forEach((image, i) => jobs.push({ image, ...refs[i] }));
  }
  return jobs;
}

const mockupFiles = readdirSync(dir).filter((f) => /^\d+-.*\.html$/.test(f));

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1600, height: 1200 }, deviceScaleFactor: 2 });
const page = await context.newPage();

const hideAnnotations = () => {
  const style = document.createElement('style');
  style.textContent = 'ul.notes, p.cap, span.num, .rec { display: none !important; }';
  document.head.append(style);
  const phrases = ['рекомендую', 'не советую', 'Рекомендация'];
  for (const el of document.querySelectorAll('body *')) {
    const text = el.textContent || '';
    if (!phrases.some((p) => text.includes(p))) continue;
    // Прячем самый мелкий элемент с пометкой, а не весь контейнер.
    if ([...el.children].some((c) => phrases.some((p) => (c.textContent || '').includes(p)))) continue;
    el.style.display = 'none';
  }
};

let current = null;
const jobs = plan();
for (const { image, mockup, frame } of jobs) {
  if (current !== mockup) {
    const file = mockupFiles.find((f) => f.startsWith(mockup + '-'));
    if (!file) throw new Error(`нет макета ${mockup}-*.html`);
    await page.goto('file://' + path.join(dir, file));
    await page.evaluate(hideAnnotations);
    current = mockup;
  }
  const target = page.locator(`#s${frame}`);
  if (!(await target.count())) throw new Error(`нет кадра s${frame} в ${mockup}`);
  await target.screenshot({ path: path.join(outDir, image) });
  console.log(`${image} ← ${mockup}, кадр ${frame}`);
}

await browser.close();
console.log(`готово: ${jobs.length}`);

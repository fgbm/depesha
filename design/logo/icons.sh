#!/usr/bin/env bash
# Собирает иконки приложения из design/logo/*.svg (их генерирует build.mjs).
# Крупные размеры — из мастера depesha.svg (.icns — из depesha-macos.svg с полем по сетке Apple), мелкие — из упрощённых depesha-small.svg и depesha-16.svg.
# Нужны только node и npx tauri (растеризует SVG через resvg).
set -euo pipefail

root="$(cd "$(dirname "$0")/../.." && pwd)"
logo="$root/design/logo"
icons="$root/src-tauri/icons"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

cd "$root"
node "$logo/build.mjs"

# Полный набор из мастера; Android и iOS проект не собирает.
npx tauri icon "$logo/depesha.svg" -o "$icons" >/dev/null
rm -rf "$icons/android" "$icons/ios"

# .icns — из версии с полем по сетке Apple.
npx tauri icon "$logo/depesha-macos.svg" -o "$tmp/macos" >/dev/null
cp "$tmp/macos/icon.icns" "$icons/icon.icns"

npx tauri icon "$logo/depesha.svg" -o "$tmp/big" -p 48,64,256 >/dev/null
npx tauri icon "$logo/depesha-small.svg" -o "$tmp/small" -p 24,30,32,44,128 >/dev/null
npx tauri icon "$logo/depesha-16.svg" -o "$tmp/tiny" -p 16 >/dev/null

# Мелкие PNG — упрощённой версией.
cp "$tmp/small/32x32.png" "$icons/32x32.png"
cp "$tmp/small/30x30.png" "$icons/Square30x30Logo.png"
cp "$tmp/small/44x44.png" "$icons/Square44x44Logo.png"

# .ico для Windows: 16–32 из упрощённых версий, 48–256 из мастера. Записи храним как PNG
# (ImageMagick пишет несжатый BMP, и 256 px раздувается до 300 КБ).
node - "$icons/icon.ico" "$tmp/tiny/16x16.png" "$tmp/small/24x24.png" "$tmp/small/32x32.png" \
  "$tmp/big/48x48.png" "$tmp/big/64x64.png" "$tmp/big/256x256.png" <<'EOF'
const fs = require("node:fs");
const [out, ...files] = process.argv.slice(2);
const pngs = files.map((f) => fs.readFileSync(f));
const head = Buffer.alloc(6 + 16 * pngs.length);
head.writeUInt16LE(1, 2);
head.writeUInt16LE(pngs.length, 4);
let offset = head.length;
pngs.forEach((png, i) => {
  const size = png.readUInt32BE(16); // ширина из IHDR
  const e = 6 + 16 * i;
  head.writeUInt8(size >= 256 ? 0 : size, e);
  head.writeUInt8(size >= 256 ? 0 : size, e + 1);
  head.writeUInt16LE(1, e + 4);
  head.writeUInt16LE(32, e + 6);
  head.writeUInt32LE(png.length, e + 8);
  head.writeUInt32LE(offset, e + 12);
  offset += png.length;
});
fs.writeFileSync(out, Buffer.concat([head, ...pngs]));
EOF

# Логотип в боковой панели (показывается в 26 px).
cp "$tmp/small/128x128.png" "$root/public/icon.png"

echo "ok: $icons, public/icon.png"

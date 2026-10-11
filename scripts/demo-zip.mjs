// Packs `dist-demo/` into `dist-demo.zip`, next to it: the archive of the live mockup, ready
// to send to the operator. Run by `npm run demo:build`. JSZip is already a dependency (the
// docx viewer), so no external `zip` is needed.

import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import JSZip from "jszip";

const DIR = "dist-demo";
const OUT = "dist-demo.zip";

const zip = new JSZip();

/** Adds every file under `dir` to the archive, keeping the paths relative to it. */
function add(dir, base) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    const rel = base ? `${base}/${name}` : name;
    if (statSync(path).isDirectory()) add(path, rel);
    else zip.file(rel, readFileSync(path));
  }
}

add(DIR, "");
const buf = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
writeFileSync(OUT, buf);
console.log(`demo-zip: ${OUT} (${buf.length} байт)`);

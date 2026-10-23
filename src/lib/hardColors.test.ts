import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// A component takes its colours from the theme's tokens (src/app.css), or the looks of 0.8.12
// miss it. These are the colours that are not the theme's on purpose.
const ALLOWED: Record<string, string[]> = {
  // The letter is the sender's white sheet in every theme, as the recipient sees it.
  "MailFrame.svelte": ["#fff", "#1d232b", "#55606c", "#1f5fa8", "#d5dbe3", "#d9dde3", "#f0f1f3", "#b9d7f5"],
  "RichEditor.svelte": ["#fff", "#1d232b", "#55606c", "#1f5fa8", "#d5dbe3", "#b9d7f5", "#6b7480"],
  // Initials and a picture's ground on the sender's own colour.
  "Avatar.svelte": ["#fff"],
  "reader/ThreadLetter.svelte": ["#fff"],
  "reader/ReaderHeader.svelte": ["#fff"],
  "reader/PersonCard.svelte": ["#fff"],
  "people/PeopleView.svelte": ["#fff"],
  "sidebar/sidebar.css": ["#fff"],
  // The colours a user gives a mailbox or a label.
  "account/ColorField.svelte": ["#fff", "#000", "#c0504d", "#d0658f", "#c77d1a", "#9b59b6", "#4a9a6a", "#3f7cc4", "#2a9d9b"],
  "account/LabelsSection.svelte": ["#6b7480"],
  "LabelPicker.svelte": ["#3f7fd0"],
  "Tasks.svelte": ["#4a9a6a"],
  // Windows' own red of «Close».
  "WindowControls.svelte": ["#c42b1c", "#fff"],
  // A page of a document and the dark of a film, whatever the theme.
  "viewer/PdfView.svelte": ["#fff"],
  "viewer/MediaView.svelte": ["#000"],
  "prefs/controls/Switch.svelte": ["#fff"],
  "prefs/KeysPanel.svelte": ["#f2c94c"],
  "Accounts.svelte": ["#000"],
};

/** The palette of before 0.8.12: its cream and its red have no place outside the «Paper» look. */
const OLD = ["#b3261e", "#faf7f1", "#f3eee4", "#e4ddcf", "#f0e9dc", "#e6dbc6", "#fff8f0", "#d8cfbd", "#c4302b", "#d6463d", "#e0a030", "#e0b040"];

const dir = fileURLToPath(new URL("../components", import.meta.url));
const files = (readdirSync(dir, { recursive: true }) as string[]).filter((f) => /\.(svelte|css|ts)$/.test(f) && !f.endsWith(".test.ts"));

/** The colours a file writes, comments left out: `#102` in a comment is an issue, not a colour. */
function colours(file: string): string[] {
  const text = readFileSync(join(dir, file), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/(^|[^:"'])\/\/.*$/gm, "$1");
  return [...new Set([...text.matchAll(/#[0-9a-f]{3}(?:[0-9a-f]{3})?\b/gi)].map((m) => m[0].toLowerCase()))];
}

describe("the colours of the components", () => {
  it.each(files)("%s writes no colour of its own beyond the allowed ones", (file) => {
    const own = ALLOWED[file.split("\\").join("/")] ?? [];
    expect(colours(file).filter((c) => !own.includes(c))).toEqual([]);
  });

  it("keep nothing of the palette of before", () => {
    for (const file of files) expect(colours(file).filter((c) => OLD.includes(c)), file).toEqual([]);
  });
});

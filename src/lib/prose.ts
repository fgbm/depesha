// How Depesha draws Markdown in the letter's sandboxed frame: a letter's Markdown part
// and an attached .md file look alike.

/** Code, tables, headings and tasks over the frame's base styles (MailFrame.svelte); greys
    that read on white and on a dark theme alike, since a letter's Markdown takes the theme. */
export const MARKDOWN_CSS = `<style>body{font-size:15px;line-height:1.6}
code,pre{font-family:ui-monospace,"DejaVu Sans Mono",Consolas,monospace;font-size:13px;background:rgb(128 128 128 / 12%);border-radius:4px}
code{padding:1px 4px}pre{padding:10px 12px;overflow:auto}pre code{padding:0;background:none}
table{border-collapse:collapse}th,td{border:1px solid rgb(128 128 128 / 30%);padding:4px 10px}th{background:rgb(128 128 128 / 12%)}
h1,h2{border-bottom:1px solid rgb(128 128 128 / 25%);padding-bottom:.25em}
li:has(> input[type=checkbox]){list-style:none}
li > input[type=checkbox]{margin:0 .45em 0 -1.35em;vertical-align:-2px;accent-color:#b5332a}</style>`;

/** A document reads as a column, not as a line across the screen. */
export const COLUMN_CSS = `<style>body{max-width:78ch;margin:24px auto;padding:0 22px}</style>`;

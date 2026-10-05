// The quote of a plain-text reply, told apart from what is typed above it.

/**
 * Splits a reply into what is typed and the quote under it: the "… wrote:" line and the
 * ">" lines after it, to the end. `head + quote` is the text again; no quote, all is head.
 */
export function splitQuote(text: string): { head: string; quote: string } {
  const lines = text.split("\n");
  let offset = 0;
  for (let i = 0; i < lines.length - 1; i++) {
    const line = lines[i];
    const header = line.trim() !== "" && !line.startsWith(">") && line.trimEnd().endsWith(":") && lines[i + 1].startsWith(">");
    if (header && lines.slice(i + 1).every((l) => l.startsWith(">") || l.trim() === "")) {
      // The empty lines above the header go with the quote.
      let start = offset;
      while (start > 0 && text[start - 1] === "\n") start--;
      return { head: text.slice(0, start), quote: text.slice(start) };
    }
    offset += line.length + 1;
  }
  return { head: text, quote: "" };
}

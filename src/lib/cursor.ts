// The row that has the cursor (#108, 2.5 Б): it moves the moment a key or a click does, not
// when the letter has come from the server. One selected row is the cursor itself; with
// several chosen it is the letter that is being opened, else the one that is open. If the
// open fails the selection still stands, so the cursor stays on the chosen row. Its ground
// marks the letter an action acts on, and no bar stands at the left of a row.
// Pure, covered by cursor.test.ts.

export function cursorId(selected: ReadonlySet<number>, opening: number | null | undefined, opened: number | null | undefined): number | null {
  if (selected.size === 1) return [...selected][0];
  return opening ?? opened ?? null;
}

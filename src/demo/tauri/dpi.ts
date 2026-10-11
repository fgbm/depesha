// The demo stand-in for `@tauri-apps/api/dpi`: `PhysicalPosition` with the one method the
// page uses (`toLogical`), so `src/lib/drops.ts` keeps working when a drop is faked.

export class PhysicalPosition {
  constructor(
    public x: number,
    public y: number,
  ) {}

  toLogical(scale: number): { x: number; y: number } {
    return { x: this.x / scale, y: this.y / scale };
  }
}

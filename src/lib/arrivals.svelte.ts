// A click on a desktop notification (#63). Stub: the behaviour comes with the next commit.

import type { View } from "./list.svelte";

export const FLASH_MS = 1500;

export class Arrivals {
  flash = $state<number | null>(null);
  focus = $state<number | null>(null);
  isFresh(_view: View, _id: number): boolean {
    return false;
  }
  freshCount(_view: View): number {
    return 0;
  }
  reset() {}
}

export const arrivals = new Arrivals();

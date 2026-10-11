// What `@demo/start` resolves to in the real app: the live mockup's panel is mounted only in
// `demo` mode, so this is a no-op. It is a file of its own (and not the demo entry) so that
// `src/main.ts` stays the same in both builds and no `if (demo)` appears anywhere.

/** Nothing to do outside the live mockup. */
export function startDemo(): void {}

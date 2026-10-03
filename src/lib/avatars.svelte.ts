import { SvelteMap } from "svelte/reactivity";
import { api } from "./api";

/** Sender pictures by account, address and whether a brand logo may show; null: none. */
const pictures = new SvelteMap<string, string | null>();
const asked = new Set<string>();

/**
 * The picture of a sender once it is known, initials until then. The first call
 * asks the backend, which keeps them for a week: a colleague's photo from
 * Exchange, or with `brand` (the message passed DMARC) the company's BIMI logo.
 */
export function avatarOf(accountId: string, email: string | undefined, brand: boolean): string | null {
  if (!email) return null;
  const key = `${accountId}\n${email.toLowerCase()}\n${brand ? 1 : 0}`;
  if (!asked.has(key)) {
    asked.add(key);
    // Not while rendering: the answer lands in state afterwards.
    queueMicrotask(() =>
      api.avatar(accountId, email, brand).then(
        (uri) => pictures.set(key, uri),
        () => pictures.set(key, null),
      ),
    );
  }
  return pictures.get(key) ?? null;
}

import { SvelteMap } from "svelte/reactivity";
import { api } from "./api";

/** Sender pictures by account, address and the letter a brand logo is asked for; null: none. */
const pictures = new SvelteMap<string, string | null>();
const asked = new Set<string>();

/**
 * The picture of a sender once it is known, initials until then. The first call
 * asks the backend, which keeps them for a week: a colleague's photo from
 * Exchange, or with `logoOf` (the cached letter that passed DMARC) the company's BIMI logo.
 * The backend checks the letter's verdict and folder itself; `null` asks for no logo.
 */
export function avatarOf(accountId: string, email: string | undefined, logoOf: number | null): string | null {
  if (!email) return null;
  const key = `${accountId}\n${email.toLowerCase()}\n${logoOf ?? 0}`;
  if (!asked.has(key)) {
    asked.add(key);
    // Not while rendering: the answer lands in state afterwards.
    queueMicrotask(() =>
      api.avatar(accountId, email, logoOf).then(
        (uri) => pictures.set(key, uri),
        () => pictures.set(key, null),
      ),
    );
  }
  return pictures.get(key) ?? null;
}

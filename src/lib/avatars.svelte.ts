import { SvelteMap } from "svelte/reactivity";
import { api } from "./api";

/** Sender pictures by account, address and whether a brand logo may show; null: none. */
const pictures = new SvelteMap<string, string | null>();
const asked = new Set<string>();

/**
 * The picture of a sender once it is known, initials until then. The first call
 * asks the backend, which keeps them for a week: a colleague's photo from
 * Exchange, or with `logoOf` (the cached letter that passed DMARC) the company's BIMI logo.
 * The backend checks the letter's verdict and folder itself; `null` asks for no logo. One
 * request per address and logo permission: the letter's id goes with the first one only, and
 * the rows of one sender asking at once share its answer.
 */
export function avatarOf(accountId: string, email: string | undefined, logoOf: number | null): string | null {
  if (!email) return null;
  const key = `${accountId}\n${email.toLowerCase()}\n${logoOf === null ? 0 : 1}`;
  if (!asked.has(key)) {
    asked.add(key);
    // Not while rendering: the answer lands in state afterwards.
    queueMicrotask(() =>
      api.avatar(accountId, email, logoOf).then(
        (uri) => pictures.set(key, uri),
        // No picture is remembered as none: the initials are shown.
        () => pictures.set(key, null),
      ),
    );
  }
  return pictures.get(key) ?? null;
}

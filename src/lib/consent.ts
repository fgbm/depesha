// What an extension asks for, laid out for the consent dialog: each permission and hook,
// which of them an update adds, and whether mail can leave the computer.

import type { ExtGrant } from "./types";

export interface ConsentItem {
  kind: "permission" | "hook";
  value: string;
  /** New since the version the user agreed to. */
  added: boolean;
}

export function grantOf(m: ExtGrant): ExtGrant {
  return { permissions: [...new Set(m.permissions)].sort(), hooks: [...new Set(m.hooks)].sort() };
}

/** Permissions, then hooks; `before` is what was agreed to for the installed copy. */
export function consentItems(m: ExtGrant, before: ExtGrant | null): ConsentItem[] {
  const g = grantOf(m);
  return [
    ...g.permissions.map((value) => ({ kind: "permission" as const, value, added: !!before && !before.permissions.includes(value) })),
    ...g.hooks.map((value) => ({ kind: "hook" as const, value, added: !!before && !before.hooks.includes(value) })),
  ];
}

/** Asks for something not agreed to before: an update like that needs consent again. */
export function widens(m: ExtGrant, before: ExtGrant): boolean {
  const g = grantOf(m);
  return g.permissions.some((p) => !before.permissions.includes(p)) || g.hooks.some((h) => !before.hooks.includes(h));
}

/** Where mail can go: the hosts of a plugin that both reads mail and has a network. */
export function mailLeaves(m: ExtGrant): { hosts: string[]; newMail: boolean } | null {
  const hosts = m.permissions.filter((p) => p.startsWith("network:")).map((p) => p.slice("network:".length));
  if (!m.permissions.includes("messages.read") || !hosts.length) return null;
  // New mail reaches only a plugin that may act on it.
  return { hosts, newMail: m.hooks.includes("newMail") && m.permissions.includes("messages.modify") };
}

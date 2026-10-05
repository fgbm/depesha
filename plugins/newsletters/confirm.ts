import type { Banner, Text } from "@depesha/plugin-api";
import { S } from "./strings";

/** How the backend would leave a list (`unsubscribe_plan`): nothing goes out before the user agrees. */
export type Way =
  | { kind: "one-click"; host: string }
  | { kind: "mail"; to: string; subject: string; text: string }
  | { kind: "link"; url: string };

export interface Plan {
  way: Way;
  /** The mailbox a request by mail leaves from. */
  from: string;
  /** The request by mail goes to another organization than the sender. */
  foreign: boolean;
}

type T = (text: Text, params?: Record<string, string | number>) => string;

/** The confirmation banner without its buttons: the way named, and a letter shown as it will be sent. */
export function confirmation(t: T, name: string, plan: Plan, reason: string | null): Omit<Banner, "icon" | "actions"> {
  const failed = reason ? `${t(S.oneClickFailed, { reason })} ` : "";
  const way = plan.way;
  if (way.kind === "one-click") return { tone: "info", text: t(S.confirmOneClick, { name, host: way.host }) };
  if (way.kind === "link") return { tone: "info", text: failed + t(S.confirmLink, { name, url: way.url }) };
  const text = failed + t(S.confirmMail, { name, from: plan.from }) + (plan.foreign ? ` ${t(S.foreign)}` : "");
  return {
    tone: plan.foreign ? "warn" : "info",
    text,
    details: [
      { label: t(S.to), value: way.to },
      { label: t(S.subject), value: way.subject },
      { label: t(S.text), value: way.text },
    ],
  };
}

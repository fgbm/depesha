// Where a wait for an answer stands, and who it waits for. Pure, covered by wait.test.ts.

import { addrName, type FollowupInfo, type MessageRow } from "@depesha/plugin-api";

/** Overdue is a waiting one past its deadline. */
export type State = "waiting" | "overdue" | "answered" | "closed";

export function stateOf(f: FollowupInfo, now: number): State {
  if (f.status !== "waiting") return f.status;
  // Waiting in the folder without a reminder: no deadline to miss.
  if (!f.deadline) return "waiting";
  return f.deadline <= now ? "overdue" : "waiting";
}

/** The letter waits in the folder "Waiting for reply", or is on its way there. */
export function parked(f: FollowupInfo | null | undefined): boolean {
  return !!f && f.status === "waiting" && (f.park === "pending" || f.park === "parked");
}

/** The wait of a row; rows of older backends have only the reminder's time. */
export function waitOf(row: MessageRow): FollowupInfo | null {
  if (row.followup) return row.followup;
  if (!row.followup_due) return null;
  return {
    status: "waiting",
    due: row.followup_due,
    deadline: row.followup_due,
    own_deadline: false,
    repeat_secs: 0,
    expect: "",
    kind: "",
    ended: null,
    answered_by: null,
    answer: null,
    reminded: [],
    sent: row.date,
    park: "",
    park_folder: "",
    auto_reply: null,
  };
}

/** The awaited recipient by the name the letter gives them. */
export function whoOf(row: MessageRow, email: string): string {
  const a = [...row.to, ...row.cc].find((x) => x.email.toLowerCase() === email);
  return a ? addrName(a) : email;
}

type Addr = { name: string | null; email: string };

/** The recipients one can wait for an answer from: To and Cc, each address once, in order. */
export function awaitable(to: Addr[], cc: Addr[]): Addr[] {
  const seen = new Set<string>();
  const out: Addr[] = [];
  for (const a of [...to, ...cc]) {
    const key = a.email.trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push({ name: a.name, email: key });
  }
  return out;
}

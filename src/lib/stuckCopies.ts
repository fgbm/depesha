import type { Task } from "./types";

/** The copies of sent letters the server refuses for good show in the tasks as `stuck-copy:<id>`. */
export const STUCK_KIND = "stuck-copy";

export function stuckTasks(tasks: Task[]): Task[] {
  return tasks.filter((x) => x.kind === STUCK_KIND && stuckId(x) !== null);
}

/** The mailbox's held copies: the badge at the mailbox counts them. */
export function stuckOf(tasks: Task[], accountId: string): Task[] {
  return stuckTasks(tasks).filter((x) => x.account_id === accountId);
}

export function stuckId(task: Task): number | null {
  const m = /^stuck-copy:(\d+)$/.exec(task.key);
  return m ? Number(m[1]) : null;
}

/** A file name for the saved copy: the subject without what a file system refuses. */
export function copyFileName(subject: string): string {
  const base = [...subject]
    .map((ch) => (ch.charCodeAt(0) < 32 || '\\/:*?"<>|'.includes(ch) ? " " : ch))
    .join("")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
  return `${base || "message"}.eml`;
}

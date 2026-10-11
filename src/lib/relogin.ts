import { api } from "./api";
import { AccountForm } from "./accountForm.svelte";
import { accountLabel } from "./format";
import { app } from "./store.svelte";
import type { Task } from "./types";

/** The server refused the saved login: only signing in again helps, a retry would fail the same way. */
export function needsLogin(task: Task): boolean {
  return task.error?.kind === "auth" && !!task.account_id && app.mailboxes.account(task.account_id) !== undefined;
}

/**
 * Signs the task's mailbox in again. A browser sign-in is the one on the mailbox's page: it
 * saves the new token and restarts the sync, so the task goes. A password is typed on that page.
 */
export async function relogin(task: Task): Promise<void> {
  const acc = task.account_id ? app.mailboxes.account(task.account_id) : undefined;
  if (!acc) return;
  const provider = acc.auth?.kind === "oauth" ? acc.auth.provider : null;
  if (!provider) {
    app.ui.tasksOpen = false;
    app.ui.openSettings(`account:${acc.id}`);
    return;
  }
  let saved = false;
  const form = new AccountForm(acc, () => (saved = true));
  await form.signIn(provider);
  // A task that cannot be dismissed stays listed; the sign-in is done all the same.
  if (saved) await api.taskDismiss(task.key).catch(() => {});
  else if (form.error) app.ui.fail(form.error, accountLabel(acc));
}

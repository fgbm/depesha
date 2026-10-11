import { api } from "./api";
import { AccountForm } from "./accountForm.svelte";
import { accountLabel } from "./format";
import { app } from "./store.svelte";
import type { Task } from "./types";

/** The server refused the saved login: only signing in again helps, a retry would fail the same way. */
export function needsLogin(task: Task): boolean {
  const kinds: Task["kind"][] = ["sync", "prefetch", "send"];
  return task.error?.kind === "auth" && kinds.includes(task.kind) && !!task.account_id && app.mailboxes.account(task.account_id) !== undefined;
}

/** The mailbox's letters the refused login held back go out again: the outbox stops a mailbox at the first refusal. */
async function resendHeld(accountId: string) {
  // An outbox that cannot be read holds nothing to restart; the sign-in itself is done.
  const held = (await api.outbox().catch(() => [])).filter((x) => x.account_id === accountId && x.failed);
  await Promise.all(held.map((x) => api.outboxRetry(x.id).catch((e) => app.ui.fail(e))));
}

/** Tasks whose sign-in is under way: a second click would open a second browser page. */
export const relogging = $state<Record<string, boolean>>({});

/**
 * Signs the task's mailbox in again. A browser sign-in is the one on the mailbox's page: it
 * saves the new token and restarts the sync, so the task goes. A password is typed on that page.
 */
export async function relogin(task: Task): Promise<void> {
  if (relogging[task.key]) return;
  relogging[task.key] = true;
  try {
    await signIn(task);
  } finally {
    relogging[task.key] = false;
  }
}

async function signIn(task: Task) {
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
  // The browser may be waited on for minutes: what was changed in the mailbox meanwhile is not written back from the old copy.
  form.settle = async () => {
    const fresh = app.mailboxes.account(acc.id);
    if (fresh) form.adopt(fresh);
  };
  await form.signIn(provider);
  if (saved) {
    if (task.kind === "send") await resendHeld(acc.id);
    // A task that cannot be dismissed stays listed; the sign-in is done all the same.
    await api.taskDismiss(task.key).catch(() => {});
  } else if (form.error) app.ui.fail(form.error, accountLabel(acc));
}

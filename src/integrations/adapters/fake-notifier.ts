import type { NotificationMessage, NotifierPort } from "../notifier.ts";

/** Recording fake notifier for tests. Mirrors fakeIssueTracker. `fail:true` forces notify() to throw. */
export function fakeNotifier(opts?: { fail?: boolean }): NotifierPort & {
  calls: NotificationMessage[];
} {
  const calls: NotificationMessage[] = [];
  return {
    calls,
    async notify(msg) {
      calls.push(msg);
      if (opts?.fail) throw new Error("fake notifier: forced failure");
      return { ref: `fake-ts-${calls.length}` };
    },
  };
}

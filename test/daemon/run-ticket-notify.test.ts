import { expect, test } from "bun:test";
import { RuntimeConfigSchema } from "../../src/config/runtime-config.ts";
import { driveToTerminal } from "../../src/daemon/run-ticket.ts";
import { insertPending } from "../../src/db/repos/signal.ts";
import { setTicketStage, setTicketStatus } from "../../src/db/repos/ticket.ts";
import { fakeIssueTracker } from "../../src/integrations/adapters/fake-issue-tracker.ts";
import { fakeNotifier } from "../../src/integrations/adapters/fake-notifier.ts";
import { makeTestDb } from "../helpers/db.ts";

test("a drive that idles to no-progress delivers the terminal 'Stopped' notification (post-loop drain)", async () => {
  const { db, ticketId } = makeTestDb();
  // Park the ticket OUT of v_ready_tickets (status 'waiting', no pending signal) so no ready ticket
  // exists → `tick` returns {advanced:0} without ever calling advanceOneStep → the (empty) registry
  // is never consulted → driveToTerminal idles to "no-progress" after IDLE_CAP(3) ticks. (A pending
  // human_resume would instead make it return "blocked" — don't use one here.)
  setTicketStatus(db, ticketId, "waiting");
  const notifier = fakeNotifier();
  const config = RuntimeConfigSchema.parse({
    notifier: "slack",
    notify: "escalations",
    slack: { channel: "#x" },
  });

  const result = await driveToTerminal(db, {} as never, {
    ticketId,
    config,
    ports: { issueTracker: fakeIssueTracker(), notifier },
    profile: { checksSystem: "none" },
  });
  db.close();

  expect(result.outcome).toBe("no-progress");
  // The centerpiece guard: the terminal notify was DELIVERED (post-loop drain), not left pending.
  expect(
    notifier.calls.some(
      (c) => c.event === "Stopped — couldn't make progress." && c.severity === "high",
    ),
  ).toBe(true);
});

test("a drive that reaches pr-ready delivers the terminal 'PR ready to merge' notification (post-loop drain)", async () => {
  const { db, ticketId } = makeTestDb();
  // Seed the pr-ready terminal directly, cheaply: park the ticket at stage 'merge' with a pending
  // human_merge_approval signal. The pending signal excludes the ticket from v_ready_tickets (see
  // schema.sql), so `tick` finds nothing ready and returns {advanced:0} without touching the (empty)
  // registry — driveToTerminal's own `t.stage === "merge" && pending.some(human_merge_approval)`
  // check (src/daemon/run-ticket.ts) then fires on the very first iteration, returning "pr-ready".
  setTicketStage(db, ticketId, "merge");
  insertPending(db, { ticketId, signalType: "human_merge_approval" });
  const notifier = fakeNotifier();
  const config = RuntimeConfigSchema.parse({
    notifier: "slack",
    notify: "escalations",
    slack: { channel: "#x" },
  });

  const result = await driveToTerminal(db, {} as never, {
    ticketId,
    config,
    ports: { issueTracker: fakeIssueTracker(), notifier },
    profile: { checksSystem: "none" },
  });
  db.close();

  expect(result.outcome).toBe("pr-ready");
  // The centerpiece guard: the success notify was DELIVERED (post-loop drain), not left pending —
  // this is the exact headline bug (silent on pr-ready success) the feature exists to fix.
  expect(
    notifier.calls.some((c) => c.event === "PR ready to merge" && c.severity === "success"),
  ).toBe(true);
});

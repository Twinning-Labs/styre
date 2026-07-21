import { expect, test } from "bun:test";
import { formatRunSummary } from "../../src/daemon/run-ticket.ts";
import { appendEvent } from "../../src/db/repos/event-log.ts";
import { insertPending, recordDelivered } from "../../src/db/repos/signal.ts";
import { makeTestDb } from "../helpers/db.ts";

test("formatRunSummary: pr-ready leads with the outcome sentence and prints the delivered PR URL", () => {
  const { db, ticketId } = makeTestDb();
  recordDelivered(db, {
    ticketId,
    signalType: "external_pr_result",
    payload: { url: "https://github.com/x/y/pull/1", ref: "x/y#1" },
    idempotencyKey: "pr-1",
  });

  const s = formatRunSummary(db, ticketId, {
    outcome: "pr-ready",
    iterations: 7,
    stage: "merge",
    status: "waiting",
  });
  db.close();

  expect(s).toContain("Opened the PR — ready for your review.");
  expect(s).toContain("PR: https://github.com/x/y/pull/1");
  // no bare internal status leaking into the summary
  expect(s).not.toContain("status=waiting");
});

test("formatRunSummary: a loopback event renders route + signature, not the bare word 'loopback'", () => {
  const { db, ticketId } = makeTestDb();
  appendEvent(db, {
    ticketId,
    kind: "loopback",
    loop: "design",
    routeTo: "review",
    signature: "a:1|b:2|c:3",
  });

  const s = formatRunSummary(db, ticketId, {
    outcome: "parked",
    iterations: 3,
    stage: "design",
    status: "waiting",
  });
  db.close();

  expect(s).toContain("loopback design → review");
  expect(s).toContain("a:1 (+2 more)");
  expect(s).not.toMatch(/#\d+ loopback\s*$/m);
});

test("formatRunSummary: pr-ready suppresses the 'Waiting on:' line even with a pending human_merge_approval", () => {
  const { db, ticketId } = makeTestDb();
  insertPending(db, { ticketId, signalType: "human_merge_approval" });

  const s = formatRunSummary(db, ticketId, {
    outcome: "pr-ready",
    iterations: 4,
    stage: "merge",
    status: "waiting",
  });
  db.close();

  expect(s).not.toContain("Waiting on:");
});

test("formatRunSummary: an escalation reports `escalated`, names the reason, hides internal vocab", () => {
  const { db, ticketId } = makeTestDb();
  insertPending(db, { ticketId, signalType: "human_resume" });
  appendEvent(db, { ticketId, kind: "escalated", reason: "step 'design:extract' failed" });

  const s = formatRunSummary(db, ticketId, {
    outcome: "escalated",
    iterations: 3,
    stage: "design",
    status: "waiting",
  });
  db.close();

  expect(s).toContain("Escalated — a human needs to unblock this; re-run once it's resolved.");
  expect(s).toContain("Reason: step 'design:extract' failed");
  // The blocked sentence and the raw internal signal name must NOT appear for an escalation.
  expect(s).not.toContain("Stopped — no actionable work remains.");
  expect(s).not.toContain("Waiting on: human_resume");
  // No internal detector vocabulary, no stack frames.
  expect(s).not.toContain("no-progress");
  expect(s).not.toMatch(/\bat .*\(.*:\d+:\d+\)/);
});

test("formatRunSummary: a resolver dead-end still reports `blocked` (distinct from an escalation)", () => {
  const { db, ticketId } = makeTestDb();
  // No pending human_resume, no escalated event → a genuine dead-end.
  const s = formatRunSummary(db, ticketId, {
    outcome: "blocked",
    iterations: 2,
    stage: "implement",
    status: "active",
  });
  db.close();

  expect(s).toContain("Stopped — no actionable work remains.");
  expect(s).not.toContain("Escalated");
});

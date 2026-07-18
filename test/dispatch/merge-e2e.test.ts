import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeAgentRunner } from "../../src/agent/fake-runner.ts";
import { DEFAULT_AGENT_CONFIG } from "../../src/config/agent-config.ts";
import { tick } from "../../src/daemon/loop.ts";
import { classifyAcCheck, insertAcCheck } from "../../src/db/repos/ac-check.ts";
import { insertAc } from "../../src/db/repos/acceptance-criterion.ts";
import { completeDispatch, insertDispatch, nextSeq } from "../../src/db/repos/dispatch.ts";
import { insertSignal } from "../../src/db/repos/ground-truth-signal.ts";
import { listPending as listSignals } from "../../src/db/repos/signal.ts";
import { getTicket } from "../../src/db/repos/ticket.ts";
import { insertWorkUnit } from "../../src/db/repos/work-unit.ts";
import { buildDispatchRegistry } from "../../src/dispatch/handlers.ts";
import { parseProfile } from "../../src/dispatch/profile.ts";
import { fakeForge } from "../../src/integrations/adapters/fake-forge.ts";
import { fakeIssueTracker } from "../../src/integrations/adapters/fake-issue-tracker.ts";
import { makeTestDb } from "../helpers/db.ts";

function registryFor() {
  return buildDispatchRegistry({
    runner: new FakeAgentRunner(() => {
      throw new Error("merge steps dispatch no agent");
    }),
    agentConfig: DEFAULT_AGENT_CONFIG,
    profile: parseProfile({
      slug: "demo",
      targetRepo: "/tmp/x",
      defaultBranch: "main",
    }),
    worktreeRoot: mkdtempSync(join(tmpdir(), "styre-me-")),
  });
}

/** Seed a ticket at stage='merge' with a completed dispatch carrying a branch_head_sha.
 *  Mirrors how merge-handlers.test.ts seeds for unit tests. */
function seedMergeTicket(db: ReturnType<typeof makeTestDb>["db"], ticketId: number) {
  db.query("UPDATE ticket SET stage = 'merge' WHERE id = ?").run(ticketId);
  insertWorkUnit(db, {
    ticketId,
    seq: 1,
    kind: "backend",
    behavioral: 0,
    verifyCheckTypes: ["test"],
  });
  const d = insertDispatch(db, { ticketId, dispatchId: "T-d1", seq: nextSeq(db, ticketId) });
  completeDispatch(db, d.id, { outcome: "clean-success", branchHeadSha: "headsha123" });
}

test("merge-write flow: push + PR opened, ticket parks awaiting human_merge_approval", async () => {
  const { db, ticketId } = makeTestDb();
  seedMergeTicket(db, ticketId);

  const reg = registryFor();
  const forge = fakeForge();
  const issueTracker = fakeIssueTracker();
  const ports = { issueTracker, forge };

  // Drive ticks until the ticket parks on human_merge_approval (status='waiting').
  // merge:push runs in tick 1 → enqueues forge/push → drain applies it.
  // merge:pr-ensure runs in tick 2 → enqueues forge/pr_create → drain applies it.
  // tick 3: resolver sees human_merge_approval not delivered → wait → ticket parks
  //   (checks are report-not-gate: no external_checks signal is ever created).
  let t = getTicket(db, ticketId);
  let iterations = 0;
  const MAX = 10;
  while (t?.status !== "waiting" && iterations < MAX) {
    await tick(db, reg, { ports });
    t = getTicket(db, ticketId);
    iterations++;
  }

  // Ticket must have parked (status='waiting') — not hit the iteration guard.
  expect(iterations).toBeLessThan(MAX);
  expect(t?.status).toBe("waiting");

  // forge/push row was drained to the fake forge.
  expect(forge.calls.some((c) => c.method === "push")).toBe(true);
  const pushCall = forge.calls.find((c) => c.method === "push");
  expect((pushCall?.args[0] as { sha: string }).sha).toBe("headsha123");

  // forge/pr_create row was drained → ensurePr called on the fake forge.
  expect(forge.calls.some((c) => c.method === "ensurePr")).toBe(true);
  const prCall = forge.calls.find((c) => c.method === "ensurePr");
  const prArgs = prCall?.args[0] as { branch: string; base: string; title: string; body: string };
  expect(prArgs.base).toBe("main");
  expect(typeof prArgs.body).toBe("string");
  expect(prArgs.body.length).toBeGreaterThan(0);

  // The pr_create outbox row is 'sent' and carries a response_ref (the PR ref from ensurePr).
  const sentPrRow = db
    .query<{ op: string; status: string; response_ref: string | null }, [number]>(
      "SELECT op, status, response_ref FROM projection_outbox WHERE ticket_id = ? AND op = 'pr_create'",
    )
    .get(ticketId);
  expect(sentPrRow?.status).toBe("sent");
  // fakeForge.ensurePr returns ref = `fake-pr-${prs.size + 1}` (per-branch) — a non-null string.
  expect(sentPrRow?.response_ref).not.toBeNull();
  expect(typeof sentPrRow?.response_ref).toBe("string");

  // A pending human_merge_approval signal exists — the wait the ticket is parked on.
  // No external_checks signal is ever created (checks are report-not-gate).
  const pendingSignals = listSignals(db, ticketId);
  expect(pendingSignals.some((s) => s.signal_type === "human_merge_approval")).toBe(true);
  expect(pendingSignals.some((s) => s.signal_type === "external_checks")).toBe(false);

  db.close();
});

test("idempotent re-drive: a second tick does not enqueue duplicate forge rows or re-call the fake forge", async () => {
  const { db, ticketId } = makeTestDb();
  seedMergeTicket(db, ticketId);

  const reg = registryFor();
  const forge = fakeForge();
  const issueTracker = fakeIssueTracker();
  const ports = { issueTracker, forge };

  // First: drive to parked state.
  let t = getTicket(db, ticketId);
  let iterations = 0;
  const MAX = 10;
  while (t?.status !== "waiting" && iterations < MAX) {
    await tick(db, reg, { ports });
    t = getTicket(db, ticketId);
    iterations++;
  }
  expect(t?.status).toBe("waiting");

  const forgeCallCountAfterFirstRun = forge.calls.length;

  // Capture outbox row count after first run (all rows should be 'sent').
  const outboxRows = db
    .query<{ id: number; status: string }, [number]>(
      "SELECT id, status FROM projection_outbox WHERE ticket_id = ? AND target = 'forge'",
    )
    .all(ticketId);
  // All forge outbox rows must be 'sent' at this point.
  expect(outboxRows.every((r) => r.status === "sent")).toBe(true);

  // Second tick: ticket is 'waiting' → not in v_ready_tickets → advanceOneStep not called.
  // drainOutbox finds no pending rows → fake forge not called again.
  await tick(db, reg, { ports });

  // No new forge rows enqueued.
  const outboxRowsAfter = db
    .query<{ id: number; status: string }, [number]>(
      "SELECT id, status FROM projection_outbox WHERE ticket_id = ? AND target = 'forge'",
    )
    .all(ticketId);
  expect(outboxRowsAfter.length).toBe(outboxRows.length);

  // Fake forge call count did not grow — already-sent rows are not re-applied.
  expect(forge.calls.length).toBe(forgeCallCountAfterFirstRun);

  db.close();
});

test("merge PR body carries the change-scoped verify criteria list", async () => {
  const { db, ticketId } = makeTestDb();
  seedMergeTicket(db, ticketId); // completes a dispatch at branch_head_sha 'headsha123'
  // Seed one verified AC at the SAME sha the seeded dispatch used, so the at-HEAD reads resolve.
  const ac = insertAc(db, {
    ticketId,
    seq: 1,
    text: "returns 201 on create",
    source: "checklist",
  });
  const chk = insertAcCheck(db, {
    ticketId,
    acId: ac.id,
    selector: "s",
    testPath: "t",
  });
  classifyAcCheck(db, { acCheckId: chk.id, redClass: "assertion" });
  insertSignal(db, {
    ticketId,
    signalType: "ac-check-post-implement",
    result: "pass",
    branchHeadSha: "headsha123",
    detail: {
      acCheckId: chk.id,
      acId: ac.id,
      coarse: "green",
      redClass: "assertion",
      outcome: "green",
    },
  });

  const reg = registryFor();
  const forge = fakeForge();
  const ports = { issueTracker: fakeIssueTracker(), forge };
  let t = getTicket(db, ticketId);
  let i = 0;
  while (t?.status !== "waiting" && i < 10) {
    await tick(db, reg, { ports });
    t = getTicket(db, ticketId);
    i++;
  }
  const prCall = forge.calls.find((c) => c.method === "ensurePr");
  const body = (prCall?.args[0] as { body: string }).body;
  expect(body).toContain("### Change-scoped verify");
  expect(body).toContain("✅ AC-1 — returns 201 on create");

  db.close();
});

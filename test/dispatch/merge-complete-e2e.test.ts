import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeAgentRunner } from "../../src/agent/fake-runner.ts";
import { DEFAULT_AGENT_CONFIG } from "../../src/config/agent-config.ts";
import { tick } from "../../src/daemon/loop.ts";
import { completeDispatch, insertDispatch, nextSeq } from "../../src/db/repos/dispatch.ts";
import { listPending } from "../../src/db/repos/signal.ts";
import { getTicket } from "../../src/db/repos/ticket.ts";
import { insertWorkUnit } from "../../src/db/repos/work-unit.ts";
import { buildDispatchRegistry } from "../../src/dispatch/handlers.ts";
import { type Profile, parseProfile } from "../../src/dispatch/profile.ts";
import { deliverSignal } from "../../src/engine/signals.ts";
import { fakeChecks } from "../../src/integrations/adapters/fake-checks.ts";
import { fakeForge } from "../../src/integrations/adapters/fake-forge.ts";
import { fakeIssueTracker } from "../../src/integrations/adapters/fake-issue-tracker.ts";
import { makeTestDb } from "../helpers/db.ts";

function registryFor(profile: Profile) {
  return buildDispatchRegistry({
    runner: new FakeAgentRunner(() => {
      throw new Error("merge steps dispatch no agent");
    }),
    agentConfig: DEFAULT_AGENT_CONFIG,
    profile,
    worktreeRoot: mkdtempSync(join(tmpdir(), "styre-mc-")),
  });
}

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

/** Drive ticks until predicate or MAX. */
async function driveUntil(
  db: ReturnType<typeof makeTestDb>["db"],
  reg: ReturnType<typeof registryFor>,
  opts: Parameters<typeof tick>[2],
  pred: () => boolean,
  label: string,
) {
  for (let i = 0; i < 20; i++) {
    if (pred()) return;
    await tick(db, reg, opts);
  }
  if (!pred()) throw new Error(`driveUntil: '${label}' not reached within 20 ticks`);
}

test("merge → released completes: checksSystem none auto-passes, operator approves merge", async () => {
  const { db, ticketId } = makeTestDb();
  seedMergeTicket(db, ticketId);
  const profile = parseProfile({
    slug: "demo",
    targetRepo: "/tmp/x",
    defaultBranch: "main",
    checksSystem: "none",
  });
  const reg = registryFor(profile);
  const ports = { issueTracker: fakeIssueTracker(), forge: fakeForge() };

  // The merge resolver parks directly on human_merge_approval (checks are report-not-gate).
  await driveUntil(
    db,
    reg,
    { ports },
    () => listPending(db, ticketId).some((s) => s.signal_type === "human_merge_approval"),
    "human_merge_approval pending",
  );

  // Operator approves the merge (the one human gate, delivered via the inbox in production).
  const approval = listPending(db, ticketId).find((s) => s.signal_type === "human_merge_approval");
  if (!approval) throw new Error("expected a pending human_merge_approval signal");
  deliverSignal(db, approval.id, { merged: true });

  await driveUntil(
    db,
    reg,
    { ports },
    () => getTicket(db, ticketId)?.status === "done",
    "ticket done",
  );

  const t = getTicket(db, ticketId);
  expect(t?.stage).toBe("released");
  expect(t?.status).toBe("done");
  // The released→done transition projected the tracker to 'done'.
  expect(
    ports.issueTracker.calls.some((c) => c.method === "setState" && c.args[1] === "done"),
  ).toBe(true);
  db.close();
});

test("merge → released completes: checksSystem github with passing checks", async () => {
  const { db, ticketId } = makeTestDb();
  seedMergeTicket(db, ticketId);
  const profile = parseProfile({
    slug: "demo",
    targetRepo: "/tmp/x",
    defaultBranch: "main",
    checksSystem: "github",
  });
  const reg = registryFor(profile);
  // The checks port is no longer consulted to reach human_merge_approval (nothing polls it);
  // kept here to document that its presence doesn't change the flow.
  const ports = {
    issueTracker: fakeIssueTracker(),
    forge: fakeForge(),
    checks: fakeChecks("passing"),
  };

  await driveUntil(
    db,
    reg,
    { ports },
    () => listPending(db, ticketId).some((s) => s.signal_type === "human_merge_approval"),
    "human_merge_approval pending",
  );

  const approval = listPending(db, ticketId).find((s) => s.signal_type === "human_merge_approval");
  if (!approval) throw new Error("expected a pending human_merge_approval signal");
  deliverSignal(db, approval.id, { merged: true });
  await driveUntil(
    db,
    reg,
    { ports },
    () => getTicket(db, ticketId)?.status === "done",
    "ticket done",
  );

  const t = getTicket(db, ticketId);
  expect(t?.stage).toBe("released");
  expect(t?.status).toBe("done");
  db.close();
});

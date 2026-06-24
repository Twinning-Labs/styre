import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeAgentRunner } from "../../src/agent/fake-runner.ts";
import { DEFAULT_AGENT_CONFIG } from "../../src/config/agent-config.ts";
import { advanceOneStep } from "../../src/daemon/advance.ts";
import { completeDispatch, insertDispatch, nextSeq } from "../../src/db/repos/dispatch.ts";
import { listPending } from "../../src/db/repos/projection-outbox.ts";
import { insertWorkUnit } from "../../src/db/repos/work-unit.ts";
import { getByKey, insertPending } from "../../src/db/repos/workflow-step.ts";
import { buildDispatchRegistry } from "../../src/dispatch/handlers.ts";
import { parseProfile } from "../../src/dispatch/profile.ts";
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
    worktreeRoot: mkdtempSync(join(tmpdir(), "styre-mh-")),
  });
}

// Record a ticket-level dispatch carrying a branch_head_sha so merge:push has a sha.
function seedReviewedBranch(db: ReturnType<typeof makeTestDb>["db"], ticketId: number) {
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

test("merge:push enqueues a forge push row at the branch head sha", async () => {
  const { db, ticketId } = makeTestDb();
  seedReviewedBranch(db, ticketId);
  await advanceOneStep(db, ticketId, registryFor()); // resolver → merge:push
  const rows = listPending(db).filter((r) => r.target === "forge" && r.op === "push");
  db.close();
  expect(rows.length).toBe(1);
  expect(JSON.parse(rows[0]?.payload_json ?? "{}").sha).toBe("headsha123");
});

test("merge:pr-ensure enqueues a forge pr_create row with base + a non-empty body", async () => {
  const { db, ticketId } = makeTestDb();
  seedReviewedBranch(db, ticketId);
  // mark merge:push done so the resolver routes to merge:pr-ensure
  const s = insertPending(db, { ticketId, stepKey: "merge:push", stepType: "project" });
  db.query("UPDATE workflow_step SET status = 'succeeded' WHERE id = ?").run(s.id);
  await advanceOneStep(db, ticketId, registryFor()); // resolver → merge:pr-ensure
  const rows = listPending(db).filter((r) => r.target === "forge" && r.op === "pr_create");
  db.close();
  expect(rows.length).toBe(1);
  const payload = JSON.parse(rows[0]?.payload_json ?? "{}");
  expect(payload.base).toBe("main");
  expect(typeof payload.body).toBe("string");
  expect(payload.body.length).toBeGreaterThan(0);
});

test("released:project runs (best-effort worktree cleanup) and succeeds", async () => {
  const { db, ticketId } = makeTestDb();
  db.query("UPDATE ticket SET stage = 'released' WHERE id = ?").run(ticketId);
  await advanceOneStep(db, ticketId, registryFor()); // resolver → released:project
  const step = getByKey(db, ticketId, "released:project");
  db.close();
  expect(step?.status).toBe("succeeded"); // cleanup is best-effort; the step doesn't fail if the worktree is absent
});

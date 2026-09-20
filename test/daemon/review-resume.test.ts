import type { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { DEFAULT_RUNTIME_CONFIG } from "../../src/config/runtime-config.ts";
import { nextStepKey } from "../../src/daemon/resolver.ts";
import { applyReviewResume, planReviewResume } from "../../src/daemon/review-resume.ts";
import { insertDispatch } from "../../src/db/repos/dispatch.ts";
import { listByTicket as events, appendEvent } from "../../src/db/repos/event-log.ts";
import { enqueue } from "../../src/db/repos/projection-outbox.ts";
import { getById, insertFinding, setStatus } from "../../src/db/repos/review-finding.ts";
import { requiredCodeFindings, unresolvedReviewReason } from "../../src/db/repos/review-round.ts";
import { getTicket } from "../../src/db/repos/ticket.ts";
import { insertWorkUnit } from "../../src/db/repos/work-unit.ts";
import { getByKey, insertPending } from "../../src/db/repos/workflow-step.ts";
import { makeTestDb } from "../helpers/db.ts";

const HEAD = "a".repeat(40);
const NEW_HEAD = "b".repeat(40);
const databases: Database[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

function seed(kind: "code" | "plan" = "code") {
  const { db, ticketId } = makeTestDb();
  databases.push(db);
  const stage = kind === "code" ? "review" : "design";
  const key = kind === "code" ? "review" : "design:review";
  db.query("UPDATE ticket SET stage=?, status='waiting', track='full' WHERE id=?").run(
    stage,
    ticketId,
  );
  const unit = insertWorkUnit(db, { ticketId, seq: 1, kind: "backend", behavioral: 0 });
  const step = insertPending(db, { ticketId, stepKey: key, stepType: "dispatch" });
  insertDispatch(db, { ticketId, dispatchId: "review-1", seq: 1, stepId: step.id, stage });
  db.query("UPDATE dispatch SET branch_head_sha=? WHERE ticket_id=?").run(HEAD, ticketId);
  const findings = [1, 2].map((n) =>
    insertFinding(db, {
      ticketId,
      dispatchId: "review-1",
      reviewKind: kind,
      workUnitId: unit.id,
      severity: "major",
      category: "correctness",
      deferralCandidate: 1,
      blocksShip: 0,
      location: `fixture.ts:${n}`,
      rationale: `Concrete review finding ${n}`,
    }),
  );
  db.query("UPDATE workflow_step SET status='succeeded', result_json=? WHERE id=?").run(
    JSON.stringify({ findings: 2, blocking: 0 }),
    step.id,
  );
  return { db, ticketId, step, findings };
}

function options(ids: number[]) {
  return {
    action: "accept-risk",
    findings: ids.join(","),
    reason: "Operator accepts this specified compatibility risk.",
  };
}

test("generic resume repairs legacy deferral suggestions instead of accepting them", () => {
  const { db, ticketId, findings } = seed();
  const plan = planReviewResume(db, ticketId, HEAD, false, {});
  expect(plan.kind).toBe("retry");
  db.transaction(() => applyReviewResume(db, ticketId, DEFAULT_RUNTIME_CONFIG, plan))();
  expect(getTicket(db, ticketId)?.stage).toBe("implement");
  expect(getByKey(db, ticketId, "review")?.status).toBe("pending");
  expect(requiredCodeFindings(db, ticketId).map((f) => f.id)).toEqual(findings.map((f) => f.id));
  expect(events(db, ticketId).filter((e) => e.reason === "review-risk-accepted")).toHaveLength(0);
});

test("acceptance requires exact IDs, eligible severity, explicit reason and reviewed HEAD", () => {
  const { db, ticketId, findings } = seed();
  const ids = findings.map((f) => f.id);
  const first = ids[0];
  if (first === undefined) throw new Error("fixture missing first finding");
  for (const invalid of [[], [first], [first, first], [...ids, 9999], [first, 9999]]) {
    expect(() => planReviewResume(db, ticketId, HEAD, false, options(invalid))).toThrow();
  }
  expect(() =>
    planReviewResume(db, ticketId, HEAD, false, { ...options(ids), reason: "  " }),
  ).toThrow();
  expect(() => planReviewResume(db, ticketId, NEW_HEAD, true, options(ids))).toThrow();
  expect(() => planReviewResume(db, ticketId, NEW_HEAD, false, options(ids))).toThrow();
  expect(() => planReviewResume(db, ticketId, null, false, options(ids))).toThrow();
  db.query(
    "UPDATE review_finding SET severity='critical', deferral_candidate=0, blocks_ship=1 WHERE id=?",
  ).run(first);
  expect(() => planReviewResume(db, ticketId, HEAD, false, options(ids))).toThrow();
  expect(requiredCodeFindings(db, ticketId)).toHaveLength(2);
});

test("acceptance does not trust a failed step or unmatched final review provenance", () => {
  const { db, ticketId, step, findings } = seed();
  const accept = options(findings.map((f) => f.id));
  db.query("UPDATE workflow_step SET status='failed' WHERE id=?").run(step.id);
  expect(() => planReviewResume(db, ticketId, HEAD, false, accept)).toThrow();
  db.query("UPDATE workflow_step SET status='succeeded', result_json='{}' WHERE id=?").run(step.id);
  expect(() => planReviewResume(db, ticketId, HEAD, false, accept)).toThrow();
  db.query("UPDATE workflow_step SET result_json=? WHERE id=?").run(
    JSON.stringify({ reviewCompletion: { dispatchId: "older-review" } }),
    step.id,
  );
  expect(() => planReviewResume(db, ticketId, HEAD, false, accept)).toThrow();
});

test("valid explicit acceptance is audited, head-scoped, and rollback remains atomic", () => {
  const { db, ticketId, findings } = seed();
  const ids = findings.map((f) => f.id);
  const plan = planReviewResume(db, ticketId, HEAD, false, options(ids));
  expect(() =>
    db.transaction(() => {
      applyReviewResume(db, ticketId, DEFAULT_RUNTIME_CONFIG, plan);
      throw new Error("abort surrounding resume transaction");
    })(),
  ).toThrow("abort surrounding");
  expect(ids.map((id) => getById(db, id)?.status)).toEqual(["open", "open"]);
  expect(events(db, ticketId)).toHaveLength(0);
  db.transaction(() => applyReviewResume(db, ticketId, DEFAULT_RUNTIME_CONFIG, plan))();
  expect(ids.map((id) => getById(db, id)?.status)).toEqual(["deferred", "deferred"]);
  expect(unresolvedReviewReason(db, ticketId, HEAD)).toBeNull();
  expect(unresolvedReviewReason(db, ticketId, NEW_HEAD)).toContain("stale risk acceptance");
  const accepted = events(db, ticketId).find((e) => e.reason === "review-risk-accepted");
  expect(accepted?.actor).toBe("operator");
  expect(JSON.parse(accepted?.payload_json ?? "{}")).toMatchObject({
    sha: HEAD,
    findingIds: ids,
    rationale: options(ids).reason,
  });
});

test("moving accepted HEAD reopens the same finding IDs and re-arms review", () => {
  const { db, ticketId, findings } = seed();
  const acceptance = planReviewResume(
    db,
    ticketId,
    HEAD,
    false,
    options(findings.map((f) => f.id)),
  );
  db.transaction(() => applyReviewResume(db, ticketId, DEFAULT_RUNTIME_CONFIG, acceptance))();
  const retry = planReviewResume(db, ticketId, NEW_HEAD, true, {});
  db.transaction(() => applyReviewResume(db, ticketId, DEFAULT_RUNTIME_CONFIG, retry))();
  expect(requiredCodeFindings(db, ticketId).map((f) => f.id)).toEqual(findings.map((f) => f.id));
  expect(getTicket(db, ticketId)?.stage).toBe("implement");
  expect(getByKey(db, ticketId, "review")?.status).toBe("pending");
});

test("unproven legacy deferred rows can retry without moving HEAD", () => {
  const { db, ticketId, findings } = seed();
  for (const f of findings) setStatus(db, f.id, "deferred");
  const plan = planReviewResume(db, ticketId, HEAD, false, { action: "retry" });
  expect(plan.kind).toBe("retry");
  db.transaction(() => applyReviewResume(db, ticketId, DEFAULT_RUNTIME_CONFIG, plan))();
  expect(requiredCodeFindings(db, ticketId)).toHaveLength(2);
  expect(getTicket(db, ticketId)?.stage).toBe("implement");
});

test("queued forge effects prevent retry before any ledger mutation", () => {
  const { db, ticketId, findings } = seed();
  enqueue(db, {
    ticketId,
    target: "forge",
    op: "push",
    idempotencyKey: "pending-push",
    payload: { sha: HEAD },
  });
  expect(() => planReviewResume(db, ticketId, HEAD, false, {})).toThrow("pending forge effects");
  expect(findings.map((f) => getById(db, f.id)?.status)).toEqual(["open", "open"]);
  expect(events(db, ticketId)).toHaveLength(0);
});

test("plan review cannot accept risks or advance merely because review step succeeded", () => {
  const { db, ticketId, findings } = seed("plan");
  for (const key of ["provision", "design:dispatch"]) {
    const step = insertPending(db, { ticketId, stepKey: key, stepType: "dispatch" });
    db.query("UPDATE workflow_step SET status='succeeded' WHERE id=?").run(step.id);
  }
  expect(nextStepKey(db, ticketId)).toMatchObject({ kind: "escalate", stepKey: "design:review" });
  expect(() =>
    planReviewResume(db, ticketId, HEAD, false, options(findings.map((f) => f.id))),
  ).toThrow();
  const retry = planReviewResume(db, ticketId, HEAD, false, {});
  expect(retry.kind).toBe("retry-plan");
  db.transaction(() => applyReviewResume(db, ticketId, DEFAULT_RUNTIME_CONFIG, retry))();
  expect(getTicket(db, ticketId)?.stage).toBe("design");
  expect(getByKey(db, ticketId, "design:review")?.status).toBe("pending");
});

test("same-HEAD repeated plan findings stay paused; explicit moved HEAD re-arms design", () => {
  const { db, ticketId } = seed("plan");
  appendEvent(db, {
    ticketId,
    kind: "loopback",
    loop: "design",
    routeTo: "review",
    signature: "review:correctness:fixture.ts:1|correctness:fixture.ts:2",
  });
  const same = planReviewResume(db, ticketId, HEAD, false, {});
  db.transaction(() => applyReviewResume(db, ticketId, DEFAULT_RUNTIME_CONFIG, same))();
  expect(getTicket(db, ticketId)?.status).toBe("waiting");
  expect(getByKey(db, ticketId, "design:review")?.status).toBe("succeeded");
  const moved = planReviewResume(db, ticketId, NEW_HEAD, true, {});
  db.transaction(() => applyReviewResume(db, ticketId, DEFAULT_RUNTIME_CONFIG, moved))();
  expect(getByKey(db, ticketId, "design:review")?.status).toBe("pending");
});

test("unchanged code retries and all plan retries respect the durable repair cap", () => {
  for (const kind of ["code", "plan"] as const) {
    const { db, ticketId } = seed(kind);
    for (let i = 0; i < 3; i++)
      appendEvent(db, {
        ticketId,
        kind: "loopback",
        loop: "design",
        routeTo: "review",
        signature: `old-${i}`,
      });
    expect(() => planReviewResume(db, ticketId, HEAD, false, {})).toThrow("review repair limit");
    if (kind === "plan")
      expect(() => planReviewResume(db, ticketId, NEW_HEAD, true, {})).toThrow(
        "review repair limit",
      );
    else expect(planReviewResume(db, ticketId, NEW_HEAD, true, {}).kind).toBe("retry");
  }
});

test("code-review redesign preserves mandatory finding identities after replacing work units", () => {
  const { db, ticketId, findings } = seed();
  const first = findings[0];
  if (!first) throw new Error("fixture missing first finding");
  db.query("UPDATE review_finding SET category='plan-defect' WHERE id=?").run(first.id);
  const retry = planReviewResume(db, ticketId, HEAD, false, {});
  db.transaction(() =>
    applyReviewResume(
      db,
      ticketId,
      {
        ...DEFAULT_RUNTIME_CONFIG,
        onPlanDefect: "redesign",
      },
      retry,
    ),
  )();
  expect(getTicket(db, ticketId)?.stage).toBe("design");
  expect(requiredCodeFindings(db, ticketId).map((f) => f.id)).toEqual(findings.map((f) => f.id));
  expect(findings.map((f) => getById(db, f.id)?.work_unit_id)).toEqual([null, null]);
  expect(findings.map((f) => getById(db, f.id)?.status)).toEqual(["open", "open"]);
});

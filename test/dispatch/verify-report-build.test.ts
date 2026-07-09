import { expect, test } from "bun:test";
import { classifyAcCheck, insertAcCheck, supersedeByAc } from "../../src/db/repos/ac-check.ts";
import { insertAc } from "../../src/db/repos/acceptance-criterion.ts";
import { completeDispatch, insertDispatch, nextSeq } from "../../src/db/repos/dispatch.ts";
import { insertSignal } from "../../src/db/repos/ground-truth-signal.ts";
import { buildVerifyReport } from "../../src/dispatch/verify-report.ts";
import { makeTestDb } from "../helpers/db.ts";

const HEAD = "headsha123";

function seedHead(db: ReturnType<typeof makeTestDb>["db"], ticketId: number) {
  const d = insertDispatch(db, { ticketId, dispatchId: "d1", seq: nextSeq(db, ticketId) });
  completeDispatch(db, d.id, { outcome: "clean-success", branchHeadSha: HEAD });
}

test("verified: an assertion check green at HEAD", () => {
  const { db, ticketId } = makeTestDb();
  seedHead(db, ticketId);
  const ac = insertAc(db, { ticketId, seq: 1, text: "returns 201 on create", source: "checklist" });
  const chk = insertAcCheck(db, { ticketId, acId: ac.id, selector: "s", testPath: "t" });
  classifyAcCheck(db, { acCheckId: chk.id, redClass: "assertion" });
  insertSignal(db, {
    ticketId,
    signalType: "ac-check-post-implement",
    result: "pass",
    branchHeadSha: HEAD,
    detail: {
      acCheckId: chk.id,
      acId: ac.id,
      coarse: "green",
      redClass: "assertion",
      outcome: "green",
    },
  });
  const r = buildVerifyReport(db, ticketId);
  expect(r.criteria).toEqual([{ seq: 1, text: "returns 201 on create", label: "verified" }]);
  expect(r.allClean).toBe(true);
});

test("satisfied, not-expressible, no-check labels", () => {
  const { db, ticketId } = makeTestDb();
  seedHead(db, ticketId);
  const a1 = insertAc(db, { ticketId, seq: 1, text: "pre-existing", source: "checklist" });
  const c1 = insertAcCheck(db, { ticketId, acId: a1.id, selector: "s", testPath: "t" });
  classifyAcCheck(db, { acCheckId: c1.id, disposition: "satisfied" });
  const a2 = insertAc(db, { ticketId, seq: 2, text: "subjective", source: "checklist" });
  const c2 = insertAcCheck(db, { ticketId, acId: a2.id, selector: "s", testPath: "t" });
  classifyAcCheck(db, { acCheckId: c2.id, disposition: "not-expressible" });
  insertAc(db, { ticketId, seq: 3, text: "no check for this", source: "checklist" });
  const r = buildVerifyReport(db, ticketId);
  expect(r.criteria.map((c) => c.label)).toEqual(["satisfied", "not-expressible", "no-check"]);
  expect(r.allClean).toBe(false); // not-expressible + no-check force it false
});

test("environmental check green at HEAD is NOT verified (I1)", () => {
  const { db, ticketId } = makeTestDb();
  seedHead(db, ticketId);
  const ac = insertAc(db, { ticketId, seq: 1, text: "env only", source: "checklist" });
  const chk = insertAcCheck(db, { ticketId, acId: ac.id, selector: "s", testPath: "t" });
  classifyAcCheck(db, { acCheckId: chk.id, redClass: "environmental" });
  insertSignal(db, {
    ticketId,
    signalType: "ac-check-post-implement",
    result: "pass",
    branchHeadSha: HEAD,
    detail: {
      acCheckId: chk.id,
      acId: ac.id,
      coarse: "green",
      redClass: "environmental",
      outcome: "advisory-red",
    },
  });
  const r = buildVerifyReport(db, ticketId);
  expect(r.criteria[0].label).toBe("environmental");
  expect(r.allClean).toBe(false);
});

test("environmental still-red emits an advisory caveat tagged to its AC", () => {
  const { db, ticketId } = makeTestDb();
  seedHead(db, ticketId);
  const ac = insertAc(db, { ticketId, seq: 1, text: "env red", source: "checklist" });
  const chk = insertAcCheck(db, { ticketId, acId: ac.id, selector: "s", testPath: "t" });
  classifyAcCheck(db, { acCheckId: chk.id, redClass: "environmental" });
  insertSignal(db, {
    ticketId,
    signalType: "ac-check-post-implement",
    result: "fail",
    branchHeadSha: HEAD,
    detail: {
      acCheckId: chk.id,
      acId: ac.id,
      coarse: "red",
      redClass: "environmental",
      outcome: "advisory-red",
    },
  });
  const r = buildVerifyReport(db, ticketId);
  expect(r.advisory).toContainEqual({ kind: "environmental-red", seq: 1 });
});

test("C1: an active check with a rejected re-author is check-unreplaced, even if coarse green", () => {
  const { db, ticketId } = makeTestDb();
  seedHead(db, ticketId);
  const ac = insertAc(db, { ticketId, seq: 1, text: "wrong-shape check", source: "checklist" });
  const chk = insertAcCheck(db, { ticketId, acId: ac.id, selector: "s", testPath: "t" });
  classifyAcCheck(db, { acCheckId: chk.id, redClass: "assertion" });
  // Post-implement went green (implement coded to the wrong shape) — must NOT read as verified.
  insertSignal(db, {
    ticketId,
    signalType: "ac-check-post-implement",
    result: "pass",
    branchHeadSha: HEAD,
    detail: {
      acCheckId: chk.id,
      acId: ac.id,
      coarse: "green",
      redClass: "assertion",
      outcome: "green",
    },
  });
  insertSignal(db, {
    ticketId,
    signalType: "ac-check-blame",
    result: "fail",
    branchHeadSha: "roundsha",
    detail: {
      acId: ac.id,
      acCheckId: chk.id,
      blame: "check-wrong",
      reason: "asserts 200, AC says 201",
    },
  });
  insertSignal(db, {
    ticketId,
    signalType: "ac-check-reauthor",
    result: "fail",
    branchHeadSha: "roundsha",
    detail: { acId: ac.id, acCheckId: chk.id, disposition: "rejected" },
  });
  const r = buildVerifyReport(db, ticketId);
  expect(r.criteria[0].label).toBe("check-unreplaced");
  expect(r.allClean).toBe(false);
  expect(r.provenance).toContainEqual({
    seq: 1,
    disposition: "rejected",
    reason: "asserts 200, AC says 201",
  });
});

test("superseded checks do not leak into the rollup", () => {
  const { db, ticketId } = makeTestDb();
  seedHead(db, ticketId);
  const ac = insertAc(db, { ticketId, seq: 1, text: "re-authored", source: "checklist" });
  const old = insertAcCheck(db, { ticketId, acId: ac.id, selector: "old", testPath: "t" });
  classifyAcCheck(db, { acCheckId: old.id, redClass: "assertion" });
  supersedeByAc(db, ac.id); // supersede the old generation
  const neu = insertAcCheck(db, { ticketId, acId: ac.id, selector: "new", testPath: "t" });
  classifyAcCheck(db, { acCheckId: neu.id, redClass: "assertion" });
  insertSignal(db, {
    ticketId,
    signalType: "ac-check-post-implement",
    result: "pass",
    branchHeadSha: HEAD,
    detail: {
      acCheckId: neu.id,
      acId: ac.id,
      coarse: "green",
      redClass: "assertion",
      outcome: "green",
    },
  });
  const r = buildVerifyReport(db, ticketId);
  expect(r.criteria[0].label).toBe("verified"); // reads the new active check only
});

test("advisory sweeps surface sha-agnostically (I2)", () => {
  const { db, ticketId } = makeTestDb();
  seedHead(db, ticketId); // HEAD = headsha123
  insertSignal(db, {
    ticketId,
    signalType: "integration",
    result: "fail",
    branchHeadSha: "OLDER_SHA",
    detail: { advisory: true, ran: [{ label: "backend:test", exitCode: 1 }] },
  });
  const r = buildVerifyReport(db, ticketId);
  expect(r.advisory).toContainEqual({
    kind: "integration",
    result: "fail",
    firstFailingJob: "backend:test",
  });
});

test("precedence: green gating + environmental-red on one AC → verified headline + env caveat + not clean (design §6)", () => {
  const { db, ticketId } = makeTestDb();
  seedHead(db, ticketId);
  const ac = insertAc(db, { ticketId, seq: 1, text: "mixed", source: "checklist" });
  const gate = insertAcCheck(db, { ticketId, acId: ac.id, selector: "g", testPath: "t" });
  classifyAcCheck(db, { acCheckId: gate.id, redClass: "assertion" });
  insertSignal(db, {
    ticketId,
    signalType: "ac-check-post-implement",
    result: "pass",
    branchHeadSha: HEAD,
    detail: {
      acCheckId: gate.id,
      acId: ac.id,
      coarse: "green",
      redClass: "assertion",
      outcome: "green",
    },
  });
  const env = insertAcCheck(db, { ticketId, acId: ac.id, selector: "e", testPath: "t" });
  classifyAcCheck(db, { acCheckId: env.id, redClass: "environmental" });
  insertSignal(db, {
    ticketId,
    signalType: "ac-check-post-implement",
    result: "fail",
    branchHeadSha: HEAD,
    detail: {
      acCheckId: env.id,
      acId: ac.id,
      coarse: "red",
      redClass: "environmental",
      outcome: "advisory-red",
    },
  });
  const r = buildVerifyReport(db, ticketId);
  expect(r.criteria[0].label).toBe("verified"); // gating check green — headline reflects gating only
  expect(r.advisory).toContainEqual({ kind: "environmental-red", seq: 1 }); // env red still surfaced
  expect(r.allClean).toBe(false); // the advisory caveat forces it false
});

test("installed re-author → new active check verified + installed provenance line (M-2)", () => {
  const { db, ticketId } = makeTestDb();
  seedHead(db, ticketId);
  const ac = insertAc(db, { ticketId, seq: 1, text: "re-authored ok", source: "checklist" });
  const old = insertAcCheck(db, { ticketId, acId: ac.id, selector: "old", testPath: "t" });
  classifyAcCheck(db, { acCheckId: old.id, redClass: "assertion" });
  // Arbiter blamed the old check check-wrong; reauthor INSTALLED — the signal records the OLD (about-to-be
  // superseded) id, per handlers.ts checks:reauthor.
  insertSignal(db, {
    ticketId,
    signalType: "ac-check-blame",
    result: "fail",
    branchHeadSha: "roundsha",
    detail: {
      acId: ac.id,
      acCheckId: old.id,
      blame: "check-wrong",
      reason: "asserted stale field",
    },
  });
  insertSignal(db, {
    ticketId,
    signalType: "ac-check-reauthor",
    result: "pass",
    branchHeadSha: "roundsha",
    detail: { acId: ac.id, acCheckId: old.id, disposition: "installed" },
  });
  supersedeByAc(db, ac.id);
  const neu = insertAcCheck(db, { ticketId, acId: ac.id, selector: "new", testPath: "t" });
  classifyAcCheck(db, { acCheckId: neu.id, redClass: "assertion" });
  insertSignal(db, {
    ticketId,
    signalType: "ac-check-post-implement",
    result: "pass",
    branchHeadSha: HEAD,
    detail: {
      acCheckId: neu.id,
      acId: ac.id,
      coarse: "green",
      redClass: "assertion",
      outcome: "green",
    },
  });
  const r = buildVerifyReport(db, ticketId);
  expect(r.criteria[0].label).toBe("verified"); // installed id is the superseded old id → not in rejected set
  expect(r.provenance).toContainEqual({
    seq: 1,
    disposition: "installed",
    reason: "asserted stale field",
  });
});

test("no ACs → empty report", () => {
  const { db, ticketId } = makeTestDb();
  seedHead(db, ticketId);
  const r = buildVerifyReport(db, ticketId);
  expect(r.criteria).toEqual([]);
  expect(r.advisory).toEqual([]);
  expect(r.provenance).toEqual([]);
});

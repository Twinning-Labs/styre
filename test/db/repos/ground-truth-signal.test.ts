import { expect, test } from "bun:test";
import {
  behavioralStillRed,
  blameShasFor,
  insertSignal,
  latestBlameAtSha,
  latestReauthorAtSha,
  listByUnit,
  passingShasFor,
  reauthorShasFor,
} from "../../../src/db/repos/ground-truth-signal.ts";
import * as gts from "../../../src/db/repos/ground-truth-signal.ts";
import { insertWorkUnit } from "../../../src/db/repos/work-unit.ts";
import { makeTestDb } from "../../helpers/db.ts";

test("insertSignal records a pass signal with detail; listByUnit returns it", () => {
  const { db, ticketId } = makeTestDb();
  const unit = insertWorkUnit(db, { ticketId, seq: 1, kind: "backend" });
  gts.insertSignal(db, {
    ticketId,
    workUnitId: unit.id,
    signalType: "test",
    result: "pass",
    detail: { tests_passed: 3 },
  });
  const list = gts.listByUnit(db, unit.id);
  db.close();
  expect(list.length).toBe(1);
  expect(list[0]?.signal_type).toBe("test");
  expect(list[0]?.result).toBe("pass");
  expect(JSON.parse(list[0]?.detail_json ?? "null")).toEqual({ tests_passed: 3 });
  expect(list[0]?.measured_at).toBeTruthy();
});

test("listByUnit is empty for a unit with no signals", () => {
  const { db, ticketId } = makeTestDb();
  const unit = insertWorkUnit(db, { ticketId, seq: 1, kind: "backend" });
  const list = gts.listByUnit(db, unit.id);
  db.close();
  expect(list).toEqual([]);
});

test("insertSignal stores SQL NULL when detail is omitted", () => {
  const { db, ticketId } = makeTestDb();
  const unit = insertWorkUnit(db, { ticketId, seq: 1, kind: "backend" });
  gts.insertSignal(db, {
    ticketId,
    workUnitId: unit.id,
    signalType: "build",
    result: "pass",
  });
  const list = gts.listByUnit(db, unit.id);
  db.close();
  expect(list.length).toBe(1);
  expect(list[0]?.detail_json).toBeNull();
});

test("insertSignal persists and reads back the profile command", () => {
  const { db, ticketId } = makeTestDb();
  const unit = insertWorkUnit(db, {
    ticketId,
    seq: 1,
    kind: "backend",
    verifyCheckTypes: ["test"],
  });
  const row = insertSignal(db, {
    ticketId,
    workUnitId: unit.id,
    signalType: "test",
    result: "pass",
    command: "bun test",
  });
  const back = listByUnit(db, unit.id);
  db.close();
  expect(row.command).toBe("bun test");
  expect(back[0]?.command).toBe("bun test");
});

test("command defaults to null when omitted", () => {
  const { db, ticketId } = makeTestDb();
  const unit = insertWorkUnit(db, {
    ticketId,
    seq: 1,
    kind: "backend",
    verifyCheckTypes: ["test"],
  });
  const row = insertSignal(db, {
    ticketId,
    workUnitId: unit.id,
    signalType: "test",
    result: "pass",
  });
  db.close();
  expect(row.command).toBeNull();
});

test("records branch_head_sha and reports the SHAs a check passed at", () => {
  const { db, ticketId } = makeTestDb();
  const unit = insertWorkUnit(db, {
    ticketId,
    seq: 1,
    kind: "backend",
    verifyCheckTypes: ["test"],
  });
  insertSignal(db, {
    ticketId,
    workUnitId: unit.id,
    signalType: "test",
    result: "fail",
    branchHeadSha: "aaa",
  });
  insertSignal(db, {
    ticketId,
    workUnitId: unit.id,
    signalType: "test",
    result: "pass",
    branchHeadSha: "bbb",
  });
  const passed = passingShasFor(db, { ticketId, workUnitId: unit.id, signalType: "test" });
  db.close();
  expect(passed).toEqual(["bbb"]); // only the passing SHA, history of the fail kept
});

test("behavioralStillRed subtracts tampered from stillRed of the gate signal at a sha", () => {
  const { db, ticketId } = makeTestDb();
  insertSignal(db, {
    ticketId,
    signalType: "ac-check-gate",
    result: "fail",
    branchHeadSha: "S1",
    detail: { stillRed: [4, 7], tampered: [7], advisory: [] },
  });
  expect(behavioralStillRed(db, ticketId, "S1")).toEqual([4]);
  db.close();
});

test("blameShasFor / latestBlameAtSha round-key the ac-check-blame signal", () => {
  const { db, ticketId } = makeTestDb();
  insertSignal(db, {
    ticketId,
    signalType: "ac-check-blame",
    result: "fail",
    branchHeadSha: "S1",
    detail: { acId: 4, acCheckId: 40, blame: "code-wrong", reason: "r" },
  });
  expect(blameShasFor(db, ticketId)).toContain("S1");
  expect(latestBlameAtSha(db, ticketId, "S1")).toEqual([
    { acId: 4, acCheckId: 40, blame: "code-wrong", reason: "r" },
  ]);
  expect(latestBlameAtSha(db, ticketId, "S2")).toEqual([]);
  db.close();
});

test("reauthorShasFor / latestReauthorAtSha round-key the ac-check-reauthor disposition", () => {
  const { db, ticketId } = makeTestDb();
  insertSignal(db, {
    ticketId,
    signalType: "ac-check-reauthor",
    result: "pass",
    branchHeadSha: "S1",
    detail: { acId: 4, acCheckId: 41, disposition: "installed" },
  });
  insertSignal(db, {
    ticketId,
    signalType: "ac-check-reauthor",
    result: "fail",
    branchHeadSha: "S1",
    detail: { acId: 5, acCheckId: 51, disposition: "rejected" },
  });
  expect(reauthorShasFor(db, ticketId)).toContain("S1");
  expect(latestReauthorAtSha(db, ticketId, "S1")).toHaveLength(2);
  expect(latestReauthorAtSha(db, ticketId, "S2")).toEqual([]);
  db.close();
});

import { expect, test } from "bun:test";
import {
  completeDispatch,
  getLatestByWorkUnit,
  getLatestForTicket,
  insertDispatch,
  nextSeq,
} from "../../../src/db/repos/dispatch.ts";
import * as dispatch from "../../../src/db/repos/dispatch.ts";
import { insertWorkUnit } from "../../../src/db/repos/work-unit.ts";
import { makeTestDb } from "../../helpers/db.ts";

test("nextSeq starts at 1 and increments per ticket", () => {
  const { db, ticketId } = makeTestDb();
  expect(dispatch.nextSeq(db, ticketId)).toBe(1);
  dispatch.insertDispatch(db, { ticketId, dispatchId: "ENG-1-d0001", seq: 1 });
  const next = dispatch.nextSeq(db, ticketId);
  db.close();
  expect(next).toBe(2);
});

test("insertDispatch records start fields with partial=0 default", () => {
  const { db, ticketId } = makeTestDb();
  const row = dispatch.insertDispatch(db, {
    ticketId,
    dispatchId: "ENG-1-d0001",
    seq: 1,
    stage: "design",
    model: "claude-opus-4-8",
    startedAt: "2026-06-20T00:00:00.000Z",
  });
  db.close();
  expect(row.dispatch_id).toBe("ENG-1-d0001");
  expect(row.stage).toBe("design");
  expect(row.model).toBe("claude-opus-4-8");
  expect(row.outcome).toBeNull();
  expect(row.partial).toBe(0);
});

test("completeDispatch records outcome + usage; getByDispatchId reads it back", () => {
  const { db, ticketId } = makeTestDb();
  const row = dispatch.insertDispatch(db, { ticketId, dispatchId: "ENG-1-d0001", seq: 1 });
  dispatch.completeDispatch(db, row.id, {
    outcome: "clean-success",
    branchHeadSha: "abc123",
    endedAt: "2026-06-20T00:01:00.000Z",
    tokensIn: 100,
    tokensOut: 50,
    costUsd: 0.42,
  });
  const after = dispatch.getByDispatchId(db, ticketId, "ENG-1-d0001");
  db.close();
  expect(after?.outcome).toBe("clean-success");
  expect(after?.branch_head_sha).toBe("abc123");
  expect(after?.tokens_in).toBe(100);
  expect(after?.cost_usd).toBe(0.42);
});

test("listByTicket returns dispatches ordered by seq", () => {
  const { db, ticketId } = makeTestDb();
  dispatch.insertDispatch(db, { ticketId, dispatchId: "ENG-1-d0002", seq: 2 });
  dispatch.insertDispatch(db, { ticketId, dispatchId: "ENG-1-d0001", seq: 1 });
  const list = dispatch.listByTicket(db, ticketId);
  db.close();
  expect(list.map((d) => d.seq)).toEqual([1, 2]);
});

test("getLatestByWorkUnit / getLatestForTicket return the most recent coding attempt", () => {
  const { db, ticketId } = makeTestDb();
  const unit = insertWorkUnit(db, { ticketId, seq: 1, kind: "backend" });
  const d1 = insertDispatch(db, {
    ticketId,
    dispatchId: "ENG-1-d0001",
    seq: nextSeq(db, ticketId),
    workUnitId: unit.id,
  });
  completeDispatch(db, d1.id, { outcome: "clean-success", branchHeadSha: "sha1" });
  const d2 = insertDispatch(db, {
    ticketId,
    dispatchId: "ENG-1-d0002",
    seq: nextSeq(db, ticketId),
    workUnitId: unit.id,
  });
  completeDispatch(db, d2.id, { outcome: "clean-success", branchHeadSha: "sha2" });
  const latestUnit = getLatestByWorkUnit(db, unit.id);
  const latestTicket = getLatestForTicket(db, ticketId);
  db.close();
  expect(latestUnit?.branch_head_sha).toBe("sha2");
  expect(latestTicket?.branch_head_sha).toBe("sha2");
});

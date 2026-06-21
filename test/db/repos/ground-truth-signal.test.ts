import { expect, test } from "bun:test";
import { insertSignal, listByUnit } from "../../../src/db/repos/ground-truth-signal.ts";
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

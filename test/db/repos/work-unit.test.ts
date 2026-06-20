import { expect, test } from "bun:test";
import * as workUnits from "../../../src/db/repos/work-unit.ts";
import { makeTestDb } from "../../helpers/db.ts";

test("insertWorkUnit creates a pending unit with parsed json fields", () => {
  const { db, ticketId } = makeTestDb();
  const u = workUnits.insertWorkUnit(db, {
    ticketId,
    seq: 1,
    kind: "backend",
    verifyCheckTypes: ["test"],
    dependsOn: [],
  });
  db.close();
  expect(u.status).toBe("pending");
  expect(u.kind).toBe("backend");
  expect(workUnits.parseVerifyCheckTypes(u)).toEqual(["test"]);
  expect(workUnits.parseDependsOn(u)).toEqual([]);
});

test("listByTicket returns units ordered by seq", () => {
  const { db, ticketId } = makeTestDb();
  workUnits.insertWorkUnit(db, { ticketId, seq: 2, kind: "frontend" });
  workUnits.insertWorkUnit(db, { ticketId, seq: 1, kind: "backend" });
  const list = workUnits.listByTicket(db, ticketId);
  db.close();
  expect(list.map((u) => u.seq)).toEqual([1, 2]);
});

test("setStatus updates the unit status", () => {
  const { db, ticketId } = makeTestDb();
  const u = workUnits.insertWorkUnit(db, { ticketId, seq: 1, kind: "backend" });
  workUnits.setStatus(db, u.id, "verified");
  const after = workUnits.getById(db, u.id);
  db.close();
  expect(after?.status).toBe("verified");
});

test("parse helpers tolerate null json", () => {
  const { db, ticketId } = makeTestDb();
  const u = workUnits.insertWorkUnit(db, { ticketId, seq: 1, kind: "backend" });
  db.close();
  expect(workUnits.parseDependsOn(u)).toEqual([]);
  expect(workUnits.parseVerifyCheckTypes(u)).toEqual([]);
});

import { describe, expect, test } from "bun:test";
import { completeDispatch, insertDispatch } from "../../src/db/repos/dispatch.ts";
import { getByDispatchId } from "../../src/db/repos/dispatch.ts";
import { makeTestDb } from "../helpers/db.ts";

describe("completeDispatch duration_ms", () => {
  test("computes duration_ms from started_at and ended_at when not passed", () => {
    const { db, ticketId } = makeTestDb();
    insertDispatch(db, {
      ticketId,
      dispatchId: "ENG-1-d0001",
      seq: 1,
      startedAt: "2026-07-16T00:00:00.000Z",
    });
    const row = getByDispatchId(db, ticketId, "ENG-1-d0001");
    if (!row) throw new Error("row missing");
    completeDispatch(db, row.id, {
      outcome: "clean-success",
      endedAt: "2026-07-16T00:00:12.500Z",
    });
    const done = getByDispatchId(db, ticketId, "ENG-1-d0001");
    if (!done) throw new Error("done missing");
    expect(done.duration_ms).toBe(12500);
    db.close();
  });

  test("leaves duration_ms null when started_at is absent", () => {
    const { db, ticketId } = makeTestDb();
    insertDispatch(db, { ticketId, dispatchId: "ENG-1-d0002", seq: 2 });
    const row = getByDispatchId(db, ticketId, "ENG-1-d0002");
    if (!row) throw new Error("row missing");
    completeDispatch(db, row.id, { outcome: "parked", endedAt: "2026-07-16T00:00:01.000Z" });
    expect(getByDispatchId(db, ticketId, "ENG-1-d0002")?.duration_ms).toBeNull();
    db.close();
  });

  test("an explicitly passed durationMs wins", () => {
    const { db, ticketId } = makeTestDb();
    insertDispatch(db, {
      ticketId,
      dispatchId: "ENG-1-d0003",
      seq: 3,
      startedAt: "2026-07-16T00:00:00.000Z",
    });
    const row = getByDispatchId(db, ticketId, "ENG-1-d0003");
    if (!row) throw new Error("row missing");
    completeDispatch(db, row.id, {
      outcome: "clean-success",
      endedAt: "2026-07-16T00:00:10.000Z",
      durationMs: 999,
    });
    expect(getByDispatchId(db, ticketId, "ENG-1-d0003")?.duration_ms).toBe(999);
    db.close();
  });
});

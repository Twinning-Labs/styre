import { expect, test } from "bun:test";
import { headBaseline } from "../../src/cli/park.ts";
import { completeDispatch, nextSeq } from "../../src/db/repos/dispatch.ts";
import { appendEvent } from "../../src/db/repos/event-log.ts";
import { makeTestDb } from "../helpers/db.ts";

/**
 * Insert a dispatch row with a known created_at so we can control ordering precisely.
 * We insert via direct SQL to bypass the nowUtc() default in insertDispatch.
 */
function seedDispatch(
  db: ReturnType<typeof makeTestDb>["db"],
  ticketId: number,
  branchHeadSha: string,
  createdAt: string,
): void {
  const seq = nextSeq(db, ticketId);
  const dispatchId = `d-${seq}-${Date.now()}`;
  // Insert with an explicit created_at by using a raw query instead of insertDispatch, which
  // hard-codes nowUtc(). Then completeDispatch to set the branch_head_sha.
  db.query(
    `INSERT INTO dispatch
       (ticket_id, work_unit_id, step_id, dispatch_id, seq, stage, kind, model, started_at, worktree_path, created_at)
     VALUES ($t, NULL, NULL, $did, $seq, NULL, NULL, NULL, NULL, NULL, $created_at)`,
  ).run({ $t: ticketId, $did: dispatchId, $seq: seq, $created_at: createdAt });
  const row = db
    .query<{ id: number }, [number, string]>(
      "SELECT id FROM dispatch WHERE ticket_id = ? AND dispatch_id = ?",
    )
    .get(ticketId, dispatchId);
  if (!row) throw new Error("seedDispatch: row missing after insert");
  completeDispatch(db, row.id, { outcome: "success", branchHeadSha: branchHeadSha });
}

/**
 * Insert an accept-head resumed event with an explicit created_at so we can control ordering.
 */
function seedAcceptHeadEvent(
  db: ReturnType<typeof makeTestDb>["db"],
  ticketId: number,
  sha: string,
  createdAt: string,
): void {
  // appendEvent uses nowUtc() for created_at — override via direct SQL after the insert.
  const row = appendEvent(db, { ticketId, kind: "resumed", reason: `accept-head:${sha}` });
  db.query("UPDATE event_log SET created_at = ? WHERE id = ?").run(createdAt, row.id);
}

test("committed sha wins when dispatch row is newer than the accept-head event", () => {
  // Scenario: --accept-head ran at T1 (recording shaA), then Styre committed and advanced to shaB at T2.
  // headBaseline should return shaB (the committed sha is newer).
  const { db, ticketId } = makeTestDb();
  seedAcceptHeadEvent(db, ticketId, "shaA", "2024-01-01T10:00:00.000Z");
  seedDispatch(db, ticketId, "shaB", "2024-01-01T11:00:00.000Z"); // newer than the accept event

  // This FAILS before the fix: the old code returns "shaA" unconditionally when an accept-head
  // event exists, regardless of whether a newer committed dispatch sha exists.
  expect(headBaseline(db, ticketId)).toBe("shaB");
  db.close();
});

test("accepted sha wins when accept-head event is newer than the latest committed dispatch", () => {
  // Scenario: Styre committed shaB at T1, then the operator ran --accept-head (accepting shaA, a
  // different sha they pushed manually) at T2.  headBaseline should return shaA.
  const { db, ticketId } = makeTestDb();
  seedDispatch(db, ticketId, "shaB", "2024-01-01T10:00:00.000Z");
  seedAcceptHeadEvent(db, ticketId, "shaA", "2024-01-01T11:00:00.000Z"); // newer than dispatch

  expect(headBaseline(db, ticketId)).toBe("shaA");
  db.close();
});

test("returns dispatch sha when no accept-head event exists", () => {
  const { db, ticketId } = makeTestDb();
  seedDispatch(db, ticketId, "shaX", "2024-01-01T10:00:00.000Z");

  expect(headBaseline(db, ticketId)).toBe("shaX");
  db.close();
});

test("returns accepted sha when no dispatch row has a branch_head_sha", () => {
  const { db, ticketId } = makeTestDb();
  seedAcceptHeadEvent(db, ticketId, "shaY", "2024-01-01T10:00:00.000Z");

  expect(headBaseline(db, ticketId)).toBe("shaY");
  db.close();
});

test("returns null when neither an accept-head event nor a committed dispatch exists", () => {
  const { db, ticketId } = makeTestDb();

  expect(headBaseline(db, ticketId)).toBeNull();
  db.close();
});

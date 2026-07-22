import { describe, expect, test } from "bun:test";
import { insertDispatch, listByTicket as listDispatches } from "../../src/db/repos/dispatch.ts";
import { appendEvent, listByTicket as listEvents } from "../../src/db/repos/event-log.ts";
import { makeTestDb } from "../helpers/db.ts";

describe("row widening", () => {
  test("DispatchRow carries forensic fields (null when unset)", () => {
    const { db, ticketId } = makeTestDb();
    insertDispatch(db, { ticketId, dispatchId: "ENG-1-d0001", seq: 1 });
    const row = listDispatches(db, ticketId)[0];
    expect(row).toHaveProperty("trigger");
    expect(row).toHaveProperty("exit_code");
    expect(row).toHaveProperty("effort");
    expect(row).toHaveProperty("predecessor_dispatch_id");
    expect(row.trigger).toBeNull();
    db.close();
  });

  test("appendEvent writes dispatch_id when given, null otherwise", () => {
    const { db, ticketId } = makeTestDb();
    appendEvent(db, { ticketId, kind: "note", reason: "no-dispatch" });
    appendEvent(db, { ticketId, kind: "loopback", dispatchId: "ENG-1-d0001" });
    const evs = listEvents(db, ticketId);
    expect(evs[0].dispatch_id).toBeNull();
    expect(evs[1].dispatch_id).toBe("ENG-1-d0001");
    db.close();
  });
});

import { expect, test } from "bun:test";
import * as eventLog from "../../../src/db/repos/event-log.ts";
import { makeTestDb } from "../../helpers/db.ts";

test("appendEvent assigns monotonic seq per ticket", () => {
  const { db, ticketId } = makeTestDb();
  const a = eventLog.appendEvent(db, {
    ticketId,
    kind: "transition",
    fromStage: "design",
    toStage: "implement",
  });
  const b = eventLog.appendEvent(db, {
    ticketId,
    kind: "transition",
    fromStage: "implement",
    toStage: "review",
  });
  db.close();
  expect(a.seq).toBe(1);
  expect(b.seq).toBe(2);
  expect(a.kind).toBe("transition");
  expect(a.from_stage).toBe("design");
  expect(a.to_stage).toBe("implement");
  expect(a.actor).toBe("runner");
});

test("appendEvent records loopback fields; listByTicket returns in order", () => {
  const { db, ticketId } = makeTestDb();
  eventLog.appendEvent(db, {
    ticketId,
    kind: "transition",
    fromStage: "design",
    toStage: "implement",
  });
  eventLog.appendEvent(db, {
    ticketId,
    kind: "loopback",
    loop: "implement",
    routeTo: "implement:wu1:dispatch",
    signature: "tests-red:[t1]",
  });
  const list = eventLog.listByTicket(db, ticketId);
  db.close();
  expect(list.length).toBe(2);
  expect(list[0]?.seq).toBe(1);
  expect(list[1]?.seq).toBe(2);
  expect(list[1]?.kind).toBe("loopback");
  expect(list[1]?.loop).toBe("implement");
  expect(list[1]?.signature).toBe("tests-red:[t1]");
});

test("appendEvent round-trips dispatch_id", () => {
  const { db, ticketId } = makeTestDb();
  const row = eventLog.appendEvent(db, { ticketId, kind: "escalated", dispatchId: "ENG-9-d0007" });
  expect(row.dispatch_id).toBe("ENG-9-d0007");
  db.close();
});

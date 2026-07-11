import { expect, test } from "bun:test";
import { insertSignal, signalForAcCheck } from "../../../src/db/repos/ground-truth-signal.ts";
import { makeTestDb } from "../../helpers/db.ts";

test("signalForAcCheck reads the RED-first signal by live ac_check id, not the latest for the AC", () => {
  const { db, ticketId } = makeTestDb();
  // A stale prior-round signal for a now-dead ac_check id 11, then the live row's signal id 22.
  insertSignal(db, {
    ticketId,
    signalType: "ac-check-red-first",
    result: "fail",
    detail: { rawOutput: "stale", exitCode: 1, framework: "pytest", command: "old", acCheckId: 11 },
  });
  insertSignal(db, {
    ticketId,
    signalType: "ac-check-red-first",
    result: "fail",
    detail: { rawOutput: "live", exitCode: 2, framework: "pytest", command: "new", acCheckId: 22 },
  });

  const hit = signalForAcCheck(db, 22);
  expect(hit?.detail.rawOutput).toBe("live");
  expect(hit?.detail.exitCode).toBe(2);
  expect(signalForAcCheck(db, 99)).toBeNull();
  db.close();
});

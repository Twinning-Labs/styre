import { expect, test } from "bun:test";
import { pollChecks } from "../../src/daemon/poll-checks.ts";
import { completeDispatch, insertDispatch, nextSeq } from "../../src/db/repos/dispatch.ts";
import { hasDelivered, listPending } from "../../src/db/repos/signal.ts";
import { getTicket } from "../../src/db/repos/ticket.ts";
import { awaitSignal } from "../../src/engine/signals.ts";
import { fakeChecks } from "../../src/integrations/adapters/fake-checks.ts";
import { makeTestDb } from "../helpers/db.ts";

/** Park a ticket on external_checks and give it a completed dispatch with a head sha. */
function parkOnChecks(db: ReturnType<typeof makeTestDb>["db"], ticketId: number) {
  const d = insertDispatch(db, { ticketId, dispatchId: "D1", seq: nextSeq(db, ticketId) });
  completeDispatch(db, d.id, { outcome: "clean-success", branchHeadSha: "sha-1" });
  awaitSignal(db, { ticketId, signalType: "external_checks" });
}

test("checksSystem none → external_checks auto-delivered (human merge stays the gate)", async () => {
  const { db, ticketId } = makeTestDb();
  parkOnChecks(db, ticketId);
  await pollChecks(db, { checksSystem: "none" });
  expect(hasDelivered(db, ticketId, "external_checks")).toBe(true);
  expect(getTicket(db, ticketId)?.status).toBe("active"); // un-parked
  db.close();
});

test("github + passing → delivered; polls the head sha", async () => {
  const { db, ticketId } = makeTestDb();
  parkOnChecks(db, ticketId);
  const checks = fakeChecks("passing");
  await pollChecks(db, { checksSystem: "github" }, checks);
  expect(hasDelivered(db, ticketId, "external_checks")).toBe(true);
  expect((checks.calls[0].args[0] as { ref: string }).ref).toBe("sha-1");
  db.close();
});

test("github + failing → NOT delivered, escalates once (guarded against spam)", async () => {
  const { db, ticketId } = makeTestDb();
  parkOnChecks(db, ticketId);
  const checks = fakeChecks("failing");
  await pollChecks(db, { checksSystem: "github" }, checks);
  await pollChecks(db, { checksSystem: "github" }, checks); // second tick must not add a 2nd escalation
  expect(hasDelivered(db, ticketId, "external_checks")).toBe(false);
  const pending = listPending(db, ticketId);
  expect(pending.filter((s) => s.signal_type === "human_resume").length).toBe(1);
  db.close();
});

test("github + pending → left parked, no escalation", async () => {
  const { db, ticketId } = makeTestDb();
  parkOnChecks(db, ticketId);
  await pollChecks(db, { checksSystem: "github" }, fakeChecks("pending"));
  expect(hasDelivered(db, ticketId, "external_checks")).toBe(false);
  expect(listPending(db, ticketId).some((s) => s.signal_type === "human_resume")).toBe(false);
  db.close();
});

test("checksSystem external → unsupported: left parked, no delivery, no escalation", async () => {
  const { db, ticketId } = makeTestDb();
  parkOnChecks(db, ticketId);
  await pollChecks(db, { checksSystem: "external" }, fakeChecks("passing"));
  expect(hasDelivered(db, ticketId, "external_checks")).toBe(false);
  expect(listPending(db, ticketId).some((s) => s.signal_type === "human_resume")).toBe(false);
  db.close();
});

test("a throwing checks port does not throw out of pollChecks (loop never blocks)", async () => {
  const { db, ticketId } = makeTestDb();
  parkOnChecks(db, ticketId);
  const throwingChecks = {
    async status(): Promise<never> {
      throw new Error("network down");
    },
  };
  await pollChecks(db, { checksSystem: "github" }, throwingChecks);
  expect(hasDelivered(db, ticketId, "external_checks")).toBe(false); // left parked, no crash
  db.close();
});

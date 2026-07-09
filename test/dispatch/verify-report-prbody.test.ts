import { expect, test } from "bun:test";
import { classifyAcCheck, insertAcCheck } from "../../src/db/repos/ac-check.ts";
import { insertAc } from "../../src/db/repos/acceptance-criterion.ts";
import { completeDispatch, insertDispatch, nextSeq } from "../../src/db/repos/dispatch.ts";
import { insertSignal } from "../../src/db/repos/ground-truth-signal.ts";
import { getTicket } from "../../src/db/repos/ticket.ts";
import { renderPrBody } from "../../src/dispatch/handlers.ts";
import { makeTestDb } from "../helpers/db.ts";

const HEAD = "headsha123";
function seedHead(db: ReturnType<typeof makeTestDb>["db"], ticketId: number) {
  const d = insertDispatch(db, { ticketId, dispatchId: "d1", seq: nextSeq(db, ticketId) });
  completeDispatch(db, d.id, { outcome: "clean-success", branchHeadSha: HEAD });
}
function mustGetTicket(db: ReturnType<typeof makeTestDb>["db"], ticketId: number) {
  const t = getTicket(db, ticketId);
  if (!t) throw new Error("ticket not found");
  return t;
}

test("no ACs: body unchanged, keeps the closing line", () => {
  const { db, ticketId } = makeTestDb();
  seedHead(db, ticketId);
  const body = renderPrBody(db, mustGetTicket(db, ticketId));
  expect(body).not.toContain("### Change-scoped verify");
  expect(body).toContain("Verified against the project's checks and passed independent review.");
});

test("clean ACs: block present, closing line kept", () => {
  const { db, ticketId } = makeTestDb();
  seedHead(db, ticketId);
  const ac = insertAc(db, { ticketId, seq: 1, text: "returns 201", source: "checklist" });
  const chk = insertAcCheck(db, { ticketId, acId: ac.id, selector: "s", testPath: "t" });
  classifyAcCheck(db, { acCheckId: chk.id, redClass: "assertion" });
  insertSignal(db, {
    ticketId,
    signalType: "ac-check-post-implement",
    result: "pass",
    branchHeadSha: HEAD,
    detail: {
      acCheckId: chk.id,
      acId: ac.id,
      coarse: "green",
      redClass: "assertion",
      outcome: "green",
    },
  });
  const body = renderPrBody(db, mustGetTicket(db, ticketId));
  expect(body).toContain("### Change-scoped verify");
  expect(body).toContain("✅ AC-1 — returns 201");
  expect(body).toContain("Verified against the project's checks and passed independent review.");
});

test("not-clean ACs: closing line dropped", () => {
  const { db, ticketId } = makeTestDb();
  seedHead(db, ticketId);
  const ac = insertAc(db, { ticketId, seq: 1, text: "subjective", source: "checklist" });
  const chk = insertAcCheck(db, { ticketId, acId: ac.id, selector: "s", testPath: "t" });
  classifyAcCheck(db, { acCheckId: chk.id, disposition: "not-expressible" });
  const body = renderPrBody(db, mustGetTicket(db, ticketId));
  expect(body).toContain("⚪ AC-1 — subjective");
  expect(body).not.toContain(
    "Verified against the project's checks and passed independent review.",
  );
});

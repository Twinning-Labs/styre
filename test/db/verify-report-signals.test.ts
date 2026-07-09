import { expect, test } from "bun:test";
import { insertSignal } from "../../src/db/repos/ground-truth-signal.ts";
import {
  advisorySweeps,
  postImplementAtSha,
  reauthorProvenance,
} from "../../src/db/repos/ground-truth-signal.ts";
import { makeTestDb } from "../helpers/db.ts";

test("postImplementAtSha: newest coarse per acCheckId at the sha", () => {
  const { db, ticketId } = makeTestDb();
  insertSignal(db, { ticketId, signalType: "ac-check-post-implement", result: "fail",
    branchHeadSha: "sha1", detail: { acCheckId: 7, acId: 1, coarse: "red", redClass: "assertion", outcome: "gated-red" } });
  insertSignal(db, { ticketId, signalType: "ac-check-post-implement", result: "pass",
    branchHeadSha: "sha1", detail: { acCheckId: 7, acId: 1, coarse: "green", redClass: "assertion", outcome: "green" } });
  // A different sha must not leak in.
  insertSignal(db, { ticketId, signalType: "ac-check-post-implement", result: "fail",
    branchHeadSha: "sha0", detail: { acCheckId: 7, acId: 1, coarse: "red", redClass: "assertion", outcome: "gated-red" } });
  const m = postImplementAtSha(db, ticketId, "sha1");
  expect(m.get(7)?.coarse).toBe("green"); // newest at sha1 wins
});

test("advisorySweeps: only advisory:true + non-pass, newest per type, excludes gate's number[] advisory", () => {
  const { db, ticketId } = makeTestDb();
  // A demoted suite (checkType 'backend') that errored.
  insertSignal(db, { ticketId, signalType: "backend", result: "error", branchHeadSha: "shaOld",
    detail: { advisory: true } });
  // A demoted integration fail with a failing job — at a DIFFERENT sha than any HEAD (sha-agnostic).
  insertSignal(db, { ticketId, signalType: "integration", result: "fail", branchHeadSha: "shaOld",
    detail: { advisory: true, ran: [{ label: "backend:build", exitCode: 0 }, { label: "backend:test", exitCode: 1 }] } });
  // A passing advisory must be excluded.
  insertSignal(db, { ticketId, signalType: "frontend", result: "pass", branchHeadSha: "shaOld",
    detail: { advisory: true } });
  // The gate signal carries advisory as a number[] — must NOT be selected.
  insertSignal(db, { ticketId, signalType: "ac-check-gate", result: "fail", branchHeadSha: "shaOld",
    detail: { stillRed: [1], tampered: [], advisory: [2, 3] } });
  const sweeps = advisorySweeps(db, ticketId).sort((a, b) => a.type.localeCompare(b.type));
  expect(sweeps.map((s) => s.type)).toEqual(["backend", "integration"]);
  expect(sweeps.find((s) => s.type === "integration")?.firstFailingJob).toBe("backend:test");
  expect(sweeps.find((s) => s.type === "backend")?.result).toBe("error");
});

test("reauthorProvenance: newest disposition per acCheckId + joined check-wrong reason", () => {
  const { db, ticketId } = makeTestDb();
  insertSignal(db, { ticketId, signalType: "ac-check-blame", result: "fail", branchHeadSha: "sha1",
    detail: { acId: 2, acCheckId: 9, blame: "check-wrong", reason: "asserts 200 but AC says 201" } });
  insertSignal(db, { ticketId, signalType: "ac-check-reauthor", result: "fail", branchHeadSha: "sha1",
    detail: { acId: 2, acCheckId: 9, disposition: "rejected" } });
  const prov = reauthorProvenance(db, ticketId);
  expect(prov).toEqual([{ acId: 2, acCheckId: 9, disposition: "rejected", reason: "asserts 200 but AC says 201" }]);
});

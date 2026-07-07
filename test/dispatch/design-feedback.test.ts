import { expect, test } from "bun:test";
import { insertFinding } from "../../src/db/repos/review-finding.ts";
import { designFeedback } from "../../src/dispatch/design-feedback.ts";
import { makeTestDb } from "../helpers/db.ts";
import { insertDesignReviewDispatch } from "../helpers/dispatch-fixtures.ts";

test("designFeedback is empty with no prior review", () => {
  const { db, ticketId } = makeTestDb();
  expect(designFeedback(db, ticketId)).toBe("");
  db.close();
});

test("designFeedback returns only the blocking findings of the latest review", () => {
  const { db, ticketId } = makeTestDb();
  const dispatchId = insertDesignReviewDispatch(db, ticketId); // creates a design:review step + dispatch row
  insertFinding(db, {
    ticketId,
    dispatchId,
    reviewKind: "plan",
    severity: "major",
    category: "consistency",
    location: "docs/plans/ENG-1.md:45",
    rationale: "regex breaks the offset invariant",
    blocksShip: 1,
  });
  insertFinding(db, {
    ticketId,
    dispatchId,
    reviewKind: "plan",
    severity: "nit",
    category: "scope",
    location: null,
    rationale: "trivial",
    blocksShip: 0,
  });
  const out = designFeedback(db, ticketId);
  db.close();
  expect(out).toContain("regex breaks the offset invariant");
  expect(out).toContain("docs/plans/ENG-1.md:45");
  expect(out).not.toContain("trivial"); // non-blocking excluded
  expect(out).toContain("no changes needed"); // the disposition demand
});

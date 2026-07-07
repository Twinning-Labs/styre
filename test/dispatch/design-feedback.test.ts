import { expect, test } from "bun:test";
import { appendEvent } from "../../src/db/repos/event-log.ts";
import { designFeedback } from "../../src/dispatch/design-feedback.ts";
import { makeTestDb } from "../helpers/db.ts";

test("designFeedback is empty with no prior redesign", () => {
  const { db, ticketId } = makeTestDb();
  expect(designFeedback(db, ticketId)).toBe("");
  db.close();
});

test("designFeedback renders the findings snapshotted into the latest design loopback event", () => {
  const { db, ticketId } = makeTestDb();
  appendEvent(db, {
    ticketId,
    kind: "loopback",
    loop: "design",
    routeTo: "review",
    signature: "review:consistency:docs/plans/ENG-1.md:45",
    payload: {
      findings: [
        {
          category: "consistency",
          location: "docs/plans/ENG-1.md:45",
          rationale: "regex breaks the offset invariant",
        },
      ],
    },
  });
  const out = designFeedback(db, ticketId);
  db.close();
  expect(out).toContain("regex breaks the offset invariant");
  expect(out).toContain("docs/plans/ENG-1.md:45");
  expect(out).toContain("no changes needed"); // the disposition demand
});

test("designFeedback reads the most recent design loopback, not an earlier one", () => {
  const { db, ticketId } = makeTestDb();
  appendEvent(db, {
    ticketId,
    kind: "loopback",
    loop: "design",
    routeTo: "review",
    signature: "sig-old",
    payload: { findings: [{ category: "scope", location: "p:1", rationale: "OLD-ISSUE" }] },
  });
  appendEvent(db, {
    ticketId,
    kind: "loopback",
    loop: "design",
    routeTo: "review",
    signature: "sig-new",
    payload: { findings: [{ category: "feasibility", location: "p:2", rationale: "NEW-ISSUE" }] },
  });
  const out = designFeedback(db, ticketId);
  db.close();
  expect(out).toContain("NEW-ISSUE");
  expect(out).not.toContain("OLD-ISSUE");
});

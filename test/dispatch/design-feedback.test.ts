import { expect, test } from "bun:test";
import { invalidateSteps } from "../../src/daemon/invalidate.ts";
import { appendEvent } from "../../src/db/repos/event-log.ts";
import { designFeedback } from "../../src/dispatch/design-feedback.ts";
import { makeTestDb } from "../helpers/db.ts";
import {
  STEP_TEST_TIMEOUT_MS,
  atStep,
  driveUntil,
  makeDesignTicket,
} from "../helpers/design-steps.ts";

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

test(
  "a loopback written before ENG-477 (no consumer) is generation 0 feedback for design:dispatch",
  async () => {
    // design:dispatch has really run once (generation 0); the loopback is written as an older Styre
    // wrote it, with no consumer and no generation.
    const t = makeDesignTicket();
    await driveUntil(t, atStep("design:extract"));
    appendEvent(t.db, {
      ticketId: t.ticketId,
      kind: "loopback",
      loop: "design",
      routeTo: "review",
      signature: "s",
      payload: { findings: [{ category: "x", location: null, rationale: "LEGACY-FINDING" }] },
    });
    expect(designFeedback(t.db, t.ticketId)).toContain("LEGACY-FINDING");
    invalidateSteps(t.db, t.ticketId, ["design:dispatch"], {
      cause: "inputs",
      changed: ["profile.promptVars"],
    });
    expect(designFeedback(t.db, t.ticketId)).toBe("");
  },
  STEP_TEST_TIMEOUT_MS,
);

test("a design loopback addressed to another consumer is not design:dispatch's feedback", () => {
  const { db, ticketId } = makeTestDb();
  appendEvent(db, {
    ticketId,
    kind: "loopback",
    loop: "design",
    routeTo: "review",
    signature: "s",
    payload: {
      findings: [{ category: "x", location: null, rationale: "FOR-ANOTHER-STEP" }],
      consumer: "design:extract",
      generation: 0,
    },
  });
  expect(designFeedback(db, ticketId)).toBe("");
  db.close();
});

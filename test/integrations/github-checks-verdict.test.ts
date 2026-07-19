import { expect, test } from "bun:test";
import {
  type CheckRunLike,
  type CommitStatusLike,
  aggregateChecksVerdict,
} from "../../src/integrations/adapters/github-checks-verdict.ts";

const run = (status: string, conclusion?: string | null): CheckRunLike => ({ status, conclusion });
const st = (context: string, state: string): CommitStatusLike => ({ context, state });

// ---------------------------------------------------------------------------
// ENG-340 #1 — the headline bug. Styre ALWAYS pushes then opens a PR
// (handlers.ts merge:push -> merge:pr-ensure), which is exactly what trips
// `concurrency: cancel-in-progress`. The push suite gets cancelled by the PR
// suite; both are attached to the same head sha, and /check-runs?filter=latest
// dedups per suite, not across suites -- so both come back.
// ---------------------------------------------------------------------------

test("a concurrency-cancelled push suite alongside a green PR suite reports passing", () => {
  const runs = [run("completed", "cancelled"), run("completed", "success")];
  expect(aggregateChecksVerdict(runs, [])).toBe("passing");
});

test("a cancelled run produces no verdict, so a cancelled-only sha is pending (never failing)", () => {
  expect(aggregateChecksVerdict([run("completed", "cancelled")], [])).toBe("pending");
});

// ---------------------------------------------------------------------------
// ENG-340 -- fail-safe polarity. The old FAIL_CONCLUSIONS denylist meant every
// conclusion NOT in the set read as green, so a repo with broken CI reported
// pr-ready. An allowlist inverts that: unknown => not passing.
// ---------------------------------------------------------------------------

test("startup_failure reports failing -- the workflow never ran, that is not green", () => {
  expect(aggregateChecksVerdict([run("completed", "startup_failure")], [])).toBe("failing");
});

test("an unknown/future conclusion fails safe rather than reading as passing", () => {
  expect(aggregateChecksVerdict([run("completed", "some_new_2027_conclusion")], [])).toBe(
    "failing",
  );
});

test("stale does not read as passing -- GitHub says the result is invalid for this sha", () => {
  expect(aggregateChecksVerdict([run("completed", "stale")], [])).not.toBe("passing");
});

test("a stale run is ignored, so a sibling success still reports passing", () => {
  expect(aggregateChecksVerdict([run("completed", "stale"), run("completed", "success")], [])).toBe(
    "passing",
  );
});

test("failure, timed_out and action_required all report failing", () => {
  for (const c of ["failure", "timed_out", "action_required"]) {
    expect(aggregateChecksVerdict([run("completed", c)], [])).toBe("failing");
  }
});

test("success, neutral and skipped all count as passing", () => {
  for (const c of ["success", "neutral", "skipped"]) {
    expect(aggregateChecksVerdict([run("completed", c)], [])).toBe("passing");
  }
});

test("a completed run with a null conclusion fails safe", () => {
  expect(aggregateChecksVerdict([run("completed", null)], [])).toBe("failing");
});

// ---------------------------------------------------------------------------
// Precedence + the empty case.
// ---------------------------------------------------------------------------

test("an unfinished run is pending even alongside a success", () => {
  expect(aggregateChecksVerdict([run("in_progress"), run("completed", "success")], [])).toBe(
    "pending",
  );
});

test("a queued run is pending", () => {
  expect(aggregateChecksVerdict([run("queued"), run("completed", "success")], [])).toBe("pending");
});

test("failing beats pending -- a red check is terminal, do not wait it out", () => {
  expect(aggregateChecksVerdict([run("in_progress"), run("completed", "failure")], [])).toBe(
    "failing",
  );
});

test("nothing reported at all is pending, not passing", () => {
  expect(aggregateChecksVerdict([], [])).toBe("pending");
});

// ---------------------------------------------------------------------------
// Legacy commit-status API (some CIs post statuses, not check-runs).
// ---------------------------------------------------------------------------

test("legacy statuses: success passes, failure and error fail, pending pends", () => {
  expect(aggregateChecksVerdict([], [st("ci", "success")])).toBe("passing");
  expect(aggregateChecksVerdict([], [st("ci", "failure")])).toBe("failing");
  expect(aggregateChecksVerdict([], [st("ci", "error")])).toBe("failing");
  expect(aggregateChecksVerdict([], [st("ci", "pending")])).toBe("pending");
});

test("an unknown legacy state fails safe", () => {
  expect(aggregateChecksVerdict([], [st("ci", "wat")])).toBe("failing");
});

test("legacy statuses collapse to the latest state per context (API returns newest first)", () => {
  // Newest first: ci went red, then was re-run green -> the green wins.
  expect(aggregateChecksVerdict([], [st("ci", "success"), st("ci", "failure")])).toBe("passing");
  // And the converse: newest is the failure.
  expect(aggregateChecksVerdict([], [st("ci", "failure"), st("ci", "success")])).toBe("failing");
});

test("distinct contexts are independent -- one red context fails the sha", () => {
  expect(aggregateChecksVerdict([], [st("ci", "success"), st("lint", "failure")])).toBe("failing");
});

test("check-runs and legacy statuses are aggregated together", () => {
  expect(aggregateChecksVerdict([run("completed", "success")], [st("lint", "pending")])).toBe(
    "pending",
  );
});

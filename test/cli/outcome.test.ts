import { expect, test } from "bun:test";
import { exitCodeForOutcome, outcomeSentence } from "../../src/cli/outcome.ts";

test("sentences match the approved vocabulary", () => {
  expect(outcomeSentence("pr-ready")).toBe(
    "Opened the PR — ready for your review. Waiting on CI + merge approval.",
  );
  expect(outcomeSentence("done")).toBe("Merged and released.");
  expect(outcomeSentence("parked")).toBe("Paused — ran out of budget; resume anytime.");
  expect(outcomeSentence("blocked")).toBe("Stopped — no actionable work remains.");
  expect(outcomeSentence("no-progress")).toBe("Stopped — couldn't make progress.");
  expect(outcomeSentence("escalated")).toBe(
    "Escalated — a human needs to unblock this; re-run once it's resolved.",
  );
});

test("exit codes: success 0, operational stop 1, parked 75", () => {
  expect(exitCodeForOutcome("pr-ready")).toBe(0);
  expect(exitCodeForOutcome("done")).toBe(0);
  expect(exitCodeForOutcome("blocked")).toBe(1);
  expect(exitCodeForOutcome("no-progress")).toBe(1);
  expect(exitCodeForOutcome("parked")).toBe(75);
});

test("exit code: escalated is 75 (resumable), distinct from a dead-end's 1", () => {
  expect(exitCodeForOutcome("escalated")).toBe(75);
  expect(exitCodeForOutcome("escalated")).not.toBe(exitCodeForOutcome("blocked"));
});

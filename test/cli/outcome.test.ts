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
});

test("exit codes: success 0, operational stop 1, parked 75", () => {
  expect(exitCodeForOutcome("pr-ready")).toBe(0);
  expect(exitCodeForOutcome("done")).toBe(0);
  expect(exitCodeForOutcome("blocked")).toBe(1);
  expect(exitCodeForOutcome("no-progress")).toBe(1);
  expect(exitCodeForOutcome("parked")).toBe(75);
});

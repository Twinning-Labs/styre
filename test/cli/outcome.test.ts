import { expect, test } from "bun:test";
import { EXIT } from "../../src/cli/errors.ts";
import { exitCodeForOutcome, outcomeSentence } from "../../src/cli/outcome.ts";

test("exitCodeForOutcome: paused→75, abandoned→1, done/pr-ready→0", () => {
  expect(exitCodeForOutcome("pr-ready")).toBe(EXIT.OK);
  expect(exitCodeForOutcome("done")).toBe(EXIT.OK);
  expect(exitCodeForOutcome("paused")).toBe(EXIT.TEMPFAIL);
  expect(exitCodeForOutcome("abandoned")).toBe(EXIT.OPERATIONAL);
});

test("outcomeSentence reflects the reason for a paused run", () => {
  expect(outcomeSentence("paused", "budget")).toMatch(/budget|resume/i);
  expect(outcomeSentence("paused", "needs_you")).toMatch(/you|resume/i);
  expect(outcomeSentence("abandoned")).toMatch(/rethink|abandon|couldn't/i);
  expect(outcomeSentence("done")).toMatch(/merged|released/i);
});

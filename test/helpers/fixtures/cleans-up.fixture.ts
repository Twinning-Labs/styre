// Run only by test/helpers/temp.test.ts, as a nested `bun test`: the control for the leak guard.
// Every folder it makes goes through the tracked helper, so the run must pass.
import { expect, test } from "bun:test";
import { makeTempDir } from "../temp.ts";

test("makes a tracked folder", () => {
  makeTempDir("styre-tidy-");
  expect(true).toBe(true);
});

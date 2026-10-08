// Run only by test/helpers/temp.test.ts, as a nested `bun test`: the first test fails after making
// a tracked folder, so the run fails, but the folder must be gone before the next test starts.
import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { makeTempDir } from "../temp.ts";

let made = "";

test("fails after making a tracked folder", () => {
  made = makeTempDir("styre-failing-");
  expect("this test").toBe("failing on purpose");
});

test("the failed test's folder is already gone", () => {
  expect(made).not.toBe("");
  expect(existsSync(made)).toBe(false);
});

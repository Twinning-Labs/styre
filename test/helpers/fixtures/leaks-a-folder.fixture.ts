// Run only by test/helpers/temp.test.ts, as a nested `bun test`: it leaves a folder in the temp
// root without removing it, so the preload's leak guard must fail the run. The bare mkdtempSync
// is the point of this file; do not route it through test/helpers/temp.ts.
import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("leaves a folder behind", () => {
  mkdtempSync(join(tmpdir(), "styre-leak-"));
  expect(true).toBe(true);
});

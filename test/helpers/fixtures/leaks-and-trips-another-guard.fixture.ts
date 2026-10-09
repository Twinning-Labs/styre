// Run only by test/helpers/temp.test.ts, as a nested `bun test`: it leaks a temp folder AND writes a
// launch record where the preload's records guard (ENG-485) fails the run. A preload afterAll that
// throws makes Bun skip the ones after it, so the temp guard must still remove the run's temp root.
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("leaks a folder and writes a stray launch record", () => {
  mkdtempSync(join(tmpdir(), "styre-leak-both-"));
  const into = process.env.PROBE_WRITE_INTO;
  if (!into) throw new Error("PROBE_WRITE_INTO is not set");
  mkdirSync(into, { recursive: true });
  writeFileSync(join(into, "4242-1.json"), "{}");
  expect(true).toBe(true);
});

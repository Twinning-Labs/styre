// Run only by test/helpers/temp.test.ts, as a nested `bun test`: it makes a tracked folder that
// cannot be removed (a read-only subfolder holding a file), so the leak guard must still report it
// by name, with the reason, instead of failing on the removal error.
import { expect, test } from "bun:test";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeTempDir } from "../temp.ts";

test("makes a tracked folder that cannot be removed", () => {
  const dir = makeTempDir("styre-stuck-");
  mkdirSync(join(dir, "locked"));
  writeFileSync(join(dir, "locked", "file"), "x");
  chmodSync(join(dir, "locked"), 0o500);
  expect(true).toBe(true);
});

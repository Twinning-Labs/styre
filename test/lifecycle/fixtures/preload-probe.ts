// Run by test/lifecycle/preload-isolation.test.ts as its own `bun test` (not a test of the suite: the
// name does not match *.test.ts). It says which state folder the preload gave it, and, when told,
// writes a launch record named file where a leaking child would.
import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

test("preload probe", () => {
  process.stdout.write(`probe state=${process.env.XDG_STATE_HOME}\n`);
  const into = process.env.PROBE_WRITE_INTO;
  if (into) {
    mkdirSync(into, { recursive: true });
    writeFileSync(join(into, "4242-1.json"), "{}");
  }
  expect(true).toBe(true);
});

// test/db/read-only-guard.test.ts
import { expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/** Operator ruling (2026-10-09, spec §7.7): a database that must not change is read through
 *  readCopyOf (src/db/read-copy.ts), never by opening it read only. These files may, each for the
 *  reason given. The guard is against a read only open coming back by accident: it reads the source
 *  text, so a spelling it does not list (a quoted key, a flag held in a variable, numeric open
 *  flags, `immutable=1`) passes it, and an exception covers its whole file. */
const EXCEPTIONS: Record<string, string> = {
  "test/db/migrate-upgrade.test.ts":
    "the second connection that holds a read snapshot while the backup runs: the scenario under test, on a private copy",
  "test/db/read-only-guard.test.ts": "this guard names the patterns it refuses",
};
const PATTERNS = [/readonly:\s*true/, /[?&]mode=ro\b/, /SQLITE_OPEN_READONLY/];
const ROOT = join(import.meta.dir, "..", "..");

function sourceFiles(top: string): string[] {
  return (readdirSync(join(ROOT, top), { recursive: true }) as string[])
    .filter((f) => f.endsWith(".ts"))
    .map((f) => join(top, f));
}

test("no file in src/ or test/ opens a database read only, except the stated ones", () => {
  const offences: string[] = [];
  for (const file of [...sourceFiles("src"), ...sourceFiles("test")]) {
    if (file in EXCEPTIONS) continue;
    const text = readFileSync(join(ROOT, file), "utf8");
    for (const p of PATTERNS) if (p.test(text)) offences.push(`${file}: ${p.source}`);
  }
  expect(offences).toEqual([]);
});

test("the guard reads both trees, nested folders included", () => {
  // Without this, a guard that stopped reading one tree would still pass the test above.
  const files = [...sourceFiles("src"), ...sourceFiles("test")];
  for (const f of [
    "src/index.ts",
    "src/util/process/door.ts",
    "test/migrate.test.ts",
    "test/db/migrate-upgrade.test.ts",
  ])
    expect([f, files.includes(f)]).toEqual([f, true]);
});

test("every stated exception still needs its exception", () => {
  for (const file of Object.keys(EXCEPTIONS)) {
    const text = readFileSync(join(ROOT, file), "utf8");
    expect([file, PATTERNS.some((p) => p.test(text))]).toEqual([file, true]);
  }
});

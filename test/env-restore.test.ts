import { expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";

// Assigning `undefined` to a process.env key in Bun stores the STRING "undefined", not an unset
// variable. A test that "restores" an env var that way leaks a set value into every later test in
// the same process (and every child process they spawn) — e.g. XDG_*="undefined" makes the path
// helpers compute "undefined/styre", and JIRA_*="undefined" is truthy, so Jira reads as configured.
// Restoring an unset variable must delete the key.
//
// The scan below is a narrow tripwire for the literal `= undefined` form only. It does not catch
// assigning a variable that holds undefined (`process.env.X = prev`); such restores need an
// explicit `if (prev === undefined) delete … else …` check.

test("Bun stores the string 'undefined' when undefined is assigned to process.env", () => {
  const key = "STYRE_ENV_RESTORE_PROBE";
  try {
    process.env[key] = undefined;
    expect(Reflect.get(process.env, key)).toBe("undefined");
  } finally {
    delete process.env[key];
  }
  expect(key in process.env).toBe(false);
});

function tsFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return tsFiles(p);
    return e.name.endsWith(".ts") ? [p] : [];
  });
}

test("no test assigns literal undefined to a process.env key", () => {
  const root = import.meta.dir;
  const assignUndefined = /process\.env(\.\w+|\[[^\]]+\])\s*=\s*undefined\b/;
  const offenders = tsFiles(root)
    .filter((f) => f !== import.meta.path)
    .flatMap((f) =>
      readFileSync(f, "utf8")
        .split("\n")
        .map((line, i) => ({ line, at: `${relative(root, f)}:${i + 1}` }))
        .filter(({ line }) => assignUndefined.test(line))
        .map(({ at, line }) => `${at}: ${line.trim()}`),
    );
  expect(offenders).toEqual([]);
});

import { expect, test } from "bun:test";
import { preexistingFrom } from "../../src/dispatch/baseline-rerun.ts";

test("a baseline FAIL means the failure pre-dates the change", () => {
  expect(preexistingFrom("fail")).toBe(true);
});

test("a baseline PASS means this change introduced it", () => {
  expect(preexistingFrom("pass")).toBe(false);
});

test("an unusable baseline is UNDEFINED, never 'pre-existing'", () => {
  // Fail-closed. Reporting a failure as pre-existing when that was never shown would excuse a
  // real regression — the more dangerous of the two errors, so neither `error` nor `unknown`
  // may collapse into `true`.
  expect(preexistingFrom("error")).toBeUndefined();
  expect(preexistingFrom("unknown")).toBeUndefined();
});

// -- ENG-402: a delivered test must be shown to bind ---------------------------------------

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deliveredTestBindsAtBaseline } from "../../src/dispatch/baseline-rerun.ts";

function git(args: string[], cwd: string) {
  return Bun.spawnSync(["git", ...args], { cwd }).success;
}

/** A repo whose baseline has a buggy `add`, with the fix applied on top. */
function repoWithBaseline(): { repoPath: string; baselineSha: string } {
  const dir = mkdtempSync(join(tmpdir(), "styre-bind-repo-"));
  git(["init", "-q", "."], dir);
  git(["config", "user.email", "t@t"], dir);
  git(["config", "user.name", "t"], dir);
  writeFileSync(join(dir, "add.sh"), "echo 3\n");
  git(["add", "-A"], dir);
  git(["commit", "-qm", "base"], dir);
  const baselineSha = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: dir })
    .stdout.toString()
    .trim();
  return { repoPath: dir, baselineSha };
}

test("a test that FAILS at the baseline binds", async () => {
  const { repoPath, baselineSha } = repoWithBaseline();
  const src = mkdtempSync(join(tmpdir(), "styre-bind-src-"));
  mkdirSync(join(src, "t"), { recursive: true });
  // Exits non-zero at the baseline → it distinguishes the two revisions.
  writeFileSync(join(src, "t", "a.test.sh"), "exit 1\n");
  const verdict = await deliveredTestBindsAtBaseline({
    repoPath,
    baselineSha,
    testFile: "t/a.test.sh",
    sourcePath: join(src, "t", "a.test.sh"),
    command: "sh t/a.test.sh",
    timeoutMs: 20_000,
  });
  expect(verdict).toBe("binds");
});

test("a test that PASSES at the baseline does not bind (the hollow case)", async () => {
  // `expect(true).toBe(true)` is the degenerate form, but an over-mocked or wrongly-scoped test
  // fails identically and reads as fine. This is what styre already proves for its own AC checks
  // via ac-check-red-first, and previously proved for nothing it delivered.
  const { repoPath, baselineSha } = repoWithBaseline();
  const src = mkdtempSync(join(tmpdir(), "styre-bind-src2-"));
  mkdirSync(join(src, "t"), { recursive: true });
  writeFileSync(join(src, "t", "a.test.sh"), "exit 0\n");
  const verdict = await deliveredTestBindsAtBaseline({
    repoPath,
    baselineSha,
    testFile: "t/a.test.sh",
    sourcePath: join(src, "t", "a.test.sh"),
    command: "sh t/a.test.sh",
    timeoutMs: 20_000,
  });
  expect(verdict).toBe("does-not-bind");
});

test("an unusable baseline is unknown, never a verdict either way", async () => {
  const { repoPath } = repoWithBaseline();
  const src = mkdtempSync(join(tmpdir(), "styre-bind-src3-"));
  mkdirSync(join(src, "t"), { recursive: true });
  writeFileSync(join(src, "t", "a.test.sh"), "exit 1\n");
  const verdict = await deliveredTestBindsAtBaseline({
    repoPath,
    baselineSha: "0000000000000000000000000000000000000000",
    testFile: "t/a.test.sh",
    sourcePath: join(src, "t", "a.test.sh"),
    command: "sh t/a.test.sh",
    timeoutMs: 20_000,
  });
  expect(verdict).toBe("unknown");
});

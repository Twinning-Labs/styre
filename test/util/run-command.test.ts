import { expect, test } from "bun:test";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCommand } from "../../src/util/run-command.ts";

// realpathSync resolves macOS /var → /private/var so pwd output matches
const cwd = realpathSync(mkdtempSync(join(tmpdir(), "styre-cmd-")));

test("captures stdout and a zero exit on success", async () => {
  const r = await runCommand("echo hello", { cwd, timeoutMs: 5000 });
  expect(r.exitCode).toBe(0);
  expect(r.timedOut).toBe(false);
  expect(r.stdout.trim()).toBe("hello");
});

test("reports a non-zero exit on failure", async () => {
  const r = await runCommand("exit 3", { cwd, timeoutMs: 5000 });
  expect(r.exitCode).toBe(3);
  expect(r.timedOut).toBe(false);
});

test("kills and flags a command that exceeds the timeout", async () => {
  const r = await runCommand("sleep 5", { cwd, timeoutMs: 200 });
  expect(r.timedOut).toBe(true);
  expect(r.exitCode).not.toBe(0);
});

test("runs the command in the given cwd", async () => {
  const r = await runCommand("pwd", { cwd, timeoutMs: 5000 });
  expect(r.stdout.trim()).toBe(cwd);
});

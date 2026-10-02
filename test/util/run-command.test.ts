import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as door from "../../src/util/process/door.ts";
import { listRecords } from "../../src/util/process/records.ts";
import { runCommand } from "../../src/util/run-command.ts";
import { commandLifecycleTests } from "../helpers/command-lifecycle.ts";

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

test("verify commands cannot read ANTHROPIC_API_KEY", async () => {
  const prev = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = "secret-should-not-leak";
  try {
    const res = await runCommand("printf '%s' \"$ANTHROPIC_API_KEY\"", {
      cwd: process.cwd(),
      timeoutMs: 5000,
    });
    expect(res.stdout).toBe("");
  } finally {
    // biome-ignore lint/performance/noDelete: process.env must be unset via delete; assigning undefined leaves the string "undefined"
    if (prev === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = prev;
  }
});

// Capability isolation (move-4): verify runs agent-authored code, so the daemon's creds must NOT
// be visible to it. runCommand scrubs LINEAR_API_KEY / GITHUB_TOKEN from the spawned env.
test("scrubs the daemon-held creds from the spawned command's env", async () => {
  process.env.GITHUB_TOKEN = "ghp_should_not_leak";
  process.env.LINEAR_API_KEY = "lin_should_not_leak";
  process.env.STYRE_KEEP_ME = "visible";
  try {
    const r = await runCommand('echo "[$GITHUB_TOKEN][$LINEAR_API_KEY][$STYRE_KEEP_ME]"', {
      cwd,
      timeoutMs: 5000,
    });
    expect(r.stdout.trim()).toBe("[][][visible]");
  } finally {
    // biome-ignore lint/performance/noDelete: process.env must be unset via delete; assigning undefined leaves the string "undefined"
    delete process.env.GITHUB_TOKEN;
    // biome-ignore lint/performance/noDelete: process.env must be unset via delete; assigning undefined leaves the string "undefined"
    delete process.env.LINEAR_API_KEY;
    // biome-ignore lint/performance/noDelete: process.env must be unset via delete; assigning undefined leaves the string "undefined"
    delete process.env.STYRE_KEEP_ME;
  }
});

commandLifecycleTests("runCommand", runCommand);

describe("runCommand context", () => {
  const saved = process.env.XDG_STATE_HOME;
  let state: string;
  beforeEach(() => {
    state = mkdtempSync(join(tmpdir(), "styre-cmdctx-state-"));
    process.env.XDG_STATE_HOME = state;
    door.__resetForTests();
  });
  afterEach(() => {
    door.__resetForTests();
    rmSync(state, { recursive: true, force: true });
    if (saved === undefined) Reflect.deleteProperty(process.env, "XDG_STATE_HOME");
    else process.env.XDG_STATE_HOME = saved;
  });

  test("the caller's context is written to the launch record", async () => {
    const p = runCommand("sleep 1", {
      cwd,
      timeoutMs: 5000,
      context: { ident: "ENG-9", stepId: 3, worktree: cwd },
    });
    const end = Date.now() + 3000;
    while (listRecords().length === 0 && Date.now() < end) await Bun.sleep(20);
    const rec = listRecords()[0]?.record;
    expect(rec?.ident).toBe("ENG-9");
    expect(rec?.stepId).toBe(3);
    expect(rec?.kind).toBe("group");
    await p;
  });
});

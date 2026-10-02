import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runBoundedCommand } from "../../src/util/run-bounded-command.ts";
import { commandLifecycleTests } from "../helpers/command-lifecycle.ts";

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;

async function withDirectory(run: (cwd: string) => Promise<void>): Promise<void> {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "styre-bounded-command-")));
  try {
    await run(cwd);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

test("preserves command output and nonzero exit status", async () => {
  await withDirectory(async (cwd) => {
    const result = await runBoundedCommand("printf output; printf diagnostic >&2; exit 7", {
      cwd,
      timeoutMs: 5000,
    });
    expect(result).toEqual({
      exitCode: 7,
      timedOut: false,
      stdout: "output",
      stderr: "diagnostic",
      truncated: false,
    });
  });
});

test("timeout kills descendants and bounds inherited pipes while the shell waits", async () => {
  await withDirectory(async (cwd) => {
    const start = performance.now();
    // A child inherits the pipe. Killing only the shell would leave this child able to modify the
    // reviewed worktree.
    const result = await runBoundedCommand(
      "printf ready; (sleep 0.8; printf survived > descendant-survived) & wait",
      { cwd, timeoutMs: 200 },
    );
    const elapsed = performance.now() - start;
    expect(result.timedOut).toBe(true);
    expect(result.exitCode).toBeNull();
    expect(result.stdout).toBe("ready");
    expect(elapsed).toBeLessThan(750);
    // Check the externally visible consequence, not just whether SIGKILL was invoked.
    await delay(950);
    expect(existsSync(join(cwd, "descendant-survived"))).toBe(false);
  });
});

test("a shell that exits while its child still runs is a completed command, and the child is stopped", async () => {
  await withDirectory(async (cwd) => {
    const start = performance.now();
    // Before ENG-485 this was a timeout, because the child held the output pipe open. The shell
    // finished on its own, so the command is complete; what it left behind is stopped.
    const result = await runBoundedCommand(
      "printf ready; (sleep 0.8; printf survived > descendant-survived) & exit 0",
      { cwd, timeoutMs: 5000 },
    );
    expect(result.timedOut).toBe(false);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("ready");
    expect(performance.now() - start).toBeLessThan(2500);
    await delay(950);
    expect(existsSync(join(cwd, "descendant-survived"))).toBe(false);
  });
});

test("caps both output streams while draining them to completion", async () => {
  await withDirectory(async (cwd) => {
    writeFileSync(
      join(cwd, "large-output.js"),
      'process.stdout.write("START" + "o".repeat(131072) + "END"); process.stderr.write("FIRST" + "e".repeat(131072) + "LAST");',
    );
    const result = await runBoundedCommand(`${quote(process.execPath)} large-output.js`, {
      cwd,
      timeoutMs: 5000,
    });
    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
    expect(result.truncated).toBe(true);
    expect(result.stdout.length).toBe(65536);
    expect(result.stderr.length).toBe(65536);
    expect(result.stdout.startsWith("START")).toBe(true);
    expect(result.stdout.endsWith("END")).toBe(true);
    expect(result.stderr.startsWith("FIRST")).toBe(true);
    expect(result.stderr.endsWith("LAST")).toBe(true);
  });
});

commandLifecycleTests("runBoundedCommand", runBoundedCommand);

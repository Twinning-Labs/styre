import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { realRecoverDeps, recover } from "../../src/daemon/recover.ts";
import { getById, insertPending, markRunning } from "../../src/db/repos/workflow-step.ts";
import { runBoundedCommand } from "../../src/util/run-bounded-command.ts";
import { makeTestDb } from "../helpers/db.ts";

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

test.each(["wait", "exit 0"])(
  "timeout kills descendants and bounds inherited pipes when the shell uses %s",
  async (ending) => {
    await withDirectory(async (cwd) => {
      const start = performance.now();
      // A child inherits the pipe even if the shell exits. Killing only the shell would
      // return eventually but leave this child able to modify the reviewed worktree.
      const result = await runBoundedCommand(
        `printf ready; (sleep 0.8; printf survived > descendant-survived) & ${ending}`,
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
  },
);

test("caps both output streams while draining them to completion", async () => {
  await withDirectory(async (cwd) => {
    writeFileSync(
      join(cwd, "large-output.js"),
      'process.stdout.write("o".repeat(131072)); process.stderr.write("e".repeat(131072));',
    );
    const result = await runBoundedCommand(`${quote(process.execPath)} large-output.js`, {
      cwd,
      timeoutMs: 5000,
    });
    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
    expect(result.truncated).toBe(true);
    expect(result.stdout).toBe("o".repeat(65536));
    expect(result.stderr).toBe("e".repeat(65536));
  });
});

test("PID journal failure aborts the child before returning an error result", async () => {
  await withDirectory(async (cwd) => {
    let journalCalled = false;
    const result = await runBoundedCommand("sleep 0.3; printf survived > journal-survived", {
      cwd,
      timeoutMs: 5000,
      onSpawn: (pid) => {
        expect(pid).toBeGreaterThan(0);
        journalCalled = true;
        throw new Error("synthetic journal failure");
      },
    });
    expect(journalCalled).toBe(true);
    expect(result.exitCode).toBeNull();
    expect(result.timedOut).toBe(false);
    expect(result.stderr).toContain("PID journaling failed: Error: synthetic journal failure");
    await delay(450);
    expect(existsSync(join(cwd, "journal-survived"))).toBe(false);
  });
});

test("recovery kills a journaled process group after its shell leader has exited", async () => {
  await withDirectory(async (cwd) => {
    const { db, ticketId } = makeTestDb();
    const proc = spawn("sh", ["-c", "(sleep 0.8; printf survived > recovery-survived) & exit 0"], {
      cwd,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const pid = proc.pid;
    try {
      if (!pid) throw new Error("synthetic detached process did not spawn");
      const step = insertPending(db, { ticketId, stepKey: "review", stepType: "dispatch" });
      markRunning(db, step.id, { pid: -pid });
      // Wait for exit rather than close: the descendant deliberately still owns the pipes.
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("shell leader did not exit")), 2000);
        proc.once("exit", () => {
          clearTimeout(timer);
          resolve();
        });
        proc.once("error", (error) => {
          clearTimeout(timer);
          reject(error);
        });
      });
      const deps = realRecoverDeps();
      expect(deps.isAlive(pid)).toBe(false);
      expect(deps.isAlive(-pid)).toBe(true);
      expect(recover(db, deps)).toEqual({ reset: 1, killed: 1 });
      expect(getById(db, step.id)?.status).toBe("pending");
      await delay(950);
      expect(existsSync(join(cwd, "recovery-survived"))).toBe(false);
    } finally {
      if (pid) {
        try {
          process.kill(-pid, "SIGKILL");
        } catch {
          // Recovery already removed this process group.
        }
      }
      proc.stdout.destroy();
      proc.stderr.destroy();
      proc.unref();
      db.close();
    }
  });
});

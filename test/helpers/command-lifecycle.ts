import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as door from "../../src/util/process/door.ts";
import { listProcesses } from "../../src/util/process/proc-table.ts";
import { listRecords } from "../../src/util/process/records.ts";
import type { StopDeps } from "../../src/util/process/stop.ts";
import type { CommandResult } from "../../src/util/run-command.ts";

type Run = (command: string, opts: { cwd: string; timeoutMs: number }) => Promise<CommandResult>;

const alive = (pid: number): boolean =>
  listProcesses().some((p) => p.pid === pid && p.state !== "zombie");

async function waitFor(pred: () => boolean, ms = 3_000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (pred()) return true;
    await Bun.sleep(20);
  }
  return pred();
}

/**
 * The process handling contract shared by runCommand and runBoundedCommand (ENG-485 section 6.2).
 * Every test uses its own temp folder for pid files and records, and kills what it started.
 * `spawnFailure` is each runner's own contract for a command that cannot be launched at all, kept
 * from before ENG-485: runCommand throws (final review A F10), runBoundedCommand returns a result.
 */
export function commandLifecycleTests(
  name: string,
  run: Run,
  spawnFailure: "throws" | "result",
): void {
  describe(`${name} process handling`, () => {
    let dir: string;
    let state: string;
    const saved = process.env.XDG_STATE_HOME;
    const pidFile = (): string => join(dir, "pid");
    const readPid = (): number => Number(readFileSync(pidFile(), "utf8").trim());
    const spawned = new Set<number>();
    const remember = (): number => {
      const pid = readPid();
      spawned.add(pid);
      return pid;
    };

    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), "styre-cmdlife-"));
      state = mkdtempSync(join(tmpdir(), "styre-cmdlife-state-"));
      process.env.XDG_STATE_HOME = state;
      door.__resetForTests();
    });
    afterEach(async () => {
      door.__setStopDepsForTests(undefined);
      for (const h of door.liveLaunches()) {
        try {
          await h.stop("forced");
        } catch {
          /* best effort */
        }
      }
      for (const pid of spawned) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          /* gone */
        }
      }
      spawned.clear();
      door.__resetForTests();
      rmSync(dir, { recursive: true, force: true });
      rmSync(state, { recursive: true, force: true });
      if (saved === undefined) Reflect.deleteProperty(process.env, "XDG_STATE_HOME");
      else process.env.XDG_STATE_HOME = saved;
    });

    test("a background child holding the pipe no longer hangs the command (N6)", async () => {
      const t0 = performance.now();
      const r = await run(`sleep 6 & echo $! > "${pidFile()}"; echo hi`, {
        cwd: dir,
        timeoutMs: 2000,
      });
      const elapsed = performance.now() - t0;
      remember();
      // Today the call waits the child's full 6 s. The leftover must be stopped first.
      expect(elapsed).toBeLessThan(3000);
      expect(r.timedOut).toBe(false);
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain("hi");
    });

    test("a leftover in the command's group is stopped after a normal exit", async () => {
      await run(`sleep 30 & echo $! > "${pidFile()}"; exit 0`, { cwd: dir, timeoutMs: 5000 });
      const pid = remember();
      expect(alive(pid)).toBe(false);
    });

    test("a timeout stops the whole group, not just sh", async () => {
      const r = await run(`sleep 30 & echo $! > "${pidFile()}"; sleep 30`, {
        cwd: dir,
        timeoutMs: 400,
      });
      const pid = remember();
      expect(r.timedOut).toBe(true);
      expect(await waitFor(() => !alive(pid))).toBe(true);
    });

    test("a command stopped by the handler throws RunInterrupted", async () => {
      const p = run("sleep 30", { cwd: dir, timeoutMs: 60_000 });
      const settled = p.then(
        () => "resolved",
        (e) => e,
      );
      expect(await waitFor(() => door.liveLaunches().length === 1)).toBe(true);
      door.beginStopping();
      for (const h of door.liveLaunches()) {
        h.interrupted = true;
        await h.stop("graceful");
      }
      expect(await settled).toBeInstanceOf(door.RunInterrupted);
    });

    test("a command that was stopped after it exited on its own still throws RunInterrupted", async () => {
      // The handler marks the launch interrupted and the shell is already gone: still an interruption.
      const p = run("exit 0; sleep 30", { cwd: dir, timeoutMs: 60_000 });
      for (const h of door.liveLaunches()) h.interrupted = true;
      await expect(p).rejects.toBeInstanceOf(door.RunInterrupted);
    });

    test("a launch while a stop is under way is refused with RunInterrupted", async () => {
      door.beginStopping();
      await expect(run("echo hi", { cwd: dir, timeoutMs: 1000 })).rejects.toBeInstanceOf(
        door.RunInterrupted,
      );
      expect(door.liveLaunches()).toEqual([]);
    });

    test("the command is a group leader of its own and is recorded while it runs", async () => {
      const p = run(`echo $$ > "${pidFile()}"; ps -o pgid= -p $$ >> "${pidFile()}"; sleep 30`, {
        cwd: dir,
        timeoutMs: 1500,
      });
      expect(await waitFor(() => listRecords().length === 1)).toBe(true);
      const rec = listRecords()[0]?.record;
      expect(rec?.kind).toBe("group");
      expect(rec?.worktree).toBe(dir);
      expect(rec?.ident).toBeNull();
      await waitFor(() => {
        try {
          return readFileSync(pidFile(), "utf8").includes("\n");
        } catch {
          return false;
        }
      });
      const [pid, pgid] = readFileSync(pidFile(), "utf8").trim().split("\n").map(Number);
      expect(pgid).toBe(pid); // the shell leads its own group
      expect(pid).toBe(rec?.pid as number);
      await p;
      expect(listRecords()).toEqual([]); // released once nothing survives
    });

    test("a daemonized holder of the pipe cannot hang the caller: output is read for at most 5 s", async () => {
      if (!Bun.which("perl")) return;
      // perl leaves the group (setsid), so no stop reaches it; it keeps the pipe open for 12 s.
      const t0 = performance.now();
      const r = await run(
        // The shell waits until perl has left the group, or the stop would still reach it.
        `perl -MPOSIX -e 'POSIX::setsid(); open(F, ">ready"); close(F); sleep 12' & echo $! > "${pidFile()}"; until [ -e ready ]; do sleep 0.05; done; echo hi`,
        { cwd: dir, timeoutMs: 3000 },
      );
      const elapsed = performance.now() - t0;
      remember();
      expect(elapsed).toBeLessThan(8_000);
      expect(elapsed).toBeGreaterThan(4_000); // it did wait for the limit
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain("hi");
      expect(r.stderr).toContain("output read limit reached");
    }, 20_000);

    const deaf = (): StopDeps => {
      let t = 0;
      return {
        list: listProcesses,
        kill: () => {},
        sleep: async () => {},
        now: () => {
          t += 250;
          return t;
        },
      };
    };

    test("survivors after the stop are named in stderr, never a clean result", async () => {
      door.__setStopDepsForTests(deaf());
      const r = await run(`sleep 30 >/dev/null 2>&1 & echo $! > "${pidFile()}"; exit 0`, {
        cwd: dir,
        timeoutMs: 5000,
      });
      const pid = remember();
      expect(alive(pid)).toBe(true);
      expect(r.stderr).toContain(String(pid));
      expect(r.timedOut).toBe(false);
    });

    test("survivors after a timeout stop are named in stderr", async () => {
      door.__setStopDepsForTests(deaf());
      const r = await run(
        // Close the shell's own output first, so only the stop (made deaf here) could end the read.
        `exec >/dev/null 2>&1; sleep 30 & echo $! > "${pidFile()}"; sleep 30`,
        {
          cwd: dir,
          timeoutMs: 400,
        },
      );
      const pid = remember();
      expect(r.timedOut).toBe(true);
      expect(r.stderr).toContain(String(pid));
    });

    test("a stop that arrives while leftovers are being stopped still throws RunInterrupted", async () => {
      // The leftover ignores TERM, so finish() waits out its grace period. The handler stops the
      // launch during that wait: the runner must not report a result after that.
      const p = run(`(trap '' TERM; sleep 30) & echo $! > "${pidFile()}"; exit 0`, {
        cwd: dir,
        timeoutMs: 60_000,
      });
      const settled = p.then(
        () => "resolved",
        (e) => e,
      );
      expect(
        await waitFor(
          () => existsSync(pidFile()) && readFileSync(pidFile(), "utf8").includes("\n"),
        ),
      ).toBe(true);
      remember();
      await Bun.sleep(400); // the shell has exited and finish() is in its grace wait
      for (const h of door.liveLaunches()) {
        h.interrupted = true;
        await h.stop("forced");
      }
      expect(await settled).toBeInstanceOf(door.RunInterrupted);
    }, 15_000);

    test("a timeout stop is graceful: a TERM trap in the command runs", async () => {
      const marker = join(dir, "term-seen");
      const r = await run(`trap 'echo term > "${marker}"; exit 0' TERM; sleep 30 & wait`, {
        cwd: dir,
        timeoutMs: 700,
      });
      expect(r.timedOut).toBe(true);
      expect(existsSync(marker)).toBe(true);
    });

    test("the command runs without the daemon's credentials", async () => {
      const keys = ["GITHUB_TOKEN", "LINEAR_API_KEY", "ANTHROPIC_API_KEY"] as const;
      const before = keys.map((k) => process.env[k]);
      for (const k of keys) process.env[k] = `secret-${k}`;
      try {
        const r = await run(
          'printf "[%s][%s][%s]" "$GITHUB_TOKEN" "$LINEAR_API_KEY" "$ANTHROPIC_API_KEY"',
          {
            cwd: dir,
            timeoutMs: 5000,
          },
        );
        expect(r.stdout).toBe("[][][]");
      } finally {
        keys.forEach((k, i) => {
          const v = before[i];
          if (v === undefined) Reflect.deleteProperty(process.env, k);
          else process.env[k] = v;
        });
      }
    });

    test("survivors are also reported on Styre's stderr, in the spec's words", async () => {
      door.__setStopDepsForTests(deaf());
      const lines: string[] = [];
      const realWrite = process.stderr.write.bind(process.stderr);
      process.stderr.write = ((chunk: string | Uint8Array) => {
        lines.push(String(chunk));
        return true;
      }) as typeof process.stderr.write;
      let pid: number;
      try {
        await run(`sleep 30 >/dev/null 2>&1 & echo $! > "${pidFile()}"; exit 0`, {
          cwd: dir,
          timeoutMs: 5000,
        });
        pid = remember();
      } finally {
        process.stderr.write = realWrite;
      }
      const text = lines.join("");
      expect(text).toContain("styre: could not stop ");
      expect(text).toContain(`(pid ${pid}); stop it with: kill -9 ${pid}`);
    });

    test("a command killed by a signal reports no exit code of its own where the runner did before", async () => {
      const r = await run("echo before; kill -TERM $$", { cwd: dir, timeoutMs: 5000 });
      expect(r.stdout.trim()).toBe("before");
      expect(r.timedOut).toBe(false);
      expect(r.exitCode === null || r.exitCode === 143).toBe(true);
    });

    test.if(spawnFailure === "result")("a spawn failure is a result, not a throw", async () => {
      const r = await run("echo hi", { cwd: join(dir, "does-not-exist"), timeoutMs: 1000 });
      expect(r.exitCode).toBeNull();
      expect(r.timedOut).toBe(false);
      expect(r.stderr.length).toBeGreaterThan(0);
    });

    test.if(spawnFailure === "throws")(
      "a spawn failure throws, never returns as a command that ran",
      async () => {
        await expect(
          run("echo hi", { cwd: join(dir, "does-not-exist"), timeoutMs: 1000 }),
        ).rejects.toThrow();
      },
    );
  });
}

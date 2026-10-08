// ENG-485 Task 15: the stop handling in a real terminal. Each test runs Styre's stop handling (the
// driver fixture, or the compiled `styre` itself) under a real pseudo terminal (test/lifecycle/pty.ts)
// and does what a person does: Ctrl-C, Ctrl-\, `kill -TERM`, closing the terminal, Ctrl-C twice.
// The exit is read the way a shell reads it (the shell fixture reports the signal that ended the
// command), and the processes are checked by pid and start time.
//
// Cleanup touches only the test's own processes (test/helpers/own-processes.ts): script is claimed
// as it starts, everything under it by descent while it is still connected (the Ctrl-\ tool is
// claimed before the keystroke that orphans it), and `killOwned` ends whatever is left.
import { Database } from "bun:sqlite";
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProcInfo } from "../../src/util/process/proc-table.ts";
import { makeTicketDb } from "../helpers/lifecycle.ts";
import {
  allGone,
  commandOf,
  isAlive,
  killOwned,
  ownTree,
  signalOwned,
  until,
} from "../helpers/own-processes.ts";
import { CTRL_BACKSLASH, CTRL_C, type Pty, shellStatus, underPty } from "./pty.ts";

const ROOT = join(import.meta.dir, "../..");
const FX = join(import.meta.dir, "fixtures");
const DRIVER = join(FX, "drive-run.ts");
const OPENING_INT =
  "styre: stopping — cleaning up the agent and its commands before exiting (up to 5s; press Ctrl-C again to force)…\n";
const opening = (sig: string): string => `styre: received a stop request (${sig}) — cleaning up…\n`;
const FORCING = "styre: forcing stop…\n";
const SLOW = 30_000;

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "styre-terminal-")));
const ptys: Pty[] = [];
afterEach(() => {
  killOwned();
  for (const p of ptys.splice(0)) p.dispose();
});
afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

/** A sleep length no other test here uses, so a line naming `sleep <n>` names this test's tool. */
let nextSleep = 3_510;
const sleepLength = (): string => String(nextSleep++);

/** Wait (bounded) for the terminal to show `text`; on failure, the message holds what it showed. */
async function expectShown(pty: Pty, text: string, ms = 3_000): Promise<void> {
  const ok = await pty.waitFor(text, ms);
  expect(ok, `the terminal never showed ${JSON.stringify(text)}; it showed:\n${pty.output()}`).toBe(
    true,
  );
}

/** The pid in the first `<word> <pid>` line the terminal showed. */
function said(pty: Pty, word: string): number {
  const m = new RegExp(`${word} (\\d+)\\n`).exec(pty.output());
  return m ? Number(m[1]) : Number.NaN;
}

interface Driven {
  pty: Pty;
  driver: ProcInfo;
  /** Everything under script when the driver said "ready", claimed. */
  tree: ProcInfo[];
  find: (pid: number) => ProcInfo;
  sleep: string;
  worktree: string;
}

/** The driver in a new terminal, once it has said "ready": everything it started is claimed. */
async function driven(mode: string, env: Record<string, string> = {}): Promise<Driven> {
  const worktree = realpathSync(mkdtempSync(join(scratch, "wt-")));
  const sleep = sleepLength();
  const pty = underPty([process.execPath, DRIVER, mode], {
    env: { ...process.env, DRIVE_WORKTREE: worktree, STANDIN_SLEEP: sleep, ...env },
  });
  ptys.push(pty);
  const driver = await pty.command();
  await expectShown(pty, "ready\n", 10_000);
  const tree = ownTree(pty.script);
  const find = (pid: number): ProcInfo => {
    const p = tree.find((q) => q.pid === pid);
    if (p === undefined) throw new Error(`pid ${pid} is not in the terminal's tree`);
    return p;
  };
  return { pty, driver, tree, find, sleep, worktree };
}

/** The status a shell shows for each stop signal (global constraints: by re-raising the signal). */
const STATUS = { SIGHUP: 129, SIGINT: 130, SIGQUIT: 131, SIGTERM: 143 } as const;

/** The command ended BY `signal` (not an exit with its number), which a shell shows as 128 + n. */
async function endedBy(pty: Pty, signal: keyof typeof STATUS, ms = 10_000): Promise<void> {
  const end = await pty.ended(ms);
  expect(end).toEqual({ code: null, signal });
  if (end) expect(shellStatus(end)).toBe(STATUS[signal]);
}

describe("the driver in a terminal", () => {
  test(
    "Ctrl-C: the stopping line, the agent and its tool gone within 5 s, and the exit is SIGINT (130)",
    async () => {
      const d = await driven("agent");
      const agent = d.find(said(d.pty, "agent"));
      const tool = d.find(said(d.pty, "tool"));
      const t0 = Date.now();
      d.pty.type(CTRL_C);
      await endedBy(d.pty, "SIGINT");
      expect(await allGone([agent, tool], Math.max(0, 5_000 - (Date.now() - t0)))).toBe(true);
      expect(Date.now() - t0).toBeLessThan(5_000);
      await expectShown(d.pty, OPENING_INT);
      await expectShown(d.pty, `styre: stopped the agent (pid ${agent.pid}) and `);
    },
    SLOW,
  );

  test(
    "Ctrl-\\: the agent dies at once and its orphaned tool is reported with the exact line, not stopped (D13); the exit is SIGQUIT (131)",
    async () => {
      const d = await driven("agent");
      const agent = d.find(said(d.pty, "agent"));
      // Claimed above, while still a descendant: once the agent dies it is no one's child.
      const tool = d.find(said(d.pty, "tool"));
      d.pty.type(CTRL_BACKSLASH);
      await endedBy(d.pty, "SIGQUIT");
      await expectShown(d.pty, opening("SIGQUIT"));
      await expectShown(
        d.pty,
        `styre: the agent left "sleep ${d.sleep}" (pid ${tool.pid}) running in the worktree; stop it with: kill ${tool.pid} (if it is not yours)\n`,
      );
      expect(isAlive(agent)).toBe(false);
      expect(isAlive(tool)).toBe(true); // reported, not stopped
      expect(killOwned()).toBeGreaterThan(0);
      expect(await allGone([tool])).toBe(true);
    },
    SLOW,
  );

  test(
    "kill -TERM of the driver: the stop request line, the agent and its tool gone, and the exit is SIGTERM (143)",
    async () => {
      const d = await driven("agent");
      const agent = d.find(said(d.pty, "agent"));
      const tool = d.find(said(d.pty, "tool"));
      expect(signalOwned(d.driver, "SIGTERM")).toBe(true);
      await endedBy(d.pty, "SIGTERM");
      await expectShown(d.pty, opening("SIGTERM"));
      expect(await allGone([agent, tool])).toBe(true);
    },
    SLOW,
  );

  test(
    "closing the terminal while a suite group runs: the group is gone and the exit is SIGHUP (129)",
    async () => {
      const d = await driven("group");
      const leader = d.find(said(d.pty, "group"));
      // The group's two sleeps, claimed by descent as soon as the leader has started them.
      let members: ProcInfo[] = [];
      expect(
        await until(() => {
          members = ownTree(leader);
          return members.length >= 3;
        }),
      ).toBe(true);
      expect(members.every((p) => p.pgid === leader.pid)).toBe(true);
      const t0 = Date.now();
      await d.pty.close();
      await endedBy(d.pty, "SIGHUP");
      expect(await allGone(members, Math.max(0, 5_000 - (Date.now() - t0)))).toBe(true);
    },
    SLOW,
  );

  test(
    "a second Ctrl-C within 1 s: the forcing line, the stubborn agent killed at once, and the exit is still SIGINT (130)",
    async () => {
      const d = await driven("stubborn");
      const agent = d.find(said(d.pty, "agent"));
      const tool = d.find(said(d.pty, "tool"));
      const t0 = Date.now();
      d.pty.type(CTRL_C);
      await expectShown(d.pty, OPENING_INT, 1_000);
      d.pty.type(CTRL_C);
      expect(Date.now() - t0).toBeLessThan(1_000);
      await endedBy(d.pty, "SIGINT");
      // Well inside the 5 s grace period, which only a forced stop cuts short for an agent that
      // ignores SIGTERM.
      expect(Date.now() - t0).toBeLessThan(3_000);
      await expectShown(d.pty, FORCING);
      expect(d.pty.output().split(FORCING).length - 1).toBe(1);
      expect(await allGone([agent, tool], 1_000)).toBe(true);
    },
    SLOW,
  );

  test(
    "the terminal really closes: the handler's writes to it fail, and still the exit is SIGHUP, the processes are stopped and the run is recorded",
    async () => {
      const t = makeTicketDb();
      const errors = join(scratch, `stderr-errors-${Date.now()}`);
      const d = await driven("agent", {
        DRIVE_DB: t.path,
        DRIVE_TICKET: String(t.ticketId),
        DRIVE_STEP: String(t.stepId),
        DRIVE_STARTED: t.startedAt,
        DRIVE_SLOW: "1",
        DRIVE_ERRORS: errors,
      });
      const agent = d.find(said(d.pty, "agent"));
      const tool = d.find(said(d.pty, "tool"));
      await d.pty.close();
      await endedBy(d.pty, "SIGHUP");
      // The stop line went to a terminal that no longer exists: the write failed (EIO), and the
      // stream's error listener kept that from ending the stop.
      expect(existsSync(errors) ? readFileSync(errors, "utf8") : "").toContain("EIO");
      expect(await allGone([agent, tool])).toBe(true);
      expect(interruptions(t.path)).toBe(1);
    },
    SLOW,
  );
});

/** How many interruption notes the run database holds. */
function interruptions(path: string): number {
  const c = new Database(path, { readonly: true });
  try {
    return (
      c
        .query<{ n: number }, []>(
          "SELECT COUNT(*) AS n FROM event_log WHERE kind = 'note' AND reason = 'interrupted'",
        )
        .get()?.n ?? -1
    );
  } finally {
    c.close();
  }
}

// ---- the compiled styre --------------------------------------------------------------------------

let built: string | null = null;
/** A fresh build of styre for this run (never a dist/styre left from an older checkout). */
function binary(): string {
  if (built !== null) return built;
  const out = join(scratch, "styre");
  const r = Bun.spawnSync(["sh", join(ROOT, "scripts", "build.sh")], {
    cwd: ROOT,
    env: { ...process.env, OUTFILE: out },
    stdout: "pipe",
    stderr: "pipe",
    timeout: 120_000,
  });
  if (r.exitCode !== 0) throw new Error(`the build failed: ${r.stderr.toString()}`);
  built = out;
  return out;
}

/** A folder for one `styre` command: its own config and state folders, a runtime config naming the
 *  fake agent CLI, and the environment it runs with. */
function styreHome(extraEnv: Record<string, string> = {}) {
  const home = realpathSync(mkdtempSync(join(scratch, "home-")));
  const config = join(home, "config.json");
  writeFileSync(
    config,
    JSON.stringify({
      telemetry: false,
      agent: {
        provider: "claude",
        command: join(FX, "fake-claude.sh"),
        models: { deep: "d", standard: "s", cheap: "c" },
      },
    }),
  );
  const env: Record<string, string | undefined> = {
    ...process.env,
    XDG_CONFIG_HOME: join(home, "config"),
    XDG_STATE_HOME: join(home, "state"),
    DO_NOT_TRACK: "1",
    // Test values for the fake CLI and the adapters' presence checks; nothing here reaches a
    // network (the forge's requests go to a local proxy that never answers).
    ANTHROPIC_API_KEY: "test-key-not-real",
    ...extraEnv,
  };
  return { home, config, env };
}

/** A git repository whose setup asks for missing commands and then for approval (Ruby). */
function rubyRepo(home: string): string {
  const repo = join(home, "repo");
  Bun.spawnSync(["mkdir", "-p", repo]);
  const git = (a: string[]) => Bun.spawnSync(["git", ...a], { cwd: repo });
  git(["init", "-b", "main"]);
  git(["remote", "add", "origin", "git@github.com:acme/myapp.git"]);
  writeFileSync(join(repo, "Gemfile"), "source 'https://rubygems.org'\ngem 'rspec'\n");
  writeFileSync(join(repo, ".rspec"), "--format documentation\n");
  return repo;
}

describe("styre in a terminal", () => {
  test(
    "styre setup: Ctrl-C at its approval prompt ends it at once by SIGINT (130), and no profile is written (finding 3)",
    async () => {
      const bin = binary();
      const h = styreHome();
      const repo = rubyRepo(h.home);
      const out = join(h.home, "profile.json");
      const pty = underPty([bin, "setup", repo, "--config", h.config, "--out", out], {
        env: h.env,
      });
      ptys.push(pty);
      await pty.command();
      // Setup first asks for each missing command: Enter leaves it blank. Then it asks for approval.
      let answered = 0;
      const reached = await until(() => {
        if (pty.output().includes("Approve these components")) return true;
        const asked = (pty.output().match(/leave blank for none: /g) ?? []).length;
        if (asked > answered) {
          pty.type("\n");
          answered = asked;
        }
        return false;
      }, 20_000);
      expect(reached, `setup never asked for approval; it showed:\n${pty.output()}`).toBe(true);
      expect(answered).toBeGreaterThan(0); // the prompts before it really ran
      const t0 = Date.now();
      pty.type(CTRL_C);
      await endedBy(pty, "SIGINT", 1_500);
      expect(Date.now() - t0).toBeLessThan(1_500);
      expect(existsSync(out)).toBe(false);
      expect(existsSync(`${out}.environment.json`)).toBe(false);
    },
    SLOW,
  );

  // The Bun #30189 guard (spec 7.6): handlers never run while stdin has a flowing data listener. Each
  // command that installs handlers is signalled for real while it waits, in a terminal, so a future
  // reader of stdin (or a handler not installed) shows here as a command that does not say its stop
  // line or does not end by the signal.
  test(
    "Bun #30189 guard: styre setup's handler fires on SIGTERM while its agent runs, and stops the agent",
    async () => {
      const bin = binary();
      const sleep = sleepLength();
      const h = styreHome({ STYRE_FAKE_AGENT: "hang", STANDIN_SLEEP: sleep });
      const repo = rubyRepo(h.home);
      const out = join(h.home, "profile.json");
      const pty = underPty([bin, "setup", repo, "--config", h.config, "--out", out], {
        env: h.env,
      });
      ptys.push(pty);
      const styre = await pty.command();
      // The enrichment agent (the stand-in) is running once its tool, a group of its own, exists.
      let tree: ProcInfo[] = [];
      let tool: ProcInfo | undefined;
      const running = await until(() => {
        tree = ownTree(styre);
        tool = tree.find(
          (p) => p.pid !== styre.pid && p.pgid === p.pid && commandOf(p) === `sleep ${sleep}`,
        );
        return tool !== undefined;
      }, 15_000);
      expect(running, `the agent's tool never started; setup showed:\n${pty.output()}`).toBe(true);
      expect(signalOwned(styre, "SIGTERM")).toBe(true);
      await endedBy(pty, "SIGTERM");
      await expectShown(pty, opening("SIGTERM"));
      expect(await allGone(tree.filter((p) => p.pid !== styre.pid))).toBe(true);
      expect(existsSync(out)).toBe(false);
    },
    SLOW,
  );

  test(
    "Bun #30189 guard: styre run's handler fires on SIGTERM while it waits on the forge",
    async () => {
      const bin = binary();
      // A proxy that takes the forge's connection and never answers: the run waits there, and
      // nothing leaves the machine.
      let asked = "";
      const proxy = Bun.listen({
        hostname: "127.0.0.1",
        port: 0,
        socket: {
          data(_s, d) {
            asked += new TextDecoder().decode(d);
          },
        },
      });
      try {
        const h = styreHome({
          GITHUB_TOKEN: "test-token-not-real",
          LINEAR_API_KEY: "test-key-not-real",
          HTTPS_PROXY: `http://127.0.0.1:${proxy.port}`,
          https_proxy: `http://127.0.0.1:${proxy.port}`,
          NO_PROXY: "",
          no_proxy: "",
        });
        const repo = rubyRepo(h.home);
        const profile = join(h.home, "profile.json");
        writeFileSync(
          profile,
          JSON.stringify({
            slug: "terminal-test",
            targetRepo: repo,
            defaultBranch: "main",
            checksSystem: "none",
            components: [],
          }),
        );
        const pty = underPty([bin, "run", "ENG-1", "--profile", profile, "--config", h.config], {
          env: h.env,
        });
        ptys.push(pty);
        const styre = await pty.command();
        const waiting = await until(() => asked.includes("CONNECT api.github.com:443"), 15_000);
        expect(waiting, `the run never asked the forge; it showed:\n${pty.output()}`).toBe(true);
        expect(signalOwned(styre, "SIGTERM")).toBe(true);
        await endedBy(pty, "SIGTERM");
        await expectShown(pty, opening("SIGTERM"));
      } finally {
        proxy.stop(true);
      }
    },
    SLOW,
  );
});

// ENG-485 section 8: every Styre command (run, setup, ls, clean, migrate, notify) sweeps first,
// inside its error boundary, before any other work. Each test calls the real citty command, with an
// orphan on disk (a dead owner, a live `sleep` this file started), and checks that the orphan was
// stopped, that the sweep spoke on stderr only, and that the command's own work came after.
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CommandDef } from "citty";
import { cleanCommand } from "../../src/cli/clean.ts";
import { lsCommand } from "../../src/cli/ls.ts";
import { migrateCommand } from "../../src/cli/migrate.ts";
import { notifyCommand } from "../../src/cli/notify.ts";
import { runCommand } from "../../src/cli/run.ts";
import { setupCommand } from "../../src/cli/setup.ts";
import * as door from "../../src/util/process/door.ts";
import { bootId, probe } from "../../src/util/process/proc-table.ts";
import { processesDir, writeRecord } from "../../src/util/process/records.ts";

/** A sleep length no other test uses. */
const NAP = "4179";
let state: string;
let scratch: string;
const saved = { state: process.env.XDG_STATE_HOME, dnt: process.env.DO_NOT_TRACK };
const mine: number[] = [];
/** Every write to stdout and stderr, in order. */
let log: { stream: "out" | "err"; text: string }[] = [];
let spies: { mockRestore(): void }[] = [];

beforeEach(() => {
  state = mkdtempSync(join(tmpdir(), "styre-sweep-cmd-"));
  scratch = mkdtempSync(join(tmpdir(), "styre-sweep-cmd-scratch-"));
  process.env.XDG_STATE_HOME = state;
  process.env.DO_NOT_TRACK = "1";
  door.__resetForTests();
  log = [];
  spies = [
    spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      log.push({ stream: "out", text: String(chunk) });
      return true;
    }),
    spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
      log.push({ stream: "err", text: String(chunk) });
      return true;
    }),
  ];
});
afterEach(() => {
  for (const s of spies.splice(0)) s.mockRestore();
  for (const p of mine.splice(0)) {
    try {
      process.kill(p, "SIGKILL");
    } catch {
      /* already gone */
    }
  }
  process.exitCode = 0;
  process.env.XDG_STATE_HOME = saved.state;
  if (saved.dnt === undefined) Reflect.deleteProperty(process.env, "DO_NOT_TRACK");
  else process.env.DO_NOT_TRACK = saved.dnt;
  rmSync(state, { recursive: true, force: true });
  rmSync(scratch, { recursive: true, force: true });
});

const isGone = (pid: number): boolean => {
  const p = probe(pid);
  return p.kind === "gone" || (p.kind === "alive" && p.info.state === "zombie");
};
async function until(fn: () => boolean, ms = 4000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return true;
    await Bun.sleep(20);
  }
  return fn();
}

/** An orphaned agent: a live `sleep` whose recorded owner has exited. */
async function orphan(ident: string): Promise<number> {
  const owner = Bun.spawn(["sleep", "0.2"]);
  const o = probe(owner.pid);
  await owner.exited;
  const agent = Bun.spawn(["sleep", NAP], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  mine.push(agent.pid);
  const a = probe(agent.pid);
  if (o.kind !== "alive" || a.kind !== "alive") throw new Error("fixture did not start");
  expect(await until(() => isGone(o.info.pid))).toBe(true);
  writeRecord({
    version: 1,
    pid: a.info.pid,
    startedAt: a.info.startedAt,
    bootId: bootId(),
    kind: "agent",
    ident,
    stepId: 1,
    worktree: null,
    command: `sleep ${NAP}`,
    owner: { pid: o.info.pid, startedAt: o.info.startedAt, pgid: o.info.pgid },
  });
  return a.info.pid;
}

const line = (ident: string, pid: number) =>
  `styre: stopped an orphaned agent from ${ident} (pid ${pid}), left running when Styre was force quit\n`;

// biome-ignore lint/suspicious/noExplicitAny: every command definition, whatever its arguments
async function call(cmd: CommandDef<any>, args: Record<string, unknown>): Promise<void> {
  const run = cmd.run as (ctx: unknown) => Promise<void>;
  await run({ args: { _: [], ...args }, rawArgs: [], cmd });
}

/** The orphan was stopped, its record removed, and the sweep's line went to stderr only. Returns
 *  the position of that line in the ordered log. */
async function swept(ident: string, pid: number): Promise<number> {
  expect(await until(() => isGone(pid))).toBe(true);
  expect(readdirSync(processesDir())).toEqual([]);
  const at = log.findIndex((w) => w.stream === "err" && w.text === line(ident, pid));
  expect(at).toBeGreaterThanOrEqual(0);
  expect(log.filter((w) => w.stream === "out" && w.text.includes("styre: stopped"))).toEqual([]);
  return at;
}

test("styre ls sweeps first, says it on stderr, and lists what it stopped on stdout", async () => {
  const pid = await orphan("ENG-11");
  await call(lsCommand, {});
  const at = await swept("ENG-11", pid);
  const out = log.filter((w) => w.stream === "out").map((w) => w.text);
  expect(out.length).toBe(1);
  expect(out[0]).toContain("Stopped orphans (left running when Styre was force quit):\n");
  expect(out[0]).toContain(`  ENG-11  [agent, pid ${pid}]  sleep ${NAP}\n`);
  const listing = log.findIndex((w) => w.stream === "out");
  expect(at).toBeLessThan(listing);
});

test("styre ls with nothing to sweep prints no orphan section", async () => {
  await call(lsCommand, {});
  const out = log.filter((w) => w.stream === "out").map((w) => w.text);
  expect(out.join("")).not.toContain("Stopped orphans");
});

test("an unreadable records folder does not stop a command: one line, then the command's own work", async () => {
  writeFileSync(join(state, "styre-processes"), ""); // a file where the folder should be
  await call(lsCommand, {});
  const err = log.filter((w) => w.stream === "err").map((w) => w.text);
  expect(err.length).toBe(1);
  expect(err[0]).toStartWith("styre: could not read the launch records in ");
  expect(
    log
      .filter((w) => w.stream === "out")
      .map((w) => w.text)
      .join(""),
  ).toContain("Paused/resumable efforts:");
  expect(process.exitCode ?? 0).toBe(0);
});

test("styre migrate sweeps before it migrates", async () => {
  const pid = await orphan("ENG-12");
  const db = join(scratch, "x.db");
  await call(migrateCommand, { db });
  const at = await swept("ENG-12", pid);
  const migrated = log.findIndex((w) => w.stream === "err" && w.text.startsWith("bootstrapped:"));
  expect(migrated).toBeGreaterThan(at);
});

test("styre clean sweeps before its first check", async () => {
  const pid = await orphan("ENG-13");
  await call(cleanCommand, {}); // no ident and no --all: a usage error at its first line
  const at = await swept("ENG-13", pid);
  expect(process.exitCode).toBe(64);
  const err = log.findIndex((w) => w.stream === "err" && w.text.startsWith("styre clean:"));
  expect(err).toBeGreaterThan(at);
});

test("styre notify sweeps before its first check", async () => {
  const pid = await orphan("ENG-14");
  await call(notifyCommand, {}); // no --test: a usage error at its first line
  await swept("ENG-14", pid);
  expect(process.exitCode).toBe(64);
});

test("styre run sweeps before its first check, and its stdout carries no sweep line", async () => {
  const pid = await orphan("ENG-15");
  // A review action without --resume: refused at the run's first check.
  await call(runCommand, { "review-action": "retry" });
  const at = await swept("ENG-15", pid);
  expect(process.exitCode).toBe(64);
  for (const w of log.filter((x) => x.stream === "out")) {
    for (const l of w.text.split("\n").filter((s) => s !== ""))
      expect(() => JSON.parse(l)).not.toThrow();
  }
  const err = log.findIndex((w) => w.stream === "err" && w.text.startsWith("styre run:"));
  expect(err).toBeGreaterThan(at);
});

test("styre setup sweeps before its first check", async () => {
  const pid = await orphan("ENG-16");
  await call(setupCommand, {
    repo: scratch,
    slug: "sweep-test",
    config: join(scratch, "no-such-config.json"),
  });
  const at = await swept("ENG-16", pid);
  expect(process.exitCode).not.toBe(0);
  const err = log.findIndex((w) => w.stream === "err" && w.text.startsWith("styre setup:"));
  expect(err).toBeGreaterThan(at);
});

test("the real entry point: `styre ls` sweeps, with sweep lines on stderr and none on stdout", async () => {
  const pid = await orphan("ENG-17");
  const proc = Bun.spawn(["bun", "run", join(import.meta.dir, "../../src/index.ts"), "ls"], {
    env: { ...process.env, XDG_STATE_HOME: state },
    stdout: "pipe",
    stderr: "pipe",
  });
  mine.push(proc.pid);
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  expect(code).toBe(0);
  expect(err).toContain(line("ENG-17", pid));
  expect(out).not.toContain("styre: stopped");
  expect(out).toContain(`  ENG-17  [agent, pid ${pid}]  sleep ${NAP}\n`);
  expect(await until(() => isGone(pid))).toBe(true);
  expect(readdirSync(processesDir())).toEqual([]);
});

test("in every command, the sweep is the first statement inside the error boundary", () => {
  const src = (f: string) => readFileSync(join(import.meta.dir, "../../src/cli", f), "utf8");
  const cases: [string, string, string][] = [
    ["run.ts", "guardWithExitCheck", "run"],
    ["setup.ts", "guardWithExitCheck", "setup"],
    ["ls.ts", "guard", "ls"],
    ["clean.ts", "guard", "clean"],
    ["migrate.ts", "guard", "migrate"],
    ["notify.ts", "guard", "notify"],
  ];
  for (const [file, boundary, name] of cases) {
    const first = new RegExp(
      `${boundary}\\(\\s*"${name}",\\s*async \\(\\) => \\{\\s*(?://[^\\n]*\\n\\s*)*(?:const \\w+ = )?await sweepOrphans\\(\\);`,
    );
    expect({ file, wired: first.test(src(file)) }).toEqual({ file, wired: true });
  }
});

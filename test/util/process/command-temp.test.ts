// The temp folder Styre gives the project commands it starts. Every command a Styre process starts
// gets TMPDIR, TMP and TEMP pointed at one folder that process owns, so what a command leaves in its
// temp folder (a browser profile karma never removed, a Python TemporaryDirectory a stop cut short)
// stays out of the system temp folder, and Styre removes it on its way out. Each test gets its own
// temp root, so the folder it inspects is the one these tests made.
import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { guardWithExitCheck } from "../../../src/cli/exit-check.ts";
import {
  __swapCommandTempForTests,
  commandTempDir,
  removeCommandTempDir,
} from "../../../src/util/process/command-temp.ts";
import * as door from "../../../src/util/process/door.ts";
import { bootId } from "../../../src/util/process/proc-table.ts";
import { processesDir } from "../../../src/util/process/records.ts";
import { __resetSignalsForTests, handleStopSignal } from "../../../src/util/process/signals.ts";
import { runBoundedCommand } from "../../../src/util/run-bounded-command.ts";
import { runCommand } from "../../../src/util/run-command.ts";
import { makeTempDir } from "../../helpers/temp.ts";

let root: string;
let cwd: string;
let state: string;
let runs: ReturnType<typeof __swapCommandTempForTests> = null;
const savedTmp = process.env.TMPDIR;
const savedState = process.env.XDG_STATE_HOME;
const savedKey = process.env.ANTHROPIC_API_KEY;

beforeEach(() => {
  cwd = realpathSync(makeTempDir("styre-cmdtmp-cwd-"));
  state = makeTempDir("styre-cmdtmp-state-");
  process.env.XDG_STATE_HOME = state;
  root = realpathSync(makeTempDir("styre-cmdtmp-root-"));
  process.env.TMPDIR = root;
  // The test run's own folder (test/preload.ts) is put back in afterEach.
  runs = __swapCommandTempForTests(null);
});
afterEach(() => {
  // A test that failed before its own removal must not leave the folder in the run's temp root.
  removeCommandTempDir(() => {});
  __swapCommandTempForTests(runs);
  process.env.TMPDIR = savedTmp;
  process.env.XDG_STATE_HOME = savedState;
  if (savedKey === undefined) Reflect.deleteProperty(process.env, "ANTHROPIC_API_KEY");
  else process.env.ANTHROPIC_API_KEY = savedKey;
});

const echoTemp = `printf '%s\\n%s\\n%s\\n' "$TMPDIR" "$TMP" "$TEMP"`;
const lines = (s: string) => s.trim().split("\n");
const collect = () => {
  const out: string[] = [];
  return { out, say: (s: string) => out.push(s) };
};

test("a command's TMPDIR, TMP and TEMP all name one folder this Styre owns, for every command", async () => {
  const bounded = await runBoundedCommand(echoTemp, { cwd, timeoutMs: 5000 });
  const plain = await runCommand(echoTemp, { cwd, timeoutMs: 5000 });
  const [tmpdir, tmp, temp] = lines(bounded.stdout);
  expect([tmp, temp]).toEqual([tmpdir, tmpdir]);
  expect(lines(plain.stdout)).toEqual([tmpdir, tmpdir, tmpdir]);
  const dir = tmpdir as string;
  expect(dirname(dir)).toBe(root);
  const me = door.selfIdentity();
  expect(basename(dir)).toMatch(
    new RegExp(`^styre-cmd-${me.pid}-${me.startedAt.replace(".", "\\.")}-[A-Za-z0-9]{6}$`),
  );
  expect(statSync(dir).isDirectory()).toBe(true);
  // Only this user may read or write what commands put there.
  expect(statSync(dir).mode & 0o777).toBe(0o700);
  expect(commandTempDir()).toBe(dir);
});

test("the folder is made when the first command starts, not before", async () => {
  expect(readdirSync(root)).toEqual([]);
  await runCommand("true", { cwd, timeoutMs: 5000 });
  expect(readdirSync(root)).toEqual([basename(commandTempDir())]);
});

test("the command environment still strips the provider keys", async () => {
  process.env.ANTHROPIC_API_KEY = "sk-test-not-a-real-key";
  const r = await runCommand(`printf '%s' "\${ANTHROPIC_API_KEY-unset}"`, { cwd, timeoutMs: 5000 });
  expect(r.stdout).toBe("unset");
});

test("a folder removed while Styre runs is replaced by a new one, noted in place of the old", async () => {
  await runCommand("true", { cwd, timeoutMs: 5000 });
  const old = commandTempDir();
  rmSync(old, { recursive: true, force: true });
  const r = await runCommand(`test -d "$TMPDIR" && printf '%s' "$TMPDIR"`, {
    cwd,
    timeoutMs: 5000,
  });
  expect(r.stdout).not.toBe("");
  expect(r.stdout).not.toBe(old);
  expect(dirname(r.stdout)).toBe(root);
  expect(statSync(r.stdout).mode & 0o777).toBe(0o700);
  const notes = readdirSync(processesDir());
  expect(notes.length).toBe(1);
  expect(JSON.parse(readFileSync(join(processesDir(), notes[0] as string), "utf8")).path).toBe(
    r.stdout,
  );
});

test("a new folder is made in the temp folder of the moment when the old one's parent is gone", async () => {
  const first = realpathSync(makeTempDir("styre-cmdtmp-first-"));
  process.env.TMPDIR = first;
  await runCommand("true", { cwd, timeoutMs: 5000 });
  rmSync(first, { recursive: true, force: true });
  process.env.TMPDIR = root;
  const r = await runCommand(`printf '%s' "$TMPDIR"`, { cwd, timeoutMs: 5000 });
  expect(r.exitCode).toBe(0);
  expect(dirname(r.stdout)).toBe(root);
});

test("what a timed out command leaves in its temp folder stays inside Styre's folder, and the removal takes it", async () => {
  // Nothing removes what this command makes: the timeout's stop ends it first.
  const r = await runBoundedCommand(`mktemp -d "$TMPDIR/leftover-XXXXXX" >/dev/null; sleep 30`, {
    cwd,
    timeoutMs: 300,
  });
  expect(r.timedOut).toBe(true);
  const dir = commandTempDir();
  expect(readdirSync(root)).toEqual([basename(dir)]);
  expect(readdirSync(dir).some((n) => n.startsWith("leftover-"))).toBe(true);
  const { out, say } = collect();
  removeCommandTempDir(say);
  expect(out).toEqual([]);
  expect(readdirSync(root)).toEqual([]);
});

test("the removal is a no-op when no command ran", () => {
  const { out, say } = collect();
  removeCommandTempDir(say);
  expect(out).toEqual([]);
  expect(readdirSync(root)).toEqual([]);
});

test("the removal keeps the folder while a command Styre started is still running, and says so", async () => {
  const running = runCommand("sleep 1", { cwd, timeoutMs: 5000 });
  try {
    for (let i = 0; i < 100 && door.liveLaunches().length === 0; i++) await Bun.sleep(10);
    expect(door.liveLaunches().length).toBe(1);
    const dir = commandTempDir();
    const { out, say } = collect();
    removeCommandTempDir(say);
    expect(existsSync(dir)).toBe(true);
    expect(out).toEqual([
      `styre: kept the temp folder ${dir}: a command Styre started is still running; the next Styre command removes it once that command has stopped\n`,
    ]);
    await running;
    removeCommandTempDir(say);
    expect(existsSync(dir)).toBe(false);
  } finally {
    await running;
  }
});

test("a removal that fails is said, never thrown", async () => {
  await runCommand("true", { cwd, timeoutMs: 5000 });
  const dir = commandTempDir();
  // A temp root this user may not write: the folder's entries go, the folder itself cannot.
  chmodSync(root, 0o500);
  const { out, say } = collect();
  try {
    expect(() => removeCommandTempDir(say)).not.toThrow();
  } finally {
    chmodSync(root, 0o700);
  }
  expect(out.length).toBe(1);
  expect(out[0]).toStartWith(`styre: could not remove the temp folder ${dir}: `);
  expect(existsSync(dir)).toBe(true);
});

test("the exit check removes the folder once the command is done", async () => {
  const savedCode = process.exitCode;
  let made: string[] = [];
  let dir = "";
  try {
    await guardWithExitCheck("test", async () => {
      await runCommand("true", { cwd, timeoutMs: 5000 });
      made = readdirSync(root);
      dir = commandTempDir();
    });
  } finally {
    process.exitCode = savedCode;
  }
  expect(made).toEqual([basename(dir)]);
  expect(readdirSync(root)).toEqual([]);
});

test("the folder is noted in the launch records folder while it exists, so a force quit is cleaned up later", async () => {
  await runCommand("true", { cwd, timeoutMs: 5000 });
  const dir = commandTempDir();
  const me = door.selfIdentity();
  const name = `tmp-${me.pid}-${me.startedAt}.json`;
  expect(readdirSync(processesDir())).toEqual([name]);
  const note = join(processesDir(), name);
  expect(statSync(note).mode & 0o777).toBe(0o600);
  expect(JSON.parse(readFileSync(note, "utf8"))).toEqual({
    version: 1,
    owner: { pid: me.pid, startedAt: me.startedAt },
    bootId: bootId(),
    path: dir,
  });
  removeCommandTempDir(() => {});
  expect(readdirSync(processesDir())).toEqual([]);
});

test("the note is removed from the folder it was written to, even if the state folder changed since", async () => {
  await runCommand("true", { cwd, timeoutMs: 5000 });
  expect(readdirSync(join(state, "styre-processes")).length).toBe(1);
  process.env.XDG_STATE_HOME = join(state, "later");
  removeCommandTempDir(() => {});
  expect(readdirSync(join(state, "styre-processes"))).toEqual([]);
});

test("a folder that cannot be noted is not used: the command fails loudly and no folder is left", async () => {
  // The records folder's path is taken by a file, so no note can be written there.
  writeFileSync(join(state, "styre-processes"), "");
  await expect(runCommand("true", { cwd, timeoutMs: 5000 })).rejects.toThrow();
  const bounded = await runBoundedCommand("true", { cwd, timeoutMs: 5000 });
  expect(bounded.exitCode).toBeNull();
  expect(bounded.stderr).not.toBe("");
  expect(readdirSync(root)).toEqual([]);
});

test("the stop handler removes the folder once it has stopped the commands", async () => {
  const running = runCommand("sleep 30", { cwd, timeoutMs: 60_000 }).catch((e: unknown) => e);
  try {
    for (let i = 0; i < 100 && door.liveLaunches().length === 0; i++) await Bun.sleep(10);
    expect(door.liveLaunches().length).toBe(1);
    const dir = commandTempDir();
    const err: string[] = [];
    await handleStopSignal(
      "SIGTERM",
      { command: "run", run: null },
      {
        stderr: (s) => err.push(s),
        emit: () => {},
        reraise: () => {},
        exit: () => {},
        now: () => Date.now(),
        leftovers: () => [],
        noCore: () => {},
      },
    );
    expect(await running).toBeInstanceOf(door.RunInterrupted);
    expect(existsSync(dir)).toBe(false);
    expect(readdirSync(join(state, "styre-processes"))).toEqual([]);
    expect(err.filter((l) => l.includes("temp folder"))).toEqual([]);
  } finally {
    await running;
    door.__resetForTests();
    __resetSignalsForTests();
  }
});

test("a folder replaced by a link while Styre runs is left alone and never written through", async () => {
  await runCommand("true", { cwd, timeoutMs: 5000 });
  const dir = commandTempDir();
  rmSync(dir, { recursive: true, force: true });
  const elsewhere = makeTempDir("styre-cmdtmp-elsewhere-");
  symlinkSync(elsewhere, dir);
  try {
    const r = await runCommand(`touch "$TMPDIR/written" && printf '%s' "$TMPDIR"`, {
      cwd,
      timeoutMs: 5000,
    });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).not.toBe(dir);
    expect(readdirSync(elsewhere)).toEqual([]);
    // The note names the new folder, so no sweep ever acts on the link.
    const notes = readdirSync(processesDir());
    expect(JSON.parse(readFileSync(join(processesDir(), notes[0] as string), "utf8")).path).toBe(
      r.stdout,
    );
  } finally {
    rmSync(dir, { force: true });
  }
});

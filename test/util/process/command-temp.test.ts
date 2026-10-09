// The temp folder Styre gives the project commands it starts. Every command a Styre process starts
// gets TMPDIR, TMP and TEMP pointed at one folder that process owns, so what a command leaves in its
// temp folder (a browser profile karma never removed, a Python TemporaryDirectory a stop cut short)
// stays out of the system temp folder, and Styre removes it on its way out. Each test gets its own
// temp root, so the folder it inspects is the one these tests made.
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
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
import * as commandTemp from "../../../src/util/process/command-temp.ts";
import * as door from "../../../src/util/process/door.ts";
import { bootId } from "../../../src/util/process/proc-table.ts";
import { processesDir } from "../../../src/util/process/records.ts";
import {
  HANDLER_DEADLINE_MS,
  __resetSignalsForTests,
  handleStopSignal,
} from "../../../src/util/process/signals.ts";
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
/** Gives every folder below `dir` back its owner's write permission, if it still exists. */
function writable(dir: string): void {
  if (!existsSync(dir)) return;
  chmodSync(dir, 0o700);
  for (const e of readdirSync(dir, { withFileTypes: true }))
    if (e.isDirectory() && !e.isSymbolicLink()) writable(join(dir, e.name));
}
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
  expect(basename(dir)).toMatch(/^styre-cmd-[A-Za-z0-9]{6}$/);
  // Short on purpose: a Unix socket path holds at most 104 bytes on macOS, and Python's
  // multiprocessing puts its listener 32 characters below TMPDIR.
  expect(dir.length - root.length).toBeLessThanOrEqual(17);
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
    // Announcing (as the exit check does) says nothing about a removal that does not happen.
    removeCommandTempDir(say, { announce: true });
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

test("a removal that fails is said once, with how to remove it, and its note goes so it is not said again", async () => {
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
  expect(out[0]).toEndWith(`; remove it with: chmod -R u+w ${dir} && rm -rf ${dir}\n`);
  expect(existsSync(dir)).toBe(true);
  expect(readdirSync(processesDir())).toEqual([]);
});

test("a read-only tree inside the folder is removed too (a Go module cache)", async () => {
  await runCommand(
    `mkdir -p "$TMPDIR/mod/pkg@v1" && echo x > "$TMPDIR/mod/pkg@v1/a.go" && chmod -R a-w "$TMPDIR/mod"`,
    { cwd, timeoutMs: 5000 },
  );
  const dir = commandTempDir();
  const { out, say } = collect();
  try {
    removeCommandTempDir(say);
  } finally {
    writable(dir); // so a failing run can still clean up
  }
  expect(out).toEqual([]);
  expect(existsSync(dir)).toBe(false);
});

test("with a time budget, a removal that runs out of time stops, says so, and keeps the note for the sweep", async () => {
  await runCommand(
    `mkdir "$TMPDIR/many" && i=0; while [ $i -lt 300 ]; do : > "$TMPDIR/many/f$i"; i=$((i+1)); done`,
    { cwd, timeoutMs: 10_000 },
  );
  const dir = commandTempDir();
  // A clock that moves 1 ms per look: 50 ms of budget ends long before 300 entries are gone.
  let t = 0;
  const { out, say } = collect();
  removeCommandTempDir(say, { budgetMs: 50, now: () => t++ });
  expect(out).toEqual([
    `styre: left the temp folder ${dir} for the next Styre command to remove: no time was left before the stop deadline\n`,
  ]);
  expect(existsSync(dir)).toBe(true);
  expect(readdirSync(join(dir, "many")).length).toBeLessThan(300);
  expect(readdirSync(processesDir()).length).toBe(1);
  // Still this process's: a later removal without a budget finishes it, note and all.
  const later = collect();
  removeCommandTempDir(later.say);
  expect(later.out).toEqual([]);
  expect(existsSync(dir)).toBe(false);
  expect(readdirSync(processesDir())).toEqual([]);
});

test("a running agent does not hold the folder back: agents keep their own temp folder", async () => {
  await runCommand("true", { cwd, timeoutMs: 5000 });
  const dir = commandTempDir();
  const agent = door.launch({
    argv: ["sleep", "5"],
    cwd,
    env: { ...process.env },
    kind: "agent",
    context: { ident: null, stepId: null, worktree: null },
  });
  try {
    const { out, say } = collect();
    removeCommandTempDir(say);
    expect(out).toEqual([]);
    expect(existsSync(dir)).toBe(false);
  } finally {
    await agent.stop("forced");
  }
});

test("no folder is made once a stop has begun: the refused command leaves nothing behind", async () => {
  door.beginStopping();
  try {
    await expect(runCommand("true", { cwd, timeoutMs: 5000 })).rejects.toBeInstanceOf(
      door.RunInterrupted,
    );
    await expect(runBoundedCommand("true", { cwd, timeoutMs: 5000 })).rejects.toBeInstanceOf(
      door.RunInterrupted,
    );
  } finally {
    door.__resetForTests();
  }
  expect(readdirSync(root)).toEqual([]);
  expect(existsSync(processesDir()) ? readdirSync(processesDir()) : []).toEqual([]);
});

test("the exit check leaves the folder to the stop handler while a stop is in progress", async () => {
  const running = runCommand("sleep 2", { cwd, timeoutMs: 5000 }).catch((e: unknown) => e);
  for (let i = 0; i < 100 && door.liveLaunches().length === 0; i++) await Bun.sleep(10);
  const dir = commandTempDir();
  const err: string[] = [];
  const write = process.stderr.write.bind(process.stderr);
  (process.stderr as { write: unknown }).write = (s: unknown) => {
    err.push(String(s));
    return true;
  };
  door.beginStopping();
  const savedCode = process.exitCode;
  try {
    await guardWithExitCheck("test", async () => {});
  } finally {
    (process.stderr as { write: unknown }).write = write;
    process.exitCode = savedCode;
    door.__resetForTests();
    await running;
  }
  expect(err.filter((l) => l.includes("temp folder"))).toEqual([]);
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

test("the stop handler leaves the folder to the sweep when its deadline leaves no time to remove it", async () => {
  await runCommand("true", { cwd, timeoutMs: 5000 });
  const dir = commandTempDir();
  const err: string[] = [];
  // The first look sets the handler's deadline; every later look is a minute past it.
  let first = true;
  const now = () => {
    const t = Date.now() + (first ? 0 : 60_000);
    first = false;
    return t;
  };
  try {
    await handleStopSignal(
      "SIGTERM",
      { command: "run", run: null },
      {
        stderr: (s) => err.push(s),
        emit: () => {},
        reraise: () => {},
        exit: () => {},
        now,
        leftovers: () => [],
        noCore: () => {},
      },
    );
  } finally {
    door.__resetForTests();
    __resetSignalsForTests();
  }
  expect(err.filter((l) => l.includes("temp folder"))).toEqual([
    `styre: left the temp folder ${dir} for the next Styre command to remove: no time was left before the stop deadline\n`,
  ]);
  expect(existsSync(dir)).toBe(true);
  expect(readdirSync(processesDir()).length).toBe(1);
});

test("an abandoned folder's note goes from the folder it was written to, so no sweep acts on what is at its name", async () => {
  await runCommand("true", { cwd, timeoutMs: 5000 });
  const first = join(state, "styre-processes");
  expect(readdirSync(first).length).toBe(1);
  rmSync(commandTempDir(), { recursive: true, force: true });
  process.env.XDG_STATE_HOME = join(state, "later");
  await runCommand("true", { cwd, timeoutMs: 5000 });
  expect(readdirSync(first)).toEqual([]);
  expect(readdirSync(join(state, "later", "styre-processes")).length).toBe(1);
});

test("the remedy names the folder as one shell word, so a temp folder with a space is safe to paste", async () => {
  const spaced = join(root, "My Temp");
  mkdirSync(spaced);
  process.env.TMPDIR = spaced;
  await runCommand("true", { cwd, timeoutMs: 5000 });
  const dir = commandTempDir();
  chmodSync(spaced, 0o500);
  const { out, say } = collect();
  try {
    removeCommandTempDir(say);
  } finally {
    chmodSync(spaced, 0o700);
  }
  expect(out.length).toBe(1);
  expect(out[0]).toEndWith(`; remove it with: chmod -R u+w '${dir}' && rm -rf '${dir}'\n`);
});

test("at exit, a folder replaced by something else is left alone, unnamed, and its note goes", async () => {
  await runCommand("true", { cwd, timeoutMs: 5000 });
  const dir = commandTempDir();
  rmSync(dir, { recursive: true, force: true });
  const elsewhere = makeTempDir("styre-cmdtmp-elsewhere-");
  writeFileSync(join(elsewhere, "precious"), "keep");
  symlinkSync(elsewhere, dir);
  const { out, say } = collect();
  try {
    removeCommandTempDir(say);
    expect(out).toEqual([]);
    expect(lstatSync(dir).isSymbolicLink()).toBe(true); // not Styre's: left as it is
    expect(readdirSync(elsewhere)).toEqual(["precious"]);
    expect(readdirSync(processesDir())).toEqual([]);
  } finally {
    rmSync(dir, { force: true });
  }
});

test("the stop handler gives the removal only what is left of its deadline, short of its margins", async () => {
  await runCommand("true", { cwd, timeoutMs: 5000 });
  const seen: { budgetMs?: number }[] = [];
  const real = commandTemp.removeCommandTempDir;
  const spy = spyOn(commandTemp, "removeCommandTempDir").mockImplementation((say, opts) => {
    seen.push({ budgetMs: opts?.budgetMs });
    real(say, opts);
  });
  // The first look sets the deadline; every later look is 1 s after it.
  const t0 = Date.now();
  let first = true;
  const now = () => {
    const t = first ? t0 : t0 + 1000;
    first = false;
    return t;
  };
  try {
    await handleStopSignal(
      "SIGTERM",
      { command: "run", run: null },
      {
        stderr: () => {},
        emit: () => {},
        reraise: () => {},
        exit: () => {},
        now,
        leftovers: () => [],
        noCore: () => {},
      },
    );
  } finally {
    spy.mockRestore();
    door.__resetForTests();
    __resetSignalsForTests();
  }
  expect(seen.length).toBe(1);
  const budget = seen[0]?.budgetMs ?? Number.NaN;
  // What is left (HANDLER_DEADLINE_MS - 1000), less the exit's reserve and the cleanup margin.
  expect(budget).toBeGreaterThan(0);
  expect(budget).toBeLessThanOrEqual(HANDLER_DEADLINE_MS - 1000 - 250);
});

/** After one command, the temp root becomes a file: the folder's path can no longer be looked at
 *  (ENOTDIR), as on a temp folder whose parent went away or an unreadable network mount. */
async function unreachableFolder(): Promise<string> {
  await runCommand("true", { cwd, timeoutMs: 5000 });
  const dir = commandTempDir();
  rmSync(root, { recursive: true, force: true });
  writeFileSync(root, "");
  return dir;
}

test("a folder that can no longer be looked at: the removal says so and never throws", async () => {
  const dir = await unreachableFolder();
  const { out, say } = collect();
  expect(() => removeCommandTempDir(say)).not.toThrow();
  expect(out.length).toBe(1);
  expect(out[0]).toStartWith(
    `styre: left the temp folder ${dir} for the next Styre command to remove: it could not be looked at (`,
  );
  // The note stays: the next command's sweep, which may see more, removes the folder.
  expect(readdirSync(processesDir()).length).toBe(1);
});

test("the stop handler still releases, re-raises and exits when the folder can no longer be looked at", async () => {
  await unreachableFolder();
  const reraised: string[] = [];
  const exited: number[] = [];
  try {
    await handleStopSignal(
      "SIGTERM",
      { command: "run", run: null },
      {
        stderr: () => {},
        emit: () => {},
        reraise: (s) => reraised.push(s),
        exit: (c) => exited.push(c),
        now: () => Date.now(),
        leftovers: () => [],
        noCore: () => {},
      },
    );
  } finally {
    door.__resetForTests();
    __resetSignalsForTests();
  }
  expect(reraised).toEqual(["SIGTERM"]);
  expect(exited).toEqual([143]);
});

test("the exit check still returns when the folder can no longer be looked at", async () => {
  await unreachableFolder();
  const savedCode = process.exitCode;
  const write = process.stderr.write.bind(process.stderr);
  (process.stderr as { write: unknown }).write = () => true;
  try {
    await expect(guardWithExitCheck("test", async () => {})).resolves.toBeUndefined();
  } finally {
    (process.stderr as { write: unknown }).write = write;
    process.exitCode = savedCode;
  }
});

/** What `fn` writes to stderr, each write with whether `dir` still existed at that moment. */
async function stderrWhile(dir: string, fn: () => Promise<unknown>) {
  const said: { line: string; folderThere: boolean }[] = [];
  const write = process.stderr.write.bind(process.stderr);
  (process.stderr as { write: unknown }).write = (s: unknown) => {
    said.push({ line: String(s), folderThere: dir !== "" && existsSync(dir) });
    return true;
  };
  try {
    await fn();
  } finally {
    (process.stderr as { write: unknown }).write = write;
  }
  return said;
}

test("the exit check says one line before it removes the run's temp folder, so a long removal is never a silent pause", async () => {
  await runCommand("true", { cwd, timeoutMs: 5000 });
  const dir = commandTempDir();
  const savedCode = process.exitCode;
  let said: { line: string; folderThere: boolean }[] = [];
  try {
    said = await stderrWhile(dir, () => guardWithExitCheck("test", async () => {}));
  } finally {
    process.exitCode = savedCode;
  }
  expect(said).toEqual([
    {
      line: `styre: cleaning up the temp folder of the commands Styre ran: ${dir}\n`,
      folderThere: true,
    },
  ]);
  expect(existsSync(dir)).toBe(false);
});

test("the exit check says nothing when no command ran", async () => {
  const savedCode = process.exitCode;
  let said: { line: string; folderThere: boolean }[] = [];
  try {
    said = await stderrWhile("", () => guardWithExitCheck("test", async () => {}));
  } finally {
    process.exitCode = savedCode;
  }
  expect(said).toEqual([]);
});

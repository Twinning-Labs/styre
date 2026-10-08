// Live lifecycle smoke (ENG-485 Task 16, spec 11.2 and 11.4; NOT run in CI on every PR): repeats
// the design's experiment (spec 2.1) with the REAL `claude` CLI and checks, by outcome, that a
// stopped Styre leaves no agent and no agent command running. Requires the `claude` CLI installed
// and authenticated. Each scenario is one real agent dispatch, which costs money: seven per full
// run on the cheap model.
//
// Usage: bun run scripts/smoke-lifecycle.ts [model]     (default: claude-haiku-4-5-20251001)
//
// Each scenario makes a throwaway git repository whose test suite is slow (`test.sh` writes its
// pid, then becomes `sleep 97.3<n>`), and runs scripts/smoke-lifecycle-driver.ts: Styre's stop
// handling around one dispatch through the real Claude adapter, with the design's prompt and the
// tools ["Read", "Bash(sh:*)"]. Once the agent's sleep is running, the scenario stops Styre.
//
//   1. It records `claude --version` (at least 2.1.280), and in every scenario that the group the
//      agent's command runs in is led by the agent's direct child (R8, spec 6.1).
//   2. CONTROL: main, checked out in a temporary git worktree outside this checkout, under
//      `kill` and `kill -9`. Each must leave the agent and its sleep running (spec 2.1). If one
//      does not, the probes cannot see a failure: it prints "probes are blind" and exits 1.
//      ($SMOKE_CONTROL_ROOT names other code to use as the control: the proof that this check bites.)
//   3. NEW CODE: Ctrl-C (typed into a real terminal), `kill`, `kill -9` followed by `styre ls`, a
//      dispatch timeout, and Ctrl-\. Each must end with the expected exit, and the agent and its
//      sleep must be gone within 5 s, except Ctrl-\, where the sleep may outlive the stop but must
//      then be reported (D13).
//
// Safety. Every process here is the script's own (test/helpers/own-processes.ts): a driver started
// in the background leads a new session that the script registers, so the agent, which stays in
// the driver's group, remains claimable after the driver dies; the agent's command and its sleep
// are claimed by descent before any stop. Nothing is found by its command text, and nothing is
// signalled that was not claimed. After every scenario everything claimed is stopped, and the
// scenario fails loudly if any claimed process, any member of the driver's group, or any process
// working in the scenario's folder is still running. Every Styre process gets a state folder of the
// script's own (XDG_STATE_HOME), and the run fails if a launch record appears in the real
// ~/.local/state/styre-processes.
import {
  type FSWatcher,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  watch,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { CLAUDE_MIN_CLI_VERSION } from "../src/agent/providers/claude.ts";
import { findLeftovers } from "../src/util/process/leftovers.ts";
import { type ProcInfo, listProcesses, nowToken, probe } from "../src/util/process/proc-table.ts";
import {
  commandOf,
  isAlive,
  killOwned,
  own,
  ownPrinted,
  ownTree,
  registerGroup,
  signalOwned,
  stillRunning,
  stopStillRunning,
  until,
} from "../test/helpers/own-processes.ts";
import { CTRL_BACKSLASH, CTRL_C, type Pty, underPty } from "../test/lifecycle/pty.ts";
import {
  type ControlResult,
  type Ended,
  type Expectation,
  type Observation,
  STOP_WINDOW_MS,
  agentAbove,
  controlVerdict,
  judge,
  parseClaudeVersion,
  parseDriver,
  r8Check,
  versionAtLeast,
} from "./lifecycle-live.ts";

const model = process.argv[2] ?? "claude-haiku-4-5-20251001";
const ROOT = realpathSync(join(import.meta.dir, ".."));
const DRIVER = join(ROOT, "scripts", "smoke-lifecycle-driver.ts");
/** How long the agent may take to start its test (CLI start, one model call, one tool call). */
const START_MS = 120_000;
/** The dispatch timeout of the timeout scenario: long enough for the sleep to start first. */
const TIMEOUT_SCENARIO_MS = 60_000;
/** How long a stopped driver may take to exit: the handler's 6.5 s deadline, and some room. */
const EXIT_MS = 15_000;

const OPENING_INT =
  "styre: stopping — cleaning up the agent and its commands before exiting (up to 5s; press Ctrl-C again to force)…";
const opening = (sig: string): string => `styre: received a stop request (${sig}) — cleaning up…`;
const stoppedAgent = (pid: number): RegExp =>
  new RegExp(`^styre: stopped the agent \\(pid ${pid}\\) and \\d+ of its commands\\.$`, "m");
const COULD_NOT = /^styre: could not (?:stop|confirm)/m;

const log = (s: string): void => {
  process.stderr.write(`${s}\n`);
};

// ---- the script's own folders, before anything starts -------------------------------------------
const work = realpathSync(mkdtempSync(join(tmpdir(), "styre-smoke-lifecycle-")));
const stateHome = join(work, "state");
process.env.XDG_STATE_HOME = stateHome;
const recordsDir = join(stateHome, "styre-processes");

// The guard on the operator's real records folder (as test/preload.ts does for the test suite).
const RECORD_NAME = /^\.?\d+-\d+(?:\.\d{6})?\.json/;
const realDir = join(process.env.HOME || homedir(), ".local", "state", "styre-processes");
const realRecords = (): string[] => {
  try {
    return readdirSync(realDir).filter((n) => RECORD_NAME.test(n));
  } catch {
    return [];
  }
};
const realExisted = existsSync(realDir);
const realBefore = new Set(realRecords());
const realSeen = new Set<string>();
let realWatch: FSWatcher | null = null;
if (realExisted) {
  try {
    realWatch = watch(realDir, (_e, name) => {
      if (typeof name === "string" && RECORD_NAME.test(name)) realSeen.add(name);
    });
    realWatch.unref?.();
  } catch {
    realWatch = null;
  }
}
function realRecordsWritten(): string[] {
  realWatch?.close();
  for (const n of realRecords()) if (!realBefore.has(n)) realSeen.add(n);
  if (!realExisted && existsSync(realDir)) realSeen.add("(the folder itself was created)");
  return [...realSeen].sort();
}

/** Every dispatch this run started: each is one real `claude` agent run. */
let dispatches = 0;
const ptys: Pty[] = [];
let mainWorktree: string | null = null;

// ---- cleanup: only what the script claimed ------------------------------------------------------
interface LeakCheck {
  ok: boolean;
  lines: string[];
}
/** Stop everything claimed, then check that nothing the scenario started is still running. */
async function cleanUp(
  scenarioDir: string | null,
  since: string | null,
  groups: number[],
): Promise<LeakCheck> {
  killOwned();
  const lines: string[] = [];
  const left = await stillRunning(3_000);
  if (left.length > 0) {
    stopStillRunning(left);
    for (const l of left) lines.push(`claimed process still running: pid ${l.pid} "${l.command}"`);
  }
  // The driver's group: the agent stays in it, so after the stop it must be empty.
  await until(
    () => groups.every((g) => !listProcesses().some((p) => p.pgid === g && p.state !== "zombie")),
    3_000,
  );
  for (const g of groups)
    for (const p of listProcesses().filter((q) => q.pgid === g && q.state !== "zombie"))
      lines.push(`process ${p.pid} still in the driver's group ${g}: ${commandOf(p) ?? "?"}`);
  // Anything working in the scenario's folder, claimed or not (found by folder, reported only).
  if (scenarioDir !== null && since !== null) {
    const found = findLeftovers({
      worktree: scenarioDir,
      since,
      timeoutMs: 5_000,
      viaDiagnostic: true,
    });
    if (found === "skipped") lines.push("the folder check could not finish (lsof timed out)");
    else
      for (const f of found)
        lines.push(
          `still running in the scenario's folder: pid ${f.pid} "${f.command}" (not claimed; stop it with: kill ${f.pid})`,
        );
  }
  for (const p of ptys.splice(0)) p.dispose();
  return { ok: lines.length === 0, lines };
}

let finishing = false;
async function finish(wanted: number): Promise<never> {
  let code = wanted;
  if (!finishing) {
    finishing = true;
    const leak = await cleanUp(null, null, []);
    if (!leak.ok) {
      log(`LEAK after the run:\n- ${leak.lines.join("\n- ")}`);
      code = 1;
    }
    if (mainWorktree !== null) {
      Bun.spawnSync(["git", "-C", ROOT, "worktree", "remove", "--force", mainWorktree], {
        timeout: 60_000,
      });
      Bun.spawnSync(["git", "-C", ROOT, "worktree", "prune"], { timeout: 60_000 });
    }
    const written = realRecordsWritten();
    if (written.length > 0) {
      log(`FAIL: launch records were written into the real ${realDir}: ${written.join(", ")}`);
      code = 1;
    }
    rmSync(work, { recursive: true, force: true });
    log(`claude dispatches started: ${dispatches}`);
  }
  process.exit(code);
}
// A stop of the smoke itself still cleans up what it started.
for (const s of ["SIGINT", "SIGTERM", "SIGHUP"] as const)
  process.on(s, () => {
    log(`smoke: ${s} received, cleaning up`);
    void finish(1);
  });

// ---- one scenario --------------------------------------------------------------------------------
interface Started {
  name: string;
  /** The ticket ident the dispatch's launch record names. */
  ident: string;
  dir: string;
  repo: string;
  since: string;
  driver: ProcInfo;
  agent: ProcInfo;
  sleep: ProcInfo;
  sleepTag: string;
  r8: { ok: boolean; why: string };
  /** The sleep's parent chain up to the driver, one line per process, as listed at the start. */
  chain: string[];
  /** Everything the driver said (its stderr, or the terminal's text). */
  said: () => string;
  /** How the driver ended, or null if not within `ms`. */
  ended: (ms: number) => Promise<Ended | null>;
  /** Registered groups (a background driver's own). */
  groups: number[];
  pty: Pty | null;
}

let nextSleep = 1;
function makeRepo(dir: string, sleepTag: string): string {
  const repo = join(dir, "repo");
  Bun.spawnSync(["mkdir", "-p", repo]);
  const git = (args: string[]) =>
    Bun.spawnSync(["git", "-c", "user.email=smoke@styre.dev", "-c", "user.name=smoke", ...args], {
      cwd: repo,
      timeout: 30_000,
    });
  git(["init", "-q", "-b", "main"]);
  writeFileSync(
    join(repo, "test.sh"),
    `#!/bin/sh\n# The test suite: slow on purpose. It says its pid, then waits.\necho $$ > .test-pid.tmp && mv .test-pid.tmp .test-pid\nexec sleep ${sleepTag}\n`,
  );
  writeFileSync(join(repo, ".gitignore"), ".test-pid*\n");
  git(["add", "-A"]);
  git(["commit", "-qm", "init"]);
  return repo;
}

function driverEnv(
  root: string,
  repo: string,
  ident: string,
  timeoutMs: number,
): Record<string, string | undefined> {
  return {
    ...process.env,
    XDG_STATE_HOME: stateHome,
    DO_NOT_TRACK: "1",
    SMOKE_ROOT: root,
    SMOKE_REPO: repo,
    SMOKE_MODEL: model,
    SMOKE_TIMEOUT_MS: String(timeoutMs),
    SMOKE_IDENT: ident,
  };
}

/** Start the driver, wait for the agent's sleep, and claim everything. */
async function start(
  name: string,
  root: string,
  how: "background" | "terminal",
  timeoutMs = 600_000,
): Promise<Started> {
  const dir = realpathSync(mkdtempSync(join(work, `${name.replace(/[^a-z0-9]+/gi, "-")}-`)));
  const sleepTag = `97.3${nextSleep++}`;
  const repo = makeRepo(dir, sleepTag);
  const ident = `SMOKE-${nextSleep - 1}`;
  const env = driverEnv(root, repo, ident, timeoutMs);
  const since = nowToken();
  dispatches++;
  let driver: ProcInfo;
  let said: () => string;
  let ended: (ms: number) => Promise<Ended | null>;
  const groups: number[] = [];
  let pty: Pty | null = null;
  if (how === "background") {
    const proc = Bun.spawn([process.execPath, DRIVER], {
      cwd: dir,
      env,
      detached: true, // a new session: the agent stays in this group, which the script registers
      stdin: "ignore",
      stdout: "ignore",
      stderr: "pipe",
    });
    const me = probe(proc.pid);
    const claimed = me.kind === "alive" ? own(me.info)[0] : undefined;
    if (claimed === undefined || !registerGroup(claimed)) {
      proc.kill("SIGKILL");
      throw new Error(`${name}: the driver (pid ${proc.pid}) could not be claimed and registered`);
    }
    groups.push(claimed.pid);
    driver = claimed;
    let text = "";
    void (async () => {
      const dec = new TextDecoder();
      for await (const chunk of proc.stderr) text += dec.decode(chunk, { stream: true });
    })();
    said = () => text;
    ended = async (ms) => {
      const done = await Promise.race([
        proc.exited.then(() => true),
        Bun.sleep(ms).then(() => false),
      ]);
      return done ? { code: proc.exitCode, signal: proc.signalCode } : null;
    };
  } else {
    pty = underPty([process.execPath, DRIVER], { env, cwd: dir });
    ptys.push(pty);
    driver = await pty.command();
    const p = pty;
    said = () => p.output();
    ended = (ms) => p.ended(ms);
  }

  // The sleep: test.sh writes its pid, then becomes the sleep.
  const pidFile = join(repo, ".test-pid");
  let sleepPid = Number.NaN;
  const begun = await until(() => {
    if (existsSync(pidFile)) {
      const t = readFileSync(pidFile, "utf8");
      sleepPid = /^\d+\n$/.test(t) ? Number(t) : Number.NaN;
      if (sleepPid > 1) return true;
    }
    return !isAlive(driver); // the driver ended: no point waiting
  }, START_MS);
  if (!begun || !(sleepPid > 1))
    throw new Error(
      `${name}: the agent never started its test (${isAlive(driver) ? `not within ${START_MS} ms` : "the driver ended first"}); the driver said:\n${said()}`,
    );
  const sleep = ownPrinted(sleepPid, since);
  if (sleep === null)
    throw new Error(`${name}: the test's process (pid ${sleepPid}) could not be claimed`);
  if (!(await until(() => commandOf(sleep) === `sleep ${sleepTag}`, 5_000)))
    throw new Error(`${name}: pid ${sleep.pid} is "${commandOf(sleep)}", not the test's sleep`);
  const table = listProcesses();
  ownTree(pty ? pty.script : driver, table);
  const agent = agentAbove(sleep.pid, driver.pid, table) as ProcInfo | null;
  if (agent === null)
    throw new Error(
      `${name}: no agent between the driver ${driver.pid} and the sleep ${sleep.pid}`,
    );
  const r8 = r8Check(sleep, agent, table);
  const chain: string[] = [];
  for (let p: ProcInfo | undefined = sleep; p !== undefined && p.pid !== driver.pid; ) {
    chain.push(`pid ${p.pid} parent ${p.ppid} group ${p.pgid}: ${commandOf(p) ?? "?"}`);
    const parent: number = p.ppid;
    p = table.find((q) => q.pid === parent);
  }
  return {
    name,
    ident,
    dir,
    repo,
    since,
    driver,
    agent,
    sleep,
    sleepTag,
    r8,
    chain,
    said,
    ended,
    groups,
    pty,
  };
}

/** Watch the agent and the sleep from `t0` until both are gone or the window has passed. */
async function watchStop(
  s: Started,
  t0: number,
): Promise<Pick<Observation, "agentGoneMs" | "sleepGoneMs" | "sleepAliveAtEnd">> {
  let agentGoneMs: number | null = null;
  let sleepGoneMs: number | null = null;
  const end = t0 + STOP_WINDOW_MS + 1_000;
  for (;;) {
    const now = Date.now();
    if (agentGoneMs === null && !isAlive(s.agent)) agentGoneMs = now - t0;
    if (sleepGoneMs === null && !isAlive(s.sleep)) sleepGoneMs = now - t0;
    if ((agentGoneMs !== null && sleepGoneMs !== null) || now >= end) break;
    await Bun.sleep(20);
  }
  return { agentGoneMs, sleepGoneMs, sleepAliveAtEnd: isAlive(s.sleep) };
}

/** What a scenario's action did: the trigger's instant, and anything it read itself. */
interface Acted {
  t0: number;
  extra?: string[];
  /** What Styre said, when it is not the driver's own stderr (`styre ls`). */
  stderr?: string;
  /** The exit to judge, when it is not the driver's. */
  exit?: Ended | null;
  /** Checks that need the driver to have exited first. */
  after?: () => string[];
}

interface Outcome {
  name: string;
  code: "control" | "new";
  agent: number;
  sleep: number;
  r8: string;
  r8ok: boolean;
  chain: string[];
  exit: Ended | null;
  agentGoneMs: number | null;
  sleepGoneMs: number | null;
  failures: string[];
  leakCheck: string[];
}
const outcomes: Outcome[] = [];

/** Run one scenario: start, trigger, observe, judge, clean up, check for leaks. */
async function scenario(
  name: string,
  code: "control" | "new",
  root: string,
  how: "background" | "terminal",
  act: (s: Started) => Promise<Acted>,
  want: ((s: Started) => Expectation) | null,
  timeoutMs?: number,
): Promise<Outcome> {
  let s: Started | null = null;
  const failures: string[] = [];
  let watched: Pick<Observation, "agentGoneMs" | "sleepGoneMs" | "sleepAliveAtEnd"> = {
    agentGoneMs: null,
    sleepGoneMs: null,
    sleepAliveAtEnd: true,
  };
  let exit: Ended | null = null;
  let r8ok = false;
  try {
    s = await start(name, root, how, timeoutMs);
    if (code === "new") {
      const recorded =
        existsSync(recordsDir) &&
        readdirSync(recordsDir).some((n) => n.startsWith(`${s?.agent.pid}-`));
      if (!recorded)
        failures.push(
          `no launch record for the agent in ${recordsDir} (XDG_STATE_HOME not honoured)`,
        );
    }
    log(
      `${name}: agent ${s.agent.pid}, sleep ${s.sleep.pid} ("sleep ${s.sleepTag}"); R8: ${s.r8.why}`,
    );
    log(`${name}: the sleep's parent chain up to the driver:\n  ${s.chain.join("\n  ")}`);
    r8ok = s.r8.ok;
    const acted = await act(s);
    watched = await watchStop(s, acted.t0);
    exit = acted.exit !== undefined ? acted.exit : await s.ended(EXIT_MS);
    failures.push(...(acted.extra ?? []), ...(acted.after?.() ?? []));
    if (want !== null)
      failures.push(...judge(want(s), { exit, ...watched, stderr: acted.stderr ?? s.said() }));
  } catch (err) {
    failures.push(err instanceof Error ? err.message : String(err));
  }
  const leak = await cleanUp(s?.dir ?? null, s?.since ?? null, s?.groups ?? []);
  const o: Outcome = {
    name,
    code,
    agent: s?.agent.pid ?? -1,
    sleep: s?.sleep.pid ?? -1,
    r8: s?.r8.why ?? "",
    r8ok,
    chain: s?.chain ?? [],
    exit,
    agentGoneMs: watched.agentGoneMs,
    sleepGoneMs: watched.sleepGoneMs,
    failures,
    leakCheck: leak.ok ? ["nothing left running"] : leak.lines,
  };
  if (!leak.ok) failures.push(...leak.lines.map((l) => `LEAK: ${l}`));
  outcomes.push(o);
  log(`${name}: leak check: ${o.leakCheck.join("; ")}`);
  log(`${name}: ${failures.length === 0 ? "held" : `FAILED\n  - ${failures.join("\n  - ")}`}`);
  if (s !== null && failures.length > 0) log(`${name}: the driver said:\n${s.said()}`);
  return o;
}

// ---- the run -------------------------------------------------------------------------------------
try {
  // 1. The CLI's version.
  const v = Bun.spawnSync(["claude", "--version"], {
    timeout: 30_000,
    env: { ...process.env, XDG_STATE_HOME: stateHome },
  });
  const version = parseClaudeVersion(v.stdout.toString());
  log(
    `claude --version: ${v.stdout.toString().trim() || v.stderr.toString().trim()}; model ${model}`,
  );
  if (version === null || !versionAtLeast(version, CLAUDE_MIN_CLI_VERSION)) {
    log(
      `FAIL: claude ${version ?? "(not found)"} is older than ${CLAUDE_MIN_CLI_VERSION}, or missing`,
    );
    await finish(1);
  }

  // 2. The control.
  let controlRoot = process.env.SMOKE_CONTROL_ROOT ?? "";
  if (controlRoot === "") {
    mainWorktree = join(work, "main");
    const add = Bun.spawnSync(
      ["git", "-C", ROOT, "worktree", "add", "--quiet", "--detach", mainWorktree, "main"],
      { timeout: 60_000 },
    );
    if (add.exitCode !== 0) throw new Error(`could not check out main: ${add.stderr.toString()}`);
    const inst = Bun.spawnSync([process.execPath, "install", "--frozen-lockfile"], {
      cwd: mainWorktree,
      timeout: 180_000,
      stdout: "pipe",
      stderr: "pipe",
    });
    if (inst.exitCode !== 0)
      throw new Error(`bun install in main's worktree failed: ${inst.stderr.toString()}`);
    controlRoot = mainWorktree;
  }
  log(`control: ${controlRoot}`);
  const control: ControlResult[] = [];
  for (const [name, sig] of [
    ["control kill", "SIGTERM"],
    ["control kill -9", "SIGKILL"],
  ] as const) {
    let alive = { agent: false, sleep: false };
    const o = await scenario(
      name,
      "control",
      controlRoot,
      "background",
      async (s) => {
        const t0 = Date.now();
        if (!signalOwned(s.driver, sig)) throw new Error(`${name}: could not signal the driver`);
        const exit = await s.ended(EXIT_MS);
        // Read at the end of the same 5 s window the new code is held to.
        await until(
          () => !isAlive(s.agent) && !isAlive(s.sleep),
          Math.max(0, t0 + STOP_WINDOW_MS - Date.now()),
        );
        alive = { agent: isAlive(s.agent), sleep: isAlive(s.sleep) };
        return { t0, exit };
      },
      null,
    );
    if (o.failures.length > 0) {
      log(`FAIL: ${name} did not run as a control: ${o.failures.join("; ")}`);
      await finish(1);
    }
    control.push({ name, agentAlive: alive.agent, sleepAlive: alive.sleep });
    const verdict = controlVerdict(control);
    if (verdict.blind) {
      log(`FAIL: probes are blind: the control did not leak (${verdict.why})`);
      await finish(1);
    }
  }

  // 3. The new code.
  const stopped = (s: Started) => stoppedAgent(s.agent.pid);
  await scenario(
    "Ctrl-C",
    "new",
    ROOT,
    "terminal",
    async (s) => {
      const t0 = Date.now();
      s.pty?.type(CTRL_C);
      return { t0 };
    },
    (s) => ({
      exit: { code: null, signal: "SIGINT" },
      lines: [OPENING_INT, stopped(s)],
      absent: [COULD_NOT],
    }),
  );

  await scenario(
    "kill",
    "new",
    ROOT,
    "background",
    async (s) => {
      const t0 = Date.now();
      if (!signalOwned(s.driver, "SIGTERM")) throw new Error("kill: could not signal the driver");
      return { t0 };
    },
    (s) => ({
      exit: { code: null, signal: "SIGTERM" },
      lines: [opening("SIGTERM"), stopped(s)],
      absent: [COULD_NOT],
    }),
  );

  await scenario(
    "kill -9, then styre ls",
    "new",
    ROOT,
    "background",
    async (s) => {
      const extra: string[] = [];
      if (!signalOwned(s.driver, "SIGKILL"))
        throw new Error("kill -9: could not signal the driver");
      const killed = await s.ended(EXIT_MS);
      if (killed?.signal !== "SIGKILL")
        extra.push(`the driver ended ${JSON.stringify(killed)}, not by SIGKILL`);
      // No program can react to SIGKILL: the agent is still running until the next Styre command.
      if (!isAlive(s.agent))
        extra.push(
          "the agent was already gone before `styre ls` ran (the scenario proves nothing)",
        );
      const t0 = Date.now();
      const ls = Bun.spawn([process.execPath, join(ROOT, "src", "index.ts"), "ls"], {
        cwd: s.dir,
        env: {
          ...process.env,
          XDG_STATE_HOME: stateHome,
          XDG_CONFIG_HOME: join(s.dir, "config"),
          DO_NOT_TRACK: "1",
        },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      });
      const timer = setTimeout(() => ls.kill("SIGKILL"), 30_000);
      const [, err] = await Promise.all([
        new Response(ls.stdout).text(),
        new Response(ls.stderr).text(),
        ls.exited,
      ]);
      clearTimeout(timer);
      return { t0, extra, stderr: err, exit: { code: ls.exitCode, signal: ls.signalCode } };
    },
    (s) => ({
      exit: { code: 0, signal: null },
      lines: [
        `styre: stopped an orphaned agent from ${s.ident} (pid ${s.agent.pid}), left running when Styre was force quit`,
      ],
      absent: [COULD_NOT],
    }),
  );

  await scenario(
    "timeout",
    "new",
    ROOT,
    "background",
    async (s) => {
      const said = parseDriver(s.said());
      if (said.dispatchAt === null)
        throw new Error("timeout: the driver never said when the dispatch began");
      // The trigger is the timeout's own instant; the watch runs live from now until 6 s after it.
      const t0 = said.dispatchAt + TIMEOUT_SCENARIO_MS;
      const extra: string[] = [];
      if (Date.now() > t0 - 2_000)
        extra.push("the sleep started too close to the timeout; raise TIMEOUT_SCENARIO_MS");
      const after = (): string[] => {
        const r = parseDriver(s.said()).result;
        return r?.timedOut === true
          ? []
          : [`the dispatch returned ${JSON.stringify(r)}, not a timeout`];
      };
      return { t0, extra, after };
    },
    () => ({ exit: { code: 0, signal: null }, lines: [], absent: [COULD_NOT] }),
    TIMEOUT_SCENARIO_MS,
  );

  await scenario(
    "Ctrl-\\",
    "new",
    ROOT,
    "terminal",
    async (s) => {
      const t0 = Date.now();
      s.pty?.type(CTRL_BACKSLASH);
      return { t0 };
    },
    (s) => ({ exit: { code: null, signal: "SIGQUIT" }, lines: [], reportSleep: s.sleep.pid }),
  );

  log(JSON.stringify({ claude: version, model, outcomes }, null, 2));
  const failed = outcomes.filter((o) => o.failures.length > 0);
  const r8 = outcomes.filter((o) => !o.r8ok);
  if (r8.length > 0)
    log(
      `FAIL: R8 (the agent's command group is led by its direct child) did not hold in: ${r8.map((o) => `${o.name} (${o.r8})`).join("; ")}`,
    );
  if (failed.length > 0 || r8.length > 0) {
    if (failed.length > 0)
      log(`FAIL: ${failed.map((o) => `${o.name}: ${o.failures.join("; ")}`).join("\n      ")}`);
    await finish(1);
  }
  log("PASS: control leaked (probes can see failure); every scenario held");
  await finish(0);
} catch (err) {
  log(`FAIL: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
  await finish(1);
}

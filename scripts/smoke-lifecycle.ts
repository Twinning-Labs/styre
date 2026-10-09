// Live lifecycle smoke (ENG-485 Task 16 and the final fix wave, spec 11.2, 11.3 and 11.4; NOT run in
// CI on every PR): repeats the design's experiment (spec 2.1) with the REAL `claude` CLI and checks,
// by outcome, that a stopped Styre leaves no agent and no agent command running. Requires the
// `claude` CLI installed and authenticated. Each agent scenario is one real agent dispatch, which
// costs money: seventeen per full run on the cheap model (the suite scenarios dispatch nothing).
//
// Usage: bun run scripts/smoke-lifecycle.ts --live|--standin [--model <claude model>]
//   (model default: claude-haiku-4-5-20251001). The mode is required: with none, or with any argument
//   the script does not know, it prints the usage and exits 64 before anything runs.
//
// --standin is the free mode: every driver runs test/lifecycle/fixtures/standin-claude.sh (no network,
// no model) by its absolute path, and a refusing `claude` sits first on PATH for every process the
// script starts, so a lookup by name can never reach the real CLI: the run fails if the refusing one
// was called, or if an agent's command line is not the stand-in's (behind a wrapper, the wrapper's
// child must be the stand-in). The whole run, the controls, every scenario, the leak checks and
// D13's leftover report (the stand-in dies at once on SIGQUIT) cost nothing. Run it before every
// live run. SMOKE_STANDIN_QUIT, SMOKE_STANDIN_PARENT and SMOKE_STANDIN_TEST change the stand-in (see
// its header); SMOKE_START_MS shortens the wait for the test to start.
//
// Each scenario makes a throwaway git repository whose test suite is slow (`test.sh` writes its
// pid, then becomes `sleep 97.3<n>`), and runs scripts/smoke-lifecycle-driver.ts: Styre's stop
// handling around one dispatch through the real Claude adapter, with the design's prompt and the
// tools ["Read", "Bash(sh:*)"], or around the suite itself through runBoundedCommand (a verify
// step's command group). Once the test's sleep is running, the scenario stops Styre.
//
//   1. It records `claude --version` (at least 2.1.280), and in every agent scenario the sleep's
//      parent chain and R8 (spec 6.1, amended 2026-10-08): the agent's direct child (behind a
//      wrapper, the real CLI's) leads the command group, and every process on the chain sits in a
//      group led by a process on the chain.
//   2. CONTROL: the branch baseline/pre-eng-485 (main before ENG-485, operator decision), exported
//      with `git archive` into the script's temporary folder (no worktree is registered, so a crash
//      leaves nothing in the repository). The run refuses loudly if the branch is missing or has
//      src/util/process/signals.ts, and the control's driver must say it installed no stop handlers
//      (the new code's, that it did). Each control must leak what the old code leaks (spec 2.1);
//      if one does not, the probes cannot see a failure: it prints "probes are blind" and exits 1.
//      ($SMOKE_CONTROL_ROOT names other code to use as the control.) The controls:
//        - `kill`, and `kill -9`: the agent and its sleep keep running; after `kill -9` the old
//          `styre ls`, `styre run --resume`, `styre run --fresh` and `styre clean` leave them so;
//        - a wrapper's dispatch timeout: the old code signalled the wrapper only, so the real CLI
//          and the sleep keep running;
//        - the startup refusal: the old code killed the CLI only, so its child keeps running;
//        - `kill` during a verify suite: the suite's group keeps running.
//      Closing the terminal, a second Ctrl-C and Ctrl-C through a wrapper have no control: a real
//      shell sends its hangup, and a terminal sends Ctrl-C, to the whole foreground group, where the
//      agent is too (D4), so the CLI hears them itself without Styre; and the old code has no stop
//      to force.
//   3. NEW CODE, each judged by `judge()` (the exit, the agent and its sleep, and anything else
//      named, gone within 5 s of the trigger, the expected lines, the forbidden lines):
//        - Ctrl-C (typed into a real terminal), `kill`, a dispatch timeout, Ctrl-\ (the sleep may
//          outlive the stop but must then be reported with D13's exact leftover line);
//        - a wrapper that runs the CLI as a child (not `exec`), under Ctrl-C and under a timeout:
//          the wrapper, the real CLI and the sleep all gone;
//        - a closed terminal (the pty helper's real close: SIGHUP, 129), read from a copy of
//          Styre's stderr since the terminal is gone;
//        - a second Ctrl-C while the stop waits for a wrapper that ignores the polite stop and
//          outlives its CLI: the forcing line, the exit still SIGINT, and the wrapper gone well
//          inside the 5 s grace period;
//        - the startup refusal (ENG-476): a CLI started with a wider tool set than the step allows,
//          holding a command of its own: the refusal's forced stop ends both;
//        - `kill` during a verify suite (runBoundedCommand, a real command group with a background
//          child): the whole group gone;
//        - `kill -9`, then each of `styre ls`, `styre run --resume`, `styre run --fresh` and
//          `styre clean`: each stops the orphan first (its sweep line comes before its own
//          refusal), then ends with its documented status.
//
// Safety. Every process here is the script's own (test/helpers/own-processes.ts): a driver started
// in the background leads a new session that the script registers, so the agent, which stays in
// the driver's group, remains claimable after the driver dies; the agent's command and its sleep
// are claimed by descent before any stop. Nothing is found by its command text, and nothing is
// signalled that was not claimed. After every scenario the members of the driver's group are
// claimed and asked to stop (so a driver that died before its tree was claimed leaves no agent
// running), everything claimed is stopped, and the scenario fails loudly if any claimed process,
// any member of the driver's group, or any process working in the scenario's folder is still
// running. Every Styre process gets a state folder of the script's own (XDG_STATE_HOME), and the
// run fails if a launch record appears in the real ~/.local/state/styre-processes. The follow-up
// commands get a config folder of the scenario's own and no tracker, forge or provider keys. A
// SIGKILL of the smoke itself skips all of this: background drivers then keep running in their own
// sessions.
import {
  type FSWatcher,
  existsSync,
  mkdirSync,
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
  BASELINE_REFS,
  type ControlResult,
  type Ended,
  type Expectation,
  type Observation,
  SIGNALS_FILE,
  SMOKE_USAGE,
  STOP_WINDOW_MS,
  agentAbove,
  baselineProblem,
  controlVerdict,
  handlersProblem,
  judge,
  parseClaudeVersion,
  parseDriver,
  parseSmokeArgs,
  r8Check,
  versionAtLeast,
} from "./lifecycle-live.ts";

// The arguments first, before anything is created or run (N1): no mode, or anything unknown, ends here.
const parsed = parseSmokeArgs(process.argv.slice(2));
if ("error" in parsed) {
  process.stderr.write(`smoke-lifecycle: ${parsed.error}\n${SMOKE_USAGE}\n`);
  process.exit(64);
}
const standin = parsed.mode === "standin";
const model = parsed.model;
const ROOT = realpathSync(join(import.meta.dir, ".."));
const DRIVER = join(ROOT, "scripts", "smoke-lifecycle-driver.ts");
/** How long the agent may take to start its test (CLI start, one model call, one tool call). */
const START_MS = Number(process.env.SMOKE_START_MS ?? 120_000);
/** The dispatch timeout of the timeout scenarios: long enough for the sleep to start first. */
const TIMEOUT_SCENARIO_MS = 60_000;
/** How long a stopped driver may take to exit: the handler's 6.5 s deadline, and some room. */
const EXIT_MS = 15_000;
/** When the second Ctrl-C is typed, after the first. */
const SECOND_PRESS_MS = 1_000;
/** How soon after the first Ctrl-C a forced stop must have ended the wrapper that ignores the
 *  polite stop: well inside the 5 s grace period, which only a forced stop cuts short. */
const FORCED_BY_MS = 3_000;

const OPENING_INT =
  "styre: stopping — cleaning up the agent and its commands before exiting (up to 5s; press Ctrl-C again to force)…";
const FORCING = "styre: forcing stop…";
const opening = (sig: string): string => `styre: received a stop request (${sig}) — cleaning up…`;
const stoppedAgent = (pid: number): RegExp =>
  new RegExp(`^styre: stopped the agent \\(pid ${pid}\\) and \\d+ of its commands\\.$`, "m");
const COULD_NOT = /^styre: could not (?:stop|confirm)/m;
const STARTUP_FALLBACK = /^styre: could not stop the agent's process tree at startup/m;
const orphanLine = (ident: string, pid: number): string =>
  `styre: stopped an orphaned agent from ${ident} (pid ${pid}), left running when Styre was force quit`;
/** The ENG-476 refusal's own words, at the start of the dispatch's fault. */
const REFUSED = "stopped at startup: ";

const log = (s: string): void => {
  process.stderr.write(`${s}\n`);
};

// ---- the script's own folders, before anything starts -------------------------------------------
const work = realpathSync(mkdtempSync(join(tmpdir(), "styre-smoke-lifecycle-")));
const stateHome = join(work, "state");
process.env.XDG_STATE_HOME = stateHome;
const recordsDir = join(stateHome, "styre-processes");
/** The agent CLI every driver runs: the stand-in, by absolute path, in the free mode. */
const STANDIN = join(ROOT, "test", "lifecycle", "fixtures", "standin-claude.sh");
const CLAUDE = standin ? STANDIN : "claude";
/** Free mode: every call of a `claude` found by name lands here, is recorded, and is refused. */
const refusedLog = join(work, "refused-claude.log");
if (standin) {
  const shim = join(work, "refusing-bin");
  mkdirSync(shim);
  writeFileSync(
    join(shim, "claude"),
    `#!/bin/sh\nprintf '%s\\n' "$*" >>'${refusedLog}'\necho "refused: the free mode never runs the real claude" >&2\nexit 1\n`,
    { mode: 0o755 },
  );
  process.env.PATH = `${shim}:${process.env.PATH ?? "/usr/bin:/bin"}`;
}
/** A wrapper around the agent CLI that runs it as a child, never by `exec` (spec 2.2): the shape of
 *  the ticket's original finding. Its own status is the CLI's. */
const WRAPPER = join(work, "wrapper-claude.sh");
writeFileSync(
  WRAPPER,
  `#!/bin/bash\n# Runs the agent CLI as a child, not by exec.\n'${CLAUDE}' "$@"\nexit $?\n`,
  { mode: 0o755 },
);

/** A wrapper that is slow to stop: it runs the agent CLI as a child, answers SIGINT, SIGTERM and
 *  SIGHUP with nothing, and keeps running once the CLI has ended (for at most a minute), so a
 *  polite stop waits out the whole grace period for it unless a second Ctrl-C forces the stop. */
const STUBBORN_WRAPPER = join(work, "stubborn-wrapper-claude.sh");
writeFileSync(
  STUBBORN_WRAPPER,
  `#!/bin/bash
# Slow to stop: deaf to a polite stop, and still running after its CLI.
trap ':' INT TERM HUP
'${CLAUDE}' "$@"
n=0
while [ $n -lt 300 ]; do sleep 0.2; n=$((n + 1)); done
`,
  { mode: 0o755 },
);

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
  // A driver that died before its tree was claimed leaves its agent in the driver's group (the
  // agent is never spawned detached, D4): claim the group's members (rule 2) and ask them to stop,
  // so the agent stops its own commands, before everything claimed is killed.
  const members = own(
    ...listProcesses().filter((p) => groups.includes(p.pgid) && p.state !== "zombie"),
  );
  for (const p of members) signalOwned(p, "SIGTERM");
  if (members.length > 0) await until(() => members.every((p) => !isAlive(p)), STOP_WINDOW_MS);
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
    if (standin && existsSync(refusedLog)) {
      const calls = readFileSync(refusedLog, "utf8").split("\n").filter(Boolean).length;
      log(
        `FAIL: the free mode looked up \`claude\` by name ${calls} time(s); the refusing one answered, so the real CLI was not run`,
      );
      code = 1;
    }
    const written = realRecordsWritten();
    if (written.length > 0) {
      log(`FAIL: launch records were written into the real ${realDir}: ${written.join(", ")}`);
      code = 1;
    }
    rmSync(work, { recursive: true, force: true });
    log(
      standin
        ? `claude dispatches started: 0 (free mode: ${dispatches} runs of the stand-in)`
        : `claude dispatches started: ${dispatches}`,
    );
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
/** What a scenario's test suite does (test.sh). */
type TestKind =
  /** writes its pid, then becomes `sleep 97.3<n>` */
  | "plain"
  /** starts a background `sleep 98.3<n>` first (a suite's background child), then as plain */
  | "suite";

interface StartOpts {
  how: "background" | "terminal";
  /** agent: one dispatch (the default); suite: runBoundedCommand on the suite, no agent. */
  mode?: "agent" | "suite";
  test?: TestKind;
  /** Run the CLI behind WRAPPER (as a child, not by exec), or behind STUBBORN_WRAPPER. */
  wrapped?: boolean | "stubborn";
  /** The startup refusal's CLI: a command of its own first, then the CLI with a wider tool set. */
  refusal?: boolean;
  /** Keep a copy of the driver's stderr in a file, and read what it said from there. */
  log?: boolean;
  timeoutMs?: number;
}

interface Started {
  name: string;
  /** The ticket ident the dispatch's launch record names. */
  ident: string;
  dir: string;
  repo: string;
  since: string;
  driver: ProcInfo;
  /** What Styre launched: the agent (or the wrapper, or the suite's shell). */
  agent: ProcInfo;
  /** Behind a wrapper: the real CLI, the wrapper's child. */
  cli: ProcInfo | null;
  sleep: ProcInfo;
  sleepTag: string;
  /** Other processes that must be gone with the rest, by name (the real CLI, a background child). */
  others: { name: string; proc: ProcInfo }[];
  /** The CLI the driver was given (SMOKE_CLAUDE). */
  claude: string;
  /** The startup refusal's go file: the CLI starts once it exists. */
  go: string | null;
  r8: { ok: boolean; why: string };
  /** The sleep's parent chain up to the driver, one line per process, as listed at the start. */
  chain: string[];
  /** Everything the driver said (its stderr, the terminal's text, or the copy of its stderr). */
  said: () => string;
  /** How the driver ended, or null if not within `ms`. */
  ended: (ms: number) => Promise<Ended | null>;
  /** Registered groups (a background driver's own). */
  groups: number[];
  pty: Pty | null;
}

let nextSleep = 1;
function makeRepo(dir: string, sleepTag: string, test: TestKind): string {
  const repo = join(dir, "repo");
  Bun.spawnSync(["mkdir", "-p", repo]);
  const git = (args: string[]) =>
    Bun.spawnSync(["git", "-c", "user.email=smoke@styre.dev", "-c", "user.name=smoke", ...args], {
      cwd: repo,
      timeout: 30_000,
    });
  git(["init", "-q", "-b", "main"]);
  const pid = "echo $$ > .test-pid.tmp && mv .test-pid.tmp .test-pid";
  const body =
    test === "suite"
      ? `# The test suite: slow on purpose. It starts a background child, says both pids, then waits.\nsleep 9${sleepTag} &\necho $! > .bg-pid.tmp && mv .bg-pid.tmp .bg-pid\n${pid}\nexec sleep ${sleepTag}\n`
      : `# The test suite: slow on purpose. It says its pid, then waits.\n${pid}\nexec sleep ${sleepTag}\n`;
  writeFileSync(join(repo, "test.sh"), `#!/bin/sh\n${body}`);
  writeFileSync(join(repo, ".gitignore"), ".test-pid*\n.bg-pid*\n");
  git(["add", "-A"]);
  git(["commit", "-qm", "init"]);
  return repo;
}

/** The startup refusal's CLI (ENG-476): it starts a command of its own (in a group of its own, as a
 *  tool's would be), waits until the smoke has claimed it, then becomes the agent CLI (exec), which
 *  inherits the command as its child, with a wider tool set than the step allows: the adapter's
 *  startup gate refuses the CLI's first report and stops the whole tree at once. */
function refusalCli(dir: string, sleepTag: string, go: string): string {
  const path = join(dir, "refusing-claude.sh");
  writeFileSync(
    path,
    `#!/bin/bash
case "$1" in --version | --help) exec '${CLAUDE}' "$@" ;; esac
set -m
sh -c 'echo $$ > .test-pid.tmp && mv .test-pid.tmp .test-pid; exec sleep ${sleepTag}' &
n=0
until [ -e '${go}' ] || [ $n -ge 1200 ]; do sleep 0.05; n=$((n + 1)); done
# Never start the CLI unattended: without the smoke's go, stop the command and end.
if [ ! -e '${go}' ]; then kill -TERM -$! 2>/dev/null; exit 1; fi
args=()
while [ $# -gt 0 ]; do
  if [ "$1" = --tools ]; then args+=(--tools "$2,Write"); shift 2; continue; fi
  args+=("$1")
  shift
done
exec '${CLAUDE}' "\${args[@]}"
`,
    { mode: 0o755 },
  );
  return path;
}

/** A project profile for the follow-up commands: one component whose build tool is missing, so a
 *  fresh run refuses at its toolchain check (exit 69) before any agent or tracker. */
function writeProfile(s: Started): string {
  const path = join(s.dir, "profile.json");
  writeFileSync(
    path,
    JSON.stringify({
      slug: "smoke",
      targetRepo: s.repo,
      defaultBranch: "main",
      components: [
        {
          name: "app",
          kind: "node",
          paths: ["**"],
          commands: {
            build: "styre-smoke-absent-tool build",
            test: { unavailable: true },
            check: { unavailable: true },
          },
        },
      ],
    }),
  );
  return path;
}

/** The environment of a follow-up Styre command: the script's state folder, a config folder of the
 *  scenario's own, and no tracker, forge or provider key, so nothing can reach a service. */
function followEnv(s: Started): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {
    ...process.env,
    XDG_STATE_HOME: stateHome,
    XDG_CONFIG_HOME: join(s.dir, "config"),
    DO_NOT_TRACK: "1",
  };
  for (const k of [
    "LINEAR_API_KEY",
    "JIRA_API_TOKEN",
    "JIRA_EMAIL",
    "GITHUB_TOKEN",
    "GH_TOKEN",
    "ANTHROPIC_API_KEY",
    "OPENAI_API_KEY",
  ])
    delete env[k];
  return env;
}

/** Run one Styre command of the code at `root` after a force quit, bounded, and read what it said. */
async function styreCommand(
  root: string,
  s: Started,
  args: string[],
  cwd: string,
): Promise<{ stderr: string; exit: Ended }> {
  const p = Bun.spawn([process.execPath, join(root, "src", "index.ts"), ...args], {
    cwd,
    env: followEnv(s),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const timer = setTimeout(() => p.kill("SIGKILL"), 30_000);
  const [, err] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
    p.exited,
  ]);
  clearTimeout(timer);
  return { stderr: err, exit: { code: p.exitCode, signal: p.signalCode } };
}

function driverEnv(
  root: string,
  repo: string,
  ident: string,
  timeoutMs: number,
  extra: Record<string, string>,
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
    ...extra,
  };
}

/** What a scenario knows about its driver so far. */
interface Known {
  dir: string | null;
  since: string | null;
  groups: number[];
}

/** Start the driver, wait for the test's sleep, and claim everything. */
async function start(name: string, root: string, o: StartOpts, known: Known): Promise<Started> {
  const mode = o.mode ?? "agent";
  const test = o.test ?? (mode === "suite" ? "suite" : "plain");
  const dir = realpathSync(mkdtempSync(join(work, `${name.replace(/[^a-z0-9]+/gi, "-")}-`)));
  known.dir = dir;
  const sleepTag = `97.3${nextSleep++}`;
  const repo = makeRepo(dir, sleepTag, test);
  const ident = `SMOKE-${nextSleep - 1}`;
  const go = o.refusal ? join(dir, "go") : null;
  const claude =
    go !== null
      ? refusalCli(dir, sleepTag, go)
      : o.wrapped === "stubborn"
        ? STUBBORN_WRAPPER
        : o.wrapped
          ? WRAPPER
          : CLAUDE;
  const logFile = o.log ? join(dir, "driver-stderr.log") : null;
  const env = driverEnv(root, repo, ident, o.timeoutMs ?? 600_000, {
    SMOKE_CLAUDE: claude,
    SMOKE_MODE: mode,
    ...(logFile !== null ? { SMOKE_LOG: logFile } : {}),
  });
  const since = nowToken();
  known.since = since;
  if (mode === "agent") dispatches++;
  let driver: ProcInfo;
  let said: () => string;
  let ended: (ms: number) => Promise<Ended | null>;
  const groups = known.groups;
  let pty: Pty | null = null;
  if (o.how === "background") {
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
    // The terminal echoes the keystroke (`^C`, `^\`) in front of whatever is written next.
    said = () => p.output().replace(/\^[C\\]/g, "");
    ended = (ms) => p.ended(ms);
  }
  if (logFile !== null) said = () => (existsSync(logFile) ? readFileSync(logFile, "utf8") : "");

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
  const others: { name: string; proc: ProcInfo }[] = [];
  if (test === "suite") {
    const bg = Number(readFileSync(join(repo, ".bg-pid"), "utf8"));
    const child = ownPrinted(bg, since);
    if (child === null || commandOf(child) !== `sleep 9${sleepTag}`)
      throw new Error(`${name}: the suite's background child (pid ${bg}) could not be claimed`);
    others.push({ name: "background child", proc: child });
  }
  const table = listProcesses();
  ownTree(pty ? pty.script : driver, table);
  const agent = agentAbove(sleep.pid, driver.pid, table) as ProcInfo | null;
  if (agent === null)
    throw new Error(
      `${name}: no ${mode === "suite" ? "suite" : "agent"} between the driver ${driver.pid} and the sleep ${sleep.pid}`,
    );
  // Behind a wrapper, the real CLI is the wrapper's child on the sleep's chain.
  let cli: ProcInfo | null = null;
  if (o.wrapped) {
    for (let p = table.find((q) => q.pid === sleep.pid); p !== undefined; ) {
      if (p.ppid === agent.pid) {
        cli = p;
        break;
      }
      const parent = p.ppid;
      p = table.find((q) => q.pid === parent);
    }
    if (cli === null)
      throw new Error(`${name}: no real CLI between the wrapper ${agent.pid} and the sleep`);
    others.push({ name: "real CLI", proc: cli });
  }
  if (standin && mode === "agent") {
    // The process that must be the stand-in: the agent itself, or the wrapper's child. The startup
    // refusal's CLI is this script's own file, which becomes the stand-in once it is told to go.
    const checked = cli ?? agent;
    const cmd = commandOf(checked) ?? "";
    const want = go !== null ? claude : STANDIN;
    if (!cmd.includes(want))
      throw new Error(
        `${name}: free mode, but the ${cli ? "wrapper's child" : "agent"} (pid ${checked.pid}) is "${cmd}", not ${go !== null ? "the refusal's CLI" : "the stand-in"}`,
      );
  }
  const r8 =
    mode === "suite"
      ? sleep.pgid === agent.pid && agent.pgid === agent.pid
        ? {
            ok: true,
            why: `a command group: the suite runs in group ${agent.pid}, led by its shell`,
          }
        : {
            ok: false,
            why: `the suite's sleep is in group ${sleep.pgid}, its shell ${agent.pid} in ${agent.pgid}`,
          }
      : r8Check(sleep, cli ?? agent, table);
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
    cli,
    sleep,
    sleepTag,
    others,
    claude,
    go,
    r8,
    chain,
    said,
    ended,
    groups,
    pty,
  };
}

type Watched = Pick<Observation, "agentGoneMs" | "sleepGoneMs" | "alsoGoneMs">;

/** Watch the agent, the sleep and the others from `t0` until all are gone or the window has passed. */
async function watchStop(s: Started, t0: number): Promise<Watched> {
  let agentGoneMs: number | null = null;
  let sleepGoneMs: number | null = null;
  const alsoGoneMs: Record<string, number | null> = {};
  for (const o of s.others) alsoGoneMs[o.name] = null;
  const end = t0 + STOP_WINDOW_MS + 1_000;
  for (;;) {
    const now = Date.now();
    if (agentGoneMs === null && !isAlive(s.agent)) agentGoneMs = now - t0;
    if (sleepGoneMs === null && !isAlive(s.sleep)) sleepGoneMs = now - t0;
    for (const o of s.others)
      if (alsoGoneMs[o.name] === null && !isAlive(o.proc)) alsoGoneMs[o.name] = now - t0;
    const allGone =
      agentGoneMs !== null &&
      sleepGoneMs !== null &&
      Object.values(alsoGoneMs).every((v) => v !== null);
    if (allGone || now >= end) break;
    await Bun.sleep(20);
  }
  return { agentGoneMs, sleepGoneMs, alsoGoneMs };
}

/** What a scenario's action did: the trigger's instant, and anything it read itself. */
interface Acted {
  t0: number;
  extra?: string[];
  /** What Styre said, when it is not the driver's own stderr (a follow-up command). */
  stderr?: string;
  /** The exit to judge, when it is not the driver's. */
  exit?: Ended | null;
  /** Checks that need the driver to have exited first. */
  after?: () => string[];
  /** Checks on the watch's own times (a forced stop's speed). */
  timing?: (w: Watched) => string[];
}

interface Outcome {
  name: string;
  code: "control" | "new";
  agent: number;
  sleep: number;
  others: Record<string, number>;
  r8: string;
  r8ok: boolean;
  chain: string[];
  exit: Ended | null;
  agentGoneMs: number | null;
  sleepGoneMs: number | null;
  alsoGoneMs: Record<string, number | null>;
  failures: string[];
  leakCheck: string[];
  /** What Styre said (its `styre:` lines). */
  styreSaid: string[];
}
const outcomes: Outcome[] = [];

/** Run one scenario: start, trigger, observe, judge, clean up, check for leaks. */
async function scenario(
  name: string,
  code: "control" | "new",
  root: string,
  opts: StartOpts,
  act: (s: Started) => Promise<Acted>,
  want: ((s: Started) => Expectation) | null,
): Promise<Outcome> {
  let s: Started | null = null;
  const known: Known = { dir: null, since: null, groups: [] };
  const failures: string[] = [];
  let watched: Watched = { agentGoneMs: null, sleepGoneMs: null, alsoGoneMs: {} };
  let exit: Ended | null = null;
  let r8ok = false;
  let styreText = "";
  try {
    s = await start(name, root, opts, known);
    const handlers = handlersProblem(code, parseDriver(s.said()).handlers);
    if (handlers !== null) failures.push(handlers);
    if (
      (opts.mode ?? "agent") === "agent" &&
      !s.said().split("\n").includes(`smoke-driver: claude ${s.claude}`)
    )
      failures.push(`the driver did not run ${s.claude}`);
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
      `${name}: agent ${s.agent.pid}${s.cli ? `, real CLI ${s.cli.pid}` : ""}, sleep ${s.sleep.pid} ("sleep ${s.sleepTag}")${s.others.length > 0 ? `, ${s.others.map((o) => `${o.name} ${o.proc.pid}`).join(", ")}` : ""}; R8: ${s.r8.why}`,
    );
    log(`${name}: the sleep's parent chain up to the driver:\n  ${s.chain.join("\n  ")}`);
    r8ok = s.r8.ok;
    const acted = await act(s);
    watched = await watchStop(s, acted.t0);
    exit = acted.exit !== undefined ? acted.exit : await s.ended(EXIT_MS);
    failures.push(
      ...(acted.extra ?? []),
      ...(acted.after?.() ?? []),
      ...(acted.timing?.(watched) ?? []),
    );
    styreText = acted.stderr ?? s.said();
    if (want !== null) failures.push(...judge(want(s), { exit, ...watched, stderr: styreText }));
  } catch (err) {
    failures.push(err instanceof Error ? err.message : String(err));
  }
  const leak = await cleanUp(known.dir, known.since, known.groups);
  const o: Outcome = {
    name,
    code,
    agent: s?.agent.pid ?? -1,
    sleep: s?.sleep.pid ?? -1,
    others: Object.fromEntries((s?.others ?? []).map((x) => [x.name, x.proc.pid])),
    r8: s?.r8.why ?? "",
    r8ok,
    chain: s?.chain ?? [],
    exit,
    agentGoneMs: watched.agentGoneMs,
    sleepGoneMs: watched.sleepGoneMs,
    alsoGoneMs: watched.alsoGoneMs ?? {},
    failures,
    leakCheck: leak.ok ? ["nothing left running"] : leak.lines,
    styreSaid: styreText.split("\n").filter((l) => l.startsWith("styre")),
  };
  if (!leak.ok) failures.push(...leak.lines.map((l) => `LEAK: ${l}`));
  outcomes.push(o);
  log(`${name}: leak check: ${o.leakCheck.join("; ")}`);
  log(`${name}: ${failures.length === 0 ? "held" : `FAILED\n  - ${failures.join("\n  - ")}`}`);
  if (s !== null && failures.length > 0) log(`${name}: the driver said:\n${s.said()}`);
  return o;
}

// ---- triggers shared by the control and the new code ---------------------------------------------
/** A dispatch timeout: the trigger is the timeout's own instant, watched live until 6 s after it. */
function timeoutAct(s: Started): Acted {
  const said = parseDriver(s.said());
  if (said.dispatchAt === null)
    throw new Error(`${s.name}: the driver never said when the dispatch began`);
  const t0 = said.dispatchAt + TIMEOUT_SCENARIO_MS;
  const extra: string[] = [];
  if (Date.now() > t0 - 2_000)
    extra.push("the sleep started too close to the timeout; raise TIMEOUT_SCENARIO_MS");
  return { t0, extra };
}
/** Wait until `t0` has come (a timeout's instant), then until the end of the stop window. */
async function waitWindow(t0: number, done: () => boolean): Promise<void> {
  await until(() => Date.now() >= t0, Math.max(0, t0 - Date.now() + 1_000));
  await until(done, Math.max(0, t0 + STOP_WINDOW_MS - Date.now()));
}

// ---- the run -------------------------------------------------------------------------------------
try {
  // 1. The CLI's version.
  const v = Bun.spawnSync([CLAUDE, "--version"], {
    timeout: 30_000,
    env: { ...process.env, XDG_STATE_HOME: stateHome },
  });
  const version = parseClaudeVersion(v.stdout.toString());
  log(
    `claude --version: ${v.stdout.toString().trim() || v.stderr.toString().trim()}; model ${model}`,
  );
  if (standin && !v.stdout.toString().includes("stand-in")) {
    log(`FAIL: the free mode is not running the stand-in (${CLAUDE}); no dispatch was started`);
    await finish(1);
  }
  if (version === null || !versionAtLeast(version, CLAUDE_MIN_CLI_VERSION)) {
    log(
      `FAIL: claude ${version ?? "(not found)"} is older than ${CLAUDE_MIN_CLI_VERSION}, or missing`,
    );
    await finish(1);
  }

  // 2. The control.
  let controlRoot = process.env.SMOKE_CONTROL_ROOT ?? "";
  if (controlRoot === "") {
    const git = (a: string[]) => Bun.spawnSync(["git", "-C", ROOT, ...a], { timeout: 60_000 });
    const ref =
      BASELINE_REFS.find((r) => git(["rev-parse", "--verify", "--quiet", r]).exitCode === 0) ??
      null;
    const hasSignals =
      ref !== null && git(["cat-file", "-e", `${ref}:${SIGNALS_FILE}`]).exitCode === 0;
    const problem = baselineProblem(ref, hasSignals);
    if (problem !== null) {
      log(`FAIL: the control's code: ${problem}`);
      await finish(1);
    }
    // Exported, not checked out: no worktree is registered in the repository.
    controlRoot = join(work, "baseline");
    mkdirSync(controlRoot);
    const sha = git(["rev-parse", `${ref}^{commit}`])
      .stdout.toString()
      .trim();
    const out = Bun.spawnSync(
      [
        "sh",
        "-c",
        'git -C "$1" archive --format=tar "$2" | tar -x -C "$3"',
        "sh",
        ROOT,
        sha,
        controlRoot,
      ],
      { timeout: 120_000, stderr: "pipe" },
    );
    if (out.exitCode !== 0) throw new Error(`could not export ${ref}: ${out.stderr.toString()}`);
    const inst = Bun.spawnSync([process.execPath, "install", "--frozen-lockfile"], {
      cwd: controlRoot,
      timeout: 180_000,
      stdout: "pipe",
      stderr: "pipe",
    });
    if (inst.exitCode !== 0)
      throw new Error(`bun install in the baseline failed: ${inst.stderr.toString()}`);
    log(`control: ${ref} at ${sha}`);
  }
  log(`control: ${controlRoot}`);
  const control: ControlResult[] = [];
  /** Run one control scenario, read what is still running at the end of its window, and stop the
   *  whole run at once if the control did not leak what the old code leaks. */
  const controlScenario = async (
    name: string,
    opts: StartOpts,
    trigger: (s: Started) => Promise<{ t0: number; exit?: Ended | null }>,
    leaks: ControlResult["leaks"],
    then?: (s: Started) => Promise<string[]>,
  ): Promise<void> => {
    let alive = { agent: false, sleep: false, cli: false };
    const o = await scenario(
      name,
      "control",
      controlRoot,
      opts,
      async (s) => {
        const { t0, exit } = await trigger(s);
        // Read at the end of the same 5 s window the new code is held to.
        const done = () =>
          !isAlive(s.agent) && !isAlive(s.sleep) && (s.cli === null || !isAlive(s.cli));
        await waitWindow(t0, done);
        alive = {
          agent: isAlive(s.agent),
          sleep: isAlive(s.sleep),
          cli: s.cli !== null && isAlive(s.cli),
        };
        const extra = then ? await then(s) : [];
        return { t0, exit: exit === undefined ? await s.ended(EXIT_MS) : exit, extra };
      },
      null,
    );
    if (o.failures.length > 0) {
      log(`FAIL: ${name} did not run as a control: ${o.failures.join("; ")}`);
      await finish(1);
    }
    control.push({
      name,
      agentAlive: alive.agent,
      sleepAlive: alive.sleep,
      cliAlive: alive.cli,
      ...(leaks !== undefined ? { leaks } : {}),
    });
    const verdict = controlVerdict(control);
    if (verdict.blind) {
      log(`FAIL: probes are blind: the control did not leak (${verdict.why})`);
      await finish(1);
    }
  };
  const signalDriver = (sig: NodeJS.Signals) => async (s: Started) => {
    const t0 = Date.now();
    if (!signalOwned(s.driver, sig)) throw new Error(`${s.name}: could not signal the driver`);
    return { t0, exit: await s.ended(EXIT_MS) };
  };

  await controlScenario("control kill", { how: "background" }, signalDriver("SIGTERM"), undefined);
  // After a force quit, none of the old commands stops the orphan.
  await controlScenario(
    "control kill -9",
    { how: "background" },
    signalDriver("SIGKILL"),
    undefined,
    async (s) => {
      const profile = writeProfile(s);
      const extra: string[] = [];
      for (const args of [
        ["ls"],
        ["run", "--resume", s.ident, "--profile", profile],
        ["run", s.ident, "--fresh", "--profile", profile],
        ["clean", s.ident, "--profile", profile],
      ]) {
        const r = await styreCommand(controlRoot, s, args, s.repo);
        const still = isAlive(s.agent) && isAlive(s.sleep);
        log(
          `control kill -9: the old \`styre ${args.join(" ")}\` exited ${JSON.stringify(r.exit)}; the agent and its sleep ${still ? "still run" : "are gone"}`,
        );
        if (!still) extra.push(`the old \`styre ${args[0]}\` stopped the orphan: not a control`);
      }
      return extra;
    },
  );
  await controlScenario(
    "control wrapper timeout",
    { how: "background", wrapped: true, timeoutMs: TIMEOUT_SCENARIO_MS },
    async (s) => ({ t0: timeoutAct(s).t0 }),
    ["cli", "sleep"],
  );
  await controlScenario(
    "control startup refusal",
    { how: "background", refusal: true },
    async (s) => {
      const t0 = Date.now();
      writeFileSync(s.go as string, "");
      return { t0 };
    },
    ["sleep"],
  );
  await controlScenario(
    "control suite kill",
    { how: "background", mode: "suite" },
    signalDriver("SIGTERM"),
    undefined,
  );

  // 3. The new code.
  const stopped = (s: Started) => stoppedAgent(s.agent.pid);
  const typed = (key: string) => async (s: Started) => {
    const t0 = Date.now();
    s.pty?.type(key);
    return { t0 };
  };
  const sigterm = async (s: Started): Promise<Acted> => {
    const t0 = Date.now();
    if (!signalOwned(s.driver, "SIGTERM"))
      throw new Error(`${s.name}: could not signal the driver`);
    return { t0 };
  };
  const timedOut = (s: Started) => (): string[] => {
    const r = parseDriver(s.said()).result;
    return r?.timedOut === true
      ? []
      : [`the dispatch returned ${JSON.stringify(r)}, not a timeout`];
  };

  await scenario("Ctrl-C", "new", ROOT, { how: "terminal" }, typed(CTRL_C), (s) => ({
    exit: { code: null, signal: "SIGINT" },
    lines: [OPENING_INT, stopped(s)],
    absent: [COULD_NOT],
  }));

  await scenario("kill", "new", ROOT, { how: "background" }, sigterm, (s) => ({
    exit: { code: null, signal: "SIGTERM" },
    lines: [opening("SIGTERM"), stopped(s)],
    absent: [COULD_NOT],
  }));

  /** `kill -9`, then one Styre command of the new code, which must stop the orphan first. */
  const afterForceQuit =
    (args: (s: Started, profile: string) => string[], inRepo: boolean) =>
    async (s: Started): Promise<Acted> => {
      const extra: string[] = [];
      if (!signalOwned(s.driver, "SIGKILL"))
        throw new Error(`${s.name}: could not signal the driver`);
      const killed = await s.ended(EXIT_MS);
      if (killed?.signal !== "SIGKILL")
        extra.push(`the driver ended ${JSON.stringify(killed)}, not by SIGKILL`);
      // No program can react to SIGKILL: the agent is still running until the next Styre command.
      if (!isAlive(s.agent))
        extra.push(
          "the agent was already gone before the command ran (the scenario proves nothing)",
        );
      const profile = writeProfile(s);
      const t0 = Date.now();
      const r = await styreCommand(ROOT, s, args(s, profile), inRepo ? s.repo : s.dir);
      return { t0, extra, stderr: r.stderr, exit: r.exit };
    };
  const forceQuitWant =
    (code: number, own: (s: Started) => string | RegExp | null) =>
    (s: Started): Expectation => {
      const sweep = orphanLine(s.ident, s.agent.pid);
      const mine = own(s);
      return {
        exit: { code, signal: null },
        lines: mine === null ? [sweep] : [sweep, mine],
        absent: [COULD_NOT],
        ...(mine === null
          ? {}
          : { before: [[sweep, mine]] as [string | RegExp, string | RegExp][] }),
      };
    };

  await scenario(
    "kill -9, then styre ls",
    "new",
    ROOT,
    { how: "background" },
    afterForceQuit(() => ["ls"], false),
    forceQuitWant(0, () => null),
  );
  await scenario(
    "kill -9, then styre run --resume",
    "new",
    ROOT,
    { how: "background" },
    afterForceQuit((s, profile) => ["run", "--resume", s.ident, "--profile", profile], true),
    forceQuitWant(64, () => /^styre run: no paused run at /m),
  );
  await scenario(
    "kill -9, then styre run --fresh",
    "new",
    ROOT,
    { how: "background" },
    afterForceQuit((s, profile) => ["run", s.ident, "--fresh", "--profile", profile], true),
    forceQuitWant(
      69,
      () => "styre run: cannot start — required commands are not runnable on this machine",
    ),
  );
  await scenario(
    "kill -9, then styre clean",
    "new",
    ROOT,
    { how: "background" },
    afterForceQuit((s, profile) => ["clean", s.ident, "--profile", profile], true),
    forceQuitWant(64, (s) => `styre clean: no styre effort on '${s.ident}'`),
  );

  await scenario(
    "timeout",
    "new",
    ROOT,
    { how: "background", timeoutMs: TIMEOUT_SCENARIO_MS },
    async (s) => ({ ...timeoutAct(s), after: timedOut(s) }),
    () => ({ exit: { code: 0, signal: null }, lines: [], absent: [COULD_NOT] }),
  );

  await scenario("Ctrl-\\", "new", ROOT, { how: "terminal" }, typed(CTRL_BACKSLASH), (s) => ({
    exit: { code: null, signal: "SIGQUIT" },
    lines: [opening("SIGQUIT"), stopped(s)],
    absent: [COULD_NOT],
    reportSleep: { pid: s.sleep.pid, command: `sleep ${s.sleepTag}` },
  }));

  await scenario(
    "wrapper, Ctrl-C",
    "new",
    ROOT,
    { how: "terminal", wrapped: true },
    typed(CTRL_C),
    (s) => ({
      exit: { code: null, signal: "SIGINT" },
      lines: [OPENING_INT, stopped(s)],
      absent: [COULD_NOT],
      alsoGone: ["real CLI"],
    }),
  );

  await scenario(
    "wrapper, timeout",
    "new",
    ROOT,
    { how: "background", wrapped: true, timeoutMs: TIMEOUT_SCENARIO_MS },
    async (s) => ({ ...timeoutAct(s), after: timedOut(s) }),
    () => ({
      exit: { code: 0, signal: null },
      lines: [],
      absent: [COULD_NOT],
      alsoGone: ["real CLI"],
    }),
  );

  await scenario(
    "closed terminal",
    "new",
    ROOT,
    { how: "terminal", log: true },
    async (s) => {
      const t0 = Date.now();
      await s.pty?.close();
      return { t0 };
    },
    (s) => ({
      exit: { code: null, signal: "SIGHUP" },
      lines: [opening("SIGHUP"), stopped(s)],
      absent: [COULD_NOT],
    }),
  );

  await scenario(
    "second Ctrl-C",
    "new",
    ROOT,
    { how: "terminal", wrapped: "stubborn" },
    async (s) => {
      const t0 = Date.now();
      s.pty?.type(CTRL_C);
      const extra: string[] = [];
      if (!(await until(() => s.said().includes(OPENING_INT), SECOND_PRESS_MS)))
        extra.push("the first Ctrl-C was not answered within 1 s");
      await Bun.sleep(Math.max(0, t0 + SECOND_PRESS_MS - Date.now()));
      // The wrapper ignores the polite stop, so the stop is still waiting for it here: the second
      // press must force it.
      if (!isAlive(s.agent))
        extra.push("the wrapper was gone before the second Ctrl-C (the scenario proves nothing)");
      s.pty?.type(CTRL_C);
      return {
        t0,
        extra,
        timing: (w) =>
          w.agentGoneMs !== null && w.agentGoneMs <= FORCED_BY_MS
            ? []
            : [
                `the wrapper was gone ${w.agentGoneMs ?? "never"} ms after the first Ctrl-C; a forced stop must end it within ${FORCED_BY_MS} ms`,
              ],
      };
    },
    (s) => ({
      exit: { code: null, signal: "SIGINT" },
      lines: [OPENING_INT, FORCING, stopped(s)],
      absent: [COULD_NOT],
      alsoGone: ["real CLI"],
    }),
  );

  await scenario(
    "startup refusal",
    "new",
    ROOT,
    { how: "background", refusal: true },
    async (s) => {
      const t0 = Date.now();
      writeFileSync(s.go as string, "");
      return {
        t0,
        after: () => {
          const r = parseDriver(s.said()).result;
          return r?.completed === false &&
            r.timedOut === false &&
            typeof r.fault === "string" &&
            r.fault.startsWith(REFUSED)
            ? []
            : [`the dispatch returned ${JSON.stringify(r)}, not a startup refusal`];
        },
      };
    },
    () => ({ exit: { code: 0, signal: null }, lines: [], absent: [COULD_NOT, STARTUP_FALLBACK] }),
  );

  await scenario("suite, kill", "new", ROOT, { how: "background", mode: "suite" }, sigterm, () => ({
    exit: { code: null, signal: "SIGTERM" },
    lines: [opening("SIGTERM")],
    absent: [COULD_NOT],
    alsoGone: ["background child"],
  }));

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

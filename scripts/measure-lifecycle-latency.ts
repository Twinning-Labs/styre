// Latency measurement for ENG-485 (spec 11.4; plan Task 17 step 1). NOT part of `bun test`: it
// times real processes, so its numbers depend on the machine. It launches no real `claude`: every
// dispatch runs a stand-in CLI script that answers at once.
//
// Usage: bun run scripts/measure-lifecycle-latency.ts [--rounds <n>] [--dispatches <n>]
//   (defaults: 5 rounds of 50 dispatches for each side; at least 2 rounds, since the noise is the
//   spread between rounds). Takes about a minute on a laptop.
//
// What it measures:
//   1. Normal dispatches, before and after: `runAgentDispatch` on a temporary repository, through
//      the real Claude adapter, with a stand-in CLI that answers at once. "Before" is the branch
//      baseline/pre-eng-485 (main at 9f51460, before ENG-485), exported with `git archive` into the
//      script's temporary folder (no worktree is registered in the checkout). "After" is this
//      checkout. Each round runs both sides in a fresh process each, alternating which goes first,
//      and prints the median and p90 of each side for that round and pooled over all rounds.
//   2. On this checkout only:
//      - the sweep over an empty records folder, and over a missing one (1000 calls each);
//      - `stopGroup` on a group that is already empty, and a command launch's `finish()` after the
//        command exited normally (the group check of spec 6.2);
//      - the `headAtStart` read: one `git rev-parse` of the branch per step (`branchHeadSha`);
//      - the gap from one step's end to the next step's start, with and without the background
//        leftover check started at the step's end (as `advanceOneStep`'s `finally` does), and how
//        long a dispatch takes while such a check runs beside it.
//
// The verdict on dispatches: "within noise" when the difference of the pooled medians is no larger
// than the noise, where the noise is the larger of the two sides' spreads (highest round median
// minus lowest) across the repeated rounds. The script prints the numbers it judged by. Caution
// (ENG-485 Task 17): this band widens with the machine's load and then hides a fixed cost of about
// 0.5 ms. Also compare the rounds in pairs (each round runs both sides back to back) across several
// runs: the per round differences, how many are positive, and their mean and standard error.
//
// Safety: every process it starts gets XDG_STATE_HOME and TMPDIR under the script's temporary
// folder, so the real ~/.local/state/styre-processes is never touched and every temporary file lands
// in that folder, which is removed at the end: after a failure too, and on SIGINT, SIGTERM or SIGHUP
// (a SIGKILL leaves it in $TMPDIR as styre-latency-*). A Ctrl-C in the terminal reaches the
// running worker too, so both end at once; a `kill -TERM` of this script alone is handled only once
// the running worker has ended (each worker is waited for synchronously, up to its own time limit of
// several minutes), and the cleanup runs then. It fails loudly (exit 1) if the baseline
// branch is missing or already has the stop handlers. LATENCY_FAIL_AFTER_EXPORT=1 forces a failure
// after the export, to check that cleanup.
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BASELINE_REFS, SIGNALS_FILE, baselineProblem } from "./lifecycle-live.ts";

const ROOT = join(import.meta.dir, "..");

// ---- small statistics ----------------------------------------------------------------------------

function quantile(xs: number[], q: number): number {
  if (xs.length === 0) return Number.NaN;
  const s = [...xs].sort((a, b) => a - b);
  const pos = (s.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return s[lo] + (s[hi] - s[lo]) * (pos - lo);
}
const median = (xs: number[]): number => quantile(xs, 0.5);
const p90 = (xs: number[]): number => quantile(xs, 0.9);
const fmt = (ms: number): string =>
  ms < 1 ? `${(ms * 1000).toFixed(0)} µs` : `${ms.toFixed(2)} ms`;

// ---- the stand-in CLI ----------------------------------------------------------------------------

/** Answers like `claude -p --output-format stream-json`: the tools it was given, then a result. */
const STANDIN = `#!/bin/bash
case "$1" in
  --version) echo "2.1.294 (Claude Code, latency stand-in)"; exit 0 ;;
  --help)
    cat <<'HELP'
Options:
  --restricted                     Restrict the session
  --tools <tools>                  The tools the session may use
  --allowedTools <tools>           Tools allowed without asking
  --permission-mode <mode>         (choices: "default", "dontAsk")
  --strict-mcp-config              Use only the given MCP servers
  --output-format <format>         (choices: "text", "json", "stream-json")
HELP
    exit 0 ;;
esac
tools=""
while [ $# -gt 0 ]; do
  if [ "$1" = --tools ]; then tools="$2"; fi
  shift
done
cat >/dev/null
if [ -z "$tools" ]; then list="[]"; else list="[\\"$(printf '%s' "$tools" | sed 's/,/","/g')\\"]"; fi
printf '{"type":"system","subtype":"init","tools":%s,"permissionMode":"dontAsk","mcp_servers":[]}\\n' "$list"
printf '{"type":"result","subtype":"success","result":"done","total_cost_usd":0}\\n'
`;

// ---- worker: runs inside a child process, against one tree's own code ----------------------------

function gitRepo(dir: string): string {
  mkdirSync(dir, { recursive: true });
  const run = (a: string[]) => {
    const r = Bun.spawnSync(["git", ...a], { cwd: dir, timeout: 30_000 });
    if (r.exitCode !== 0) throw new Error(`git ${a.join(" ")} failed: ${r.stderr.toString()}`);
  };
  run(["init", "-q", "-b", "main"]);
  run(["config", "user.email", "t@s.dev"]);
  run(["config", "user.name", "T"]);
  writeFileSync(join(dir, "README.md"), "x\n");
  run(["add", "-A"]);
  run(["commit", "-q", "-m", "init"]);
  return dir;
}

/** Everything a dispatch needs, loaded from `root`'s own code (the baseline or this checkout). */
async function dispatcher(root: string, work: string, standin: string) {
  // A checkout whose test helpers track their temp folders (test/helpers/temp.ts) refuses to make one
  // outside `bun test` unless the process removes them on exit; the baseline predates it.
  const tempHelpers = join(root, "test/helpers/temp.ts");
  if (existsSync(tempHelpers)) (await import(tempHelpers)).removeTempDirsOnExit();
  const { makeTestDb } = await import(join(root, "test/helpers/db.ts"));
  const { insertPending } = await import(join(root, "src/db/repos/workflow-step.ts"));
  const { getTicket } = await import(join(root, "src/db/repos/ticket.ts"));
  const { runAgentDispatch } = await import(join(root, "src/dispatch/run-dispatch.ts"));
  const { claudeAgentRunner } = await import(join(root, "src/agent/providers/claude.ts"));
  const { DEFAULT_AGENT_CONFIG } = await import(join(root, "src/config/agent-config.ts"));
  const { DEFAULT_RUNTIME_CONFIG } = await import(join(root, "src/config/runtime-config.ts"));
  const { parseProfile } = await import(join(root, "src/dispatch/profile.ts"));
  const { db, ticketId } = makeTestDb();
  const repo = gitRepo(join(work, "repo"));
  const wt = join(work, "wt");
  const runner = claudeAgentRunner(standin);
  let n = 0;
  return {
    repo,
    wt,
    async once(): Promise<number> {
      n++;
      const step = insertPending(db, {
        ticketId,
        stepKey: `implement:wu${n}:dispatch`,
        stepType: "dispatch",
      });
      const ticket = getTicket(db, ticketId);
      const ctx = { db, ticket, step, workUnitId: null, config: DEFAULT_RUNTIME_CONFIG };
      const deps = {
        runner,
        agentConfig: DEFAULT_AGENT_CONFIG,
        profile: parseProfile({ slug: "latency", targetRepo: repo }),
        repoPath: repo,
        worktreePath: wt,
        branch: "feat/LAT-1",
        timeoutMs: 60_000,
      };
      const spec = {
        handlerKey: "implement:dispatch",
        template: "implement {{ident}}",
        vars: { ident: "LAT-1" },
        postcondition: () => {},
      };
      const t0 = performance.now();
      const out = await runAgentDispatch(ctx, deps, spec);
      const dt = performance.now() - t0;
      if (typeof out?.dispatchId !== "string") throw new Error("the dispatch returned no id");
      return dt;
    },
  };
}

async function workerDispatch(root: string, work: string, standin: string, count: number) {
  const d = await dispatcher(root, work, standin);
  for (let i = 0; i < 3; i++) await d.once(); // warm up: imports, the worktree, the first spawns
  const ms: number[] = [];
  for (let i = 0; i < count; i++) ms.push(await d.once());
  process.stdout.write(`${JSON.stringify({ ms })}\n`);
}

async function workerMicro(root: string, work: string, standin: string) {
  const out: Record<string, number[]> = {};
  const time = async (name: string, n: number, fn: () => unknown): Promise<void> => {
    await fn(); // warm up
    const ms: number[] = [];
    for (let i = 0; i < n; i++) {
      const t0 = performance.now();
      await fn();
      ms.push(performance.now() - t0);
    }
    out[name] = ms;
  };

  const { sweepOrphans } = await import(join(root, "src/util/process/sweep.ts"));
  const door = await import(join(root, "src/util/process/door.ts"));
  const { stopGroup } = await import(join(root, "src/util/process/stop.ts"));
  const { checkLeftoversInBackground, pendingLeftoverChecks } = await import(
    join(root, "src/util/process/leftovers.ts")
  );
  const { nowToken } = await import(join(root, "src/util/process/proc-table.ts"));
  const { branchHeadSha } = await import(join(root, "src/dispatch/worktree.ts"));

  // The sweep: an empty records folder, then a missing one.
  const state = process.env.XDG_STATE_HOME as string;
  mkdirSync(join(state, "styre-processes"), { recursive: true });
  const said: string[] = [];
  const quiet = { stderr: (s: string) => said.push(s) };
  await time("sweep, empty folder", 1000, () => sweepOrphans(quiet));
  process.env.XDG_STATE_HOME = join(work, "no-such-state");
  await time("sweep, missing folder", 1000, () => sweepOrphans(quiet));
  process.env.XDG_STATE_HOME = state;
  if (said.length > 0) throw new Error(`the sweep said something: ${said.join("")}`);

  // The group check after a command exits normally (spec 6.2).
  const finishMs: number[] = [];
  const emptyStopMs: number[] = [];
  for (let i = 0; i < 101; i++) {
    const h = door.launch({
      argv: ["true"],
      cwd: work,
      env: process.env,
      kind: "group",
      context: { ident: null, stepId: null, worktree: null },
    });
    await h.proc.exited;
    let t0 = performance.now();
    const rep = await h.finish();
    const f = performance.now() - t0;
    if (rep.survivors.length > 0) throw new Error("a finished `true` left survivors");
    t0 = performance.now();
    await stopGroup(h.record.pid, "graceful", { graceMs: door.GRACE_MS });
    const s = performance.now() - t0;
    if (i > 0) {
      finishMs.push(f);
      emptyStopMs.push(s);
    }
  }
  out["finish() of an exited command launch"] = finishMs;
  out["stopGroup on an empty group"] = emptyStopMs;

  // The headAtStart read, once per step: `git rev-parse` of the branch.
  const d = await dispatcher(root, join(work, "micro"), standin);
  await d.once(); // creates the worktree and its branch
  await time("headAtStart rev-parse (branchHeadSha)", 200, () => {
    if (branchHeadSha(d.repo, "feat/LAT-1") === null) throw new Error("no branch head");
  });
  await time("nowToken (the leftover window's start)", 1000, () => nowToken());

  // A step's end to the next step's start. At a step's end `advanceOneStep` starts the check and
  // returns; the next step starts on the following turn of the event loop. The check's own
  // duration, which runs beside the next step, is reported apart.
  const nextTurn = () => new Promise<void>((r) => setImmediate(r));
  const gapWith: number[] = [];
  const gapWithout: number[] = [];
  const checkMs: number[] = [];
  for (let i = 0; i < 201; i++) {
    const withCheck = i % 2 === 0;
    const t0 = performance.now();
    let p: Promise<void> | null = null;
    if (withCheck) {
      p = checkLeftoversInBackground({ worktree: d.wt, since: nowToken(), report: () => {} });
    }
    await nextTurn();
    const gap = performance.now() - t0;
    if (p) {
      await p;
      checkMs.push(performance.now() - t0);
    }
    await pendingLeftoverChecks();
    if (i > 0) (withCheck ? gapWith : gapWithout).push(gap);
  }
  out["step end to next step start, without the check"] = gapWithout;
  out["step end to next step start, with the check"] = gapWith;
  out["the background check's own duration"] = checkMs;

  // A whole dispatch while a check runs beside it, against one without.
  const dispWith: number[] = [];
  const dispWithout: number[] = [];
  for (let i = 0; i < 40; i++) {
    const withCheck = i % 2 === 0;
    if (withCheck)
      void checkLeftoversInBackground({ worktree: d.wt, since: nowToken(), report: () => {} });
    const ms = await d.once();
    await pendingLeftoverChecks();
    (withCheck ? dispWith : dispWithout).push(ms);
  }
  out["dispatch, no check beside it"] = dispWithout;
  out["dispatch, a check running beside it"] = dispWith;

  if (door.liveLaunches().length > 0) throw new Error("a launch was left live");
  process.stdout.write(`${JSON.stringify(out)}\n`);
}

// ---- main ----------------------------------------------------------------------------------------

/** A failure of the measurement. It is thrown, never an exit, so `main`'s cleanup always runs. */
class Failed extends Error {}
function die(msg: string): never {
  throw new Failed(msg);
}

function parseArgs(argv: string[]): { rounds: number; dispatches: number } {
  const o = { rounds: 5, dispatches: 50 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const v = Number(argv[i + 1]);
    if ((a === "--rounds" || a === "--dispatches") && Number.isInteger(v) && v > 0) {
      o[a === "--rounds" ? "rounds" : "dispatches"] = v;
      i++;
    } else {
      process.stderr.write(
        "usage: bun run scripts/measure-lifecycle-latency.ts [--rounds <n>] [--dispatches <n>]\n",
      );
      process.exit(64);
    }
  }
  if (o.rounds < 2) {
    // The noise is the spread of the round medians: one round has none, so any difference would
    // read as "NOT WITHIN NOISE".
    process.stderr.write(
      "measure-lifecycle-latency: --rounds must be at least 2: the noise is the spread of the round medians, and one round has none\n",
    );
    process.exit(64);
  }
  return o;
}

function exportBaseline(into: string): { ref: string; sha: string } {
  const git = (a: string[]) => Bun.spawnSync(["git", "-C", ROOT, ...a], { timeout: 60_000 });
  const ref =
    BASELINE_REFS.find((r) => git(["rev-parse", "--verify", "--quiet", r]).exitCode === 0) ?? null;
  const hasSignals =
    ref !== null && git(["cat-file", "-e", `${ref}:${SIGNALS_FILE}`]).exitCode === 0;
  const problem = baselineProblem(ref, hasSignals);
  if (problem !== null || ref === null) die(`the baseline: ${problem}`);
  const sha = git(["rev-parse", `${ref}^{commit}`])
    .stdout.toString()
    .trim();
  mkdirSync(into);
  const out = Bun.spawnSync(
    ["sh", "-c", 'git -C "$1" archive --format=tar "$2" | tar -x -C "$3"', "sh", ROOT, sha, into],
    { timeout: 120_000, stderr: "pipe" },
  );
  if (out.exitCode !== 0) die(`could not export ${ref}: ${out.stderr.toString()}`);
  // The same dependencies as this checkout: share its node_modules (no network). Otherwise install.
  const same = (f: string) =>
    existsSync(join(into, f)) &&
    readFileSync(join(into, f), "utf8") === readFileSync(join(ROOT, f), "utf8");
  if (same("package.json") && same("bun.lock") && existsSync(join(ROOT, "node_modules"))) {
    symlinkSync(join(ROOT, "node_modules"), join(into, "node_modules"));
  } else {
    const inst = Bun.spawnSync([process.execPath, "install", "--frozen-lockfile"], {
      cwd: into,
      timeout: 180_000,
      stdout: "pipe",
      stderr: "pipe",
    });
    if (inst.exitCode !== 0) die(`bun install in the baseline failed: ${inst.stderr.toString()}`);
  }
  return { ref, sha };
}

function runWorker(args: string[], env: Record<string, string>, timeoutMs: number): unknown {
  const r = Bun.spawnSync([process.execPath, import.meta.path, "--worker", ...args], {
    env,
    timeout: timeoutMs,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (r.exitCode !== 0) {
    die(
      `worker ${args[0]} on ${args[1]} failed (${r.exitedDueToTimeout ? "timed out" : `exit ${r.exitCode}`}):\n${r.stderr.toString()}`,
    );
  }
  const line = r.stdout.toString().trim().split("\n").pop() ?? "";
  return JSON.parse(line);
}

async function main(): Promise<void> {
  const { rounds, dispatches } = parseArgs(process.argv.slice(2));
  const work = realpathSync(mkdtempSync(join(tmpdir(), "styre-latency-")));
  // Ctrl-C, `kill` or a closed terminal: remove the temporary folder, then end by the signal's
  // status. A running worker gets the terminal's Ctrl-C too; the handler runs once it has ended.
  const onStop = (sig: NodeJS.Signals, n: number) => () => {
    process.stderr.write(`measure-lifecycle-latency: stopped by ${sig}\n`);
    rmSync(work, { recursive: true, force: true });
    process.exit(128 + n);
  };
  const handlers: [NodeJS.Signals, () => void][] = [
    ["SIGINT", onStop("SIGINT", 2)],
    ["SIGTERM", onStop("SIGTERM", 15)],
    ["SIGHUP", onStop("SIGHUP", 1)],
  ];
  for (const [sig, h] of handlers) process.on(sig, h);
  try {
    const state = join(work, "state");
    mkdirSync(state);
    const standin = join(work, "standin-claude.sh");
    writeFileSync(standin, STANDIN, { mode: 0o755 });
    const base = exportBaseline(join(work, "baseline"));
    if (process.env.LATENCY_FAIL_AFTER_EXPORT === "1")
      die("forced failure (LATENCY_FAIL_AFTER_EXPORT)");
    const head = Bun.spawnSync(["git", "-C", ROOT, "rev-parse", "--short", "HEAD"])
      .stdout.toString()
      .trim();
    const dirty =
      Bun.spawnSync(["git", "-C", ROOT, "status", "--porcelain"]).stdout.toString().trim() !== "";
    // TMPDIR: every temporary file a worker makes (makeTestDb's database folder, its repositories)
    // lands inside `work`, which is removed at the end whatever happens.
    const tmp = join(work, "tmp");
    mkdirSync(tmp);
    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
      XDG_STATE_HOME: state,
      TMPDIR: tmp,
    };
    const log = (s: string) => process.stdout.write(`${s}\n`);

    log(`ENG-485 latency, ${new Date().toISOString()}`);
    log(`machine: ${process.platform} ${process.arch}, bun ${Bun.version}`);
    log(`before: ${base.ref} at ${base.sha.slice(0, 7)} (exported to a temporary folder)`);
    log(`after:  this checkout at ${head}${dirty ? " (with uncommitted changes)" : ""}`);
    log(
      `dispatches: ${rounds} rounds x ${dispatches} per side, 3 warm up dispatches each, not counted`,
    );
    log("");

    const sides = { before: join(work, "baseline"), after: ROOT };
    const per: Record<"before" | "after", number[][]> = { before: [], after: [] };
    for (let r = 0; r < rounds; r++) {
      const order: ("before" | "after")[] = r % 2 === 0 ? ["before", "after"] : ["after", "before"];
      for (const side of order) {
        const w = join(work, `d-${side}-${r}`);
        mkdirSync(w);
        const res = runWorker(
          ["dispatch", sides[side], w, standin, String(dispatches)],
          env,
          600_000,
        ) as {
          ms: number[];
        };
        per[side].push(res.ms);
      }
    }
    log("| Dispatch | round | median | p90 |");
    log("|---|---|---|---|");
    for (const side of ["before", "after"] as const) {
      per[side].forEach((ms, i) =>
        log(`| ${side} | ${i + 1} | ${fmt(median(ms))} | ${fmt(p90(ms))} |`),
      );
      const all = per[side].flat();
      log(`| ${side} | all (${all.length}) | ${fmt(median(all))} | ${fmt(p90(all))} |`);
    }
    const spread = (side: "before" | "after") => {
      const meds = per[side].map(median);
      return Math.max(...meds) - Math.min(...meds);
    };
    const diff = median(per.after.flat()) - median(per.before.flat());
    const noise = Math.max(spread("before"), spread("after"));
    log("");
    log(
      `median difference (after - before): ${diff >= 0 ? "+" : "-"}${fmt(Math.abs(diff))}; noise (the larger spread of round medians): ${fmt(noise)} (before ${fmt(spread("before"))}, after ${fmt(spread("after"))})`,
    );
    const within = Math.abs(diff) <= noise;
    log(`verdict: ${within ? "WITHIN NOISE" : "NOT WITHIN NOISE"}`);
    log("");

    const w = join(work, "micro");
    mkdirSync(w);
    const micro = runWorker(["micro", ROOT, w, standin], env, 600_000) as Record<string, number[]>;
    log("| This checkout | n | median | p90 |");
    log("|---|---|---|---|");
    for (const [name, ms] of Object.entries(micro)) {
      log(`| ${name} | ${ms.length} | ${fmt(median(ms))} | ${fmt(p90(ms))} |`);
    }
    if (!within) process.exitCode = 2;
  } finally {
    for (const [sig, h] of handlers) process.removeListener(sig, h);
    rmSync(work, { recursive: true, force: true });
  }
}

if (process.argv[2] === "--worker") {
  const [, , , kind, root, work, standin, count] = process.argv;
  if (kind === "dispatch") await workerDispatch(root, work, standin, Number(count));
  else if (kind === "micro") await workerMicro(root, work, standin);
  else throw new Error(`unknown worker ${kind}`);
  process.exit(0);
} else {
  try {
    await main(); // its `finally` has removed the temporary folder before anything below runs
  } catch (err) {
    process.stderr.write(
      `measure-lifecycle-latency: ${err instanceof Failed ? err.message : String(err)}\n`,
    );
    process.exitCode = 1;
  }
}

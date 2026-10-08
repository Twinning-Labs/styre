// Replays GitHub Actions' cancel of a `run:` step against the compiled styre (ENG-485 D14, Task 16),
// so the workflow's two cancel jobs (.github/workflows/lifecycle-live.yml) have a local prediction
// before they can be dispatched. No real agent: `styre setup` runs the fake claude CLI in hang mode,
// which becomes the stand-in agent with a tool command in a group of its own.
//
// Usage: bun run scripts/simulate-github-cancel.ts      ($STYRE_BIN: a built binary; default: build one)
//
// The runner's sequence, from actions/runner (src/Runner.Sdk/ProcessInvoker.cs, CancelAndKillProcessTree,
// SendSignal, NixKillProcessTree, ProcessExitedHandler): SIGINT to the step's process by pid; if it
// has not exited within 7.5 s, SIGTERM; if not within 2.5 s more, Process.Kill(), which is SIGKILL to
// that pid alone. Once the process has exited, if its output pipes are still held, the runner waits
// 5 s more and ends the step. A `run:` step with `shell: bash` is a script file run as
// `bash --noprofile --norc -e -o pipefail <file>` (src/Runner.Worker/Handlers/ScriptHandlerHelpers.cs).
//
// Forms, and what each must show (lifecycle-live.ts cancelVerdict):
//   script file, `exec styre …`     graceful: Styre is the step's process and handles the SIGINT;
//   script file, `styre …`          orphaned: bash takes the signals and dies on SIGTERM, Styre and
//                                   the agent keep running (on GitHub, until the job's cleanup);
//   `bash -c 'exec styre …'`        graceful;
//   `bash -c 'styre …'`             graceful too: bash runs a lone simple command given with -c by
//                                   exec, so Styre is the process signalled. That is why the
//                                   script file form, not -c, is what models GitHub.
// Every process is the script's own (test/helpers/own-processes.ts): bash leads a new session the
// script registers; the stand-in's pids are claimed as soon as it writes them. After each form,
// everything claimed is stopped and the form fails if anything is still running.
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nowToken, probe } from "../src/util/process/proc-table.ts";
import {
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
import {
  type CancelObservation,
  GITHUB_CANCEL,
  cancelStep,
  cancelVerdict,
} from "./lifecycle-live.ts";

const ROOT = realpathSync(join(import.meta.dir, ".."));
const work = realpathSync(mkdtempSync(join(tmpdir(), "styre-cancel-sim-")));
process.env.XDG_STATE_HOME = join(work, "state");
const log = (s: string): void => {
  process.stderr.write(`${s}\n`);
};

/** A fresh build, as scripts/build.sh makes it, in this script's own folder (Bun leaves a
 *  `.bun-build` file in the working folder of a compile on macOS). */
function binary(): string {
  if (process.env.STYRE_BIN) return process.env.STYRE_BIN;
  const out = join(work, "styre");
  const run = (argv: string[]) =>
    Bun.spawnSync(argv, { cwd: work, stdout: "pipe", stderr: "pipe", timeout: 180_000 });
  const r = run([
    process.execPath,
    "build",
    "--compile",
    join(ROOT, "src", "index.ts"),
    "--outfile",
    out,
  ]);
  if (r.exitCode !== 0) throw new Error(`the build failed: ${r.stderr.toString()}`);
  if (process.platform === "darwin") {
    const sign = run(["codesign", "--sign", "-", "--force", out]);
    if (sign.exitCode !== 0) throw new Error(`codesign failed: ${sign.stderr.toString()}`);
  }
  return out;
}

interface Form {
  name: string;
  /** The workflow's own step (a script file), or a `bash -c` string. */
  file: boolean;
  exec: boolean;
  expect: "graceful" | "orphaned";
}
const FORMS: Form[] = [
  { name: "script file, exec (the workflow's step)", file: true, exec: true, expect: "graceful" },
  {
    name: "script file, no exec (the workflow's step)",
    file: true,
    exec: false,
    expect: "orphaned",
  },
  { name: "bash -c, exec", file: false, exec: true, expect: "graceful" },
  { name: "bash -c, no exec", file: false, exec: false, expect: "graceful" },
];
const PREPARE = join(ROOT, "test", "lifecycle", "cancel-prepare.sh");
const ASSERT = join(ROOT, "test", "lifecycle", "assert-cancel.sh");

let nextSleep = 4_301;
async function simulate(bin: string, form: Form, marker: string) {
  const dir = realpathSync(mkdtempSync(join(work, "form-")));
  // The job's preparation step, with its environment file read back as GitHub would.
  const envFile = join(dir, "github-env");
  const prep = Bun.spawnSync(["bash", PREPARE, marker], {
    env: { ...process.env, RUNNER_TEMP: dir, CANCEL_DIR: dir, GITHUB_ENV: envFile },
    stdout: "pipe",
    stderr: "pipe",
    timeout: 30_000,
  });
  if (prep.exitCode !== 0)
    throw new Error(`${form.name}: cancel-prepare.sh failed: ${prep.stderr.toString()}`);
  const jobEnv: Record<string, string> = {};
  for (const line of readFileSync(envFile, "utf8").split("\n")) {
    const eq = line.indexOf("=");
    if (eq > 0) jobEnv[line.slice(0, eq)] = line.slice(eq + 1);
  }
  const sleep = String(nextSleep++);
  const env = { ...process.env, ...jobEnv, STYRE: bin, STANDIN_SLEEP: sleep };
  const pids = jobEnv.CANCEL_PIDS as string;
  // The workflow's step, run as GitHub runs a bash step; or a lone simple command given to -c (no
  // redirection: bash then runs it by exec).
  const file = join(dir, "step.sh");
  writeFileSync(file, cancelStep(form.exec));
  const body = `${form.exec ? "exec " : ""}"$STYRE" setup "$CANCEL_REPO" --config "$CANCEL_CONFIG" --out "$CANCEL_OUT"`;
  const argv = form.file
    ? ["bash", "--noprofile", "--norc", "-e", "-o", "pipefail", file]
    : ["bash", "-c", body];
  const since = nowToken();
  const proc = Bun.spawn(argv, {
    cwd: dir,
    detached: true, // a new session, registered: what Styre starts stays claimable after bash dies
    env,
    stdin: "ignore",
    stdout: "ignore",
    stderr: "pipe",
  });
  const me = probe(proc.pid);
  const step = me.kind === "alive" ? own(me.info)[0] : undefined;
  if (step === undefined || !registerGroup(step)) {
    proc.kill("SIGKILL");
    throw new Error(`${form.name}: the step's bash could not be claimed`);
  }
  let piped = "";
  let eof = false;
  void (async () => {
    const dec = new TextDecoder();
    for await (const c of proc.stderr) piped += dec.decode(c, { stream: true });
    eof = true;
  })();
  const said = (): string =>
    form.file
      ? existsSync(jobEnv.CANCEL_LOG as string)
        ? readFileSync(jobEnv.CANCEL_LOG as string, "utf8")
        : ""
      : piped;

  const standin = /^agent (\d+) tool (\d+)$/m;
  const started = await until(
    () => existsSync(pids) && standin.test(readFileSync(pids, "utf8")),
    30_000,
  );
  if (!started)
    throw new Error(`${form.name}: the stand-in agent never started; styre said:\n${said()}`);
  const m = standin.exec(readFileSync(pids, "utf8")) as RegExpExecArray;
  const agent = ownPrinted(Number(m[1]), since);
  const tool = ownPrinted(Number(m[2]), since);
  if (agent === null || tool === null)
    throw new Error(`${form.name}: the stand-in's pids could not be claimed`);
  ownTree(step);
  const styreNow = probe(agent.ppid);
  if (styreNow.kind !== "alive")
    throw new Error(`${form.name}: styre (pid ${agent.ppid}) is not running`);
  const styre = styreNow.info;

  // The runner's cancel.
  const sent: string[] = [];
  const exited = (ms: number) =>
    Promise.race([proc.exited.then(() => true), Bun.sleep(ms).then(() => false)]);
  const t0 = Date.now();
  signalOwned(step, "SIGINT");
  sent.push("SIGINT");
  if (!(await exited(GITHUB_CANCEL.sigintWaitMs))) {
    signalOwned(step, "SIGTERM");
    sent.push("SIGTERM");
    if (!(await exited(GITHUB_CANCEL.sigtermWaitMs))) {
      signalOwned(step, "SIGKILL");
      sent.push("SIGKILL");
      await exited(5_000);
    }
  }
  const endedMs = Date.now() - t0;
  // The process has exited; the runner waits up to 5 s more for its output pipes.
  await until(() => eof, GITHUB_CANCEL.pipeWaitMs);
  const o: CancelObservation = {
    sent,
    stepEnded: { code: proc.exitCode, signal: proc.signalCode },
    stderr: said(),
    agentPid: agent.pid,
    styreAlive: isAlive(styre),
    agentAlive: isAlive(agent),
    toolAlive: isAlive(tool),
  };
  const verdict = cancelVerdict(o);
  // The workflow's own check, on the workflow's own step, before anything is cleaned up.
  let assertOut: string[] = [];
  let assertOk = true;
  if (form.file) {
    const a = Bun.spawnSync(["bash", ASSERT, marker, form.expect], {
      env: { ...process.env, CANCEL_DIR: dir },
      stdout: "pipe",
      stderr: "pipe",
      timeout: 30_000,
    });
    assertOk = a.exitCode === 0;
    assertOut = `${a.stdout.toString()}${a.stderr.toString()}`.trim().split("\n");
  }

  // Clean up: everything claimed, then nothing may be left.
  killOwned();
  const left = await stillRunning(3_000);
  if (left.length > 0) stopStillRunning(left);
  rmSync(dir, { recursive: true, force: true });
  return {
    form: form.name,
    expected: form.expect,
    got: verdict.kind,
    why: verdict.why,
    styreWasTheStepProcess: styre.pid === step.pid,
    sent,
    stepEnded: o.stepEnded,
    stepEndedAfterMs: endedMs,
    afterTheStep: { styre: o.styreAlive, agent: o.agentAlive, tool: o.toolAlive },
    stderr: o.stderr.trim().split("\n"),
    assertCancel: form.file ? { ok: assertOk, output: assertOut } : null,
    leftRunning: left.map((l) => `pid ${l.pid} "${l.command}"`),
  };
}

let code = 0;
try {
  const bin = binary();
  const shell = Bun.spawnSync(["bash", "--version"]).stdout.toString().split("\n")[0];
  log(`styre ${bin}; ${shell}`);
  const results = [];
  for (const f of FORMS) {
    const r = await simulate(bin, f, `cancel-sim-${results.length + 1}`);
    results.push(r);
    log(
      `${r.form}: ${r.got} (expected ${r.expected}); signals ${r.sent.join(" → ")}; step ended ${JSON.stringify(r.stepEnded)} after ${r.stepEndedAfterMs} ms; assert-cancel.sh: ${r.assertCancel === null ? "not run (-c form)" : r.assertCancel.ok ? "PASS" : "FAIL"}; leak check: ${r.leftRunning.length === 0 ? "nothing left running" : r.leftRunning.join(", ")}`,
    );
  }
  log(JSON.stringify(results, null, 2));
  const bad = results.filter(
    (r) => r.got !== r.expected || r.leftRunning.length > 0 || r.assertCancel?.ok === false,
  );
  if (bad.length > 0) {
    log(
      `FAIL: ${bad.map((r) => `${r.form}: ${r.got}, expected ${r.expected}; ${r.why.join("; ")}`).join("\n      ")}`,
    );
    code = 1;
  } else log("PASS: every form ended as GitHub's cancel sequence predicts");
} catch (err) {
  log(`FAIL: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
  code = 1;
} finally {
  killOwned();
  const left = await stillRunning(3_000);
  if (left.length > 0) {
    stopStillRunning(left);
    log(`LEAK: ${left.map((l) => `pid ${l.pid} "${l.command}"`).join(", ")}`);
    code = 1;
  }
  rmSync(work, { recursive: true, force: true });
}
process.exit(code);

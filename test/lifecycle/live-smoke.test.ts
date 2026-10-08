// The pure logic of the live smoke (scripts/smoke-lifecycle.ts) and the GitHub cancel simulation
// (scripts/simulate-github-cancel.ts), ENG-485 Task 16: reading the driver's lines, finding the
// agent and its command group in a process table, the claude version, and the verdicts. Stand-in
// tables and texts only: nothing here starts a process.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  BASELINE_BRANCH,
  BASELINE_REFS,
  GITHUB_CANCEL,
  type Proc,
  SIGNALS_FILE,
  agentAbove,
  baselineProblem,
  cancelStep,
  cancelVerdict,
  controlVerdict,
  handlersProblem,
  judge,
  parseClaudeVersion,
  parseDriver,
  r8Check,
  versionAtLeast,
} from "../../scripts/lifecycle-live.ts";

const p = (pid: number, ppid: number, pgid: number, startedAt = "100"): Proc => ({
  pid,
  ppid,
  pgid,
  startedAt,
});

// The shape §2.1 found: driver 500 (its own group), claude 501 in the driver's group, the Bash tool's
// shell 502 leading a group of its own, and the test's sleep 503 in that group.
const TABLE: Proc[] = [
  p(1, 0, 1),
  p(500, 1, 500),
  p(501, 500, 500),
  p(502, 501, 502),
  p(503, 502, 502),
];

describe("agentAbove: the driver's direct child on the sleep's parent chain", () => {
  test("finds the agent two levels above the sleep", () => {
    expect(agentAbove(503, 500, TABLE)?.pid).toBe(501);
  });
  test("null when the chain never reaches the driver", () => {
    expect(agentAbove(503, 999, TABLE)).toBeNull();
  });
  test("null when the sleep is not in the table", () => {
    expect(agentAbove(777, 500, TABLE)).toBeNull();
  });
  test("a loop in the table ends the walk", () => {
    expect(agentAbove(10, 500, [p(10, 11, 10), p(11, 10, 10)])).toBeNull();
  });
});

describe("r8Check: Claude Code's command group is led by the agent's direct child (R8)", () => {
  test("holds when the sleep sits in the group the agent's child leads", () => {
    expect(r8Check(TABLE[4] as Proc, TABLE[2] as Proc, TABLE)).toEqual({
      ok: true,
      why: "the command group 502 is led by pid 502, the agent's direct child; the test runs in that group",
    });
  });
  test("holds for a nested group led by a process on the chain (a shell with job control), and says so", () => {
    // Seen on Linux with claude 2.1.294: the tool shell 502 leads 502, and the test 503 leads 503.
    const t = [p(500, 1, 500), p(501, 500, 500), p(502, 501, 502), p(503, 502, 503)];
    expect(r8Check(t[3] as Proc, t[1] as Proc, t)).toEqual({
      ok: true,
      why: "the command group 502 is led by pid 502, the agent's direct child; the test runs in group 503, led by pid 503 below it",
    });
  });
  test("fails when the agent's child does not lead a group of its own", () => {
    const t = [p(500, 1, 500), p(501, 500, 500), p(502, 501, 500), p(503, 502, 500)];
    const r = r8Check(t[3] as Proc, t[1] as Proc, t);
    expect(r.ok).toBe(false);
    expect(r.why).toContain("pid 502, the agent's direct child, is in group 500");
  });
  test("fails when the sleep sits in a group whose leader is not on its chain", () => {
    // The group's leader 504 exited, or is somewhere else: a stop would not take the group in.
    const t = [p(500, 1, 500), p(501, 500, 500), p(502, 501, 502), p(503, 502, 504)];
    const r = r8Check(t[3] as Proc, t[1] as Proc, t);
    expect(r.ok).toBe(false);
    expect(r.why).toContain("pid 503 is in group 504, which no process on its chain leads");
  });
  test("fails when the sleep is not below the agent", () => {
    const t = [p(500, 1, 500), p(501, 500, 500), p(503, 1, 503)];
    expect(r8Check(t[2] as Proc, t[1] as Proc, t).ok).toBe(false);
  });
});

describe("the control's baseline: branch baseline/pre-eng-485, before ENG-485", () => {
  test("named by the operator's decision, found locally or as the remote's branch", () => {
    expect(BASELINE_BRANCH).toBe("baseline/pre-eng-485");
    expect(BASELINE_REFS).toEqual([
      "refs/heads/baseline/pre-eng-485",
      "refs/remotes/origin/baseline/pre-eng-485",
    ]);
  });
  test("a missing branch, or one that has the stop handlers, is refused loudly", () => {
    expect(baselineProblem(null, false)).toContain("no branch baseline/pre-eng-485");
    expect(baselineProblem("refs/heads/baseline/pre-eng-485", true)).toContain(
      "has src/util/process/signals.ts",
    );
    expect(baselineProblem("refs/heads/baseline/pre-eng-485", false)).toBeNull();
  });
  // Runs wherever the branch is in the clone (the Mac, the laptop, the workflow after its fetch);
  // a shallow CI checkout without it skips, and the smoke itself refuses to run without it.
  const git = (args: string[]) =>
    Bun.spawnSync(["git", ...args], { cwd: join(import.meta.dir, "../.."), timeout: 10_000 });
  const ref = BASELINE_REFS.find(
    (r) => git(["rev-parse", "--verify", "--quiet", r]).exitCode === 0,
  );
  test.skipIf(ref === undefined)(
    "the baseline branch has the Claude adapter and no stop handlers",
    () => {
      expect(git(["cat-file", "-e", `${ref}:${SIGNALS_FILE}`]).exitCode).not.toBe(0);
      expect(git(["cat-file", "-e", `${ref}:src/agent/providers/claude.ts`]).exitCode).toBe(0);
    },
  );
});

describe("handlersProblem: the control runs without stop handlers, the new code with them", () => {
  test("the control must say `handlers none`", () => {
    expect(handlersProblem("control", "none")).toBeNull();
    expect(handlersProblem("control", "installed")).toContain(
      "the control installed stop handlers",
    );
    expect(handlersProblem("control", null)).toContain("never said");
  });
  test("the new code must say `handlers installed`", () => {
    expect(handlersProblem("new", "installed")).toBeNull();
    expect(handlersProblem("new", "none")).toContain("the new code installed no stop handlers");
  });
});

describe("the claude version", () => {
  test("parsed from `claude --version`", () => {
    expect(parseClaudeVersion("2.1.292 (Claude Code)\n")).toBe("2.1.292");
    expect(parseClaudeVersion("claude: command not found")).toBeNull();
  });
  test("compared part by part, not as text", () => {
    expect(versionAtLeast("2.1.292", "2.1.280")).toBe(true);
    expect(versionAtLeast("2.1.280", "2.1.280")).toBe(true);
    expect(versionAtLeast("2.1.99", "2.1.280")).toBe(false);
    expect(versionAtLeast("2.2.0", "2.1.280")).toBe(true);
    expect(versionAtLeast("1.9.999", "2.1.280")).toBe(false);
  });
});

describe("parseDriver: what the driver said on stderr", () => {
  test("reads the handlers, the dispatch time and the result", () => {
    const said = parseDriver(
      'smoke-driver: handlers installed\nsmoke-driver: dispatch 1700000000123\nstyre: x\nsmoke-driver: result {"completed":false,"timedOut":true,"exitCode":null,"interrupted":false}\n',
    );
    expect(said).toEqual({
      handlers: "installed",
      dispatchAt: 1700000000123,
      result: { completed: false, timedOut: true, exitCode: null, interrupted: false },
    });
  });
  test("nulls for what it never said, and a broken result line is not a result", () => {
    expect(parseDriver("smoke-driver: handlers none\nsmoke-driver: result {oops\n")).toEqual({
      handlers: "none",
      dispatchAt: null,
      result: null,
    });
  });
});

describe("judge: one scenario against what it must show", () => {
  const ok = {
    exit: { code: null, signal: "SIGTERM" },
    agentGoneMs: 900,
    sleepGoneMs: 1_100,
    stderr: "styre: received a stop request (SIGTERM) — cleaning up…\n",
  };
  const want = {
    exit: { code: null, signal: "SIGTERM" },
    lines: ["styre: received a stop request (SIGTERM) — cleaning up…"],
  };
  test("no failures when everything held", () => {
    expect(judge(want, ok)).toEqual([]);
  });
  test("a wrong exit is named", () => {
    expect(judge(want, { ...ok, exit: { code: 0, signal: null } })).toEqual([
      'exit {"code":0,"signal":null}, expected {"code":null,"signal":"SIGTERM"}',
    ]);
  });
  test("the same code with another signal is a wrong exit (130, 143 and 131 differ only there)", () => {
    expect(judge(want, { ...ok, exit: { code: null, signal: "SIGINT" } })).toEqual([
      'exit {"code":null,"signal":"SIGINT"}, expected {"code":null,"signal":"SIGTERM"}',
    ]);
  });
  test("no exit at all is named", () => {
    expect(judge(want, { ...ok, exit: null })[0]).toContain("did not exit");
  });
  test("an agent still running, or gone too late, fails", () => {
    expect(judge(want, { ...ok, agentGoneMs: null })[0]).toContain("the agent was still running");
    expect(judge(want, { ...ok, agentGoneMs: 5_001 })[0]).toContain("the agent was still running");
  });
  test("a sleep still running fails, unless the scenario expects it reported", () => {
    expect(judge(want, { ...ok, sleepGoneMs: null })[0]).toContain(
      "the test's sleep was still running",
    );
    expect(judge(want, { ...ok, sleepGoneMs: 5_400 })[0]).toContain(
      "the test's sleep was still running",
    );
  });
  test("a missing line, or a line that must not appear, fails", () => {
    expect(judge(want, { ...ok, stderr: "" })[0]).toContain("missing line");
    expect(
      judge(
        { ...want, absent: [/could not stop/] },
        { ...ok, stderr: `${ok.stderr}styre: could not stop x\n` },
      )[0],
    ).toContain("unexpected line");
  });
  test("a line matches only whole: the same text inside a longer line does not count", () => {
    expect(judge(want, { ...ok, stderr: `x ${ok.stderr}` })[0]).toContain("missing line");
    expect(
      judge(want, {
        ...ok,
        stderr: "styre: received a stop request (SIGTERM) — cleaning up… and more\n",
      })[0],
    ).toContain("missing line");
  });
  test("a regular expression line matches", () => {
    expect(
      judge(
        {
          exit: ok.exit,
          lines: [/^styre: stopped the agent \(pid \d+\) and \d+ of its commands\.$/m],
        },
        { ...ok, stderr: "styre: stopped the agent (pid 501) and 1 of its commands.\n" },
      ),
    ).toEqual([]);
  });
  const quit = {
    exit: { code: null, signal: "SIGQUIT" },
    lines: [],
    reportSleep: { pid: 503, command: "sleep 97.35" },
  };
  const D13 =
    'styre: the agent left "sleep 97.35" (pid 503) running in the worktree; stop it with: kill 503 (if it is not yours)';
  test("Ctrl-\\: a sleep still running 5 s after the trigger must be reported with the exact D13 line", () => {
    const seen = { ...ok, exit: { code: null, signal: "SIGQUIT" }, sleepGoneMs: null };
    expect(judge(quit, seen)[0]).toContain("(pid 503) outlived the stop and was not reported");
    expect(judge(quit, { ...seen, stderr: `${D13}\n` })).toEqual([]);
    // Another pid, another command, or the line inside a longer one does not count.
    expect(judge(quit, { ...seen, stderr: `${D13.replaceAll("503", "502")}\n` })).toHaveLength(1);
    expect(judge(quit, { ...seen, stderr: `${D13.replace("97.35", "97.36")}\n` })).toHaveLength(1);
    expect(judge(quit, { ...seen, stderr: `x${D13}\n` })).toHaveLength(1);
  });
  test("Ctrl-\\: a sleep gone only after 5 s also needs the report", () => {
    const seen = { ...ok, exit: { code: null, signal: "SIGQUIT" }, sleepGoneMs: 5_500 };
    expect(judge(quit, seen)).toHaveLength(1);
    expect(judge(quit, { ...seen, stderr: `${D13}\n` })).toEqual([]);
  });
  test("Ctrl-\\: a sleep gone within 5 s needs no report", () => {
    expect(judge(quit, { ...ok, exit: { code: null, signal: "SIGQUIT" } })).toEqual([]);
  });
});

describe("controlVerdict: the control must leak, or the probes are blind", () => {
  test("leaked when every control scenario left the agent running", () => {
    expect(
      controlVerdict([
        { name: "kill", agentAlive: true, sleepAlive: true },
        { name: "kill -9", agentAlive: true, sleepAlive: true },
      ]),
    ).toEqual({ blind: false, why: "" });
  });
  test("blind when one control scenario stopped its agent, naming it", () => {
    const v = controlVerdict([
      { name: "kill", agentAlive: false, sleepAlive: false },
      { name: "kill -9", agentAlive: true, sleepAlive: true },
    ]);
    expect(v.blind).toBe(true);
    expect(v.why).toContain("kill: the agent was gone");
  });
  test("blind when a control stopped only its agent and left the sleep", () => {
    const v = controlVerdict([
      { name: "kill", agentAlive: false, sleepAlive: true },
      { name: "kill -9", agentAlive: true, sleepAlive: true },
    ]);
    expect(v).toEqual({ blind: true, why: "kill: the agent was gone and its sleep running" });
  });
  test("blind when a control left the agent but its sleep was gone", () => {
    expect(controlVerdict([{ name: "kill", agentAlive: true, sleepAlive: false }]).blind).toBe(
      true,
    );
  });
  test("blind with no control scenario at all", () => {
    expect(controlVerdict([]).blind).toBe(true);
  });
});

describe("cancelVerdict: what a simulated GitHub cancel did", () => {
  test("the runner's timings, from actions/runner ProcessInvoker.cs", () => {
    expect(GITHUB_CANCEL).toEqual({ sigintWaitMs: 7_500, sigtermWaitMs: 2_500, pipeWaitMs: 5_000 });
  });
  const graceful = {
    sent: ["SIGINT"],
    stepEnded: { code: null, signal: "SIGINT" },
    stderr:
      "styre: stopping — cleaning up the agent and its commands before exiting (up to 5s; press Ctrl-C again to force)…\nstyre: stopped the agent (pid 42) and 1 of its commands.\n",
    agentPid: 42,
    styreAlive: false,
    agentAlive: false,
    toolAlive: false,
  };
  test("graceful: SIGINT alone ended the step by SIGINT, Styre said so and stopped everything", () => {
    expect(cancelVerdict(graceful)).toEqual({ kind: "graceful", why: [] });
  });
  test("not graceful when the stop line names another agent", () => {
    const v = cancelVerdict({ ...graceful, agentPid: 43 });
    expect(v.kind).toBe("other");
    expect(v.why.join()).toContain("stopped the agent (pid 43)");
  });
  test("not graceful when the step ended any other way than by SIGINT", () => {
    for (const stepEnded of [
      { code: 0, signal: null },
      { code: 130, signal: null },
      { code: null, signal: "SIGTERM" },
    ]) {
      const v = cancelVerdict({ ...graceful, stepEnded });
      expect(v.kind).toBe("other");
      expect(v.why.join()).toContain("step ended");
    }
  });
  test("not graceful when the tool survived", () => {
    expect(cancelVerdict({ ...graceful, toolAlive: true }).kind).toBe("other");
  });
  const orphaned = {
    sent: ["SIGINT", "SIGTERM"],
    stepEnded: { code: null, signal: "SIGTERM" },
    stderr: "",
    agentPid: 42,
    styreAlive: true,
    agentAlive: true,
    toolAlive: true,
  };
  test("orphaned: the step needed SIGTERM, no handler line, and Styre, agent and tool still run", () => {
    expect(cancelVerdict(orphaned)).toEqual({ kind: "orphaned", why: [] });
  });
  test("a handler line is never orphaned", () => {
    const v = cancelVerdict({
      ...orphaned,
      stderr: "styre: received a stop request (SIGTERM) — cleaning up…\n",
    });
    expect(v.kind).toBe("other");
  });
  test("a step that ended on SIGINT alone with nothing left is not orphaned", () => {
    expect(cancelVerdict({ ...orphaned, sent: ["SIGINT"] }).kind).toBe("other");
  });
});

describe("the workflow (.github/workflows/lifecycle-live.yml)", () => {
  type Step = { name?: string; run?: string; uses?: string; env?: Record<string, string> };
  const wf = Bun.YAML.parse(
    readFileSync(join(import.meta.dir, "../../.github/workflows/lifecycle-live.yml"), "utf8"),
  ) as { on: unknown; jobs: Record<string, { steps: Step[]; "timeout-minutes"?: number }> };
  const longStep = (job: string): Step | undefined =>
    wf.jobs[job]?.steps.find((s) => s.name?.startsWith("Long run"));

  test("runs by hand only", () => {
    expect(wf.on).toBe("workflow_dispatch");
  });
  test("each cancel job's long step is exactly the step the simulation runs", () => {
    expect(longStep("cancel-with-exec")?.run).toBe(cancelStep(true));
    expect(longStep("cancel-without-exec")?.run).toBe(cancelStep(false));
    expect(wf.jobs["cancel-with-exec"]?.["timeout-minutes"]).toBe(3);
    expect(wf.jobs["cancel-without-exec"]?.["timeout-minutes"]).toBe(3);
  });
  test("each cancel job checks the outcome its form predicts, even after the cancel", () => {
    const last = (job: string) => wf.jobs[job]?.steps.at(-1) as Step & { if?: string };
    expect(last("cancel-with-exec")).toEqual({
      if: "always()",
      run: "bash test/lifecycle/assert-cancel.sh cancel-exec graceful",
    });
    expect(last("cancel-without-exec")).toEqual({
      if: "always()",
      run: "bash test/lifecycle/assert-cancel.sh cancel-noexec orphaned",
    });
  });
  const text = readFileSync(
    join(import.meta.dir, "../../.github/workflows/lifecycle-live.yml"),
    "utf8",
  );
  test("the secret reaches the live smoke step only, in any spelling", () => {
    expect(text.match(/secrets\s*(?:\.|\[)/g)).toHaveLength(1);
    const withSecret = Object.entries(wf.jobs).flatMap(([job, j]) =>
      j.steps.filter((s) => /secrets/.test(JSON.stringify(s))).map((s) => `${job}: ${s.name}`),
    );
    expect(withSecret).toEqual(["smoke: Live smoke (real claude; seven dispatches)"]);
  });
  test("every action is pinned by commit", () => {
    for (const j of Object.values(wf.jobs))
      for (const s of j.steps) if (s.uses) expect(s.uses).toMatch(/@[0-9a-f]{40}$/);
  });
  test("the smoke fetches the baseline, runs the free stand-in first, and execs each run under a time limit with no cores", () => {
    const run = (name: string) => wf.jobs.smoke?.steps.find((s) => s.name === name)?.run;
    expect(run("Fetch the control's baseline branch")).toBe(
      "git fetch --depth 1 --no-tags origin +refs/heads/baseline/pre-eng-485:refs/remotes/origin/baseline/pre-eng-485",
    );
    expect(run("Free run with the stand-in claude (no model calls)")).toBe(
      "ulimit -c 0 && exec timeout 600 bun run scripts/smoke-lifecycle.ts --standin",
    );
    expect(run("Live smoke (real claude; seven dispatches)")).toBe(
      "ulimit -c 0 && exec timeout 900 bun run scripts/smoke-lifecycle.ts",
    );
    const names = wf.jobs.smoke?.steps.map((s) => s.name) ?? [];
    expect(names.indexOf("Free run with the stand-in claude (no model calls)")).toBeLessThan(
      names.indexOf("Live smoke (real claude; seven dispatches)"),
    );
  });
  test("claude is pinned to the version smoke-lifecycle-container.sh uses", () => {
    const pin = /@anthropic-ai\/claude-code@(\d+\.\d+\.\d+)/;
    const container = readFileSync(
      join(import.meta.dir, "../../scripts/smoke-lifecycle-container.sh"),
      "utf8",
    );
    expect(pin.exec(text)?.[1]).toBeDefined();
    const pinned = /^CLAUDE_PIN="@anthropic-ai\/claude-code@(\d+\.\d+\.\d+)"$/m.exec(
      container,
    )?.[1];
    expect(pinned).toBeDefined();
    expect(pin.exec(text)?.[1]).toBe(pinned);
    expect(container.match(/claude-code@\d/g)).toHaveLength(1);
  });
  test("each cancel job prepares and asserts the same marker", () => {
    for (const job of ["cancel-with-exec", "cancel-without-exec"]) {
      const steps = wf.jobs[job]?.steps ?? [];
      const prepared = steps
        .map((s) => /^bash test\/lifecycle\/cancel-prepare\.sh (\S+)$/.exec(s.run ?? "")?.[1])
        .filter(Boolean);
      const asserted = steps
        .map((s) => /^bash test\/lifecycle\/assert-cancel\.sh (\S+) \S+$/.exec(s.run ?? "")?.[1])
        .filter(Boolean);
      expect(prepared).toHaveLength(1);
      expect(asserted).toEqual(prepared);
    }
  });
});

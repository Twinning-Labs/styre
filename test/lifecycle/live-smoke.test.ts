// The pure logic of the live smoke (scripts/smoke-lifecycle.ts) and the GitHub cancel simulation
// (scripts/simulate-github-cancel.ts), ENG-485 Task 16: reading the driver's lines, finding the
// agent and its command group in a process table, the claude version, and the verdicts. Stand-in
// tables and texts only: nothing here starts a process.
import { describe, expect, test } from "bun:test";
import {
  GITHUB_CANCEL,
  type Proc,
  agentAbove,
  cancelVerdict,
  controlVerdict,
  groupLedByChild,
  judge,
  parseClaudeVersion,
  parseDriver,
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

describe("groupLedByChild: R8, the agent's command group is led by its direct child", () => {
  test("holds when the sleep's group leader is the agent's child", () => {
    const r = groupLedByChild(TABLE[4] as Proc, TABLE[2] as Proc, TABLE);
    expect(r).toEqual({
      ok: true,
      why: "group 502 is led by pid 502, a direct child of the agent 501",
    });
  });
  test("fails when the leader is a grandchild", () => {
    const t = [
      p(500, 1, 500),
      p(501, 500, 500),
      p(502, 501, 501),
      p(504, 502, 504),
      p(503, 504, 504),
    ];
    const r = groupLedByChild(t[4] as Proc, t[1] as Proc, t);
    expect(r.ok).toBe(false);
    expect(r.why).toContain("parent 502");
  });
  test("fails when the sleep shares the agent's group", () => {
    const t = [p(500, 1, 500), p(501, 500, 500), p(503, 501, 500)];
    expect(groupLedByChild(t[2] as Proc, t[1] as Proc, t).ok).toBe(false);
  });
  test("fails when the group's leader has exited", () => {
    const t = [p(500, 1, 500), p(501, 500, 500), p(503, 1, 502)];
    const r = groupLedByChild(t[2] as Proc, t[1] as Proc, t);
    expect(r.ok).toBe(false);
    expect(r.why).toContain("no process leads group 502");
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
    sleepAliveAtEnd: false,
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
  test("no exit at all is named", () => {
    expect(judge(want, { ...ok, exit: null })[0]).toContain("did not exit");
  });
  test("an agent still running, or gone too late, fails", () => {
    expect(judge(want, { ...ok, agentGoneMs: null })[0]).toContain("the agent was still running");
    expect(judge(want, { ...ok, agentGoneMs: 5_001 })[0]).toContain("the agent was still running");
  });
  test("a sleep still running fails, unless the scenario expects it reported", () => {
    expect(judge(want, { ...ok, sleepGoneMs: null, sleepAliveAtEnd: true })[0]).toContain(
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
  test("Ctrl-\\: a sleep that survives must be named in a leftover report with its pid", () => {
    const want2 = { exit: { code: null, signal: "SIGQUIT" }, lines: [], reportSleep: 503 };
    const seen = {
      ...ok,
      exit: { code: null, signal: "SIGQUIT" },
      sleepGoneMs: null,
      sleepAliveAtEnd: true,
    };
    expect(judge(want2, seen)[0]).toContain("(pid 503) outlived the stop and was not reported");
    expect(
      judge(want2, {
        ...seen,
        stderr:
          'styre: the agent left "sleep 97.35" (pid 503) running in the worktree; stop it with: kill 503 (if it is not yours)\n',
      }),
    ).toEqual([]);
    // The report for some other pid does not count.
    expect(
      judge(want2, {
        ...seen,
        stderr:
          'styre: the agent left "sh" (pid 502) running in the worktree; stop it with: kill 502 (if it is not yours)\n',
      }),
    ).toHaveLength(1);
  });
  test("Ctrl-\\: a sleep that is gone needs no report", () => {
    const want2 = { exit: { code: null, signal: "SIGQUIT" }, lines: [], reportSleep: 503 };
    expect(judge(want2, { ...ok, exit: { code: null, signal: "SIGQUIT" } })).toEqual([]);
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

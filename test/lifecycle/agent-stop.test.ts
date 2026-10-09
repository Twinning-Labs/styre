// The Claude adapter driven against stand-in agents (ENG-485 task 6).
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launchAgent } from "../../src/agent/launch.ts";
import { claudeAgentRunner } from "../../src/agent/providers/claude.ts";
import { codexAgentRunner } from "../../src/agent/providers/codex.ts";
import * as door from "../../src/util/process/door.ts";
import {
  type ProcInfo,
  listProcesses,
  nowToken,
  probe,
} from "../../src/util/process/proc-table.ts";
import { type StopDeps, realStopDeps } from "../../src/util/process/stop.ts";
import {
  allGone,
  killOwned,
  own,
  ownLaunch,
  ownPrinted,
  ownTree,
  toolPid,
  until,
} from "../helpers/own-processes.ts";

const FX = join(import.meta.dir, "fixtures");
const input = {
  prompt: "x",
  model: "m",
  allowedTools: ["Read"],
  cwd: process.cwd(),
  timeoutMs: 300,
};
const key = (p: { pid: number; startedAt: string }) => `${p.pid}:${p.startedAt}`;

/** The pollers `watchStops` started, stopped after each test. */
const pollers: ReturnType<typeof setInterval>[] = [];

/**
 * Stop functions that remember the tree of each live launch, with start times, claimed while the
 * agent is certainly the test's own: at every listing a stop reads (what the stop is about to act
 * on), and every 10 ms from the start (the adapter reads the stand-in's `tool <pid>` line itself,
 * so polling the tree is the earliest the test can claim the tool; a tool whose stand-in died
 * before any claim could never be claimed). `tools()` is what was seen without the agents
 * themselves. Each claimed process is killed in afterEach if it is somehow still there. `over`
 * replaces parts of the real stop functions; every signal sent is recorded in `sent`.
 */
function watchStops(over: Partial<StopDeps> = {}): {
  sent: NodeJS.Signals[];
  tools: () => ProcInfo[];
} {
  const sent: NodeJS.Signals[] = [];
  const seen = new Map<string, ProcInfo>();
  const agents = new Set<string>();
  const base = { ...realStopDeps, ...over };
  const look = (table: ProcInfo[]): void => {
    for (const h of door.liveLaunches()) {
      agents.add(key(h.record));
      for (const p of ownTree(h.record, table)) seen.set(key(p), p);
    }
  };
  pollers.push(setInterval(() => look(listProcesses()), 10));
  door.__setStopDepsForTests({
    ...base,
    list: () => {
      const table = base.list();
      look(table);
      return table;
    },
    kill: (target, sig) => {
      sent.push(sig);
      base.kill(target, sig);
    },
  });
  return { sent, tools: () => [...seen.values()].filter((p) => !agents.has(key(p))) };
}

/** The tree of the one live launch once it has a command running beside the agent. */
async function toolsRunning(): Promise<ProcInfo[]> {
  let tools: ProcInfo[] = [];
  const ok = await until(() => {
    const [h] = door.liveLaunches();
    tools = h ? ownTree(h.record).filter((p) => p.pid !== h.record.pid) : [];
    return tools.length > 0;
  });
  expect(ok, "the stand-in never started its tool command").toBe(true);
  return tools;
}

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "styre-agent-stop-")));
/** Each test gets a state folder of its own, inside `scratch` (removed after the file): the
 *  records a stop that left survivors keeps never reach the run's shared test state folder. */
const savedState = process.env.XDG_STATE_HOME;
beforeEach(() => {
  process.env.XDG_STATE_HOME = mkdtempSync(join(scratch, "state-"));
});
afterAll(() => {
  if (savedState === undefined) Reflect.deleteProperty(process.env, "XDG_STATE_HOME");
  else process.env.XDG_STATE_HOME = savedState;
  rmSync(scratch, { recursive: true, force: true });
});
/** An executable stand-in CLI; `body` runs under bash and sees the test's env. */
function script(name: string, body: string): string {
  const path = join(scratch, name);
  writeFileSync(path, `#!/bin/bash\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}

beforeAll(async () => {
  // Start the stand-ins once, directly as the adapters do, before any timed test. On macOS the
  // first exec of a script that was just written (a fresh checkout) took 0.3 to 1.3 s here, longer
  // than the 300 ms timeouts below, and a stop that lands before the stand-in starts its tool
  // command leaves nothing to check. The wrapper starts the stand-in, so both are run. A zero second
  // tool ends at once, and the stand-in with it.
  const p = Bun.spawn([join(FX, "wrapped-standin.sh")], {
    env: { ...process.env, STANDIN_SLEEP: "0" },
    stdout: "ignore",
    stderr: "ignore",
  });
  expect(await p.exited).toBe(0);
});

afterEach(() => {
  for (const t of pollers.splice(0)) clearInterval(t);
  // Even on failure: nothing a test started may outlive it, and nothing else is touched.
  for (const h of door.liveLaunches()) ownLaunch(h);
  killOwned();
  door.__resetForTests();
  Reflect.deleteProperty(process.env, "STANDIN_SLEEP");
  Reflect.deleteProperty(process.env, "TERM_MARKER");
});

test("a timeout stops the agent gracefully, so its command in its own group is gone too", async () => {
  process.env.STANDIN_SLEEP = "301";
  const watch = watchStops();
  const r = await claudeAgentRunner(join(FX, "standin-agent.sh")).run(input);
  expect(r.timedOut).toBe(true);
  expect(watch.tools().length).toBeGreaterThan(0); // the tool command was seen and claimed
  expect(await allGone(watch.tools())).toBe(true);
});

test("a timeout is graceful: only SIGTERM is sent when the agent exits within the grace period", async () => {
  // No timing dependence: the stand-in exits on SIGTERM (or dies of it), so a forced stop is the
  // only way a SIGKILL could be sent.
  process.env.STANDIN_SLEEP = "304";
  const { sent, tools } = watchStops();
  const r = await claudeAgentRunner(join(FX, "standin-agent.sh")).run(input);
  expect(r.timedOut).toBe(true);
  expect(sent.length).toBeGreaterThan(0);
  expect(sent.every((sig) => sig === "SIGTERM")).toBe(true);
  expect(tools().length).toBeGreaterThan(0);
  expect(await allGone(tools())).toBe(true);
});

test("a startup refusal is forced: the agent gets no chance to run a shutdown", async () => {
  // The CLI reports the wrong tool set. No tool has run yet, so the whole tree is killed at once;
  // a graceful stop would let the TERM trap write the marker.
  const marker = join(scratch, "refusal.marker");
  process.env.TERM_MARKER = marker;
  process.env.STANDIN_SLEEP = "305";
  const init = JSON.stringify({
    type: "system",
    subtype: "init",
    tools: ["Read", "Bash"],
    permissionMode: "dontAsk",
    mcp_servers: [],
  });
  const cli = script(
    "refused-agent.sh",
    `trap 'touch "$TERM_MARKER"; exit 0' TERM\nsleep "$STANDIN_SLEEP" &\necho '${init}'\nwait`,
  );
  const { sent, tools } = watchStops();
  const r = await claudeAgentRunner(cli).run({ ...input, timeoutMs: 20_000 });
  expect(r.completed).toBe(false);
  expect(r.capabilities?.error).toContain("stopped at startup");
  // A TERM trap would have written the marker before its shell left the table, and the stop waits
  // for that: no wait is needed here.
  expect(existsSync(marker)).toBe(false);
  expect(sent.length).toBeGreaterThan(0);
  expect(sent.every((sig) => sig === "SIGKILL")).toBe(true); // forced: never a SIGTERM first
  expect(tools().length).toBeGreaterThan(0);
  expect(await allGone(tools())).toBe(true);
});

test("an agent launched through a wrapper is stopped completely on timeout", async () => {
  process.env.STANDIN_SLEEP = "302";
  const { tools } = watchStops();
  const r = await claudeAgentRunner(join(FX, "wrapped-standin.sh")).run(input);
  expect(r.timedOut).toBe(true);
  // Below the wrapper: the stand-in itself and its tool command.
  expect(tools().length).toBeGreaterThanOrEqual(2);
  expect(await allGone(tools())).toBe(true);
});

test("an agent stopped by the handler makes launchAgent throw RunInterrupted", async () => {
  process.env.STANDIN_SLEEP = "303";
  const p = launchAgent(claudeAgentRunner(join(FX, "standin-agent.sh")), {
    ...input,
    timeoutMs: 60_000,
  });
  const outcome = p.then(
    () => null,
    (e: unknown) => e,
  ); // attached at once: the rejection can land while the stop below is still being awaited
  const tools = await toolsRunning();
  door.beginStopping();
  for (const h of door.liveLaunches()) {
    h.interrupted = true;
    await h.stop("graceful");
  }
  expect(await outcome).toBeInstanceOf(door.RunInterrupted);
  expect(await allGone(tools)).toBe(true);
});

test("an interrupted agent that is also past its timeout is still reported as interrupted", async () => {
  process.env.STANDIN_SLEEP = "307";
  const runner = claudeAgentRunner(join(FX, "standin-agent.sh"));
  const p = runner.run({ ...input, timeoutMs: 600 });
  const tools = await toolsRunning();
  for (const h of door.liveLaunches()) h.interrupted = true; // flagged, not yet stopped
  const r = await p;
  expect(r.interrupted).toBe(true);
  expect(r.timedOut).toBe(false);
  expect(await allGone(tools)).toBe(true);
});

test("the agent stays in Styre's own group and carries the context it was given", async () => {
  process.env.STANDIN_SLEEP = "308";
  watchStops();
  const context = {
    ident: "ENG-7",
    stepId: 41,
    worktree: scratch,
    untrackedBefore: ["a.txt"],
    dispatchRowId: 9,
  };
  const p = claudeAgentRunner(join(FX, "standin-agent.sh")).run({
    ...input,
    timeoutMs: 800,
    context,
  });
  expect(await until(() => door.liveLaunches().length === 1)).toBe(true);
  const [h] = door.liveLaunches();
  expect(h?.context).toEqual(context);
  expect(h?.record.kind).toBe("agent");
  expect(h?.record.ident).toBe("ENG-7");
  const me = probe(process.pid);
  const agent = probe(h?.proc.pid ?? -1);
  expect(me.kind === "alive" && agent.kind === "alive" && agent.info.pgid === me.info.pgid).toBe(
    true,
  );
  await p;
});

test("a stop that leaves survivors is reported on stderr and never hangs", async () => {
  process.env.STANDIN_SLEEP = "309";
  const lines: string[] = [];
  const realWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((s: string | Uint8Array) => {
    lines.push(String(s));
    return true;
  }) as typeof process.stderr.write;
  try {
    // A stop whose kill never lands: every process looks alive until the grace and confirm waits end.
    // The survivors are remembered by the watch, and killed after the test.
    watchStops({
      kill: () => {},
      sleep: async () => {},
      now: (() => {
        let t = 0;
        return () => {
          t += 1_000;
          return t;
        };
      })(),
    });
    const r = await claudeAgentRunner(join(FX, "standin-agent.sh")).run({
      ...input,
      timeoutMs: 300,
    });
    expect(r.timedOut).toBe(true);
  } finally {
    process.stderr.write = realWrite;
  }
  const text = lines.join("");
  // Each line names the survivor's own command (spec 7.3), not the launch's argv.
  expect(text).toMatch(/styre: could not stop sleep 309 \(pid \d+\); stop it with: kill -9 \d+/);
  // The agent's own line: its command is cut to 120 characters, so a long checkout path hides the
  // script name. Match only the start and the tail, never the path.
  expect(text).toMatch(/styre: could not stop \S*bash .*\(pid \d+\); stop it with: kill -9 \d+/);
  // The sleep line does not borrow the agent's argv (the Claude flags are the agent's own).
  expect(text.split("\n").find((l) => l.includes("sleep 309"))).not.toContain("--output-format");
});

test("the codex adapter, though refused at startup, also goes through the door", async () => {
  process.env.STANDIN_SLEEP = "300";
  const { tools } = watchStops();
  const r = await codexAgentRunner(join(FX, "standin-agent.sh")).run(input);
  expect(r.timedOut).toBe(true);
  expect(tools().length).toBeGreaterThan(0);
  expect(await allGone(tools())).toBe(true);
});

test("a survivor of a timeout stop no longer keeps the subprocess referenced", async () => {
  process.env.STANDIN_SLEEP = "310";
  let t = 0;
  // The survivors are remembered by the watch, and killed after the test.
  watchStops({
    kill: () => {},
    sleep: async () => {},
    now: () => {
      t += 1_000;
      return t;
    },
  });
  const unrefs: number[] = [];
  const realWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = (() => true) as typeof process.stderr.write; // the survivor lines
  try {
    const p = claudeAgentRunner(join(FX, "standin-agent.sh")).run({ ...input, timeoutMs: 400 });
    expect(await until(() => door.liveLaunches().length === 1)).toBe(true);
    const [h] = door.liveLaunches();
    const unref = h?.proc.unref.bind(h.proc);
    if (h && unref) {
      h.proc.unref = () => {
        unrefs.push(1);
        unref();
      };
    }
    expect((await p).timedOut).toBe(true);
  } finally {
    process.stderr.write = realWrite;
  }
  expect(unrefs.length).toBeGreaterThan(0);
});

const okCli = () => {
  const init = JSON.stringify({
    type: "system",
    subtype: "init",
    tools: ["Read"],
    permissionMode: "dontAsk",
    mcp_servers: [],
  });
  const result = JSON.stringify({ type: "result", subtype: "success", result: "ok" });
  return script("ok-agent.sh", `echo '${init}'\necho '${result}'`);
};

test("after a completed run the launch is released: nothing live, no record left on disk", async () => {
  const prev = process.env.XDG_STATE_HOME;
  const state = realpathSync(mkdtempSync(join(scratch, "agent-state-")));
  process.env.XDG_STATE_HOME = state;
  try {
    const r = await claudeAgentRunner(okCli()).run({ ...input, timeoutMs: 20_000 });
    expect(r.completed).toBe(true);
    expect(door.liveLaunches()).toEqual([]);
    const dir = join(state, "styre-processes");
    const left = existsSync(dir) ? readdirSync(dir).filter((n) => n.endsWith(".json")) : [];
    expect(left).toEqual([]);
  } finally {
    if (prev === undefined) Reflect.deleteProperty(process.env, "XDG_STATE_HOME");
    else process.env.XDG_STATE_HOME = prev;
  }
});

test("a closed door makes both adapters throw RunInterrupted, not report a transient failure", async () => {
  door.beginStopping();
  await expect(claudeAgentRunner(okCli()).run(input)).rejects.toBeInstanceOf(door.RunInterrupted);
  await expect(codexAgentRunner(okCli()).run(input)).rejects.toBeInstanceOf(door.RunInterrupted);
});

test("the stand-in says `tool <pid>` only once its traps are set: a SIGTERM right then stops its tool", async () => {
  // Tests wait for that line before they signal the stand-in, so the line must mean "ready". Left
  // alone, the gap between two lines of the script is microseconds, too narrow to show a wrong
  // order. So the stand-in runs under a DEBUG trap that pauses 0.2 s before each `trap` line: a
  // line said before the traps leaves 0.2 s with no TERM trap, and the SIGTERM below lands in it
  // (the stand-in then dies by the signal). Said after them, nothing pauses between the line and
  // the `wait` it ends in, and the trap stops the tool. `set -T` carries the DEBUG trap into the
  // sourced script.
  const since = nowToken();
  const p = Bun.spawn(
    [
      "bash",
      "-c",
      `set -T; trap '[[ $BASH_COMMAND == trap* ]] && sleep 0.2' DEBUG; . "$0"`,
      join(FX, "standin-agent.sh"),
    ],
    {
      env: { ...process.env, STANDIN_SLEEP: "311" },
      stdout: "ignore",
      stderr: "pipe",
    },
  );
  const self = probe(p.pid);
  if (self.kind === "alive") own(self.info);
  const reader = p.stderr.getReader();
  let text = "";
  while (!/tool \d+\n/.test(text)) {
    const r = await reader.read();
    if (r.done) break;
    text += new TextDecoder().decode(r.value);
  }
  reader.releaseLock();
  const pid = toolPid(text);
  // The tool leads its own group (the stand-in runs it with job control).
  const tool = ownPrinted(pid, since, { pgid: pid });
  p.kill("SIGTERM"); // at once: no time for a late trap to be installed
  expect(tool).not.toBeNull();
  expect(await p.exited).toBe(0); // the TERM trap ran: `exit 0`, not death by the signal
  expect(p.signalCode).toBeNull();
  expect(await allGone(tool ? [tool] : [])).toBe(true);
});

test("the stand-in's script says `tool <pid>` after all of its traps", () => {
  // The order itself, read from the script: what the test above shows by behaviour.
  const lines = readFileSync(join(FX, "standin-agent.sh"), "utf8").split("\n");
  const echo = lines.findIndex((l) => l.trim().startsWith('echo "tool '));
  const traps = lines.flatMap((l, i) => (l.trim().startsWith("trap ") ? [i] : []));
  expect(echo).toBeGreaterThan(-1);
  expect(traps.length).toBeGreaterThanOrEqual(2); // TERM/INT/HUP and QUIT, at least
  expect(traps.every((i) => i < echo)).toBe(true);
});

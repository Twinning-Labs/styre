// The Claude adapter driven against stand-in agents (ENG-485 task 6).
import { afterEach, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launchAgent } from "../../src/agent/launch.ts";
import { claudeAgentRunner } from "../../src/agent/providers/claude.ts";
import { codexAgentRunner } from "../../src/agent/providers/codex.ts";
import * as door from "../../src/util/process/door.ts";
import { probe } from "../../src/util/process/proc-table.ts";
import { realStopDeps } from "../../src/util/process/stop.ts";

const FX = join(import.meta.dir, "fixtures");
const input = {
  prompt: "x",
  model: "m",
  allowedTools: ["Read"],
  cwd: process.cwd(),
  timeoutMs: 300,
};
/** Count live processes whose command line contains `marker` (tests may spawn; the guard covers src/). */
const running = (marker: string) =>
  Bun.spawnSync(["pgrep", "-f", marker]).stdout.toString().trim().split("\n").filter(Boolean)
    .length;

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "styre-agent-stop-")));
/** An executable stand-in CLI; `body` runs under bash and sees the test's env. */
function script(name: string, body: string): string {
  const path = join(scratch, name);
  writeFileSync(path, `#!/bin/bash\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}

afterEach(() => {
  // Even on failure: nothing a test started may outlive it.
  Bun.spawnSync(["pkill", "-9", "-f", "sleep 30[0-9]"]);
  Bun.spawnSync(["pkill", "-9", "-f", "standin-agent.sh"]);
  door.__resetForTests();
  Reflect.deleteProperty(process.env, "STANDIN_SLEEP");
  Reflect.deleteProperty(process.env, "TERM_MARKER");
});

test("a timeout stops the agent gracefully, so its command in its own group is gone too", async () => {
  process.env.STANDIN_SLEEP = "301";
  const r = await claudeAgentRunner(join(FX, "standin-agent.sh")).run(input);
  expect(r.timedOut).toBe(true);
  await Bun.sleep(100);
  expect(running("sleep 301")).toBe(0);
});

/** Wrap the real stop functions so a test can see every signal the door sends. */
function recordSignals(): NodeJS.Signals[] {
  const sent: NodeJS.Signals[] = [];
  door.__setStopDepsForTests({
    ...realStopDeps,
    kill: (target, sig) => {
      sent.push(sig);
      realStopDeps.kill(target, sig);
    },
  });
  return sent;
}

test("a timeout is graceful: only SIGTERM is sent when the agent exits within the grace period", async () => {
  // No timing dependence: the stand-in exits on SIGTERM (or dies of it), so a forced stop is the
  // only way a SIGKILL could be sent.
  process.env.STANDIN_SLEEP = "304";
  const sent = recordSignals();
  const r = await claudeAgentRunner(join(FX, "standin-agent.sh")).run(input);
  expect(r.timedOut).toBe(true);
  expect(sent.length).toBeGreaterThan(0);
  expect(sent.every((sig) => sig === "SIGTERM")).toBe(true);
  await Bun.sleep(100);
  expect(running("sleep 304")).toBe(0);
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
  const sent = recordSignals();
  const r = await claudeAgentRunner(cli).run({ ...input, timeoutMs: 20_000 });
  expect(r.completed).toBe(false);
  expect(r.capabilities?.error).toContain("stopped at startup");
  await Bun.sleep(200);
  expect(existsSync(marker)).toBe(false);
  expect(sent.length).toBeGreaterThan(0);
  expect(sent.every((sig) => sig === "SIGKILL")).toBe(true); // forced: never a SIGTERM first
  expect(running("sleep 305")).toBe(0);
});

test("an agent launched through a wrapper is stopped completely on timeout", async () => {
  process.env.STANDIN_SLEEP = "302";
  const r = await claudeAgentRunner(join(FX, "wrapped-standin.sh")).run(input);
  expect(r.timedOut).toBe(true);
  await Bun.sleep(100);
  expect(running("standin-agent.sh")).toBe(0);
  expect(running("sleep 302")).toBe(0);
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
  await Bun.sleep(200);
  door.beginStopping();
  for (const h of door.liveLaunches()) {
    h.interrupted = true;
    await h.stop("graceful");
  }
  expect(await outcome).toBeInstanceOf(door.RunInterrupted);
  expect(running("sleep 303")).toBe(0);
});

test("an interrupted agent that is also past its timeout is still reported as interrupted", async () => {
  process.env.STANDIN_SLEEP = "307";
  const runner = claudeAgentRunner(join(FX, "standin-agent.sh"));
  const p = runner.run({ ...input, timeoutMs: 600 });
  await Bun.sleep(200);
  for (const h of door.liveLaunches()) h.interrupted = true; // flagged, not yet stopped
  const r = await p;
  expect(r.interrupted).toBe(true);
  expect(r.timedOut).toBe(false);
  expect(running("sleep 307")).toBe(0);
});

test("the agent stays in Styre's own group and carries the context it was given", async () => {
  process.env.STANDIN_SLEEP = "308";
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
  await Bun.sleep(300);
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
    const real = await import("../../src/util/process/stop.ts");
    door.__setStopDepsForTests({
      list: real.realStopDeps.list,
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
  const r = await codexAgentRunner(join(FX, "standin-agent.sh")).run(input);
  expect(r.timedOut).toBe(true);
  await Bun.sleep(100);
  expect(running("sleep 300")).toBe(0);
});

test("a survivor of a timeout stop no longer keeps the subprocess referenced", async () => {
  process.env.STANDIN_SLEEP = "310";
  const real = realStopDeps;
  let t = 0;
  door.__setStopDepsForTests({
    list: real.list,
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
    await Bun.sleep(100);
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
  const state = realpathSync(mkdtempSync(join(tmpdir(), "styre-agent-state-")));
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

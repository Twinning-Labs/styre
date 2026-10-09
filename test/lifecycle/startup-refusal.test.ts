// ENG-485 section 6.1 step 5 and section 6.3 (final review A F1, C I3): the ENG-476 startup
// refusal's forced stop is awaited before the launch is finished. A process it cannot stop is
// named with the section 7.3 line; a forced stop that fails outright falls back to killing the
// agent's own process, and says so. Never silent.
//
// Safety: the "survivor" is a fake process table entry with pid 999999, which cannot exist on
// macOS (pids end at 99999) and is far above Linux's usual limit. The stop's kill function refuses
// it with EPERM before any real signal, so a fake only makes a stop do less. Every real process is
// this test's own, claimed through test/helpers/own-processes.ts and stopped in afterEach.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeAgentRunner } from "../../src/agent/providers/claude.ts";
import * as door from "../../src/util/process/door.ts";
import { type ProcInfo, listProcesses, probe } from "../../src/util/process/proc-table.ts";
import { processesDir } from "../../src/util/process/records.ts";
import { realStopDeps } from "../../src/util/process/stop.ts";
import { killOwned, ownLaunch, until } from "../helpers/own-processes.ts";

const FAKE = 999999;
const scratch = realpathSync(mkdtempSync(join(tmpdir(), "styre-refusal-")));
const pollers: ReturnType<typeof setInterval>[] = [];

const savedState = process.env.XDG_STATE_HOME;
beforeEach(() => {
  // A records folder of this file's own, so another file's records are never read here.
  process.env.XDG_STATE_HOME = mkdtempSync(join(scratch, "state-"));
});
afterEach(() => {
  process.env.XDG_STATE_HOME = savedState;
  for (const t of pollers.splice(0)) clearInterval(t);
  for (const h of door.liveLaunches()) ownLaunch(h);
  killOwned();
  door.__resetForTests();
});

/** Claims the live agent's tree every 10 ms, so afterEach can stop whatever is left. */
function claimWhileRunning(): void {
  pollers.push(
    setInterval(() => {
      for (const h of door.liveLaunches()) ownLaunch(h);
    }, 10),
  );
}

/** A stand-in CLI that reports a wider tool set than the step allows, then runs `rest`. */
function wideCli(name: string, rest: string): string {
  const init = JSON.stringify({
    type: "system",
    subtype: "init",
    tools: ["Read", "Bash"],
    permissionMode: "dontAsk",
    mcp_servers: [],
  });
  const path = join(scratch, name);
  writeFileSync(path, `#!/bin/sh\necho '${init}'\n${rest}\n`);
  chmodSync(path, 0o755);
  return path;
}

/** Everything written to Styre's stderr while `fn` runs. */
async function stderrOf<T>(fn: () => Promise<T>): Promise<{ value: T; lines: string[] }> {
  const lines: string[] = [];
  const real = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((s: string | Uint8Array) => {
    lines.push(String(s));
    return true;
  }) as typeof process.stderr.write;
  try {
    return { value: await fn(), lines };
  } finally {
    process.stderr.write = real;
  }
}

const input = (cwd: string) => ({
  prompt: "x",
  model: "m",
  allowedTools: ["Read"],
  cwd,
  timeoutMs: 20_000,
});

test("a process the refusal's forced stop cannot end is named with the exact line, once", async () => {
  const cwd = realpathSync(mkdtempSync(join(scratch, "wt-")));
  const cli = wideCli("wide-with-child.sh", "sleep 6.2519 </dev/null >/dev/null 2>&1");
  let agentPid: number | null = null;
  door.__setStopDepsForTests({
    ...realStopDeps,
    list: () => {
      const table = listProcesses();
      agentPid ??= door.liveLaunches().find((h) => h.record.kind === "agent")?.record.pid ?? null;
      if (agentPid === null) return table;
      const fake: ProcInfo = {
        pid: FAKE,
        ppid: agentPid,
        pgid: FAKE,
        startedAt: "1.000000",
        state: "running",
      };
      return [...table, fake];
    },
    kill: (target, sig) => {
      if (target === FAKE || target === -FAKE) {
        throw Object.assign(new Error("EPERM"), { code: "EPERM" });
      }
      realStopDeps.kill(target, sig);
    },
  });
  claimWhileRunning();
  const { value: r, lines } = await stderrOf(() => claudeAgentRunner(cli).run(input(cwd)));
  expect(r.capabilities?.error).toContain("stopped at startup");
  const survivor = lines.filter((l) => l.includes(`(pid ${FAKE})`));
  expect(survivor.length).toBe(1);
  expect(survivor[0]).toMatch(
    new RegExp(`^styre: could not stop .+ \\(pid ${FAKE}\\); stop it with: kill -9 ${FAKE}\\n$`),
  );
});

test("a forced stop that fails at startup kills the agent's own process and says so", async () => {
  const cwd = realpathSync(mkdtempSync(join(scratch, "wt-")));
  // The agent is the sleep itself (exec), so killing its own process ends everything it is.
  const cli = wideCli("wide-exec.sh", "exec sleep 7.3119 </dev/null >/dev/null 2>&1");
  let armed = false;
  door.__setStopDepsForTests({
    ...realStopDeps,
    list: () => {
      // Every read of the whole table fails once an agent is running: the stop cannot start.
      if (armed || door.liveLaunches().some((h) => h.record.kind === "agent")) {
        armed = true;
        throw new Error("the process table could not be read");
      }
      return listProcesses();
    },
  });
  claimWhileRunning();
  const t0 = Date.now();
  const { value: r, lines } = await stderrOf(() => claudeAgentRunner(cli).run(input(cwd)));
  const took = Date.now() - t0;
  expect(r.capabilities?.error ?? r.stderr).toContain("stopped at startup");
  // Killed at once, not left acting until the 20 s dispatch timeout.
  expect(took).toBeLessThan(5_000);
  const agent = lines.find((l) => l.startsWith("styre: could not stop the agent's process tree"));
  expect(agent).toMatch(
    /^styre: could not stop the agent's process tree at startup \(the process table could not be read\), so only the agent itself was killed \(pid \d+\); anything it started may still be running\n$/,
  );
  const pid = Number(/\(pid (\d+)\)/.exec(agent as string)?.[1]);
  const gone = () => {
    const q = probe(pid);
    return q.kind === "gone" || (q.kind === "alive" && q.info.state === "zombie");
  };
  expect(await until(gone, 2_000)).toBe(true);
}, 30_000);

test("no launch record is left on disk by a refused agent whose tree was stopped", async () => {
  const cwd = realpathSync(mkdtempSync(join(scratch, "wt-")));
  const cli = wideCli("wide-plain.sh", "sleep 6.4119 </dev/null >/dev/null 2>&1");
  claimWhileRunning();
  const { value: r } = await stderrOf(() => claudeAgentRunner(cli).run(input(cwd)));
  expect(r.capabilities?.error).toContain("stopped at startup");
  expect(door.liveLaunches()).toEqual([]);
  let names: string[] = [];
  try {
    names = readdirSync(processesDir());
  } catch {
    names = [];
  }
  expect(names).toEqual([]);
});

process.on("exit", () => rmSync(scratch, { recursive: true, force: true }));

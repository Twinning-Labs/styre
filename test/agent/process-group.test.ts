import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { killProcessGroup } from "../../src/agent/process-group.ts";

const dir = realpathSync(mkdtempSync(join(tmpdir(), "styre-pg-")));

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test("killProcessGroup kills a detached process AND the grandchild it started", async () => {
  const marker = join(dir, "grandchild-acted.txt");
  // The shell starts a grandchild that would create the marker after a delay, then waits.
  const proc = Bun.spawn(["sh", "-c", `(sleep 1; touch '${marker}') & echo $!; wait`], {
    stdout: "pipe",
    detached: true,
  });
  const reader = proc.stdout.getReader();
  const first = new TextDecoder().decode((await reader.read()).value);
  const grandchild = Number(first.trim());
  expect(alive(grandchild)).toBe(true);
  killProcessGroup(proc.pid);
  await proc.exited;
  await Bun.sleep(1500); // past the grandchild's delay
  expect(existsSync(marker)).toBe(false);
  expect(alive(grandchild)).toBe(false);
});

test("killProcessGroup on a pid that is gone does not throw", () => {
  expect(() => killProcessGroup(2 ** 22 + 12345)).not.toThrow();
});

test("a termination signal to the runner is forwarded to the agent's group before the runner exits", async () => {
  const marker = join(dir, "agent-survived-signal.txt");
  const script = join(dir, "forward.ts");
  writeFileSync(
    script,
    `import { forwardTerminationSignals } from ${JSON.stringify(join(import.meta.dir, "../../src/agent/process-group.ts"))};
const agent = Bun.spawn(["sh", "-c", "sleep 1; touch '${marker}'"], { detached: true });
forwardTerminationSignals(agent.pid);
console.log("ready");
await Bun.sleep(5000);
`,
  );
  const runner = Bun.spawn(["bun", "run", script], { stdout: "pipe" });
  const reader = runner.stdout.getReader();
  await reader.read(); // "ready"
  runner.kill("SIGTERM");
  const code = await runner.exited;
  await Bun.sleep(1500);
  expect(existsSync(marker)).toBe(false); // the agent group died with the runner
  expect(runner.signalCode ?? code).not.toBe(0); // the runner still terminated, not swallowed
});

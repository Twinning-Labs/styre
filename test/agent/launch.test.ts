import { expect, test } from "bun:test";
import { chmodSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launchAgent } from "../../src/agent/launch.ts";
import { claudeAgentRunner } from "../../src/agent/providers/claude.ts";

// launchAgent through the REAL Claude adapter (a fake CLI binary, real spawn and parsing): the
// fault rule must keep ordinary failures ordinary and confinement faults loud.
const cwd = realpathSync(mkdtempSync(join(tmpdir(), "styre-launch-")));
function fakeCli(name: string, lines: unknown[], tail: string): string {
  const path = join(cwd, name);
  const body = lines.map((l) => JSON.stringify(l)).join("\n");
  writeFileSync(path, `#!/bin/sh\ncat <<'EOF'\n${body}\nEOF\n${tail}\n`);
  chmodSync(path, 0o755);
  return path;
}
const input = {
  prompt: "x",
  model: "m",
  allowedTools: ["Read", "Grep", "Glob"],
  cwd,
  timeoutMs: 10000,
};
const init = (tools: string[]) => ({
  type: "system",
  subtype: "init",
  tools,
  permissionMode: "dontAsk",
});

test("a session-limit death with a correct init is not a confinement fault (the run still pauses for budget)", async () => {
  const cli = fakeCli(
    "limit",
    [
      init(["Glob", "Grep", "Read"]),
      { type: "result", is_error: true, result: "You've hit your session limit · resets 5pm" },
    ],
    "exit 1",
  );
  const { result, fault } = await launchAgent(claudeAgentRunner(cli), input);
  expect(fault).toBeNull();
  expect(result.cause).toBe("session-limit");
  expect(result.resetAt).toBe("5pm");
});

test("a run killed at startup for a wrong tool set is a confinement fault", async () => {
  const cli = fakeCli("wide", [init(["Glob", "Grep", "Read", "Bash"])], "sleep 3");
  const { result, fault } = await launchAgent(claudeAgentRunner(cli), input);
  expect(result.completed).toBe(false);
  expect(fault).toContain("stopped at startup: unexpected tools: Bash");
});

test("a correct, completed run has no fault", async () => {
  const cli = fakeCli(
    "ok",
    [init(["Glob", "Grep", "Read"]), { type: "result", result: "done" }],
    "exit 0",
  );
  const { result, fault } = await launchAgent(claudeAgentRunner(cli), input);
  expect(fault).toBeNull();
  expect(result.stdout).toBe("done");
});

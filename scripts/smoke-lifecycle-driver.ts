// The process the live smoke (scripts/smoke-lifecycle.ts) stops: it plays `styre run` around one
// agent dispatch, with the REAL Claude adapter of the code under test. $SMOKE_ROOT names that code:
// the branch for the new code, or a checkout of main for the control run. When the code has the
// ENG-485 stop handlers (src/util/process/signals.ts), they are installed as `styre run` installs
// them; main has none, so there the driver dies as main's `styre run` did.
//
// It says on stderr, one `smoke-driver: …` line each:
//   handlers installed|none   whether the stop handlers are in place;
//   dispatch <epoch ms>       just before the dispatch starts (a timeout's instant is counted from it);
//   result <json>             what the dispatch returned, if it returns.
// Everything Styre itself says goes to the same stderr.
//
// Environment: SMOKE_ROOT, SMOKE_REPO (the agent's working folder), SMOKE_MODEL, SMOKE_TIMEOUT_MS,
// SMOKE_IDENT. The caller points XDG_STATE_HOME at a folder of its own.
import { existsSync } from "node:fs";
import { join } from "node:path";
import type * as Claude from "../src/agent/providers/claude.ts";
import type * as Signals from "../src/util/process/signals.ts";

const need = (name: string): string => {
  const v = process.env[name];
  if (!v) throw new Error(`smoke-driver: ${name} is not set`);
  return v;
};
const root = need("SMOKE_ROOT");
const repo = need("SMOKE_REPO");
const model = need("SMOKE_MODEL");
const timeoutMs = Number(need("SMOKE_TIMEOUT_MS"));
const ident = need("SMOKE_IDENT");

const say = (line: string): void => {
  process.stderr.write(`smoke-driver: ${line}\n`);
};

const signals = join(root, "src", "util", "process", "signals.ts");
if (existsSync(signals)) {
  const { installStopHandlers } = (await import(signals)) as typeof Signals;
  installStopHandlers({ command: "run", run: null });
  say("handlers installed");
} else {
  say("handlers none");
}

const { claudeAgentRunner } = (await import(
  join(root, "src", "agent", "providers", "claude.ts")
)) as typeof Claude;

/** The prompt of the design's experiment (spec 2.1). */
const PROMPT =
  "Run this project's test suite with the Bash tool: `sh test.sh` (in the foreground, with a 300000 ms timeout), then report whether it passed.";

say(`dispatch ${Date.now()}`);
const r = await claudeAgentRunner().run({
  prompt: PROMPT,
  model,
  allowedTools: ["Read", "Bash(sh:*)"],
  cwd: repo,
  timeoutMs,
  // Main's adapter has no `context` and ignores it.
  context: { ident, stepId: null, worktree: repo },
});
say(
  `result ${JSON.stringify({
    completed: r.completed,
    timedOut: r.timedOut,
    exitCode: r.exitCode,
    interrupted: r.interrupted === true,
    // The CLI's own complaint, when it failed: the tail of its stderr and plain output.
    stderr: r.completed ? "" : r.stderr.slice(-600),
    stdout: r.completed ? "" : r.stdout.slice(-600),
  })}`,
);
// As the CLI's error boundary does (src/cli/output.ts guard): while a stop is in progress the stop
// handler owns the exit, so an interrupted dispatch ends nothing here; the handler re-raises.
if (r.interrupted !== true) process.exit(0);

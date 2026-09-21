import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCommand } from "../util/run-command.ts";
import type { CmdRunner } from "../util/run-command.ts";
import {
  type CheckExecutionPlan,
  executionCwd,
  interpretCheckExecution,
} from "./check-execution.ts";
import { type CheckFramework, type CoarseOrNone, interpretRunOutput } from "./check-selector.ts";

export interface CheckRunResult {
  /** The coarse RED-first bucket, or `selected-none` (identity reject, §5.1). */
  coarse: CoarseOrNone;
  /** The exact assembled command line that ran (for the ac_check selector / observability). */
  command: string;
  /** Combined stdout+stderr, stored in ground_truth_signal.detail_json (M3 subdivides `red` from it). */
  rawOutput: string;
  /** The process exit code, or `null` on timeout/spawn failure (M3: recorded in the signal detail). */
  exitCode: number | null;
  reason?: string;
  behavioralFailure?: boolean;
}

/** Run ONE authored check RED-first, in-suite: assemble `<binary> <runArgs>`, run it in the component
 *  dir `cwd` (so the suite's setup context — conftest / jest config / session fixtures / migrations —
 *  still applies, §5.3), and read the coarse verdict via `interpretRunOutput` (ground truth, never the
 *  agent's word). The runner is injectable for tests (decision 4); production passes the real
 *  `runCommand` (scrubbed env, capability isolation). */
export async function runCheckForRed(p: {
  framework: CheckFramework;
  binary: string;
  runArgs: string;
  cwd: string;
  timeoutMs: number;
  run?: CmdRunner;
}): Promise<CheckRunResult> {
  const command = `${p.binary} ${p.runArgs}`;
  const out = await (p.run ?? runCommand)(command, { cwd: p.cwd, timeoutMs: p.timeoutMs });
  return {
    coarse: interpretRunOutput(p.framework, out),
    command,
    rawOutput: `${out.stdout}\n${out.stderr}`.trim(),
    exitCode: out.exitCode,
  };
}

/** Execute a frozen plan identically at the design, replay, and implemented revisions. */
export async function runCheckExecution(p: {
  plan: CheckExecutionPlan;
  worktreePath: string;
  timeoutMs: number;
  run?: CmdRunner;
}): Promise<CheckRunResult> {
  let root = p.worktreePath;
  try {
    root = realpathSync(root);
  } catch {
    /* runner reports missing cwd; injectable tests may use virtual paths */
  }
  const cwd = executionCwd(p.plan, root);
  const reportDir =
    p.plan.framework === "mocha" ? mkdtempSync(join(tmpdir(), "styre-mocha-report-")) : undefined;
  const reportPath = reportDir ? join(reportDir, "result.json") : undefined;
  const reporterArg = reportPath
    ? ` --reporter-option 'output=${reportPath.replace(/'/g, "'\\''")}'`
    : "";
  const command = `${p.plan.launcher} ${p.plan.runArgs}${reporterArg}`;
  try {
    const out = await (p.run ?? runCommand)(command, { cwd, timeoutMs: p.timeoutMs });
    let report = out.stdout;
    if (reportPath) {
      try {
        report = readFileSync(reportPath, "utf8");
      } catch {
        report = "";
      }
    }
    return {
      ...interpretCheckExecution(p.plan, { ...out, stdout: report }, root),
      command,
      rawOutput: [out.stdout, out.stderr, reportPath ? report : ""]
        .filter(Boolean)
        .join("\n")
        .trim(),
      exitCode: out.exitCode,
    };
  } finally {
    if (reportDir) rmSync(reportDir, { recursive: true, force: true });
  }
}

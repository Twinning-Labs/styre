import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EnvironmentObservation } from "../testing/environment-schema.ts";
import { requireTestEnvironment } from "../testing/environment.ts";
import { runCommand } from "../util/run-command.ts";
import type { CmdRunner } from "../util/run-command.ts";
import {
  type CheckExecutionPlan,
  executionCwd,
  interpretCheckExecution,
} from "./check-execution.ts";
import { type CheckFramework, type CoarseOrNone, interpretRunOutput } from "./check-selector.ts";
import type { Component } from "./profile.ts";

export interface CheckRunResult {
  /** Measured for this execution checkout; distinct from the frozen plan fingerprint. */
  environment?: EnvironmentObservation;
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
  components?: Component[];
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
  let environment: EnvironmentObservation | undefined;
  const commandPrefix = `${p.plan.launcher} ${p.plan.runArgs}`;
  const invalid = (reason: string): CheckRunResult => ({
    coarse: "error",
    command: commandPrefix,
    rawOutput: reason,
    reason,
    exitCode: null,
    ...(environment ? { environment } : {}),
  });
  const component = p.components?.find((c) => c.name === p.plan.component);
  if (p.plan.environmentFingerprint && !component?.testEnvironment)
    return invalid("Qualified execution plan requires its component environment contract");
  if (component?.testEnvironment) {
    if (
      component.testAction?.launcher !== p.plan.launcher ||
      component.testAction?.framework !== p.plan.framework ||
      (component.dir ?? ".") !== p.plan.cwd ||
      p.plan.selectorCwd !== p.plan.cwd
    )
      return invalid(
        "Persisted execution context differs from current test environment intent; re-author the check",
      );
    const obs = await requireTestEnvironment(root, component, { run: p.run });
    environment = obs;
    if (!obs || !["ready", "empty"].includes(obs.status))
      return invalid(
        `Test environment could not be qualified at execution checkout: ${obs?.reason ?? "unknown"}`,
      );
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
      ...(environment ? { environment } : {}),
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

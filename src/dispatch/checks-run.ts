import { runCommand } from "../util/run-command.ts";
import { type CheckFramework, type CoarseOrNone, interpretRunOutput } from "./check-selector.ts";
import type { CmdRunner } from "./reuse.ts";

export interface CheckRunResult {
  /** The coarse RED-first bucket, or `selected-none` (identity reject, §5.1). */
  coarse: CoarseOrNone;
  /** The exact assembled command line that ran (for the ac_check selector / observability). */
  command: string;
  /** Combined stdout+stderr, stored in ground_truth_signal.detail_json (M3 subdivides `red` from it). */
  rawOutput: string;
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
  };
}

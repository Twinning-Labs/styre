import type { Database } from "bun:sqlite";
import { killProcessGroup } from "../agent/process-group.ts";
import * as steps from "../db/repos/workflow-step.ts";
import { StepExecutionError } from "../engine/step-journal.ts";
import { isSuiteStep } from "./verification-retry.ts";

export interface RecoverDeps {
  /** True if this PID is alive; a negative value denotes a POSIX process group. */
  isAlive: (pid: number) => boolean;
  /** Force-kill the process or negative-PID process group journaled before the crash. */
  kill: (pid: number) => void;
}

export interface RecoverResult {
  reset: number;
  killed: number;
}

/** Crash recovery (control-loop §6.1). A step left 'running' is the complete record
 *  that a crash interrupted it. Kill any journaled orphan still alive (the ENG-131
 *  lesson), then reset the step to 'pending' so the resolver re-picks it. A dispatch
 *  retry is a fresh attempt (§6.3); exactly-once for external effects is provided by
 *  keyed/probed effects (§3 / §5), added with the adapters in M6 — so resetting to
 *  pending is the correct, complete behavior for the substrate at M1. */
export function recover(db: Database, deps: RecoverDeps): RecoverResult {
  const running = steps.listByStatus(db, "running");
  let killed = 0;
  for (const step of running) {
    if (step.pid !== null && deps.isAlive(step.pid)) {
      deps.kill(step.pid);
      killed++;
    }
    // An interrupted suite is incomplete execution, not a verdict. Retain its consumed attempt
    // and typed error so restarting cannot skip the same bounded retry policy as a timeout.
    if (isSuiteStep(step)) {
      steps.markFailed(db, step.id, new StepExecutionError("verification execution interrupted"));
    }
    steps.resetToPending(db, step.id);
  }
  return { reset: running.length, killed };
}

/** Production deps: liveness via signal 0 (throws if the pid is gone), SIGKILL to the pid's
 *  process group (falling back to the pid alone) to kill. */
export function realRecoverDeps(): RecoverDeps {
  return {
    isAlive: (pid: number) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    },
    // Agents lead their own process group (ENG-476), so kill the group: an orphaned agent's
    // children (the real CLI behind a wrapper, tools it started) die with it.
    kill: (pid: number) => killProcessGroup(pid),
  };
}

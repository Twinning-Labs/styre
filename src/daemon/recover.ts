import type { Database } from "bun:sqlite";
import * as steps from "../db/repos/workflow-step.ts";
import { StepExecutionError } from "../engine/step-journal.ts";
import {
  findInterruption,
  olderCheckpointWarning,
  resetBranchAfterInterruption,
  undoInterruptedEdits,
} from "../util/process/interruption.ts";
import { isSuiteStep } from "./verification-retry.ts";

/** What `--resume` knows about the checkout (ENG-485 section 7.5). Without it (a fresh run's empty
 *  database), a matched interruption is still free, but nothing on disk is touched. */
export interface RecoverCtx {
  inPlace: boolean;
  repoPath: string;
  branch: string;
  acceptHead: boolean;
  warn: (line: string) => void;
}

export interface RecoverResult {
  /** Steps left `running` that were returned to `pending`. */
  reset: number;
  /** Of those, the ones matched to a recorded interruption. */
  interrupted: number;
  /** Older checkpoints whose journaled pid is still alive (section 5.5). */
  warned: number;
}

/** Crash and interruption recovery (control-loop §6.1, ENG-485 section 7.5). Kills nothing: the
 *  sweep (section 8) has already stopped any orphan, from its launch record.
 *
 *  For each step left `running`:
 *  - matched to a recorded interruption (step ID, attempt and start): the attempt was already given
 *    back, so it returns to `pending` without being marked failed, suite steps included. With a
 *    context, the in-place edits are undone and then the branch is returned to the step's start
 *    when that is safe;
 *  - otherwise it was a crash or a `kill -9`: a suite step keeps its consumed attempt and a typed
 *    error, so restarting cannot skip the bounded retry policy, and the step returns to `pending`. */
export function recover(db: Database, ctx?: RecoverCtx): RecoverResult {
  const running = steps.listByStatus(db, "running");
  let interrupted = 0;
  let warned = 0;
  for (const step of running) {
    const older = olderCheckpointWarning(step);
    if (older) {
      ctx?.warn(older);
      warned++;
    }
    const p = findInterruption(db, step);
    if (p) {
      interrupted++;
      if (ctx) {
        const undo = undoInterruptedEdits(p, ctx);
        if (undo) ctx.warn(undo);
        const reset = resetBranchAfterInterruption(db, p, ctx);
        if (reset) ctx.warn(reset);
      }
      steps.resetToPending(db, step.id);
      continue;
    }
    if (isSuiteStep(step)) {
      steps.markFailed(db, step.id, new StepExecutionError("verification execution interrupted"));
    }
    steps.resetToPending(db, step.id);
  }
  return { reset: running.length, interrupted, warned };
}

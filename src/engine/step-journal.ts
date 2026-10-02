import type { Database } from "bun:sqlite";
import * as steps from "../db/repos/workflow-step.ts";
import { RunInterrupted, beginStep, endStep, isStopping } from "../util/process/door.ts";
import { ParkSignal } from "./park-signal.ts";

/** Thrown when a step is found 'running' — an in-flight or crash-interrupted run
 *  that recover() (control-loop §6.1) owns, not a fresh execution. */
export class StepInFlightError extends Error {
  constructor(stepKey: string) {
    super(`step '${stepKey}' is running; recovery owns it`);
    this.name = "StepInFlightError";
  }
}

/** The step cannot progress until an operator repairs a prerequisite. Journaled by name so
 * failure routing remains deterministic across process restarts; resume rechecks the prerequisite. */
export class StepPrerequisiteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StepPrerequisiteError";
  }
}

/** An attempted operation did not complete. Retry the same step within its attempt budget;
 * never interpret this as a behavioral verdict or ask an author to repair code for it. */
export class StepExecutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StepExecutionError";
  }
}

export interface RunStepParams {
  ticketId: number;
  workUnitId?: number | null;
  stepKey: string;
  stepType: string;
  input?: unknown;
  /** Effectful steps journal 'running' + idempotency key BEFORE the effect (control-loop §3). */
  effectful?: boolean;
  idempotencyKey?: string | null;
  /** The ticket's identifier, for the in-flight step record (ENG-485 section 5.5). Falls back to the
   *  ticket's numeric id when a caller gives none. */
  ident?: string;
  /** Reads the ticket branch's HEAD, or null when the branch does not exist yet. Called once, at the
   *  start of an effectful step, so a stop can return the branch there (ENG-485 section 7.5). */
  readHead?: () => string | null;
  execute: (step: steps.WorkflowStepRow) => unknown | Promise<unknown>;
  /** Synchronous side effect committed ATOMICALLY with `markSucceeded` (one transaction). Use for a
   *  decision that must never be separated from the step's success by a crash — e.g. applying the
   *  review verdict: if it ran in a later transaction, a crash in between would leave a `succeeded`
   *  review with an un-applied verdict and the resolver would advance past blocking findings. Runs
   *  after the (effectful, non-transactional) `execute`, so it sees the persisted effect. */
  onSucceed?: (step: steps.WorkflowStepRow) => void;
}

export interface RunStepResult {
  step: steps.WorkflowStepRow;
  result: unknown;
  replayed: boolean;
}

/**
 * The durable step executor (control-loop §3 / §6.2).
 *  - succeeded → return recorded result, never re-run (replay)
 *  - running   → throw StepInFlightError (recover owns it)
 *  - pending/failed → execute with write-ahead intent (effectful), journal the outcome
 *
 * Pure-vs-effectful split (deliberate design — do not "fix"):
 *   Only **effectful** steps journal `running` + an idempotency key before the effect
 *   (write-ahead intent, control-loop §3). **Pure** steps compute → `markSucceeded`
 *   with no `running` phase: a pure step is a deterministic recompute from SQLite state,
 *   so a crash leaves it `pending` (markSucceeded never committed), which is the correct,
 *   safe re-run state — there is no external effect to double-apply.
 *
 * Three-write effectful path (deliberate design — not an oversight):
 *   `markRunning` → `execute` → `markSucceeded` are intentionally NOT a single
 *   transaction: the external effect lives between intent and outcome (control-loop §3).
 *   Collapsing them would prevent write-ahead crash detection.
 *
 * M2 invariant (resolver / event loop):
 *   The resolver advances one step per ticket per tick; K-concurrency is across
 *   **tickets**, so no two workers ever share a `step_key`. The `StepInFlightError`
 *   guard + `recover()` cover crash-resume; per-ticket serialization covers concurrency.
 *   This is why pure steps need no `running` journal for safety.
 */
export async function runStep(db: Database, params: RunStepParams): Promise<RunStepResult> {
  // A stop that began before the step did: write nothing (no row, no markRunning, no attempt) and
  // start nothing. The step stays as it was, so resume runs it as if it had never been tried.
  if (params.effectful && isStopping()) throw new RunInterrupted();
  const existing = steps.getByKey(db, params.ticketId, params.stepKey);
  const step =
    existing ??
    steps.insertPending(db, {
      ticketId: params.ticketId,
      workUnitId: params.workUnitId ?? null,
      stepKey: params.stepKey,
      stepType: params.stepType,
      input: params.input,
    });

  if (step.status === "succeeded") {
    return {
      step,
      result: step.result_json === null ? null : JSON.parse(step.result_json),
      replayed: true,
    };
  }
  if (step.status === "running") {
    throw new StepInFlightError(params.stepKey);
  }

  // pending | failed → (re)execute
  // Effectful only: write-ahead intent + idempotency key before the external effect (control-loop §3).
  // No pid is journaled (ENG-485 section 5.5): the launch record on disk names what to stop.
  if (params.effectful) {
    steps.markRunning(db, step.id, { idempotencyKey: params.idempotencyKey ?? null });
  }

  const current = steps.getById(db, step.id);
  if (!current) {
    throw new Error(`runStep: step ${step.id} vanished`);
  }

  try {
    if (params.effectful) {
      // Registered in flight, with the branch HEAD at its start, until it ends in any way.
      beginStep({
        stepId: step.id,
        // markRunning set started_at in the same statement as the status; the interruption note
        // is matched on this exact value.
        startedAt: requireStartedAt(current),
        ident: params.ident ?? String(params.ticketId),
        headAtStart: params.readHead?.() ?? null,
      });
    }
    let result: unknown;
    try {
      result = await params.execute(current);
    } catch (err) {
      // Section 7.5: any error while a stop is in progress is an interruption, whatever its type.
      if (isStopping()) throw new RunInterrupted();
      throw err;
    }
    // A call site that turns every error into an ordinary result returns normally; check here too.
    if (isStopping()) throw new RunInterrupted();
    // markSucceeded + onSucceed commit together: a verdict-bearing step's decision is never split
    // from its success by a crash (control-loop §3 / §6.2). bun:sqlite nests as a SAVEPOINT, so an
    // onSucceed that opens its own transaction (applyReviewVerdict) composes correctly.
    db.transaction(() => {
      steps.markSucceeded(db, step.id, result);
      params.onSucceed?.(current);
    })();
    const finished = steps.getById(db, step.id);
    if (!finished) {
      throw new Error(`runStep: step ${step.id} vanished after success`);
    }
    return { step: finished, result, replayed: false };
  } catch (err) {
    if (err instanceof RunInterrupted) {
      // Leave the step 'running': the signal handler owns the interruption, and --resume returns
      // the step to pending without consuming an attempt.
      throw err;
    }
    // An ordinary error that surfaces while a stop is in progress (a refused write, say) is an
    // interruption too, never a failure to record.
    if (isStopping()) throw new RunInterrupted();
    if (err instanceof ParkSignal) {
      // Leave the step 'running': advance() records the park and resume()/recover() re-dispatch it.
      // Crucially, NOT markFailed → no attempt consumed (ENG-164: a quota pause is not a failure).
      throw err;
    }
    steps.markFailed(db, step.id, err);
    throw err;
  } finally {
    // While a stop is in progress the record stays: the signal handler reads it after the stopped
    // launch has already unwound this function, to write the interruption (ENG-485 section 7.5).
    if (params.effectful && !isStopping()) endStep();
  }
}

/** `markRunning` sets `started_at` in the same statement as the status. A missing value afterwards
 *  is a bug, and the interruption is matched on this exact value, so never invent one. */
function requireStartedAt(row: steps.WorkflowStepRow): string {
  if (row.started_at === null) {
    throw new Error(`runStep: step ${row.id} has no started_at after markRunning`);
  }
  return row.started_at;
}

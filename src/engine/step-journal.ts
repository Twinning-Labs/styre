import type { Database } from "bun:sqlite";
import * as steps from "../db/repos/workflow-step.ts";

/** Thrown when a step is found 'running' — an in-flight or crash-interrupted run
 *  that recover() (control-loop §6.1) owns, not a fresh execution. */
export class StepInFlightError extends Error {
  constructor(stepKey: string) {
    super(`step '${stepKey}' is running; recovery owns it`);
    this.name = "StepInFlightError";
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
  execute: (step: steps.WorkflowStepRow) => unknown | Promise<unknown>;
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
  if (params.effectful) {
    steps.markRunning(db, step.id, {
      idempotencyKey: params.idempotencyKey ?? null,
      pid: process.pid,
    });
  }

  const current = steps.getById(db, step.id);
  if (!current) {
    throw new Error(`runStep: step ${step.id} vanished`);
  }

  try {
    const result = await params.execute(current);
    steps.markSucceeded(db, step.id, result);
    const finished = steps.getById(db, step.id);
    if (!finished) {
      throw new Error(`runStep: step ${step.id} vanished after success`);
    }
    return { step: finished, result, replayed: false };
  } catch (err) {
    steps.markFailed(db, step.id, err);
    throw err;
  }
}

import { z } from "zod";
import type { TestEnvironmentPlan } from "../testing/environment-schema.ts";
import {
  LegacySuiteEvidenceSchema,
  SuiteReceiptSchema,
  legacySuiteVerdict,
  prepareSuite,
  receiptVerdict,
  suiteBinding,
  suiteReceipt,
} from "../testing/suite-adapters.ts";
import { runBoundedCommand } from "../util/run-bounded-command.ts";
import type { CommandResult } from "../util/run-command.ts";

/** Process observations are not test verdicts: exit 1 may be an assertion, import, or setup failure. */
export const SuiteObservationSchema = z
  .object({
    version: z.literal(1),
    sha: z.string().nullable(),
    command: z.string(),
    cwd: z.string(),
    outcome: z.enum(["completed-zero", "completed-nonzero", "timed-out", "execution-error"]),
    exitCode: z.number().int().nullable(),
    timedOut: z.boolean(),
    stdout: z.string(),
    stderr: z.string(),
    outputTruncated: z.boolean(),
    executedCommand: z.string().optional(),
    suite: SuiteReceiptSchema.optional(),
    /** Legacy checkpoints only; new writes use suite. */
    karma: LegacySuiteEvidenceSchema.optional(),
    // Optional for older checkpoints and synthetic observations, measured for native runs.
    timing: z
      .object({ durationMs: z.number().nonnegative(), timeoutMs: z.number().positive() })
      .optional(),
  })
  .refine(
    (o) =>
      o.outcome ===
      (o.timedOut
        ? "timed-out"
        : o.exitCode === null
          ? "execution-error"
          : o.exitCode === 0
            ? "completed-zero"
            : "completed-nonzero"),
    "execution status disagrees with exit/timeout evidence",
  );
export type SuiteObservation = z.infer<typeof SuiteObservationSchema>;

const limit = 3000;
function excerpt(text: string): string {
  return text.length <= limit
    ? text
    : `${text.slice(0, limit / 2)}\n[output omitted]\n${text.slice(-limit / 2)}`;
}

export function suiteObservation(
  context: { sha: string | null; command: string; cwd: string },
  run: CommandResult & { truncated?: boolean },
): SuiteObservation {
  return {
    version: 1,
    ...context,
    outcome: run.timedOut
      ? "timed-out"
      : run.exitCode === null
        ? "execution-error"
        : run.exitCode === 0
          ? "completed-zero"
          : "completed-nonzero",
    exitCode: run.exitCode,
    timedOut: run.timedOut,
    stdout: excerpt(run.stdout),
    stderr: excerpt(run.stderr),
    outputTruncated: !!run.truncated || run.stdout.length > limit || run.stderr.length > limit,
  };
}

/** Bound capture as well as execution; never infer test identity or causality from output text. */
export async function observeSuiteCommand(p: {
  sha: string | null;
  command: string;
  cwd: string;
  timeoutMs: number;
  environment?: TestEnvironmentPlan;
  onSpawn?: (pid: number) => void;
  onSettled?: () => void;
}): Promise<SuiteObservation> {
  const started = performance.now();
  if (p.environment && p.environment.suiteCommand !== p.command)
    throw Error("Suite command differs from its environment contract");
  const binding = suiteBinding(p.environment);
  const prepared = prepareSuite(p.command, p.cwd, binding);
  try {
    const run = await runBoundedCommand(prepared.command, p);
    return {
      ...suiteObservation({ sha: p.sha, command: p.command, cwd: p.cwd }, run),
      suite: suiteReceipt(p.command, p.cwd, binding, prepared.read(), run),
      executedCommand: prepared.command,
      timing: { durationMs: performance.now() - started, timeoutMs: p.timeoutMs },
    };
  } finally {
    prepared.cleanup();
    p.onSettled?.();
  }
}

/** Keep the actual process exit separately from the qualified suite verdict. */
export function suiteResult(observation: SuiteObservation): "pass" | "fail" | "error" {
  if (observation.timedOut || observation.exitCode === null) return "error";
  if (observation.suite)
    return receiptVerdict(observation.suite, observation.command, observation.cwd, observation);
  if (observation.karma) return legacySuiteVerdict(observation.karma, observation);
  return observation.exitCode === 0 ? "pass" : "fail";
}

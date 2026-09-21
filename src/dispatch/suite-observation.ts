import { z } from "zod";
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
  onSpawn?: (pid: number) => void;
  onSettled?: () => void;
}): Promise<SuiteObservation> {
  try {
    const run = await runBoundedCommand(p.command, p);
    return suiteObservation({ sha: p.sha, command: p.command, cwd: p.cwd }, run);
  } finally {
    p.onSettled?.();
  }
}

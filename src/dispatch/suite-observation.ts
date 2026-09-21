import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type { TestEnvironmentPlan } from "../testing/environment-schema.ts";
import { KarmaCompletionSchema, karmaReporterConfig, karmaVerdict } from "../testing/karma.ts";
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
    karma: z
      .object({
        verdict: z.enum(["pass", "fail", "error"]),
        completion: KarmaCompletionSchema.optional(),
        reason: z.string().optional(),
      })
      .optional(),
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
  let dir: string | undefined;
  try {
    let command = p.command;
    let reportPath: string | undefined;
    if (p.environment?.adapter === "karma") {
      if (p.environment.suiteCommand !== p.command)
        throw Error("Karma suite command differs from its environment contract");
      dir = mkdtempSync(join(tmpdir(), "styre-karma-"));
      reportPath = join(dir, "completion.json");
      const wrapper = join(dir, "config.cjs");
      writeFileSync(wrapper, karmaReporterConfig(p.cwd, p.environment, reportPath), {
        mode: 0o600,
      });
      command = `${p.command} -- --single-run=true '${wrapper.replace(/'/g, `'\\''`)}'`;
    }
    const run = await runBoundedCommand(command, p);
    let karma: SuiteObservation["karma"];
    if (reportPath && p.environment?.adapter === "karma") {
      let report: unknown;
      try {
        if (statSync(reportPath).size > 65536) throw Error("oversized completion");
        report = JSON.parse(readFileSync(reportPath, "utf8"));
      } catch {
        /* absence/malformed evidence is an explicit execution error below */
      }
      const parsed = KarmaCompletionSchema.safeParse(report);
      const verdict = run.timedOut
        ? "error"
        : karmaVerdict(report, run.exitCode, p.environment.browsers.length);
      karma = {
        verdict,
        ...(parsed.success ? { completion: parsed.data } : {}),
        ...(verdict === "error"
          ? {
              reason: "Karma did not complete a nonempty, consistent run on every declared browser",
            }
          : {}),
      };
    }
    return {
      ...(karma ? { karma, executedCommand: command } : {}),
      ...suiteObservation({ sha: p.sha, command: p.command, cwd: p.cwd }, run),
      timing: { durationMs: performance.now() - started, timeoutMs: p.timeoutMs },
    };
  } finally {
    if (dir) rmSync(dir, { recursive: true, force: true });
    p.onSettled?.();
  }
}

/** Keep the actual process exit separately from the qualified suite verdict. */
export function suiteResult(observation: SuiteObservation): "pass" | "fail" | "error" {
  if (observation.timedOut || observation.exitCode === null) return "error";
  if (observation.karma) return observation.karma.verdict;
  return observation.exitCode === 0 ? "pass" : "fail";
}

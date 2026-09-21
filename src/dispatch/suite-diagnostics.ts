import { z } from "zod";
import type { GroundTruthSignalRow } from "../db/repos/ground-truth-signal.ts";
import { SuiteObservationSchema } from "./suite-observation.ts";

const DetailSchema = z.object({
  advisory: z.literal(true),
  ran: z.array(
    z.object({
      label: z.string().optional(),
      component: z.string().optional(),
      observation: z.unknown().optional(),
    }),
  ),
  baseline: z
    .object({
      requestedSha: z.string(),
      comparison: z.literal("unqualified"),
      reason: z.string(),
      execution: z.unknown(),
    })
    .optional(),
  notExecuted: z.array(z.string()).optional(),
  reason: z.string().optional(),
  component: z.string().optional(),
  changed: z.array(z.string()).optional(),
});
function readDetail(row: GroundTruthSignalRow) {
  try {
    const parsed = DetailSchema.safeParse(JSON.parse(row.detail_json ?? "null"));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Neutral, bounded context. Preserve provenance even when command output must be shortened.
 * Old checkpoints lack observations; say so rather than reconstructing evidence from an exit. */
export function suiteDiagnostics(rows: GroundTruthSignalRow[], currentSha: string | null) {
  const latest = new Map<
    string,
    { row: GroundTruthSignalRow; detail: NonNullable<ReturnType<typeof readDetail>> }
  >();
  for (const row of rows) {
    const detail = readDetail(row);
    if (detail) {
      const key = JSON.stringify([row.work_unit_id, row.signal_type]);
      // Map replacement preserves the original position; move updates to the newest end.
      latest.delete(key);
      latest.set(key, { row, detail });
    }
  }
  const failed = [...latest.values()].filter(({ row }) => row.result !== "pass");
  return {
    interpretation:
      "Command diagnostics only. Test identity and baseline causality are not established. Investigate relevant failures; do not blindly repair unrelated suite failures.",
    omittedSignals: Math.max(0, failed.length - 8),
    observations: failed.slice(-8).map(({ row, detail }) => {
      const summarize = (observation: unknown) => {
        const parsed = SuiteObservationSchema.safeParse(observation);
        if (!parsed.success) return null;
        const o = parsed.data;
        return {
          sha: o.sha,
          command: o.command,
          cwd: o.cwd,
          outcome: o.outcome,
          exitCode: o.exitCode,
          timedOut: o.timedOut,
          stdout: typeof o.stdout === "string" ? o.stdout.slice(-750) : null,
          stderr: typeof o.stderr === "string" ? o.stderr.slice(-750) : null,
          outputTruncated:
            o.outputTruncated === true ||
            (typeof o.stdout === "string" && o.stdout.length > 750) ||
            (typeof o.stderr === "string" && o.stderr.length > 750),
        };
      };
      const jobs = detail.ran.slice(-4).map((job) => ({
        label: job.label ?? job.component,
        execution: summarize(job.observation),
      }));
      return {
        signalId: row.id,
        workUnitId: row.work_unit_id,
        type: row.signal_type,
        result: row.result,
        aggregateReason: detail.reason ?? null,
        component: detail.component ?? null,
        changed: detail.changed?.slice(0, 10) ?? null,
        measuredSha: row.branch_head_sha,
        atCurrentSha: currentSha !== null && row.branch_head_sha === currentSha,
        omittedJobs: Math.max(0, detail.ran.length - 4),
        jobs,
        baseline: detail.baseline
          ? {
              requestedSha: detail.baseline.requestedSha,
              comparison: detail.baseline.comparison,
              reason: detail.baseline.reason,
              execution: summarize(detail.baseline.execution),
            }
          : null,
        comparison: "unqualified",
        notExecuted: detail.notExecuted?.slice(0, 10) ?? null,
        omittedNotExecuted: Math.max(0, (detail.notExecuted?.length ?? 0) - 10),
        evidenceMissing: !jobs.some((job) => job.execution !== null),
        jobsMissingEvidence: jobs.filter((job) => job.execution === null).length,
      };
    }),
  };
}

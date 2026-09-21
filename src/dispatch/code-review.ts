import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import type { HandlerContext } from "../daemon/step-registry.ts";
import { listByTicket as events, appendEvent } from "../db/repos/event-log.ts";
import { insertSignal, listByTicket as signals } from "../db/repos/ground-truth-signal.ts";
import {
  type ReviewCompletion,
  assertExactFindingIds,
  beginReviewContract,
  requiredCodeFindings,
} from "../db/repos/review-round.ts";
import { getTicket } from "../db/repos/ticket.ts";
import { listByTicket as units } from "../db/repos/work-unit.ts";
import { setPid } from "../db/repos/workflow-step.ts";
import { StepPrerequisiteError } from "../engine/step-journal.ts";
import { runBoundedCommand } from "../util/run-bounded-command.ts";
import { commandFor } from "./components.ts";
import type { Profile } from "./profile.ts";
import { validateReviewEvidence } from "./review-evidence.ts";
import { CodeReviewOutputSchema, validateReviewFindings } from "./review-schema.ts";
import { extractSidecar } from "./sidecar.ts";
import { suiteDiagnostics } from "./suite-diagnostics.ts";
import { pendingEntries, undoAttempt, worktreeHead } from "./worktree.ts";

export const REVIEW_PROBE_LIMIT = 3; // persisted per ticket, including interrupted requests
export function reviewJobs(profile: Profile) {
  const jobs = profile.components.flatMap((c, index) => {
    const command = commandFor(c, "test");
    return command ? [{ label: `${c.name}:test`, command, dir: c.dir ?? "", index }] : [];
  });
  return jobs.map((job) => ({
    ...job,
    id: createHash("sha256").update(JSON.stringify(job)).digest("hex"),
  }));
}

function reviewContext(db: Database, ticketId: number, sha: string, profile: Profile) {
  return JSON.stringify(
    {
      reviewed_sha: sha,
      original_ticket: {
        title: getTicket(db, ticketId)?.title,
        description: getTicket(db, ticketId)?.description,
      },
      suite_diagnostics: suiteDiagnostics(signals(db, ticketId), sha),
      work_units: units(db, ticketId).map((u) => ({
        id: u.id,
        seq: u.seq,
        title: u.title,
        files: u.files_to_touch,
      })),
      unresolved_findings: requiredCodeFindings(db, ticketId),
      author_responses: events(db, ticketId)
        .filter((e) => e.reason === "review-responses")
        .map((e) => ({ dispatch_id: e.dispatch_id, ...JSON.parse(e.payload_json ?? "{}") })),
      measurements: signals(db, ticketId)
        .filter((s) => s.branch_head_sha === sha)
        .slice(-30)
        .map((s) => ({
          ...s,
          detail_json: s.detail_json?.slice(0, 16000),
          detail_truncated: (s.detail_json?.length ?? 0) > 16000,
        })),
      available_verification_jobs: reviewJobs(profile),
      verification_requests_used: events(db, ticketId).filter(
        (e) => e.reason === "review-probe-requested",
      ).length,
      verification_request_limit: REVIEW_PROBE_LIMIT,
    },
    null,
    2,
  );
}

export async function runCodeReview(
  ctx: HandlerContext,
  deps: {
    profile: Profile;
    worktreePath: string;
    timeoutMs: number;
    dispatch: (context: string) => Promise<{ dispatchId: string; sha: string; output: string }>;
    executeProbe?: typeof runBoundedCommand;
  },
) {
  beginReviewContract(ctx.db, ctx.ticket.id);
  const previous = requiredCodeFindings(ctx.db, ctx.ticket.id);
  const unitSeqs = units(ctx.db, ctx.ticket.id).map((u) => u.seq);
  // Each request consumes a durable ticket-wide allowance BEFORE executing. A crash cannot buy a free probe.
  for (let turn = 0; turn <= REVIEW_PROBE_LIMIT; turn++) {
    const sha = worktreeHead(deps.worktreePath);
    const result = await deps.dispatch(reviewContext(ctx.db, ctx.ticket.id, sha, deps.profile));
    if (result.sha !== sha) throw new Error("read-only review changed HEAD");
    const parsed = extractSidecar(result.output, CodeReviewOutputSchema);
    if (!parsed.ok) throw new Error(`review sidecar ${parsed.reason}: ${parsed.detail}`);
    const output = parsed.value;
    const errors = validateReviewFindings(output.findings, unitSeqs, "code");
    if (errors.length) throw new Error(`review findings invalid: ${errors.join("; ")}`);
    if (!output.verification_requests.length) {
      assertExactFindingIds(
        output.resolutions.map((r) => r.finding_id),
        previous.map((f) => f.id),
      );
      for (const r of output.resolutions)
        validateReviewEvidence(ctx.db, ctx.ticket.id, deps.worktreePath, sha, r.evidence, true);
      const reviewCompletion: ReviewCompletion = {
        version: 1,
        dispatchId: result.dispatchId,
        sha,
        output,
      };
      return {
        reviewCompletion,
        findings: output.findings.length,
        blocking: output.findings.filter((f) => f.severity === "major" || f.severity === "critical")
          .length,
      };
    }
    if (output.findings.length || output.resolutions.length)
      throw new Error("verification request must not include a provisional review verdict");
    const job = reviewJobs(deps.profile).find((j) => j.id === output.verification_requests[0]);
    if (!job)
      throw new Error("review requested an unknown verification job; only catalog IDs are allowed");
    const requests = events(ctx.db, ctx.ticket.id).filter(
      (e) => e.reason === "review-probe-requested",
    );
    if (requests.length >= REVIEW_PROBE_LIMIT)
      throw new StepPrerequisiteError(
        "review verification request limit reached; inspect retained evidence before resuming",
      );
    const before = new Set(
      pendingEntries(deps.worktreePath)
        .filter((e) => e.isNew)
        .map((e) => e.path),
    );
    const cwd = realpathSync(join(deps.worktreePath, job.dir));
    const relativeCwd = relative(realpathSync(deps.worktreePath), cwd);
    if (relativeCwd === ".." || relativeCwd.startsWith("../") || isAbsolute(relativeCwd))
      throw new StepPrerequisiteError("review verification directory escapes the worktree");
    appendEvent(ctx.db, {
      ticketId: ctx.ticket.id,
      dispatchId: result.dispatchId,
      kind: "note",
      reason: "review-probe-requested",
      payload: { version: 1, sha, job },
    });
    const run = await (deps.executeProbe ?? runBoundedCommand)(job.command, {
      cwd,
      timeoutMs: deps.timeoutMs,
      // Negative PID deliberately journals the detached process GROUP. Recovery's signal-0/kill
      // then reaches descendants even when the original shell leader has already exited.
      onSpawn: (pid) => setPid(ctx.db, ctx.step.id, -pid),
    });
    setPid(ctx.db, ctx.step.id, null);
    const moved = worktreeHead(deps.worktreePath) !== sha;
    const dirtied = pendingEntries(deps.worktreePath).some((e) => !e.isNew || !before.has(e.path));
    insertSignal(ctx.db, {
      ticketId: ctx.ticket.id,
      signalType: "review-probe",
      branchHeadSha: sha,
      command: job.command,
      result:
        moved || dirtied || run.timedOut || run.exitCode === null
          ? "error"
          : run.exitCode === 0
            ? "pass"
            : "fail",
      detail: {
        version: 1,
        job,
        ...run,
        headMoved: moved,
        worktreeMutated: dirtied,
        meaning: "command execution only; not a claim that a particular assertion passed",
      },
    });
    if (moved)
      throw new StepPrerequisiteError(
        "review verification command changed HEAD; repair the worktree before resuming",
      );
    if (dirtied) undoAttempt(deps.worktreePath, before);
    if (run.timedOut)
      throw new StepPrerequisiteError(
        "review verification timed out; inspect the recorded probe before resuming",
      );
  }
  throw new Error("review exceeded verification request limit");
}

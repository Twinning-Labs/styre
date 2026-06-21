import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { branchNameFor } from "../agent/branch.ts";
import type { AgentRunner } from "../agent/runner.ts";
import type { AgentConfig } from "../config/agent-config.ts";
import { StepRegistry } from "../daemon/step-registry.ts";
import type { HandlerContext } from "../daemon/step-registry.ts";
import { getLatestByWorkUnit, getLatestForTicket } from "../db/repos/dispatch.ts";
import { listByTicket as listEvents } from "../db/repos/event-log.ts";
import { insertSignal, listByUnit } from "../db/repos/ground-truth-signal.ts";
import { getProject } from "../db/repos/project.ts";
import { insertFinding } from "../db/repos/review-finding.ts";
import { setTicketTrack } from "../db/repos/ticket.ts";
import {
  getById as getUnit,
  insertWorkUnit,
  listByTicket as listUnits,
  parseFilesToTouch,
  setStatus as setUnitStatus,
} from "../db/repos/work-unit.ts";
import { runCommand } from "../util/run-command.ts";
import { ExtractOutputSchema, validateExtraction } from "./extract-schema.ts";
import { implementFeedback } from "./feedback.ts";
import type { Profile } from "./profile.ts";
import {
  DESIGN_TEMPLATE,
  EXTRACT_TEMPLATE,
  IMPLEMENT_TEMPLATE,
  REVIEW_TEMPLATE,
  designVars,
  extractVars,
  implementVars,
  reviewVars,
} from "./prompt-vars.ts";
import { ReviewOutputSchema, computeBlocksShip, validateReviewFindings } from "./review-schema.ts";
import type { DispatchDeps } from "./run-dispatch.ts";
import { runAgentDispatch } from "./run-dispatch.ts";
import { extractSidecar } from "./sidecar.ts";
import { isTestFile } from "./test-file.ts";
import { sizeTrack } from "./track-sizing.ts";
import { changedFilesAt, ensureWorktree } from "./worktree.ts";

export interface RegistryDeps {
  runner: AgentRunner;
  agentConfig: AgentConfig;
  profile: Profile;
  worktreeRoot: string;
  timeoutMs?: number;
}

const DESIGN_TIMEOUT_MS = 60 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
const VERIFY_TIMEOUT_MS = 10 * 60 * 1000;

/** Resolve the repo + ticket worktree + branch for a DAEMON-run step (verify). Unlike
 *  `depsFor` this carries no agent capability — verify only reads the committed worktree. */
function worktreeFor(
  ctx: HandlerContext,
  deps: RegistryDeps,
): { repoPath: string; worktreePath: string; branch: string } {
  const project = getProject(ctx.db, ctx.ticket.project_id);
  if (!project) {
    throw new Error(`handler: project ${ctx.ticket.project_id} not found`);
  }
  return {
    repoPath: project.target_repo,
    worktreePath: join(deps.worktreeRoot, ctx.ticket.ident),
    branch: branchNameFor(ctx.ticket),
  };
}

/** Has this unit been bounced back to coding before? (a loopback event targeting its checks) */
function isUnitLoopback(ctx: HandlerContext, unitSeq: number): boolean {
  const prefix = `verify:wu${unitSeq}:`;
  return listEvents(ctx.db, ctx.ticket.id).some(
    (e) => e.kind === "loopback" && (e.route_to?.startsWith(prefix) ?? false),
  );
}

function depsFor(ctx: HandlerContext, deps: RegistryDeps, timeoutMs: number): DispatchDeps {
  const project = getProject(ctx.db, ctx.ticket.project_id);
  if (!project) {
    throw new Error(`handler: project ${ctx.ticket.project_id} not found`);
  }
  return {
    runner: deps.runner,
    agentConfig: deps.agentConfig,
    profile: deps.profile,
    repoPath: project.target_repo,
    worktreePath: join(deps.worktreeRoot, ctx.ticket.ident),
    branch: branchNameFor(ctx.ticket),
    timeoutMs,
  };
}

/** Register the real worktree-agent handlers (control-loop §4 S1a/S2b), provider-agnostic.
 *  design:extract (M5a) is real; design:review (M5b) and merge (M6) are added later. */
export function buildDispatchRegistry(deps: RegistryDeps): StepRegistry {
  const registry = new StepRegistry();

  registry.register("design:dispatch", async (ctx: HandlerContext) =>
    runAgentDispatch(ctx, depsFor(ctx, deps, deps.timeoutMs ?? DESIGN_TIMEOUT_MS), {
      handlerKey: "design:dispatch",
      template: DESIGN_TEMPLATE,
      vars: designVars(ctx.ticket, deps.profile),
      postcondition: ({ worktreePath, changed }) => {
        const plansDir = join(worktreePath, "docs", "plans");
        const hasPlan =
          changed && existsSync(plansDir) && readdirSync(plansDir).some((f) => f.endsWith(".md"));
        if (!hasPlan) {
          throw new Error("design:dispatch postcondition: no plan committed under docs/plans/");
        }
      },
    }),
  );

  registry.register("design:extract", async (ctx: HandlerContext) => {
    const { output } = await runAgentDispatch(
      ctx,
      depsFor(ctx, deps, deps.timeoutMs ?? DESIGN_TIMEOUT_MS),
      {
        handlerKey: "design:extract",
        template: EXTRACT_TEMPLATE,
        vars: extractVars(ctx.ticket, deps.profile),
        // Read-only step: no files change, so no postcondition on the diff.
        postcondition: () => {},
      },
    );

    const parsed = extractSidecar(output, ExtractOutputSchema);
    if (!parsed.ok) {
      // Absent/malformed sidecar = transport failure (§3a) → failure-policy re-dispatches.
      throw new Error(`design:extract sidecar ${parsed.reason}: ${parsed.detail}`);
    }
    const errors = validateExtraction(parsed.value.units);
    if (errors.length > 0) {
      throw new Error(`design:extract completeness failed: ${errors.join("; ")}`);
    }

    for (const u of parsed.value.units) {
      insertWorkUnit(ctx.db, {
        ticketId: ctx.ticket.id,
        seq: u.seq,
        kind: u.kind,
        title: u.title,
        description: u.description,
        behavioral: u.behavioral ? 1 : 0, // the carry: classify explicitly, never default
        testPlan: u.test_plan,
        filesToTouch: u.files_to_touch,
        verifyCheckTypes: u.verify_check_types,
        dependsOn: u.depends_on,
      });
    }
    // M5b-2: size the track from the validated breakdown (sprawl-only). An explicitly-set
    // track (per-ticket override) wins; the complexity grader is the M5b-3 follow-up.
    const track = ctx.ticket.track ?? sizeTrack(parsed.value.units);
    setTicketTrack(ctx.db, ctx.ticket.id, track);
    return { units: parsed.value.units.length };
  });

  registry.register("implement:dispatch", async (ctx: HandlerContext) => {
    if (ctx.workUnitId === null) {
      throw new Error("implement:dispatch: missing workUnitId");
    }
    const unit = getUnit(ctx.db, ctx.workUnitId);
    if (!unit) {
      throw new Error(`implement:dispatch: work_unit ${ctx.workUnitId} not found`);
    }
    const result = await runAgentDispatch(
      ctx,
      depsFor(ctx, deps, deps.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      {
        handlerKey: "implement:dispatch",
        template: IMPLEMENT_TEMPLATE,
        vars: implementVars(ctx.ticket, unit, deps.profile, implementFeedback(ctx.db, unit.id)),
        loopback: isUnitLoopback(ctx, unit.seq),
        postcondition: ({ changed }) => {
          if (!changed) {
            throw new Error("implement:dispatch postcondition: empty diff");
          }
        },
      },
    );
    setUnitStatus(ctx.db, unit.id, "verifying");
    return result;
  });

  registry.register("verify:check", async (ctx: HandlerContext) => {
    if (ctx.workUnitId === null) {
      throw new Error("verify:check: missing workUnitId");
    }
    const checkType = ctx.step.step_key.split(":").pop() ?? "";
    if (checkType === "") {
      throw new Error(`verify:check: cannot parse check-type from '${ctx.step.step_key}'`);
    }
    const { repoPath, worktreePath, branch } = worktreeFor(ctx, deps);
    ensureWorktree(repoPath, branch, worktreePath);

    const command = deps.profile.commands[checkType];
    if (command === undefined) {
      insertSignal(ctx.db, {
        ticketId: ctx.ticket.id,
        workUnitId: ctx.workUnitId,
        signalType: checkType,
        result: "error",
        detail: { reason: `no profile command for check-type '${checkType}'` },
      });
      throw new Error(`verify:check: no profile command for '${checkType}'`);
    }

    const run = await runCommand(command, {
      cwd: worktreePath,
      timeoutMs: deps.timeoutMs ?? VERIFY_TIMEOUT_MS,
    });
    const branchHeadSha = getLatestByWorkUnit(ctx.db, ctx.workUnitId)?.branch_head_sha ?? undefined;
    let result =
      run.exitCode === 0 ? "pass" : run.timedOut || run.exitCode === null ? "error" : "fail";
    let detail: Record<string, unknown> = {
      exitCode: run.exitCode,
      timedOut: run.timedOut,
      stderr: run.stderr.slice(0, 2000),
    };

    // Behavioral gate (A1): a behavioral unit's green test check still fails if the coding diff
    // added no test file. Deterministic; "is the test good?" is the reviewer's job (M5).
    if (result === "pass" && checkType === "test") {
      const unit = getUnit(ctx.db, ctx.workUnitId);
      if (unit && unit.behavioral === 1) {
        const changed =
          branchHeadSha === undefined ? [] : changedFilesAt(branchHeadSha, worktreePath);
        const hasTest = changed.some((p) => isTestFile(p, deps.profile.testFilePattern));
        if (!hasTest) {
          result = "fail";
          detail = { reason: "behavioral-no-test", changed };
        }
      }
    }

    insertSignal(ctx.db, {
      ticketId: ctx.ticket.id,
      workUnitId: ctx.workUnitId,
      signalType: checkType,
      result,
      command,
      branchHeadSha,
      detail,
    });

    // scope_diff (A3) — advisory only: compare the coding diff against the unit's declared files.
    // Recorded once per (unit, commit); NEVER throws, NEVER gates the step.
    if (branchHeadSha !== undefined) {
      const unitRow = getUnit(ctx.db, ctx.workUnitId);
      const declared = unitRow ? parseFilesToTouch(unitRow) : [];
      const already = listByUnit(ctx.db, ctx.workUnitId).some(
        (s) => s.signal_type === "scope_diff" && s.branch_head_sha === branchHeadSha,
      );
      if (declared.length > 0 && !already) {
        const changed = changedFilesAt(branchHeadSha, worktreePath);
        const outOfScope = changed.filter((p) => !declared.includes(p));
        insertSignal(ctx.db, {
          ticketId: ctx.ticket.id,
          workUnitId: ctx.workUnitId,
          signalType: "scope_diff",
          result: outOfScope.length === 0 ? "pass" : "fail",
          branchHeadSha,
          detail: { changed, out_of_scope: outOfScope },
        });
      }
    }

    if (result !== "pass") {
      throw new Error(`verify:check ${checkType}: ${result}`);
    }
    return { check: checkType, result };
  });

  registry.register("verify:integration", async (ctx: HandlerContext) => {
    const { repoPath, worktreePath, branch } = worktreeFor(ctx, deps);
    ensureWorktree(repoPath, branch, worktreePath);

    const commands = (["build", "test"] as const)
      .map((key) => ({ key, command: deps.profile.commands[key] }))
      .filter((c): c is { key: "build" | "test"; command: string } => c.command !== undefined);

    if (commands.length === 0) {
      insertSignal(ctx.db, {
        ticketId: ctx.ticket.id,
        signalType: "integration",
        result: "error",
        detail: { reason: "no build/test profile command declared" },
      });
      throw new Error("verify:integration: no build/test profile command declared");
    }

    const branchHeadSha = getLatestForTicket(ctx.db, ctx.ticket.id)?.branch_head_sha ?? undefined;
    const ran: Array<{ key: string; exitCode: number | null; timedOut: boolean }> = [];
    let result: "pass" | "fail" | "error" = "pass";
    let lastCommand = "";
    for (const { key, command } of commands) {
      lastCommand = command;
      const run = await runCommand(command, {
        cwd: worktreePath,
        timeoutMs: deps.timeoutMs ?? VERIFY_TIMEOUT_MS,
      });
      ran.push({ key, exitCode: run.exitCode, timedOut: run.timedOut });
      if (run.exitCode !== 0) {
        result = run.timedOut || run.exitCode === null ? "error" : "fail";
        break;
      }
    }

    insertSignal(ctx.db, {
      ticketId: ctx.ticket.id,
      signalType: "integration",
      result,
      command: lastCommand,
      branchHeadSha,
      detail: { ran },
    });
    if (result !== "pass") {
      throw new Error(`verify:integration: ${result}`);
    }
    return { integration: result };
  });

  registry.register("review", async (ctx: HandlerContext) => {
    const result = await runAgentDispatch(
      ctx,
      depsFor(ctx, deps, deps.timeoutMs ?? DESIGN_TIMEOUT_MS),
      {
        handlerKey: "review",
        template: REVIEW_TEMPLATE,
        vars: reviewVars(ctx.ticket, deps.profile),
        postcondition: () => {}, // read-only: nothing commits
      },
    );

    const parsed = extractSidecar(result.output, ReviewOutputSchema);
    if (!parsed.ok) {
      throw new Error(`review sidecar ${parsed.reason}: ${parsed.detail}`);
    }
    const units = listUnits(ctx.db, ctx.ticket.id);
    const seqToId = new Map(units.map((u) => [u.seq, u.id]));
    const errors = validateReviewFindings(parsed.value.findings, [...seqToId.keys()]);
    if (errors.length > 0) {
      throw new Error(`review findings invalid: ${errors.join("; ")}`);
    }

    let blocking = 0;
    for (const f of parsed.value.findings) {
      const blocksShip = computeBlocksShip(f.severity, f.deferral_candidate);
      if (blocksShip === 1) {
        blocking += 1;
      }
      insertFinding(ctx.db, {
        ticketId: ctx.ticket.id,
        reviewKind: "code",
        dispatchId: result.dispatchId,
        workUnitId: f.work_unit_seq === null ? null : (seqToId.get(f.work_unit_seq) ?? null),
        severity: f.severity,
        category: f.category,
        factorsJson: f.factors === null ? null : JSON.stringify(f.factors),
        deferralCandidate: f.deferral_candidate ? 1 : 0,
        blocksShip,
        location: f.location,
        rationale: f.rationale,
      });
    }
    return { findings: parsed.value.findings.length, blocking };
  });

  return registry;
}

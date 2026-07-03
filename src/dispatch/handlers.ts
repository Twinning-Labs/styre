import type { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { branchNameFor } from "../agent/branch.ts";
import type { AgentRunner } from "../agent/runner.ts";
import type { AgentConfig } from "../config/agent-config.ts";
import { StepRegistry } from "../daemon/step-registry.ts";
import type { HandlerContext } from "../daemon/step-registry.ts";
import { getLatestByWorkUnit, getLatestForTicket } from "../db/repos/dispatch.ts";
import { listByTicket as listEvents } from "../db/repos/event-log.ts";
import {
  insertSignal,
  listByUnit,
  listByTicket as listSignalsByTicket,
} from "../db/repos/ground-truth-signal.ts";
import { getProject } from "../db/repos/project.ts";
import { enqueue } from "../db/repos/projection-outbox.ts";
import { insertFinding } from "../db/repos/review-finding.ts";
import { setNeedsDocs, setTicketTrack } from "../db/repos/ticket.ts";
import {
  getById as getUnit,
  insertWorkUnit,
  listByTicket as listUnits,
  parseFilesToTouch,
  setBaseSha,
  setStatus as setUnitStatus,
} from "../db/repos/work-unit.ts";
import { pythonImportName } from "../setup/lang/python.ts";
import { runCommand } from "../util/run-command.ts";
import { ComplexityGradeSchema } from "./complexity-schema.ts";
import {
  commandFor,
  impactedComponents,
  isInertFile,
  isUnavailable,
  matchesComponent,
  realRunnerCommands,
  scopedRunnersForFiles,
} from "./components.ts";
import { ExtractOutputSchema, validateCdotImpact, validateExtraction } from "./extract-schema.ts";
import { implementFeedback } from "./feedback.ts";
import type { Profile } from "./profile.ts";
import {
  DESIGN_COMPLEXITY_GRADE_TEMPLATE,
  DESIGN_REVIEW_TEMPLATE,
  DESIGN_TEMPLATE,
  EXTRACT_TEMPLATE,
  IMPLEMENT_TEMPLATE,
  REVIEW_TEMPLATE,
  complexityGradeVars,
  designReviewVars,
  designVars,
  extractVars,
  implementVars,
  reviewVars,
} from "./prompt-vars.ts";
import {
  planProvision,
  resetProvisionIfManifestTouched,
  resolvePythonInterpreter,
  sourceCheckCommand,
} from "./provision.ts";
import { ReviewOutputSchema, computeBlocksShip, validateReviewFindings } from "./review-schema.ts";
import type { DispatchDeps } from "./run-dispatch.ts";
import { runAgentDispatch } from "./run-dispatch.ts";
import { extractSidecar } from "./sidecar.ts";
import { isTestFile } from "./test-file.ts";
import { combineTrack, sizeTrack } from "./track-sizing.ts";
import {
  branchHeadSha,
  changedFilesAt,
  changedFilesBetween,
  ensureWorktree,
  removeWorktree,
} from "./worktree.ts";

export interface RegistryDeps {
  runner: AgentRunner;
  agentConfig: AgentConfig;
  profile: Profile;
  worktreeRoot: string;
  timeoutMs?: number;
  resumeContext?: { stepKey: string; transcript: string };
}

const DESIGN_TIMEOUT_MS = 60 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
const VERIFY_TIMEOUT_MS = 10 * 60 * 1000;
const PROVISION_TIMEOUT_MS = 15 * 60 * 1000;

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
    resumeContext: deps.resumeContext,
  };
}

/** Deterministic templated PR description from facts the daemon already has (M6b-1; a cheap-LLM
 *  write-up is a later polish). Exported for unit-testing the rendered sections. */
export function renderPrBody(
  db: Database,
  ticket: { id: number; ident: string; title: string | null },
): string {
  const units = listUnits(db, ticket.id);
  const lines = units.map((u) => `- ${u.kind}${u.title ? `: ${u.title}` : ""}`);
  const allSignals = listSignalsByTicket(db, ticket.id);
  const risks = allSignals.filter((s) => s.signal_type === "untested-merge-risk");
  const riskLines =
    risks.length > 0
      ? [
          "",
          "⚠ Untested stacks (reviewer-only — no automated test gate):",
          ...risks.map((s) => `- ${JSON.parse(s.detail_json ?? "{}").component ?? "?"}`),
        ]
      : [];
  // Advisory sweep failures: unowned non-inert files triggered a precautionary run of an untouched
  // stack that failed. Surfaced here for reviewer awareness; never a hard gate.
  const sweeps = allSignals.filter((s) => s.signal_type === "ran-all-unowned");
  const sweepLines =
    sweeps.length > 0
      ? [
          "",
          "Precautionary runs on unowned-file changes — review:",
          ...sweeps.map((s) => {
            const d = JSON.parse(s.detail_json ?? "{}") as {
              component?: string;
              checkType?: string;
            };
            return `- ${d.component ?? "?"}:${d.checkType ?? "?"}`;
          }),
        ]
      : [];
  return [
    `Automated PR for ${ticket.ident}${ticket.title ? ` — ${ticket.title}` : ""}.`,
    "",
    "Work units:",
    ...(lines.length > 0 ? lines : ["- (none)"]),
    ...riskLines,
    ...sweepLines,
    "",
    "Verified against the project's checks and passed independent review.",
  ].join("\n");
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
    const cdotErrors = validateCdotImpact(parsed.value, deps.profile);
    if (cdotErrors.length > 0) {
      throw new Error(`design:extract CDOT gate failed: ${cdotErrors.join("; ")}`);
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
    if (parsed.value.cdotImpact.documentation.applies) {
      setNeedsDocs(ctx.db, ctx.ticket.id, 1);
    }
    return { units: parsed.value.units.length };
  });

  registry.register("design:size", async (ctx: HandlerContext) => {
    const units = listUnits(ctx.db, ctx.ticket.id);
    if (!ctx.config.complexityGrading) {
      const track = sizeTrack(units); // off: deterministic sprawl-only, no agent
      setTicketTrack(ctx.db, ctx.ticket.id, track);
      return { track, graded: false };
    }
    // on: cold cheap-tier grader → daemon combines the grade with sprawl.
    const result = await runAgentDispatch(
      ctx,
      depsFor(ctx, deps, deps.timeoutMs ?? DESIGN_TIMEOUT_MS),
      {
        handlerKey: "design:size",
        template: DESIGN_COMPLEXITY_GRADE_TEMPLATE,
        vars: complexityGradeVars(ctx.ticket, deps.profile, units),
        postcondition: () => {}, // read-only: nothing commits
      },
    );
    const parsed = extractSidecar(result.output, ComplexityGradeSchema);
    if (!parsed.ok) {
      throw new Error(`design:size grade sidecar ${parsed.reason}: ${parsed.detail}`);
    }
    const track = combineTrack(units.length, parsed.value.overall);
    setTicketTrack(ctx.db, ctx.ticket.id, track);
    return { track, graded: true, overall: parsed.value.overall };
  });

  registry.register("design:review", async (ctx: HandlerContext) => {
    const result = await runAgentDispatch(
      ctx,
      depsFor(ctx, deps, deps.timeoutMs ?? DESIGN_TIMEOUT_MS),
      {
        handlerKey: "design:review",
        template: DESIGN_REVIEW_TEMPLATE,
        vars: designReviewVars(ctx.ticket, deps.profile),
        postcondition: () => {}, // read-only: nothing commits
      },
    );

    const parsed = extractSidecar(result.output, ReviewOutputSchema);
    if (!parsed.ok) {
      throw new Error(`design:review sidecar ${parsed.reason}: ${parsed.detail}`);
    }
    const units = listUnits(ctx.db, ctx.ticket.id);
    const seqToId = new Map(units.map((u) => [u.seq, u.id]));
    const errors = validateReviewFindings(parsed.value.findings, [...seqToId.keys()]);
    if (errors.length > 0) {
      throw new Error(`design:review findings invalid: ${errors.join("; ")}`);
    }

    let blocking = 0;
    for (const f of parsed.value.findings) {
      const blocksShip = computeBlocksShip(f.severity, f.deferral_candidate);
      if (blocksShip === 1) {
        blocking += 1;
      }
      insertFinding(ctx.db, {
        ticketId: ctx.ticket.id,
        reviewKind: "plan",
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

  registry.register("implement:dispatch", async (ctx: HandlerContext) => {
    if (ctx.workUnitId === null) {
      throw new Error("implement:dispatch: missing workUnitId");
    }
    const unit = getUnit(ctx.db, ctx.workUnitId);
    if (!unit) {
      throw new Error(`implement:dispatch: work_unit ${ctx.workUnitId} not found`);
    }
    const {
      repoPath: implRepoPath,
      worktreePath: implWorktreePath,
      branch: implBranch,
    } = worktreeFor(ctx, deps);
    ensureWorktree(implRepoPath, implBranch, implWorktreePath);
    if (unit.base_sha === null) {
      const base = branchHeadSha(implRepoPath, implBranch);
      if (base !== null) setBaseSha(ctx.db, unit.id, base);
    }
    const filesToTouch = parseFilesToTouch(unit);
    const scoped = scopedRunnersForFiles(deps.profile.components, filesToTouch);
    const runnerCommands = scoped.length > 0 ? scoped : realRunnerCommands(deps.profile.components);
    const result = await runAgentDispatch(
      ctx,
      depsFor(ctx, deps, deps.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      {
        handlerKey: "implement:dispatch",
        template: IMPLEMENT_TEMPLATE,
        vars: implementVars(ctx.ticket, unit, deps.profile, implementFeedback(ctx.db, unit.id)),
        loopback: isUnitLoopback(ctx, unit.seq),
        runnerCommands,
        postcondition: ({ changed }) => {
          if (!changed) {
            throw new Error("implement:dispatch postcondition: empty diff");
          }
        },
      },
    );
    setUnitStatus(ctx.db, unit.id, "verifying");
    // Review F-2: if this dispatch's committed diff touched a dependency manifest, a once-gated
    // `provision` (already `done`) would otherwise be silently stale — re-arm it so the resolver
    // re-installs before the next verify (never a hard fail here; the agent has no install
    // capability itself, so surfacing this at implement time is the only safe point).
    resetProvisionIfManifestTouched(
      ctx.db,
      ctx.ticket.id,
      changedFilesAt(result.sha, implWorktreePath),
    );
    return result;
  });

  registry.register("provision", async (ctx: HandlerContext) => {
    const { repoPath, worktreePath, branch } = worktreeFor(ctx, deps);
    ensureWorktree(repoPath, branch, worktreePath);
    const actions = planProvision(deps.profile.components, worktreePath);
    for (const a of actions) {
      const run = await runCommand(a.command, { cwd: a.cwd, timeoutMs: PROVISION_TIMEOUT_MS });
      insertSignal(ctx.db, {
        ticketId: ctx.ticket.id,
        workUnitId: null,
        signalType: "provision",
        result: run.exitCode === 0 ? "pass" : run.timedOut ? "error" : "fail",
        detail: { component: a.component, command: a.command, exitCode: run.exitCode },
      });
      if (run.exitCode !== 0) {
        throw new Error(
          `provision: ${a.component} '${a.command}' exited ${run.exitCode}${run.timedOut ? " (timed out)" : ""}: ${run.stderr.slice(0, 500)}`,
        );
      }
      // The worktree-source assertion (Task 5 / review F-1, hardened by the Opus re-review's
      // Fix A/B/D/E): a successful `pip install -e .` does not prove `import <pkg>` resolves to
      // the worktree — a pre-installed/conda copy can shadow it. Only applies to the python
      // editable-install shape. An unresolvable import name is NOT a silent skip (Fix B) — it
      // escalates.
      const component = deps.profile.components.find((c) => c.name === a.component);
      const isEditablePythonInstall =
        component?.kind === "python" && component.prepare === "pip install -e .";
      if (isEditablePythonInstall && component) {
        // Fix D: resolve once (python3, then python); neither present is a distinct
        // provisioning-infra failure, not a silent pass.
        let interp: string;
        try {
          interp = resolvePythonInterpreter();
        } catch (err) {
          insertSignal(ctx.db, {
            ticketId: ctx.ticket.id,
            workUnitId: null,
            signalType: "provision",
            result: "fail",
            detail: {
              component: a.component,
              check: "source-under-test",
              reason: "no-python-interpreter",
            },
          });
          throw err;
        }
        // Fix A: the probe script lives in a fresh tempdir OUTSIDE the worktree — never inside
        // `a.cwd` — so CPython never auto-prepends the worktree to sys.path for the probe.
        const scriptDir = mkdtempSync(join(tmpdir(), "styre-provcheck-"));
        try {
          const importName = pythonImportName(a.cwd);
          let check: ReturnType<typeof sourceCheckCommand>;
          try {
            check = sourceCheckCommand({
              component: a.component,
              kind: component.kind,
              prepare: component.prepare,
              cwd: a.cwd,
              importName,
              scriptDir,
              interp,
            });
          } catch (err) {
            // Fix B: unresolvable/invalid (Fix E) import name escalates — never a silent skip.
            insertSignal(ctx.db, {
              ticketId: ctx.ticket.id,
              workUnitId: null,
              signalType: "provision",
              result: "fail",
              detail: {
                component: a.component,
                check: "source-under-test",
                reason: "unresolvable-import-name",
              },
            });
            throw err;
          }
          if (!check) continue; // unreachable given isEditablePythonInstall, but keeps TS honest
          writeFileSync(check.scriptPath, check.script);
          let probe = await runCommand(check.command, {
            cwd: a.cwd,
            timeoutMs: PROVISION_TIMEOUT_MS,
          });
          if (probe.exitCode !== 0) {
            // Remediate once: a stale/non-editable prior install can shadow the worktree copy on
            // sys.path; force-reinstalling editable (no-deps, deps are already provisioned) fixes
            // the common case without re-running the full prepare command.
            await runCommand(`${interp} -m pip install -e . --force-reinstall --no-deps`, {
              cwd: a.cwd,
              timeoutMs: PROVISION_TIMEOUT_MS,
            });
            probe = await runCommand(check.command, {
              cwd: a.cwd,
              timeoutMs: PROVISION_TIMEOUT_MS,
            });
          }
          if (probe.exitCode !== 0) {
            insertSignal(ctx.db, {
              ticketId: ctx.ticket.id,
              workUnitId: null,
              signalType: "provision",
              result: "fail",
              detail: { component: a.component, check: "source-under-test" },
            });
            throw new Error(`provision: worktree source not under test for ${a.component}`);
          }
        } finally {
          rmSync(scriptDir, { recursive: true, force: true });
        }
      }
    }
    return { provisioned: actions.length };
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

    const unit = getUnit(ctx.db, ctx.workUnitId);
    if (!unit) throw new Error(`verify:check: work_unit ${ctx.workUnitId} not found`);

    const latestSha = getLatestByWorkUnit(ctx.db, ctx.workUnitId)?.branch_head_sha ?? undefined;

    // Cumulative per-unit diff (base_sha..HEAD, across all the unit's commits incl. loopbacks).
    // Empty-diff is a DISTINCT diagnostic, not a missing-command error — and when base==head (the
    // first-unit edge), fall back to the latest commit's own files so a legitimate unit never
    // misroutes to an empty impacted set.
    const components = deps.profile.components;
    const changed =
      unit.base_sha && latestSha && unit.base_sha !== latestSha
        ? changedFilesBetween(unit.base_sha, latestSha, worktreePath)
        : latestSha
          ? changedFilesAt(latestSha, worktreePath)
          : [];

    // Guard: empty diff (unchanged) and zero components (unchanged intent) — always hard errors.
    if (changed.length === 0) {
      insertSignal(ctx.db, {
        ticketId: ctx.ticket.id,
        workUnitId: ctx.workUnitId,
        signalType: checkType,
        result: "error",
        branchHeadSha: latestSha,
        detail: { reason: "empty-diff", checkType, changed },
      });
      throw new Error(`verify:check ${checkType}: no changes detected for unit`);
    }
    if (components.length === 0) {
      insertSignal(ctx.db, {
        ticketId: ctx.ticket.id,
        workUnitId: ctx.workUnitId,
        signalType: checkType,
        result: "error",
        branchHeadSha: latestSha,
        detail: { reason: "no-components-detected", checkType },
      });
      throw new Error(`verify:check ${checkType}: no components detected in profile`);
    }

    // Partition the diff into: owned (a component claims the file), realImpacted (those components),
    // and unownedNonInert (everything else that is NOT an inert file — docs, licence/attribution/
    // git-metadata basenames). Inert files cannot flip any stack's gate, so they skip the sweep.
    const owned = changed.filter((f) => components.some((c) => matchesComponent(c, f)));
    const realImpacted = impactedComponents(components, owned);
    const unownedNonInert = changed.filter((f) => !owned.includes(f) && !isInertFile(f));

    // Pure-inert path: no owned file, nothing to sweep (all unowned files are inert).
    // Behavioral units MUST have code changes → fail. Non-behavioral units pass with a note.
    if (realImpacted.length === 0 && unownedNonInert.length === 0) {
      if (unit.behavioral === 1) {
        insertSignal(ctx.db, {
          ticketId: ctx.ticket.id,
          workUnitId: ctx.workUnitId,
          signalType: checkType,
          result: "fail",
          branchHeadSha: latestSha,
          detail: { reason: "behavioral-no-code", checkType, changed },
        });
        throw new Error(`verify:check ${checkType}: behavioral unit changed only inert files`);
      }
      insertSignal(ctx.db, {
        ticketId: ctx.ticket.id,
        workUnitId: ctx.workUnitId,
        signalType: checkType,
        result: "pass",
        branchHeadSha: latestSha,
        detail: {
          reason: "inert-only",
          note: "inert-only change (docs/licence/attribution), no code gates ran",
          checkType,
          changed,
        },
      });
      return { check: checkType, result: "pass" };
    }

    // HARD GATES over realImpacted only (the stacks whose files this unit owns).
    // THREE-WAY resolution: (a) real command → run it, (b) unavailable → reviewer-only degrade +
    // untested-merge-risk, (c) absent/unknown → loud error. These can fail → loopback.
    let result: "pass" | "fail" | "error" = "pass";
    let lastCommand = "";
    let lastStderr = "";
    let detail: Record<string, unknown> = {};

    if (realImpacted.length > 0) {
      const toRun = realImpacted
        .filter((c) => commandFor(c, checkType) !== undefined)
        .map((c) => ({
          component: c.name,
          command: commandFor(c, checkType) as string,
          dir: c.dir,
        }));
      const unavailable = realImpacted.filter((c) => isUnavailable(c, checkType));
      const absent = realImpacted.filter(
        (c) => commandFor(c, checkType) === undefined && !isUnavailable(c, checkType),
      );

      // (c) absent/unknown on a realImpacted component → loud error (unit declared a check-type
      // but the stack that owns the changed files has no command for it, not even "unavailable").
      if (absent.length > 0) {
        insertSignal(ctx.db, {
          ticketId: ctx.ticket.id,
          workUnitId: ctx.workUnitId,
          signalType: checkType,
          result: "error",
          branchHeadSha: latestSha,
          detail: { reason: "check-absent", checkType, components: absent.map((c) => c.name) },
        });
        throw new Error(
          `verify:check ${checkType}: no command configured on ${absent.map((c) => c.name).join(",")}`,
        );
      }

      // (b) every realImpacted component marked this check unavailable → reviewer-only degrade.
      if (toRun.length === 0) {
        for (const c of unavailable) {
          insertSignal(ctx.db, {
            ticketId: ctx.ticket.id,
            workUnitId: ctx.workUnitId,
            signalType: "untested-merge-risk",
            result: "fail",
            branchHeadSha: latestSha,
            detail: { component: c.name, checkType, reason: "check-unavailable" },
          });
        }
        insertSignal(ctx.db, {
          ticketId: ctx.ticket.id,
          workUnitId: ctx.workUnitId,
          signalType: checkType,
          result: "pass",
          branchHeadSha: latestSha,
          detail: { degraded: "reviewer-only", unavailable: unavailable.map((c) => c.name) },
        });
        return { check: checkType, result: "pass", degraded: true };
      }

      // (a) run each realImpacted component's real command; aggregate.
      const ran: Array<{ component: string; exitCode: number | null; timedOut: boolean }> = [];
      for (const { component, command, dir } of toRun) {
        lastCommand = command;
        const run = await runCommand(command, {
          cwd: join(worktreePath, dir ?? ""),
          timeoutMs: deps.timeoutMs ?? VERIFY_TIMEOUT_MS,
        });
        ran.push({ component, exitCode: run.exitCode, timedOut: run.timedOut });
        if (run.exitCode !== 0) {
          result = run.timedOut || run.exitCode === null ? "error" : "fail";
          lastStderr = run.stderr.slice(0, 2000);
          break;
        }
      }
      detail = { ran, stderr: lastStderr };

      // Per-component A1 behavioral gate: each realImpacted component with a real test command
      // needs a matching test file among the owned files for this unit. Components with test
      // unavailable emit a PR-visible untested-merge-risk (reviewer-only, decision C).
      if (checkType === "test" && unit.behavioral === 1) {
        for (const c of unavailable) {
          insertSignal(ctx.db, {
            ticketId: ctx.ticket.id,
            workUnitId: ctx.workUnitId,
            signalType: "untested-merge-risk",
            result: "fail",
            branchHeadSha: latestSha,
            detail: { component: c.name, reason: "behavioral-unit-no-test-command" },
          });
        }
        if (result === "pass") {
          for (const c of realImpacted) {
            if (commandFor(c, "test") === undefined) continue;
            const inComponent = owned.filter((p) => matchesComponent(c, p));
            const hasTest = inComponent.some((p) => isTestFile(p, c.testFilePattern));
            if (!hasTest) {
              result = "fail";
              detail = { reason: "behavioral-no-test", component: c.name, changed: inComponent };
              break;
            }
          }
        }
      }
    }

    // ADVISORY SWEEP: any unowned non-inert file → run the UNTOUCHED stacks' available commands
    // as a precaution so the unowned change cannot slip through silently. Failures are surfaced
    // via "ran-all-unowned" signals and appear in the PR body. The sweep NEVER fails/wedges the
    // unit — absent commands on swept stacks are silently skipped (no "check-absent" error).
    // Cost is recorded as a "sweep-cost" (result:"pass") signal for every triggered sweep so
    // the T1 frequency risk (freeze §13 #1) becomes observable data.
    if (unownedNonInert.length > 0) {
      const untouched = components.filter((c) => !realImpacted.includes(c));
      const sweepStart = Date.now();
      let stacksSwept = 0;
      for (const c of untouched) {
        const cmd = commandFor(c, checkType);
        if (cmd === undefined) continue; // absent on untouched stack → skip, no error
        stacksSwept++;
        const sweepRun = await runCommand(cmd, {
          cwd: join(worktreePath, c.dir ?? ""),
          timeoutMs: deps.timeoutMs ?? VERIFY_TIMEOUT_MS,
        });
        if (sweepRun.exitCode !== 0) {
          insertSignal(ctx.db, {
            ticketId: ctx.ticket.id,
            workUnitId: ctx.workUnitId,
            signalType: "ran-all-unowned",
            result: "fail",
            branchHeadSha: latestSha,
            detail: {
              component: c.name,
              checkType,
              note: `unowned files ${unownedNonInert.join(", ")} triggered a precautionary run of this untouched stack, which failed — review`,
            },
          });
        }
      }
      insertSignal(ctx.db, {
        ticketId: ctx.ticket.id,
        workUnitId: ctx.workUnitId,
        branchHeadSha: latestSha,
        signalType: "sweep-cost",
        result: "pass",
        detail: {
          checkType,
          stacksSwept,
          wallClockMs: Date.now() - sweepStart,
          unownedTriggers: unownedNonInert.length,
        },
      });
    }

    insertSignal(ctx.db, {
      ticketId: ctx.ticket.id,
      workUnitId: ctx.workUnitId,
      signalType: checkType,
      result,
      command: lastCommand,
      branchHeadSha: latestSha,
      detail,
    });

    // scope_diff (A3) — advisory; now over the cumulative diff. Recorded once per (unit, sha).
    if (latestSha !== undefined) {
      const declared = parseFilesToTouch(unit);
      const already = listByUnit(ctx.db, ctx.workUnitId).some(
        (s) => s.signal_type === "scope_diff" && s.branch_head_sha === latestSha,
      );
      if (declared.length > 0 && !already) {
        const outOfScope = changed.filter((p) => !declared.includes(p));
        insertSignal(ctx.db, {
          ticketId: ctx.ticket.id,
          workUnitId: ctx.workUnitId,
          signalType: "scope_diff",
          result: outOfScope.length === 0 ? "pass" : "fail",
          branchHeadSha: latestSha,
          detail: { changed, out_of_scope: outOfScope },
        });
      }
    }

    if (result !== "pass") throw new Error(`verify:check ${checkType}: ${result}`);
    return { check: checkType, result };
  });

  registry.register("verify:integration", async (ctx: HandlerContext) => {
    const { repoPath, worktreePath, branch } = worktreeFor(ctx, deps);
    ensureWorktree(repoPath, branch, worktreePath);

    const jobs: Array<{ label: string; command: string; dir?: string }> = [];
    for (const c of deps.profile.components) {
      for (const key of ["build", "test"] as const) {
        const cmd = commandFor(c, key);
        if (cmd) jobs.push({ label: `${c.name}:${key}`, command: cmd, dir: c.dir });
      }
    }
    for (const [name, cmd] of Object.entries(deps.profile.repoCommands)) {
      jobs.push({ label: `repo:${name}`, command: cmd }); // repo-wide → no dir → worktree root
    }
    if (jobs.length === 0) {
      insertSignal(ctx.db, {
        ticketId: ctx.ticket.id,
        signalType: "integration",
        result: "error",
        detail: { reason: "no component build/test or repoCommands declared" },
      });
      throw new Error("verify:integration: nothing to run");
    }
    const branchHeadSha = getLatestForTicket(ctx.db, ctx.ticket.id)?.branch_head_sha ?? undefined;
    const ran: Array<{ label: string; exitCode: number | null; timedOut: boolean }> = [];
    let result: "pass" | "fail" | "error" = "pass";
    let lastCommand = "";
    for (const { label, command, dir } of jobs) {
      lastCommand = command;
      const run = await runCommand(command, {
        cwd: join(worktreePath, dir ?? ""),
        timeoutMs: deps.timeoutMs ?? VERIFY_TIMEOUT_MS,
      });
      ran.push({ label, exitCode: run.exitCode, timedOut: run.timedOut });
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
    if (result !== "pass") throw new Error(`verify:integration: ${result}`);
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

  registry.register("merge:push", (ctx: HandlerContext) => {
    const branch = branchNameFor(ctx.ticket);
    const sha = getLatestForTicket(ctx.db, ctx.ticket.id)?.branch_head_sha;
    if (!sha) {
      throw new Error("merge:push: no branch head sha (no completed dispatch)");
    }
    enqueue(ctx.db, {
      ticketId: ctx.ticket.id,
      target: "forge",
      op: "push",
      payload: { branch, sha },
      idempotencyKey: `${ctx.ticket.ident}:push:${sha}`,
    });
    return { enqueued: "push", sha };
  });

  registry.register("merge:pr-ensure", (ctx: HandlerContext) => {
    const branch = branchNameFor(ctx.ticket);
    const base = deps.profile.defaultBranch;
    const title = `${ctx.ticket.ident}${ctx.ticket.title ? ` ${ctx.ticket.title}` : ""}`;
    const body = renderPrBody(ctx.db, ctx.ticket);
    enqueue(ctx.db, {
      ticketId: ctx.ticket.id,
      target: "forge",
      op: "pr_create",
      payload: { branch, base, title, body },
      idempotencyKey: `${ctx.ticket.ident}:pr_create:${branch}`,
    });
    return { enqueued: "pr_create" };
  });

  registry.register("released:project", (ctx: HandlerContext) => {
    // The Done projection is enqueued by the merge→released transition (enqueueStageProjection,
    // released→done). Here we only clean up the per-ticket worktree (best-effort).
    const { repoPath, worktreePath } = worktreeFor(ctx, deps);
    try {
      removeWorktree(repoPath, worktreePath);
    } catch {
      // already gone / never created — fine; cleanup must not fail the terminal step.
    }
    return { released: true };
  });

  return registry;
}

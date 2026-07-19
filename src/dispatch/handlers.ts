import type { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { branchNameFor } from "../agent/branch.ts";
import type { AgentRunner } from "../agent/runner.ts";
import type { AgentConfig } from "../config/agent-config.ts";
import { latestReauthorRoute } from "../daemon/arbiter-verdict.ts";
import { latestChecksReauthorAcs } from "../daemon/checks-verdict.ts";
import { StepRegistry } from "../daemon/step-registry.ts";
import type { HandlerContext } from "../daemon/step-registry.ts";
import {
  classifyAcCheck,
  deleteActiveByAc,
  deleteByTicket,
  insertAcCheck,
  listActiveByTicket as listAcChecks,
  listUnresolvedByTicket,
  supersedeByAc,
} from "../db/repos/ac-check.ts";
import { listByTicket as listAcs } from "../db/repos/acceptance-criterion.ts";
import {
  completeDispatch,
  getByDispatchId,
  getLatestByWorkUnit,
  getLatestForTicket,
} from "../db/repos/dispatch.ts";
import { listByTicket as listEvents } from "../db/repos/event-log.ts";
import {
  behavioralStillRed,
  insertSignal,
  listByUnit,
  listByTicket as listSignalsByTicket,
  signalForAcCheck,
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
import { nowUtc } from "../util/time.ts";
import { type AdjClass, ChecksClassifyOutputSchema } from "./adjudicate-schema.ts";
import { ChecksArbitrateOutputSchema } from "./arbitrate-schema.ts";
import { carryVerifiedVerdictForward } from "./carry-forward.ts";
import { checkIntegrityViolations } from "./check-integrity.ts";
import { resolveAuthoredTestPath } from "./check-path.ts";
import {
  type CheckFramework,
  type CoarseResult,
  binaryFor,
  buildCheckSelector,
  frameworkFor,
  importErrorImplicatesDiscarded,
  signalResultForCoarse,
} from "./check-selector.ts";
import { checksFeedback } from "./checks-feedback.ts";
import { runCheckForRed } from "./checks-run.ts";
import { ChecksOutputSchema } from "./checks-schema.ts";
import { classifyPrior } from "./classify-prior.ts";
import { checksScopeFor, docScope, implementScope, planScope } from "./commit-scope.ts";
import { classifyDisposition, reconcileScope } from "./completeness.ts";
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
import { deriveAndPersistAcs } from "./derive-acs.ts";
import { designFeedback } from "./design-feedback.ts";
import { ExtractOutputSchema, validateCdotImpact, validateExtraction } from "./extract-schema.ts";
import { gateFeedback, implementFeedback } from "./feedback.ts";
import { ImplementOutputSchema } from "./implement-schema.ts";
import { hasTicketPlan } from "./plan-frontmatter.ts";
import { rerunAcChecks } from "./post-implement-rerun.ts";
import type { Profile } from "./profile.ts";
import {
  type AdjudicateItem,
  type ArbitrateItem,
  CHECKS_ARBITRATE_TEMPLATE,
  CHECKS_CLASSIFY_TEMPLATE,
  CHECKS_TEMPLATE,
  DESIGN_COMPLEXITY_GRADE_TEMPLATE,
  DESIGN_REVIEW_TEMPLATE,
  DESIGN_TEMPLATE,
  DOCS_REVISE_TEMPLATE,
  EXTRACT_TEMPLATE,
  IMPLEMENT_TEMPLATE,
  REVIEW_TEMPLATE,
  adjudicateVars,
  arbitrateVars,
  checksVars,
  complexityGradeVars,
  designReviewVars,
  designVars,
  docsVars,
  extractVars,
  implementVars,
  reviewVars,
} from "./prompt-vars.ts";
import {
  isEditablePythonPrepare,
  planProvision,
  resetProvisionIfManifestTouched,
  resolvePythonInterpreter,
  sourceCheckCommand,
} from "./provision.ts";
import { baselineShaForAc, replayCheckAtBaseline } from "./replay-harness.ts";
import { reuseAwareTestCommand } from "./reuse.ts";
import { reviewFeedback } from "./review-feedback.ts";
import { ReviewOutputSchema, computeBlocksShip, validateReviewFindings } from "./review-schema.ts";
import type { DispatchDeps } from "./run-dispatch.ts";
import { runAgentDispatch } from "./run-dispatch.ts";
import { extractSidecar } from "./sidecar.ts";
import { isTestFile } from "./test-file.ts";
import { combineTrack, sizeTrack } from "./track-sizing.ts";
import { buildVerifyReport, renderVerifyReport } from "./verify-report.ts";
import {
  addedFilesAt,
  branchHeadSha,
  changedFilesAt,
  changedFilesBetween,
  ensureWorktree,
  fileContentAt,
  removeWorktree,
  resetWorktreeHard,
  sweepScratch,
  worktreeHead,
} from "./worktree.ts";

export interface RegistryDeps {
  runner: AgentRunner;
  agentConfig: AgentConfig;
  profile: Profile;
  worktreeRoot: string;
  inPlace?: boolean;
  timeoutMs?: number;
  resumeContext?: { stepKey: string; transcript: string };
  /** RED-first check executor override (tests inject a scripted runner; production uses runCommand).
   *  Only `checks:dispatch` reads it (M2b decision 4). */
  runCheckCommand?: import("./reuse.ts").CmdRunner;
}

const DESIGN_TIMEOUT_MS = 60 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
const VERIFY_TIMEOUT_MS = 10 * 60 * 1000;
const PROVISION_TIMEOUT_MS = 15 * 60 * 1000;

/** Resolve the repo + ticket worktree + branch for a DAEMON-run step (verify). Unlike
 *  `depsFor` this carries no agent capability — verify only reads the committed worktree. */
export function worktreeFor(
  ctx: HandlerContext,
  deps: RegistryDeps,
): { repoPath: string; worktreePath: string; branch: string } {
  const project = getProject(ctx.db, ctx.ticket.project_id);
  if (!project) {
    throw new Error(`handler: project ${ctx.ticket.project_id} not found`);
  }
  return {
    repoPath: project.target_repo,
    worktreePath: deps.inPlace ? project.target_repo : join(deps.worktreeRoot, ctx.ticket.ident),
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
    worktreePath: deps.inPlace ? project.target_repo : join(deps.worktreeRoot, ctx.ticket.ident),
    branch: branchNameFor(ctx.ticket),
    timeoutMs,
    resumeContext: deps.resumeContext,
  };
}

/** Classify ONE check (the M5 re-author's classify step, §5.3): the deterministic prior first, then
 *  the checks:classify adjudicator for the ambiguous case. Returns the AdjClass or null (transport
 *  miss). Reused by the checks:arbitrate re-author pipeline — NOT applyChecksVerdict (which would
 *  re-trigger the pre-implement reauthorRoundsForAc escalate). */
export async function adjudicateOne(
  ctx: HandlerContext,
  deps: RegistryDeps,
  item: AdjudicateItem,
): Promise<AdjClass | null> {
  const prior = classifyPrior({ coarse: item.coarse as CoarseResult, rawOutput: item.rawOutput });
  if (prior.kind === "settled-red") return prior.redClass;
  const { output } = await runAgentDispatch(
    ctx,
    depsFor(ctx, deps, deps.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    {
      handlerKey: "checks:classify",
      template: CHECKS_CLASSIFY_TEMPLATE,
      vars: adjudicateVars(ctx.ticket, deps.profile, [item]),
      postcondition: () => {},
    },
  );
  const parsed = extractSidecar(output, ChecksClassifyOutputSchema);
  if (!parsed.ok) return null;
  return parsed.value.classifications.find((c) => c.ac_check_id === item.acCheckId)?.class ?? null;
}

/** §5: the check-wrong re-author pipeline for ONE AC. Code-blind author (reuses checks:dispatch) →
 *  clean-HEAD replay (coarse==red installs; green/selected-none/error reject) → classify via the
 *  adjudicator directly (environmental rejects) → supersede + insert + red-first at the re-author sha
 *  (integrity re-freeze). Resume-safe: supersede-then-insert in one txn, and the escalate counter is
 *  the gate attempt (never reauthorRoundsForAc), so a resumed extra round never premature-escalates. */
async function reauthorCheckWrong(
  ctx: HandlerContext,
  deps: RegistryDeps,
  acId: number,
  supersedeTargetId: number,
): Promise<"installed" | "rejected"> {
  const baselineSha = baselineShaForAc(ctx.db, acId);
  if (baselineSha === null) return "rejected"; // can't validate → fail closed
  const ac = listAcs(ctx.db, ctx.ticket.id).find((a) => a.id === acId);
  if (!ac) return "rejected";
  const { repoPath, worktreePath } = worktreeFor(ctx, deps);

  // 1) Code-blind author (AC text only; reuses checks:dispatch's plan-blind prompt + no-Bash allowlist).
  const { sha: reauthorSha, output } = await runAgentDispatch(
    ctx,
    depsFor(ctx, deps, deps.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    {
      handlerKey: "checks:dispatch",
      template: CHECKS_TEMPLATE,
      vars: checksVars(ctx.ticket, deps.profile, [{ id: ac.id, text: ac.text }], ""),
      commitScope: checksScopeFor(ctx.ticket.ident, [ac.id]),
      disposition: "discard",
      postcondition: () => {},
    },
  );
  const parsed = extractSidecar(output, ChecksOutputSchema);
  if (!parsed.ok) return "rejected";
  const authored = parsed.value.checksAuthored.find((c) => c.ac_id === acId);
  if (!authored) return "rejected";

  // 2) Identity: resolve the real committed test path (ENG-296: trust what was written, not declared),
  //    then require the test name present in that file. Unresolvable/name-absent stays fail-closed
  //    ("rejected" is a designed disposition feeding the escalate counter — never a throw here).
  const testPath = resolveAuthoredTestPath(
    addedFilesAt(reauthorSha, worktreePath),
    ctx.ticket.ident,
    acId,
    authored.test_file,
  );
  if (testPath === null) return "rejected";
  const content = fileContentAt(reauthorSha, testPath, worktreePath);
  if (content === null || !content.includes(authored.test_name)) return "rejected";

  // 3) Clean-HEAD replay — the RED-first oracle. coarse == red installs; everything else rejects.
  const coarse = await replayCheckAtBaseline({
    repoPath,
    baselineSha,
    components: deps.profile.components,
    testFile: testPath,
    testName: authored.test_name,
    content,
    timeoutMs: deps.timeoutMs ?? VERIFY_TIMEOUT_MS,
    run: deps.runCheckCommand,
  });
  if (String(coarse) !== "red") return "rejected"; // green / selected-none / error

  // 4) Classify via the adjudicator directly (NOT applyChecksVerdict). environmental → reject.
  const cls = await adjudicateOne(ctx, deps, {
    acCheckId: supersedeTargetId,
    acText: ac.text,
    testPath: testPath,
    testName: authored.test_name,
    coarse: "red",
    rawOutput: "", // the replay trace is red-shaped; the prior/adjudicator judge absence vs assertion
  });
  if (cls !== "assertion" && cls !== "absence") return "rejected"; // environmental/weak/null → reject

  // 5) Install: supersede the old generation + insert the new active + red-first at the re-author sha.
  // (The replay above already resolved a component+framework for this same test_file — coarse would
  // have been "error" otherwise, rejecting before this point — but fail closed here too, no assertion.)
  const installComp = impactedComponents(deps.profile.components, [testPath])[0];
  const installFw = installComp ? frameworkFor(installComp) : null;
  if (!installComp || !installFw) return "rejected";
  const sel = buildCheckSelector(installFw, {
    testFile: testPath,
    testName: authored.test_name,
  }).runArgs;
  ctx.db.transaction(() => {
    supersedeByAc(ctx.db, acId); // supersedes ALL active for the AC (resume-safe; counter is gate attempt)
    const row = insertAcCheck(ctx.db, {
      ticketId: ctx.ticket.id,
      acId,
      selector: sel,
      testPath: testPath,
      redFirstResult: "red",
    });
    classifyAcCheck(ctx.db, { acCheckId: row.id, redClass: cls });
    insertSignal(ctx.db, {
      ticketId: ctx.ticket.id,
      signalType: "ac-check-red-first",
      result: "fail",
      branchHeadSha: reauthorSha, // §5.4 integrity re-freeze at the new baseline
      detail: { rawOutput: "", exitCode: 1, framework: null, command: null, acCheckId: row.id },
    });
  })();
  return "installed";
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
  const report = buildVerifyReport(db, ticket.id);
  const verifyBlock = renderVerifyReport(report); // "" when the ticket has no ACs
  const verifyLines = verifyBlock === "" ? [] : ["", verifyBlock];
  // Keep the closing assurance only when there is nothing to caveat: no ACs at all (block empty), or a
  // fully clean report. A ⚠/⚪/➖ AC or an advisory failure means "verified" would over-claim (design §3).
  const keepClosing = verifyBlock === "" || report.allClean;
  const closingLines = keepClosing
    ? ["", "Verified against the project's checks and passed independent review."]
    : [];
  return [
    `Automated PR for ${ticket.ident}${ticket.title ? ` — ${ticket.title}` : ""}.`,
    "",
    "Work units:",
    ...(lines.length > 0 ? lines : ["- (none)"]),
    ...verifyLines,
    ...riskLines,
    ...sweepLines,
    ...closingLines,
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
      vars: designVars(ctx.ticket, deps.profile, designFeedback(ctx.db, ctx.ticket.id)),
      commitScope: planScope,
      postcondition: ({ worktreePath }) => {
        if (!hasTicketPlan(join(worktreePath, "docs", "plans"), ctx.ticket.ident)) {
          throw new Error(
            "design:dispatch postcondition: no plan for this ticket under docs/plans/",
          );
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

  registry.register("docs:revise", async (ctx: HandlerContext) => {
    const { sha, changed } = await runAgentDispatch(
      ctx,
      depsFor(ctx, deps, deps.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      {
        handlerKey: "docs:revise",
        template: DOCS_REVISE_TEMPLATE,
        vars: docsVars(ctx.ticket, deps.profile),
        commitScope: docScope,
        postcondition: () => {},
      },
    );
    if (changed) carryVerifiedVerdictForward(ctx.db, ctx.ticket.id, sha);
    return { docsRevised: changed };
  });

  registry.register("checks:dispatch", async (ctx: HandlerContext) => {
    // deriveAndPersistAcs runs HERE, not in the resolver (resolver is pure, §2). Idempotent (§6).
    deriveAndPersistAcs(ctx.db, ctx.ticket.id);
    const allAcs = listAcs(ctx.db, ctx.ticket.id);
    if (allAcs.length === 0) return { authored: 0, acs: 0 }; // no ACs → nothing to author (decision 6)
    // Scoped re-author (§2b): a loop==="checks" event re-authors ONLY its flagged ACs; a fresh/
    // crash-resume dispatch re-authors the whole ticket. `scoped` drives the agent's AC list, the
    // coverage postcondition, and the delete strategy — all three must agree.
    const flaggedAcs = latestChecksReauthorAcs(ctx.db, ctx.ticket.id);
    const scoped = flaggedAcs !== null;
    const acs = scoped ? allAcs.filter((a) => flaggedAcs.includes(a.id)) : allAcs;
    const acIds = new Set(acs.map((a) => a.id));

    // Identity + coverage (below) are checked against the COMMITTED diff (added-only, §5.1), so the
    // author is committed first — commitScope gates only path-scope, never AC coverage. Capture the
    // pre-author HEAD so a REJECTED author (malformed sidecar / uncovered ACs / bad identity) is
    // rolled back here: without it the invalid test commit stays on the branch, pollutes the PR, and
    // poisons the retry's diff (codex finding P1). ensureWorktree is idempotent (runAgentDispatch
    // re-runs it); the agent never commits, so HEAD is unchanged until CL-COMMIT below.
    const { repoPath, worktreePath, branch } = worktreeFor(ctx, deps);
    ensureWorktree(repoPath, branch, worktreePath);
    const preHead = worktreeHead(worktreePath);

    // Dispatch the plan-blind author (scoped Bash to run/confirm its own RED-first checks; commits
    // via CL-COMMIT → sha).
    const {
      sha,
      output,
      dispatchId: did,
      discarded,
    } = await runAgentDispatch(ctx, depsFor(ctx, deps, deps.timeoutMs ?? DEFAULT_TIMEOUT_MS), {
      handlerKey: "checks:dispatch",
      template: CHECKS_TEMPLATE,
      vars: checksVars(ctx.ticket, deps.profile, acs, checksFeedback(ctx.db, ctx.ticket.id)),
      runnerCommands: realRunnerCommands(deps.profile.components),
      commitScope: checksScopeFor(ctx.ticket.ident, [...acIds]),
      disposition: "discard",
      // Identity + coverage are verified below against the committed diff, not on the raw diff here.
      postcondition: () => {},
    });

    try {
      // Structured output through the validated interface (§4): absent/malformed = transport failure.
      const parsed = extractSidecar(output, ChecksOutputSchema);
      if (!parsed.ok) {
        throw new Error(`checks:dispatch sidecar ${parsed.reason}: ${parsed.detail}`);
      }

      const addedArr = addedFilesAt(sha, worktreePath);
      const ident = ctx.ticket.ident;
      const missReason = new Map<number, string>(); // ac.id → why it was uncovered (specific retry msg)
      const components = deps.profile.components;
      const run = deps.runCheckCommand;

      // Per authored check: identity (§5.1) → framework → RED-first execution (§5.3) → coarse (§5.4).
      const records: Array<{
        acId: number;
        selector: string;
        testPath: string;
        coarse: CoarseResult;
        rawOutput: string;
        exitCode: number | null;
        framework: CheckFramework | null;
        command: string | null;
      }> = [];
      const covered = new Set<number>();

      for (const c of parsed.value.checksAuthored) {
        if (!acIds.has(c.ac_id)) continue; // unknown AC id → reject (decision 5)
        // ENG-296: trust the file actually committed (canonical basename), not the declared path;
        // fall back to the declared path when it was itself committed (non-canonical-but-correct).
        const testPath = resolveAuthoredTestPath(addedArr, ident, c.ac_id, c.test_file);
        if (testPath === null) {
          missReason.set(
            c.ac_id,
            `no check test named \`${ident}_ac${c.ac_id}_test.*\` was committed, and your declared test_file \`${c.test_file}\` wasn't created either — save the RED-first test with exactly that filename`,
          );
          continue;
        }
        const content = fileContentAt(sha, testPath, worktreePath);
        if (content === null || !content.includes(c.test_name)) {
          missReason.set(
            c.ac_id,
            `\`${testPath}\` does not contain a test named \`${c.test_name}\``,
          );
          continue; // name absent → reject
        }

        const comp = impactedComponents(components, [testPath])[0]; // decision 2
        const fw = comp ? frameworkFor(comp) : null;

        let coarse: CoarseResult;
        let selector = testPath; // NOT-NULL fallback when no framework (decision 2)
        let rawOutput = "";
        let exitCode: number | null = null;
        let command: string | null = null;

        if (!comp || !fw) {
          coarse = "error"; // can't attempt — no framework (§5.2)
        } else {
          let interp: string | undefined;
          if (fw === "pytest") {
            try {
              interp = resolvePythonInterpreter();
            } catch {
              interp = undefined;
            }
          }
          if (fw === "pytest" && interp === undefined) {
            coarse = "error"; // no interpreter → can't attempt
          } else {
            const sel = buildCheckSelector(fw, { testFile: testPath, testName: c.test_name });
            selector = sel.runArgs;
            const res = await runCheckForRed({
              framework: fw,
              binary: binaryFor(fw, { interp }),
              runArgs: sel.runArgs,
              cwd: join(worktreePath, comp.dir ?? ""),
              timeoutMs: deps.timeoutMs ?? VERIFY_TIMEOUT_MS,
              run,
            });
            rawOutput = res.rawOutput;
            exitCode = res.exitCode;
            command = res.command;
            if (res.coarse === "selected-none") {
              missReason.set(c.ac_id, `the selector for \`${testPath}\` matched no test`);
              continue; // selects 0 → identity reject (§5.1)
            }
            coarse = res.coarse;
          }
        }

        // Discard-poison guard (silent-bad-merge): a check that did NOT go green while this dispatch
        // discarded undeclared files, whose output shows an import/collection/module error naming a
        // discarded file, could not actually run — the referenced helper was stripped before commit.
        // Route it to the SAME uncovered path `selected-none` uses so no permanently-broken check is
        // installed and the discard is surfaced in the retry feedback. Conservative: fires only when
        // the import error NAMES a discarded file (never a bare basename). Diagnosis-only (INV-B).
        if (discarded.length > 0 && coarse !== "green") {
          const implicated = importErrorImplicatesDiscarded(rawOutput, discarded);
          if (implicated.length > 0) {
            missReason.set(
              c.ac_id,
              `the check for this AC could not run because it references files styre discarded this attempt (undeclared): ${implicated.join(", ")}`,
            );
            continue; // uncovered → loud retry path, no poisoned check persisted
          }
        }

        records.push({
          acId: c.ac_id,
          selector,
          testPath: testPath,
          coarse,
          rawOutput,
          exitCode,
          framework: fw,
          command,
        });
        covered.add(c.ac_id);
      }

      // Postcondition (§8): ≥1 identity-verified check per AC, else fail (bounded retry / escalate).
      // ENG-296: name the specific reason per uncovered AC so the retry-prefix informs the re-dispatch.
      const uncovered = acs.filter((a) => !covered.has(a.id));
      if (uncovered.length > 0) {
        const detail = uncovered
          .map(
            (a) => `AC ${a.seq}: ${missReason.get(a.id) ?? "no valid check authored for this AC"}`,
          )
          .join("; ");
        // Diagnosis-only (INV-B): name what was discarded this attempt so a discarded-but-needed
        // helper is recoverable instead of an opaque wedge — no instruction, just the fact.
        const discardNote =
          discarded.length > 0
            ? ` — undeclared files discarded this attempt: ${discarded.join(", ")}`
            : "";
        throw new Error(`checks:dispatch postcondition: ${detail}${discardNote}`);
      }

      // Persist (§9): delete-then-insert in ONE transaction (resume-dedup, decision 1) + the signal row
      // via the vocab map (never write 'red' into ground_truth_signal).
      ctx.db.transaction(() => {
        if (scoped) {
          // Resume-dedup ONLY: clear this dispatch's own not-yet-classified actives (a crash-resume would
          // otherwise double-insert). The flagged generation was already SUPERSEDED by the verdict
          // (checks-verdict.ts, exactly-once) — never deleted here, so history + the escalate counter stand.
          for (const acId of acIds) deleteActiveByAc(ctx.db, acId);
        } else {
          deleteByTicket(ctx.db, ctx.ticket.id); // fresh / crash-resume whole-ticket author (unchanged)
        }
        for (const r of records) {
          const row = insertAcCheck(ctx.db, {
            ticketId: ctx.ticket.id,
            acId: r.acId,
            selector: r.selector,
            testPath: r.testPath,
            redFirstResult: r.coarse,
          });
          insertSignal(ctx.db, {
            ticketId: ctx.ticket.id,
            signalType: "ac-check-red-first",
            result: signalResultForCoarse(r.coarse),
            branchHeadSha: sha,
            detail: {
              rawOutput: r.rawOutput,
              exitCode: r.exitCode,
              framework: r.framework,
              command: r.command,
              acCheckId: row.id,
            },
          });
        }
      })();

      return { authored: records.length, acs: acs.length };
    } catch (err) {
      // A rejected author: roll the branch back to the pre-author HEAD so the invalid test commit
      // never reaches the PR, and record the dispatch as `reverted` (branch_head_sha ← preHead) so
      // getLatestForTicket never returns the discarded sha. Then rethrow → failure-policy re-dispatches
      // from a clean tree (codex finding P1). Guarded on sha !== preHead: a no-op author (nothing
      // committed) leaves HEAD already at preHead — nothing to undo.
      if (sha !== preHead) {
        resetWorktreeHard(worktreePath, preHead);
        const row = getByDispatchId(ctx.db, ctx.ticket.id, did);
        if (row) {
          completeDispatch(ctx.db, row.id, {
            outcome: "reverted",
            branchHeadSha: preHead,
            endedAt: nowUtc(),
          });
        }
      }
      throw err;
    }
  });

  registry.register("checks:classify", async (ctx: HandlerContext) => {
    // Classify ONLY unresolved rows (§7 write-once): a re-author round re-classifies only the freshly
    // re-authored NULL rows; every previously-classified row is frozen.
    const unresolved = listUnresolvedByTicket(ctx.db, ctx.ticket.id);
    if (unresolved.length === 0) return { classified: 0, adjudicated: 0, vacuous: 0 };

    const acs = listAcs(ctx.db, ctx.ticket.id);
    const acTextById = new Map(acs.map((a) => [a.id, a.text]));

    // 1) Read each check's RED-first trace by LIVE id (§3), run the prior.
    type Pending = { row: (typeof unresolved)[number]; coarse: CoarseResult; item: AdjudicateItem };
    const settled: Array<{
      acCheckId: number;
      acId: number;
      redClass: "absence" | "environmental";
    }> = [];
    const pending: Pending[] = [];
    for (const row of unresolved) {
      const sig = signalForAcCheck(ctx.db, row.id);
      const coarse = (row.red_first_result ?? "error") as CoarseResult;
      const rawOutput = sig?.detail.rawOutput ?? "";
      const prior = classifyPrior({ coarse, rawOutput });
      if (prior.kind === "settled-red") {
        settled.push({ acCheckId: row.id, acId: row.ac_id, redClass: prior.redClass });
        continue;
      }
      pending.push({
        row,
        coarse,
        item: {
          acCheckId: row.id,
          acText: acTextById.get(row.ac_id) ?? "",
          testPath: row.test_path,
          testName: row.selector,
          coarse,
          rawOutput,
        },
      });
    }

    // 2) Adjudicate the ambiguous checks (agent-skip when the prior settled everything, §5). A
    //    missing per-check result re-dispatches ONLY the affected checks (fault isolation), bounded.
    const results = new Map<number, AdjClass>();
    const reasons = new Map<number, string>();
    let toAsk = pending;
    for (let round = 0; round < 2 && toAsk.length > 0; round++) {
      const { output } = await runAgentDispatch(
        ctx,
        depsFor(ctx, deps, deps.timeoutMs ?? DEFAULT_TIMEOUT_MS),
        {
          handlerKey: "checks:classify",
          template: CHECKS_CLASSIFY_TEMPLATE,
          vars: adjudicateVars(
            ctx.ticket,
            deps.profile,
            toAsk.map((p) => p.item),
          ),
          postcondition: () => {}, // read-only: nothing commits
        },
      );
      const parsed = extractSidecar(output, ChecksClassifyOutputSchema);
      if (parsed.ok) {
        const asked = new Set(toAsk.map((p) => p.row.id));
        for (const c of parsed.value.classifications) {
          if (!asked.has(c.ac_check_id)) continue; // ignore ids we did not ask about
          results.set(c.ac_check_id, c.class);
          reasons.set(c.ac_check_id, c.reason);
        }
      }
      toAsk = toAsk.filter((p) => !results.has(p.row.id));
    }
    if (toAsk.length > 0) {
      // Absent after the fault-isolated bound = transport failure → failure-policy re-dispatches.
      throw new Error(
        `checks:classify: adjudicator omitted ${toAsk.length} check(s): ${toAsk.map((p) => p.row.id).join(", ")}`,
      );
    }

    // 3) Validate class↔coarse bucket, map to storage, persist ALL in one txn (crash-resume: an
    //    interrupted classify rolls back whole; §7 recompute-all-in-txn).
    const RED_CLASSES = new Set<AdjClass>(["assertion", "absence", "environmental", "weak"]);
    const GREEN_CLASSES = new Set<AdjClass>(["vacuous", "already-satisfied", "not-expressible"]);
    let vacuous = 0;
    let weak = 0;
    ctx.db.transaction(() => {
      for (const s of settled) {
        classifyAcCheck(ctx.db, { acCheckId: s.acCheckId, redClass: s.redClass });
        insertSignal(ctx.db, {
          ticketId: ctx.ticket.id,
          signalType: "ac-check-classification",
          result: "fail",
          detail: {
            acCheckId: s.acCheckId,
            acId: s.acId,
            class: s.redClass,
            reason: "deterministic prior",
          },
        });
      }
      for (const p of pending) {
        const cls = results.get(p.row.id) as AdjClass;
        const reason = reasons.get(p.row.id) ?? "";
        const isGreen = p.coarse === "green";
        if (isGreen ? !GREEN_CLASSES.has(cls) : !RED_CLASSES.has(cls)) {
          throw new Error(
            `checks:classify: class '${cls}' invalid for coarse '${p.coarse}' (check ${p.row.id})`,
          );
        }
        if (cls === "vacuous") {
          vacuous += 1; // no column set — triggers a re-author (§7); recorded as a signal for the verdict
        } else if (cls === "weak") {
          weak += 1; // no column set — triggers a re-author (§5); recorded as a signal for the verdict
        } else if (cls === "already-satisfied") {
          classifyAcCheck(ctx.db, { acCheckId: p.row.id, disposition: "satisfied" });
        } else if (cls === "not-expressible") {
          classifyAcCheck(ctx.db, { acCheckId: p.row.id, disposition: "not-expressible" });
        } else {
          classifyAcCheck(ctx.db, {
            acCheckId: p.row.id,
            redClass: cls as "assertion" | "absence" | "environmental",
          });
        }
        insertSignal(ctx.db, {
          ticketId: ctx.ticket.id,
          signalType: "ac-check-classification",
          result: cls === "already-satisfied" || cls === "not-expressible" ? "pass" : "fail",
          detail: { acCheckId: p.row.id, acId: p.row.ac_id, class: cls, reason },
        });
      }
    })();

    return {
      classified: settled.length + pending.length,
      adjudicated: pending.length,
      vacuous,
      weak,
    };
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
    const implPreHead = worktreeHead(implWorktreePath);
    const result = await runAgentDispatch(
      ctx,
      depsFor(ctx, deps, deps.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      {
        handlerKey: "implement:dispatch",
        template: IMPLEMENT_TEMPLATE,
        vars: implementVars(
          ctx.ticket,
          unit,
          deps.profile,
          implementFeedback(ctx.db, unit.id),
          listAcChecks(ctx.db, ctx.ticket.id),
          gateFeedback(ctx.db, ctx.ticket.id),
          reviewFeedback(ctx.db, ctx.ticket.id, unit.id),
        ),
        loopback: isUnitLoopback(ctx, unit.seq),
        runnerCommands,
        commitScope: implementScope,
        disposition: ctx.config.implementDisposition,
        // Empty-diff is no longer a dispatch-level failure: the plan gate guarantees non-empty
        // declared files, and the completeness step (under-delivery) is what gates on it now.
        postcondition: () => {},
      },
    );
    if (ctx.config.implementDisposition === "discard") {
      // Discard-mode sidecar guard: a transport failure must never become a silent partial-commit.
      // A MALFORMED sidecar always re-dispatches (we cannot trust ANY declaration it might contain).
      // An ABSENT sidecar re-dispatches ONLY when it actually caused a discard (undeclared new files
      // with no declaration to admit them) — a valid ticket with no new files and no sidecar is fine.
      // A valid sidecar that leaves an undeclared throwaway out is the intended discard path.
      const parsed = extractSidecar(result.output, ImplementOutputSchema);
      const malformed = !parsed.ok && parsed.reason === "malformed";
      const absentButDiscarded =
        !parsed.ok && parsed.reason === "absent" && result.discarded.length > 0;
      if (malformed || absentButDiscarded) {
        // Guarded on sha !== implPreHead (mirrors checks:dispatch's catch block, ~:748): a no-op
        // dispatch (nothing committed) leaves HEAD already at implPreHead, so `git clean -fd` would
        // wipe pre-existing untracked cruft — including the *.egg-info undoAttempt deliberately
        // spares — for no reason. Only reset + re-mark when a commit was actually produced.
        if (result.sha !== implPreHead) {
          resetWorktreeHard(implWorktreePath, implPreHead);
          const row = getByDispatchId(ctx.db, ctx.ticket.id, result.dispatchId);
          if (row) {
            completeDispatch(ctx.db, row.id, {
              outcome: "reverted",
              branchHeadSha: implPreHead,
              endedAt: nowUtc(),
            });
          }
        }
        throw new Error(
          `implement:dispatch sidecar transport failure (${parsed.ok ? "ok" : parsed.reason}); ` +
            `discarded=[${result.discarded.join(", ")}] — re-dispatching`,
        );
      }
    }
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
      // Fix A/B/D/E, and the whole-branch review's Finding 2): a successful pip-editable install
      // does not prove `import <pkg>` resolves to the worktree — a pre-installed/conda copy can
      // shadow it. Applies to any pip-editable-install shape (`isEditablePythonPrepare` — not
      // just the exact `pip install -e .` string; a config-overridden `pip install -e .[dev]` /
      // `--editable` / `python -m pip install -e .` is guarded too). An unresolvable import name
      // is NOT a silent skip (Fix B) — it escalates.
      const component = deps.profile.components.find((c) => c.name === a.component);
      const isEditablePythonInstall =
        component?.kind === "python" &&
        component.prepare !== undefined &&
        isEditablePythonPrepare(component.prepare);
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

  registry.register("completeness", async (ctx: HandlerContext) => {
    if (ctx.workUnitId === null) throw new Error("completeness: missing workUnitId");
    const unit = getUnit(ctx.db, ctx.workUnitId);
    if (!unit) throw new Error(`completeness: work_unit ${ctx.workUnitId} not found`);
    const { repoPath, worktreePath, branch } = worktreeFor(ctx, deps);
    ensureWorktree(repoPath, branch, worktreePath);

    const latestSha = getLatestByWorkUnit(ctx.db, ctx.workUnitId)?.branch_head_sha ?? undefined;
    const declared = parseFilesToTouch(unit);

    // The unit's OWN diff (per-unit base) — for over-delivery + "did this unit change anything".
    // Unlike verify:check, base==head means "this unit committed NOTHING": ownTouched is [] (NOT
    // changedFilesAt, which would wrongly attribute a sibling's commit at that sha as this unit's).
    const ownTouched =
      unit.base_sha && latestSha && unit.base_sha !== latestSha
        ? changedFilesBetween(unit.base_sha, latestSha, worktreePath)
        : [];

    // The CUMULATIVE ticket diff — base = the lowest-seq unit's base_sha (the ticket fork point),
    // so a redundant unit whose declared files a sibling already touched is not flagged (darkreader).
    const minSeqUnit = listUnits(ctx.db, ctx.ticket.id)[0];
    const cumulativeBase = minSeqUnit?.base_sha ?? null;
    const cumulativeTouched =
      cumulativeBase && latestSha && cumulativeBase !== latestSha
        ? changedFilesBetween(cumulativeBase, latestSha, worktreePath)
        : ownTouched;

    const { under, over } = reconcileScope(declared, cumulativeTouched, ownTouched);
    const disposition = classifyDisposition(under, ownTouched);

    // Over-delivery — advisory scope_diff, OWN-diff based, once per (unit, sha).
    if (latestSha !== undefined && declared.length > 0) {
      const already = listByUnit(ctx.db, ctx.workUnitId).some(
        (s) => s.signal_type === "scope_diff" && s.branch_head_sha === latestSha,
      );
      if (!already) {
        insertSignal(ctx.db, {
          ticketId: ctx.ticket.id,
          workUnitId: ctx.workUnitId,
          signalType: "scope_diff",
          result: over.length === 0 ? "pass" : "fail",
          branchHeadSha: latestSha,
          detail: { changed: ownTouched, out_of_scope: over },
        });
      }
    }

    insertSignal(ctx.db, {
      ticketId: ctx.ticket.id,
      workUnitId: ctx.workUnitId,
      signalType: "completeness",
      result: disposition === "under-delivered" ? "fail" : "pass",
      branchHeadSha: latestSha,
      detail: { disposition, under, declared },
    });

    if (disposition === "under-delivered") {
      throw new Error(`completeness:wu${unit.seq}: under-delivered [${under.join(", ")}]`);
    }
    return { disposition, under: under.length, over: over.length };
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
    sweepScratch(worktreePath); // defense-in-depth: no styre_scratch/ reaches the broad verify run (ENG-300)

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
      const toRun = await Promise.all(
        realImpacted
          .filter((c) => commandFor(c, checkType) !== undefined)
          .map(async (c) => ({
            component: c.name,
            command: await reuseAwareTestCommand(
              c,
              checkType,
              commandFor(c, checkType) as string,
              join(worktreePath, c.dir ?? ""),
            ),
            dir: c.dir,
          })),
      );
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

    // M4 §8a: the component-suite verdict is DEMOTED to advisory — record the (possibly-fail)
    // result for observability and RETURN normally; never throw on it. The AC-checks gate
    // (verify:checks-gate) is now the only per-change hard gate. The realImpacted run loop + the
    // A1 behavioral-no-test check above still COMPUTE `result`/`detail` as before — only the
    // terminal throw is removed. `advisory: true` marks this signal so implementFeedback (and any
    // other reader) knows it never gates and must not be fed back as a re-coding instruction.
    insertSignal(ctx.db, {
      ticketId: ctx.ticket.id,
      workUnitId: ctx.workUnitId,
      signalType: checkType,
      result,
      command: lastCommand,
      branchHeadSha: latestSha,
      detail: { ...detail, advisory: true },
    });

    return { check: checkType, result };
  });

  registry.register("verify:integration", async (ctx: HandlerContext) => {
    const { repoPath, worktreePath, branch } = worktreeFor(ctx, deps);
    ensureWorktree(repoPath, branch, worktreePath);

    const jobs: Array<{ label: string; command: string; dir?: string }> = [];
    for (const c of deps.profile.components) {
      for (const key of ["build", "test"] as const) {
        const cmd = commandFor(c, key);
        if (!cmd) continue;
        const command =
          key === "test"
            ? await reuseAwareTestCommand(c, key, cmd, join(worktreePath, c.dir ?? ""))
            : cmd;
        jobs.push({ label: `${c.name}:${key}`, command, dir: c.dir });
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
    // M4 §8c: demoted to advisory (§3/§7) — record the (possibly-fail) result and RETURN normally;
    // never throw on the suite verdict. Coupled with the resolver's integration gate flip to
    // ranShasFor (below) in this SAME commit — an advisory fail with no pass at HEAD would otherwise
    // re-emit this step forever against the journal replay (MAX_TRANSITIONS deadlock).
    insertSignal(ctx.db, {
      ticketId: ctx.ticket.id,
      signalType: "integration",
      result,
      command: lastCommand,
      branchHeadSha,
      detail: { ran, advisory: true },
    });
    return { integration: result };
  });

  registry.register("verify:checks-gate", async (ctx: HandlerContext) => {
    const checks = listAcChecks(ctx.db, ctx.ticket.id);
    if (checks.length === 0) return { gated: 0, stillRed: 0 }; // no AC-checks → nothing to gate
    const { repoPath, worktreePath, branch } = worktreeFor(ctx, deps);
    ensureWorktree(repoPath, branch, worktreePath);
    const headSha = getLatestForTicket(ctx.db, ctx.ticket.id)?.branch_head_sha;
    if (!headSha) throw new Error("verify:checks-gate: no branch head sha");

    // §2b integrity FIRST — a tampered check is untrustworthy at re-run.
    const violations = checkIntegrityViolations(ctx.db, ctx.ticket.id, worktreePath, headSha);
    for (const v of violations) {
      insertSignal(ctx.db, {
        ticketId: ctx.ticket.id,
        signalType: "ac-check-integrity",
        result: "fail",
        branchHeadSha: headSha,
        detail: v,
      });
    }
    // §4 re-run in the implemented env (throws loud on a NULL/NULL row).
    const rerun = await rerunAcChecks({
      db: ctx.db,
      ticketId: ctx.ticket.id,
      components: deps.profile.components,
      worktreePath,
      headSha,
      timeoutMs: deps.timeoutMs ?? VERIFY_TIMEOUT_MS,
      run: deps.runCheckCommand,
    });
    // Gate blocks on the union of tampered ACs + not-flipped gated ACs.
    const stillRed = [...new Set([...violations.map((v) => v.acId), ...rerun.stillRed])].sort(
      (a, b) => a - b,
    );
    insertSignal(ctx.db, {
      ticketId: ctx.ticket.id,
      signalType: "ac-check-gate",
      result: stillRed.length === 0 ? "pass" : "fail",
      branchHeadSha: headSha,
      detail: { stillRed, tampered: violations.map((v) => v.acId), advisory: rerun.advisory },
    });
    return { gated: checks.length, stillRed: stillRed.length };
  });

  registry.register("checks:arbitrate", async (ctx: HandlerContext) => {
    const { worktreePath } = worktreeFor(ctx, deps);
    const headSha = getLatestForTicket(ctx.db, ctx.ticket.id)?.branch_head_sha;
    if (!headSha) throw new Error("checks:arbitrate: no branch head sha");
    const behavioral = behavioralStillRed(ctx.db, ctx.ticket.id, headSha);
    if (behavioral.length === 0) return { arbitrated: 0 }; // no-op (integrity-only fail)

    const acs = listAcs(ctx.db, ctx.ticket.id);
    const acTextById = new Map(acs.map((a) => [a.id, a.text]));
    const active = listAcChecks(ctx.db, ctx.ticket.id); // active checks
    const byAc = new Map(active.map((c) => [c.ac_id, c]));
    const checkById = new Map(active.map((c) => [c.id, c]));

    const items: ArbitrateItem[] = [];
    for (const acId of behavioral) {
      const check = byAc.get(acId);
      const acText = acTextById.get(acId) ?? "";
      if (check === undefined || acText === "") {
        throw new Error(
          `checks:arbitrate: behavioral still-red AC ${acId} has no active check or no AC text (invariant: never an arbiter input)`,
        );
      }
      const pi = listSignalsByTicket(ctx.db, ctx.ticket.id)
        .filter((s) => s.signal_type === "ac-check-post-implement")
        .reverse()
        .find(
          (s) =>
            (JSON.parse(s.detail_json ?? "{}") as { acCheckId?: number }).acCheckId === check.id,
        );
      // FIX I2: prefer the persisted `rawOutput` (the actual failure trace, e.g. "assert 200 == 201" —
      // Task 4c's post-implement-rerun.ts extension) so the arbiter has real evidence for a
      // positive-AC-contradiction judgment, not just the coarse bucket. Fall back to `String(coarse)`
      // only if an older signal predates the rawOutput field (defensive; should not occur post-M5).
      const piDetail = pi
        ? (JSON.parse(pi.detail_json ?? "{}") as { coarse?: string; rawOutput?: string })
        : null;
      const trace = piDetail ? piDetail.rawOutput || String(piDetail.coarse ?? "") : "";
      const source = check.test_path
        ? (fileContentAt(headSha, check.test_path, worktreePath) ?? "")
        : "";
      items.push({
        acCheckId: check.id,
        acText,
        testPath: check.test_path,
        testName: check.selector,
        coarse: "red",
        trace,
        source,
      });
    }

    // Fault-isolated arbiter dispatch (bounded 2 rounds; a missing per-check verdict re-asks only it).
    const blame = new Map<number, { blame: string; reason: string }>();
    let toAsk = items;
    for (let round = 0; round < 2 && toAsk.length > 0; round++) {
      const { output } = await runAgentDispatch(
        ctx,
        depsFor(ctx, deps, deps.timeoutMs ?? DEFAULT_TIMEOUT_MS),
        {
          handlerKey: "checks:arbitrate",
          template: CHECKS_ARBITRATE_TEMPLATE,
          vars: arbitrateVars(ctx.ticket, deps.profile, toAsk),
          postcondition: () => {},
        },
      );
      const parsed = extractSidecar(output, ChecksArbitrateOutputSchema);
      if (parsed.ok) {
        const asked = new Set(toAsk.map((i) => i.acCheckId));
        for (const a of parsed.value.arbitrations) {
          if (!asked.has(a.ac_check_id)) continue;
          blame.set(a.ac_check_id, { blame: a.blame, reason: a.reason });
        }
      }
      toAsk = toAsk.filter((i) => !blame.has(i.acCheckId));
    }
    if (toAsk.length > 0) {
      throw new Error(
        `checks:arbitrate: arbiter omitted ${toAsk.length} check(s): ${toAsk.map((i) => i.acCheckId).join(", ")}`,
      );
    }

    // This handler stays BLAME-ONLY. Task 6 does NOT touch it — the check-wrong re-author lives in the
    // SEPARATE checks:reauthor step; applyArbiterVerdict routes check-wrong there (not into this handler).
    ctx.db.transaction(() => {
      for (const it of items) {
        const b = blame.get(it.acCheckId) as { blame: string; reason: string };
        const check = checkById.get(it.acCheckId) as (typeof active)[number];
        insertSignal(ctx.db, {
          ticketId: ctx.ticket.id,
          signalType: "ac-check-blame",
          result: "fail",
          branchHeadSha: headSha,
          detail: { acId: check.ac_id, acCheckId: check.id, blame: b.blame, reason: b.reason },
        });
      }
    })();
    return { arbitrated: items.length };
  });

  registry.register("checks:reauthor", async (ctx: HandlerContext) => {
    const route = latestReauthorRoute(ctx.db, ctx.ticket.id); // { acIds, sha } | null
    if (route === null || route.acIds.length === 0) return { reauthored: 0 }; // no-op (nothing routed)
    const roundSha = route.sha;

    const active = listAcChecks(ctx.db, ctx.ticket.id); // the check-wrong generation (still active)
    const byAc = new Map(active.map((c) => [c.ac_id, c]));

    // Re-author each check-wrong AC (sequential: each author dispatch commits, moving HEAD). The
    // installs commit; a rejected AC leaves its old check active (fail-closed).
    const dispositions: Array<{
      acId: number;
      acCheckId: number;
      disposition: "installed" | "rejected";
    }> = [];
    for (const acId of route.acIds) {
      const check = byAc.get(acId);
      if (check === undefined) {
        // The check-wrong AC's active check vanished (shouldn't happen) → fail closed as rejected.
        dispositions.push({ acId, acCheckId: -1, disposition: "rejected" });
        continue;
      }
      const outcome = await reauthorCheckWrong(ctx, deps, acId, check.id);
      dispositions.push({ acId, acCheckId: check.id, disposition: outcome });
    }

    // Record dispositions at the ROUND sha. Open-vocab signal_type (no schema change), never overwrites
    // the arbiter's ac-check-blame at the same sha.
    ctx.db.transaction(() => {
      for (const d of dispositions) {
        insertSignal(ctx.db, {
          ticketId: ctx.ticket.id,
          signalType: "ac-check-reauthor",
          result: d.disposition === "installed" ? "pass" : "fail",
          branchHeadSha: roundSha,
          detail: { acId: d.acId, acCheckId: d.acCheckId, disposition: d.disposition },
        });
      }
    })();
    return { reauthored: dispositions.filter((d) => d.disposition === "installed").length };
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

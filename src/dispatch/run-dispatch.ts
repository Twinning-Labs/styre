import type { AgentRunner } from "../agent/runner.ts";
import { resolveTier } from "../agent/tiers.ts";
import type { AgentConfig } from "../config/agent-config.ts";
import { modelForTier } from "../config/agent-config.ts";
import type { HandlerContext } from "../daemon/step-registry.ts";
import { completeDispatch, insertDispatch, nextSeq } from "../db/repos/dispatch.ts";
import { setPid } from "../db/repos/workflow-step.ts";
import { ParkSignal } from "../engine/park-signal.ts";
import { nowUtc } from "../util/time.ts";
import type { Profile } from "./profile.ts";
import { renderPrompt } from "./render-prompt.ts";
import { allowlistFor } from "./tool-allowlists.ts";
import {
  commitWorktree,
  ensureWorktree,
  pendingChanges,
  revertWorktree,
  worktreeHead,
} from "./worktree.ts";

export interface DispatchDeps {
  runner: AgentRunner;
  agentConfig: AgentConfig;
  profile: Profile;
  repoPath: string;
  worktreePath: string;
  branch: string;
  timeoutMs: number;
  /** Set only when resuming a parked run: the interrupted step's prior partial output, injected
   *  as an advisory (non-authoritative) continuity hint into THAT step's re-dispatch prompt. */
  resumeContext?: { stepKey: string; transcript: string };
}

export interface DispatchSpec {
  handlerKey: string;
  template: string;
  vars: Record<string, string>;
  loopback?: boolean;
  postcondition: (args: { worktreePath: string; changed: boolean; sha: string }) => void;
  /** Bash runner commands to scope the implement allowlist to (string commands only). Other
   *  handlers omit this (their allowlists do not scope Bash). */
  runnerCommands?: string[];
  /** Optional PRE-commit scope gate. When set, `runAgentDispatch` computes the full working-tree
   *  delta (incl untracked) after the agent runs and BEFORE committing, and calls this. A throw
   *  means "do not commit": the worktree is reverted, the dispatch is recorded `dispatch-failed`
   *  with the head UNCHANGED, and the error rethrows (→ failure-policy). Handlers that omit it are
   *  unaffected. Used by `docs:revise` to guarantee a docs-only commit. */
  commitGuard?: (args: { worktreePath: string; pending: string[] }) => void;
}

const CARRYOVER_PREFIX =
  "A previous attempt was interrupted (quota/billing pause). Below is its partial output, for " +
  "context only — it may be incomplete or stale. The repository and journal are the source of " +
  "truth; verify the current state before redoing or relying on anything it claims to have done.";
const CARRYOVER_SUFFIX = "--- end of interrupted attempt's partial output ---";

const RETRY_FEEDBACK_PREFIX =
  "## Your previous attempt at this step was REJECTED\n\nFix exactly the problem described below " +
  "and produce a corrected result — do NOT repeat the output that caused it. (If a planned work " +
  "unit has no files to change, it is redundant: remove it. If your structured output was malformed, " +
  "emit valid output.)";
const RETRY_FEEDBACK_SUFFIX = "--- end of prior rejection (address it before anything else) ---";

/** The human-readable message of the prior attempt's rejection, from `workflow_step.error_json`
 *  (serializeError → {name, message}). "" when there was no prior failure / it can't be parsed —
 *  so the first attempt and any malformed record prepend nothing. General: any dispatch step's own
 *  thrown postcondition/validation/sidecar rejection is carried into its retry. NOTE: the message is
 *  prepended verbatim into the agent prompt — today every gate message is styre-controlled (static
 *  text + integer seqs); if a future gate ever interpolates agent/ticket free-text into its thrown
 *  message, that text would be fed back verbatim (still self-to-self — the agent's own prior output —
 *  never a privilege escalation, but worth keeping gate messages free of untrusted content). */
function rejectionFrom(errorJson: string | null): string {
  if (!errorJson) return "";
  try {
    const msg = (JSON.parse(errorJson) as { message?: string }).message ?? "";
    return typeof msg === "string" ? msg.trim() : "";
  } catch {
    return "";
  }
}

function dispatchId(ident: string, seq: number): string {
  return `${ident}-d${String(seq).padStart(4, "0")}`;
}

/** The shared real-dispatch flow (control-loop §4), provider-agnostic: render (CL-PROFILE) →
 *  worktree → run the agent via the injected AgentRunner (model from the tier+config; pid
 *  journaled for orphan-kill) → daemon-commit (CL-COMMIT) → record the dispatch → enforce the
 *  postcondition (CL-POSTCOND). Throws on CL-PROFILE miss, transport failure, or postcondition
 *  failure (→ failure-policy). */
export async function runAgentDispatch(
  ctx: HandlerContext,
  deps: DispatchDeps,
  spec: DispatchSpec,
): Promise<{ dispatchId: string; sha: string; changed: boolean; output: string }> {
  const rendered = renderPrompt(spec.template, spec.vars);
  if (!rendered.ok) {
    throw new Error(`CL-PROFILE: unresolved prompt vars: ${rendered.missing.join(", ")}`);
  }

  let prompt = rendered.prompt;
  // CL-RETRY: prepend the prior attempt's rejection so a retry is informed, not blind. error_json
  // is captured generically by markFailed for every dispatch throw and survives resetToPending.
  const priorRejection = rejectionFrom(ctx.step.error_json);
  if (priorRejection !== "") {
    prompt = `${RETRY_FEEDBACK_PREFIX}\n\n${priorRejection}\n\n${RETRY_FEEDBACK_SUFFIX}\n\n${prompt}`;
  }
  if (deps.resumeContext && deps.resumeContext.stepKey === ctx.step.step_key) {
    // chain off `prompt` (NOT rendered.prompt) so both prepends compose (design §1, review Important)
    prompt = `${CARRYOVER_PREFIX}\n\n${deps.resumeContext.transcript}\n\n${CARRYOVER_SUFFIX}\n\n${prompt}`;
  }

  ensureWorktree(deps.repoPath, deps.branch, deps.worktreePath);

  const seq = nextSeq(ctx.db, ctx.ticket.id);
  const did = dispatchId(ctx.ticket.ident, seq);
  const tier = resolveTier(spec.handlerKey, { loopback: spec.loopback });
  const model = modelForTier(deps.agentConfig, tier);
  const inserted = insertDispatch(ctx.db, {
    ticketId: ctx.ticket.id,
    dispatchId: did,
    seq,
    workUnitId: ctx.workUnitId,
    stepId: ctx.step.id,
    stage: ctx.ticket.stage,
    model,
    startedAt: nowUtc(),
    worktreePath: deps.worktreePath,
  });

  const result = await deps.runner.run({
    prompt,
    model,
    allowedTools: allowlistFor(spec.handlerKey, { runnerCommands: spec.runnerCommands ?? [] }),
    cwd: deps.worktreePath,
    timeoutMs: deps.timeoutMs,
    onSpawn: (pid) => setPid(ctx.db, ctx.step.id, pid),
  });

  if (!result.completed || result.timedOut) {
    // A timeout never carries a marker (no drained output) → always transient.
    const cause = result.timedOut ? "transient" : (result.cause ?? "transient");
    if (cause === "session-limit" || cause === "out-of-credits") {
      completeDispatch(ctx.db, inserted.id, { outcome: "parked", endedAt: nowUtc() });
      throw new ParkSignal({
        cause,
        resetAt: result.resetAt ?? null,
        dispatchId: did,
        transcript: result.stdout ?? "",
      });
    }
    completeDispatch(ctx.db, inserted.id, { outcome: "dispatch-failed", endedAt: nowUtc() });
    throw new Error(
      `dispatch ${did} transport failure (exit ${result.exitCode}, timedOut=${result.timedOut})`,
    );
  }

  if (spec.commitGuard) {
    const preHead = worktreeHead(deps.worktreePath);
    const pending = pendingChanges(deps.worktreePath);
    try {
      spec.commitGuard({ worktreePath: deps.worktreePath, pending });
    } catch (err) {
      revertWorktree(deps.worktreePath);
      completeDispatch(ctx.db, inserted.id, {
        outcome: "dispatch-failed",
        branchHeadSha: preHead,
        endedAt: nowUtc(),
      });
      throw err;
    }
  }

  const { sha, changed } = commitWorktree(deps.worktreePath, `${did} ${spec.handlerKey}`);
  const completion = {
    branchHeadSha: sha,
    endedAt: nowUtc(),
    costUsd: result.costUsd,
    tokensIn: result.tokensIn,
    tokensOut: result.tokensOut,
    cacheRead: result.cacheRead ?? null,
    cacheCreate: result.cacheCreate ?? null,
  };
  try {
    spec.postcondition({ worktreePath: deps.worktreePath, changed, sha });
  } catch (err) {
    completeDispatch(ctx.db, inserted.id, { outcome: "postcondition-failed", ...completion });
    throw err;
  }
  completeDispatch(ctx.db, inserted.id, { outcome: "clean-success", ...completion });
  return { dispatchId: did, sha, changed, output: result.stdout };
}

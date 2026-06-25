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
import { commitWorktree, ensureWorktree } from "./worktree.ts";

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
}

const CARRYOVER_PREFIX =
  "A previous attempt was interrupted (quota/billing pause). Below is its partial output, for " +
  "context only — it may be incomplete or stale. The repository and journal are the source of " +
  "truth; verify the current state before redoing or relying on anything it claims to have done.";
const CARRYOVER_SUFFIX = "--- end of interrupted attempt's partial output ---";

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
  if (deps.resumeContext && deps.resumeContext.stepKey === ctx.step.step_key) {
    prompt = `${CARRYOVER_PREFIX}\n\n${deps.resumeContext.transcript}\n\n${CARRYOVER_SUFFIX}\n\n${rendered.prompt}`;
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

import type { AgentRunner } from "../agent/runner.ts";
import { resolveTier } from "../agent/tiers.ts";
import type { AgentConfig } from "../config/agent-config.ts";
import { modelForTier } from "../config/agent-config.ts";
import type { HandlerContext } from "../daemon/step-registry.ts";
import { completeDispatch, insertDispatch, nextSeq } from "../db/repos/dispatch.ts";
import { setPid } from "../db/repos/workflow-step.ts";
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
}

export interface DispatchSpec {
  handlerKey: string;
  template: string;
  vars: Record<string, string>;
  loopback?: boolean;
  postcondition: (args: { worktreePath: string; changed: boolean; sha: string }) => void;
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
): Promise<{ dispatchId: string; sha: string; changed: boolean }> {
  const rendered = renderPrompt(spec.template, spec.vars);
  if (!rendered.ok) {
    throw new Error(`CL-PROFILE: unresolved prompt vars: ${rendered.missing.join(", ")}`);
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
    prompt: rendered.prompt,
    model,
    allowedTools: allowlistFor(spec.handlerKey),
    cwd: deps.worktreePath,
    timeoutMs: deps.timeoutMs,
    onSpawn: (pid) => setPid(ctx.db, ctx.step.id, pid),
  });

  if (!result.completed || result.timedOut) {
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
  };
  try {
    spec.postcondition({ worktreePath: deps.worktreePath, changed, sha });
  } catch (err) {
    completeDispatch(ctx.db, inserted.id, { outcome: "postcondition-failed", ...completion });
    throw err;
  }
  completeDispatch(ctx.db, inserted.id, { outcome: "clean-success", ...completion });
  return { dispatchId: did, sha, changed };
}

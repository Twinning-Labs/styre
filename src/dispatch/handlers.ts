import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { branchNameFor } from "../agent/branch.ts";
import type { AgentRunner } from "../agent/runner.ts";
import type { AgentConfig } from "../config/agent-config.ts";
import { StepRegistry } from "../daemon/step-registry.ts";
import type { HandlerContext } from "../daemon/step-registry.ts";
import { getLatestByWorkUnit, getLatestForTicket } from "../db/repos/dispatch.ts";
import { listByTicket as listEvents } from "../db/repos/event-log.ts";
import { insertSignal } from "../db/repos/ground-truth-signal.ts";
import { getProject } from "../db/repos/project.ts";
import { getById as getUnit, setStatus as setUnitStatus } from "../db/repos/work-unit.ts";
import { runCommand } from "../util/run-command.ts";
import type { Profile } from "./profile.ts";
import { DESIGN_TEMPLATE, IMPLEMENT_TEMPLATE, designVars, implementVars } from "./prompt-vars.ts";
import type { DispatchDeps } from "./run-dispatch.ts";
import { runAgentDispatch } from "./run-dispatch.ts";
import { ensureWorktree } from "./worktree.ts";

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
 *  Other handlerKeys (extract/review → M5; verify → M4; merge → M6) are added later. */
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
        vars: implementVars(ctx.ticket, unit, deps.profile),
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
    const latest = getLatestByWorkUnit(ctx.db, ctx.workUnitId);
    const branchHeadSha = latest?.branch_head_sha ?? null;
    const result =
      run.exitCode === 0 ? "pass" : run.timedOut || run.exitCode === null ? "error" : "fail";
    insertSignal(ctx.db, {
      ticketId: ctx.ticket.id,
      workUnitId: ctx.workUnitId,
      signalType: checkType,
      result,
      command,
      branchHeadSha: branchHeadSha ?? undefined,
      detail: { exitCode: run.exitCode, timedOut: run.timedOut, stderr: run.stderr.slice(0, 2000) },
    });
    if (result !== "pass") {
      throw new Error(`verify:check ${checkType}: ${result} (exit ${run.exitCode})`);
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

  return registry;
}

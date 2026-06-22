import type { Database } from "bun:sqlite";
import type { RuntimeConfig } from "../config/runtime-config.ts";
import { listPending } from "../db/repos/signal.ts";
import { getTicket } from "../db/repos/ticket.ts";
import { tick } from "./loop.ts";
import type { ProjectorPorts } from "./projector.ts";
import type { StepRegistry } from "./step-registry.ts";

export type RunOutcome = "pr-ready" | "done" | "blocked" | "no-progress";
export interface RunResult {
  outcome: RunOutcome;
  iterations: number;
  stage: string;
  status: string;
}

const DEFAULT_CAP = 200; // overall iteration budget for one ticket
const IDLE_CAP = 3; // consecutive zero-advance ticks → stalled

/** Drive ONE ticket through repeated ticks until a terminal state. `run` exits at PR-ready (the
 *  ticket parked at merge on human_merge_approval — the PR is open, awaiting the human merge gate
 *  which `run` never delivers). Passes `profile` so pollChecks delivers external_checks. */
export async function driveToTerminal(
  db: Database,
  registry: StepRegistry,
  opts: {
    ticketId: number;
    config: RuntimeConfig;
    ports: ProjectorPorts;
    profile: { checksSystem: string };
    cap?: number;
  },
): Promise<RunResult> {
  const cap = opts.cap ?? DEFAULT_CAP;
  let idle = 0;
  let last = { stage: "", status: "" };
  for (let i = 1; i <= cap; i++) {
    const r = await tick(db, registry, {
      config: opts.config,
      ports: opts.ports,
      profile: opts.profile,
    });
    const t = getTicket(db, opts.ticketId);
    if (!t) throw new Error(`driveToTerminal: ticket ${opts.ticketId} not found`);
    last = { stage: t.stage, status: t.status };
    const pending = listPending(db, opts.ticketId);

    if (t.status === "done") return { outcome: "done", iterations: i, ...last };
    if (pending.some((s) => s.signal_type === "human_resume"))
      return { outcome: "blocked", iterations: i, ...last };
    if (t.stage === "merge" && pending.some((s) => s.signal_type === "human_merge_approval"))
      return { outcome: "pr-ready", iterations: i, ...last };

    if (r.advanced === 0) {
      idle += 1;
      if (idle >= IDLE_CAP) return { outcome: "no-progress", iterations: i, ...last };
    } else {
      idle = 0;
    }
  }
  return { outcome: "no-progress", iterations: cap, ...last };
}

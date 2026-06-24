import type { Database } from "bun:sqlite";
import type { RuntimeConfig } from "../config/runtime-config.ts";
import type { ParkInfo } from "../engine/park-signal.ts";
import { advanceOneStep } from "./advance.ts";
import { pollChecks } from "./poll-checks.ts";
import { type ProjectorPorts, drainOutbox } from "./projector.ts";
import type { StepRegistry } from "./step-registry.ts";

const DEFAULT_MAX_CONCURRENT = 2; // K (control-loop §2.2)

/** Ticket ids the daemon may pick this tick — active, project not paused, not parked
 *  on a pending signal (the v_ready_tickets view). */
export function readyTicketIds(db: Database): number[] {
  return db
    .query<{ id: number }, []>("SELECT id FROM v_ready_tickets")
    .all()
    .map((r) => r.id);
}

/** One pass of the event loop: advance up to K ready tickets by one step each, then drain the
 *  projection outbox if ports are supplied. When ports are absent (e.g. the walking-skeleton),
 *  no drain happens and rows accumulate harmlessly. */
export async function tick(
  db: Database,
  registry: StepRegistry,
  opts?: {
    maxConcurrent?: number;
    config?: RuntimeConfig;
    ports?: ProjectorPorts;
    profile?: { checksSystem: string };
  },
): Promise<{ advanced: number; blocked: boolean; parked?: ParkInfo }> {
  const max = opts?.maxConcurrent ?? DEFAULT_MAX_CONCURRENT;
  const ids = readyTicketIds(db).slice(0, max);
  let advanced = 0;
  // A 'blocked' resolver outcome makes no state change and raises no signal, so it is NOT progress:
  // count it separately so the driver can terminate instead of spinning to the iteration cap
  // (control-loop §8-P1: never a dead end).
  let blocked = false;
  let parked: ParkInfo | undefined;
  for (const id of ids) {
    const outcome = await advanceOneStep(db, id, registry, { config: opts?.config });
    if (outcome.kind === "blocked") blocked = true;
    else if (outcome.kind === "parked")
      parked = outcome.park; // `styre run` is single-ticket so at most one park per drive is possible; multi-ticket daemon park handling is future work
    else advanced++;
  }
  if (opts?.ports) {
    await drainOutbox(db, opts.ports);
  }
  if (opts?.profile) {
    await pollChecks(db, opts.profile, opts.ports?.checks);
  }
  return { advanced, blocked, parked };
}

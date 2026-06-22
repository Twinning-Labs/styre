import type { Database } from "bun:sqlite";
import type { RuntimeConfig } from "../config/runtime-config.ts";
import { advanceOneStep } from "./advance.ts";
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
  opts?: { maxConcurrent?: number; config?: RuntimeConfig; ports?: ProjectorPorts },
): Promise<{ advanced: number }> {
  const max = opts?.maxConcurrent ?? DEFAULT_MAX_CONCURRENT;
  const ids = readyTicketIds(db).slice(0, max);
  let advanced = 0;
  for (const id of ids) {
    await advanceOneStep(db, id, registry, { config: opts?.config });
    advanced++;
  }
  if (opts?.ports) {
    await drainOutbox(db, opts.ports);
  }
  return { advanced };
}

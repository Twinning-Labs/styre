import type { Database } from "bun:sqlite";
import type { NonPrimaryComponent } from "../cli/component-roles.ts";
import type { UnusableComponent } from "../cli/preflight.ts";
import type { RuntimeConfig } from "../config/runtime-config.ts";
import { appendEvent } from "../db/repos/event-log.ts";
import { getInput, insertInputIfAbsent, upsertInput } from "../db/repos/ticket-input.ts";
import { type TicketRow, getTicket, listActiveTickets } from "../db/repos/ticket.ts";
import type { Profile } from "../dispatch/profile.ts";
import { nowUtc } from "../util/time.ts";
import { canonicalJson, sha256Hex } from "./canonical.ts";
import {
  SNAPSHOT_INPUT_NAMES,
  type SnapshotInputName,
  TICKET_TEXT_INPUTS,
} from "./design-graph.ts";

/** The commit a run started from (spec §4.2). Not a fingerprinted input; ENG-478 reads it. */
export const STARTING_COMMIT_INPUT = "run.startingCommit";

/** What the design handlers receive, exactly (spec §4.1): the profile narrowed by role and by this
 *  host's toolchain, the lists of what was narrowed away, and the config. */
export interface SnapshotSources {
  profile: Profile;
  unusableComponents: readonly UnusableComponent[];
  nonPrimaryComponents: readonly NonPrimaryComponent[];
  config: Pick<RuntimeConfig, "complexityGrading">;
}

export interface RunInputs extends SnapshotSources {
  /** In place: HEAD at run start. Worktree mode: null here; provision records it (§4.2). */
  startingCommit: string | null;
}

const byComponent = <T extends { component: string }>(a: T, b: T): number =>
  a.component < b.component ? -1 : a.component > b.component ? 1 : 0;

export function snapshotValues(
  ticket: Pick<TicketRow, "ident" | "title" | "description">,
  s: SnapshotSources,
): Record<SnapshotInputName, unknown> {
  return {
    "ticket.ident": ticket.ident,
    "ticket.title": ticket.title,
    "ticket.description": ticket.description,
    "profile.slug": s.profile.slug,
    "profile.promptVars": s.profile.promptVars,
    "profile.runtimeContext": s.profile.runtimeContext,
    "profile.components": s.profile.components,
    // sets: sorted, so the host's discovery order cannot change the digest
    "run.unusableComponents": [...s.unusableComponents].sort(byComponent),
    "run.nonPrimaryComponents": [...s.nonPrimaryComponents].sort(byComponent),
    "config.complexityGrading": s.config.complexityGrading,
  };
}

/** Write the snapshot (spec §4). The ticket text is written once and never rewritten (E2); every
 *  other input is rewritten when its digest changed, and the changed names go in one `note` event,
 *  reason `inputs-changed`. Called at run start, on a reused --db, and on each resume. */
export function captureSnapshot(
  db: Database,
  ticketId: number,
  sources: SnapshotSources,
): { changed: SnapshotInputName[] } {
  const ticket = getTicket(db, ticketId);
  if (!ticket) throw new Error(`captureSnapshot: ticket ${ticketId} not found`);
  const values = snapshotValues(ticket, sources);
  const changed: SnapshotInputName[] = [];
  db.transaction(() => {
    const at = nowUtc();
    for (const name of SNAPSHOT_INPUT_NAMES) {
      const value_json = canonicalJson(values[name]);
      const row = {
        ticket_id: ticketId,
        name,
        value_json,
        digest: sha256Hex(value_json),
        captured_at: at,
      };
      if (TICKET_TEXT_INPUTS.includes(name)) {
        insertInputIfAbsent(db, row);
        continue;
      }
      const prior = getInput(db, ticketId, name);
      if (prior === null) upsertInput(db, row);
      else if (prior.digest !== row.digest) {
        upsertInput(db, row);
        changed.push(name);
      }
    }
    if (changed.length > 0) {
      const pastDesign = ticket.stage !== "design";
      appendEvent(db, {
        ticketId,
        kind: "note",
        reason: "inputs-changed",
        payload: {
          event: "inputs-changed",
          names: changed,
          pastDesign,
          message: pastDesign
            ? "recorded; the run carries on from where it paused, and the change takes effect the next time the run is in design"
            : "the design steps that read these inputs are judged again when the run next walks the design steps; a run stopped at the plan review gate stays there until the plan changes (edit it and resume with --accept-head)",
        },
      });
    }
  })();
  return { changed };
}

/** The mark of a run started again on an existing database without a `resumed` event of its
 *  own: the invalidate loop guard counts from the latest one (spec §6.6, ruling 2026-10-09). */
export function noteReusedDatabase(db: Database, ticketId: number): void {
  appendEvent(db, {
    ticketId,
    kind: "note",
    reason: "reused-database",
    payload: { event: "reused-database" },
  });
}

/** Operator rulings, 2026-10-10 (spec §4): a run on a reused --db, and a resume, drive every ready
 *  ticket in the database with this run's registry and so with this run's inputs. Each other active
 *  ticket gets the same snapshot, with the same note, before any step runs. Waiting tickets are left
 *  alone, and no other ticket gets a starting commit: that stays the run's own ticket's.
 *  Before its snapshot, each gets a `reused-database` note: it is driven again, its inputs
 *  rewritten, and the `resumed` event of a resume is the run's own ticket's alone, so without the
 *  note an input that changes at every restart would trip its loop guard on the fourth (ruling,
 *  2026-10-10). */
export function captureOtherActiveTickets(
  db: Database,
  ticketId: number,
  sources: SnapshotSources,
): void {
  for (const other of listActiveTickets(db)) {
    if (other.id === ticketId) continue;
    noteReusedDatabase(db, other.id);
    captureSnapshot(db, other.id, sources);
  }
}

export function recordStartingCommit(db: Database, ticketId: number, sha: string): boolean {
  const value_json = canonicalJson(sha);
  return insertInputIfAbsent(db, {
    ticket_id: ticketId,
    name: STARTING_COMMIT_INPUT,
    value_json,
    digest: sha256Hex(value_json),
    captured_at: nowUtc(),
  });
}

export function startingCommit(db: Database, ticketId: number): string | null {
  const row = getInput(db, ticketId, STARTING_COMMIT_INPUT);
  return row === null ? null : (JSON.parse(row.value_json) as string);
}

function requireRow(db: Database, ticketId: number, name: SnapshotInputName) {
  const row = getInput(db, ticketId, name);
  if (row === null)
    throw new Error(
      `ticket ${ticketId}: ticket_input is missing ${name}; the snapshot was never captured`,
    );
  return row;
}

export function snapshotDigest(db: Database, ticketId: number, name: SnapshotInputName): string {
  return requireRow(db, ticketId, name).digest;
}

export function snapshotValue(db: Database, ticketId: number, name: SnapshotInputName): unknown {
  return JSON.parse(requireRow(db, ticketId, name).value_json);
}

/** A design table step may run only once the snapshot exists (fail fast, spec §5.2). */
export function requireSnapshot(db: Database, ticketId: number): void {
  const missing = SNAPSHOT_INPUT_NAMES.filter((n) => getInput(db, ticketId, n) === null);
  if (missing.length > 0)
    throw new Error(
      `ticket ${ticketId}: ticket_input is missing ${missing.join(", ")}; the snapshot was never captured`,
    );
}

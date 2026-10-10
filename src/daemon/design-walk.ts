import type { Database } from "bun:sqlite";
import { classifyDatabase } from "../db/migrate.ts";
import { readCopyOf } from "../db/read-copy.ts";
import { requiredPlanFindings } from "../db/repos/review-round.ts";
import type { TicketRow } from "../db/repos/ticket.ts";
import { getByKey } from "../db/repos/workflow-step.ts";
import { FINGERPRINT_SCHEME } from "./canonical.ts";
import { changedInputs, currentManifest } from "./design-digests.ts";
import { DESIGN_TABLE, type GateRow, ensureDesignTableChecked } from "./design-graph.ts";
import type { StepDescriptor } from "./resolver.ts";

/** The tickets whose design steps were fingerprinted under a scheme newer than this Styre's,
 *  with the highest such scheme, or null (operator rulings, 2026-10-10, spec §5.1). Reads `db`
 *  only: the callers pass a private copy at the current version (an older database has no
 *  `fingerprint_scheme` column, and a newer one is refused by `migrate` anyway). */
export function newerSchemeIn(db: Database): { scheme: number; idents: string[] } | null {
  const rows = db
    .query<{ ident: string; s: number }, [number]>(
      `SELECT t.ident AS ident, MAX(w.fingerprint_scheme) AS s
         FROM workflow_step w JOIN ticket t ON t.id = w.ticket_id
        WHERE w.fingerprint_scheme > ? GROUP BY t.ident ORDER BY t.ident`,
    )
    .all(FINGERPRINT_SCHEME);
  if (rows.length === 0) return null;
  return { scheme: Math.max(...rows.map((r) => r.s)), idents: rows.map((r) => r.ident) };
}

/** `newerSchemeIn` on one private copy of the database at `path`, which it never opens. */
export function newerSchemeRecorded(path: string): { scheme: number; idents: string[] } | null {
  return readCopyOf(path, (db) =>
    classifyDatabase(db, path).kind === "current" ? newerSchemeIn(db) : null,
  );
}

/** A resume of a run fingerprinted under a newer scheme (operator ruling, 2026-10-10). */
export function newerSchemeRefusal(ident: string, scheme: number): string {
  return `this run was recorded by a newer Styre; use that version.\n  Its design steps were fingerprinted under scheme ${scheme}; this Styre knows scheme ${FINGERPRINT_SCHEME} and cannot compare them.\n  Nothing was changed. Or start the ticket over: styre run ${ident} --fresh.\n`;
}

/** A fresh run on a reused --db that holds such a run (operator rulings, 2026-10-10). It names
 *  every ticket with a newer manifest, and does not suggest --fresh, which a reused database
 *  ignores. */
export function newerSchemeDbRefusal(found: { scheme: number; idents: string[] }): string {
  return `this database holds a run recorded by a newer Styre; use that version, or point --db at a new database.\n  Design steps fingerprinted under scheme ${found.scheme} (this Styre knows scheme ${FINGERPRINT_SCHEME}), for: ${found.idents.join(", ")}.\n  Nothing was changed.\n`;
}

const GATE_FIRES: Record<GateRow["name"], (db: Database, ticketId: number) => boolean> = {
  // today's resolver rule: blocking findings of the latest design:review dispatch remain
  "plan-review": (db, ticketId) => requiredPlanFindings(db, ticketId).length > 0,
};

/** The design routing, generated from the declared table (spec §5.4). Walks the rows in order:
 *  skip a row whose "applies when" is false; a step that is not succeeded is the next step and the
 *  walk stops there; a succeeded step's manifest is recomputed and compared with the recorded one,
 *  and a mismatch invalidates that step alone (its readers are judged afresh after it reruns: early
 *  cutoff); a gate that fires returns its escalation. Null past the last row. Reads the database
 *  only, never the worktree. Pure: the interpreter applies what it returns. */
export function walkDesign(db: Database, ticket: TicketRow): StepDescriptor | null {
  ensureDesignTableChecked();
  for (const row of DESIGN_TABLE) {
    if (!row.appliesWhen(ticket)) continue;
    if (row.kind === "gate") {
      if (GATE_FIRES[row.name](db, ticket.id))
        return {
          kind: "escalate",
          reason: row.reason,
          signature: row.signature,
          stepKey: row.stepKey,
        };
      continue;
    }
    const step = getByKey(db, ticket.id, row.stepKey);
    if (step?.status !== "succeeded") {
      return {
        kind: "step",
        stepKey: row.stepKey,
        stepType: row.stepType,
        handlerKey: row.handlerKey,
        workUnitId: null,
      };
    }
    // Neither can reach here: the adopt pass (resume, reused --db) records a manifest for every
    // succeeded step without one, and both a resume and a run on a reused --db refuse a newer
    // scheme before they start (65; operator rulings, 2026-10-10).
    if (step.input_manifest === null || (step.fingerprint_scheme ?? 0) > FINGERPRINT_SCHEME) {
      throw new Error(
        `design walk: '${row.stepKey}' succeeded without an input manifest this Styre can compare (scheme ${step.fingerprint_scheme ?? "none"}, this Styre ${FINGERPRINT_SCHEME}); the adopt pass should have recorded one, and a resume or a reused --db refuses a newer scheme`,
      );
    }
    // Operator ruling (2026-10-09, spec §5.1): a manifest recorded under an older scheme counts as
    // changed. Its digests are not comparable, so the step reruns now that the run is in design.
    const recorded =
      step.fingerprint_scheme === FINGERPRINT_SCHEME
        ? (JSON.parse(step.input_manifest) as Record<string, string>)
        : {};
    const changed = changedInputs(recorded, currentManifest(db, ticket.id, row));
    if (changed.length > 0) {
      return { kind: "invalidate", stepKeys: [row.stepKey], reason: { cause: "inputs", changed } };
    }
  }
  return null;
}

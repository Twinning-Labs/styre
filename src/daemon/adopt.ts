import type { Database } from "bun:sqlite";
import { branchNameFor } from "../agent/branch.ts";
import { appendEvent } from "../db/repos/event-log.ts";
import { getProject } from "../db/repos/project.ts";
import { getTicket, listActiveTickets } from "../db/repos/ticket.ts";
import { type WorkflowStepRow, getByKey, recordManifest } from "../db/repos/workflow-step.ts";
import { branchHeadSha } from "../dispatch/worktree.ts";
import { FINGERPRINT_SCHEME, digestValue } from "./canonical.ts";
import { planDigestOf, recordStepManifest, ticketPlanFilesAt } from "./design-digests.ts";
import { DESIGN_TABLE, type DesignStepKey, type StepRow } from "./design-graph.ts";

export interface AdoptContext {
  repoPath: string;
  branch: string;
}

export interface AdoptResult {
  /** Recorded with today's inputs: they count as done. */
  adopted: DesignStepKey[];
  /** Recorded with an empty manifest: the walk invalidates each one (cause `inputs`) when it
   *  reaches it, after the steps before it have run. */
  willRerun: DesignStepKey[];
}

/** Succeeded with no manifest at all: finished under a Styre older than ENG-477. A manifest
 *  recorded under an older scheme is never adopted again; the walk counts it as changed (operator
 *  ruling, 2026-10-09, spec §5.1). */
const unfingerprinted = (s: WorkflowStepRow | null): boolean =>
  s !== null && s.status === "succeeded" && s.input_manifest === null;

/** The plan's digest at the branch head, or null when it cannot be read there: the branch is gone,
 *  or holds no plan file for this ticket. Read through git, before any transaction (spec §5.2).
 *  The branch is resolved fully qualified and the plan read at that commit: git prefers a tag of
 *  the same name over a bare branch name. */
function readablePlanDigest(ctx: AdoptContext, ident: string): string | null {
  const head = branchHeadSha(ctx.repoPath, `refs/heads/${ctx.branch}`);
  if (head === null) return null;
  const files = ticketPlanFilesAt(ctx.repoPath, head, ident);
  return files.length === 0 ? null : planDigestOf(files);
}

/** spec §7.6 (D9) and the operator rulings of 2026-10-09: a run paused by an older Styre has
 *  succeeded design steps with no manifest. Going through the table
 *  in order, as the walk does, each one before the first applicable step that is not succeeded is
 *  recorded with its manifest from the current inputs (and, for design:dispatch, the plan's digest
 *  at the branch head), so it counts as done and the run continues without rerunning it. Each one
 *  after that point, or whose plan cannot be read, or that does not apply, is recorded with an
 *  empty manifest: its inputs do not exist yet, so the walk invalidates it through the ordinary
 *  comparison once its upstream has run. `provision` produces nothing a later step reads, so its
 *  reset for a recreated worktree does not stop the pass. One `note`, reason `adopted`, lists both
 *  sets, and says that an edit made between the pause and the upgrade cannot be detected. Runs
 *  after the snapshot and before the first resolver pass: on every resume and on a reused --db. */
export function adoptUnfingerprinted(
  db: Database,
  ticketId: number,
  ctx: AdoptContext,
): AdoptResult {
  const ticket = getTicket(db, ticketId);
  if (!ticket) throw new Error(`adopt: ticket ${ticketId} not found`);
  const rows = DESIGN_TABLE.filter((r): r is StepRow => r.kind === "step");
  const candidates = rows.filter((r) => unfingerprinted(getByKey(db, ticketId, r.stepKey)));
  if (candidates.length === 0) return { adopted: [], willRerun: [] };
  const planDigest = candidates.some((r) => r.fileOutput)
    ? readablePlanDigest(ctx, ticket.ident)
    : null;
  const adopted: StepRow[] = [];
  const willRerun: StepRow[] = [];
  let stopped = false;
  for (const row of rows) {
    const step = getByKey(db, ticketId, row.stepKey);
    const applies = row.appliesWhen(ticket);
    if (unfingerprinted(step)) {
      const unreadable = row.fileOutput && planDigest === null;
      if (stopped || !applies || unreadable) willRerun.push(row);
      else adopted.push(row);
      if (applies && unreadable) stopped = true;
    } else if (applies && step?.status !== "succeeded" && row.produces.length > 0) {
      stopped = true; // a later step's inputs include what this one has not produced yet
    }
  }
  db.transaction(() => {
    // table order: design:extract's manifest reads the plan digest adopted just before it
    for (const row of adopted) {
      const step = getByKey(db, ticketId, row.stepKey);
      if (!step) throw new Error(`adopt: ${row.stepKey} vanished`);
      recordStepManifest(db, ticketId, step.id, row, row.fileOutput ? planDigest : null);
    }
    for (const row of willRerun) {
      const step = getByKey(db, ticketId, row.stepKey);
      if (!step) throw new Error(`adopt: ${row.stepKey} vanished`);
      recordManifest(db, step.id, {
        manifest: {},
        fingerprint: digestValue({}),
        outputDigest: null,
        scheme: FINGERPRINT_SCHEME,
      });
    }
    appendEvent(db, {
      ticketId,
      kind: "note",
      reason: "adopted",
      payload: {
        event: "adopted",
        stepKeys: adopted.map((r) => r.stepKey),
        willRerun: willRerun.map((r) => r.stepKey),
        message:
          "these design steps finished under an older Styre; their inputs are recorded as they are now, so an edit made between the pause and the upgrade cannot be detected. Those under willRerun finished after a step that has not, so they run again once it has",
      },
    });
  })();
  return {
    adopted: adopted.map((r) => r.stepKey),
    willRerun: willRerun.map((r) => r.stepKey),
  };
}

/** The adopt pass for the run's own ticket, then for every other active ticket in the database
 *  (operator rulings, 2026-10-10, spec §4: a run on a reused --db and a resume prepare every ticket
 *  their loop drives), each against its own project's repository and its own branch, with its own
 *  note. Waiting tickets are left alone. Called after every snapshot is captured, since the pass
 *  reads them. */
export function adoptActiveTickets(db: Database, ticketId: number): void {
  const others = listActiveTickets(db).filter((t) => t.id !== ticketId);
  for (const id of [ticketId, ...others.map((t) => t.id)]) {
    const ticket = getTicket(db, id);
    const project = ticket ? getProject(db, ticket.project_id) : null;
    if (!ticket || !project) throw new Error(`adopt: ticket ${id} or its project vanished`);
    adoptUnfingerprinted(db, id, { repoPath: project.target_repo, branch: branchNameFor(ticket) });
  }
}

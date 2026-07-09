import type { Database } from "bun:sqlite";
import { listActiveByTicket as listAcChecks } from "../db/repos/ac-check.ts";
import { getLatestByWorkUnit, getLatestForTicket } from "../db/repos/dispatch.ts";
import * as gts from "../db/repos/ground-truth-signal.ts";
import { hasDelivered } from "../db/repos/signal.ts";
import { getTicket } from "../db/repos/ticket.ts";
import * as workUnits from "../db/repos/work-unit.ts";
import { getByKey } from "../db/repos/workflow-step.ts";

export type StepDescriptor =
  | {
      kind: "step";
      stepKey: string;
      stepType: string;
      handlerKey: string;
      workUnitId: number | null;
    }
  | { kind: "advance"; from: string; to: string }
  | { kind: "mark-verified"; workUnitId: number }
  | { kind: "wait"; signalType: string }
  | { kind: "blocked"; reason: string }
  | { kind: "done" };

function done(db: Database, ticketId: number, stepKey: string): boolean {
  return getByKey(db, ticketId, stepKey)?.status === "succeeded";
}

function step(
  stepKey: string,
  stepType: string,
  handlerKey: string,
  workUnitId: number | null,
): StepDescriptor {
  return { kind: "step", stepKey, stepType, handlerKey, workUnitId };
}

/** First unit (by seq) that still needs work (pending or verifying) and whose
 *  depends_on units are all verified. */
export function nextActionableUnit(db: Database, ticketId: number): workUnits.WorkUnitRow | null {
  const units = workUnits.listByTicket(db, ticketId);
  const verified = new Set(units.filter((u) => u.status === "verified").map((u) => u.seq));
  for (const u of units) {
    if (u.status !== "pending" && u.status !== "verifying") {
      continue;
    }
    if (workUnits.parseDependsOn(u).every((d) => verified.has(d))) {
      return u;
    }
  }
  return null;
}

/** The commit a unit's verification is currently judged against = the unit's latest coding
 *  attempt's branch head. Null if it hasn't been coded yet. */
function currentShaForUnit(db: Database, workUnitId: number): string | null {
  return getLatestByWorkUnit(db, workUnitId)?.branch_head_sha ?? null;
}

/** First declared check-type for the unit that has NOT RUN at the unit's current commit. `verify:check`
 *  is demoted to advisory (M4 §8b) — ANY recorded result (pass or fail) at the current sha satisfies
 *  routing, so a genuine suite failure never wedges the unit re-emitting forever. A result recorded
 *  against an older commit does not count (content-keyed re-verification). */
export function nextUnrunCheck(db: Database, unit: workUnits.WorkUnitRow): string | null {
  const sha = currentShaForUnit(db, unit.id);
  for (const check of workUnits.parseVerifyCheckTypes(unit)) {
    const ranShas = gts.ranShasFor(db, {
      ticketId: unit.ticket_id,
      workUnitId: unit.id,
      signalType: check,
    });
    const satisfied = sha !== null && ranShas.includes(sha);
    if (!satisfied) {
      return check;
    }
  }
  return null;
}

function allUnitsVerified(db: Database, ticketId: number): boolean {
  const units = workUnits.listByTicket(db, ticketId);
  return units.length > 0 && units.every((u) => u.status === "verified");
}

/** Pure resolver (control-loop §2.3): maps current SQLite state to the next action.
 *  Does NOT mutate — M2b's advance_one_step interprets the descriptor. */
export function nextStepKey(db: Database, ticketId: number): StepDescriptor {
  const ticket = getTicket(db, ticketId);
  if (!ticket) {
    throw new Error(`nextStepKey: ticket ${ticketId} not found`);
  }

  switch (ticket.stage) {
    case "design": {
      if (!done(db, ticketId, "design:dispatch")) {
        return step("design:dispatch", "dispatch", "design:dispatch", null);
      }
      if (workUnits.listByTicket(db, ticketId).length === 0) {
        return step("design:extract", "dispatch", "design:extract", null);
      }
      if (ticket.track === null) {
        return step("design:size", "dispatch", "design:size", null);
      }
      if (ticket.track === "full" && !done(db, ticketId, "design:review")) {
        return step("design:review", "dispatch", "design:review", null);
      }
      // Hoist: provision runs ONCE at design-HEAD (reused by implement — whose provision gates stay,
      // finding it done and skipping; resetProvisionIfManifestTouched still re-arms it, §2).
      if (!done(db, ticketId, "provision")) {
        return step("provision", "provision", "provision", null);
      }
      if (!done(db, ticketId, "checks:dispatch")) {
        return step("checks:dispatch", "dispatch", "checks:dispatch", null);
      }
      if (!done(db, ticketId, "checks:classify")) {
        return step("checks:classify", "dispatch", "checks:classify", null);
      }
      return { kind: "advance", from: "design", to: "implement" };
    }

    case "implement": {
      const u = nextActionableUnit(db, ticketId);
      if (u) {
        if (u.status === "pending") {
          return step(`implement:wu${u.seq}:dispatch`, "dispatch", "implement:dispatch", u.id);
        }
        // verifying
        if (!done(db, ticketId, "provision")) {
          return step("provision", "provision", "provision", null);
        }
        if (!done(db, ticketId, `completeness:wu${u.seq}`)) {
          return step(`completeness:wu${u.seq}`, "completeness", "completeness", u.id);
        }
        const check = nextUnrunCheck(db, u);
        if (check !== null) {
          return step(`verify:wu${u.seq}:${check}`, "verify", "verify:check", u.id);
        }
        return { kind: "mark-verified", workUnitId: u.id };
      }
      if (allUnitsVerified(db, ticketId)) {
        const branchSha = getLatestForTicket(db, ticketId)?.branch_head_sha ?? null;
        const gateHasChecks = listAcChecks(db, ticketId).length > 0; // active checks only
        if (gateHasChecks) {
          const gatePassedShas = gts.passingShasFor(db, {
            ticketId,
            workUnitId: null,
            signalType: "ac-check-gate",
          });
          if (branchSha === null || !gatePassedShas.includes(branchSha)) {
            // M5: the gate already ran at this sha and left behavioral still-red, and the arbiter has
            // not judged this round → serve the arbiter (it may re-author check-wrong checks). The
            // integrity-only fail path never reaches here (its verdict loops back, resetting the gate).
            const behavioral =
              branchSha !== null && gts.behavioralStillRed(db, ticketId, branchSha).length > 0;
            const blamed = branchSha !== null && gts.blameShasFor(db, ticketId).includes(branchSha);
            if (behavioral && !blamed) {
              return step("checks:arbitrate", "dispatch", "checks:arbitrate", null);
            }
            if (!done(db, ticketId, "provision")) {
              return step("provision", "provision", "provision", null);
            }
            return step("verify:checks-gate", "verify", "verify:checks-gate", null);
          }
        }
        // M4 §8c: verify:integration is demoted to advisory — ran-at-sha (ANY recorded result),
        // not passingShasFor. Coupled with handlers.ts's throw removal (same commit): a handler that
        // records an advisory fail with no pass at HEAD would otherwise leave this gate re-emitting
        // forever against the journal replay (MAX_TRANSITIONS).
        const integrationRanShas = gts.ranShasFor(db, {
          ticketId,
          workUnitId: null,
          signalType: "integration",
        });
        if (branchSha === null || !integrationRanShas.includes(branchSha)) {
          if (!done(db, ticketId, "provision")) {
            return step("provision", "provision", "provision", null);
          }
          return step("verify:integration", "verify", "verify:integration", null);
        }
        if (ticket.needs_docs === 1 && !done(db, ticketId, "docs:revise")) {
          return step("docs:revise", "dispatch", "docs:revise", null);
        }
        return { kind: "advance", from: "implement", to: "review" };
      }
      return { kind: "blocked", reason: "no actionable unit and not all units verified" };
    }

    case "review": {
      if (!done(db, ticketId, "review")) {
        return step("review", "dispatch", "review", null);
      }
      return { kind: "advance", from: "review", to: "merge" };
    }

    case "merge": {
      if (!done(db, ticketId, "merge:push")) {
        return step("merge:push", "project", "merge:push", null);
      }
      if (!done(db, ticketId, "merge:pr-ensure")) {
        return step("merge:pr-ensure", "project", "merge:pr-ensure", null);
      }
      if (!hasDelivered(db, ticketId, "external_checks")) {
        return { kind: "wait", signalType: "external_checks" };
      }
      if (!hasDelivered(db, ticketId, "human_merge_approval")) {
        return { kind: "wait", signalType: "human_merge_approval" };
      }
      return { kind: "advance", from: "merge", to: "released" };
    }

    case "released": {
      if (!done(db, ticketId, "released:project")) {
        return step("released:project", "project", "released:project", null);
      }
      return { kind: "done" };
    }

    default:
      throw new Error(`nextStepKey: unknown stage '${ticket.stage}'`);
  }
}

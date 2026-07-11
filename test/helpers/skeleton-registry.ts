import { StepRegistry } from "../../src/daemon/step-registry.ts";
import type { HandlerContext } from "../../src/daemon/step-registry.ts";
import {
  completeDispatch,
  getLatestByWorkUnit,
  getLatestForTicket,
  insertDispatch,
  nextSeq,
} from "../../src/db/repos/dispatch.ts";
import { insertSignal } from "../../src/db/repos/ground-truth-signal.ts";
import { setTicketTrack } from "../../src/db/repos/ticket.ts";
import { insertWorkUnit, setStatus as setUnitStatus } from "../../src/db/repos/work-unit.ts";

/** Mock handlers that write exactly the state a real handler would, so the resolver
 *  can route a fast-track ticket design→released. No real dispatch/verify/projector. */
export function skeletonRegistry(): StepRegistry {
  const r = new StepRegistry();
  r.register("design:dispatch", () => ({ plan: "ok" }));
  r.register("design:extract", (ctx: HandlerContext) => {
    insertWorkUnit(ctx.db, {
      ticketId: ctx.ticket.id,
      seq: 1,
      kind: "backend",
      verifyCheckTypes: ["test"],
    });
    setTicketTrack(ctx.db, ctx.ticket.id, "fast");
    return { units: 1 };
  });
  r.register("checks:dispatch", () => ({ authored: 0 }));
  r.register("checks:classify", () => ({ classified: 0 }));
  r.register("implement:dispatch", (ctx: HandlerContext) => {
    if (ctx.workUnitId !== null) {
      setUnitStatus(ctx.db, ctx.workUnitId, "verifying");
      // Record a coding attempt with a branch_head_sha so verify:check can stamp its signals
      // at the current commit (content-keyed re-verification)
      const d = insertDispatch(ctx.db, {
        ticketId: ctx.ticket.id,
        dispatchId: `${ctx.ticket.ident}-wud${ctx.workUnitId}`,
        seq: nextSeq(ctx.db, ctx.ticket.id),
        workUnitId: ctx.workUnitId,
      });
      completeDispatch(ctx.db, d.id, { outcome: "clean-success", branchHeadSha: "sha-skeleton" });
    }
    return { code: "ok" };
  });
  r.register("provision", () => ({ ok: true }));
  r.register("completeness", () => ({ ok: true }));
  r.register("verify:check", (ctx: HandlerContext) => {
    const check = ctx.step.step_key.split(":").pop() ?? "test";
    // Stamp the PASS signal at the unit's current commit SHA (content-keyed)
    const sha =
      ctx.workUnitId !== null
        ? (getLatestByWorkUnit(ctx.db, ctx.workUnitId)?.branch_head_sha ?? null)
        : null;
    insertSignal(ctx.db, {
      ticketId: ctx.ticket.id,
      workUnitId: ctx.workUnitId,
      signalType: check,
      result: "pass",
      branchHeadSha: sha ?? undefined,
    });
    return { check };
  });
  r.register("verify:integration", (ctx: HandlerContext) => {
    // Record a ticket-level dispatch with a branch_head_sha so the integration gate can match
    const d = insertDispatch(ctx.db, {
      ticketId: ctx.ticket.id,
      dispatchId: `${ctx.ticket.ident}-int${Date.now()}`,
      seq: nextSeq(ctx.db, ctx.ticket.id),
    });
    completeDispatch(ctx.db, d.id, { outcome: "clean-success", branchHeadSha: "sha-skeleton" });
    // Stamp the integration PASS at the branch's current SHA
    const sha = getLatestForTicket(ctx.db, ctx.ticket.id)?.branch_head_sha ?? null;
    insertSignal(ctx.db, {
      ticketId: ctx.ticket.id,
      signalType: "integration",
      result: "pass",
      branchHeadSha: sha ?? undefined,
    });
    return { integration: "pass" };
  });
  r.register("review", () => ({ findings: 0 }));
  r.register("merge:push", () => ({ sha: "abc123" }));
  r.register("merge:pr-ensure", () => ({ pr: 1 }));
  r.register("released:project", () => ({ released: true }));
  return r;
}

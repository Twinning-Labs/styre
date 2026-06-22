import type { Database } from "bun:sqlite";
import { z } from "zod";
import { appendEvent } from "../db/repos/event-log.ts";
import {
  type OutboxRow,
  bumpAttempt,
  enqueue,
  listPending,
  markFailed,
  markSent,
} from "../db/repos/projection-outbox.ts";
import { insertPending as insertSignal, recordDelivered } from "../db/repos/signal.ts";
import { getTicket, setTicketStatus } from "../db/repos/ticket.ts";
import type { ChecksPort } from "../integrations/checks.ts";
import type { ForgePort } from "../integrations/forge.ts";
import type { IssueState, IssueTrackerPort } from "../integrations/issue-tracker.ts";

const PushPayload = z.object({ branch: z.string(), sha: z.string() });
const PrCreatePayload = z.object({
  branch: z.string(),
  base: z.string(),
  title: z.string(),
  body: z.string(),
});
const PrCommentPayload = z.object({ prRef: z.string(), body: z.string() });

export const OUTBOX_RETRY_BUDGET = 5;

const STAGE_STATE: Record<string, IssueState> = {
  design: "in_progress",
  implement: "in_progress",
  verify: "in_progress",
  review: "in_review",
  merge: "in_review",
  released: "done",
};

export function stageToState(stage: string): IssueState {
  return STAGE_STATE[stage] ?? "in_progress";
}

/** Enqueue the issue-tracker projection for a stage transition (projector §3): a mapped set_state
 *  and a stage-label swap. Deterministic keys → re-enqueue is a no-op (idempotent). MUST be called
 *  inside the same transaction as the stage change (advance.ts). */
export function enqueueStageProjection(
  db: Database,
  ticket: { id: number; ident: string },
  from: string,
  to: string,
): void {
  enqueue(db, {
    ticketId: ticket.id,
    target: "issue_tracker",
    op: "set_state",
    payload: { state: stageToState(to) },
    idempotencyKey: `${ticket.ident}:set_state:${to}`,
  });
  enqueue(db, {
    ticketId: ticket.id,
    target: "issue_tracker",
    op: "set_labels",
    payload: { add: [`stage:${to}`], remove: [`stage:${from}`] },
    idempotencyKey: `${ticket.ident}:set_labels:${from}->${to}`,
  });
}

export interface ProjectorPorts {
  issueTracker: IssueTrackerPort;
  forge?: ForgePort;
  checks?: ChecksPort;
}

/** Apply one outbox row to the configured port by NEUTRAL ROLE (never a vendor name). Returns the
 *  response ref (e.g. a comment id) or null. Throws on a transient external failure (the drainer
 *  retries/escalates). */
async function applyRow(
  db: Database,
  row: OutboxRow,
  ports: ProjectorPorts,
): Promise<string | null> {
  const ticket = getTicket(db, row.ticket_id);
  if (!ticket) {
    throw new Error(`projector: ticket ${row.ticket_id} not found`);
  }
  const ref = ticket.ident; // the issue ref the adapter resolves (e.g. "ENG-1")
  const payload =
    row.payload_json === null ? {} : (JSON.parse(row.payload_json) as Record<string, unknown>);

  if (row.target === "issue_tracker") {
    const it = ports.issueTracker;
    switch (row.op) {
      case "set_state":
        await it.setState(ref, payload.state as IssueState);
        return null;
      case "set_labels":
        await it.setLabels(ref, payload as { add: string[]; remove: string[] });
        return null;
      case "add_comment":
        return await it.addComment(ref, payload.body as string, row.idempotency_key);
      default:
        throw new Error(`projector: unknown issue_tracker op '${row.op}'`);
    }
  }
  if (row.target === "forge") {
    if (!ports.forge) {
      throw new Error("projector: forge outbox row but no forge port configured");
    }
    const f = ports.forge;
    switch (row.op) {
      case "push":
        await f.push(PushPayload.parse(payload));
        return null;
      case "pr_create": {
        const pr = await f.ensurePr(PrCreatePayload.parse(payload));
        // The drainer delivers external_pr_result (control-loop §7): the durable PR-ref record the
        // deferred human-merge poll consumes. A data-carrier — recorded delivered, never pending.
        recordDelivered(db, {
          ticketId: row.ticket_id,
          signalType: "external_pr_result",
          payload: { ref: pr.ref, url: pr.url },
          idempotencyKey: `${ticket.ident}:pr_result`,
        });
        return pr.ref; // → response_ref (the PR#)
      }
      case "pr_comment": {
        const c = PrCommentPayload.parse(payload);
        return await f.addPrComment(c.prRef, c.body, row.idempotency_key);
      }
      default:
        throw new Error(`projector: unknown forge op '${row.op}'`);
    }
  }
  throw new Error(`projector: no adapter for target '${row.target}'`);
}

/** Park the ticket and tell the operator the external service is down (projector §7, atlas X1).
 *  Mirrors the escalate idiom in failure-policy.ts: setTicketStatus → insertSignal → appendEvent,
 *  all in one transaction. A projection failure never blocks the loop — the row is failed durably;
 *  control flow runs on. */
function escalateProjection(db: Database, ticketId: number, reason: string): void {
  db.transaction(() => {
    setTicketStatus(db, ticketId, "waiting");
    insertSignal(db, { ticketId, signalType: "human_resume", reason });
    appendEvent(db, { ticketId, kind: "escalated", reason });
  })();
}

/** Drain pending outbox rows in FIFO order, applying each idempotently. A transient failure bumps
 *  attempts (retried next drain); past the budget the row is failed and the ticket escalated. A
 *  projection failure NEVER throws out of this loop — the loop continues and never blocks control flow. */
export async function drainOutbox(
  db: Database,
  ports: ProjectorPorts,
  opts?: { retryBudget?: number },
): Promise<{ sent: number; failed: number }> {
  const budget = opts?.retryBudget ?? OUTBOX_RETRY_BUDGET;
  let sent = 0;
  let failed = 0;
  for (const row of listPending(db)) {
    try {
      const ref = await applyRow(db, row, ports);
      markSent(db, row.id, ref);
      sent += 1;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (row.attempts + 1 >= budget) {
        markFailed(db, row.id, message);
        escalateProjection(db, row.ticket_id, `projection failing: ${message}`);
        failed += 1;
      } else {
        bumpAttempt(db, row.id, message);
      }
    }
  }
  return { sent, failed };
}

import type { Database } from "bun:sqlite";
import type { RuntimeConfig } from "../config/runtime-config.ts";
import { type EventLogRow, listByTicketSince } from "../db/repos/event-log.ts";
import { enqueue } from "../db/repos/projection-outbox.ts";
import { getDeliveredPayload } from "../db/repos/signal.ts";
import { getTicket } from "../db/repos/ticket.ts";
import type { NotificationMessage, NotifySeverity } from "../integrations/notifier.ts";

type Policy = RuntimeConfig["notify"];
const RANK: Record<Policy, number> = { escalations: 0, transitions: 1, everything: 2 };

/** Map an event_log kind → (severity, label) under the policy, or null if it shouldn't notify. */
function eventDecision(
  e: EventLogRow,
  policy: Policy,
): { severity: NotifySeverity; label: string } | null {
  switch (e.kind) {
    case "escalated":
      return { severity: "high", label: "escalated" };
    case "parked":
      return { severity: "high", label: "parked" };
    case "transition":
      return RANK[policy] >= 1
        ? { severity: "info", label: `${e.from_stage ?? "?"}→${e.to_stage ?? "?"}` }
        : null;
    case "loopback":
      return RANK[policy] >= 2 ? { severity: "info", label: "loopback" } : null;
    default:
      return null; // resumed, note
  }
}

/** Map a terminal outcome → (severity, event) or null. `blocked`/`parked` are intentionally null:
 *  their notification already went out as a swept event (`escalated`/`parked`); the rare dead-end
 *  `blocked` is exit-code-only for v1 (deferred, to avoid double-notifying escalation-blocked). */
function terminalDecision(outcome: string): { severity: NotifySeverity; event: string } | null {
  switch (outcome) {
    case "pr-ready":
      return { severity: "success", event: "PR ready to merge" };
    case "done":
      return { severity: "success", event: "released" };
    case "no-progress":
      return { severity: "high", event: "gave up (no progress)" };
    default:
      return null; // blocked, parked
  }
}

/** Sibling of the telemetry emitter (src/telemetry/emitter.ts): a per-tick event sweep with a
 *  monotonic watermark + a drive-end terminal enqueue. Both ENQUEUE notify outbox rows (the projector
 *  drain delivers them). Idempotency keyed on event `seq` / terminal outcome. No-op when disabled. */
export function createNotifier(config: RuntimeConfig): {
  sweepNew(db: Database, ticketId: number): void;
  notifyTerminal(db: Database, ticketId: number, outcome: string): void;
} {
  let lastEventSeq = 0;
  const enabled = config.notifier !== "none";

  const buildMsg = (
    db: Database,
    ticketId: number,
    event: string,
    severity: NotifySeverity,
    reason?: string,
  ): NotificationMessage => {
    const t = getTicket(db, ticketId);
    const pr = getDeliveredPayload(db, ticketId, "external_pr_result");
    const prUrl = typeof pr?.url === "string" ? pr.url : undefined;
    return {
      ticketIdent: t?.ident ?? String(ticketId),
      event,
      severity,
      reason,
      ticketTitle: t?.title ?? undefined,
      prUrl,
    };
  };

  const post = (db: Database, ticketId: number, key: string, msg: NotificationMessage): void => {
    enqueue(db, { ticketId, target: "notify", op: "post", payload: msg, idempotencyKey: key });
  };

  return {
    sweepNew(db, ticketId) {
      if (!enabled) return;
      for (const e of listByTicketSince(db, ticketId, lastEventSeq)) {
        lastEventSeq = e.seq;
        const d = eventDecision(e, config.notify);
        if (!d) continue;
        post(
          db,
          ticketId,
          `notify:${ticketId}:evt:${e.seq}`,
          buildMsg(db, ticketId, d.label, d.severity, e.reason ?? undefined),
        );
      }
    },
    notifyTerminal(db, ticketId, outcome) {
      if (!enabled) return;
      const d = terminalDecision(outcome);
      if (!d) return;
      post(
        db,
        ticketId,
        `notify:${ticketId}:term:${outcome}`,
        buildMsg(db, ticketId, d.event, d.severity),
      );
    },
  };
}

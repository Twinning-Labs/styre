import type { Database } from "bun:sqlite";
import * as signals from "../db/repos/signal.ts";
import { setTicketStatus } from "../db/repos/ticket.ts";

/** Park a ticket on a durable signal (control-loop §7): insert a pending signal and
 *  set ticket.status='waiting' so it leaves the ready set (no busy-wait). Idempotent:
 *  reuses an existing pending signal of the same type. */
export function awaitSignal(
  db: Database,
  p: { ticketId: number; signalType: string; reason?: string; idempotencyKey?: string | null },
): signals.SignalRow {
  const tx = db.transaction(() => {
    const existing = signals
      .listPending(db, p.ticketId)
      .find((s) => s.signal_type === p.signalType);
    const signal = existing ?? signals.insertPending(db, p);
    setTicketStatus(db, p.ticketId, "waiting");
    return signal;
  });
  return tx();
}

/** Deliver a signal out-of-band (control-loop §7.3): mark delivered + un-park the ticket. */
export function deliverSignal(
  db: Database,
  signalId: number,
  payload?: unknown,
): signals.SignalRow {
  const tx = db.transaction(() => {
    signals.markDelivered(db, signalId, payload);
    const sig = signals.getById(db, signalId);
    if (!sig) {
      throw new Error(`deliverSignal: signal ${signalId} not found`);
    }
    setTicketStatus(db, sig.ticket_id, "active");
    return sig;
  });
  return tx();
}

/** Consume a delivered signal — the parked await step then succeeds. */
export function consumeSignal(db: Database, signalId: number): signals.SignalRow {
  signals.markConsumed(db, signalId);
  const sig = signals.getById(db, signalId);
  if (!sig) {
    throw new Error(`consumeSignal: signal ${signalId} not found`);
  }
  return sig;
}

import type { Database } from "bun:sqlite";
import { getLatestForTicket } from "../db/repos/dispatch.ts"; // the current branch HEAD sha source used by the resolver
import { appendEvent, listByTicket as listEvents } from "../db/repos/event-log.ts";
import { latestBlameAtSha, latestReauthorAtSha } from "../db/repos/ground-truth-signal.ts";
import { latestDispatchForStep } from "../db/repos/review-finding.ts";
import { insertPending as insertSignal } from "../db/repos/signal.ts";
import { setTicketStatus } from "../db/repos/ticket.ts";
import { getByKey, resetToPending } from "../db/repos/workflow-step.ts";
import { type GateVerdictResult, gateOriginLoopback } from "./checks-gate-verdict.ts";

/** §6: the monotone per-ticket gate-round bound = the verify:checks-gate step attempt. Escalate at
 *  the cap. See the plan's "Flagged for the lead #3" for the value. */
export const GATE_ROUND_CAP = 3;

export function gateRoundExceeded(db: Database, ticketId: number, cap: number): boolean {
  const gate = getByKey(db, ticketId, "verify:checks-gate");
  return (gate?.attempt ?? 0) >= cap;
}

/** LIVENESS (an Opus review of Task 5 flagged this): a stuck-HEAD re-implement — the coding attempt
 *  commits NOTHING new (`commitWorktree` returns the unchanged sha) — leaves `branchSha` identical
 *  round over round. The resolver's blamed-fallback arm (`blamed && !done("checks:reauthor")`) then
 *  re-serves checks:reauthor at that SAME sha every cycle, without ever falling through to
 *  verify:checks-gate (its `attempt` never increments, since `behavioralStillRed`/`blameShasFor`
 *  already have a stale hit at that sha, short-circuiting past the gate's own re-serve). `gateRoundExceeded`
 *  (keyed to verify:checks-gate's attempt) therefore never trips — a livelock, not a bounded retry.
 *  `checks:reauthor`'s OWN attempt, in contrast, increments every time the resolver actually SERVES it
 *  (`markRunning`), independent of whether HEAD ever moves — `resetToPending` (called by
 *  `gateOriginLoopback` on every re-arm) never touches attempt, so it survives across cycles exactly
 *  like the gate's counter does. Checking it too makes the cap reachable from the blame-at-HEAD path,
 *  not only from a fresh arbiter round that actually re-runs the gate. */
function reauthorRoundExceeded(db: Database, ticketId: number, cap: number): boolean {
  const reauthor = getByKey(db, ticketId, "checks:reauthor");
  return (reauthor?.attempt ?? 0) >= cap;
}

/** onSucceed of checks:arbitrate. Routes on the blame recorded at the current gate round + the
 *  gate-round counter. Task 5 (arbitration-only): both routes loopback implement. Task 6 rewires the
 *  check-wrong route to loop back to the SEPARATE checks:reauthor step (which installs the re-authors,
 *  then its own verdict re-serves the gate or loops implement). */
export function applyArbiterVerdict(
  db: Database,
  ticketId: number,
  opts: { stepKey: string },
): GateVerdictResult {
  const dispatchId = latestDispatchForStep(db, ticketId, opts.stepKey);
  const sha = getLatestForTicket(db, ticketId)?.branch_head_sha ?? null;
  const blames = sha === null ? [] : latestBlameAtSha(db, ticketId, sha);
  if (blames.length === 0) return { decision: "clean" }; // nothing to route (no-op guard)

  if (gateRoundExceeded(db, ticketId, GATE_ROUND_CAP)) {
    db.transaction(() => {
      setTicketStatus(db, ticketId, "waiting");
      insertSignal(db, {
        ticketId,
        signalType: "human_resume",
        reason: `gate: still red after ${GATE_ROUND_CAP} arbitrated rounds (${blames.map((b) => `${b.acCheckId}:${b.blame}`).join(", ")})`,
      });
      appendEvent(db, {
        ticketId,
        dispatchId: dispatchId ?? undefined,
        kind: "escalated",
        reason: "gate-round cap",
        signature: `gate-cap:${GATE_ROUND_CAP}`,
      });
    })();
    return { decision: "escalated" };
  }

  const anyCheckWrong = blames.some((b) => b.blame === "check-wrong");
  if (anyCheckWrong) {
    // Mixed OR pure check-wrong → the re-authors must be installed before any implement loop, so route
    // to the SEPARATE checks:reauthor step (M3 shape: classify→dispatch). Its verdict then loops
    // implement (mixed / any rejected) or re-serves the gate (pure check-wrong all installed). Reset
    // reauthor + arbitrate to pending (counter untouched — resetToPending never changes attempt);
    // carry the check-wrong ACs + round sha in the payload (scopes the reauthor step + keys its verdict).
    //
    // FIX I1: loop label is "reauthor", DELIBERATELY NOT "checks". The payload shape ({acIds}) is
    // identical to M3's design-stage checks:dispatch re-author loopback, and the legacy design-stage
    // readers latestChecksReauthorAcs (checks-verdict.ts) + checksFeedback (checks-feedback.ts) both
    // select the LATEST loop==="checks" event with NO route_to filter — same label would let a future
    // design-stage re-entry silently pick up THIS M5 event's acIds as its own re-author scope. A
    // distinct label closes that cross-wiring trap by construction; do not rename this back to "checks".
    const checkWrongAcs = blames.filter((b) => b.blame === "check-wrong").map((b) => b.acId);
    db.transaction(() => {
      for (const key of ["checks:reauthor", "checks:arbitrate"]) {
        const s = getByKey(db, ticketId, key);
        if (s) resetToPending(db, s.id);
      }
      appendEvent(db, {
        ticketId,
        dispatchId: dispatchId ?? undefined,
        kind: "loopback",
        loop: "reauthor",
        routeTo: "checks:reauthor",
        signature: `arbiter:${checkWrongAcs.join(",")}`,
        payload: { acIds: checkWrongAcs, sha },
      });
    })();
    return { decision: "loopback" };
  }

  // Pure code-wrong (no check-wrong) → loopback implement now (no re-author needed this round).
  gateOriginLoopback(
    db,
    ticketId,
    "checks:arbitrate",
    {
      blame: blames.map((b) => ({ acCheckId: b.acCheckId, blame: b.blame })),
    },
    dispatchId,
  );
  return { decision: "loopback" };
}

/** The check-wrong ACs + round sha the arbiter last routed to checks:reauthor (payload of its
 *  `loop:"reauthor" routeTo:"checks:reauthor"` loopback event). Mirrors checks-verdict.ts's
 *  latestChecksReauthorAcs in shape (same `{acIds}` payload), but on a DISTINCT `loop:"reauthor"`
 *  label (FIX I1) — NOT `loop:"checks"`. latestChecksReauthorAcs (checks-verdict.ts) and checksFeedback
 *  (checks-feedback.ts) both select the latest `loop==="checks"` event with NO route_to filter; had
 *  this route also used `loop:"checks"`, a future design-stage checks:dispatch re-entry could silently
 *  pick up THIS event's acIds as its own re-author scope (same payload shape, different meaning). The
 *  distinct label makes that impossible by construction — do not rename this back to "checks". Null
 *  when no such event exists / the payload is empty. */
export function latestReauthorRoute(
  db: Database,
  ticketId: number,
): { acIds: number[]; sha: string } | null {
  const events = listEvents(db, ticketId).filter(
    (e) => e.kind === "loopback" && e.loop === "reauthor" && e.route_to === "checks:reauthor",
  );
  const latest = events[events.length - 1];
  if (!latest?.payload_json) return null;
  const p = JSON.parse(latest.payload_json) as { acIds?: number[]; sha?: string };
  if (!p.acIds || p.acIds.length === 0 || !p.sha) return null;
  return { acIds: p.acIds, sha: p.sha };
}

/** onSucceed of checks:reauthor. Routes on the ROUND's blame (code-wrong presence) + the re-author
 *  dispositions the handler recorded — keyed to the arbiter's round sha (read from the reauthor
 *  loopback event, NOT getLatestForTicket: the author dispatch moved HEAD). §5 + operator call #5:
 *  any code-wrong in the round OR any rejected re-author → loopback implement (installed re-authors
 *  persist); pure check-wrong all installed → re-serve the gate at the re-author HEAD (no re-code). */
export function applyReauthorVerdict(
  db: Database,
  ticketId: number,
  opts: { stepKey: string },
): GateVerdictResult {
  const dispatchId = latestDispatchForStep(db, ticketId, opts.stepKey);
  const route = latestReauthorRoute(db, ticketId);
  if (route === null) return { decision: "clean" }; // nothing routed (no-op guard)
  const blames = latestBlameAtSha(db, ticketId, route.sha);
  const dispositions = latestReauthorAtSha(db, ticketId, route.sha);

  // LIVENESS: also check checks:reauthor's OWN attempt (see reauthorRoundExceeded's docstring) — the
  // stuck-HEAD path never re-runs verify:checks-gate, so gateRoundExceeded alone would livelock.
  if (
    gateRoundExceeded(db, ticketId, GATE_ROUND_CAP) ||
    reauthorRoundExceeded(db, ticketId, GATE_ROUND_CAP)
  ) {
    db.transaction(() => {
      setTicketStatus(db, ticketId, "waiting");
      insertSignal(db, {
        ticketId,
        signalType: "human_resume",
        reason: `gate: still red after ${GATE_ROUND_CAP} arbitrated rounds (re-author of AC(s) ${route.acIds.join(",")})`,
      });
      appendEvent(db, {
        ticketId,
        dispatchId: dispatchId ?? undefined,
        kind: "escalated",
        reason: "gate-round cap",
        signature: `gate-cap:${GATE_ROUND_CAP}`,
      });
    })();
    return { decision: "escalated" };
  }

  const anyCodeWrong = blames.some((b) => b.blame === "code-wrong");
  const anyRejected = dispositions.some((d) => d.disposition === "rejected");
  const anyInstalled = dispositions.some((d) => d.disposition === "installed");

  if (anyCodeWrong || anyRejected) {
    // Mixed (code-wrong also present) OR a rejected re-author → re-code. gateOriginLoopback resets
    // units + gate + arbitrate + reauthor; the installed re-authors persist (supersede+insert already
    // committed) and re-run next gate round.
    gateOriginLoopback(
      db,
      ticketId,
      "checks:reauthor",
      {
        codeWrong: anyCodeWrong,
        rejected: anyRejected,
      },
      dispatchId,
    );
    return { decision: "loopback" };
  }
  if (anyInstalled) {
    // Pure check-wrong, all installed: the code was right, the checks were wrong. Re-run the gate at
    // the re-author HEAD WITHOUT re-coding — reset the gate + arbiter, leave units verified + reauthor
    // succeeded (blamed at the new HEAD is false, so the resolver serves the gate next).
    db.transaction(() => {
      for (const key of ["verify:checks-gate", "checks:arbitrate"]) {
        const s = getByKey(db, ticketId, key);
        if (s) resetToPending(db, s.id);
      }
      // This event's loop label is "checks" (unlike the arbiter→reauthor route above, which uses
      // "reauthor" — FIX I1) but it is NOT the cross-wiring trap: it carries no `payload` (no `acIds`),
      // so even if a future design-stage `latestChecksReauthorAcs`/`checksFeedback` read picked it up
      // as "latest checks-loop event", both readers treat a payload-less event as "no re-author scope"
      // (identical to no event at all) — a no-op, never a false acIds match. Do not add an `acIds`
      // payload to this event without first renaming its loop label off "checks".
      appendEvent(db, {
        ticketId,
        dispatchId: dispatchId ?? undefined,
        kind: "loopback",
        loop: "checks",
        routeTo: "verify:checks-gate",
        signature: "gate:reauthored",
      });
    })();
    return { decision: "loopback" };
  }
  return { decision: "clean" }; // no dispositions at all (defensive; the resolver re-serves the gate)
}

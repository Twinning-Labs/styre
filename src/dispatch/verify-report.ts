import type { Database } from "bun:sqlite";
import { listByTicket as listAcs } from "../db/repos/acceptance-criterion.ts";
import { listActiveByTicket as listActiveChecks } from "../db/repos/ac-check.ts";
import { getLatestForTicket } from "../db/repos/dispatch.ts";
import {
  advisorySweeps,
  postImplementAtSha,
  reauthorProvenance,
} from "../db/repos/ground-truth-signal.ts";

export type AcLabel =
  | "verified"
  | "satisfied"
  | "not-expressible"
  | "environmental"
  | "still-red"
  | "check-unreplaced"
  | "no-check";

export type AcLine = { seq: number; text: string; label: AcLabel };

export type AdvisoryLine =
  | { kind: "suite"; checkType: string; result: string; firstFailingJob?: string }
  | { kind: "integration"; result: string; firstFailingJob?: string }
  | { kind: "environmental-red"; seq: number };

export type ProvenanceLine = { seq: number; disposition: "installed" | "rejected"; reason: string };

export type VerifyReport = {
  criteria: AcLine[];
  advisory: AdvisoryLine[];
  provenance: ProvenanceLine[];
  allClean: boolean;
};

/** Read the M3/M4/M5 records for `ticketId` and roll them up per-AC. Pure read — no control-flow
 *  effect, no recompute (design §2/§8). Green-ness/advisory/provenance sourced from Task-1 readers. */
export function buildVerifyReport(db: Database, ticketId: number): VerifyReport {
  const acs = listAcs(db, ticketId); // ORDER BY seq
  const checks = listActiveChecks(db, ticketId); // superseded_at IS NULL
  const headSha = getLatestForTicket(db, ticketId)?.branch_head_sha ?? null;
  const postImpl = headSha ? postImplementAtSha(db, ticketId, headSha) : new Map();
  const prov = reauthorProvenance(db, ticketId);
  const sweeps = advisorySweeps(db, ticketId);

  const rejectedCheckIds = new Set(
    prov.filter((p) => p.disposition === "rejected").map((p) => p.acCheckId),
  );
  const seqByAcId = new Map(acs.map((a) => [a.id, a.seq]));

  const criteria: AcLine[] = [];
  const advisory: AdvisoryLine[] = [];

  for (const ac of acs) {
    const mine = checks.filter((c) => c.ac_id === ac.id);
    let label: AcLabel;
    if (mine.length === 0) {
      label = "no-check";
    } else if (mine.some((c) => rejectedCheckIds.has(c.id))) {
      label = "check-unreplaced"; // C1 — a wrong-shape check left active; never verified
    } else {
      const gating = mine.filter((c) => c.red_class === "assertion" || c.red_class === "absence");
      if (gating.length > 0) {
        const allGreen = gating.every((c) => postImpl.get(c.id)?.coarse === "green");
        label = allGreen ? "verified" : "still-red";
      } else if (mine.some((c) => c.disposition === "not-expressible")) {
        label = "not-expressible";
      } else if (mine.some((c) => c.red_class === "environmental")) {
        label = "environmental";
      } else if (mine.some((c) => c.disposition === "satisfied")) {
        label = "satisfied";
      } else {
        label = "still-red"; // defensive: a check exists but is unclassified — never over-claim
      }
    }
    criteria.push({ seq: ac.seq, text: ac.text, label });

    // Environmental-still-red caveats (one per AC), regardless of the headline label.
    const envRed = mine.some(
      (c) => c.red_class === "environmental" && postImpl.get(c.id)?.coarse !== "green",
    );
    if (envRed) advisory.push({ kind: "environmental-red", seq: ac.seq });
  }

  for (const s of sweeps) {
    if (s.type === "integration") {
      advisory.push({ kind: "integration", result: s.result, firstFailingJob: s.firstFailingJob });
    } else {
      advisory.push({
        kind: "suite",
        checkType: s.type,
        result: s.result,
        firstFailingJob: s.firstFailingJob,
      });
    }
  }

  // One provenance line per AC — a multi-round AC has several acCheckId generations in `prov`; keep the
  // newest generation (highest acCheckId, AUTOINCREMENT-monotonic) so the section shows one line per AC
  // (design §3, review finding M-1).
  const provByAc = new Map<number, { acCheckId: number; line: ProvenanceLine }>();
  for (const p of prov) {
    const seq = seqByAcId.get(p.acId);
    if (seq === undefined) continue;
    const cur = provByAc.get(p.acId);
    if (!cur || p.acCheckId > cur.acCheckId) {
      provByAc.set(p.acId, {
        acCheckId: p.acCheckId,
        line: { seq, disposition: p.disposition, reason: p.reason },
      });
    }
  }
  const provenance: ProvenanceLine[] = [...provByAc.values()]
    .map((v) => v.line)
    .sort((a, b) => a.seq - b.seq);

  const allClean =
    criteria.length > 0 &&
    criteria.every((c) => c.label === "verified" || c.label === "satisfied") &&
    advisory.length === 0;

  return { criteria, advisory, provenance, allClean };
}

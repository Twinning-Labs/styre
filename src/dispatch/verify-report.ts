import type { Database } from "bun:sqlite";
import { listActiveByTicket as listActiveChecks } from "../db/repos/ac-check.ts";
import { listByTicket as listAcs } from "../db/repos/acceptance-criterion.ts";
import { getLatestForTicket } from "../db/repos/dispatch.ts";
import {
  advisorySweeps,
  deliveredTestBinding,
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
  /** ENG-402: a behavioral unit shipped no test. The suite itself PASSED — the A1 gate in
   *  `handlers.ts` overwrites the result — so this must never be rendered as a suite failure. */
  | { kind: "behavioral-no-test"; checkType: string; component?: string; changed?: string[] }
  /** ENG-402: a test WAS delivered, but it already passed at the baseline — so it does not
   *  distinguish the two revisions and proves nothing about the change. */
  | {
      kind: "delivered-test-does-not-bind";
      checkType: string;
      component?: string;
      changed?: string[];
    }
  /** ENG-412: a component was excluded from the whole run because its toolchain is absent on
   *  this machine. The PR must say so — a narrowed scope that never leaves stderr is a silent
   *  one by the time anybody reviews the diff. */
  | { kind: "component-unusable"; components: string[]; missing: string[] }
  | { kind: "integration"; result: string; firstFailingJob?: string; preexisting?: boolean }
  | { kind: "environmental-red"; seq: number };

export type ProvenanceLine = { seq: number; disposition: "installed" | "rejected"; reason: string };

/** ENG-402: the delivered regression tests proven to fail at the baseline. Positive evidence —
 *  the reviewer should be able to see that the proof RAN, not only hear about it when it fails. */
export type BindingLine = { component: string; bound: string[] };

export type VerifyReport = {
  criteria: AcLine[];
  binding: BindingLine[];
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
  const binding = deliveredTestBinding(db, ticketId)
    .filter((b) => b.bound.length > 0)
    .map((b) => ({ component: b.component, bound: b.bound }));

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
      advisory.push({
        kind: "integration",
        result: s.result,
        firstFailingJob: s.firstFailingJob,
        ...(s.preexisting !== undefined ? { preexisting: s.preexisting } : {}),
      });
    } else if (s.reason === "delivered-test-does-not-bind") {
      advisory.push({
        kind: "delivered-test-does-not-bind",
        checkType: s.type,
        ...(s.component !== undefined ? { component: s.component } : {}),
        ...(s.changed !== undefined ? { changed: s.changed } : {}),
      });
    } else if (s.reason === "component-unusable") {
      advisory.push({
        kind: "component-unusable",
        components: s.components ?? [],
        missing: s.missing ?? [],
      });
    } else if (s.reason === "behavioral-no-test") {
      advisory.push({
        kind: "behavioral-no-test",
        checkType: s.type,
        ...(s.component !== undefined ? { component: s.component } : {}),
        ...(s.changed !== undefined ? { changed: s.changed } : {}),
      });
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

  return { criteria, binding, advisory, provenance, allClean };
}

/** Truncate an AC to one line and neutralize markdown/HTML so a crafted AC cannot break the list or
 *  inject markup into a cross-team PR body (design §5, review finding M3). */
function acText(raw: string): string {
  const oneLine = raw.replace(/\s+/g, " ").trim();
  const clipped = oneLine.length > 120 ? `${oneLine.slice(0, 117)}…` : oneLine;
  return clipped.replace(/</g, "&lt;").replace(/`/g, "'");
}

const SYMBOL: Record<AcLabel, string> = {
  verified: "✅",
  satisfied: "✅",
  "not-expressible": "⚪",
  environmental: "⚪",
  "still-red": "⚠️",
  "check-unreplaced": "⚠️",
  "no-check": "➖",
};

const EXPLAIN: Record<AcLabel, string> = {
  verified: "Confirmed by an automated test that failed before this change and passes now.",
  satisfied:
    "Already working before this change. An automated test found the behavior was already present, so this criterion needed no new code.",
  "not-expressible":
    "Could not be checked automatically — no reliable test could capture this criterion, so it was left to human code review instead.",
  environmental:
    'Could not be checked reliably — the automated check needs tooling or configuration that was not available here (an "environmental" check), so its result does not confirm the criterion. Please confirm by review.',
  "still-red":
    "The automated check for this criterion did not end in a passing state as expected. Please verify this one by review.",
  "check-unreplaced":
    "A check for this criterion was judged to not actually match it, and no correct replacement could be created. The criterion may show as passing without truly being met — please verify this one carefully by review.",
  "no-check": "No automated check was created for this criterion.",
};

function renderAdvisory(a: AdvisoryLine): string {
  if (a.kind === "integration") {
    const job = a.firstFailingJob ? ` (first failing job: \`${a.firstFailingJob}\`)` : "";
    const verb = a.result === "error" ? "did not complete" : "FAILED";
    // ENG-403: say whether this change caused it. Reporting a failure without that leaves the
    // reviewer unable to tell a regression from an already-broken repo — on
    // darkreader__darkreader-7241 `frontend:build` was failing before the change (an upstream
    // tslib/rollup-plugin-typescript2 incompatibility in the image) and the PR did not say so.
    if (a.preexisting === true) {
      return `- ⚠️ The full integration test run ${verb}${job} — but it ALSO ${verb.toLowerCase()} at the base commit, so this change did not cause it. Pre-existing; not used as a merge gate.`;
    }
    if (a.preexisting === false) {
      return `- ⚠️ The full integration test run ${verb}${job}, and it PASSED at the base commit — this change appears to have introduced it. Not used as a merge gate, so please look before merging.`;
    }
    return `- ⚠️ The full integration test run ${verb}${job}. Whether it was already failing before this change could not be established. This was not used as a merge gate.`;
  }
  if (a.kind === "delivered-test-does-not-bind") {
    const where = a.component ? ` in component \`${a.component}\`` : "";
    const files =
      a.changed && a.changed.length > 0
        ? ` (${a.changed
            .slice(0, 5)
            .map((f) => `\`${f}\``)
            .join(", ")}${a.changed.length > 5 ? ", …" : ""})`
        : "";
    return `- ⚠️ A test shipped with this change${where} already PASSED at the base commit${files}, so it does not prove the change does anything. The \`${a.checkType}\` suite itself passed. This was not used as a merge gate.`;
  }
  if (a.kind === "behavioral-no-test") {
    const where = a.component ? ` in component \`${a.component}\`` : "";
    const files =
      a.changed && a.changed.length > 0
        ? ` (${a.changed
            .slice(0, 5)
            .map((f) => `\`${f}\``)
            .join(", ")}${a.changed.length > 5 ? ", …" : ""})`
        : "";
    // The suite PASSED. Saying otherwise — as this line used to — puts a false statement about
    // the repo's own tests in front of the person deciding whether to merge.
    return `- ⚠️ A behavior change${where} shipped without a test of its own${files}. The \`${a.checkType}\` suite itself passed. This was not used as a merge gate.`;
  }
  if (a.kind === "component-unusable") {
    const comps = a.components.map((c) => `\`${c}\``).join(", ");
    const tools = [...new Set(a.missing)].map((m) => `\`${m}\``).join(", ");
    // State the SCOPE loss, not just the missing tool: the reviewer's question is "what did
    // styre not look at?", and answering only "npm was missing" leaves them to infer the rest.
    return `- ⚠️ Nothing was built, tested or checked for ${comps} — the required tooling (${tools}) is not installed on the machine this run used, so ${a.components.length === 1 ? "that component" : "those components"} ${a.components.length === 1 ? "was" : "were"} skipped entirely. Any change touching ${a.components.length === 1 ? "it" : "them"} is unverified.`;
  }
  if (a.kind === "suite") {
    return `- ⚠️ The \`${a.checkType}\` test suite did not pass (result: ${a.result}). This was not used as a merge gate.`;
  }
  return `- ⚠️ The automated check for AC-${a.seq} is still failing, but the failure looks environmental (for example, missing tooling or configuration) rather than something this change caused.`;
}

function renderBinding(b: BindingLine): string {
  const files = b.bound.map((f) => `\`${f}\``).join(", ");
  return `- ✅ ${b.component}: ${files} — checked out at the base commit and confirmed to FAIL there, so ${b.bound.length === 1 ? "it proves" : "they prove"} this change does something.`;
}

/** ENG-412: `component-unusable` is the one advisory that is RUN-scoped rather than AC-scoped —
 *  it says a whole component was skipped, which is true regardless of how many acceptance criteria
 *  the ticket carries. Every other kind derives from a check or a suite, so it cannot arise
 *  without criteria to hang it on. */
function hasRunScopedAdvisory(report: VerifyReport): boolean {
  return report.advisory.some((a) => a.kind === "component-unusable");
}

/** The `### Change-scoped verify` block, or "" when there is nothing to report. Pure.
 *
 *  Normally that means "no acceptance criteria". The exception is a run-scoped advisory: a
 *  component skipped for want of a toolchain must reach the PR even on a ticket with no ACs,
 *  or the narrowing is silent exactly where a reviewer would need it most. */
export function renderVerifyReport(report: VerifyReport): string {
  if (report.criteria.length === 0 && !hasRunScopedAdvisory(report)) return "";
  const lines: string[] = ["### Change-scoped verify", ""];
  if (report.criteria.length > 0) {
    lines.push(
      "For each acceptance criterion on this ticket, Styre tried to write an automated test that fails before the change and passes after it. Here is what those checks found.",
      "",
      "**Acceptance criteria**",
      "",
    );
  }
  for (const c of report.criteria) {
    lines.push(`- ${SYMBOL[c.label]} AC-${c.seq} — ${acText(c.text)}`);
    lines.push(`  ${EXPLAIN[c.label]}`);
    lines.push("");
  }
  if (report.binding.length > 0) {
    lines.push(
      "**Regression tests shipped with this change were checked against the base commit**",
    );
    lines.push("");
    for (const b of report.binding) lines.push(renderBinding(b));
    lines.push("");
  }
  if (report.advisory.length > 0) {
    lines.push("**Please review before merging — these did NOT block the merge**");
    lines.push("");
    lines.push(
      "These are advisory signals. Styre did not treat any of them as a reason to stop, so a human should look before merging.",
    );
    lines.push("");
    for (const a of report.advisory) lines.push(renderAdvisory(a));
    lines.push("");
  }
  if (report.provenance.length > 0) {
    lines.push("**How the automated checks changed during verification**");
    lines.push("");
    for (const p of report.provenance) {
      if (p.disposition === "installed") {
        lines.push(
          `- The automated check for AC-${p.seq} was rewritten mid-verification because the original one was judged wrong — it did not actually match the criterion. Reason: ${p.reason}.`,
        );
      } else {
        lines.push(
          `- The automated check for AC-${p.seq} was judged wrong and could not be replaced with a correct one. Reason: ${p.reason}.`,
        );
      }
    }
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}

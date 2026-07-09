# Change-scoped verify M6 — MERGE projection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Project the change-scoped verify records (M3 dispositions, M4 post-implement/gate/advisory, M5 blame/reauthor) into a plain-language "Change-scoped verify" section of the GitHub PR body at `merge:pr-ensure`, and make `ensurePr` keep that body current — so the merging human sees an honest, non-over-claiming report at the MERGE gate.

**Architecture:** One new pure module `src/dispatch/verify-report.ts` split into `buildVerifyReport` (DB → struct) and `renderVerifyReport` (struct → markdown). Three new thin readers in `src/db/repos/ground-truth-signal.ts` (mirroring the existing `latestBlameAtSha`/`latestReauthorAtSha` JS-filter pattern). `renderPrBody` splices the block in and drops the closing "Verified…" line unless everything is clean. `ensurePr` gains a body-reconcile (the one projector touch). Projection-only: no new gate, no new step, no schema change, no new outbox op.

**Tech Stack:** TypeScript, Bun, `bun:sqlite`. Tests are `bun test`. TDD throughout.

## Global Constraints

- **Never a gate.** `buildVerifyReport`/`renderVerifyReport` output is a string spliced into a PR body. Nothing in the control loop may branch on it. (design §8)
- **Never over-claim / no false-green.** A rejected re-author, an environmental check, or an unexpectedly-red gating check is labelled ⚠/⚪ and forces `allClean=false` — never ✅ verified. (design §2, C1/I1)
- **Read-only.** M6 reads M3/M4/M5 records verbatim; it must not re-run, re-classify, or re-adjudicate a check. (design §8)
- **No new `projection_outbox` op.** M6 rides the existing `pr_create`. The only projector-side change is the `ensurePr` body-reconcile. No `add_comment`/`pr_comment`. (design §1/§8)
- **Deterministic body.** The composed PR body must be stable for identical records (stable ordering) so the reconcile does not churn. (design §4/§5)
- **Exact closing-line text** (kept only when clean): `Verified against the project's checks and passed independent review.` (matches today's `renderPrBody`)
- **New signal readers mirror the existing JS-filter pattern** in `ground-truth-signal.ts` (`listByTicket(db, ticketId)` then filter/parse in JS; `listByTicket` orders by `measured_at, id` ASC so a `Map.set` loop yields newest-wins). Do NOT introduce raw `json_extract` boolean SQL. (design §4)
- Two schema files exist but **M6 changes no schema** — do not touch either `schema.sql`.

---

## File Structure

- **Create** `src/dispatch/verify-report.ts` — `VerifyReport` types + `buildVerifyReport(db, ticketId)` (Task 2) + `renderVerifyReport(report)` + text helpers (Task 3).
- **Modify** `src/db/repos/ground-truth-signal.ts` — add `postImplementAtSha`, `advisorySweeps`, `reauthorProvenance` (Task 1).
- **Modify** `src/dispatch/handlers.ts` — `renderPrBody` splices the block + conditional closing line (Task 4).
- **Modify** `src/integrations/forge.ts` (doc), `src/integrations/adapters/github.ts` (reconcile), `src/integrations/adapters/fake-forge.ts` (stateful) (Task 5).
- **Create** `test/db/verify-report-signals.test.ts` (Task 1), `test/dispatch/verify-report-build.test.ts` (Task 2), `test/dispatch/verify-report-render.test.ts` (Task 3), `test/integrations/fake-forge-reconcile.test.ts` (Task 5).
- **Modify** `test/dispatch/merge-e2e.test.ts` (Task 6).

---

## Task 1: Three new signal readers in `ground-truth-signal.ts`

**Files:**
- Modify: `src/db/repos/ground-truth-signal.ts` (append after the existing `latestReauthorAtSha`, ~line 230)
- Test: `test/db/verify-report-signals.test.ts`

**Interfaces:**
- Consumes: existing `listByTicket(db, ticketId): GroundTruthSignalRow[]` (orders by `measured_at, id` ASC), `BlameDetail`, `ReauthorDetail` (already exported in this file).
- Produces:
  - `postImplementAtSha(db: Database, ticketId: number, sha: string): Map<number, PostImplementDetail>` — newest `ac-check-post-implement` per `acCheckId` at `sha`.
  - `advisorySweeps(db: Database, ticketId: number): AdvisorySweep[]` — newest advisory suite/`integration` signal per `signal_type`, sha-agnostic, only `result !== "pass"`.
  - `reauthorProvenance(db: Database, ticketId: number): Provenance[]` — newest re-author disposition per `acCheckId`, joined to the newest `check-wrong` blame reason for that check.
  - Exported types `PostImplementDetail`, `AdvisorySweep`, `Provenance`.

- [ ] **Step 1: Write the failing test**

Create `test/db/verify-report-signals.test.ts`:

```ts
import { expect, test } from "bun:test";
import { insertSignal } from "../../src/db/repos/ground-truth-signal.ts";
import {
  advisorySweeps,
  postImplementAtSha,
  reauthorProvenance,
} from "../../src/db/repos/ground-truth-signal.ts";
import { makeTestDb } from "../helpers/db.ts";

test("postImplementAtSha: newest coarse per acCheckId at the sha", () => {
  const { db, ticketId } = makeTestDb();
  insertSignal(db, { ticketId, signalType: "ac-check-post-implement", result: "fail",
    branchHeadSha: "sha1", detail: { acCheckId: 7, acId: 1, coarse: "red", redClass: "assertion", outcome: "gated-red" } });
  insertSignal(db, { ticketId, signalType: "ac-check-post-implement", result: "pass",
    branchHeadSha: "sha1", detail: { acCheckId: 7, acId: 1, coarse: "green", redClass: "assertion", outcome: "green" } });
  // A different sha must not leak in.
  insertSignal(db, { ticketId, signalType: "ac-check-post-implement", result: "fail",
    branchHeadSha: "sha0", detail: { acCheckId: 7, acId: 1, coarse: "red", redClass: "assertion", outcome: "gated-red" } });
  const m = postImplementAtSha(db, ticketId, "sha1");
  expect(m.get(7)?.coarse).toBe("green"); // newest at sha1 wins
});

test("advisorySweeps: only advisory:true + non-pass, newest per type, excludes gate's number[] advisory", () => {
  const { db, ticketId } = makeTestDb();
  // A demoted suite (checkType 'backend') that errored.
  insertSignal(db, { ticketId, signalType: "backend", result: "error", branchHeadSha: "shaOld",
    detail: { advisory: true } });
  // A demoted integration fail with a failing job — at a DIFFERENT sha than any HEAD (sha-agnostic).
  insertSignal(db, { ticketId, signalType: "integration", result: "fail", branchHeadSha: "shaOld",
    detail: { advisory: true, ran: [{ label: "backend:build", exitCode: 0 }, { label: "backend:test", exitCode: 1 }] } });
  // A passing advisory must be excluded.
  insertSignal(db, { ticketId, signalType: "frontend", result: "pass", branchHeadSha: "shaOld",
    detail: { advisory: true } });
  // The gate signal carries advisory as a number[] — must NOT be selected.
  insertSignal(db, { ticketId, signalType: "ac-check-gate", result: "fail", branchHeadSha: "shaOld",
    detail: { stillRed: [1], tampered: [], advisory: [2, 3] } });
  const sweeps = advisorySweeps(db, ticketId).sort((a, b) => a.type.localeCompare(b.type));
  expect(sweeps.map((s) => s.type)).toEqual(["backend", "integration"]);
  expect(sweeps.find((s) => s.type === "integration")?.firstFailingJob).toBe("backend:test");
  expect(sweeps.find((s) => s.type === "backend")?.result).toBe("error");
});

test("reauthorProvenance: newest disposition per acCheckId + joined check-wrong reason", () => {
  const { db, ticketId } = makeTestDb();
  insertSignal(db, { ticketId, signalType: "ac-check-blame", result: "fail", branchHeadSha: "sha1",
    detail: { acId: 2, acCheckId: 9, blame: "check-wrong", reason: "asserts 200 but AC says 201" } });
  insertSignal(db, { ticketId, signalType: "ac-check-reauthor", result: "fail", branchHeadSha: "sha1",
    detail: { acId: 2, acCheckId: 9, disposition: "rejected" } });
  const prov = reauthorProvenance(db, ticketId);
  expect(prov).toEqual([{ acId: 2, acCheckId: 9, disposition: "rejected", reason: "asserts 200 but AC says 201" }]);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test test/db/verify-report-signals.test.ts`
Expected: FAIL — `postImplementAtSha`/`advisorySweeps`/`reauthorProvenance` are not exported.

- [ ] **Step 3: Implement the readers**

Append to `src/db/repos/ground-truth-signal.ts` (after `latestReauthorAtSha`). `BlameDetail` and `ReauthorDetail` are already defined above in the file — reuse them.

```ts
export interface PostImplementDetail {
  acCheckId: number;
  acId: number;
  coarse: string;
  redClass: string | null;
  outcome: string;
}

/** Newest `ac-check-post-implement` coarse per `acCheckId` at `sha`. `listByTicket` is measured_at,id
 *  ASC, so the last `set` for a given acCheckId wins = newest. M6 reads greenness here; never recomputes. */
export function postImplementAtSha(
  db: Database,
  ticketId: number,
  sha: string,
): Map<number, PostImplementDetail> {
  const byCheck = new Map<number, PostImplementDetail>();
  for (const s of listByTicket(db, ticketId)) {
    if (s.signal_type !== "ac-check-post-implement" || s.branch_head_sha !== sha) continue;
    const d = JSON.parse(s.detail_json ?? "{}") as PostImplementDetail;
    byCheck.set(d.acCheckId, d);
  }
  return byCheck;
}

export interface AdvisorySweep {
  type: string; // signal_type: 'integration' or a checkType (open vocab)
  result: string; // 'fail' | 'error'
  firstFailingJob?: string;
}

/** The demoted advisory suite/integration failures (M4 §8) — newest per `signal_type`, sha-agnostic
 *  (a check-only re-author moves HEAD without re-running the suite, so scoping to HEAD would drop a
 *  still-failing suite — review finding I2). Selected by `detail.advisory === true` (the boolean) so the
 *  `ac-check-gate` signal — whose `advisory` is a number[] — is never mis-selected; and `result !== pass`
 *  (include 'error', not just 'fail' — review finding M1). */
export function advisorySweeps(db: Database, ticketId: number): AdvisorySweep[] {
  const byType = new Map<string, AdvisorySweep>();
  for (const s of listByTicket(db, ticketId)) {
    const d = JSON.parse(s.detail_json ?? "{}") as {
      advisory?: unknown;
      ran?: Array<{ label: string; exitCode: number | null; timedOut?: boolean }>;
    };
    if (d.advisory !== true) continue;
    if (s.result === "pass") continue;
    let firstFailingJob: string | undefined;
    if (s.signal_type === "integration" && Array.isArray(d.ran)) {
      firstFailingJob = d.ran.find((j) => j.exitCode !== 0 || j.timedOut)?.label;
    }
    byType.set(s.signal_type, { type: s.signal_type, result: s.result, firstFailingJob });
  }
  return [...byType.values()];
}

export interface Provenance {
  acId: number;
  acCheckId: number;
  disposition: "installed" | "rejected";
  reason: string;
}

/** Newest re-author disposition per `acCheckId`, joined to the newest `check-wrong` blame reason for that
 *  check (reason lives on the blame signal; the reauthor signal has none). Sha-agnostic. Powers both the
 *  provenance section AND the C1 label: an ACTIVE check whose id appears here with `rejected` is the
 *  wrong-shape-unreplaced check (a rejected re-author leaves the old check active — arbiter-verdict.ts). */
export function reauthorProvenance(db: Database, ticketId: number): Provenance[] {
  const reasonByCheck = new Map<number, string>();
  const dispByCheck = new Map<number, { acId: number; disposition: "installed" | "rejected" }>();
  for (const s of listByTicket(db, ticketId)) {
    if (s.signal_type === "ac-check-blame") {
      const b = JSON.parse(s.detail_json ?? "{}") as BlameDetail;
      if (b.blame === "check-wrong") reasonByCheck.set(b.acCheckId, b.reason);
    } else if (s.signal_type === "ac-check-reauthor") {
      const r = JSON.parse(s.detail_json ?? "{}") as ReauthorDetail;
      dispByCheck.set(r.acCheckId, { acId: r.acId, disposition: r.disposition });
    }
  }
  const out: Provenance[] = [];
  for (const [acCheckId, { acId, disposition }] of dispByCheck) {
    out.push({ acId, acCheckId, disposition, reason: reasonByCheck.get(acCheckId) ?? "" });
  }
  return out;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test test/db/verify-report-signals.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/db/repos/ground-truth-signal.ts test/db/verify-report-signals.test.ts
git commit -m "feat(verify): M6 signal readers — postImplementAtSha, advisorySweeps, reauthorProvenance"
```

---

## Task 2: `buildVerifyReport` — DB → struct (the safety-critical rollup)

**Files:**
- Create: `src/dispatch/verify-report.ts`
- Test: `test/dispatch/verify-report-build.test.ts`

**Interfaces:**
- Consumes: `listByTicket as listAcs` from `acceptance-criterion.ts` (ORDER BY seq); `listActiveByTicket as listActiveChecks` from `ac-check.ts` (`superseded_at IS NULL`); `getLatestForTicket` from `dispatch.ts` (returns `DispatchRow | null` with `.branch_head_sha`); `postImplementAtSha`, `advisorySweeps`, `reauthorProvenance` (Task 1).
- Produces:
  - Types `AcLabel`, `AcLine`, `AdvisoryLine`, `ProvenanceLine`, `VerifyReport` (exact shapes below).
  - `buildVerifyReport(db: Database, ticketId: number): VerifyReport`.

- [ ] **Step 1: Write the failing test**

Create `test/dispatch/verify-report-build.test.ts`:

```ts
import { expect, test } from "bun:test";
import { insertAc } from "../../src/db/repos/acceptance-criterion.ts";
import { insertAcCheck, classifyAcCheck, supersedeByAc } from "../../src/db/repos/ac-check.ts";
import { insertSignal } from "../../src/db/repos/ground-truth-signal.ts";
import { completeDispatch, insertDispatch, nextSeq } from "../../src/db/repos/dispatch.ts";
import { buildVerifyReport } from "../../src/dispatch/verify-report.ts";
import { makeTestDb } from "../helpers/db.ts";

const HEAD = "headsha123";

function seedHead(db: ReturnType<typeof makeTestDb>["db"], ticketId: number) {
  const d = insertDispatch(db, { ticketId, dispatchId: "d1", seq: nextSeq(db, ticketId) });
  completeDispatch(db, d.id, { outcome: "clean-success", branchHeadSha: HEAD });
}

test("verified: an assertion check green at HEAD", () => {
  const { db, ticketId } = makeTestDb();
  seedHead(db, ticketId);
  const ac = insertAc(db, { ticketId, seq: 1, text: "returns 201 on create", source: "checklist" });
  const chk = insertAcCheck(db, { ticketId, acId: ac.id, selector: "s", testPath: "t" });
  classifyAcCheck(db, { acCheckId: chk.id, redClass: "assertion" });
  insertSignal(db, { ticketId, signalType: "ac-check-post-implement", result: "pass",
    branchHeadSha: HEAD, detail: { acCheckId: chk.id, acId: ac.id, coarse: "green", redClass: "assertion", outcome: "green" } });
  const r = buildVerifyReport(db, ticketId);
  expect(r.criteria).toEqual([{ seq: 1, text: "returns 201 on create", label: "verified" }]);
  expect(r.allClean).toBe(true);
});

test("satisfied, not-expressible, no-check labels", () => {
  const { db, ticketId } = makeTestDb();
  seedHead(db, ticketId);
  const a1 = insertAc(db, { ticketId, seq: 1, text: "pre-existing", source: "checklist" });
  const c1 = insertAcCheck(db, { ticketId, acId: a1.id, selector: "s", testPath: "t" });
  classifyAcCheck(db, { acCheckId: c1.id, disposition: "satisfied" });
  const a2 = insertAc(db, { ticketId, seq: 2, text: "subjective", source: "checklist" });
  const c2 = insertAcCheck(db, { ticketId, acId: a2.id, selector: "s", testPath: "t" });
  classifyAcCheck(db, { acCheckId: c2.id, disposition: "not-expressible" });
  insertAc(db, { ticketId, seq: 3, text: "no check for this", source: "checklist" });
  const r = buildVerifyReport(db, ticketId);
  expect(r.criteria.map((c) => c.label)).toEqual(["satisfied", "not-expressible", "no-check"]);
  expect(r.allClean).toBe(false); // not-expressible + no-check force it false
});

test("environmental check green at HEAD is NOT verified (I1)", () => {
  const { db, ticketId } = makeTestDb();
  seedHead(db, ticketId);
  const ac = insertAc(db, { ticketId, seq: 1, text: "env only", source: "checklist" });
  const chk = insertAcCheck(db, { ticketId, acId: ac.id, selector: "s", testPath: "t" });
  classifyAcCheck(db, { acCheckId: chk.id, redClass: "environmental" });
  insertSignal(db, { ticketId, signalType: "ac-check-post-implement", result: "pass",
    branchHeadSha: HEAD, detail: { acCheckId: chk.id, acId: ac.id, coarse: "green", redClass: "environmental", outcome: "advisory-red" } });
  const r = buildVerifyReport(db, ticketId);
  expect(r.criteria[0].label).toBe("environmental");
  expect(r.allClean).toBe(false);
});

test("environmental still-red emits an advisory caveat tagged to its AC", () => {
  const { db, ticketId } = makeTestDb();
  seedHead(db, ticketId);
  const ac = insertAc(db, { ticketId, seq: 1, text: "env red", source: "checklist" });
  const chk = insertAcCheck(db, { ticketId, acId: ac.id, selector: "s", testPath: "t" });
  classifyAcCheck(db, { acCheckId: chk.id, redClass: "environmental" });
  insertSignal(db, { ticketId, signalType: "ac-check-post-implement", result: "fail",
    branchHeadSha: HEAD, detail: { acCheckId: chk.id, acId: ac.id, coarse: "red", redClass: "environmental", outcome: "advisory-red" } });
  const r = buildVerifyReport(db, ticketId);
  expect(r.advisory).toContainEqual({ kind: "environmental-red", seq: 1 });
});

test("C1: an active check with a rejected re-author is check-unreplaced, even if coarse green", () => {
  const { db, ticketId } = makeTestDb();
  seedHead(db, ticketId);
  const ac = insertAc(db, { ticketId, seq: 1, text: "wrong-shape check", source: "checklist" });
  const chk = insertAcCheck(db, { ticketId, acId: ac.id, selector: "s", testPath: "t" });
  classifyAcCheck(db, { acCheckId: chk.id, redClass: "assertion" });
  // Post-implement went green (implement coded to the wrong shape) — must NOT read as verified.
  insertSignal(db, { ticketId, signalType: "ac-check-post-implement", result: "pass",
    branchHeadSha: HEAD, detail: { acCheckId: chk.id, acId: ac.id, coarse: "green", redClass: "assertion", outcome: "green" } });
  insertSignal(db, { ticketId, signalType: "ac-check-blame", result: "fail", branchHeadSha: "roundsha",
    detail: { acId: ac.id, acCheckId: chk.id, blame: "check-wrong", reason: "asserts 200, AC says 201" } });
  insertSignal(db, { ticketId, signalType: "ac-check-reauthor", result: "fail", branchHeadSha: "roundsha",
    detail: { acId: ac.id, acCheckId: chk.id, disposition: "rejected" } });
  const r = buildVerifyReport(db, ticketId);
  expect(r.criteria[0].label).toBe("check-unreplaced");
  expect(r.allClean).toBe(false);
  expect(r.provenance).toContainEqual({ seq: 1, disposition: "rejected", reason: "asserts 200, AC says 201" });
});

test("superseded checks do not leak into the rollup", () => {
  const { db, ticketId } = makeTestDb();
  seedHead(db, ticketId);
  const ac = insertAc(db, { ticketId, seq: 1, text: "re-authored", source: "checklist" });
  const old = insertAcCheck(db, { ticketId, acId: ac.id, selector: "old", testPath: "t" });
  classifyAcCheck(db, { acCheckId: old.id, redClass: "assertion" });
  supersedeByAc(db, ac.id); // supersede the old generation
  const neu = insertAcCheck(db, { ticketId, acId: ac.id, selector: "new", testPath: "t" });
  classifyAcCheck(db, { acCheckId: neu.id, redClass: "assertion" });
  insertSignal(db, { ticketId, signalType: "ac-check-post-implement", result: "pass",
    branchHeadSha: HEAD, detail: { acCheckId: neu.id, acId: ac.id, coarse: "green", redClass: "assertion", outcome: "green" } });
  const r = buildVerifyReport(db, ticketId);
  expect(r.criteria[0].label).toBe("verified"); // reads the new active check only
});

test("advisory sweeps surface sha-agnostically (I2)", () => {
  const { db, ticketId } = makeTestDb();
  seedHead(db, ticketId); // HEAD = headsha123
  insertSignal(db, { ticketId, signalType: "integration", result: "fail", branchHeadSha: "OLDER_SHA",
    detail: { advisory: true, ran: [{ label: "backend:test", exitCode: 1 }] } });
  const r = buildVerifyReport(db, ticketId);
  expect(r.advisory).toContainEqual({ kind: "integration", result: "fail", firstFailingJob: "backend:test" });
});

test("no ACs → empty report", () => {
  const { db, ticketId } = makeTestDb();
  seedHead(db, ticketId);
  const r = buildVerifyReport(db, ticketId);
  expect(r.criteria).toEqual([]);
  expect(r.advisory).toEqual([]);
  expect(r.provenance).toEqual([]);
});
```

Signatures confirmed against `src/db/repos/ac-check.ts`: `insertAcCheck(db, { ticketId, acId, selector, testPath? })`, `classifyAcCheck(db, { acCheckId, redClass?, disposition? })` (single object; `redClass`/`disposition` are optional enums, omit rather than pass null), `supersedeByAc(db, acId)`. Use exactly these shapes.

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test test/dispatch/verify-report-build.test.ts`
Expected: FAIL — `verify-report.ts` / `buildVerifyReport` do not exist.

- [ ] **Step 3: Implement `buildVerifyReport` + types**

Create `src/dispatch/verify-report.ts`:

```ts
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

  const provenance: ProvenanceLine[] = prov
    .filter((p) => seqByAcId.has(p.acId))
    .map((p) => ({
      seq: seqByAcId.get(p.acId) as number,
      disposition: p.disposition,
      reason: p.reason,
    }))
    .sort((a, b) => a.seq - b.seq);

  const allClean =
    criteria.length > 0 &&
    criteria.every((c) => c.label === "verified" || c.label === "satisfied") &&
    advisory.length === 0;

  return { criteria, advisory, provenance, allClean };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test test/dispatch/verify-report-build.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add src/dispatch/verify-report.ts test/dispatch/verify-report-build.test.ts
git commit -m "feat(verify): M6 buildVerifyReport — per-AC rollup with no-false-green labels"
```

---

## Task 3: `renderVerifyReport` — struct → plain-language markdown

**Files:**
- Modify: `src/dispatch/verify-report.ts` (add `renderVerifyReport` + helpers)
- Test: `test/dispatch/verify-report-render.test.ts`

**Interfaces:**
- Consumes: `VerifyReport`, `AcLabel`, `AcLine`, `AdvisoryLine`, `ProvenanceLine` (Task 2).
- Produces: `renderVerifyReport(report: VerifyReport): string` — the `### Change-scoped verify` markdown block, or `""` when `report.criteria` is empty.

- [ ] **Step 1: Write the failing test**

Create `test/dispatch/verify-report-render.test.ts`:

```ts
import { expect, test } from "bun:test";
import { renderVerifyReport } from "../../src/dispatch/verify-report.ts";
import type { VerifyReport } from "../../src/dispatch/verify-report.ts";

const base: VerifyReport = { criteria: [], advisory: [], provenance: [], allClean: true };

test("empty report renders nothing", () => {
  expect(renderVerifyReport(base)).toBe("");
});

test("clean run: criteria list, no advisory/provenance sections", () => {
  const out = renderVerifyReport({
    ...base,
    criteria: [{ seq: 1, text: "returns 201", label: "verified" }],
    allClean: true,
  });
  expect(out).toContain("### Change-scoped verify");
  expect(out).toContain("✅ AC-1 — returns 201");
  expect(out).toContain("Confirmed by an automated test that failed before this change and passes now.");
  expect(out).not.toContain("Please review before merging");
  expect(out).not.toContain("How the automated checks changed");
});

test("each label renders its symbol + explanation", () => {
  const out = renderVerifyReport({
    ...base,
    criteria: [
      { seq: 1, text: "a", label: "satisfied" },
      { seq: 2, text: "b", label: "not-expressible" },
      { seq: 3, text: "c", label: "environmental" },
      { seq: 4, text: "d", label: "check-unreplaced" },
      { seq: 5, text: "e", label: "still-red" },
      { seq: 6, text: "f", label: "no-check" },
    ],
    allClean: false,
  });
  expect(out).toContain("✅ AC-1 — a");
  expect(out).toContain("Already working before this change");
  expect(out).toContain("⚪ AC-2 — b");
  expect(out).toContain("left to human code review");
  expect(out).toContain("⚪ AC-3 — c");
  expect(out).toContain('an "environmental" check');
  expect(out).toContain("⚠️ AC-4 — d");
  expect(out).toContain("judged to not actually match");
  expect(out).toContain("⚠️ AC-5 — e");
  expect(out).toContain("➖ AC-6 — f");
  expect(out).toContain("No automated check was created");
});

test("advisory section: suite/integration/env-red with the 'not a merge gate' wording", () => {
  const out = renderVerifyReport({
    ...base,
    criteria: [{ seq: 1, text: "x", label: "still-red" }],
    advisory: [
      { kind: "integration", result: "fail", firstFailingJob: "backend:test" },
      { kind: "suite", checkType: "backend", result: "error" },
      { kind: "environmental-red", seq: 1 },
    ],
    allClean: false,
  });
  expect(out).toContain("Please review before merging — these did NOT block the merge");
  expect(out).toContain("full integration test run FAILED (first failing job: `backend:test`)");
  expect(out).toContain("`backend` test suite did not pass (result: error)");
  expect(out).toContain("This was not used as a merge gate.");
  expect(out).toContain("automated check for AC-1 is still failing");
});

test("provenance section only for installed/rejected", () => {
  const out = renderVerifyReport({
    ...base,
    criteria: [{ seq: 1, text: "x", label: "verified" }, { seq: 2, text: "y", label: "check-unreplaced" }],
    provenance: [
      { seq: 1, disposition: "installed", reason: "asserted stale field" },
      { seq: 2, disposition: "rejected", reason: "no correct check possible" },
    ],
    allClean: false,
  });
  expect(out).toContain("How the automated checks changed during verification");
  expect(out).toContain("check for AC-1 was rewritten mid-verification");
  expect(out).toContain("asserted stale field");
  expect(out).toContain("check for AC-2 was judged wrong and could not be replaced");
  expect(out).toContain("no correct check possible");
});

test("AC text is escaped and truncated (M3)", () => {
  const nasty = "`code` <details>bad</details> " + "x".repeat(200);
  const out = renderVerifyReport({
    ...base,
    criteria: [{ seq: 1, text: nasty, label: "verified" }],
    allClean: true,
  });
  expect(out).not.toContain("<details>");
  expect(out).not.toContain("`code`");
  expect(out).toContain("&lt;details");
  // truncated to <= 120 chars of AC text (plus ellipsis)
  const acLine = out.split("\n").find((l) => l.includes("✅ AC-1"))!;
  expect(acLine.length).toBeLessThan(160);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test test/dispatch/verify-report-render.test.ts`
Expected: FAIL — `renderVerifyReport` is not exported.

- [ ] **Step 3: Implement `renderVerifyReport` + helpers**

Append to `src/dispatch/verify-report.ts`:

```ts
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
    return `- ⚠️ The full integration test run ${a.result === "error" ? "did not complete" : "FAILED"}${job}. This was not used as a merge gate.`;
  }
  if (a.kind === "suite") {
    return `- ⚠️ The \`${a.checkType}\` test suite did not pass (result: ${a.result}). This was not used as a merge gate.`;
  }
  return `- ⚠️ The automated check for AC-${a.seq} is still failing, but the failure looks environmental (for example, missing tooling or configuration) rather than something this change caused.`;
}

/** The `### Change-scoped verify` block, or "" when the ticket has no acceptance criteria. Pure. */
export function renderVerifyReport(report: VerifyReport): string {
  if (report.criteria.length === 0) return "";
  const lines: string[] = [
    "### Change-scoped verify",
    "",
    "For each acceptance criterion on this ticket, Styre tried to write an automated test that fails before the change and passes after it. Here is what those checks found.",
    "",
    "**Acceptance criteria**",
    "",
  ];
  for (const c of report.criteria) {
    lines.push(`- ${SYMBOL[c.label]} AC-${c.seq} — ${acText(c.text)}`);
    lines.push(`  ${EXPLAIN[c.label]}`);
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
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test test/dispatch/verify-report-render.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/dispatch/verify-report.ts test/dispatch/verify-report-render.test.ts
git commit -m "feat(verify): M6 renderVerifyReport — plain-language PR-body block"
```

---

## Task 4: Splice the block into `renderPrBody` + conditional closing line

**Files:**
- Modify: `src/dispatch/handlers.ts` (`renderPrBody`, ~lines 306-349)
- Test: `test/dispatch/verify-report-prbody.test.ts` (new)

**Interfaces:**
- Consumes: `buildVerifyReport`, `renderVerifyReport` (Tasks 2/3).
- Produces: no new exports — `renderPrBody(db, ticket)` behavior change: splices the block before the untested-stacks section; keeps the closing "Verified…" line only when the block is empty (no ACs) or `report.allClean`.

- [ ] **Step 1: Write the failing test**

Create `test/dispatch/verify-report-prbody.test.ts`:

```ts
import { expect, test } from "bun:test";
import { insertAc } from "../../src/db/repos/acceptance-criterion.ts";
import { insertAcCheck, classifyAcCheck } from "../../src/db/repos/ac-check.ts";
import { insertSignal } from "../../src/db/repos/ground-truth-signal.ts";
import { completeDispatch, insertDispatch, nextSeq } from "../../src/db/repos/dispatch.ts";
import { getTicket } from "../../src/db/repos/ticket.ts";
import { renderPrBody } from "../../src/dispatch/handlers.ts";
import { makeTestDb } from "../helpers/db.ts";

const HEAD = "headsha123";
function seedHead(db: ReturnType<typeof makeTestDb>["db"], ticketId: number) {
  const d = insertDispatch(db, { ticketId, dispatchId: "d1", seq: nextSeq(db, ticketId) });
  completeDispatch(db, d.id, { outcome: "clean-success", branchHeadSha: HEAD });
}

test("no ACs: body unchanged, keeps the closing line", () => {
  const { db, ticketId } = makeTestDb();
  seedHead(db, ticketId);
  const t = getTicket(db, ticketId)!;
  const body = renderPrBody(db, t);
  expect(body).not.toContain("### Change-scoped verify");
  expect(body).toContain("Verified against the project's checks and passed independent review.");
});

test("clean ACs: block present, closing line kept", () => {
  const { db, ticketId } = makeTestDb();
  seedHead(db, ticketId);
  const ac = insertAc(db, { ticketId, seq: 1, text: "returns 201", source: "checklist" });
  const chk = insertAcCheck(db, { ticketId, acId: ac.id, selector: "s", testPath: "t" });
  classifyAcCheck(db, { acCheckId: chk.id, redClass: "assertion" });
  insertSignal(db, { ticketId, signalType: "ac-check-post-implement", result: "pass",
    branchHeadSha: HEAD, detail: { acCheckId: chk.id, acId: ac.id, coarse: "green", redClass: "assertion", outcome: "green" } });
  const body = renderPrBody(db, getTicket(db, ticketId)!);
  expect(body).toContain("### Change-scoped verify");
  expect(body).toContain("✅ AC-1 — returns 201");
  expect(body).toContain("Verified against the project's checks and passed independent review.");
});

test("not-clean ACs: closing line dropped", () => {
  const { db, ticketId } = makeTestDb();
  seedHead(db, ticketId);
  const ac = insertAc(db, { ticketId, seq: 1, text: "subjective", source: "checklist" });
  const chk = insertAcCheck(db, { ticketId, acId: ac.id, selector: "s", testPath: "t" });
  classifyAcCheck(db, { acCheckId: chk.id, disposition: "not-expressible" });
  const body = renderPrBody(db, getTicket(db, ticketId)!);
  expect(body).toContain("⚪ AC-1 — subjective");
  expect(body).not.toContain("Verified against the project's checks and passed independent review.");
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test test/dispatch/verify-report-prbody.test.ts`
Expected: FAIL — no `### Change-scoped verify` block; the closing line is currently unconditional so the third test fails.

- [ ] **Step 3: Implement the splice**

In `src/dispatch/handlers.ts`, add the import near the other `../dispatch` / repo imports at the top of the file:

```ts
import { buildVerifyReport, renderVerifyReport } from "./verify-report.ts";
```

Then change the tail of `renderPrBody` (the `return [ ... ].join("\n")` at ~lines 339-348). Replace it with:

```ts
  const report = buildVerifyReport(db, ticket.id);
  const verifyBlock = renderVerifyReport(report); // "" when the ticket has no ACs
  const verifyLines = verifyBlock === "" ? [] : ["", verifyBlock];
  // Keep the closing assurance only when there is nothing to caveat: no ACs at all (block empty), or a
  // fully clean report. A ⚠/⚪/➖ AC or an advisory failure means "verified" would over-claim (design §3).
  const keepClosing = verifyBlock === "" || report.allClean;
  const closingLines = keepClosing
    ? ["", "Verified against the project's checks and passed independent review."]
    : [];
  return [
    `Automated PR for ${ticket.ident}${ticket.title ? ` — ${ticket.title}` : ""}.`,
    "",
    "Work units:",
    ...(lines.length > 0 ? lines : ["- (none)"]),
    ...verifyLines,
    ...riskLines,
    ...sweepLines,
    ...closingLines,
  ].join("\n");
```

(The `verifyLines` splice sits **before** `riskLines`/`sweepLines`, per design §3.)

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test test/dispatch/verify-report-prbody.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/dispatch/handlers.ts test/dispatch/verify-report-prbody.test.ts
git commit -m "feat(verify): M6 splice verify report into renderPrBody + honest closing line"
```

---

## Task 5: `ensurePr` body-reconcile (the one projector touch)

**Files:**
- Modify: `src/integrations/forge.ts` (the `ensurePr` doc comment on `ForgePort`)
- Modify: `src/integrations/adapters/github.ts` (`ensurePr`, ~line 115)
- Modify: `src/integrations/adapters/fake-forge.ts` (stateful `ensurePr`)
- Test: `test/integrations/fake-forge-reconcile.test.ts` (new)

**Interfaces:**
- Consumes: nothing new.
- Produces: `ensurePr` now updates an existing PR's body when it differs from the composed body. The fake-forge records a `{ method: "updatePrBody", args: [{ branch, body }] }` call and keeps a `prs: Map<string, { ref; url; body }>`; it still records the `ensurePr` call and returns a non-null `{ ref, url }` (existing tests rely on that).

- [ ] **Step 1: Write the failing test**

Create `test/integrations/fake-forge-reconcile.test.ts`:

```ts
import { expect, test } from "bun:test";
import { fakeForge } from "../../src/integrations/adapters/fake-forge.ts";

test("ensurePr creates, then updates the body only when it differs", async () => {
  const f = fakeForge();
  const a = await f.ensurePr({ branch: "b1", base: "main", title: "t", body: "BODY-A" });
  expect(a.ref).not.toBeNull();
  // same body → no update recorded
  await f.ensurePr({ branch: "b1", base: "main", title: "t", body: "BODY-A" });
  expect(f.calls.filter((c) => c.method === "updatePrBody")).toHaveLength(0);
  // changed body → one update recorded, same ref returned
  const c = await f.ensurePr({ branch: "b1", base: "main", title: "t", body: "BODY-B" });
  expect(c.ref).toBe(a.ref);
  const updates = f.calls.filter((c) => c.method === "updatePrBody");
  expect(updates).toHaveLength(1);
  expect((updates[0].args[0] as { body: string }).body).toBe("BODY-B");
});

test("a new branch creates a fresh PR (no update)", async () => {
  const f = fakeForge();
  await f.ensurePr({ branch: "b1", base: "main", title: "t", body: "X" });
  await f.ensurePr({ branch: "b2", base: "main", title: "t", body: "Y" });
  expect(f.calls.filter((c) => c.method === "updatePrBody")).toHaveLength(0);
  expect(f.calls.filter((c) => c.method === "ensurePr")).toHaveLength(2);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test test/integrations/fake-forge-reconcile.test.ts`
Expected: FAIL — the fake never records `updatePrBody` (today it creates a fresh PR every call).

- [ ] **Step 3: Implement the stateful fake + adapter reconcile + doc**

Replace `ensurePr` in `src/integrations/adapters/fake-forge.ts` and add a `prs` map to the returned object:

```ts
export function fakeForge(): ForgePort & {
  calls: Array<{ method: string; args: unknown[] }>;
  prs: Map<string, { ref: string; url: string; body: string }>;
} {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const prs = new Map<string, { ref: string; url: string; body: string }>();
  return {
    calls,
    prs,
    async push(opts: { branch: string; sha: string }) {
      calls.push({ method: "push", args: [opts] });
    },
    async ensurePr(opts: { branch: string; base: string; title: string; body: string }) {
      calls.push({ method: "ensurePr", args: [opts] });
      const existing = prs.get(opts.branch);
      if (existing) {
        if (existing.body !== opts.body) {
          existing.body = opts.body;
          calls.push({ method: "updatePrBody", args: [{ branch: opts.branch, body: opts.body }] });
        }
        return { ref: existing.ref, url: existing.url };
      }
      const n = prs.size + 1;
      const rec = { ref: `fake-pr-${n}`, url: `https://fake/pr/${n}`, body: opts.body };
      prs.set(opts.branch, rec);
      return { ref: rec.ref, url: rec.url };
    },
    async addPrComment(prRef: string, body: string, idempotencyKey: string) {
      calls.push({ method: "addPrComment", args: [prRef, body, idempotencyKey] });
      return `fake-pr-comment-${calls.length}`;
    },
  };
}
```

In `src/integrations/adapters/github.ts`, replace the `if (found) return { ... }` line in `ensurePr` with a body-reconcile:

```ts
      const found = open[0];
      if (found) {
        if ((found.body ?? "") !== body) {
          await octokit.pulls.update({ owner, repo, pull_number: found.number, body });
        }
        return { ref: String(found.number), url: found.html_url };
      }
```

In `src/integrations/forge.ts`, update the `ensurePr` doc on `ForgePort` to state the reconcile:

```ts
  /** Ensure a PR exists for `branch` into `base` with the given `body`. Probe-idempotent: reuse an
   *  existing open PR if present, and update its body when it differs (so a projected report stays
   *  current). Returns the PR ref (number) + url. */
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test test/integrations/fake-forge-reconcile.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Run the existing forge/merge tests to confirm no regression**

Run: `bun test test/dispatch/merge-e2e.test.ts test/dispatch/merge-handlers.test.ts`
Expected: PASS (the existing assertions only check `ensurePr` was called + `response_ref` non-null; the new ref scheme `fake-pr-1` is still non-null). If any test asserts an exact old ref string, update it to assert non-null.

- [ ] **Step 6: Commit**

```bash
git add src/integrations/forge.ts src/integrations/adapters/github.ts src/integrations/adapters/fake-forge.ts test/integrations/fake-forge-reconcile.test.ts
git commit -m "feat(forge): ensurePr reconciles the PR body on an existing PR (M6 I3)"
```

---

## Task 6: Merge e2e — seed AC records, assert the composed body

**Files:**
- Modify: `test/dispatch/merge-e2e.test.ts` (add one test; reuse the file's `makeTestDb`/`registryFor`/`seedMergeTicket`)

**Interfaces:**
- Consumes: everything above, exercised through the real `tick` loop.
- Produces: no code — an end-to-end assertion that a merge-stage ticket's `pr_create` body carries the criteria list.

- [ ] **Step 1: Write the failing test**

Add to `test/dispatch/merge-e2e.test.ts` (imports at top: `insertAc` from `acceptance-criterion.ts`, `insertAcCheck` + `classifyAcCheck` from `ac-check.ts`, `insertSignal` from `ground-truth-signal.ts`):

```ts
test("merge PR body carries the change-scoped verify criteria list", async () => {
  const { db, ticketId } = makeTestDb();
  seedMergeTicket(db, ticketId); // completes a dispatch at branch_head_sha 'headsha123'
  // Seed one verified AC at the SAME sha the seeded dispatch used, so the at-HEAD reads resolve.
  const ac = insertAc(db, { ticketId, seq: 1, text: "returns 201 on create", source: "checklist" });
  const chk = insertAcCheck(db, { ticketId, acId: ac.id, selector: "s", testPath: "t" });
  classifyAcCheck(db, { acCheckId: chk.id, redClass: "assertion" });
  insertSignal(db, { ticketId, signalType: "ac-check-post-implement", result: "pass",
    branchHeadSha: "headsha123", detail: { acCheckId: chk.id, acId: ac.id, coarse: "green", redClass: "assertion", outcome: "green" } });

  const reg = registryFor();
  const forge = fakeForge();
  const ports = { issueTracker: fakeIssueTracker(), forge };
  let t = getTicket(db, ticketId);
  let i = 0;
  while (t?.status !== "waiting" && i < 10) {
    await tick(db, reg, { ports });
    t = getTicket(db, ticketId);
    i++;
  }
  const prCall = forge.calls.find((c) => c.method === "ensurePr");
  const body = (prCall?.args[0] as { body: string }).body;
  expect(body).toContain("### Change-scoped verify");
  expect(body).toContain("✅ AC-1 — returns 201 on create");
});
```

- [ ] **Step 2: Run the test to verify it fails, then passes**

Run: `bun test test/dispatch/merge-e2e.test.ts`
Expected: with Tasks 1-4 already merged, this should PASS immediately (the body now contains the block). If Task 4 were absent it would FAIL on the `toContain`. Confirm it passes here as the integration guard.

- [ ] **Step 3: Run the full suite**

Run: `bun test`
Expected: all green (the M5 baseline was 1023 passing; this adds ~20 tests and 0 failures). Investigate any failure before proceeding — do not adjust assertions to force green.

- [ ] **Step 4: Commit**

```bash
git add test/dispatch/merge-e2e.test.ts
git commit -m "test(verify): M6 e2e — merge PR body carries the verify criteria list"
```

---

## Self-Review (completed by plan author)

**Spec coverage.** design §1 concerns → dispositions (Tasks 2/3/4), advisory sweep (Tasks 1/2/3), provenance (Tasks 1/2/3); §2 rollup precedence → Task 2 label logic + tests; §3 wording → Task 3 + tests; §4 readers + build/render split + ticketId param + internal sha derivation → Tasks 1/2; §4 ensurePr reconcile (I3) → Task 5; §5 edge cases (no-ACs, no-checks, env-green, C1, escaping, dedup) → Task 2/3 tests; §6 test list → Tasks 1-6; §8 guardrails → Global Constraints. C1/I1/I2/I3 each have a named regression test.

**Placeholder scan.** No TBD/TODO; every code step carries full code; every command has an expected result.

**Type consistency.** `AcLabel`/`AcLine`/`AdvisoryLine`/`ProvenanceLine`/`VerifyReport` defined in Task 2, imported unchanged in Task 3; `PostImplementDetail`/`AdvisorySweep`/`Provenance` defined in Task 1, consumed in Task 2; `buildVerifyReport(db, ticketId: number)` signature identical in Tasks 2/4; `renderPrBody(db, ticket)` unchanged. `firstFailingJob?` optional throughout. `fakeForge` return type extended with `prs` in Task 5 only.

**Seed-helper signatures confirmed** against the live repos: `insertAcCheck(db, {ticketId, acId, selector, testPath?})`, `classifyAcCheck(db, {acCheckId, redClass?, disposition?})`, `supersedeByAc(db, acId)`, `insertDispatch(db, {ticketId, dispatchId, seq})`, `completeDispatch(db, id, {outcome, branchHeadSha})`, `nextSeq(db, ticketId)`, `insertAc(db, {ticketId, seq, text, source})`. All seed calls in Tasks 2/4/6 use these exact shapes.

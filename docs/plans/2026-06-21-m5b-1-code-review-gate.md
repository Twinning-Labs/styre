# M5b-1 — Code Review Gate (`review` / S5) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the real `review` step — an independent, read-only code reviewer that files findings on the finished diff, the daemon computes `blocks_ship` from each finding, and a **verdict** routes the ticket: clean → merge; a blocking code finding → loop back to re-code; a blocking plan-level defect → (config) escalate-to-human *or* loop back to redesign; a major finding flagged deferral_candidate → escalate to human.

**Architecture:** `review` reuses the M5a structured-output pattern exactly: a read-only agent returns a `styre-sidecar` JSON block of findings; the daemon validates it (zod), computes `blocks_ship` per finding (never trusts agent self-scoring), and writes `review_finding` rows. The **verdict** is computed by `applyReviewVerdict`, called from `advanceOneStep` immediately after the `review` step *succeeds* — the mirror image of `applyFailurePolicy`, which runs after a step *fails*. The resolver is unchanged: its existing `review done → advance to merge` path is the clean verdict; loopback/escalate are mutations the daemon performs before that advance can fire (they reset the `review` step and change stage, so the resolver re-routes next tick).

**Tech Stack:** TypeScript + Bun + `bun:sqlite`; zod; the existing `extractSidecar` / `runAgentDispatch` / `applyFailurePolicy` / `appendEvent` / `insertPending` (signals) machinery + the `FakeAgentRunner` test harness.

## Global Constraints

- **Never commit to `main`.** Work on branch `feat/m5b-review-gates` (already created).
- **Only the daemon writes the SoT.** The agent has read-only tools (`review` allowlist is already `[Read, Grep, Glob]`); the handler does all `review_finding` inserts. `blocks_ship` is **daemon-computed**, never reviewer-filed (control-loop §8; schema comment "DAEMON-computed").
- **Ground truth over self-report.** The verdict is derived from the `review_finding` ledger, never from the agent's own pass/fail claim. An absent/malformed sidecar is a **transport failure** (throw → re-dispatch), not a clean review.
- **Verdict semantics (control-loop §8, V1/V3/V-def):**
  - `critical` **always** blocks ship (non-deferrable — schema CHECK enforces it too).
  - `major` blocks ship **unless** `deferral_candidate=1` (then it does not block, but escalates to human for the defer/fix judgment).
  - `minor` / `nit` never block.
  - Blocking findings route by category: any `plan-defect` among the blocking set → the **plan route** (config: escalate or redesign); otherwise → the **code route** (loop back to implement, re-code the referenced units).
- **`onPlanDefect` config (operator decision):** `onPlanDefect ∈ {"escalate","redesign"}`, **default `"escalate"`**. This is a **runtime operator policy**, NOT a probed project-profile fact — it does not belong in `Profile` (the canonical *shape* of the product: stack, commands, test pattern, checks-system). It is a field on a **`RuntimeConfig` object** threaded into the daemon loop, exactly as `AgentConfig` (provider/models) is a runtime config rather than a profile field. **Decision (operator):** thread a config *object*, not a lone flag — so future policies don't churn signatures and the seam is shaped for "a config blob loaded from outside." Per our config precedence (per-ticket > workspace `config.json` > profile > binary defaults), the *values* live outside the target repo and are read at startup; `RuntimeConfig`'s zod schema + default here is only the **binary-defaults floor** (code, not an operator value). **Decision (operator): defer the file loader** — "load at startup" needs a `styre daemon`/`run` entrypoint, which is a later milestone; until then the threaded object falls back to the safe default. Build NO file loader here. M5b-1 builds BOTH verdict branches as the config-gated hook; M5b-2's upfront plan reviewer routes plan findings through the same hook.
- **Scope discipline:** M5b-1 builds the code reviewer (`review`/S5) + the full verdict machinery + the config-gated plan route. It does NOT build `design:review` (S1c) or real fast/full track sizing — those are M5b-2 and reuse this verdict module.
- Run the full gate before claiming done: `bun test` · `bun run lint` · `bun run typecheck` · `bun run build`. **Every task's gate includes `bun run lint`** (an M5a lesson).
- **No schema change.** The `review_finding` table already exists in BOTH `src/db/schema.sql` and `docs/architecture/schema.sql` (the dual-schema rule). M5b-1 only adds a repo + handlers + verdict logic. If a schema change becomes necessary, edit BOTH files.

---

## File Structure

- **Create** `src/db/repos/review-finding.ts` — repo for the `review_finding` table (insert, list-by-dispatch, list-open, latest-review-dispatch-id, set-status).
- **Create** `src/dispatch/review-schema.ts` — zod `FiledFindingSchema` + `ReviewOutputSchema`, `computeBlocksShip`, light `validateReviewFindings`.
- **Create** `prompts/review.md` — the read-only reviewer prompt (cold inputs; emits the findings sidecar).
- **Create** `src/daemon/review-verdict.ts` — `applyReviewVerdict` (the verdict + its loopback/escalate mutations).
- **Create** `src/config/runtime-config.ts` — the `RuntimeConfig` object (zod schema + safe defaults); `onPlanDefect` is its first field. A runtime config threaded as a single object (NOT the probed profile); shaped so a future startup loader just `parse`s an external file into it. No file loader is built here.
- **Modify** `src/dispatch/prompt-vars.ts` — add `REVIEW_TEMPLATE` + `reviewVars`.
- **Modify** `src/dispatch/handlers.ts` — register the real `review` handler.
- **Modify** `src/db/repos/work-unit.ts` — add `deleteByTicket` (for the redesign route's unit regeneration).
- **Modify** `src/daemon/advance.ts` — call `applyReviewVerdict` after the `review` step succeeds; thread the `onPlanDefect` policy through `advanceOneStep`.
- **Modify** `src/daemon/loop.ts` — forward the `onPlanDefect` policy through `tick`.
- **Tests:** `test/db/repos/review-finding.test.ts`, `test/dispatch/review-schema.test.ts`, `test/dispatch/review-handler.test.ts`, `test/daemon/review-verdict.test.ts`, `test/dispatch/review-e2e.test.ts`.

---

### Task 1: `review_finding` repo

**Files:**
- Create: `src/db/repos/review-finding.ts`
- Test: `test/db/repos/review-finding.test.ts`

**Interfaces:**
- Consumes: the existing `review_finding` table.
- Produces:
  - `ReviewFindingRow` (the selected columns).
  - `insertFinding(db, p): ReviewFindingRow` — `p`: `{ ticketId, reviewKind: "plan"|"code", severity, dispatchId?, workUnitId?, category?, factorsJson?, deferralCandidate?, blocksShip?, location?, rationale?, findingClassKey? }`.
  - `listByDispatch(db, ticketId, dispatchId): ReviewFindingRow[]`.
  - `listOpenByTicket(db, ticketId): ReviewFindingRow[]` (status='open').
  - `latestReviewDispatchId(db, ticketId, reviewKind): string | null` — the most recent dispatch with `stage` matching that filed findings of this kind; implemented as: the `dispatch_id` of the highest-`seq` dispatch whose `stage='review'` (code) — see step 3 for the exact query.
  - `setStatus(db, id, status): void`.

- [ ] **Step 1: Write the failing test**

Create `test/db/repos/review-finding.test.ts`:

```typescript
import { expect, test } from "bun:test";
import { insertFinding, listByDispatch, listOpenByTicket, setStatus } from "../../../src/db/repos/review-finding.ts";
import { makeTestDb } from "../../helpers/db.ts";

test("insertFinding persists fields and round-trips by dispatch", () => {
  const { db, ticketId } = makeTestDb();
  const f = insertFinding(db, {
    ticketId,
    reviewKind: "code",
    dispatchId: "ENG-1-d0005",
    severity: "major",
    category: "correctness",
    deferralCandidate: 0,
    blocksShip: 1,
    location: "src/a.ts:12",
    rationale: "off-by-one",
  });
  const byDispatch = listByDispatch(db, ticketId, "ENG-1-d0005");
  db.close();
  expect(byDispatch.length).toBe(1);
  expect(byDispatch[0]?.severity).toBe("major");
  expect(byDispatch[0]?.blocks_ship).toBe(1);
  expect(byDispatch[0]?.review_kind).toBe("code");
  expect(f.status).toBe("open");
});

test("listOpenByTicket returns only open; setStatus flips it", () => {
  const { db, ticketId } = makeTestDb();
  const f = insertFinding(db, { ticketId, reviewKind: "code", severity: "nit" });
  expect(listOpenByTicket(db, ticketId).length).toBe(1);
  setStatus(db, f.id, "fixed");
  const open = listOpenByTicket(db, ticketId);
  db.close();
  expect(open.length).toBe(0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/db/repos/review-finding.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

Create `src/db/repos/review-finding.ts`:

```typescript
import type { Database } from "bun:sqlite";
import { nowUtc } from "../../util/time.ts";

export interface ReviewFindingRow {
  id: number;
  ticket_id: number;
  work_unit_id: number | null;
  dispatch_id: string | null;
  review_kind: string;
  finding_class_key: string | null;
  severity: string;
  category: string | null;
  factors_json: string | null;
  deferral_candidate: number;
  blocks_ship: number | null;
  location: string | null;
  rationale: string | null;
  status: string;
  created_at: string;
}

const COLS =
  "id, ticket_id, work_unit_id, dispatch_id, review_kind, finding_class_key, severity, category, " +
  "factors_json, deferral_candidate, blocks_ship, location, rationale, status, created_at";

export function getById(db: Database, id: number): ReviewFindingRow | null {
  return (
    db.query<ReviewFindingRow, [number]>(`SELECT ${COLS} FROM review_finding WHERE id = ?`).get(id) ??
    null
  );
}

export function insertFinding(
  db: Database,
  p: {
    ticketId: number;
    reviewKind: "plan" | "code";
    severity: string;
    dispatchId?: string | null;
    workUnitId?: number | null;
    category?: string | null;
    factorsJson?: string | null;
    deferralCandidate?: number;
    blocksShip?: number | null;
    location?: string | null;
    rationale?: string | null;
    findingClassKey?: string | null;
  },
): ReviewFindingRow {
  const res = db
    .query(
      `INSERT INTO review_finding
         (ticket_id, work_unit_id, dispatch_id, review_kind, finding_class_key, severity, category,
          factors_json, deferral_candidate, blocks_ship, location, rationale, status, created_at)
       VALUES ($t, $wu, $did, $kind, $fck, $sev, $cat, $fj, $defer, $blocks, $loc, $rat, 'open', $now)`,
    )
    .run({
      $t: p.ticketId,
      $wu: p.workUnitId ?? null,
      $did: p.dispatchId ?? null,
      $kind: p.reviewKind,
      $fck: p.findingClassKey ?? null,
      $sev: p.severity,
      $cat: p.category ?? null,
      $fj: p.factorsJson ?? null,
      $defer: p.deferralCandidate ?? 0,
      $blocks: p.blocksShip ?? null,
      $loc: p.location ?? null,
      $rat: p.rationale ?? null,
      $now: nowUtc(),
    });
  const created = getById(db, Number(res.lastInsertRowid));
  if (!created) {
    throw new Error("insertFinding: row missing after insert");
  }
  return created;
}

export function listByDispatch(
  db: Database,
  ticketId: number,
  dispatchId: string,
): ReviewFindingRow[] {
  return db
    .query<ReviewFindingRow, [number, string]>(
      `SELECT ${COLS} FROM review_finding WHERE ticket_id = ? AND dispatch_id = ? ORDER BY id`,
    )
    .all(ticketId, dispatchId);
}

export function listOpenByTicket(db: Database, ticketId: number): ReviewFindingRow[] {
  return db
    .query<ReviewFindingRow, [number]>(
      `SELECT ${COLS} FROM review_finding WHERE ticket_id = ? AND status = 'open' ORDER BY id`,
    )
    .all(ticketId);
}

/** The dispatch_id of the most recent code-review round for this ticket (the dispatch with
 *  stage='review', highest seq). Findings are scoped to this so a clean re-review round is not
 *  re-judged against a prior round's blocking findings. */
export function latestReviewDispatchId(db: Database, ticketId: number): string | null {
  const row = db
    .query<{ dispatch_id: string }, [number]>(
      `SELECT dispatch_id FROM dispatch WHERE ticket_id = ? AND stage = 'review'
       ORDER BY seq DESC LIMIT 1`,
    )
    .get(ticketId);
  return row?.dispatch_id ?? null;
}

export function setStatus(db: Database, id: number, status: string): void {
  db.query("UPDATE review_finding SET status = $s WHERE id = $id").run({ $s: status, $id: id });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/db/repos/review-finding.test.ts && bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/db/repos/review-finding.ts test/db/repos/review-finding.test.ts
git commit -m "feat(m5b-1): review_finding repo"
```

---

### Task 2: Findings sidecar schema + `blocks_ship` computer

**Files:**
- Create: `src/dispatch/review-schema.ts`
- Test: `test/dispatch/review-schema.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `FiledFinding` (zod-inferred): `{ severity: "critical"|"major"|"minor"|"nit", category: string, location: string | null, rationale: string, factors: Record<string,boolean> | null, deferral_candidate: boolean, work_unit_seq: number | null }`.
  - `ReviewOutputSchema`: `ZodType<{ findings: FiledFinding[] }>`.
  - `computeBlocksShip(severity, deferralCandidate): 0 | 1` — `critical` → 1 always; `major` → `deferralCandidate ? 0 : 1`; `minor`/`nit` → 0.
  - `validateReviewFindings(findings, unitSeqs): string[]` — light completeness: a non-null `work_unit_seq` must exist in `unitSeqs`; `critical` with `deferral_candidate=true` is rejected (critical is non-deferrable). Returns human-readable errors (empty ⇒ valid).

- [ ] **Step 1: Write the failing tests**

Create `test/dispatch/review-schema.test.ts`:

```typescript
import { expect, test } from "bun:test";
import {
  ReviewOutputSchema,
  computeBlocksShip,
  validateReviewFindings,
} from "../../src/dispatch/review-schema.ts";

const finding = (over: Record<string, unknown> = {}) => ({
  severity: "major",
  category: "correctness",
  location: "src/a.ts:1",
  rationale: "bug",
  factors: null,
  deferral_candidate: false,
  work_unit_seq: 1,
  ...over,
});

test("schema parses a well-formed findings block", () => {
  expect(ReviewOutputSchema.safeParse({ findings: [finding()] }).success).toBe(true);
});

test("schema rejects an unknown severity", () => {
  expect(ReviewOutputSchema.safeParse({ findings: [finding({ severity: "blocker" })] }).success).toBe(
    false,
  );
});

test("schema accepts an empty findings list (a clean review)", () => {
  expect(ReviewOutputSchema.safeParse({ findings: [] }).success).toBe(true);
});

test("computeBlocksShip: critical always blocks, even if deferral_candidate", () => {
  expect(computeBlocksShip("critical", true)).toBe(1);
  expect(computeBlocksShip("critical", false)).toBe(1);
});

test("computeBlocksShip: major blocks unless deferred", () => {
  expect(computeBlocksShip("major", false)).toBe(1);
  expect(computeBlocksShip("major", true)).toBe(0);
});

test("computeBlocksShip: minor and nit never block", () => {
  expect(computeBlocksShip("minor", false)).toBe(0);
  expect(computeBlocksShip("nit", false)).toBe(0);
});

test("validateReviewFindings rejects a dangling work_unit_seq", () => {
  expect(validateReviewFindings([finding({ work_unit_seq: 9 })], [1, 2]).length).toBeGreaterThan(0);
});

test("validateReviewFindings rejects a deferral-flagged critical", () => {
  expect(
    validateReviewFindings([finding({ severity: "critical", deferral_candidate: true })], [1]).length,
  ).toBeGreaterThan(0);
});

test("validateReviewFindings accepts a clean set (null unit seq allowed)", () => {
  expect(validateReviewFindings([finding({ work_unit_seq: null })], [1])).toEqual([]);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test test/dispatch/review-schema.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

Create `src/dispatch/review-schema.ts`:

```typescript
import { z } from "zod";

export const FiledFindingSchema = z.object({
  severity: z.enum(["critical", "major", "minor", "nit"]),
  category: z.string().min(1),
  location: z.string().nullable(),
  rationale: z.string(),
  factors: z.record(z.string(), z.boolean()).nullable(),
  deferral_candidate: z.boolean(),
  work_unit_seq: z.number().int().positive().nullable(),
});

export type FiledFinding = z.infer<typeof FiledFindingSchema>;

export const ReviewOutputSchema = z.object({
  findings: z.array(FiledFindingSchema),
});

export type ReviewOutput = z.infer<typeof ReviewOutputSchema>;

/** Daemon-computed ship gate (control-loop §8): critical always blocks (non-deferrable);
 *  major blocks unless the reviewer flagged it deferral_candidate; minor/nit never block. */
export function computeBlocksShip(severity: string, deferralCandidate: boolean): 0 | 1 {
  if (severity === "critical") {
    return 1;
  }
  if (severity === "major") {
    return deferralCandidate ? 0 : 1;
  }
  return 0;
}

/** Light completeness gate. Returns human-readable errors (empty ⇒ valid). */
export function validateReviewFindings(findings: FiledFinding[], unitSeqs: number[]): string[] {
  const errors: string[] = [];
  const seqSet = new Set(unitSeqs);
  for (const f of findings) {
    if (f.work_unit_seq !== null && !seqSet.has(f.work_unit_seq)) {
      errors.push(`finding references work_unit_seq ${f.work_unit_seq}, which does not exist`);
    }
    if (f.severity === "critical" && f.deferral_candidate) {
      errors.push("a critical finding cannot be deferral_candidate (critical is non-deferrable)");
    }
  }
  return errors;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test test/dispatch/review-schema.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/dispatch/review-schema.ts test/dispatch/review-schema.test.ts
git commit -m "feat(m5b-1): findings sidecar schema + blocks_ship computer"
```

---

### Task 3: The `review` prompt + handler

**Files:**
- Create: `prompts/review.md`
- Modify: `src/dispatch/prompt-vars.ts`
- Modify: `src/dispatch/handlers.ts`
- Test: `test/dispatch/review-handler.test.ts`

**Interfaces:**
- Consumes: `runAgentDispatch` (`output`), `extractSidecar`, `ReviewOutputSchema`, `validateReviewFindings`, `computeBlocksShip`, `insertFinding`, `listByTicket` (units), `REVIEW_TEMPLATE`, `reviewVars`.
- Produces:
  - `REVIEW_TEMPLATE: string`; `reviewVars(ticket, profile): Record<string,string>` covering every template placeholder (at minimum `ident`, `title`, `slug`, plus `...profile.promptVars`).
  - A registered `"review"` handler: runs the read-only agent, extracts + validates the findings sidecar, inserts each finding (review_kind='code', `blocks_ship` computed by the daemon, `dispatch_id` set, `work_unit_id` mapped from `work_unit_seq`). Returns `{ findings: number, blocking: number }`.

- [ ] **Step 1: Create the prompt file**

Create `prompts/review.md`:

```markdown
You are the independent code reviewer for ticket {{ident}} ("{{title}}") in project {{slug}}.

The implementation is complete and committed in this worktree. Review the finished change on
its own terms — the diff, the plan under `docs/plans/`, and the codebase. You did not write this
code; judge it cold. Do NOT modify any files — your only output is the findings sidecar below.

For each problem you find, file a finding with:
- **severity**: `critical` (must never ship — broken/unsafe), `major` (should not ship as-is),
  `minor` (worth fixing, non-blocking), or `nit` (trivial). Do not inflate or deflate severity.
- **category**: e.g. `correctness`, `security`, `perf`, `maintainability`, `test-quality`,
  `scope`, or `plan-defect`. Use `plan-defect` ONLY when the *plan itself* was wrong — the
  approach is flawed and no amount of re-coding this unit fixes it. Code-level bugs are NOT
  plan-defects.
- **location**: `file:line` where the problem lives (or null if ticket-wide).
- **rationale**: one or two sentences on what is wrong and why it matters.
- **factors**: an object of booleans giving context, or null, e.g.
  `{"in_changed_code": true, "is_regression": false, "user_visible": true}`.
- **deferral_candidate**: `true` only for a `major` finding you judge could reasonably ship now
  and be fixed later. A `critical` can NEVER be deferral_candidate.
- **work_unit_seq**: the seq of the work unit this finding belongs to (or null if ticket-wide).

If the change is clean, return an empty `findings` array. Do NOT pass or fail the change
yourself — the system decides from your findings. Emit exactly one fenced block:

```styre-sidecar
{
  "findings": [
    {
      "severity": "major",
      "category": "correctness",
      "location": "src/foo.ts:42",
      "rationale": "…",
      "factors": {"in_changed_code": true},
      "deferral_candidate": false,
      "work_unit_seq": 1
    }
  ]
}
```
```

- [ ] **Step 2: Wire the template + vars**

In `src/dispatch/prompt-vars.ts`, mirror `EXTRACT_TEMPLATE`/`extractVars`:

```typescript
import reviewTemplate from "../../prompts/review.md" with { type: "text" };
// …existing imports…

export const REVIEW_TEMPLATE = reviewTemplate;

export function reviewVars(
  ticket: { ident: string; title: string | null },
  profile: Profile,
): Record<string, string> {
  return {
    ident: ticket.ident,
    title: ticket.title ?? "",
    slug: profile.slug,
    ...profile.promptVars,
  };
}
```

- [ ] **Step 3: Write the failing handler test**

Create `test/dispatch/review-handler.test.ts` (reuse the `gitRepo()` + `registryFor()` helpers from `test/dispatch/handlers.test.ts` — copy them; the file's harness builds the registry from `buildDispatchRegistry`). The fake runner returns a findings sidecar in `stdout`.

```typescript
import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeAgentRunner } from "../../src/agent/fake-runner.ts";
import { DEFAULT_AGENT_CONFIG } from "../../src/config/agent-config.ts";
import { advanceOneStep } from "../../src/daemon/advance.ts";
import { listOpenByTicket } from "../../src/db/repos/review-finding.ts";
import { insertWorkUnit } from "../../src/db/repos/work-unit.ts";
import { getByKey, insertPending } from "../../src/db/repos/workflow-step.ts";
import { buildDispatchRegistry } from "../../src/dispatch/handlers.ts";
import { parseProfile } from "../../src/dispatch/profile.ts";
import { makeTestDb } from "../helpers/db.ts";

function gitRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "styre-rv-"));
  const run = (a: string[]) => Bun.spawnSync(["git", ...a], { cwd: root });
  run(["init", "-b", "main"]);
  run(["config", "user.email", "t@s.dev"]);
  run(["config", "user.name", "T"]);
  writeFileSync(join(root, "README.md"), "x");
  run(["add", "-A"]);
  run(["commit", "-m", "init"]);
  return root;
}

function registryFor(repo: string, runner: FakeAgentRunner) {
  return buildDispatchRegistry({
    runner,
    agentConfig: DEFAULT_AGENT_CONFIG,
    profile: parseProfile({ slug: "demo", targetRepo: repo, commands: { test: "bun test" } }),
    worktreeRoot: mkdtempSync(join(tmpdir(), "styre-rvwt-")),
  });
}

const sidecar = (json: string) => `Reviewed.\n\n\`\`\`styre-sidecar\n${json}\n\`\`\`\n`;

// Put the ticket at stage='review' with a unit present so the resolver routes to review.
function readyForReview(db: ReturnType<typeof makeTestDb>["db"], ticketId: number) {
  db.query("UPDATE ticket SET stage = 'review' WHERE id = ?").run(ticketId);
  insertWorkUnit(db, { ticketId, seq: 1, kind: "backend", behavioral: 0, verifyCheckTypes: ["test"] });
}

test("review handler files findings with daemon-computed blocks_ship", async () => {
  const { db, ticketId, projectId } = makeTestDb();
  const repo = gitRepo();
  db.query("UPDATE project SET target_repo = ? WHERE id = ?").run(repo, projectId);
  readyForReview(db, ticketId);
  const runner = new FakeAgentRunner(() => ({
    completed: true,
    exitCode: 0,
    stdout: sidecar(
      JSON.stringify({
        findings: [
          { severity: "major", category: "correctness", location: "src/a.ts:1", rationale: "bug", factors: null, deferral_candidate: false, work_unit_seq: 1 },
          { severity: "nit", category: "maintainability", location: null, rationale: "style", factors: null, deferral_candidate: false, work_unit_seq: null },
        ],
      }),
    ),
    stderr: "",
    timedOut: false,
    costUsd: null,
    tokensIn: null,
    tokensOut: null,
  }));
  await advanceOneStep(db, ticketId, registryFor(repo, runner));
  const open = listOpenByTicket(db, ticketId);
  const step = getByKey(db, ticketId, "review");
  db.close();
  expect(open.length).toBe(2);
  const major = open.find((f) => f.severity === "major");
  expect(major?.blocks_ship).toBe(1); // daemon-computed
  expect(major?.work_unit_id).not.toBeNull(); // mapped from work_unit_seq=1
  expect(open.find((f) => f.severity === "nit")?.blocks_ship).toBe(0);
  // step status is governed by the verdict (Task 5); here we only assert findings were written.
  expect(step).not.toBeNull();
});

test("review handler throws on an absent findings sidecar (transport failure)", async () => {
  const { db, ticketId, projectId } = makeTestDb();
  const repo = gitRepo();
  db.query("UPDATE project SET target_repo = ? WHERE id = ?").run(repo, projectId);
  readyForReview(db, ticketId);
  const runner = new FakeAgentRunner(() => ({
    completed: true, exitCode: 0, stdout: "no block here", stderr: "",
    timedOut: false, costUsd: null, tokensIn: null, tokensOut: null,
  }));
  await advanceOneStep(db, ticketId, registryFor(repo, runner));
  const step = getByKey(db, ticketId, "review");
  const open = listOpenByTicket(db, ticketId);
  db.close();
  expect(step?.status).not.toBe("succeeded");
  expect(open.length).toBe(0);
});
```

> Implementer note: this test runs `advanceOneStep` WITHOUT the Task 5 verdict wiring in place if Tasks are done in order — the handler files findings and returns; the verdict integration is Task 5. The first test asserts only that findings are written with correct `blocks_ship`/`work_unit_id`, not the step's final status. Do not assert routing here.

- [ ] **Step 4: Register the handler**

In `src/dispatch/handlers.ts`, add imports (fold into existing aggregated import lines):

```typescript
import { insertFinding } from "../db/repos/review-finding.ts";
import { ReviewOutputSchema, computeBlocksShip, validateReviewFindings } from "./review-schema.ts";
import { REVIEW_TEMPLATE, reviewVars } from "./prompt-vars.ts";
import { listByTicket as listUnits } from "../db/repos/work-unit.ts";
```

Register inside `buildDispatchRegistry`, after `verify:integration` (or anywhere among the registrations):

```typescript
  registry.register("review", async (ctx: HandlerContext) => {
    const result = await runAgentDispatch(
      ctx,
      depsFor(ctx, deps, deps.timeoutMs ?? DESIGN_TIMEOUT_MS),
      {
        handlerKey: "review",
        template: REVIEW_TEMPLATE,
        vars: reviewVars(ctx.ticket, deps.profile),
        postcondition: () => {}, // read-only: nothing commits
      },
    );

    const parsed = extractSidecar(result.output, ReviewOutputSchema);
    if (!parsed.ok) {
      throw new Error(`review sidecar ${parsed.reason}: ${parsed.detail}`);
    }
    const units = listUnits(ctx.db, ctx.ticket.id);
    const seqToId = new Map(units.map((u) => [u.seq, u.id]));
    const errors = validateReviewFindings(parsed.value.findings, [...seqToId.keys()]);
    if (errors.length > 0) {
      throw new Error(`review findings invalid: ${errors.join("; ")}`);
    }

    let blocking = 0;
    for (const f of parsed.value.findings) {
      const blocksShip = computeBlocksShip(f.severity, f.deferral_candidate);
      if (blocksShip === 1) {
        blocking += 1;
      }
      insertFinding(ctx.db, {
        ticketId: ctx.ticket.id,
        reviewKind: "code",
        dispatchId: result.dispatchId,
        workUnitId: f.work_unit_seq === null ? null : (seqToId.get(f.work_unit_seq) ?? null),
        severity: f.severity,
        category: f.category,
        factorsJson: f.factors === null ? null : JSON.stringify(f.factors),
        deferralCandidate: f.deferral_candidate ? 1 : 0,
        blocksShip,
        location: f.location,
        rationale: f.rationale,
      });
    }
    return { findings: parsed.value.findings.length, blocking };
  });
```

(`DESIGN_TIMEOUT_MS` is already defined in this file and is the right order of magnitude for a deep review; reuse it.)

- [ ] **Step 5: Run tests + render check**

Run: `bun test test/dispatch/review-handler.test.ts && bun test test/dispatch/prompt-vars.test.ts`
Expected: PASS. If a `{{placeholder}}` is unresolved, add it to `reviewVars`.

- [ ] **Step 6: Commit**

```bash
git add prompts/review.md src/dispatch/prompt-vars.ts src/dispatch/handlers.ts test/dispatch/review-handler.test.ts
git commit -m "feat(m5b-1): review prompt + handler (findings sidecar → review_finding rows)"
```

---

### Task 4: Runtime config object + the verdict module

**Files:**
- Create: `src/config/runtime-config.ts`
- Modify: `src/db/repos/work-unit.ts`
- Create: `src/daemon/review-verdict.ts`
- Test: `test/daemon/review-verdict.test.ts`

**Interfaces:**
- Consumes: `latestReviewDispatchId`, `listByDispatch`, `setStatus` (review-finding repo); `getByKey`, `resetToPending`, `listStepsForUnit` (workflow-step); `setStatus as setUnitStatus`, `listByTicket as listUnits`, `deleteByTicket` (work-unit); `setTicketStage`, `setTicketStatus` (ticket); `insertPending as insertSignal` (signal); `appendEvent`, `listByTicket as listEvents` (event-log).
- Produces:
  - `src/config/runtime-config.ts` exports `OnPlanDefect` (type), `RuntimeConfigSchema` (zod), `RuntimeConfig` (inferred type), and `DEFAULT_RUNTIME_CONFIG: RuntimeConfig`. Runtime config object — NOT a profile field; NO file loader (deferred to the startup-entrypoint milestone). The schema's `.default(...)` IS the binary-defaults floor.
  - `work-unit.ts` gains `deleteByTicket(db, ticketId): void`.
  - `applyReviewVerdict(db, ticketId, config: RuntimeConfig): { decision: "clean" | "loopback" | "escalated" }` — reads `config.onPlanDefect`. Taking the whole object (not just the flag) keeps the verdict signature stable as policies grow.

**Verdict logic (exact):**
1. `dispatchId = latestReviewDispatchId(db, ticketId)`. If null → `{ decision: "clean" }` (no review round to judge).
2. `findings = listByDispatch(...)` filtered to `status='open'`. Partition: `blocking = blocks_ship===1`; `deferred = severity==='major' && deferral_candidate===1`.
3. If `blocking.length > 0`:
   - `signature = "review:" + blocking.map(f => `${f.category}:${f.location ?? ""}`).sort().join("|")`.
   - **No-progress guard:** if the previous `loopback` event with `loop ∈ {"implement","design"}` originating from review has the same `signature` → escalate (park on `human_resume`, reason "no progress: identical review findings"), return `{ decision: "escalated" }`.
   - If any blocking finding has `category==='plan-defect'`:
     - `onPlanDefect==='redesign'` → **redesign loopback** (below), `{ decision: "loopback" }`.
     - else → **escalate** to human (reason includes the plan-defect rationale), `{ decision: "escalated" }`.
   - else → **code loopback** (below), `{ decision: "loopback" }`.
4. Else if `deferred.length > 0` → **escalate** (reason: the deferral rationale), `{ decision: "escalated" }`.
5. Else → `{ decision: "clean" }`.

**Code loopback:** in one transaction — for each blocking code finding with a `work_unit_id`, set that unit `pending` and `resetToPending` all its steps; if any blocking code finding has a null `work_unit_id`, reset ALL units (conservative). Reset the `review` step (`getByKey(db,ticketId,"review")`) to pending. `setTicketStage(db,ticketId,"implement")`. `appendEvent(kind:"loopback", loop:"implement", routeTo:"review", signature)`. **Do NOT mutate finding status** — round isolation comes entirely from dispatch-scoping (the verdict reads only the latest review dispatch's findings, so a prior round's `open` findings are never re-read). This keeps the finding ledger append-only (M4 philosophy) and the `review_finding.status` CHECK untouched (NO schema change). [Operator decision: superseding was dropped as redundant.]

**Redesign loopback:** in one transaction — `deleteByTicket` (units; their findings cascade away via the `review_finding.work_unit_id ON DELETE CASCADE` FK), reset `design:dispatch`, `design:extract`, and `review` steps to pending, `setTicketStage(db,ticketId,"design")`, `appendEvent(kind:"loopback", loop:"design", routeTo:"review", signature)`. **Do NOT mutate finding status** (no superseding; no schema change) — ticket-level findings with a null `work_unit_id` simply stay on their (now-stale) review dispatch and are never re-read, since the next review round produces a new dispatch.

**Escalate:** in one transaction — `setTicketStatus(db,ticketId,"waiting")`, `insertSignal(human_resume, reason)`, `appendEvent(kind:"escalated", reason, signature)`. (Leave findings open so the inbox can show them.)

- [ ] **Step 1: Add the runtime-config object**

Create `src/config/runtime-config.ts` (a runtime operator config object — deliberately NOT in `Profile`; mirror the zod style of `src/config/agent-config.ts`):

```typescript
import { z } from "zod";

/** Daemon runtime config: operator policy knobs, threaded as one object through the loop.
 *  This is NOT the probed project Profile (product shape). The *values* live outside the target
 *  repo and are read at startup (workspace config.json > per-ticket), merged over the binary
 *  defaults below; that loader is built with the startup-entrypoint milestone. Here we define
 *  the object + its safe defaults so the seam is ready and callers thread a single object. */
export const RuntimeConfigSchema = z.object({
  // When code review finds a blocking PLAN-level defect: escalate to a human, or loop back to redesign.
  onPlanDefect: z.enum(["escalate", "redesign"]).default("escalate"),
});

export type RuntimeConfig = z.infer<typeof RuntimeConfigSchema>;
export type OnPlanDefect = RuntimeConfig["onPlanDefect"];

/** The binary-defaults floor of the config precedence chain. */
export const DEFAULT_RUNTIME_CONFIG: RuntimeConfig = RuntimeConfigSchema.parse({});
```

- [ ] **Step 2: Add `deleteByTicket`**

In `src/db/repos/work-unit.ts`:

```typescript
export function deleteByTicket(db: Database, ticketId: number): void {
  db.query("DELETE FROM work_unit WHERE ticket_id = ?").run(ticketId);
}
```

- [ ] **Step 3: Write the failing tests**

Create `test/daemon/review-verdict.test.ts`. Use a helper that seeds a review dispatch + findings directly (no agent), then calls `applyReviewVerdict`:

```typescript
import { expect, test } from "bun:test";
import { applyReviewVerdict } from "../../src/daemon/review-verdict.ts";
import { insertDispatch } from "../../src/db/repos/dispatch.ts";
import { listByTicket as listEvents } from "../../src/db/repos/event-log.ts";
import { insertFinding, listOpenByTicket } from "../../src/db/repos/review-finding.ts";
import { listPending } from "../../src/db/repos/signal.ts";
import { getTicket } from "../../src/db/repos/ticket.ts";
import { insertWorkUnit, listByTicket as listUnits } from "../../src/db/repos/work-unit.ts";
import { getByKey, insertPending } from "../../src/db/repos/workflow-step.ts";
import { makeTestDb } from "../helpers/db.ts";

function seedReviewRound(db: ReturnType<typeof makeTestDb>["db"], ticketId: number) {
  db.query("UPDATE ticket SET stage = 'review' WHERE id = ?").run(ticketId);
  const unit = insertWorkUnit(db, { ticketId, seq: 1, kind: "backend", behavioral: 0 });
  // a succeeded review step (the resolver would have run it)
  const s = insertPending(db, { ticketId, stepKey: "review", stepType: "dispatch" });
  db.query("UPDATE workflow_step SET status = 'succeeded' WHERE id = ?").run(s.id);
  const did = `T-d0001`;
  insertDispatch(db, { ticketId, dispatchId: did, seq: 1, stage: "review" });
  return { unit, did };
}

test("clean review (no findings) → decision clean", () => {
  const { db, ticketId } = makeTestDb();
  seedReviewRound(db, ticketId);
  const r = applyReviewVerdict(db, ticketId, { onPlanDefect: "escalate" });
  db.close();
  expect(r.decision).toBe("clean");
});

test("blocking code finding → loopback to implement (unit + review step reset, stage implement)", () => {
  const { db, ticketId } = makeTestDb();
  const { unit, did } = seedReviewRound(db, ticketId);
  insertFinding(db, { ticketId, reviewKind: "code", dispatchId: did, severity: "major", category: "correctness", deferralCandidate: 0, blocksShip: 1, workUnitId: unit.id, location: "a.ts:1" });
  const r = applyReviewVerdict(db, ticketId, { onPlanDefect: "escalate" });
  const ticket = getTicket(db, ticketId);
  const reviewStep = getByKey(db, ticketId, "review");
  const events = listEvents(db, ticketId);
  db.close();
  expect(r.decision).toBe("loopback");
  expect(ticket?.stage).toBe("implement");
  expect(listUnits(db === undefined ? db : db, ticketId)); // see note
  expect(reviewStep?.status).toBe("pending");
  expect(events.some((e) => e.kind === "loopback" && e.loop === "implement")).toBe(true);
});

test("blocking plan-defect, config escalate → escalated (parked on human_resume, stays open)", () => {
  const { db, ticketId } = makeTestDb();
  const { did } = seedReviewRound(db, ticketId);
  insertFinding(db, { ticketId, reviewKind: "code", dispatchId: did, severity: "critical", category: "plan-defect", deferralCandidate: 0, blocksShip: 1, location: null });
  const r = applyReviewVerdict(db, ticketId, { onPlanDefect: "escalate" });
  const ticket = getTicket(db, ticketId);
  const signals = listPending(db, ticketId);
  db.close();
  expect(r.decision).toBe("escalated");
  expect(ticket?.status).toBe("waiting");
  expect(signals.some((s) => s.signal_type === "human_resume")).toBe(true);
});

test("blocking plan-defect, config redesign → loopback to design (units cleared, design+review steps reset)", () => {
  const { db, ticketId } = makeTestDb();
  const { did } = seedReviewRound(db, ticketId);
  // seed the design steps the redesign route resets
  for (const k of ["design:dispatch", "design:extract"]) {
    const s = insertPending(db, { ticketId, stepKey: k, stepType: "dispatch" });
    db.query("UPDATE workflow_step SET status = 'succeeded' WHERE id = ?").run(s.id);
  }
  insertFinding(db, { ticketId, reviewKind: "code", dispatchId: did, severity: "major", category: "plan-defect", deferralCandidate: 0, blocksShip: 1, location: null });
  const r = applyReviewVerdict(db, ticketId, { onPlanDefect: "redesign" });
  const ticket = getTicket(db, ticketId);
  const units = listUnits(db, ticketId);
  const designStep = getByKey(db, ticketId, "design:dispatch");
  db.close();
  expect(r.decision).toBe("loopback");
  expect(ticket?.stage).toBe("design");
  expect(units.length).toBe(0);
  expect(designStep?.status).toBe("pending");
});

test("non-blocking major + deferral_candidate → escalated", () => {
  const { db, ticketId } = makeTestDb();
  const { did } = seedReviewRound(db, ticketId);
  insertFinding(db, { ticketId, reviewKind: "code", dispatchId: did, severity: "major", category: "maintainability", deferralCandidate: 1, blocksShip: 0, location: "a.ts:2" });
  const r = applyReviewVerdict(db, ticketId, { onPlanDefect: "escalate" });
  const ticket = getTicket(db, ticketId);
  db.close();
  expect(r.decision).toBe("escalated");
  expect(ticket?.status).toBe("waiting");
});
```

> Implementer note: fix the obvious placeholder in the loopback test (the `listUnits(db === undefined …)` line is a typo — replace it with the real assertions you need; the binding requirements are: `ticket.stage === "implement"`, the `review` step is `pending`, and a `loopback`/`loop="implement"` event exists). Read `test/daemon/` peers for the established assertion style. The redesign test seeds the design steps because the redesign route resets them.

- [ ] **Step 4: Write the verdict module**

Create `src/daemon/review-verdict.ts` implementing the exact logic above. Use `db.transaction(() => { … })()` for each mutation path (mirroring `applyFailurePolicy`). Reference `src/daemon/failure-policy.ts` for the escalate/loopback idioms (`setTicketStatus`, `insertSignal`, `appendEvent`, `resetToPending`, `listStepsForUnit`). Compute the no-progress guard by scanning `listEvents(db,ticketId)` for the last `loopback` event whose `loop ∈ {"implement","design"}` and comparing its `signature`.

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun test test/daemon/review-verdict.test.ts && bun run typecheck`
Expected: PASS (all five branches).

- [ ] **Step 6: Commit**

```bash
git add src/config/runtime-config.ts src/db/repos/work-unit.ts src/daemon/review-verdict.ts test/daemon/review-verdict.test.ts
git commit -m "feat(m5b-1): RuntimeConfig (onPlanDefect) + review verdict (loopback/escalate machinery)"
```

> Implementer note: `applyReviewVerdict`'s third arg is a `RuntimeConfig`. In M5b-1 `RuntimeConfig` has exactly one field, so the test literals `{ onPlanDefect: "escalate" }` / `{ onPlanDefect: "redesign" }` are complete `RuntimeConfig` values and typecheck directly. (When the object grows, prefer `{ ...DEFAULT_RUNTIME_CONFIG, onPlanDefect: "redesign" }`.)

---

### Task 5: Wire the verdict into the daemon loop

**Files:**
- Modify: `src/daemon/advance.ts`
- Modify: `src/daemon/loop.ts`
- Test: `test/daemon/advance.test.ts` (extend if present; else assert in the e2e of Task 6)

**Interfaces:**
- Consumes: `applyReviewVerdict`.
- Produces:
  - `advanceOneStep(db, ticketId, registry, opts?: { config?: RuntimeConfig })` — after the `review` step succeeds, calls `applyReviewVerdict(db, ticketId, opts?.config ?? DEFAULT_RUNTIME_CONFIG)`; if its decision is not `"clean"`, returns `{ kind: decision, stepKey: "review" }`; otherwise returns `{ kind: "stepped", stepKey: "review" }`.
  - `tick(db, registry, opts?: { maxConcurrent?: number; config?: RuntimeConfig })` — forwards `config` to `advanceOneStep`.
  - Both import `RuntimeConfig` + `DEFAULT_RUNTIME_CONFIG` from `src/config/runtime-config.ts` (thread the whole object — single source of truth; future policies don't change these signatures).

- [ ] **Step 1: Write the failing test**

Add to `test/daemon/advance.test.ts` (or the e2e in Task 6 if no such file): a test that seeds a `review` step + a blocking code finding's prerequisites, runs `advanceOneStep` so the (fake-runner) review handler files a blocking finding, and asserts the returned outcome is `{ kind: "loopback", stepKey: "review" }` and the stage is `implement`. (If this is more naturally an e2e, defer it to Task 6 and note here.)

- [ ] **Step 2: Modify `advance.ts`**

Change the signature and the post-`runStep` success path:

```typescript
export async function advanceOneStep(
  db: Database,
  ticketId: number,
  registry: StepRegistry,
  opts?: { config?: RuntimeConfig },
): Promise<AdvanceOutcome> {
```

and in the `try` block, after `runStep(...)` resolves:

```typescript
      await runStep(db, { /* …unchanged… */ });
      if (d.stepKey === "review") {
        const { decision } = applyReviewVerdict(db, ticketId, opts?.config ?? DEFAULT_RUNTIME_CONFIG);
        if (decision !== "clean") {
          return { kind: decision, stepKey: d.stepKey };
        }
      }
      return { kind: "stepped", stepKey: d.stepKey };
```

Add the imports: `import { applyReviewVerdict } from "./review-verdict.ts";` and `import { DEFAULT_RUNTIME_CONFIG, type RuntimeConfig } from "../config/runtime-config.ts";`.

- [ ] **Step 3: Modify `loop.ts`**

Thread the config object through `tick` (import `RuntimeConfig` from `../config/runtime-config.ts`):

```typescript
export async function tick(
  db: Database,
  registry: StepRegistry,
  opts?: { maxConcurrent?: number; config?: RuntimeConfig },
): Promise<{ advanced: number }> {
  const max = opts?.maxConcurrent ?? DEFAULT_MAX_CONCURRENT;
  const ids = readyTicketIds(db).slice(0, max);
  let advanced = 0;
  for (const id of ids) {
    await advanceOneStep(db, id, registry, { config: opts?.config });
    advanced++;
  }
  return { advanced };
}
```

- [ ] **Step 4: Run the full suite**

Run: `bun test && bun run typecheck`
Expected: PASS. The `review` special-case only fires for the `review` step; all existing flows (which never reached a real `review` handler) are unaffected. The walking-skeleton test registers its own mock `review` returning `{findings:0}` and files no `review_finding` rows → `latestReviewDispatchId` finds no `stage='review'` dispatch (the mock doesn't call `runAgentDispatch`) → verdict `clean` → advances to merge unchanged. Confirm walking-skeleton still passes.

- [ ] **Step 5: Commit**

```bash
git add src/daemon/advance.ts src/daemon/loop.ts test/daemon/advance.test.ts
git commit -m "feat(m5b-1): wire review verdict into advanceOneStep + tick"
```

---

### Task 6: End-to-end review flows

**Files:**
- Test: `test/dispatch/review-e2e.test.ts`

**Interfaces:**
- Consumes: the whole stack (`buildDispatchRegistry`, `advanceOneStep`, the verdict).
- Produces: no source change — behavioral guards.

Cover these flows with the `FakeAgentRunner` + real temp git repo harness (mirror `verify-routing-e2e.test.ts`):

1. **Clean review → merge.** Ticket at `review` with a verified unit; review files `{findings:[]}`. Drive `advanceOneStep` a few times; assert the ticket advances out of `review` (stage becomes `merge`) and no `review_finding` rows exist.
2. **Blocking code finding → re-code → clean → merge.** First review round files one blocking `major`/`correctness` finding on unit 1; assert stage returns to `implement` and the `review` step reset to pending. Then make the fake runner file `{findings:[]}` on the next review round; drive to merge; assert the ticket reaches `merge`. Round isolation is via dispatch-scoping: the second (clean) review round produces a NEW review dispatch with zero findings, so the verdict reads `clean` and advances — the first round's finding stays `open` on its own (older) dispatch and is never re-read. Do NOT assert any finding became `superseded` (superseding was dropped; findings stay `open`).
3. **Plan-defect, default config (escalate) → parked.** Review files a blocking `plan-defect` finding; with default `onPlanDefect` (escalate), assert the outcome is `escalated`, the ticket is `waiting`, and a `human_resume` signal is pending.
4. **Plan-defect, config redesign → back to design.** Same finding but `advanceOneStep(..., { config: { onPlanDefect: "redesign" } })`; assert stage becomes `design` and `work_unit` rows were cleared.
5. **Major + deferral_candidate → escalated.** Review files a single `major` finding with `deferral_candidate: true`; assert `escalated` + `waiting` + `human_resume` signal.

- [ ] **Step 1: Write the e2e tests** (one `test(...)` per flow above; assert the binding facts named).

- [ ] **Step 2: Run**

Run: `bun test test/dispatch/review-e2e.test.ts`
Expected: PASS (all five).

- [ ] **Step 3: Commit**

```bash
git add test/dispatch/review-e2e.test.ts
git commit -m "test(m5b-1): e2e review verdict flows (clean/re-code/escalate/redesign/defer)"
```

---

## Final Verification (before PR)

- [ ] Full gate fresh: `bun test && bun run lint && bun run typecheck && bun run build` — all pass; binary builds (re-signs on macOS).
- [ ] Whole-branch review on the most capable model; fix any Critical/Important.
- [ ] `finishing-a-development-branch`: push `feat/m5b-review-gates`, open PR into `main`. **Do not merge** — the operator merges.
- [ ] Watch CI to green.

## Carries into M5b-2 (do not drop)

- **`design:review` (S1c)** + real **fast/full track sizing** (replaces M5a's hardcoded `track="fast"`), reusing this verdict module. design:review files `review_kind='plan'` findings; its blocking verdict routes through the SAME `onPlanDefect` config hook (a blocking plan finding at design time → re-design or escalate).
- **Generalize the verdict trigger:** `advance.ts` currently special-cases `d.stepKey === "review"`. M5b-2 adds `design:review` and should generalize (e.g. a verdict-bearing step set) rather than add a second special-case.
- **V6 cross-round persistence:** the no-progress guard here compares only the immediately-previous review loopback signature. The richer "same `finding_class_key` persists N cold rounds → escalate" (control-loop §8 V6) is deferred; `finding_class_key` is currently left null by the handler — populate it in M5b-2 when the persistence counter lands.
- **Finding→unit attribution:** code loopback resets units referenced by `work_unit_seq`, falling back to ALL units when a blocking finding is ticket-level (null). Revisit if this proves too coarse.
- **Config source wiring (startup-entrypoint / config milestone):** M5b-1 threads a `RuntimeConfig` object that, with no external source yet, falls back to `DEFAULT_RUNTIME_CONFIG`. When the `styre daemon`/`run` entrypoint lands, build the loader there: read the workspace `config.json` (XDG, outside the target repo) + per-ticket overrides, `RuntimeConfigSchema.parse`/merge over the defaults, and pass the resulting object into `tick`. Do NOT bake any of this into `Profile`. The object seam already exists — only the loader is added.

## Self-Review

- **Spec coverage:** review handler files findings (T3); daemon-computed blocks_ship (T2/T3); verdict routing clean/code-loopback/plan-route/defer-escalate (T4); config-gated plan route, default escalate (T4 profile + verdict); daemon integration (T5); e2e for every route (T6). Covered.
- **Invariants:** only-daemon-writes (handler inserts; agent read-only allowlist already set); ground-truth (blocks_ship daemon-computed, verdict from ledger); transport-failure throw on absent/malformed sidecar (T3); resolver untouched (verdict in advance.ts); runtime policy stays OUT of the probed `Profile` (lives in `src/config/runtime-config.ts` as a threaded `RuntimeConfig` object, like `AgentConfig`). Held.
- **Placeholder scan:** the one deliberate typo in the T4 loopback test is called out in an implementer note with the exact assertions to use. All other steps carry complete code.
- **Type consistency:** `insertFinding` param names (T1) match the handler call (T3) and verdict reads (T4); `computeBlocksShip`/`validateReviewFindings` signatures (T2) match their callers (T3); `applyReviewVerdict(db, ticketId, config)` (T4) matches `advance.ts` (T5); `RuntimeConfig`/`DEFAULT_RUNTIME_CONFIG` from `src/config/runtime-config.ts` are the single source threaded `tick`→`advanceOneStep`→`applyReviewVerdict` (no inline enum literals in the loop, not in `Profile`).

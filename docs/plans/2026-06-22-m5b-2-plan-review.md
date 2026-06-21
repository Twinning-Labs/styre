# M5b-2 — Plan Review (`design:review` / S1c) + Track Sizing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the upfront plan reviewer (`design:review`, S1c) — a cold, read-only reviewer that grades the plan before any code is written and loops back to re-design on a blocking finding — plus the **deterministic sprawl-only track sizer** that decides which tickets get it (`full`) and which skip it (`fast`).

**Architecture:** `design:review` mirrors the M5b-1 code-review gate exactly (read-only agent → `extractSidecar` → daemon-computed findings in `review_finding`), but files `review_kind='plan'`, reviews the *plan doc + requirements + codebase* (NOT a diff, NOT the designer's reasoning — anti-anchoring), and its verdict routes a blocking finding to **re-design** (always — at design time no code exists, so redoing the plan is the natural fix). The M5b-1 verdict engine is reused: the dispatch lookup generalizes from stage-keyed to **step-keyed** (cleanly separating plan findings from code findings), the verdict trigger in `advanceOneStep` generalizes to a verdict-bearing-step set, and the existing `redesignLoopback` gains `design:review` in its reset list. Track is sized deterministically from the validated work-breakdown at `design:extract` time.

**Tech Stack:** TypeScript + Bun + `bun:sqlite`; zod; the existing `runAgentDispatch` / `extractSidecar` / `applyReviewVerdict` / `review_finding` machinery + `FakeAgentRunner` test harness.

## Global Constraints

- **Never commit to `main`.** Work on branch `feat/m5b-2-plan-review` (already created).
- **Only the daemon writes the SoT.** `design:review`'s agent gets read-only tools (its allowlist is already `[Read, Grep, Glob]`); all `review_finding` inserts are daemon-side. `blocks_ship` is daemon-computed (`computeBlocksShip`), never reviewer-filed.
- **Ground truth over self-report.** The verdict is derived from the `review_finding` ledger, never an agent pass/fail. An absent/malformed sidecar is a transport failure (throw → re-dispatch), never a clean review.
- **`design:review` verdict (control-loop S1c / DV1):** any **blocking** plan finding → loop back to **re-design** (always — NO `onPlanDefect` gate; re-design is the cheap, natural action at design time); a repeated identical blocking round → escalate (no-progress backstop); else → advance to implement. Plan review acts only on blocking findings — there is no deferral-escalate path for plan findings (deferral is a code-ship concept).
- **Track sizing (operator decision, 2026-06-22):** **deterministic sprawl-only** for M5b-2 — `full` when the validated breakdown has **≥ 2 work units**, else `fast`. (≥2 subsumes multi-kind, since a unit has one kind.) The threshold is a **named constant**, provisional and tunable. A **per-ticket override seam**: if the ticket's `track` is already set, respect it; else compute. The complexity-grader (cold cheap-tier agent, behind a `RuntimeConfig` flag, default off) is an explicit **follow-up milestone (M5b-3)** — do NOT build it here.
- Run the full gate before claiming done: `bun test` · `bun run lint` · `bun run typecheck` · `bun run build`. **Every task's gate includes `bun run lint`.**
- **No schema change.** `review_finding` (incl. `review_kind`), the `track` CHECK (`'fast'|'full'`), and `dispatch` (incl. `step_id`) all already exist. If a change becomes necessary, edit BOTH `src/db/schema.sql` and `docs/architecture/schema.sql` (the dual-schema rule).

---

## File Structure

- **Create** `src/dispatch/track-sizing.ts` — `sizeTrack(units)` (the deterministic sprawl-only rubric + the threshold constant).
- **Modify** `src/dispatch/handlers.ts` — `design:extract` calls `sizeTrack` instead of hardcoding `"fast"`; register the new `design:review` handler.
- **Create** `prompts/design-review.md` — the cold plan-review prompt.
- **Modify** `src/dispatch/prompt-vars.ts` — add `DESIGN_REVIEW_TEMPLATE` + `designReviewVars`.
- **Modify** `src/db/repos/review-finding.ts` — replace `latestReviewDispatchId(db, ticketId)` (stage-keyed) with `latestDispatchForStep(db, ticketId, stepKey)` (step-keyed join).
- **Modify** `src/daemon/review-verdict.ts` — `applyReviewVerdict` takes the triggering `stepKey`; branch plan-review vs code-review routing; add `design:review` to `redesignLoopback`'s reset list.
- **Modify** `src/daemon/advance.ts` — generalize the verdict trigger from `stepKey === "review"` to a `VERDICT_BEARING_STEPS` set; pass `stepKey` into the verdict.
- **Tests:** `test/dispatch/track-sizing.test.ts`, `test/dispatch/design-review-handler.test.ts`, `test/db/repos/review-finding.test.ts` (extend), `test/daemon/review-verdict.test.ts` (extend), `test/dispatch/design-review-e2e.test.ts`; update `test/dispatch/design-extract.test.ts` (track expectation).

---

### Task 1: Deterministic sprawl-only track sizer

**Files:**
- Create: `src/dispatch/track-sizing.ts`
- Modify: `src/dispatch/handlers.ts` (the `design:extract` handler)
- Test: `test/dispatch/track-sizing.test.ts`
- Modify: `test/dispatch/design-extract.test.ts` (the M5a test asserts `track==="fast"` for a 2-unit extraction — now `"full"`)

**Interfaces:**
- Consumes: `WorkUnitRow` (from `src/db/repos/work-unit.ts`); `setTicketTrack` (already imported in handlers.ts).
- Produces:
  - `FULL_TRACK_MIN_UNITS = 2` (exported const).
  - `sizeTrack(units: { id: number }[]): "fast" | "full"` — `units.length >= FULL_TRACK_MIN_UNITS ? "full" : "fast"`.

- [ ] **Step 1: Write the failing test**

Create `test/dispatch/track-sizing.test.ts`:

```typescript
import { expect, test } from "bun:test";
import { sizeTrack } from "../../src/dispatch/track-sizing.ts";

test("a single work unit is fast-track", () => {
  expect(sizeTrack([{ id: 1 }])).toBe("fast");
});

test("two or more work units is full-track", () => {
  expect(sizeTrack([{ id: 1 }, { id: 2 }])).toBe("full");
  expect(sizeTrack([{ id: 1 }, { id: 2 }, { id: 3 }])).toBe("full");
});

test("an empty breakdown is fast-track (degenerate; extract guarantees >=1)", () => {
  expect(sizeTrack([])).toBe("fast");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/dispatch/track-sizing.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

Create `src/dispatch/track-sizing.ts`:

```typescript
/** Deterministic, sprawl-only track sizing (M5b-2). full-track tickets get the upfront plan
 *  review (design:review, S1c); fast-track skips straight to implement. "Sprawl" = the size of
 *  the validated work-breakdown. Complexity-aware sizing (a cold grader behind a config flag) is
 *  the M5b-3 follow-up. The threshold is provisional and tunable. */
export const FULL_TRACK_MIN_UNITS = 2;

export function sizeTrack(units: { id: number }[]): "fast" | "full" {
  return units.length >= FULL_TRACK_MIN_UNITS ? "full" : "fast";
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/dispatch/track-sizing.test.ts`
Expected: PASS.

- [ ] **Step 5: Wire `sizeTrack` into `design:extract`**

In `src/dispatch/handlers.ts`, in the `design:extract` handler, replace the hardcoded track line:

```typescript
    // M5a: always fast-track. Real fast/full sizing + design:review land together in M5b.
    setTicketTrack(ctx.db, ctx.ticket.id, "fast");
```

with (the per-ticket override seam — respect an explicitly-set track, else size it):

```typescript
    // M5b-2: size the track from the validated breakdown (sprawl-only). An explicitly-set
    // track (per-ticket override) wins; the complexity grader is the M5b-3 follow-up.
    const track = ctx.ticket.track ?? sizeTrack(parsed.value.units);
    setTicketTrack(ctx.db, ctx.ticket.id, track);
```

Add the import near the other `./` dispatch imports in handlers.ts:

```typescript
import { sizeTrack } from "./track-sizing.ts";
```

(`parsed.value.units` is the validated extract output already in scope in that handler; it has length == the number of inserted units. Using it avoids a re-query.)

- [ ] **Step 6: Update the M5a extract test's track expectation**

Open `test/dispatch/design-extract.test.ts`. The M5a "carry" test inserts **2** units and asserts `ticket?.track` is `"fast"`. With the sizer, a 2-unit extraction is now `"full"`. Update that assertion to `expect(ticket?.track).toBe("full")`. If any other test there asserts the track value, reconcile it against `sizeTrack` (1 unit → fast, ≥2 → full). Do NOT weaken any other assertion.

- [ ] **Step 7: Run the full suite**

Run: `bun test && bun run lint && bun run typecheck`
Expected: PASS. The walking-skeleton test sets `track="fast"` via its own mock extract (not the real handler) and is unaffected.

- [ ] **Step 8: Commit**

```bash
git add src/dispatch/track-sizing.ts src/dispatch/handlers.ts test/dispatch/track-sizing.test.ts test/dispatch/design-extract.test.ts
git commit -m "feat(m5b-2): deterministic sprawl-only track sizer wired into design:extract"
```

---

### Task 2: The `design:review` prompt + handler

**Files:**
- Create: `prompts/design-review.md`
- Modify: `src/dispatch/prompt-vars.ts`
- Modify: `src/dispatch/handlers.ts`
- Test: `test/dispatch/design-review-handler.test.ts`

**Interfaces:**
- Consumes: `runAgentDispatch`, `extractSidecar`, `ReviewOutputSchema`, `validateReviewFindings`, `computeBlocksShip`, `insertFinding`, `listByTicket as listUnits`, `DESIGN_REVIEW_TEMPLATE`, `designReviewVars`.
- Produces:
  - `DESIGN_REVIEW_TEMPLATE: string`; `designReviewVars(ticket, profile): Record<string,string>` covering every template placeholder (`ident`, `title`, `slug`, `...profile.promptVars`).
  - A registered `"design:review"` handler: read-only agent → extract + validate findings → insert each with `reviewKind: "plan"`, daemon-computed `blocks_ship`, `dispatch_id`, `work_unit_id` mapped from `work_unit_seq`. Returns `{ findings: number, blocking: number }`. (Identical in shape to the `review` handler, differing only in `reviewKind`, template, and vars.)

- [ ] **Step 1: Create the prompt file**

Create `prompts/design-review.md`:

```markdown
You are the independent plan reviewer for ticket {{ident}} ("{{title}}") in project {{slug}}.

A design plan has been written and committed under `docs/plans/`, and it has been decomposed into
work units. No code has been written yet. Review the PLAN on its own terms — read the plan, the
ticket requirements, and the codebase it will touch. You did not write this plan; judge it cold.
Do NOT read it as "what the designer intended" — judge what is actually on the page. Do NOT modify
any files; your only output is the findings sidecar below.

Grade the plan across these dimensions and file a finding for each real problem:
- **feasibility** — will this approach actually work against the real codebase?
- **completeness** — does the plan cover the ticket's requirements, with no missing substance?
- **consistency** — are the steps internally consistent (no contradictions, no dangling refs)?
- **scope** — is it over- or under-scoped for the ticket?
- **testability** — can the behavioral work units actually be tested as described?
- **decomposition** — is the breakdown into work units sound (right boundaries, sane dependencies)?

For each finding provide:
- **severity**: `critical` (the plan is broken/unsafe — must not be built), `major` (should not be
  built as-is), `minor` (worth fixing, non-blocking), `nit` (trivial). Do not inflate or deflate.
- **category**: one of the dimensions above (e.g. `feasibility`, `decomposition`).
- **location**: `file:line` or a plan section, or null if plan-wide.
- **rationale**: one or two sentences on what is wrong and why it matters.
- **factors**: an object of booleans for context, or null.
- **deferral_candidate**: leave `false` for plan review (deferral is a code-ship concept).
- **work_unit_seq**: the seq of the work unit a finding is about, or null if plan-wide.

If the plan is sound, return an empty `findings` array. Do NOT pass or fail the plan yourself — the
system decides from your findings. Emit exactly one fenced block:

```styre-sidecar
{
  "findings": [
    {
      "severity": "major",
      "category": "decomposition",
      "location": "docs/plans/ENG-1-plan.md:Task 3",
      "rationale": "…",
      "factors": null,
      "deferral_candidate": false,
      "work_unit_seq": 3
    }
  ]
}
```
```

- [ ] **Step 2: Wire the template + vars**

In `src/dispatch/prompt-vars.ts`, mirror the `REVIEW_TEMPLATE`/`reviewVars` pair:

```typescript
import designReviewTemplate from "../../prompts/design-review.md" with { type: "text" };
// …existing imports…

export const DESIGN_REVIEW_TEMPLATE = designReviewTemplate;

export function designReviewVars(
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

Create `test/dispatch/design-review-handler.test.ts`. Reuse the `gitRepo()` + `registryFor()` harness from `test/dispatch/review-handler.test.ts` (copy the two helpers). Stage the ticket at `design` with extracted units so the resolver routes to `design:review`:

```typescript
import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeAgentRunner } from "../../src/agent/fake-runner.ts";
import { DEFAULT_AGENT_CONFIG } from "../../src/config/agent-config.ts";
import { advanceOneStep } from "../../src/daemon/advance.ts";
import { listOpenByTicket } from "../../src/db/repos/review-finding.ts";
import { setTicketTrack } from "../../src/db/repos/ticket.ts";
import { insertWorkUnit } from "../../src/db/repos/work-unit.ts";
import { getByKey, insertPending } from "../../src/db/repos/workflow-step.ts";
import { buildDispatchRegistry } from "../../src/dispatch/handlers.ts";
import { parseProfile } from "../../src/dispatch/profile.ts";
import { makeTestDb } from "../helpers/db.ts";

function gitRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "styre-dr-"));
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
    worktreeRoot: mkdtempSync(join(tmpdir(), "styre-drwt-")),
  });
}

const sidecar = (json: string) => `Reviewed the plan.\n\n\`\`\`styre-sidecar\n${json}\n\`\`\`\n`;

// design:dispatch succeeded + units present + track=full → resolver routes to design:review.
function readyForDesignReview(db: ReturnType<typeof makeTestDb>["db"], ticketId: number) {
  const s = insertPending(db, { ticketId, stepKey: "design:dispatch", stepType: "dispatch" });
  db.query("UPDATE workflow_step SET status = 'succeeded' WHERE id = ?").run(s.id);
  insertWorkUnit(db, { ticketId, seq: 1, kind: "backend", behavioral: 0, verifyCheckTypes: ["test"] });
  insertWorkUnit(db, { ticketId, seq: 2, kind: "backend", behavioral: 0, verifyCheckTypes: ["test"] });
  setTicketTrack(db, ticketId, "full");
}

test("design:review files plan findings with review_kind=plan and daemon-computed blocks_ship", async () => {
  const { db, ticketId, projectId } = makeTestDb();
  const repo = gitRepo();
  db.query("UPDATE project SET target_repo = ? WHERE id = ?").run(repo, projectId);
  readyForDesignReview(db, ticketId);
  const runner = new FakeAgentRunner(() => ({
    completed: true,
    exitCode: 0,
    stdout: sidecar(
      JSON.stringify({
        findings: [
          { severity: "major", category: "decomposition", location: "plan:Task 2", rationale: "split", factors: null, deferral_candidate: false, work_unit_seq: 2 },
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
  const step = getByKey(db, ticketId, "design:review");
  db.close();
  expect(open.length).toBe(1);
  expect(open[0]?.review_kind).toBe("plan");
  expect(open[0]?.blocks_ship).toBe(1); // major, not deferred → daemon-computed blocker
  expect(open[0]?.work_unit_id).not.toBeNull(); // mapped from work_unit_seq=2
  expect(step).not.toBeNull();
});

test("design:review throws on an absent sidecar (transport failure)", async () => {
  const { db, ticketId, projectId } = makeTestDb();
  const repo = gitRepo();
  db.query("UPDATE project SET target_repo = ? WHERE id = ?").run(repo, projectId);
  readyForDesignReview(db, ticketId);
  const runner = new FakeAgentRunner(() => ({
    completed: true, exitCode: 0, stdout: "no block", stderr: "",
    timedOut: false, costUsd: null, tokensIn: null, tokensOut: null,
  }));
  await advanceOneStep(db, ticketId, registryFor(repo, runner));
  const step = getByKey(db, ticketId, "design:review");
  const open = listOpenByTicket(db, ticketId);
  db.close();
  expect(step?.status).not.toBe("succeeded");
  expect(open.length).toBe(0);
});
```

> Implementer note: this test runs BEFORE the verdict is wired for `design:review` (Tasks 4–5), so it asserts only that findings are written (not routing). `advanceOneStep` runs the handler via the resolver's existing `design:review` routing (gated on `track==='full'`, already present). Confirm `makeTestDb`'s return shape and the failed-step assertion style against `review-handler.test.ts`.

- [ ] **Step 4: Register the handler**

In `src/dispatch/handlers.ts`, add imports (fold into existing aggregated lines):

```typescript
import { DESIGN_REVIEW_TEMPLATE, designReviewVars } from "./prompt-vars.ts";
```

(`insertFinding`, `ReviewOutputSchema`, `computeBlocksShip`, `validateReviewFindings`, `listUnits` are already imported by the `review` handler.)

Register inside `buildDispatchRegistry` (place it near the `design:extract`/`review` registrations):

```typescript
  registry.register("design:review", async (ctx: HandlerContext) => {
    const result = await runAgentDispatch(
      ctx,
      depsFor(ctx, deps, deps.timeoutMs ?? DESIGN_TIMEOUT_MS),
      {
        handlerKey: "design:review",
        template: DESIGN_REVIEW_TEMPLATE,
        vars: designReviewVars(ctx.ticket, deps.profile),
        postcondition: () => {}, // read-only: nothing commits
      },
    );

    const parsed = extractSidecar(result.output, ReviewOutputSchema);
    if (!parsed.ok) {
      throw new Error(`design:review sidecar ${parsed.reason}: ${parsed.detail}`);
    }
    const units = listUnits(ctx.db, ctx.ticket.id);
    const seqToId = new Map(units.map((u) => [u.seq, u.id]));
    const errors = validateReviewFindings(parsed.value.findings, [...seqToId.keys()]);
    if (errors.length > 0) {
      throw new Error(`design:review findings invalid: ${errors.join("; ")}`);
    }

    let blocking = 0;
    for (const f of parsed.value.findings) {
      const blocksShip = computeBlocksShip(f.severity, f.deferral_candidate);
      if (blocksShip === 1) {
        blocking += 1;
      }
      insertFinding(ctx.db, {
        ticketId: ctx.ticket.id,
        reviewKind: "plan",
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

- [ ] **Step 5: Run tests + render check**

Run: `bun test test/dispatch/design-review-handler.test.ts && bun test test/dispatch/prompt-vars.test.ts && bun run lint`
Expected: PASS. If a `{{placeholder}}` is unresolved, add it to `designReviewVars`.

- [ ] **Step 6: Commit**

```bash
git add prompts/design-review.md src/dispatch/prompt-vars.ts src/dispatch/handlers.ts test/dispatch/design-review-handler.test.ts
git commit -m "feat(m5b-2): design:review prompt + handler (plan findings → review_finding rows)"
```

---

### Task 3: Step-keyed dispatch lookup (separate plan findings from code findings)

The verdict must read the *latest plan-review round* (for `design:review`) distinctly from the *latest code-review round* (for `review`). The M5b-1 lookup keys on `stage='review'`, which is fine for code review but not for plan review (`design:dispatch`/`design:extract`/`design:review` all run in `stage='design'`). Generalize to a **step-keyed** lookup via the `dispatch.step_id → workflow_step.step_key` join. This also resolves the M5b-1 carry ("scope the lookup by kind").

**Files:**
- Modify: `src/db/repos/review-finding.ts`
- Test: `test/db/repos/review-finding.test.ts` (extend)

**Interfaces:**
- Consumes: the `dispatch` + `workflow_step` tables.
- Produces: `latestDispatchForStep(db, ticketId, stepKey): string | null` — the `dispatch_id` of the most recent dispatch whose owning `workflow_step.step_key` equals `stepKey` (highest `dispatch.seq`). **Replaces** `latestReviewDispatchId` (remove it; update its one caller in Task 4).

- [ ] **Step 1: Write the failing test**

Add to `test/db/repos/review-finding.test.ts`:

```typescript
import { latestDispatchForStep } from "../../../src/db/repos/review-finding.ts";
import { insertDispatch } from "../../../src/db/repos/dispatch.ts";
import { insertPending } from "../../../src/db/repos/workflow-step.ts";

test("latestDispatchForStep returns the newest dispatch owned by that step_key", () => {
  const { db, ticketId } = makeTestDb();
  // a design:review step + two dispatches owned by it; and a 'review' step + dispatch (must NOT match)
  const drStep = insertPending(db, { ticketId, stepKey: "design:review", stepType: "dispatch" });
  insertDispatch(db, { ticketId, dispatchId: "T-d0001", seq: 1, stepId: drStep.id, stage: "design" });
  insertDispatch(db, { ticketId, dispatchId: "T-d0002", seq: 2, stepId: drStep.id, stage: "design" });
  const crStep = insertPending(db, { ticketId, stepKey: "review", stepType: "dispatch" });
  insertDispatch(db, { ticketId, dispatchId: "T-d0003", seq: 3, stepId: crStep.id, stage: "review" });
  const dr = latestDispatchForStep(db, ticketId, "design:review");
  const cr = latestDispatchForStep(db, ticketId, "review");
  const none = latestDispatchForStep(db, ticketId, "merge:push");
  db.close();
  expect(dr).toBe("T-d0002"); // newest design:review dispatch, not the 'review' one
  expect(cr).toBe("T-d0003");
  expect(none).toBeNull();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/db/repos/review-finding.test.ts`
Expected: FAIL — `latestDispatchForStep` not exported.

- [ ] **Step 3: Replace the lookup**

In `src/db/repos/review-finding.ts`, remove `latestReviewDispatchId` and add:

```typescript
/** The dispatch_id of the most recent dispatch owned by the given step (joined via
 *  dispatch.step_id → workflow_step.step_key, highest dispatch.seq). Lets the verdict scope a
 *  review round precisely — design:review (plan) and review (code) are distinguished by step,
 *  even though several steps share a stage. Clean round (0 findings) still resolves via the
 *  dispatch row, so it is not re-judged against a prior round. */
export function latestDispatchForStep(
  db: Database,
  ticketId: number,
  stepKey: string,
): string | null {
  const row = db
    .query<{ dispatch_id: string }, [number, string]>(
      `SELECT d.dispatch_id FROM dispatch d
         JOIN workflow_step w ON d.step_id = w.id
        WHERE d.ticket_id = ? AND w.step_key = ?
        ORDER BY d.seq DESC LIMIT 1`,
    )
    .get(ticketId, stepKey);
  return row?.dispatch_id ?? null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/db/repos/review-finding.test.ts && bun run typecheck`
Expected: the new test PASSES. `typecheck` will FAIL at the old `latestReviewDispatchId` import in `review-verdict.ts` — that is fixed in Task 4. (If you want a green checkpoint now, do Task 4 before re-running the full suite.)

- [ ] **Step 5: Commit**

```bash
git add src/db/repos/review-finding.ts test/db/repos/review-finding.test.ts
git commit -m "feat(m5b-2): step-keyed dispatch lookup (latestDispatchForStep)"
```

---

### Task 4: Generalize the verdict for plan review

`applyReviewVerdict` learns which review triggered it (`stepKey`), scopes findings via `latestDispatchForStep`, and branches: **plan review** (`design:review`) → any blocking finding loops to **re-design** (no-progress → escalate; else clean); **code review** (`review`) → the existing M5b-1 routing. Also add `design:review` to `redesignLoopback`'s reset list so the new plan re-runs through review.

**Files:**
- Modify: `src/daemon/review-verdict.ts`
- Test: `test/daemon/review-verdict.test.ts` (extend)

**Interfaces:**
- Consumes: `latestDispatchForStep` (Task 3).
- Produces: `applyReviewVerdict(db, ticketId, config, opts: { stepKey: string }): ReviewVerdictResult`. (The `stepKey` arg is new; the code-review call passes `"review"`, the plan-review call passes `"design:review"`.)

- [ ] **Step 1: Write the failing tests**

Add to `test/daemon/review-verdict.test.ts` (reuse its existing seed helpers; seed a `design:review` step + dispatch so `latestDispatchForStep(..., "design:review")` resolves):

```typescript
test("plan review: a blocking plan finding loops back to re-design", () => {
  const { db, ticketId } = makeTestDb();
  db.query("UPDATE ticket SET stage = 'design', track = 'full' WHERE id = ?").run(ticketId);
  insertWorkUnit(db, { ticketId, seq: 1, kind: "backend", behavioral: 0 });
  for (const k of ["design:dispatch", "design:extract", "design:review"]) {
    const s = insertPending(db, { ticketId, stepKey: k, stepType: "dispatch" });
    db.query("UPDATE workflow_step SET status = 'succeeded' WHERE id = ?").run(s.id);
  }
  const drStep = getByKey(db, ticketId, "design:review");
  const did = "T-dr01";
  insertDispatch(db, { ticketId, dispatchId: did, seq: 1, stepId: drStep!.id, stage: "design" });
  insertFinding(db, { ticketId, reviewKind: "plan", dispatchId: did, severity: "critical", category: "feasibility", deferralCandidate: 0, blocksShip: 1, location: "plan:1" });
  const r = applyReviewVerdict(db, ticketId, DEFAULT_RUNTIME_CONFIG, { stepKey: "design:review" });
  const ticket = getTicket(db, ticketId);
  const units = listUnits(db, ticketId);
  const drAfter = getByKey(db, ticketId, "design:review");
  db.close();
  expect(r.decision).toBe("loopback");
  expect(ticket?.stage).toBe("design");
  expect(units.length).toBe(0);           // deleteByTicket cleared units for a fresh re-extract
  expect(drAfter?.status).toBe("pending"); // design:review reset so the NEW plan is re-reviewed
});

test("plan review: a clean round advances (no blocking findings)", () => {
  const { db, ticketId } = makeTestDb();
  db.query("UPDATE ticket SET stage = 'design', track = 'full' WHERE id = ?").run(ticketId);
  const s = insertPending(db, { ticketId, stepKey: "design:review", stepType: "dispatch" });
  db.query("UPDATE workflow_step SET status = 'succeeded' WHERE id = ?").run(s.id);
  insertDispatch(db, { ticketId, dispatchId: "T-dr02", seq: 1, stepId: s.id, stage: "design" });
  // no findings filed → clean
  const r = applyReviewVerdict(db, ticketId, DEFAULT_RUNTIME_CONFIG, { stepKey: "design:review" });
  db.close();
  expect(r.decision).toBe("clean");
});

test("plan review: repeated identical blocking round escalates (no-progress)", () => {
  const { db, ticketId } = makeTestDb();
  db.query("UPDATE ticket SET stage = 'design', track = 'full' WHERE id = ?").run(ticketId);
  const s = insertPending(db, { ticketId, stepKey: "design:review", stepType: "dispatch" });
  db.query("UPDATE workflow_step SET status = 'succeeded' WHERE id = ?").run(s.id);
  const did = "T-dr03";
  insertDispatch(db, { ticketId, dispatchId: did, seq: 1, stepId: s.id, stage: "design" });
  insertFinding(db, { ticketId, reviewKind: "plan", dispatchId: did, severity: "major", category: "scope", deferralCandidate: 0, blocksShip: 1, location: "plan:7" });
  // a prior design loopback with the SAME signature (review:scope:plan:7)
  appendEvent(db, { ticketId, kind: "loopback", loop: "design", routeTo: "design:review", signature: "review:scope:plan:7" });
  const r = applyReviewVerdict(db, ticketId, DEFAULT_RUNTIME_CONFIG, { stepKey: "design:review" });
  const ticket = getTicket(db, ticketId);
  db.close();
  expect(r.decision).toBe("escalated");
  expect(ticket?.status).toBe("waiting");
});
```

(Add any missing imports: `insertDispatch` from `dispatch.ts`, `appendEvent` from `event-log.ts`, `DEFAULT_RUNTIME_CONFIG` from `runtime-config.ts`, `listByTicket as listUnits` from `work-unit.ts`, `getTicket` from `ticket.ts`.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test test/daemon/review-verdict.test.ts`
Expected: FAIL — `applyReviewVerdict` doesn't accept `opts`/`stepKey` yet; the plan branch doesn't exist.

- [ ] **Step 3: Implement the generalization**

In `src/daemon/review-verdict.ts`:

(a) Update the import: replace `latestReviewDispatchId` with `latestDispatchForStep` (still importing `listByDispatch`, `type ReviewFindingRow`).

(b) Add `"design:review"` to `redesignLoopback`'s reset list:

```typescript
    for (const key of ["design:dispatch", "design:extract", "design:review", "review"]) {
```

(c) Change the signature and the routing:

```typescript
export function applyReviewVerdict(
  db: Database,
  ticketId: number,
  config: RuntimeConfig,
  opts: { stepKey: string },
): ReviewVerdictResult {
  const dispatchId = latestDispatchForStep(db, ticketId, opts.stepKey);
  if (dispatchId === null) {
    return { decision: "clean" };
  }

  const open = listByDispatch(db, ticketId, dispatchId).filter((f) => f.status === "open");
  const blocking = open.filter((f) => f.blocks_ship === 1);

  // Plan review (S1c): any blocking plan finding → re-design (always; re-design is the natural
  // action at design time). No category routing, no deferral path. No-progress → escalate.
  if (opts.stepKey === "design:review") {
    if (blocking.length === 0) {
      return { decision: "clean" };
    }
    const signature = findingsSignature(blocking);
    if (isRepeatedReviewLoopback(db, ticketId, signature)) {
      escalate(db, ticketId, "no progress: identical plan-review findings", signature);
      return { decision: "escalated" };
    }
    redesignLoopback(db, ticketId, signature);
    return { decision: "loopback" };
  }

  // Code review (S5): existing M5b-1 routing.
  const deferred = open.filter((f) => f.severity === "major" && f.deferral_candidate === 1);
  if (blocking.length > 0) {
    const signature = findingsSignature(blocking);
    if (isRepeatedReviewLoopback(db, ticketId, signature)) {
      escalate(db, ticketId, "no progress: identical review findings", signature);
      return { decision: "escalated" };
    }
    const isPlanDefect = blocking.some((f) => f.category === "plan-defect");
    if (isPlanDefect) {
      if (config.onPlanDefect === "redesign") {
        redesignLoopback(db, ticketId, signature);
        return { decision: "loopback" };
      }
      escalate(db, ticketId, "blocking plan-defect found in code review; operator policy is escalate", signature);
      return { decision: "escalated" };
    }
    codeLoopback(db, ticketId, blocking, signature);
    return { decision: "loopback" };
  }
  if (deferred.length > 0) {
    escalate(db, ticketId, "deferrable major finding requires a human deferral decision", findingsSignature(deferred));
    return { decision: "escalated" };
  }
  return { decision: "clean" };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test test/daemon/review-verdict.test.ts`
Expected: PASS (the 3 new plan-review tests + all existing code-review tests — they now pass `{ stepKey: "review" }`; if an existing test calls `applyReviewVerdict` without `opts`, it will fail to typecheck — update those call sites to pass `{ stepKey: "review" }`).

- [ ] **Step 5: Commit**

```bash
git add src/daemon/review-verdict.ts test/daemon/review-verdict.test.ts
git commit -m "feat(m5b-2): plan-review verdict (blocking → re-design) + step-scoped findings"
```

---

### Task 5: Fire the verdict after `design:review` too

Generalize the `advanceOneStep` trigger from the single `stepKey === "review"` special-case to a verdict-bearing-step set, and pass the triggering `stepKey` into the verdict.

**Files:**
- Modify: `src/daemon/advance.ts`
- Test: `test/daemon/advance.test.ts` (extend if present; otherwise covered by Task 6 e2e — follow the M5b-1 Task-5 precedent)

**Interfaces:**
- Consumes: `applyReviewVerdict(db, ticketId, config, { stepKey })`.
- Produces: after any verdict-bearing step succeeds, the verdict runs and a non-`clean` decision is returned as the outcome.

- [ ] **Step 1: Modify `advance.ts`**

Add the set near the top of the module:

```typescript
const VERDICT_BEARING_STEPS = new Set(["review", "design:review"]);
```

Replace the existing success-path block:

```typescript
      if (d.stepKey === "review") {
        const { decision } = applyReviewVerdict(db, ticketId, opts?.config ?? DEFAULT_RUNTIME_CONFIG);
        if (decision !== "clean") {
          return { kind: decision, stepKey: d.stepKey };
        }
      }
      return { kind: "stepped", stepKey: d.stepKey };
```

with:

```typescript
      if (VERDICT_BEARING_STEPS.has(d.stepKey)) {
        const { decision } = applyReviewVerdict(db, ticketId, opts?.config ?? DEFAULT_RUNTIME_CONFIG, {
          stepKey: d.stepKey,
        });
        if (decision !== "clean") {
          return { kind: decision, stepKey: d.stepKey };
        }
      }
      return { kind: "stepped", stepKey: d.stepKey };
```

- [ ] **Step 2: Run the full suite**

Run: `bun test && bun run lint && bun run typecheck`
Expected: PASS. The clean code-review path is unchanged (still routes `review` → verdict → advance to merge). The walking-skeleton's mock `design:review`/`review` handlers file no findings → `latestDispatchForStep` finds no dispatch for those steps (the mocks don't call `runAgentDispatch`) → verdict `clean` → identical prior behavior.

- [ ] **Step 3: Commit**

```bash
git add src/daemon/advance.ts test/daemon/advance.test.ts
git commit -m "feat(m5b-2): fire the verdict after design:review (verdict-bearing-step set)"
```

---

### Task 6: End-to-end plan-review flows

**Files:**
- Test: `test/dispatch/design-review-e2e.test.ts`

Cover these flows with the `FakeAgentRunner` + real temp git repo harness (mirror `test/dispatch/review-e2e.test.ts`):

1. **Full-track, clean plan → advances to implement.** Ticket at `design`, `track='full'`, design:dispatch+extract done, 2 units; `design:review` files `{findings:[]}`. Drive `advanceOneStep`; assert the ticket advances `design → implement` and no `review_finding` rows exist.
2. **Full-track, blocking plan finding → re-design.** `design:review` files one blocking `critical`/`feasibility` finding. Assert stage returns to `design`, work_units were cleared (`listByTicket` length 0), and the `design:review` step was reset to pending. (Round isolation: a subsequent clean plan-review round files a new dispatch → clean → advances. Optionally drive the re-plan round to confirm it can reach `implement`, mirroring the M5b-1 flow-2 dispatch-scoping pattern.)
3. **Repeated identical blocking plan round → escalate.** Seed a prior `design` loopback with the matching signature; the next blocking round escalates (ticket `waiting` + `human_resume` signal).
4. **Fast-track ticket skips `design:review`.** A 1-unit ticket (the real `design:extract` sizes it `fast`); drive through design; assert the resolver advances `design → implement` WITHOUT ever running `design:review` (assert `getByKey(db, ticketId, "design:review")` is null / never created).

- [ ] **Step 1: Write the four e2e tests** (assert the binding facts named for each).

- [ ] **Step 2: Run**

Run: `bun test test/dispatch/design-review-e2e.test.ts && bun run lint`
Expected: PASS (all four).

- [ ] **Step 3: Commit**

```bash
git add test/dispatch/design-review-e2e.test.ts
git commit -m "test(m5b-2): e2e plan-review flows (clean/redesign/escalate/fast-skip)"
```

---

## Final Verification (before PR)

- [ ] Full gate fresh: `bun test && bun run lint && bun run typecheck && bun run build` — all pass; binary builds (re-signs on macOS).
- [ ] Confirm NO schema change: `git diff main -- src/db/schema.sql docs/architecture/schema.sql` is empty.
- [ ] Whole-branch review on the most capable model; fix any Critical/Important.
- [ ] `finishing-a-development-branch`: push `feat/m5b-2-plan-review`, open PR into `main`. **Do not merge** — the operator merges.
- [ ] Watch CI to green.

## Carries into M5b-3 (the complexity grader — do not build here)

- **Cold cheap-tier complexity grader behind a `RuntimeConfig` flag (default off).** Complexity-leads-with-coupling (coupling is a complexity dimension, not a sprawl count); sprawl demoted to a deterministic guard/floor; bidirectional (a low grade can pull a high-sprawl ticket back to fast). Combine the grade with `sizeTrack`'s sprawl signal. The flag ships WITH the grader (not as dead config).
- **Decision-log entry:** ratify that sizing is a routing heuristic where a cold agent dimension is allowed (it brushes the "no dimensional self-scored grading" invariant, which governs *verdicts*). Add to brainstorm §10/§11.
- **V6 cross-round persistence** (still open from M5b-1): `finding_class_key`-keyed N-round counter; populate `finding_class_key` (currently null). Hardens the no-progress backstop against verify-loopback interleaving.

## Self-Review

- **Spec coverage:** track sizing (Task 1, sprawl-only + override seam); design:review handler + prompt (Task 2, review_kind='plan'); plan-vs-code finding separation (Task 3, step-keyed lookup — also the M5b-1 carry); plan-review verdict → re-design (Task 4); redesignLoopback resets design:review (Task 4b); verdict fires after design:review (Task 5, generalized trigger — the M5b-1 carry); e2e incl. fast-track skip (Task 6). Covered.
- **Invariants:** daemon-only writes (handler inserts; design:review read-only allowlist already set); ground-truth (blocks_ship daemon-computed; verdict from ledger); transport-failure throw (Task 2); no schema change (verified in Final Verification); the complexity grader (the self-scored-routing question) is explicitly deferred. Held.
- **Placeholder scan:** every code step shows complete code; the two implementer-notes flag exactly what to reconcile (the M5a extract test's track assertion; existing verdict call sites gaining `{ stepKey }`).
- **Type consistency:** `sizeTrack` (Task 1) consumed nowhere else; `latestDispatchForStep(db,ticketId,stepKey)` (Task 3) is consumed by `applyReviewVerdict` (Task 4) which gains `opts: { stepKey }` and is called by `advance.ts` (Task 5) with `{ stepKey: d.stepKey }`; `insertFinding` params (Task 2) match the M5b-1 repo; `reviewKind: "plan"` matches the `"plan"|"code"` union. The `redesignLoopback` reset list (Task 4b) includes `design:review` so Task 6 flow 2's `pending` assertion holds.

# M5b-3 — Cold Complexity Grader (config-gated track sizing) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an optional cold complexity grader to track sizing: a separate cheap-tier read-only agent grades the plan's complexity (coupling, blast-radius, difficulty), which the daemon combines with sprawl to decide fast/full — gated behind a `RuntimeConfig` flag, default off (sprawl-only, today's behavior).

**Architecture:** Sizing moves out of `design:extract` into a dedicated **`design:size` step** that owns the fast/full decision. The resolver routes to it purely from state (`ticket.track === null → design:size`), so no config leaks into the pure router. The `design:size` handler branches on `RuntimeConfig.complexityGrading`: **off** → a daemon-only step computing `sizeTrack` (sprawl) with no agent; **on** → dispatch the cold cheap-tier grader, parse its grade sidecar, and `combineTrack(units, overall)`. The grade is a transient routing input (no DB column); the daemon applies the threshold (`overall ≥ 5` OR `units ≥ 5` → full), never the agent. `RuntimeConfig` is threaded into `HandlerContext` (a gap M5b-3 closes).

**Tech Stack:** TypeScript + Bun + `bun:sqlite`; zod; the existing `runAgentDispatch` / `extractSidecar` / tier+allowlist / `FakeAgentRunner` machinery.

## Global Constraints

- **Never commit to `main`.** Work on branch `feat/m5b-3-complexity-grader` (already created).
- **The grader is a ROUTING heuristic, not a ship-gate verdict.** Its grade only chooses fast/full; it never blocks shipping and never overrides a ground-truth gate. This is what keeps it on the right side of the "ground truth over self-report / no dimensional self-scored grading" invariant (which governs VERDICTS). A decision-log entry ratifies this (Task 5).
- **Cold + separate from the planner.** The grader is its own dispatch (not the `design:extract`/`design:dispatch` agent self-grading). Read-only tools only; cheap tier.
- **Daemon applies the threshold, not the agent.** The agent emits dimension scores + an `overall`; the daemon computes the track via `combineTrack`. The sidecar carries no track/decision field.
- **Default off.** `RuntimeConfig.complexityGrading` defaults `false`; with the flag off, sizing is exactly today's deterministic sprawl rule (`sizeTrack`, full iff `units ≥ 2`) and **no agent is dispatched**.
- **Combine rule (named, tunable consts):** `full` iff `overall ≥ COMPLEXITY_FULL_THRESHOLD (5)` **OR** `unitCount ≥ SPRAWL_FLOOR (5)`; else `fast`.
- **Per-ticket override seam preserved:** a ticket whose `track` is already set is never re-sized (the resolver only routes to `design:size` when `track === null`).
- Run the full gate before claiming done: `bun test` · `bun run lint` · `bun run typecheck` · `bun run build`. **Every task's gate includes `bun run lint`.**
- **No schema change.** The grade is transient. `track` stays `('fast'|'full')`. If a change becomes necessary, edit BOTH `src/db/schema.sql` and `docs/architecture/schema.sql`.

---

## File Structure

- **Modify** `src/config/runtime-config.ts` — add `complexityGrading: boolean` (default false).
- **Modify** `src/daemon/step-registry.ts` — `HandlerContext` gains `config: RuntimeConfig`.
- **Modify** `src/daemon/advance.ts` — pass `config` into the handler call.
- **Create** `src/dispatch/complexity-schema.ts` — `ComplexityGradeSchema` (zod) + type.
- **Modify** `src/dispatch/track-sizing.ts` — add `COMPLEXITY_FULL_THRESHOLD`, `SPRAWL_FLOOR`, `combineTrack`.
- **Modify** `src/daemon/resolver.ts` — route `design → design:size` when `track === null`.
- **Modify** `src/dispatch/handlers.ts` — register `design:size` (off-path sprawl, then on-path grader); remove sizing from `design:extract`.
- **Create** `prompts/design-complexity-grade.md` — the cold grader prompt.
- **Modify** `src/dispatch/prompt-vars.ts` — `DESIGN_COMPLEXITY_GRADE_TEMPLATE` + `complexityGradeVars`.
- **Modify** `src/agent/tiers.ts` + `src/dispatch/tool-allowlists.ts` — register `design:size` (cheap, read-only).
- **Modify** `docs/architecture/brainstorm.md` — §11 changelog entry (decision-log).
- **Tests:** `test/config/runtime-config.test.ts` (or extend), `test/dispatch/complexity-schema.test.ts`, `test/dispatch/track-sizing.test.ts` (extend), `test/daemon/resolver.test.ts` (extend), `test/dispatch/design-size.test.ts`, `test/dispatch/design-size-e2e.test.ts`; reconcile `test/dispatch/design-extract.test.ts`.

---

### Task 1: `complexityGrading` flag + thread `RuntimeConfig` into handlers

**Files:**
- Modify: `src/config/runtime-config.ts`
- Modify: `src/daemon/step-registry.ts`
- Modify: `src/daemon/advance.ts`
- Test: `test/config/runtime-config.test.ts` (create if absent)

**Interfaces:**
- Consumes: `DEFAULT_RUNTIME_CONFIG` (advance.ts already imports it).
- Produces:
  - `RuntimeConfig` gains `complexityGrading: boolean` (default false).
  - `HandlerContext` gains `config: RuntimeConfig`.
  - `advanceOneStep` populates `ctx.config` from `opts?.config ?? DEFAULT_RUNTIME_CONFIG` in the handler call.

- [ ] **Step 1: Write the failing test**

Create `test/config/runtime-config.test.ts`:

```typescript
import { expect, test } from "bun:test";
import { DEFAULT_RUNTIME_CONFIG, RuntimeConfigSchema } from "../../src/config/runtime-config.ts";

test("complexityGrading defaults to false", () => {
  expect(DEFAULT_RUNTIME_CONFIG.complexityGrading).toBe(false);
  expect(RuntimeConfigSchema.parse({}).complexityGrading).toBe(false);
});

test("complexityGrading can be enabled", () => {
  expect(RuntimeConfigSchema.parse({ complexityGrading: true }).complexityGrading).toBe(true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/config/runtime-config.test.ts`
Expected: FAIL — `complexityGrading` is undefined.

- [ ] **Step 3: Add the flag**

In `src/config/runtime-config.ts`, add to `RuntimeConfigSchema`:

```typescript
export const RuntimeConfigSchema = z.object({
  onPlanDefect: z.enum(["escalate", "redesign"]).default("escalate"),
  // M5b-3: opt-in cold complexity grader for track sizing. Off = deterministic sprawl-only.
  complexityGrading: z.boolean().default(false),
});
```

- [ ] **Step 4: Thread config into `HandlerContext`**

In `src/daemon/step-registry.ts`, import the type and extend the context:

```typescript
import type { RuntimeConfig } from "../config/runtime-config.ts";
// …
export interface HandlerContext {
  db: Database;
  ticket: TicketRow;
  step: WorkflowStepRow;
  workUnitId: number | null;
  config: RuntimeConfig;
}
```

In `src/daemon/advance.ts`, populate it in the handler call (line ~83). `DEFAULT_RUNTIME_CONFIG` is already imported:

```typescript
        execute: (step) =>
          handler({
            db,
            ticket,
            step,
            workUnitId: d.workUnitId,
            config: opts?.config ?? DEFAULT_RUNTIME_CONFIG,
          }),
```

- [ ] **Step 5: Run tests + full suite**

Run: `bun test test/config/runtime-config.test.ts && bun test && bun run lint && bun run typecheck`
Expected: the new tests PASS. The full suite must stay green — existing handlers ignore `ctx.config`. **If any test that constructs a `HandlerContext` literal (e.g. a unit test calling a handler directly) now fails typecheck for missing `config`, add `config: DEFAULT_RUNTIME_CONFIG` to that literal.** (Most handler tests go through `advanceOneStep`/`buildDispatchRegistry`, which now supply it.)

- [ ] **Step 6: Commit**

```bash
git add src/config/runtime-config.ts src/daemon/step-registry.ts src/daemon/advance.ts test/config/runtime-config.test.ts
git commit -m "feat(m5b-3): complexityGrading flag + thread RuntimeConfig into HandlerContext"
```

---

### Task 2: Complexity grade schema + combine rule

**Files:**
- Create: `src/dispatch/complexity-schema.ts`
- Modify: `src/dispatch/track-sizing.ts`
- Test: `test/dispatch/complexity-schema.test.ts`, `test/dispatch/track-sizing.test.ts` (extend)

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `ComplexityGradeSchema` (zod) + `ComplexityGrade` type: `{ dimensions: { coupling: number; blast_radius: number; difficulty: number }, overall: number, rationale: string | null }`, each score `z.number().min(0).max(10)`.
  - `COMPLEXITY_FULL_THRESHOLD = 5`, `SPRAWL_FLOOR = 5` (exported consts in track-sizing.ts).
  - `combineTrack(unitCount: number, overall: number): "fast" | "full"` — `overall >= COMPLEXITY_FULL_THRESHOLD || unitCount >= SPRAWL_FLOOR ? "full" : "fast"`.

- [ ] **Step 1: Write the failing tests**

Create `test/dispatch/complexity-schema.test.ts`:

```typescript
import { expect, test } from "bun:test";
import { ComplexityGradeSchema } from "../../src/dispatch/complexity-schema.ts";

const grade = (over: Record<string, unknown> = {}) => ({
  dimensions: { coupling: 3, blast_radius: 2, difficulty: 4 },
  overall: 3,
  rationale: "low coupling",
  ...over,
});

test("schema parses a well-formed grade", () => {
  expect(ComplexityGradeSchema.safeParse(grade()).success).toBe(true);
});

test("schema accepts a null rationale", () => {
  expect(ComplexityGradeSchema.safeParse(grade({ rationale: null })).success).toBe(true);
});

test("schema rejects an out-of-range score", () => {
  expect(ComplexityGradeSchema.safeParse(grade({ overall: 11 })).success).toBe(false);
  expect(
    ComplexityGradeSchema.safeParse(grade({ dimensions: { coupling: -1, blast_radius: 2, difficulty: 4 } }))
      .success,
  ).toBe(false);
});
```

Add to `test/dispatch/track-sizing.test.ts`:

```typescript
import { combineTrack } from "../../src/dispatch/track-sizing.ts";

test("combineTrack: high complexity → full even with 1 unit (the auth-one-file case)", () => {
  expect(combineTrack(1, 5)).toBe("full");
  expect(combineTrack(1, 9)).toBe("full");
});

test("combineTrack: low complexity + few units → fast (the simple-multi-piece/docs case)", () => {
  expect(combineTrack(3, 2)).toBe("fast");
  expect(combineTrack(4, 4)).toBe("fast");
});

test("combineTrack: sprawl floor forces full regardless of a low grade", () => {
  expect(combineTrack(5, 0)).toBe("full");
  expect(combineTrack(8, 1)).toBe("full");
});

test("combineTrack: trivial single unit → fast", () => {
  expect(combineTrack(1, 0)).toBe("fast");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test test/dispatch/complexity-schema.test.ts test/dispatch/track-sizing.test.ts`
Expected: FAIL — module/symbol not found.

- [ ] **Step 3: Write the schema**

Create `src/dispatch/complexity-schema.ts`:

```typescript
import { z } from "zod";

/** The cold complexity grader's structured output (M5b-3). Per-dimension 0–10 scores plus a
 *  holistic `overall`. The daemon — not the agent — turns `overall` into a track via combineTrack;
 *  this is a routing heuristic input, never a ship-gate verdict. */
export const ComplexityGradeSchema = z.object({
  dimensions: z.object({
    coupling: z.number().min(0).max(10),
    blast_radius: z.number().min(0).max(10),
    difficulty: z.number().min(0).max(10),
  }),
  overall: z.number().min(0).max(10),
  rationale: z.string().nullable(),
});

export type ComplexityGrade = z.infer<typeof ComplexityGradeSchema>;
```

- [ ] **Step 4: Add the combine rule**

In `src/dispatch/track-sizing.ts`, append (keep `sizeTrack`/`FULL_TRACK_MIN_UNITS` as-is):

```typescript
/** Combine-rule thresholds (M5b-3). Provisional + tunable (post-cutover learning tunes them). */
export const COMPLEXITY_FULL_THRESHOLD = 5;
export const SPRAWL_FLOOR = 5;

/** Hybrid sizing: complexity leads (a high overall grade → full even for a small plan), with a
 *  deterministic sprawl floor as a backstop against the grader under-rating a large coordination
 *  job. Bidirectional — a low grade keeps a moderately-sprawling plan fast. */
export function combineTrack(unitCount: number, overall: number): "fast" | "full" {
  return overall >= COMPLEXITY_FULL_THRESHOLD || unitCount >= SPRAWL_FLOOR ? "full" : "fast";
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun test test/dispatch/complexity-schema.test.ts test/dispatch/track-sizing.test.ts && bun run lint`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/dispatch/complexity-schema.ts src/dispatch/track-sizing.ts test/dispatch/complexity-schema.test.ts test/dispatch/track-sizing.test.ts
git commit -m "feat(m5b-3): complexity grade schema + combineTrack (complexity-leads, sprawl-floor)"
```

---

### Task 3: The `design:size` step — sprawl path + resolver routing (move sizing out of extract)

This is the structural task. `design:size` becomes the sole sizer; the resolver routes to it when `track === null`; `design:extract` stops sizing. The handler implements the **off path** (sprawl-only, no agent); the grader on-path is Task 4.

**Files:**
- Modify: `src/daemon/resolver.ts`
- Modify: `src/dispatch/handlers.ts` (remove extract sizing; register `design:size`)
- Test: `test/daemon/resolver.test.ts` (extend), `test/dispatch/design-size.test.ts` (create), `test/dispatch/design-extract.test.ts` (reconcile)

**Interfaces:**
- Consumes: `sizeTrack` (track-sizing.ts); `listByTicket as listUnits`, `setTicketTrack`; `ctx.config` (Task 1).
- Produces:
  - Resolver: a `design:size` route — after `design:extract` (units exist) and when `ticket.track === null`, returns `step("design:size", "dispatch", "design:size", null)`, BEFORE the `track === "full"` design:review check.
  - A registered `"design:size"` handler. Off path (this task): `if (ctx.config.complexityGrading)` is false → `setTicketTrack(ctx.db, ctx.ticket.id, sizeTrack(listUnits(ctx.db, ctx.ticket.id)))`; returns `{ track, graded: false }`. (The `true` branch is added in Task 4.)
  - `design:extract` no longer sets `track` (removes the M5b-2 sizing lines); returns `{ units }` only.

- [ ] **Step 1: Write the failing tests**

Add to `test/daemon/resolver.test.ts` (mirror its existing design-stage setup helpers):

```typescript
test("design: units present + track unset → routes to design:size", () => {
  const { db, ticketId } = makeTestDb();
  const s = insertPending(db, { ticketId, stepKey: "design:dispatch", stepType: "dispatch" });
  db.query("UPDATE workflow_step SET status = 'succeeded' WHERE id = ?").run(s.id);
  insertWorkUnit(db, { ticketId, seq: 1, kind: "backend", verifyCheckTypes: ["test"] });
  // track is null (extract no longer sizes)
  const d = nextStepKey(db, ticketId);
  db.close();
  expect(d).toEqual({ kind: "step", stepKey: "design:size", stepType: "dispatch", handlerKey: "design:size", workUnitId: null });
});
```

Create `test/dispatch/design-size.test.ts` (reuse the `gitRepo()` + `registryFor()` harness from `test/dispatch/design-review-handler.test.ts`; the off path dispatches NO agent, so the FakeAgentRunner can throw if called):

```typescript
import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeAgentRunner } from "../../src/agent/fake-runner.ts";
import { DEFAULT_AGENT_CONFIG } from "../../src/config/agent-config.ts";
import { advanceOneStep } from "../../src/daemon/advance.ts";
import { getTicket } from "../../src/db/repos/ticket.ts";
import { insertWorkUnit } from "../../src/db/repos/work-unit.ts";
import { insertPending } from "../../src/db/repos/workflow-step.ts";
import { buildDispatchRegistry } from "../../src/dispatch/handlers.ts";
import { parseProfile } from "../../src/dispatch/profile.ts";
import { makeTestDb } from "../helpers/db.ts";

function registryFor(runner: FakeAgentRunner) {
  return buildDispatchRegistry({
    runner,
    agentConfig: DEFAULT_AGENT_CONFIG,
    profile: parseProfile({ slug: "demo", targetRepo: "/tmp/x", commands: { test: "bun test" } }),
    worktreeRoot: mkdtempSync(join(tmpdir(), "styre-szwt-")),
  });
}

// design:dispatch succeeded + units present + track null → resolver routes to design:size.
function readyForSize(db: ReturnType<typeof makeTestDb>["db"], ticketId: number, unitCount: number) {
  const s = insertPending(db, { ticketId, stepKey: "design:dispatch", stepType: "dispatch" });
  db.query("UPDATE workflow_step SET status = 'succeeded' WHERE id = ?").run(s.id);
  for (let i = 1; i <= unitCount; i++) {
    insertWorkUnit(db, { ticketId, seq: i, kind: "backend", behavioral: 0, verifyCheckTypes: ["test"] });
  }
}

test("design:size (grader off) sizes by sprawl: 1 unit → fast", async () => {
  const { db, ticketId } = makeTestDb();
  readyForSize(db, ticketId, 1);
  const runner = new FakeAgentRunner(() => {
    throw new Error("grader off: no agent should be dispatched");
  });
  await advanceOneStep(db, ticketId, registryFor(runner)); // runs design:size
  const ticket = getTicket(db, ticketId);
  db.close();
  expect(ticket?.track).toBe("fast");
});

test("design:size (grader off) sizes by sprawl: 2 units → full", async () => {
  const { db, ticketId } = makeTestDb();
  readyForSize(db, ticketId, 2);
  const runner = new FakeAgentRunner(() => {
    throw new Error("grader off: no agent should be dispatched");
  });
  await advanceOneStep(db, ticketId, registryFor(runner));
  const ticket = getTicket(db, ticketId);
  db.close();
  expect(ticket?.track).toBe("full");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test test/daemon/resolver.test.ts test/dispatch/design-size.test.ts`
Expected: FAIL — no `design:size` route / no handler.

- [ ] **Step 3: Add the resolver route**

In `src/daemon/resolver.ts`, the `design` case — insert the `design:size` route after the extract route and before the `design:review` check:

```typescript
    case "design": {
      if (!done(db, ticketId, "design:dispatch")) {
        return step("design:dispatch", "dispatch", "design:dispatch", null);
      }
      if (workUnits.listByTicket(db, ticketId).length === 0) {
        return step("design:extract", "dispatch", "design:extract", null);
      }
      if (ticket.track === null) {
        return step("design:size", "dispatch", "design:size", null);
      }
      if (ticket.track === "full" && !done(db, ticketId, "design:review")) {
        return step("design:review", "dispatch", "design:review", null);
      }
      return { kind: "advance", from: "design", to: "implement" };
    }
```

- [ ] **Step 4: Remove sizing from `design:extract`; register `design:size`**

In `src/dispatch/handlers.ts`, in the `design:extract` handler, DELETE the M5b-2 sizing block (the two comment lines + `const track = ctx.ticket.track ?? sizeTrack(...)` + `setTicketTrack(...)`), leaving:

```typescript
    return { units: parsed.value.units.length };
```

Register the new handler (place it right after `design:extract`):

```typescript
  registry.register("design:size", async (ctx: HandlerContext) => {
    const units = listUnits(ctx.db, ctx.ticket.id);
    // Off path (M5b-3 default): deterministic sprawl-only sizing, no agent. The grader on-path
    // is added in Task 4 behind ctx.config.complexityGrading.
    const track = sizeTrack(units);
    setTicketTrack(ctx.db, ctx.ticket.id, track);
    return { track, graded: false };
  });
```

(`sizeTrack`, `setTicketTrack`, and `listByTicket as listUnits` are already imported in handlers.ts. Keep the `sizeTrack` import — it's now used here instead of in extract.)

- [ ] **Step 5: Reconcile `design-extract.test.ts`**

`design:extract` no longer sets `track`. Open `test/dispatch/design-extract.test.ts` and update any assertion on `ticket.track` after a real extract: extract now leaves `track` null (sizing is `design:size`'s job). Change a `expect(ticket?.track).toBe("full")`/`"fast"` after extract to `expect(ticket?.track).toBeNull()`. Do NOT delete the test's other assertions (units inserted, behavioral flags). The sprawl rule's coverage now lives in `track-sizing.test.ts` + `design-size.test.ts`.

- [ ] **Step 6: Run tests + full suite**

Run: `bun test && bun run lint && bun run typecheck`
Expected: PASS. Watch these ripples: (a) `test/dispatch/design-review-e2e.test.ts` flow 4 (real 1-unit extract → fast → skip design:review) now reaches `track='fast'` via `design:size` instead of extract — it asserts end state (track=fast, design:review null, implement), which still holds; confirm it passes (its loop tolerates the extra `design:size` step, which dispatches no agent when grader is off). (b) The walking-skeleton's mock `design:extract` sets `track="fast"` itself, so `track` is non-null → the resolver skips `design:size` → no skeleton change needed. (c) Any resolver test seeding design-stage `units + track=null` and expecting advance/review now expects `design:size` — update it.

- [ ] **Step 7: Commit**

```bash
git add src/daemon/resolver.ts src/dispatch/handlers.ts test/daemon/resolver.test.ts test/dispatch/design-size.test.ts test/dispatch/design-extract.test.ts
git commit -m "feat(m5b-3): design:size step owns sizing (sprawl path) + resolver routes on track=null"
```

---

### Task 4: The grader on-path (prompt + handler branch + tier/allowlist)

Extend `design:size` so that, when `ctx.config.complexityGrading` is true, it dispatches the cold grader and combines its grade with sprawl.

**Files:**
- Create: `prompts/design-complexity-grade.md`
- Modify: `src/dispatch/prompt-vars.ts`
- Modify: `src/dispatch/handlers.ts` (the `design:size` handler)
- Modify: `src/agent/tiers.ts`, `src/dispatch/tool-allowlists.ts`
- Test: `test/dispatch/design-size.test.ts` (extend)

**Interfaces:**
- Consumes: `runAgentDispatch`, `extractSidecar`, `ComplexityGradeSchema`, `combineTrack`, `DESIGN_COMPLEXITY_GRADE_TEMPLATE`, `complexityGradeVars`, `ctx.config`.
- Produces:
  - `design:size` handler on-path: when `ctx.config.complexityGrading` → `runAgentDispatch` (read-only, no-op postcondition) → `extractSidecar(output, ComplexityGradeSchema)` (throw on `!ok`) → `combineTrack(units.length, grade.overall)` → `setTicketTrack`; returns `{ track, graded: true, overall }`.
  - `DESIGN_COMPLEXITY_GRADE_TEMPLATE` + `complexityGradeVars(ticket, profile, units)`.
  - `design:size` registered in TIERS (`"cheap"`) and ALLOWLISTS (`[...READ_ONLY]`).

- [ ] **Step 1: Register tier + allowlist**

In `src/agent/tiers.ts`, add to `TIERS`: `"design:size": "cheap",`.
In `src/dispatch/tool-allowlists.ts`, add to `ALLOWLISTS`: `"design:size": [...READ_ONLY],`.

- [ ] **Step 2: Create the prompt**

Create `prompts/design-complexity-grade.md`:

```markdown
You are grading the COMPLEXITY of an already-written plan for ticket {{ident}} ("{{title}}") in
project {{slug}}, to help the system decide how much review ceremony the ticket needs. You did NOT
write this plan. You are NOT judging whether it is good or whether it should be reviewed — only how
complex the work is. Do NOT modify any files; your only output is the grade sidecar below.

The plan decomposes into {{unit_count}} work unit(s): {{unit_kinds}}. Read the plan under
`docs/plans/`, the work units, and the codebase they touch. Score each dimension 0–10:
- **coupling** — how interdependent the pieces are (do changes have to land together / ripple
  across modules?). Many independent trivial files = LOW coupling; few tightly-interlocking
  changes = HIGH.
- **blast_radius** — how much of the system the change can affect (isolated helper = low;
  shared core / auth / data model / migration = high).
- **difficulty** — algorithmic / domain difficulty of the work itself (boilerplate = low; subtle
  concurrency, tricky invariants, security-sensitive logic = high).

Then give an **overall** 0–10 holistic complexity score (not necessarily the average — weight what
matters). A sprawling-but-trivial change (e.g. many independent doc edits) is LOW overall; a small
change to a deeply-coupled or high-risk area is HIGH.

Emit exactly one fenced block:

```styre-sidecar
{
  "dimensions": { "coupling": 3, "blast_radius": 2, "difficulty": 4 },
  "overall": 3,
  "rationale": "low coupling, isolated, routine"
}
```
```

- [ ] **Step 3: Wire template + vars**

In `src/dispatch/prompt-vars.ts`:

```typescript
import complexityGradeTemplate from "../../prompts/design-complexity-grade.md" with { type: "text" };
// …
export const DESIGN_COMPLEXITY_GRADE_TEMPLATE = complexityGradeTemplate;

export function complexityGradeVars(
  ticket: { ident: string; title: string | null },
  profile: Profile,
  units: { kind: string }[],
): Record<string, string> {
  return {
    ident: ticket.ident,
    title: ticket.title ?? "",
    slug: profile.slug,
    unit_count: String(units.length),
    unit_kinds: units.map((u) => u.kind).join(", "),
    ...profile.promptVars,
  };
}
```

- [ ] **Step 4: Write the failing tests**

Add to `test/dispatch/design-size.test.ts` (a runner that returns a grade sidecar; pass `{ config: { onPlanDefect: "escalate", complexityGrading: true } }` to `advanceOneStep`). Add the helper:

```typescript
const sidecar = (json: string) => `Grade.\n\n\`\`\`styre-sidecar\n${json}\n\`\`\`\n`;
const gradeRunner = (overall: number) =>
  new FakeAgentRunner(() => ({
    completed: true, exitCode: 0,
    stdout: sidecar(JSON.stringify({ dimensions: { coupling: 0, blast_radius: 0, difficulty: 0 }, overall })),
    stderr: "", timedOut: false, costUsd: null, tokensIn: null, tokensOut: null,
  }));
const ON = { config: { onPlanDefect: "escalate" as const, complexityGrading: true } };

test("grader on: low overall + 3 units → fast (bidirectional: simple multi-piece)", async () => {
  const { db, ticketId } = makeTestDb();
  readyForSize(db, ticketId, 3);
  await advanceOneStep(db, ticketId, registryFor(gradeRunner(2)), ON);
  const ticket = getTicket(db, ticketId);
  db.close();
  expect(ticket?.track).toBe("fast");
});

test("grader on: high overall + 1 unit → full (the auth-one-file catch)", async () => {
  const { db, ticketId } = makeTestDb();
  readyForSize(db, ticketId, 1);
  await advanceOneStep(db, ticketId, registryFor(gradeRunner(8)), ON);
  const ticket = getTicket(db, ticketId);
  db.close();
  expect(ticket?.track).toBe("full");
});

test("grader on: low overall but 5 units → full (sprawl floor backstop)", async () => {
  const { db, ticketId } = makeTestDb();
  readyForSize(db, ticketId, 5);
  await advanceOneStep(db, ticketId, registryFor(gradeRunner(1)), ON);
  const ticket = getTicket(db, ticketId);
  db.close();
  expect(ticket?.track).toBe("full");
});

test("grader on: absent grade sidecar fails the step (transport failure)", async () => {
  const { db, ticketId } = makeTestDb();
  readyForSize(db, ticketId, 1);
  const runner = new FakeAgentRunner(() => ({
    completed: true, exitCode: 0, stdout: "no block", stderr: "",
    timedOut: false, costUsd: null, tokensIn: null, tokensOut: null,
  }));
  await advanceOneStep(db, ticketId, registryFor(runner), ON);
  const ticket = getTicket(db, ticketId);
  db.close();
  expect(ticket?.track).toBeNull(); // step threw before setting track
});
```

> Implementer note: `registryFor` in this file uses `targetRepo: "/tmp/x"`. The grader on-path calls `runAgentDispatch`, which `ensureWorktree`s the repo — so for the grader tests the registry needs a REAL temp git repo (use the `gitRepo()` helper from `design-review-handler.test.ts`). Update `registryFor` to take a repo path and set `targetRepo` to it, and create a `gitRepo()` for the on-path tests (the off-path tests don't dispatch, so they tolerate a fake path — but it's simplest to give the whole file a real repo). Mirror `design-review-handler.test.ts` exactly.

- [ ] **Step 5: Implement the on-path**

In `src/dispatch/handlers.ts`, replace the `design:size` handler body with the branching version:

```typescript
  registry.register("design:size", async (ctx: HandlerContext) => {
    const units = listUnits(ctx.db, ctx.ticket.id);
    if (!ctx.config.complexityGrading) {
      const track = sizeTrack(units); // off: deterministic sprawl-only, no agent
      setTicketTrack(ctx.db, ctx.ticket.id, track);
      return { track, graded: false };
    }
    // on: cold cheap-tier grader → daemon combines the grade with sprawl.
    const result = await runAgentDispatch(
      ctx,
      depsFor(ctx, deps, deps.timeoutMs ?? DESIGN_TIMEOUT_MS),
      {
        handlerKey: "design:size",
        template: DESIGN_COMPLEXITY_GRADE_TEMPLATE,
        vars: complexityGradeVars(ctx.ticket, deps.profile, units),
        postcondition: () => {}, // read-only: nothing commits
      },
    );
    const parsed = extractSidecar(result.output, ComplexityGradeSchema);
    if (!parsed.ok) {
      throw new Error(`design:size grade sidecar ${parsed.reason}: ${parsed.detail}`);
    }
    const track = combineTrack(units.length, parsed.value.overall);
    setTicketTrack(ctx.db, ctx.ticket.id, track);
    return { track, graded: true, overall: parsed.value.overall };
  });
```

Add imports to handlers.ts: `ComplexityGradeSchema` from `./complexity-schema.ts`; `combineTrack` from `./track-sizing.ts`; `DESIGN_COMPLEXITY_GRADE_TEMPLATE, complexityGradeVars` from `./prompt-vars.ts`.

- [ ] **Step 6: Run tests + full suite**

Run: `bun test test/dispatch/design-size.test.ts && bun test && bun run lint && bun run typecheck`
Expected: PASS (off-path tests from Task 3 + the 4 new on-path tests). Full suite green.

- [ ] **Step 7: Commit**

```bash
git add prompts/design-complexity-grade.md src/dispatch/prompt-vars.ts src/dispatch/handlers.ts src/agent/tiers.ts src/dispatch/tool-allowlists.ts test/dispatch/design-size.test.ts
git commit -m "feat(m5b-3): cold complexity grader on-path (config-gated) + tier/allowlist"
```

---

### Task 5: End-to-end flows + decision-log entry

**Files:**
- Test: `test/dispatch/design-size-e2e.test.ts`
- Modify: `docs/architecture/brainstorm.md`

- [ ] **Step 1: Write the e2e tests**

Create `test/dispatch/design-size-e2e.test.ts` (mirror `design-review-e2e.test.ts`; drive `advanceOneStep` through the design stage). Cover:
1. **Grader OFF (default): 2-unit ticket → full → routes to design:review.** Drive real `design:extract` (2-unit extract sidecar) → `design:size` (off, no agent) sets `track='full'` → resolver routes to `design:review`. Assert `ticket.track==='full'` and the next resolved step is `design:review` (or design:review runs). No grader agent dispatched.
2. **Grader ON: 3 simple units → fast → SKIPS design:review.** `{ config: { complexityGrading: true } }`; the runner serves the extract sidecar (3 units) then a grade with `overall=2`. Assert `track==='fast'`, design:review step null, advances toward implement.
3. **Grader ON: 1 unit, high overall → full → design:review runs.** Runner serves a 1-unit extract then `overall=8`. Assert `track==='full'` and design:review is routed/runs.

> Implementer note: the runner must serve different sidecars per call (design:dispatch writes a plan file; design:extract returns an extract sidecar; design:size returns a grade sidecar). Use a call-counter or branch on `input.prompt` content (the extract vs grade prompts differ). Mirror how `design-review-e2e.test.ts` / `design-extract.test.ts` drive multi-step agent flows. If driving the full design:dispatch→extract→size chain is fiddly, you may seed design:dispatch succeeded + drive extract→size (the binding facts are the track value + whether design:review runs).

- [ ] **Step 2: Run the e2e**

Run: `bun test test/dispatch/design-size-e2e.test.ts && bun run lint`
Expected: PASS (all three).

- [ ] **Step 3: Add the decision-log entry**

In `docs/architecture/brainstorm.md`, **append** to the §11 changelog (append-only — do NOT rewrite history). Add a dated entry mirroring the existing changelog format, e.g.:

```markdown
- **2026-06-22 (M5b-3):** Track sizing gains an optional cold complexity grader (RuntimeConfig.complexityGrading, default off). A separate cheap-tier read-only agent grades plan complexity (coupling / blast_radius / difficulty + an overall 0–10); the daemon combines it with sprawl via `combineTrack` (full iff overall≥5 OR units≥5). **Ratification (re: move-5 "ground truth over self-report"):** this is permitted because sizing is a ROUTING heuristic, not a ship-gate verdict — the grade only chooses fast/full (how much review ceremony), never blocks shipping and never overrides a ground-truth gate; the grader is cold (separate from the planner) and read-only; the grade is transient (no DB column). The "no dimensional self-scored grading" rule continues to govern VERDICTS, which remain ground-truth-derived. Sizing lives in a new `design:size` step; `design:extract` no longer sizes.
```

(If brainstorm.md has a §10 Open Decisions Register row for C2 (ticket-size→track), you may ALSO add a one-line note there referencing this changelog entry — but the changelog append is the required artifact. Do not edit existing rows' history.)

- [ ] **Step 4: Commit**

```bash
git add test/dispatch/design-size-e2e.test.ts docs/architecture/brainstorm.md
git commit -m "test(m5b-3): e2e sizing flows (off/on) + decision-log entry"
```

---

## Final Verification (before PR)

- [ ] Full gate fresh: `bun test && bun run lint && bun run typecheck && bun run build` — all pass.
- [ ] Confirm NO schema change: `git diff main -- src/db/schema.sql docs/architecture/schema.sql` is empty.
- [ ] Confirm default-off parity: with `complexityGrading` false, sizing is exactly the sprawl rule and no grader agent is dispatched (the off-path tests + walking-skeleton prove this).
- [ ] Whole-branch review on the most capable model; fix any Critical/Important.
- [ ] `finishing-a-development-branch`: push `feat/m5b-3-complexity-grader`, open PR into `main`. **Do not merge** — the operator merges.
- [ ] Watch CI to green.

## Carries (not built here)

- **Config-source loader** (startup-entrypoint milestone): workspace `config.json`/per-ticket → `RuntimeConfigSchema.parse`/merge → pass into `tick`. The object seam already exists; only the loader is new. Keep out of `Profile`. Until then `complexityGrading` is reachable only via the threaded default (off) or a test-supplied config.
- **V6 cross-round persistence** (open since M5b-1): `finding_class_key`-keyed N-round counter; also disambiguates plan vs code finding signatures.
- **Tuning the thresholds / rubric** is a post-cutover learning-layer concern; the consts (`COMPLEXITY_FULL_THRESHOLD`, `SPRAWL_FLOOR`) are the tuning surface.

## Self-Review

- **Spec coverage:** flag + handler-config threading (Task 1); grade schema + combine rule (Task 2); design:size step + resolver routing + sizing-out-of-extract, sprawl/off path (Task 3); cold grader on-path + prompt + tier/allowlist (Task 4); e2e off/on + decision-log ratification (Task 5). Covered.
- **Invariants:** routing-heuristic-not-verdict (grade only sets track; ratified in Task 5); cold + separate + read-only (own dispatch, READ_ONLY allowlist, cheap tier); daemon applies threshold (combineTrack in the handler, not the agent; sidecar has no track field); default off (Task 1 default + off-path tests); no schema change (transient grade). Held.
- **Placeholder scan:** every code step has complete code; the two implementer-notes flag the test-harness repo setup and the multi-sidecar runner — both reference an exact prior-art file to mirror.
- **Type consistency:** `RuntimeConfig.complexityGrading` (Task 1) read as `ctx.config.complexityGrading` (Tasks 3–4); `combineTrack(unitCount, overall)` (Task 2) called with `units.length, parsed.value.overall` (Task 4); `ComplexityGradeSchema` (Task 2) parsed in Task 4; `design:size` handlerKey consistent across resolver (Task 3), TIERS/ALLOWLISTS (Task 4), tests; `complexityGradeVars(ticket, profile, units)` signature matches its Task 4 call.

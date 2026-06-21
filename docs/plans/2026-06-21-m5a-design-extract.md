# M5a — Plan-to-Work-Items (`design:extract`) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the real `design:extract` step — turn a committed plan into validated `work_unit` rows, classifying each unit as behavioral or not, so the implement stage has concrete, individually-gated units to build.

**Architecture:** `design:extract` is a read-only agent step. It reuses the existing `runAgentDispatch` flow (render → worktree → run agent → record dispatch) but, instead of committing files, its product is a structured **sidecar** block in the agent's stdout (control-loop §3a). The daemon parses that block against a zod schema, runs deterministic completeness checks, then inserts the `work_unit` rows itself (only-the-daemon-writes-SoT). Each unit carries an **explicit** `behavioral` flag — the linchpin of this milestone, because `insertWorkUnit` defaults `behavioral` to `1`, and the A1 verify gate demands a test file for any behavioral unit. Non-behavioral units (docs-only, config) must be classified `behavioral: false` here or they will later be blocked forever demanding a test that cannot exist.

**Tech Stack:** TypeScript + Bun + `bun:sqlite`; zod for the structured-output interface; existing `extractSidecar` + `runAgentDispatch` + `FakeAgentRunner` test harness.

## Global Constraints

- **Never commit to `main`.** Work happens on branch `feat/m5-structured-judgment`. (Already created.)
- **Only the daemon writes the SoT.** The agent returns structured data; the handler (daemon) performs all `INSERT`s. The agent gets read-only tools only (`design:extract` allowlist is already `[Read, Grep, Glob]`).
- **Ground truth over self-report.** Completeness checks (≥1 unit, behavioral⇒test_plan, acyclic deps, valid seqs) are deterministic daemon-side validations — never agent self-scoring.
- **Sidecar absent/malformed = transport failure**, not a verdict — the step throws so failure-policy re-dispatches (control-loop §3a). Never silently accept a missing/garbled block.
- **`track` is set to `"fast"` unconditionally in M5a.** Real fast/full sizing is coupled to `design:review` and lands in M5b. The resolver only branches on `track === "full"`; setting `"fast"` routes `design → implement` with no review step (matches current walking-skeleton behavior).
- Run the full gate before claiming done: `bun test` · `bun run lint` · `bun run typecheck` · `bun run build`.
- Two `schema.sql` copies exist (`src/db/schema.sql` is loaded at runtime; `docs/architecture/schema.sql` is the doc). **No schema change is required in M5a** — the `work_unit` columns (`title`, `description`, `test_plan`, `behavioral`, `files_to_touch`, `verify_check_types`, `depends_on`) already exist. We are only wiring the repo insert to populate columns it currently ignores.

---

## File Structure

- **Create** `src/dispatch/extract-schema.ts` — the zod schema for the extract sidecar (`ExtractedWorkUnit`, `ExtractOutputSchema`) + the deterministic `validateExtraction()` completeness check.
- **Create** `prompts/design-extract.md` — the read-only agent prompt; instructs the agent to read the committed plan and emit the `styre-sidecar` block, including behavioral classification.
- **Modify** `src/db/repos/work-unit.ts` — extend `WorkUnitRow`, `COLS`, and `insertWorkUnit` to persist `title`, `description`, `test_plan` (columns exist; insert currently ignores them).
- **Modify** `src/dispatch/run-dispatch.ts` — surface the agent's stdout: add `output: string` to `runAgentDispatch`'s return.
- **Modify** `src/dispatch/prompt-vars.ts` — add `EXTRACT_TEMPLATE` + `extractVars()`.
- **Modify** `src/dispatch/handlers.ts` — register the real `design:extract` handler in `buildDispatchRegistry`.
- **Create** `test/dispatch/extract-schema.test.ts` — schema + completeness-check unit tests.
- **Create** `test/dispatch/design-extract.test.ts` — handler end-to-end tests with `FakeAgentRunner` (the behavioral-carry test lives here).
- **Modify** `test/dispatch/work-unit.test.ts` (or create if absent) — repo round-trip test for the new columns.

---

### Task 1: Persist `title`, `description`, `test_plan` in `insertWorkUnit`

The `work_unit` table already has these columns, but `insertWorkUnit` never writes them (today `unit.title` is always `null`, which the implement prompt already reads). Extract produces all three; wire them through so they aren't lost and so `design:review`/`review` (M5b) can read them.

**Files:**
- Modify: `src/db/repos/work-unit.ts`
- Test: `test/dispatch/work-unit.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces:
  - `WorkUnitRow` gains `description: string | null` and `test_plan: string | null` (it already has `title: string | null`).
  - `insertWorkUnit(db, p)` `p` gains optional `title?: string | null`, `description?: string | null`, `testPlan?: string | null`. All default to `null`. Existing callers are unaffected.

- [ ] **Step 1: Write the failing test**

Create `test/dispatch/work-unit.test.ts`:

```typescript
import { expect, test } from "bun:test";
import { getById, insertWorkUnit } from "../../src/db/repos/work-unit.ts";
import { makeTestDb } from "../helpers/db.ts";

test("insertWorkUnit persists title, description, and test_plan", () => {
  const { db, ticketId } = makeTestDb();
  const u = insertWorkUnit(db, {
    ticketId,
    seq: 1,
    kind: "backend",
    title: "Add the widget",
    description: "Wire the widget into the registry",
    testPlan: "unit test the registry wiring",
    behavioral: 1,
  });
  const read = getById(db, u.id);
  db.close();
  expect(read?.title).toBe("Add the widget");
  expect(read?.description).toBe("Wire the widget into the registry");
  expect(read?.test_plan).toBe("unit test the registry wiring");
});

test("insertWorkUnit defaults the new text columns to null", () => {
  const { db, ticketId } = makeTestDb();
  const u = insertWorkUnit(db, { ticketId, seq: 1, kind: "backend" });
  const read = getById(db, u.id);
  db.close();
  expect(read?.title).toBeNull();
  expect(read?.description).toBeNull();
  expect(read?.test_plan).toBeNull();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/dispatch/work-unit.test.ts`
Expected: FAIL — `read.description` is `undefined`/property missing (COLS doesn't select it) and `test_plan` not persisted.

- [ ] **Step 3: Write minimal implementation**

In `src/db/repos/work-unit.ts`, extend the row interface:

```typescript
export interface WorkUnitRow {
  id: number;
  ticket_id: number;
  seq: number;
  kind: string;
  title: string | null;
  description: string | null;
  status: string;
  behavioral: number;
  files_to_touch: string | null;
  test_plan: string | null;
  verify_check_types: string | null;
  depends_on: string | null;
  created_at: string;
  updated_at: string;
}

const COLS =
  "id, ticket_id, seq, kind, title, description, status, behavioral, files_to_touch, test_plan, verify_check_types, depends_on, created_at, updated_at";
```

Extend the insert params and SQL:

```typescript
export function insertWorkUnit(
  db: Database,
  p: {
    ticketId: number;
    seq: number;
    kind: string;
    title?: string | null;
    description?: string | null;
    testPlan?: string | null;
    status?: string;
    behavioral?: number;
    filesToTouch?: string[] | null;
    verifyCheckTypes?: number[] | string[] | null;
    dependsOn?: number[] | null;
  },
): WorkUnitRow {
  const now = nowUtc();
  const res = db
    .query(
      `INSERT INTO work_unit
         (ticket_id, seq, kind, title, description, status, behavioral, files_to_touch, test_plan, verify_check_types, depends_on, created_at, updated_at)
       VALUES ($t, $seq, $kind, $title, $desc, $status, $behavioral, $ftt, $tp, $vct, $dep, $now, $now)`,
    )
    .run({
      $t: p.ticketId,
      $seq: p.seq,
      $kind: p.kind,
      $title: p.title ?? null,
      $desc: p.description ?? null,
      $status: p.status ?? "pending",
      $behavioral: p.behavioral ?? 1,
      $ftt: p.filesToTouch == null ? null : JSON.stringify(p.filesToTouch),
      $tp: p.testPlan ?? null,
      $vct: p.verifyCheckTypes == null ? null : JSON.stringify(p.verifyCheckTypes),
      $dep: p.dependsOn == null ? null : JSON.stringify(p.dependsOn),
      $now: now,
    });
  const created = getById(db, Number(res.lastInsertRowid));
  if (!created) {
    throw new Error("insertWorkUnit: row missing after insert");
  }
  return created;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/dispatch/work-unit.test.ts`
Expected: PASS (both tests).

- [ ] **Step 5: Run the full suite to confirm no regression**

Run: `bun test && bun run typecheck`
Expected: PASS. (The added `WorkUnitRow` fields are nullable and the insert params are optional, so existing call sites compile and behave unchanged.)

- [ ] **Step 6: Commit**

```bash
git add src/db/repos/work-unit.ts test/dispatch/work-unit.test.ts
git commit -m "feat(m5a): persist work_unit title/description/test_plan in insertWorkUnit"
```

---

### Task 2: Surface the agent's stdout from `runAgentDispatch`

`design:extract`'s product is the sidecar text in stdout, but `runAgentDispatch` returns only `{ dispatchId, sha, changed }`. Add `output` to the return so a structured-output step can read it. This is additive — existing callers (`design:dispatch`, `implement:dispatch`) ignore the new field.

**Files:**
- Modify: `src/dispatch/run-dispatch.ts`
- Test: `test/dispatch/run-dispatch.test.ts`

**Interfaces:**
- Consumes: `AgentRunResult.stdout` (already exists).
- Produces: `runAgentDispatch(...)` now resolves to `{ dispatchId: string; sha: string; changed: boolean; output: string }`.

- [ ] **Step 1: Write the failing test**

Add to `test/dispatch/run-dispatch.test.ts` (follow the existing fake-runner + git-repo setup already in that file):

```typescript
test("runAgentDispatch surfaces the agent stdout as output", async () => {
  // Arrange a runner whose stdout is a known marker; reuse the file's existing
  // harness (a fake runner + a real temp git repo + a HandlerContext).
  // Assert the resolved result.output === the runner's stdout.
});
```

Concretely, mirror the existing passing test in this file but assert on `result.output`. If the file's existing test already captures a `result`, add:

```typescript
expect(result.output).toBe("MARKER-STDOUT");
```

and make that test's fake runner return `stdout: "MARKER-STDOUT"`.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/dispatch/run-dispatch.test.ts`
Expected: FAIL — `result.output` is `undefined` (property absent) / type error.

- [ ] **Step 3: Write minimal implementation**

In `src/dispatch/run-dispatch.ts`, change the return type and the two `return` paths:

```typescript
export async function runAgentDispatch(
  ctx: HandlerContext,
  deps: DispatchDeps,
  spec: DispatchSpec,
): Promise<{ dispatchId: string; sha: string; changed: boolean; output: string }> {
```

and the final return:

```typescript
  completeDispatch(ctx.db, inserted.id, { outcome: "clean-success", ...completion });
  return { dispatchId: did, sha, changed, output: result.stdout };
```

(`result` is in scope; no other change.)

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/dispatch/run-dispatch.test.ts && bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/dispatch/run-dispatch.ts test/dispatch/run-dispatch.test.ts
git commit -m "feat(m5a): surface agent stdout as runAgentDispatch output"
```

---

### Task 3: Extract sidecar schema + deterministic completeness check

Define the validated structured-output interface for extract and the daemon-side completeness gate (control-loop §3a / S1b postcondition). The agent supplies an explicit `seq` per unit (so dependencies can reference seqs); the daemon validates and inserts.

**Files:**
- Create: `src/dispatch/extract-schema.ts`
- Test: `test/dispatch/extract-schema.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `ExtractedWorkUnit` (zod-inferred type) with fields: `seq: number`, `kind: string`, `title: string`, `description: string`, `behavioral: boolean`, `test_plan: string | null`, `files_to_touch: string[]`, `verify_check_types: string[]`, `depends_on: number[]`.
  - `ExtractOutputSchema` — a `ZodType<{ units: ExtractedWorkUnit[] }>`.
  - `validateExtraction(units: ExtractedWorkUnit[]): string[]` — returns a list of human-readable completeness errors (empty list ⇒ valid). Rules:
    1. ≥1 unit.
    2. `seq` values are exactly the set `{1..N}` (unique, contiguous, 1-based).
    3. Every behavioral unit has a non-empty `test_plan`.
    4. Every behavioral unit has `"test"` in `verify_check_types` (so the A1 gate is satisfiable).
    5. Every `depends_on` entry references an existing seq **strictly less than** the unit's own seq (this both rejects dangling/self refs and guarantees acyclicity).

- [ ] **Step 1: Write the failing tests**

Create `test/dispatch/extract-schema.test.ts`:

```typescript
import { expect, test } from "bun:test";
import { ExtractOutputSchema, validateExtraction } from "../../src/dispatch/extract-schema.ts";

const unit = (over: Record<string, unknown> = {}) => ({
  seq: 1,
  kind: "backend",
  title: "t",
  description: "d",
  behavioral: true,
  test_plan: "test it",
  files_to_touch: ["src/a.ts"],
  verify_check_types: ["test"],
  depends_on: [],
  ...over,
});

test("schema parses a well-formed extract block", () => {
  const r = ExtractOutputSchema.safeParse({ units: [unit()] });
  expect(r.success).toBe(true);
});

test("schema rejects a non-boolean behavioral", () => {
  const r = ExtractOutputSchema.safeParse({ units: [unit({ behavioral: "yes" })] });
  expect(r.success).toBe(false);
});

test("validateExtraction accepts a minimal valid set", () => {
  expect(validateExtraction([unit()])).toEqual([]);
});

test("validateExtraction rejects an empty unit list", () => {
  expect(validateExtraction([]).length).toBeGreaterThan(0);
});

test("validateExtraction rejects a behavioral unit with no test_plan", () => {
  expect(validateExtraction([unit({ test_plan: "" })]).length).toBeGreaterThan(0);
});

test("validateExtraction rejects a behavioral unit missing the test check-type", () => {
  expect(validateExtraction([unit({ verify_check_types: ["lint"] })]).length).toBeGreaterThan(0);
});

test("validateExtraction accepts a non-behavioral unit with no test_plan", () => {
  expect(
    validateExtraction([
      unit({ behavioral: false, test_plan: null, verify_check_types: ["lint"] }),
    ]),
  ).toEqual([]);
});

test("validateExtraction rejects non-contiguous seqs", () => {
  expect(
    validateExtraction([unit({ seq: 1 }), unit({ seq: 3, depends_on: [] })]).length,
  ).toBeGreaterThan(0);
});

test("validateExtraction rejects a forward or self dependency", () => {
  expect(validateExtraction([unit({ seq: 1, depends_on: [1] })]).length).toBeGreaterThan(0);
  expect(
    validateExtraction([unit({ seq: 1, depends_on: [] }), unit({ seq: 2, depends_on: [3] })])
      .length,
  ).toBeGreaterThan(0);
});

test("validateExtraction accepts a valid backward dependency", () => {
  expect(
    validateExtraction([
      unit({ seq: 1, depends_on: [] }),
      unit({ seq: 2, depends_on: [1] }),
    ]),
  ).toEqual([]);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test test/dispatch/extract-schema.test.ts`
Expected: FAIL — module `src/dispatch/extract-schema.ts` not found.

- [ ] **Step 3: Write minimal implementation**

Create `src/dispatch/extract-schema.ts`:

```typescript
import { z } from "zod";

/** One work-unit as proposed by design:extract (control-loop §3a). The daemon assigns nothing
 *  the agent can fake: completeness is checked deterministically by validateExtraction. */
export const ExtractedWorkUnitSchema = z.object({
  seq: z.number().int().positive(),
  kind: z.string().min(1),
  title: z.string(),
  description: z.string(),
  behavioral: z.boolean(),
  test_plan: z.string().nullable(),
  files_to_touch: z.array(z.string()),
  verify_check_types: z.array(z.string()),
  depends_on: z.array(z.number().int().positive()),
});

export type ExtractedWorkUnit = z.infer<typeof ExtractedWorkUnitSchema>;

export const ExtractOutputSchema = z.object({
  units: z.array(ExtractedWorkUnitSchema),
});

export type ExtractOutput = z.infer<typeof ExtractOutputSchema>;

/** Deterministic completeness gate (S1b postcondition). Returns human-readable errors;
 *  an empty array means the extraction is well-formed. Never throws. */
export function validateExtraction(units: ExtractedWorkUnit[]): string[] {
  const errors: string[] = [];
  if (units.length === 0) {
    errors.push("extraction has no work units");
    return errors;
  }

  const seqs = units.map((u) => u.seq);
  const seqSet = new Set(seqs);
  const expected = new Set(Array.from({ length: units.length }, (_, i) => i + 1));
  const contiguous =
    seqSet.size === seqs.length && [...expected].every((s) => seqSet.has(s));
  if (!contiguous) {
    errors.push(`seqs must be the unique contiguous set 1..${units.length}, got [${seqs.join(", ")}]`);
  }

  for (const u of units) {
    if (u.behavioral) {
      if (u.test_plan === null || u.test_plan.trim() === "") {
        errors.push(`unit seq ${u.seq} is behavioral but has no test_plan`);
      }
      if (!u.verify_check_types.includes("test")) {
        errors.push(`unit seq ${u.seq} is behavioral but verify_check_types lacks "test"`);
      }
    }
    for (const dep of u.depends_on) {
      if (dep >= u.seq) {
        errors.push(`unit seq ${u.seq} depends on ${dep}, which is not a strictly-earlier unit`);
      } else if (!seqSet.has(dep)) {
        errors.push(`unit seq ${u.seq} depends on ${dep}, which does not exist`);
      }
    }
  }
  return errors;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test test/dispatch/extract-schema.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add src/dispatch/extract-schema.ts test/dispatch/extract-schema.test.ts
git commit -m "feat(m5a): extract sidecar schema + deterministic completeness check"
```

---

### Task 4: The `design-extract` prompt + prompt-vars

The agent reads the committed plan and emits exactly one `styre-sidecar` JSON block matching `ExtractOutputSchema`. It is read-only (no Write/Edit/Bash).

**Files:**
- Create: `prompts/design-extract.md`
- Modify: `src/dispatch/prompt-vars.ts`
- Test: `test/dispatch/prompt-vars.test.ts` (extend if present; otherwise assert in the handler test in Task 5)

**Interfaces:**
- Consumes: `Profile` (for `slug`), ticket `{ ident, title }`.
- Produces:
  - `EXTRACT_TEMPLATE: string` (the imported prompt text).
  - `extractVars(ticket: { ident: string; title: string | null }, profile: Profile): Record<string, string>` returning at least `{ ident, title, slug, ...profile.promptVars }` — must cover every `{{placeholder}}` in the template.

- [ ] **Step 1: Create the prompt file**

Create `prompts/design-extract.md`:

```markdown
You are extracting the work breakdown for ticket {{ident}} ("{{title}}") in project {{slug}}.

A design plan has already been written and committed under `docs/plans/`. Read it (and any
files it references) and decompose it into an ordered list of work units the build system will
implement and verify one at a time. Do NOT write or edit any files — your only output is the
sidecar block described below.

For each work unit decide:
- **seq**: 1-based position. Number units 1..N with no gaps. A unit may only depend on
  strictly-earlier seqs (`depends_on`).
- **kind**: the work type, e.g. `backend`, `frontend`, `data`, `docs`, `config`.
- **title** / **description**: a short title and a one-paragraph description.
- **behavioral**: `true` if the unit changes observable program behavior and therefore must be
  covered by a test; `false` for docs-only, config-only, or pure-scaffolding units that cannot
  carry a behavioral test. Be deliberate: a unit marked behavioral MUST have a `test_plan` and
  MUST include `"test"` in its `verify_check_types`.
- **test_plan**: how the unit is tested (required when behavioral; use `null` otherwise).
- **files_to_touch**: the files this unit is expected to change.
- **verify_check_types**: the ground-truth checks that gate this unit, e.g. `["test"]`,
  `["lint"]`, `["build"]`. Behavioral units must include `"test"`.
- **depends_on**: seqs of earlier units that must be verified before this one.

Emit your answer as a single fenced block, exactly:

```styre-sidecar
{
  "units": [
    {
      "seq": 1,
      "kind": "backend",
      "title": "…",
      "description": "…",
      "behavioral": true,
      "test_plan": "…",
      "files_to_touch": ["src/…"],
      "verify_check_types": ["test"],
      "depends_on": []
    }
  ]
}
```
```

(Note: the closing ```` ``` ```` of the inner `styre-sidecar` example is part of the prompt text the agent should mimic.)

- [ ] **Step 2: Wire the template + vars**

In `src/dispatch/prompt-vars.ts`, add the import and exports (mirroring `DESIGN_TEMPLATE`/`designVars`):

```typescript
import designExtractTemplate from "../../prompts/design-extract.md" with { type: "text" };
// …existing imports…

export const EXTRACT_TEMPLATE = designExtractTemplate;

export function extractVars(
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

- [ ] **Step 3: Verify the template renders with no missing vars**

Add to `test/dispatch/prompt-vars.test.ts` (create if it does not exist):

```typescript
import { expect, test } from "bun:test";
import { EXTRACT_TEMPLATE, extractVars } from "../../src/dispatch/prompt-vars.ts";
import { parseProfile } from "../../src/dispatch/profile.ts";
import { renderPrompt } from "../../src/dispatch/render-prompt.ts";

test("extract template renders with extractVars (no missing placeholders)", () => {
  const profile = parseProfile({ slug: "demo", targetRepo: "/tmp/x", commands: {} });
  const r = renderPrompt(EXTRACT_TEMPLATE, extractVars({ ident: "ENG-1", title: "T" }, profile));
  expect(r.ok).toBe(true);
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/dispatch/prompt-vars.test.ts`
Expected: PASS. If FAIL with `missing: [...]`, the template has a `{{placeholder}}` not covered by `extractVars` — add it to `extractVars`.

- [ ] **Step 5: Commit**

```bash
git add prompts/design-extract.md src/dispatch/prompt-vars.ts test/dispatch/prompt-vars.test.ts
git commit -m "feat(m5a): design-extract prompt + extractVars"
```

---

### Task 5: The real `design:extract` handler

Register `design:extract` in `buildDispatchRegistry`. It runs the agent via `runAgentDispatch` (read-only, so no commit), extracts + validates the sidecar, then inserts the units with explicit `behavioral`, and sets `track = "fast"`.

**Files:**
- Modify: `src/dispatch/handlers.ts`
- Test: `test/dispatch/design-extract.test.ts`

**Interfaces:**
- Consumes: `runAgentDispatch` (now returns `output`), `extractSidecar`, `ExtractOutputSchema`, `validateExtraction`, `insertWorkUnit`, `setTicketTrack`, `EXTRACT_TEMPLATE`, `extractVars`.
- Produces: a registered `"design:extract"` handler. On success it returns `{ units: number }` (count inserted) and has written N `work_unit` rows + `ticket.track = "fast"`.

**Behavioral contract (the carry — must hold):** a unit with `behavioral: false` in the sidecar is inserted with `behavioral: 0`; a unit with `behavioral: true` is inserted with `behavioral: 1`. The handler must translate the boolean explicitly (`u.behavioral ? 1 : 0`) — never rely on the `insertWorkUnit` default.

- [ ] **Step 1: Write the failing tests**

Create `test/dispatch/design-extract.test.ts`. Reuse the `gitRepo()` + `registryFor()` + `FakeAgentRunner` pattern from `test/dispatch/handlers.test.ts` (copy those two helpers, or import if exported). The fake runner returns a sidecar block in `stdout`.

```typescript
import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeAgentRunner } from "../../src/agent/fake-runner.ts";
import { DEFAULT_AGENT_CONFIG } from "../../src/config/agent-config.ts";
import { advanceOneStep } from "../../src/daemon/advance.ts";
import { getTicket } from "../../src/db/repos/ticket.ts";
import { listByTicket } from "../../src/db/repos/work-unit.ts";
import { getByKey } from "../../src/db/repos/workflow-step.ts";
import { buildDispatchRegistry } from "../../src/dispatch/handlers.ts";
import { parseProfile } from "../../src/dispatch/profile.ts";
import { insertPending } from "../../src/db/repos/workflow-step.ts";
import { makeTestDb } from "../helpers/db.ts";

function gitRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "styre-e-"));
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
    worktreeRoot: mkdtempSync(join(tmpdir(), "styre-wtroot-")),
  });
}

const sidecar = (json: string) => `Here is the breakdown.\n\n\`\`\`styre-sidecar\n${json}\n\`\`\`\n`;

// design:dispatch must be 'succeeded' and stage 'design' so the resolver routes to design:extract.
function readyForExtract(db: ReturnType<typeof makeTestDb>["db"], ticketId: number) {
  const s = insertPending(db, { ticketId, stepKey: "design:dispatch", stepType: "dispatch" });
  db.query("UPDATE workflow_step SET status = 'succeeded' WHERE id = ?").run(s.id);
}

test("design:extract inserts units with the behavioral flag honored (carry)", async () => {
  const { db, ticketId, projectId } = makeTestDb();
  const repo = gitRepo();
  db.query("UPDATE project SET target_repo = ? WHERE id = ?").run(repo, projectId);
  readyForExtract(db, ticketId);
  const runner = new FakeAgentRunner(() => ({
    completed: true,
    exitCode: 0,
    stdout: sidecar(
      JSON.stringify({
        units: [
          {
            seq: 1,
            kind: "backend",
            title: "logic",
            description: "d",
            behavioral: true,
            test_plan: "test the logic",
            files_to_touch: ["src/a.ts"],
            verify_check_types: ["test"],
            depends_on: [],
          },
          {
            seq: 2,
            kind: "docs",
            title: "readme",
            description: "d",
            behavioral: false,
            test_plan: null,
            files_to_touch: ["README.md"],
            verify_check_types: ["build"],
            depends_on: [1],
          },
        ],
      }),
    ),
    stderr: "",
    timedOut: false,
    costUsd: null,
    tokensIn: null,
    tokensOut: null,
  }));

  const outcome = await advanceOneStep(db, ticketId, registryFor(repo, runner));
  const units = listByTicket(db, ticketId);
  const ticket = getTicket(db, ticketId);
  const step = getByKey(db, ticketId, "design:extract");
  db.close();

  expect(outcome.kind).toBe("stepped");
  expect(step?.status).toBe("succeeded");
  expect(units.length).toBe(2);
  expect(units[0]?.behavioral).toBe(1);
  expect(units[1]?.behavioral).toBe(0); // the carry: non-behavioral lands as 0, not the default 1
  expect(units[1]?.kind).toBe("docs");
  expect(ticket?.track).toBe("fast");
});

test("design:extract fails the step when the sidecar is absent (transport failure)", async () => {
  const { db, ticketId, projectId } = makeTestDb();
  const repo = gitRepo();
  db.query("UPDATE project SET target_repo = ? WHERE id = ?").run(repo, projectId);
  readyForExtract(db, ticketId);
  const runner = new FakeAgentRunner(() => ({
    completed: true,
    exitCode: 0,
    stdout: "I could not produce a breakdown.",
    stderr: "",
    timedOut: false,
    costUsd: null,
    tokensIn: null,
    tokensOut: null,
  }));
  await advanceOneStep(db, ticketId, registryFor(repo, runner));
  const step = getByKey(db, ticketId, "design:extract");
  const units = listByTicket(db, ticketId);
  db.close();
  expect(step?.status).not.toBe("succeeded");
  expect(units.length).toBe(0);
});

test("design:extract fails the step when completeness checks fail (behavioral, no test_plan)", async () => {
  const { db, ticketId, projectId } = makeTestDb();
  const repo = gitRepo();
  db.query("UPDATE project SET target_repo = ? WHERE id = ?").run(repo, projectId);
  readyForExtract(db, ticketId);
  const runner = new FakeAgentRunner(() => ({
    completed: true,
    exitCode: 0,
    stdout: sidecar(
      JSON.stringify({
        units: [
          {
            seq: 1,
            kind: "backend",
            title: "x",
            description: "d",
            behavioral: true,
            test_plan: "",
            files_to_touch: ["src/a.ts"],
            verify_check_types: ["test"],
            depends_on: [],
          },
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
  const step = getByKey(db, ticketId, "design:extract");
  const units = listByTicket(db, ticketId);
  db.close();
  expect(step?.status).not.toBe("succeeded");
  expect(units.length).toBe(0);
});
```

> Implementer note: confirm the exact `makeTestDb` return shape and the `advanceOneStep` failure semantics against `test/dispatch/handlers.test.ts` (e.g. how that file asserts a failed step's status — match its assertion style). Adjust `readyForExtract` if `makeTestDb` already seeds a `design:dispatch` step.

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test test/dispatch/design-extract.test.ts`
Expected: FAIL — no `design:extract` handler registered (`advanceOneStep` cannot find a handler / step does not succeed).

- [ ] **Step 3: Write minimal implementation**

In `src/dispatch/handlers.ts`, add imports:

```typescript
import { extractSidecar } from "./sidecar.ts";
import { ExtractOutputSchema, validateExtraction } from "./extract-schema.ts";
import { insertWorkUnit } from "../db/repos/work-unit.ts";
import { setTicketTrack } from "../db/repos/ticket.ts";
import { EXTRACT_TEMPLATE, extractVars } from "./prompt-vars.ts";
```

(Adjust the existing aggregated import lines rather than duplicating; `prompt-vars.ts` already exports `DESIGN_TEMPLATE` etc.)

Register the handler inside `buildDispatchRegistry`, after `design:dispatch`:

```typescript
  registry.register("design:extract", async (ctx: HandlerContext) => {
    const { output } = await runAgentDispatch(
      ctx,
      depsFor(ctx, deps, deps.timeoutMs ?? DESIGN_TIMEOUT_MS),
      {
        handlerKey: "design:extract",
        template: EXTRACT_TEMPLATE,
        vars: extractVars(ctx.ticket, deps.profile),
        // Read-only step: no files change, so no postcondition on the diff.
        postcondition: () => {},
      },
    );

    const parsed = extractSidecar(output, ExtractOutputSchema);
    if (!parsed.ok) {
      // Absent/malformed sidecar = transport failure (§3a) → failure-policy re-dispatches.
      throw new Error(`design:extract sidecar ${parsed.reason}: ${parsed.detail}`);
    }
    const errors = validateExtraction(parsed.value.units);
    if (errors.length > 0) {
      throw new Error(`design:extract completeness failed: ${errors.join("; ")}`);
    }

    for (const u of parsed.value.units) {
      insertWorkUnit(ctx.db, {
        ticketId: ctx.ticket.id,
        seq: u.seq,
        kind: u.kind,
        title: u.title,
        description: u.description,
        behavioral: u.behavioral ? 1 : 0, // the carry: classify explicitly, never default
        testPlan: u.test_plan,
        filesToTouch: u.files_to_touch,
        verifyCheckTypes: u.verify_check_types,
        dependsOn: u.depends_on,
      });
    }
    // M5a: always fast-track. Real fast/full sizing + design:review land together in M5b.
    setTicketTrack(ctx.db, ctx.ticket.id, "fast");
    return { units: parsed.value.units.length };
  });
```

Update the comment on `buildDispatchRegistry` (line ~80) to note `design:extract` is now real (extract → M5a; review → M5b).

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test test/dispatch/design-extract.test.ts`
Expected: PASS (all three cases; especially `units[1].behavioral === 0`).

- [ ] **Step 5: Run the full suite**

Run: `bun test`
Expected: PASS. Pay attention to `test/daemon/walking-skeleton.test.ts` — it still uses its own mock `design:extract` and is unaffected (the registry there is the skeleton, not `buildDispatchRegistry`).

- [ ] **Step 6: Commit**

```bash
git add src/dispatch/handlers.ts test/dispatch/design-extract.test.ts
git commit -m "feat(m5a): real design:extract handler (sidecar → validated work_units)"
```

---

### Task 6: Resolver hand-off check — extract → implement advance

Confirm that after the real `design:extract` succeeds, the resolver advances `design → implement` (track is `"fast"`, so no `design:review`). This guards the seam between M5a and the rest of the loop.

**Files:**
- Test: `test/daemon/resolver.test.ts` (extend)

**Interfaces:**
- Consumes: `nextStepKey`, `insertWorkUnit`, `setTicketTrack`.
- Produces: no source change — a regression guard.

- [ ] **Step 1: Write the test**

Add to `test/daemon/resolver.test.ts` (match the file's existing setup helpers):

```typescript
test("design: with fast track + units present, advances to implement (no review)", () => {
  const { db, ticketId } = makeTestDb();
  // design:dispatch succeeded
  const s = insertPending(db, { ticketId, stepKey: "design:dispatch", stepType: "dispatch" });
  db.query("UPDATE workflow_step SET status = 'succeeded' WHERE id = ?").run(s.id);
  insertWorkUnit(db, { ticketId, seq: 1, kind: "backend", verifyCheckTypes: ["test"] });
  setTicketTrack(db, ticketId, "fast");
  const next = nextStepKey(db, ticketId);
  db.close();
  expect(next).toEqual({ kind: "advance", from: "design", to: "implement" });
});
```

> Implementer note: the resolver test file already exercises `design:extract`/`design:review` routing (per recon). Place this beside those cases and reuse its existing imports (`insertPending`, `insertWorkUnit`, `setTicketTrack`, `nextStepKey`, `makeTestDb`). If an equivalent assertion already exists, skip this task and note it.

- [ ] **Step 2: Run test to verify it passes**

Run: `bun test test/daemon/resolver.test.ts`
Expected: PASS (the routing already exists in the resolver; this just pins it).

- [ ] **Step 3: Commit**

```bash
git add test/daemon/resolver.test.ts
git commit -m "test(m5a): pin extract→implement advance on the fast track"
```

---

## Final Verification (before PR)

- [ ] Run the full gate fresh (verification-before-completion):

```bash
bun test && bun run lint && bun run typecheck && bun run build
```

Expected: all pass; binary builds (and re-signs on macOS).

- [ ] Whole-branch review (subagent-driven: final Opus review), fix any Critical/Important.
- [ ] `finishing-a-development-branch`: push `feat/m5-structured-judgment`, open PR into `main`. **Do not merge** — the operator merges.
- [ ] Watch CI to green.

## Carries into M5b (do not drop)

- **Real `track` sizing** replaces the hardcoded `"fast"` here, coupled with the `design:review` handler (track=`full` is meaningless until review consumes it).
- **`design:review` + `review` (S5)** — the judgment gates, using the **reuse-existing-format** decision (findings as a sidecar block, not bespoke agent tools) and a new `review_finding` repo + daemon-derived verdict.
- **Minor wart noted:** on a completeness/sidecar failure the dispatch row is recorded `clean-success` (the agent run *did* succeed) before the handler throws — acceptable (re-dispatch is the §3a path), but if M5b adds output-aware postconditions, consider folding extract's validation into a postcondition so it records `postcondition-failed` instead.

## Self-Review

- **Spec coverage:** plan→work_units (Tasks 3–5), behavioral classification carry (Task 5, explicit `? 1 : 0` + dedicated assertion), completeness checks (Task 3), structured-output via sidecar (Tasks 2–3, 5), read-only/daemon-writes invariant (Task 5 handler), fast-track routing (Tasks 5–6). Covered.
- **Placeholder scan:** every code step shows complete code; no TBD/TODO.
- **Type consistency:** `insertWorkUnit` param names (`title`, `description`, `testPlan`, `behavioral`, `filesToTouch`, `verifyCheckTypes`, `dependsOn`) are used identically in Task 5; `ExtractedWorkUnit` field names (`seq`, `kind`, `title`, `description`, `behavioral`, `test_plan`, `files_to_touch`, `verify_check_types`, `depends_on`) match the prompt JSON and the handler mapping; `runAgentDispatch` return `output` (Task 2) is consumed in Task 5.

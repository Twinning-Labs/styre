# Design-loop convergence — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the `design → review → design` dead-end so a review loopback converges instead of blocking a ticket whose plan already exists.

**Architecture:** Two independent fixes from `docs/brainstorms/2026-07-07-design-loop-convergence-design.md`. **§3.1** — the `design:dispatch` postcondition keys on *this ticket's* plan existing (its `linear:` frontmatter) instead of demanding a fresh commit this turn. **§3.2** — a design re-dispatch carries the prior review's blocking findings into the prompt via a new `{{review_feedback}}` slot, mirroring the existing `implementFeedback` precedent. The exit (`escalate`-on-repeat) is UNCHANGED and out of scope.

**Tech Stack:** TypeScript + Bun + embedded SQLite (`bun:sqlite`). Tests: `bun test`. Prompts are markdown files imported as text.

## Global Constraints
- **No new dependencies.** Frontmatter is read with a regex, not a YAML lib (none is in `package.json`).
- **Only the runner writes state** — this is all runner-side code; no change to agent output contracts.
- **Exit rule is out of scope.** Do NOT touch `review-verdict.ts`, `escalate`, or `isRepeatedReviewLoopback`.
- **`renderPrompt` fails closed on an unfilled placeholder** (`render-prompt.ts`: a `{{x}}` with no `vars.x` → `{ ok:false, missing:["x"] }`). So `designVars` MUST provide `review_feedback` (default `""`) — Task 4 adds the var and the template slot together.
- Run each task's test with `bun test <path>`. Commit after each task.

---

### Task 1: `plan-frontmatter` reader

**Files:**
- Create: `src/dispatch/plan-frontmatter.ts`
- Test: `test/dispatch/plan-frontmatter.test.ts`

**Interfaces:**
- Produces: `planFrontmatterLinear(path: string): string | null` — the `linear:` value from a markdown file's leading `---`-fenced frontmatter, else `null`. `hasTicketPlan(plansDir: string, ident: string): boolean` — true iff `plansDir` holds a `.md` whose frontmatter `linear:` equals `ident`; false if `plansDir` is absent.

- [ ] **Step 1: Write the failing test**

```ts
// test/dispatch/plan-frontmatter.test.ts
import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { planFrontmatterLinear, hasTicketPlan } from "../../src/dispatch/plan-frontmatter.ts";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "styre-pf-"));
}

test("planFrontmatterLinear reads linear: from leading frontmatter", () => {
  const d = tmp();
  const p = join(d, "ENG-1-slug.md");
  writeFileSync(p, "---\nlinear: ENG-1\n---\n# Plan\nbody\n");
  expect(planFrontmatterLinear(p)).toBe("ENG-1");
});

test("planFrontmatterLinear returns null without frontmatter", () => {
  const d = tmp();
  const p = join(d, "x.md");
  writeFileSync(p, "# Plan\nlinear: ENG-1 (in body, not frontmatter)\n");
  expect(planFrontmatterLinear(p)).toBeNull();
});

test("planFrontmatterLinear returns null for a missing file", () => {
  expect(planFrontmatterLinear(join(tmp(), "nope.md"))).toBeNull();
});

test("hasTicketPlan matches only this ticket's plan", () => {
  const plans = join(tmp(), "docs", "plans");
  mkdirSync(plans, { recursive: true });
  writeFileSync(join(plans, "ENG-1.md"), "---\nlinear: ENG-1\n---\n");
  writeFileSync(join(plans, "ENG-2.md"), "---\nlinear: ENG-2\n---\n");
  expect(hasTicketPlan(plans, "ENG-1")).toBe(true);
  expect(hasTicketPlan(plans, "ENG-3")).toBe(false); // only a stale/other-ticket plan present
});

test("hasTicketPlan is false when the plans dir is absent", () => {
  expect(hasTicketPlan(join(tmp(), "docs", "plans"), "ENG-1")).toBe(false);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test test/dispatch/plan-frontmatter.test.ts`
Expected: FAIL — `Cannot find module '.../plan-frontmatter.ts'`.

- [ ] **Step 3: Implement**

```ts
// src/dispatch/plan-frontmatter.ts
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/** The `linear:` value from a plan markdown file's leading `---`-fenced frontmatter, or null.
 *  A tiny reader (no YAML dep): only the leading frontmatter block is scanned, so a `linear:`
 *  mention in the plan BODY does not count. */
export function planFrontmatterLinear(path: string): string | null {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return null; // missing/unreadable
  }
  const fm = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (fm === null) return null;
  const line = fm[1].match(/^linear:\s*(\S+)\s*$/m);
  return line ? line[1] : null;
}

/** True iff the given `docs/plans/` dir holds a `.md` whose frontmatter `linear:` equals `ident`
 *  — a plan for THIS ticket exists. False if the dir is absent. */
export function hasTicketPlan(plansDir: string, ident: string): boolean {
  if (!existsSync(plansDir)) return false;
  return readdirSync(plansDir)
    .filter((f) => f.endsWith(".md"))
    .some((f) => planFrontmatterLinear(join(plansDir, f)) === ident);
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `bun test test/dispatch/plan-frontmatter.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/dispatch/plan-frontmatter.ts test/dispatch/plan-frontmatter.test.ts
git commit -m "feat(design-loop): plan-frontmatter reader (ticket-scoped plan check)"
```

---

### Task 2: Ticket-scoped `design:dispatch` postcondition

**Files:**
- Modify: `src/dispatch/handlers.ts:195-203` (the `design:dispatch` postcondition)
- Test: `test/dispatch/handlers.test.ts` (add two tests)

**Interfaces:**
- Consumes: `hasTicketPlan(plansDir, ident)` (Task 1).

- [ ] **Step 1: Write the failing tests**

Add to `test/dispatch/handlers.test.ts` (reuses its `gitRepo`, `registryFor`, `makeTestDb` helpers):

```ts
import { mkdirSync } from "node:fs"; // add to the existing node:fs import

test("design:dispatch passes when the agent writes this ticket's plan", async () => {
  const { db, ticketId, projectId } = makeTestDb();
  const repo = gitRepo();
  db.query("UPDATE project SET target_repo = ? WHERE id = ?").run(repo, projectId);
  db.query("UPDATE ticket SET stage = 'design' WHERE id = ?").run(ticketId);
  const ident = db.query<{ ident: string }, [number]>("SELECT ident FROM ticket WHERE id = ?").get(ticketId)!.ident;
  const runner = new FakeAgentRunner((input) => {
    mkdirSync(join(input.cwd, "docs", "plans"), { recursive: true });
    writeFileSync(join(input.cwd, "docs", "plans", `${ident}.md`), `---\nlinear: ${ident}\n---\n# Plan\n`);
    return { completed: true, exitCode: 0, stdout: "{}", stderr: "", timedOut: false, costUsd: null, tokensIn: null, tokensOut: null };
  });
  await advanceOneStep(db, ticketId, registryFor(repo, runner));
  const d = listByTicket(db, ticketId);
  db.close();
  expect(d.at(-1)?.outcome).toBe("clean-success");
});

test("design:dispatch fails the postcondition when no plan for this ticket exists", async () => {
  const { db, ticketId, projectId } = makeTestDb();
  const repo = gitRepo();
  db.query("UPDATE project SET target_repo = ? WHERE id = ?").run(repo, projectId);
  db.query("UPDATE ticket SET stage = 'design' WHERE id = ?").run(ticketId);
  const runner = new FakeAgentRunner(() => // writes NO plan
    ({ completed: true, exitCode: 0, stdout: "{}", stderr: "", timedOut: false, costUsd: null, tokensIn: null, tokensOut: null }));
  await advanceOneStep(db, ticketId, registryFor(repo, runner));
  const d = listByTicket(db, ticketId);
  db.close();
  expect(d.at(-1)?.outcome).toBe("postcondition-failed");
});
```

> If `listByTicket` rows don't expose `outcome` under that name, confirm the dispatch row column from `src/db/repos/dispatch.ts` and adjust the assertion (the `no-op-revision-over-an-existing-plan → pass` path itself is unit-covered by Task 1's `hasTicketPlan`).

- [ ] **Step 2: Run to verify it fails**

Run: `bun test test/dispatch/handlers.test.ts`
Expected: the "passes when the agent writes this ticket's plan" test may already pass (old code accepts a fresh commit); the failure that matters appears in Step 4's regression once the postcondition changes. Run now to confirm the two new tests execute (green/consistent baseline).

- [ ] **Step 3: Implement — replace the postcondition body**

In `src/dispatch/handlers.ts`, add the import near the other `./` imports:
```ts
import { hasTicketPlan } from "./plan-frontmatter.ts";
```
Replace the `design:dispatch` postcondition (currently lines ~195-203):
```ts
      postcondition: () => {
        const plansDir = join(depsFor(ctx, deps, deps.timeoutMs ?? DESIGN_TIMEOUT_MS).worktreePath, "docs", "plans");
        if (!hasTicketPlan(plansDir, ctx.ticket.ident)) {
          throw new Error("design:dispatch postcondition: no plan for this ticket under docs/plans/");
        }
      },
```
> The postcondition previously used the `{ worktreePath, changed }` arg; drop `changed` (it is the wrong question — see spec §2.1) and derive `worktreePath` the same way the dispatch does. If `worktreePath` is more cleanly available on the postcondition arg object, prefer that: `postcondition: ({ worktreePath }) => { if (!hasTicketPlan(join(worktreePath, "docs", "plans"), ctx.ticket.ident)) throw ... }` — confirm the arg shape at `run-dispatch.ts:33` and use the simpler form.

- [ ] **Step 4: Run to verify**

Run: `bun test test/dispatch/handlers.test.ts`
Expected: PASS — both new tests, and the existing implement tests unaffected.

- [ ] **Step 5: Commit**

```bash
git add src/dispatch/handlers.ts test/dispatch/handlers.test.ts
git commit -m "fix(design-loop): design:dispatch postcondition keys on this ticket's plan, not a fresh commit"
```

---

### Task 3: `designFeedback` reader

**Files:**
- Create: `src/dispatch/design-feedback.ts`
- Test: `test/dispatch/design-feedback.test.ts`

**Interfaces:**
- Consumes: `latestDispatchForStep`, `listByDispatch`, `insertFinding` from `src/db/repos/review-finding.ts`.
- Produces: `designFeedback(db: Database, ticketId: number): string` — the ticket's most recent `design:review` blocking findings, formatted with a disposition demand; `""` when there is no prior review or nothing blocking.

- [ ] **Step 1: Write the failing test**

```ts
// test/dispatch/design-feedback.test.ts
import { expect, test } from "bun:test";
import { insertFinding } from "../../src/db/repos/review-finding.ts";
import { designFeedback } from "../../src/dispatch/design-feedback.ts";
import { makeTestDb } from "../helpers/db.ts";
import { insertDesignReviewDispatch } from "../helpers/dispatch-fixtures.ts";

test("designFeedback is empty with no prior review", () => {
  const { db, ticketId } = makeTestDb();
  expect(designFeedback(db, ticketId)).toBe("");
  db.close();
});

test("designFeedback returns only the blocking findings of the latest review", () => {
  const { db, ticketId } = makeTestDb();
  const dispatchId = insertDesignReviewDispatch(db, ticketId); // creates a design:review step + dispatch row
  insertFinding(db, { ticketId, dispatchId, reviewKind: "plan", severity: "major", category: "consistency",
    location: "docs/plans/ENG-1.md:45", rationale: "regex breaks the offset invariant", blocksShip: 1, status: "open" });
  insertFinding(db, { ticketId, dispatchId, reviewKind: "plan", severity: "nit", category: "scope",
    location: null, rationale: "trivial", blocksShip: 0, status: "open" });
  const out = designFeedback(db, ticketId);
  db.close();
  expect(out).toContain("regex breaks the offset invariant");
  expect(out).toContain("docs/plans/ENG-1.md:45");
  expect(out).not.toContain("trivial"); // non-blocking excluded
  expect(out).toContain("no changes needed"); // the disposition demand
});
```

> `insertFinding`'s exact param names (`blocksShip` vs `blocks_ship`, `reviewKind`) are at `review-finding.ts:34-56` — match them. `insertDesignReviewDispatch` is a **new tiny test helper** (Step 3) that inserts a `design:review` workflow_step + a `dispatch` row owned by it so `latestDispatchForStep(db, ticketId, "design:review")` resolves; build it from `src/db/repos/dispatch.ts` + `src/db/repos/workflow-step.ts` (mirror how `latestDispatchForStep`'s JOIN at `review-finding.ts:105-118` links them). Return its `dispatch_id`.

- [ ] **Step 2: Run to verify it fails**

Run: `bun test test/dispatch/design-feedback.test.ts`
Expected: FAIL — missing `design-feedback.ts` (and the fixture helper).

- [ ] **Step 3: Implement**

```ts
// src/dispatch/design-feedback.ts
import type { Database } from "bun:sqlite";
import { latestDispatchForStep, listByDispatch } from "../db/repos/review-finding.ts";

/** Corrective feedback for a design re-dispatch after a plan-review loopback: the blocking findings
 *  from the ticket's most recent `design:review`, verbatim, with a disposition demand. Empty string
 *  when there is no prior review or it raised nothing blocking — so a first design dispatch renders
 *  a blank `{{review_feedback}}` slot. Mirrors `implementFeedback` (feedback.ts). */
export function designFeedback(db: Database, ticketId: number): string {
  const dispatchId = latestDispatchForStep(db, ticketId, "design:review");
  if (dispatchId === null) return "";
  const blocking = listByDispatch(db, ticketId, dispatchId).filter(
    (f) => f.status === "open" && f.blocks_ship === 1,
  );
  if (blocking.length === 0) return "";
  const lines = blocking.map(
    (f) => `- [${f.category ?? "?"}] ${f.location ?? "plan-wide"}: ${f.rationale ?? ""}`,
  );
  return (
    "## Prior plan-review feedback (address before finalizing)\n\n" +
    "A prior plan review raised the following. For EACH, either revise the plan to address it, or " +
    'state explicitly in the plan why it does not apply or is an accepted trade-off — a bare "no ' +
    'changes needed" is not a disposition:\n' +
    lines.join("\n")
  );
}
```
Also create `test/helpers/dispatch-fixtures.ts` with `insertDesignReviewDispatch(db, ticketId): string` (see Step 1 note).

- [ ] **Step 4: Run to verify it passes**

Run: `bun test test/dispatch/design-feedback.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/dispatch/design-feedback.ts test/dispatch/design-feedback.test.ts test/helpers/dispatch-fixtures.ts
git commit -m "feat(design-loop): designFeedback reads the latest plan-review's blocking findings"
```

---

### Task 4: Wire `{{review_feedback}}` into the design prompt

**Files:**
- Modify: `src/dispatch/prompt-vars.ts:75-89` (`designVars` — add param + key)
- Modify: `prompts/design.md` (add the `{{review_feedback}}` slot)
- Modify: `src/dispatch/handlers.ts:194` (pass `designFeedback(...)`)
- Test: `test/dispatch/prompt-vars.test.ts` (create or extend)

**Interfaces:**
- Consumes: `designFeedback` (Task 3), `renderPrompt` (`render-prompt.ts`), `DESIGN_TEMPLATE`.

- [ ] **Step 1: Write the failing test**

```ts
// test/dispatch/prompt-vars.test.ts
import { expect, test } from "bun:test";
import { DESIGN_TEMPLATE, designVars } from "../../src/dispatch/prompt-vars.ts";
import { placeholders, renderPrompt } from "../../src/dispatch/render-prompt.ts";
import { parseProfile } from "../../src/dispatch/profile.ts";

const profile = parseProfile({ slug: "demo", targetRepo: "/x", components: [] });
const ticket = { ident: "ENG-1", title: "t", description: "d" };

test("design template has a review_feedback slot", () => {
  expect(placeholders(DESIGN_TEMPLATE)).toContain("review_feedback");
});

test("designVars fills review_feedback (empty default renders cleanly)", () => {
  const r1 = renderPrompt(DESIGN_TEMPLATE, designVars(ticket, profile));
  expect(r1.ok).toBe(true); // no `missing` — default "" fills the slot

  const r2 = renderPrompt(DESIGN_TEMPLATE, designVars(ticket, profile, "PRIOR REVIEW: fix the regex"));
  expect(r2.ok && r2.prompt.includes("PRIOR REVIEW: fix the regex")).toBe(true);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test test/dispatch/prompt-vars.test.ts`
Expected: FAIL — `placeholders(DESIGN_TEMPLATE)` lacks `review_feedback`; and `renderPrompt` would report it missing.

- [ ] **Step 3: Implement — three edits**

(a) `prompts/design.md` — insert after the `{{description}}` block, before "Write a brainstorm…":
```
{{review_feedback}}
```

(b) `src/dispatch/prompt-vars.ts` — `designVars` gains a param + key:
```ts
export function designVars(
  ticket: { ident: string; title: string | null; description: string | null },
  profile: Profile,
  reviewFeedback = "",
): Record<string, string> {
  return {
    ident: ticket.ident,
    title: ticket.title ?? "",
    description: ticket.description ?? "",
    slug: profile.slug,
    stack: "",
    detected_stacks: detectedStacksVar(profile),
    review_feedback: reviewFeedback,
    ...profile.promptVars,
    ...runtimeVars(profile),
  };
}
```

(c) `src/dispatch/handlers.ts` — import `designFeedback` and pass it at line ~194:
```ts
import { designFeedback } from "./design-feedback.ts";
// …
      vars: designVars(ctx.ticket, deps.profile, designFeedback(ctx.db, ctx.ticket.id)),
```

- [ ] **Step 4: Run to verify**

Run: `bun test test/dispatch/prompt-vars.test.ts test/dispatch/handlers.test.ts`
Expected: PASS — the template renders with and without feedback; handler tests unaffected.

- [ ] **Step 5: Commit**

```bash
git add src/dispatch/prompt-vars.ts prompts/design.md src/dispatch/handlers.ts test/dispatch/prompt-vars.test.ts
git commit -m "feat(design-loop): carry prior plan-review findings into the design re-dispatch"
```

---

## Final verification
Run the full dispatch suite + typecheck:
```bash
bun test test/dispatch/
bun run typecheck   # or: bunx tsc --noEmit
```
Expected: all green.

## Self-Review
- **Spec coverage:** §3.1 → Tasks 1+2 (ticket-scoped postcondition via frontmatter). §3.2 → Tasks 3+4 (designFeedback + `{{review_feedback}}` slot + handler wiring). §3.3 (exit) → intentionally untouched (Global Constraints). Both shipped items covered.
- **Placeholders:** all code blocks are complete; the only "confirm exact name" notes are for repo column/param names (`outcome`, `insertFinding` params, the postcondition arg shape) that the implementer verifies against the cited files — not gaps in logic.
- **Type consistency:** `hasTicketPlan(plansDir, ident)` used identically in Task 1 (def) and Task 2 (call); `designFeedback(db, ticketId)` def (Task 3) matches the call (Task 4); `designVars(ticket, profile, reviewFeedback="")` signature consistent across Task 4's edits and the handler call.
- **Ordering:** Task 4 adds the `review_feedback` var and the template slot in the *same* task — required, because `renderPrompt` fails closed on an unfilled placeholder.

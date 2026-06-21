# M3b — Real Dispatch (`claude -p`) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace M2's mock `design:dispatch` / `implement:dispatch` handlers with real agent dispatch — assemble model + allowlist + rendered prompt, run `claude -p` in the ticket's worktree (behind an injectable boundary), journal the dispatch + the subprocess pid, daemon-commit the worktree (CL-COMMIT), and enforce each step's postcondition.

**Architecture:** The literal `claude -p` spawn lives behind a `ClaudeRunner` interface (`src/dispatch/claude-runner.ts`) — a `FakeClaudeRunner` drives all offline tests (it simulates the agent by writing files into the worktree and returning a scripted result), while the real `spawnClaudeRunner()` is exercised only by a manual smoke. `runAgentDispatch` (`src/dispatch/run-dispatch.ts`) is the shared orchestration that chains the M3a pieces (renderPrompt+CL-PROFILE → ensureWorktree → insertDispatch → resolveModel/allowlistFor → runner.run → journal subprocess pid → commitWorktree(CL-COMMIT) → completeDispatch → postcondition). The two real handlers (`src/dispatch/handlers.ts`) specialize it; `buildDispatchRegistry(deps)` registers them into a `StepRegistry` for the loop. This is **M3b** (the second half of M3; M3a delivered the testable infra).

**Tech Stack:** Bun, `bun:sqlite`, `bun test`, Biome (`organizeImports` enabled), zod. Host dep: the `claude` CLI (real adapter + smoke only).

## Global Constraints

- **Runtime is Bun**; `bun:sqlite`; `bun test`; `Bun.spawn` for the real `claude -p`. No new deps.
- **The real `claude -p` is isolated behind `ClaudeRunner`** — every test uses `FakeClaudeRunner`; CI never calls `claude`. Only the manual smoke (Task 6) runs the real adapter.
- **Capability isolation (move 4):** the dispatch passes the per-step allowlist (`allowlistFor`, M3a) to `claude --allowedTools`; the worktree is the only writable surface; no outward tools. **CL-COMMIT:** the daemon commits via `commitWorktree` (M3a) with a deterministic message carrying the `dispatch_id`; the agent never commits.
- **Single-writer (B2):** the handler runs inside `runStep`'s `execute`; it returns the result the daemon journals. Worktree edits are the agent's; the DB is the daemon's.
- **CL-PROFILE:** `renderPrompt` (M3a) reports unresolved placeholders → `runAgentDispatch` throws a setup error (escalated by failure-policy). **CL-POSTCOND:** each dispatch has a daemon-checked postcondition (design → a plan doc committed under `docs/plans/`; implement → non-empty diff). A clean run that fails its postcondition is that step's failure (thrown → failure-policy).
- **Crash orphan-kill (control-loop §6.1):** the real `claude` subprocess pid is journaled into `workflow_step.pid` (via `setPid`) so `recover()` kills the orphaned worker, not the daemon.
- **Handlers throw on failure** (so `runStep` marks the step failed and `advanceOneStep`'s catch routes to failure-policy — the catch keys off row status). Never return a "failed" sentinel.
- **Timeouts:** the real `ClaudeRunner` and the git helper run under a timeout (per-stage: design 60m, others 30m — minimal-loop §4); a timed-out dispatch is a transport failure (re-dispatch).
- **Timestamps stored UTC (DS-1)**; conventions: `.ts` imports; `verbatimModuleSyntax` (`import type`); **Biome `organizeImports` is enabled** — run `bun run lint`, and apply `biome check --write .` to organize imports; `noNonNullAssertion`; double quotes; 2-space/100-col; `noUnusedLocals`/`noUnusedParameters`.
- **Before committing each task:** `bun test && bun run lint && bun run typecheck` clean (M0–M3a + prior M3b tasks green).
- **`.superpowers/sdd/` is gitignored — never `git add -f` a report.**
- **Dev workflow:** branch-only (`feat/m3b-dispatch-real`); no commits to `main`; Conventional Commits; no auto-merge. TDD throughout.

### Interfaces you build on (M3a/M2/M1 — exact)

- M3a: `resolveModel(handlerKey,{loopback?})`, `allowlistFor(handlerKey)`, `renderPrompt(template,vars)→{ok,prompt}|{ok:false,missing}`, `placeholders`, `loadProfile`/`parseProfile`/`Profile`, `extractSidecar`, `ensureWorktree(repoPath,branch,worktreePath)`, `worktreeHasChanges`, `commitWorktree(worktreePath,message)→{sha,changed}`, `removeWorktree`, dispatch repo (`nextSeq`, `insertDispatch`, `completeDispatch`, `getByDispatchId`, `listByTicket`).
- M2/M1: `StepRegistry`/`StepHandler`/`HandlerContext {db,ticket,step,workUnitId}` (`step-registry.ts`); `runStep` (handlers run inside `execute`); `TicketRow {id,project_id,ident,stage,status,track,needs_docs}` + setters; `getProject` (`project.ts`, has `target_repo`); `work-unit` repo (`getById`, `setStatus`); `workflow-step` repo.

> **Note:** the real `claude` CLI flag names / `--output-format json` schema (`--allowedTools` vs `--allowed-tools`, the usage/cost field names) are CLI-version-specific. Task 2 keeps arg-building in a pure, testable `buildClaudeArgs` and the JSON parse in a small `parseClaudeJson`; **their exact field/flag names are verified against a real `claude -p` run in Task 6's smoke** and corrected there. All downstream code depends only on the `ClaudeRunResult` shape, which is fixed.

---

### Task 1: repo extensions — `setPid` + ticket branch

**Files:**
- Modify: `src/db/repos/workflow-step.ts` (add `setPid`)
- Modify: `src/db/repos/ticket.ts` (add `branch_name`/`branch_prefix`/`type_label` to `TicketRow`; add `setBranch`)
- Create: `src/dispatch/branch.ts` (`branchNameFor`)
- Test: `test/db/repos/m3b-repo-ext.test.ts`
- Test: `test/dispatch/branch.test.ts`

**Interfaces:**
- Produces:
  - `setPid(db, id: number, pid: number | null): void` (`workflow-step.ts`) — set `workflow_step.pid` (for orphan-kill journaling).
  - `TicketRow` gains `branch_name: string | null`, `branch_prefix: string | null`, `type_label: string | null`; `setBranch(db, id: number, branchName: string): void` (`ticket.ts`).
  - `branchNameFor(ticket: { ident: string; branch_name: string | null; branch_prefix: string | null }): string` (`src/dispatch/branch.ts`) — returns `ticket.branch_name` if set, else `` `${ticket.branch_prefix ?? "feat"}/${ticket.ident}` ``.

- [ ] **Step 1: Write the failing test** — `test/db/repos/m3b-repo-ext.test.ts`

```ts
import { expect, test } from "bun:test";
import { makeTestDb } from "../../helpers/db.ts";
import { getTicket, insertTicket, setBranch } from "../../../src/db/repos/ticket.ts";
import { getById, insertPending, setPid } from "../../../src/db/repos/workflow-step.ts";

test("setPid sets and clears the workflow_step pid", () => {
  const { db, ticketId } = makeTestDb();
  const step = insertPending(db, { ticketId, stepKey: "design:dispatch", stepType: "dispatch" });
  setPid(db, step.id, 4242);
  expect(getById(db, step.id)?.pid).toBe(4242);
  setPid(db, step.id, null);
  const after = getById(db, step.id);
  db.close();
  expect(after?.pid).toBeNull();
});

test("ticket exposes branch fields and setBranch persists branch_name", () => {
  const { db, projectId } = makeTestDb();
  const id = insertTicket(db, { projectId, ident: "ENG-9" });
  const before = getTicket(db, id);
  setBranch(db, id, "feat/ENG-9-slug");
  const after = getTicket(db, id);
  db.close();
  expect(before?.branch_name).toBeNull();
  expect(after?.branch_name).toBe("feat/ENG-9-slug");
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test test/db/repos/m3b-repo-ext.test.ts`
Expected: FAIL — `setPid`/`setBranch` not exported (and `branch_name` not on `TicketRow`).

- [ ] **Step 3: Add `setPid` to `src/db/repos/workflow-step.ts`**

Append this function (keep all existing exports/imports):

```ts
export function setPid(db: Database, id: number, pid: number | null): void {
  db.query("UPDATE workflow_step SET pid = $pid, updated_at = $now WHERE id = $id").run({
    $pid: pid,
    $now: nowUtc(),
    $id: id,
  });
}
```

- [ ] **Step 4: Extend `src/db/repos/ticket.ts`**

Add the three columns to `TicketRow` and `COLS`, and add `setBranch`. The `TicketRow` interface and `COLS` become:

```ts
export interface TicketRow {
  id: number;
  project_id: number;
  ident: string;
  stage: string;
  status: string;
  track: string | null;
  needs_docs: number;
  branch_name: string | null;
  branch_prefix: string | null;
  type_label: string | null;
}

const COLS =
  "id, project_id, ident, stage, status, track, needs_docs, branch_name, branch_prefix, type_label";
```

Append `setBranch` (keep all other functions unchanged):

```ts
export function setBranch(db: Database, id: number, branchName: string): void {
  db.query("UPDATE ticket SET branch_name = $b, updated_at = $now WHERE id = $id").run({
    $b: branchName,
    $now: nowUtc(),
    $id: id,
  });
}
```

- [ ] **Step 5: Write the failing test** — `test/dispatch/branch.test.ts`

```ts
import { expect, test } from "bun:test";
import { branchNameFor } from "../../src/dispatch/branch.ts";

test("uses an explicit branch_name when present", () => {
  expect(branchNameFor({ ident: "ENG-9", branch_name: "feat/ENG-9-x", branch_prefix: "feat" })).toBe("feat/ENG-9-x");
});

test("derives from prefix + ident when branch_name is null", () => {
  expect(branchNameFor({ ident: "ENG-9", branch_name: null, branch_prefix: "fix" })).toBe("fix/ENG-9");
});

test("defaults the prefix to feat when both are null", () => {
  expect(branchNameFor({ ident: "ENG-9", branch_name: null, branch_prefix: null })).toBe("feat/ENG-9");
});
```

- [ ] **Step 6: Run it to verify it fails**

Run: `bun test test/dispatch/branch.test.ts`
Expected: FAIL — `Cannot find module '../../src/dispatch/branch.ts'`.

- [ ] **Step 7: Create `src/dispatch/branch.ts`**

```ts
/** The feature branch for a ticket: an explicit branch_name wins; else `<prefix>/<ident>`
 *  (prefix defaults to "feat"). Bug tickets use "fix" via branch_prefix (DS / control-loop). */
export function branchNameFor(ticket: {
  ident: string;
  branch_name: string | null;
  branch_prefix: string | null;
}): string {
  if (ticket.branch_name) {
    return ticket.branch_name;
  }
  return `${ticket.branch_prefix ?? "feat"}/${ticket.ident}`;
}
```

- [ ] **Step 8: Run both tests + full suite**

Run: `bun test test/db/repos/m3b-repo-ext.test.ts test/dispatch/branch.test.ts && bun test`
Expected: the two new files PASS; full suite stays green (the `TicketRow` widening is additive — existing M2 callers still compile).

- [ ] **Step 9: Verify lint + typecheck**

Run: `bun run lint && bun run typecheck`
Expected: clean.

- [ ] **Step 10: Commit**

```bash
git add src/db/repos/workflow-step.ts src/db/repos/ticket.ts src/dispatch/branch.ts test/db/repos/m3b-repo-ext.test.ts test/dispatch/branch.test.ts
git commit -m "feat(m3b): workflow_step.setPid + ticket branch fields + branchNameFor"
```

---

### Task 2: `ClaudeRunner` boundary (interface, fake, real adapter)

**Files:**
- Create: `src/dispatch/claude-runner.ts`
- Test: `test/dispatch/claude-runner.test.ts`

**Interfaces:**
- Produces (all on `src/dispatch/claude-runner.ts`):
  - `interface ClaudeRunInput { prompt: string; model: string; allowedTools: string[]; cwd: string; timeoutMs: number; onSpawn?: (pid: number) => void }`
  - `interface ClaudeRunResult { completed: boolean; exitCode: number | null; stdout: string; stderr: string; timedOut: boolean; costUsd: number | null; tokensIn: number | null; tokensOut: number | null }`
  - `interface ClaudeRunner { run(input: ClaudeRunInput): Promise<ClaudeRunResult> }`
  - `buildClaudeArgs(input: { model: string; allowedTools: string[] }): string[]` — the `claude -p` argv (pure, testable).
  - `parseClaudeJson(stdout: string): { costUsd: number | null; tokensIn: number | null; tokensOut: number | null }` — best-effort parse of `--output-format json` usage; returns nulls if unparseable.
  - `class FakeClaudeRunner implements ClaudeRunner` — constructed with a handler `(input) => ClaudeRunResult | Promise<ClaudeRunResult>`; records `inputs: ClaudeRunInput[]`; calls `onSpawn(424242)` before invoking the handler.
  - `spawnClaudeRunner(): ClaudeRunner` — the REAL adapter (`Bun.spawn`); its exact flags/JSON fields are smoke-verified in Task 6.

- [ ] **Step 1: Write the failing test** — `test/dispatch/claude-runner.test.ts`

```ts
import { expect, test } from "bun:test";
import { FakeClaudeRunner, buildClaudeArgs, parseClaudeJson } from "../../src/dispatch/claude-runner.ts";
import type { ClaudeRunInput, ClaudeRunResult } from "../../src/dispatch/claude-runner.ts";

test("buildClaudeArgs assembles -p, json output, model, and allowed tools", () => {
  const args = buildClaudeArgs({ model: "claude-opus-4-8", allowedTools: ["Read", "Write"] });
  expect(args).toContain("-p");
  expect(args).toContain("--model");
  expect(args).toContain("claude-opus-4-8");
  expect(args.join(" ")).toContain("Read");
});

test("parseClaudeJson extracts usage, tolerating missing fields", () => {
  const good = parseClaudeJson(JSON.stringify({ total_cost_usd: 0.5, usage: { input_tokens: 10, output_tokens: 3 } }));
  expect(good.costUsd).toBe(0.5);
  const bad = parseClaudeJson("not json");
  expect(bad).toEqual({ costUsd: null, tokensIn: null, tokensOut: null });
});

test("FakeClaudeRunner records inputs and fires onSpawn before the handler", async () => {
  const seen: number[] = [];
  const result: ClaudeRunResult = { completed: true, exitCode: 0, stdout: "ok", stderr: "", timedOut: false, costUsd: null, tokensIn: null, tokensOut: null };
  const runner = new FakeClaudeRunner((input: ClaudeRunInput) => {
    expect(seen).toEqual([424242]); // onSpawn already fired
    return result;
  });
  const out = await runner.run({ prompt: "hi", model: "m", allowedTools: [], cwd: "/tmp", timeoutMs: 1000, onSpawn: (pid) => seen.push(pid) });
  expect(out.completed).toBe(true);
  expect(runner.inputs.length).toBe(1);
  expect(runner.inputs[0]?.prompt).toBe("hi");
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test test/dispatch/claude-runner.test.ts`
Expected: FAIL — `Cannot find module '../../src/dispatch/claude-runner.ts'`.

- [ ] **Step 3: Create `src/dispatch/claude-runner.ts`**

```ts
export interface ClaudeRunInput {
  prompt: string;
  model: string;
  allowedTools: string[];
  cwd: string;
  timeoutMs: number;
  onSpawn?: (pid: number) => void;
}

export interface ClaudeRunResult {
  completed: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  costUsd: number | null;
  tokensIn: number | null;
  tokensOut: number | null;
}

export interface ClaudeRunner {
  run(input: ClaudeRunInput): Promise<ClaudeRunResult>;
}

/** The `claude -p` argv (pure). Flag names are CLI-version-specific — verified against a
 *  real `claude` run in the Task 6 smoke. Downstream code never depends on these args. */
export function buildClaudeArgs(input: { model: string; allowedTools: string[] }): string[] {
  return [
    "-p",
    "--output-format",
    "json",
    "--model",
    input.model,
    "--allowedTools",
    input.allowedTools.join(" "),
  ];
}

/** Best-effort parse of `claude -p --output-format json` usage. Returns nulls if the shape
 *  differs (the orchestration treats usage as forensic, never control flow). Field names are
 *  smoke-verified in Task 6. */
export function parseClaudeJson(stdout: string): {
  costUsd: number | null;
  tokensIn: number | null;
  tokensOut: number | null;
} {
  try {
    const obj = JSON.parse(stdout) as Record<string, unknown>;
    const usage = (obj.usage ?? {}) as Record<string, unknown>;
    const num = (v: unknown): number | null => (typeof v === "number" ? v : null);
    return {
      costUsd: num(obj.total_cost_usd),
      tokensIn: num(usage.input_tokens),
      tokensOut: num(usage.output_tokens),
    };
  } catch {
    return { costUsd: null, tokensIn: null, tokensOut: null };
  }
}

/** Test double: scripts claude's behavior (the handler may write files into `cwd` to
 *  simulate the agent editing the worktree) and returns a scripted result. */
export class FakeClaudeRunner implements ClaudeRunner {
  readonly inputs: ClaudeRunInput[] = [];
  constructor(
    private readonly handler: (input: ClaudeRunInput) => ClaudeRunResult | Promise<ClaudeRunResult>,
  ) {}

  async run(input: ClaudeRunInput): Promise<ClaudeRunResult> {
    this.inputs.push(input);
    if (input.onSpawn) {
      input.onSpawn(424242);
    }
    return this.handler(input);
  }
}

/** The REAL adapter: spawn `claude -p` in the worktree, feed the prompt on stdin, capture
 *  stdout/exit under a timeout, parse usage. Exercised only by the manual smoke (Task 6),
 *  where the exact flags + JSON field names are confirmed against the installed `claude`. */
export function spawnClaudeRunner(): ClaudeRunner {
  return {
    async run(input: ClaudeRunInput): Promise<ClaudeRunResult> {
      const proc = Bun.spawn(["claude", ...buildClaudeArgs(input)], {
        cwd: input.cwd,
        stdin: new TextEncoder().encode(input.prompt),
        stdout: "pipe",
        stderr: "pipe",
      });
      if (input.onSpawn && typeof proc.pid === "number") {
        input.onSpawn(proc.pid);
      }
      const timer = setTimeout(() => proc.kill(), input.timeoutMs);
      let timedOut = false;
      try {
        const exitCode = await proc.exited;
        clearTimeout(timer);
        const stdout = await new Response(proc.stdout).text();
        const stderr = await new Response(proc.stderr).text();
        timedOut = exitCode !== 0 && stdout === "";
        const usage = parseClaudeJson(stdout);
        return { completed: exitCode === 0, exitCode, stdout, stderr, timedOut, ...usage };
      } catch (err) {
        clearTimeout(timer);
        return {
          completed: false,
          exitCode: null,
          stdout: "",
          stderr: String(err),
          timedOut: true,
          costUsd: null,
          tokensIn: null,
          tokensOut: null,
        };
      }
    },
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test test/dispatch/claude-runner.test.ts`
Expected: PASS (3 tests). (`spawnClaudeRunner` is not invoked — it's only tested by the manual smoke.)

- [ ] **Step 5: Verify lint + typecheck**

Run: `bun run lint && bun run typecheck`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/dispatch/claude-runner.ts test/dispatch/claude-runner.test.ts
git commit -m "feat(m3b): ClaudeRunner boundary (interface, fake, real spawn adapter)"
```

---

### Task 3: prompt assets + dispatch-vars builder

**Files:**
- Create: `prompts/design.md`
- Create: `prompts/implement.md`
- Create: `src/dispatch/prompt-vars.ts`
- Test: `test/dispatch/prompt-vars.test.ts`

**Interfaces:**
- Consumes: `Profile` (M3a); `TicketRow` (ticket repo); `WorkUnitRow` (work-unit repo).
- Produces:
  - `prompts/design.md`, `prompts/implement.md` — prompt templates with `{{placeholders}}`, imported as text.
  - `designVars(ticket, profile): Record<string,string>` and `implementVars(ticket, unit, profile): Record<string,string>` (`src/dispatch/prompt-vars.ts`) — assemble the render vars from ticket facts + `profile.promptVars`.
  - `DESIGN_TEMPLATE` / `IMPLEMENT_TEMPLATE` (the imported template strings).

- [ ] **Step 1: Create the prompt templates** (minimal — real content is refined later; they must reference only vars the builders provide)

`prompts/design.md`:
```markdown
You are designing ticket {{ident}} ("{{title}}") in the project {{slug}}.

Write a brainstorm + implementation plan as a committed markdown file under `docs/plans/`,
with `linear: {{ident}}` frontmatter. The plan must state, per work-unit: kind, files to
touch, whether it is behavioral (and how it's tested), the verify check-types, and
dependencies — as prose, not JSON.

Project stack notes: {{stack}}
```

`prompts/implement.md`:
```markdown
You are implementing work-unit {{unit_seq}} ({{unit_kind}}) of ticket {{ident}} in {{slug}}.

Work-unit: {{unit_title}}

Write the code AND its tests in the worktree. Do not commit — the daemon commits.
Run the project's build/test as you go: {{test_command}}

Project stack notes: {{stack}}
```

- [ ] **Step 2: Write the failing test** — `test/dispatch/prompt-vars.test.ts`

```ts
import { expect, test } from "bun:test";
import { parseProfile } from "../../src/dispatch/profile.ts";
import { DESIGN_TEMPLATE, IMPLEMENT_TEMPLATE, designVars, implementVars } from "../../src/dispatch/prompt-vars.ts";
import { placeholders, renderPrompt } from "../../src/dispatch/render-prompt.ts";

const profile = parseProfile({
  slug: "demo",
  targetRepo: "/tmp/demo",
  commands: { test: "bun test" },
  promptVars: { stack: "Bun + SQLite" },
});

const ticket = {
  id: 1, project_id: 1, ident: "ENG-9", stage: "design", status: "active",
  track: null, needs_docs: 0, branch_name: null, branch_prefix: null, type_label: "Feature", title: "Add widget",
} as unknown as Parameters<typeof designVars>[0];

test("designVars resolves every placeholder in the design template", () => {
  const vars = designVars(ticket, profile);
  const r = renderPrompt(DESIGN_TEMPLATE, vars);
  expect(r.ok).toBe(true);
  // every placeholder is covered (no CL-PROFILE miss)
  for (const name of placeholders(DESIGN_TEMPLATE)) {
    expect(name in vars).toBe(true);
  }
});

test("implementVars resolves every placeholder in the implement template", () => {
  const unit = { id: 5, ticket_id: 1, seq: 2, kind: "backend", status: "pending", title: "API", behavioral: 1, files_to_touch: null, verify_check_types: null, depends_on: null, created_at: "", updated_at: "" };
  const vars = implementVars(ticket, unit, profile);
  const r = renderPrompt(IMPLEMENT_TEMPLATE, vars);
  expect(r.ok).toBe(true);
  for (const name of placeholders(IMPLEMENT_TEMPLATE)) {
    expect(name in vars).toBe(true);
  }
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `bun test test/dispatch/prompt-vars.test.ts`
Expected: FAIL — `Cannot find module '../../src/dispatch/prompt-vars.ts'`.

- [ ] **Step 4: Create `src/dispatch/prompt-vars.ts`**

```ts
import type { Profile } from "./profile.ts";
import designTemplate from "../../prompts/design.md" with { type: "text" };
import implementTemplate from "../../prompts/implement.md" with { type: "text" };

export const DESIGN_TEMPLATE = designTemplate;
export const IMPLEMENT_TEMPLATE = implementTemplate;

interface TicketFacts {
  ident: string;
  title: string | null;
}

interface UnitFacts {
  seq: number;
  kind: string;
  title: string | null;
}

/** Vars for the design prompt: ticket facts + profile.promptVars (e.g. `stack`). */
export function designVars(ticket: TicketFacts, profile: Profile): Record<string, string> {
  return {
    ident: ticket.ident,
    title: ticket.title ?? "",
    slug: profile.slug,
    ...profile.promptVars,
  };
}

/** Vars for the implement prompt: ticket + work-unit facts + profile (test command, vars). */
export function implementVars(
  ticket: TicketFacts,
  unit: UnitFacts,
  profile: Profile,
): Record<string, string> {
  return {
    ident: ticket.ident,
    slug: profile.slug,
    unit_seq: String(unit.seq),
    unit_kind: unit.kind,
    unit_title: unit.title ?? "",
    test_command: profile.commands.test ?? "",
    ...profile.promptVars,
  };
}
```

Add a `prompts/*.md` text-module declaration if needed: append to `src/sql.d.ts` is wrong (that's `.sql`); instead create `src/md.d.ts`:
```ts
declare module "*.md" {
  const content: string;
  export default content;
}
```

- [ ] **Step 5: Create `src/md.d.ts`** (so `.md` text imports typecheck)

```ts
declare module "*.md" {
  const content: string;
  export default content;
}
```

- [ ] **Step 6: Run the test + full suite**

Run: `bun test test/dispatch/prompt-vars.test.ts && bun test`
Expected: PASS; full suite green. (Every template placeholder is covered by its builder — proving CL-PROFILE won't trip for a well-formed profile.)

- [ ] **Step 7: Verify lint + typecheck + compile (templates must embed in the binary)**

Run: `bun run lint && bun run typecheck && bun run build && ./dist/styre --version`
Expected: clean; binary builds (the `.md` templates embed via the text import like `schema.sql` does).

- [ ] **Step 8: Commit**

```bash
git add prompts/design.md prompts/implement.md src/dispatch/prompt-vars.ts src/md.d.ts test/dispatch/prompt-vars.test.ts
git commit -m "feat(m3b): prompt templates + dispatch-vars builders"
```

---

### Task 4: `runAgentDispatch` orchestration

**Files:**
- Create: `src/dispatch/run-dispatch.ts`
- Test: `test/dispatch/run-dispatch.test.ts`

**Interfaces:**
- Consumes: `ClaudeRunner` (Task 2); `Profile`; `resolveModel`/`allowlistFor`; `renderPrompt`; `ensureWorktree`/`commitWorktree`; dispatch repo (`nextSeq`/`insertDispatch`/`completeDispatch`); `setPid` (Task 1); `HandlerContext`.
- Produces:
  - `interface DispatchDeps { runner: ClaudeRunner; profile: Profile; repoPath: string; worktreePath: string; branch: string; timeoutMs: number }`
  - `interface DispatchSpec { handlerKey: string; template: string; vars: Record<string, string>; loopback?: boolean; postcondition: (args: { worktreePath: string; changed: boolean; sha: string }) => void }`
  - `runAgentDispatch(ctx: HandlerContext, deps: DispatchDeps, spec: DispatchSpec): Promise<{ dispatchId: string; sha: string; changed: boolean }>` — the shared dispatch flow. Throws on CL-PROFILE miss, transport failure (runner `completed:false`), or postcondition failure.

Flow: render (CL-PROFILE) → `ensureWorktree` → allocate `dispatch_id` (`${ident}-d${seq}` zero-padded) + `insertDispatch` (started) → `runner.run` with `onSpawn` journaling the pid via `setPid` → on `!completed`/`timedOut` `completeDispatch(outcome:"dispatch-failed")` + throw → `commitWorktree` (CL-COMMIT, message `"<ident>-d<seq> <handlerKey>"`) → `completeDispatch(outcome:"clean-success", sha, usage)` → run `spec.postcondition` (throws → that's the step's failure).

- [ ] **Step 1: Write the failing test** — `test/dispatch/run-dispatch.test.ts`

```ts
import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeTestDb } from "../helpers/db.ts";
import { listByTicket } from "../../src/db/repos/dispatch.ts";
import { getTicket } from "../../src/db/repos/ticket.ts";
import { insertPending } from "../../src/db/repos/workflow-step.ts";
import { FakeClaudeRunner } from "../../src/dispatch/claude-runner.ts";
import { parseProfile } from "../../src/dispatch/profile.ts";
import { runAgentDispatch } from "../../src/dispatch/run-dispatch.ts";
import type { HandlerContext } from "../../src/daemon/step-registry.ts";

function gitRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "styre-rd-"));
  const run = (args: string[]) => Bun.spawnSync(["git", ...args], { cwd: root });
  run(["init", "-b", "main"]);
  run(["config", "user.email", "t@styre.dev"]);
  run(["config", "user.name", "T"]);
  writeFileSync(join(root, "README.md"), "x");
  run(["add", "-A"]);
  run(["commit", "-m", "init"]);
  return root;
}

test("runAgentDispatch runs the agent, commits its edits (CL-COMMIT), records the dispatch", async () => {
  const { db, ticketId } = makeTestDb();
  const repo = gitRepo();
  const wt = join(repo, "..", `wt-${Date.now()}`);
  const step = insertPending(db, { ticketId, stepKey: "implement:wu1:dispatch", stepType: "dispatch" });
  const ticket = getTicket(db, ticketId);
  if (!ticket) throw new Error("no ticket");
  const ctx: HandlerContext = { db, ticket, step, workUnitId: null };
  // Fake claude "edits the worktree" by writing a file, then completes.
  const runner = new FakeClaudeRunner((input) => {
    writeFileSync(join(input.cwd, "feature.ts"), "export const x = 1;\n");
    return { completed: true, exitCode: 0, stdout: "{}", stderr: "", timedOut: false, costUsd: 0.1, tokensIn: 5, tokensOut: 2 };
  });

  const out = await runAgentDispatch(ctx, { runner, profile: parseProfile({ slug: "demo", targetRepo: repo }), repoPath: repo, worktreePath: wt, branch: "feat/ENG-1", timeoutMs: 1000 }, {
    handlerKey: "implement:dispatch",
    template: "implement {{ident}}",
    vars: { ident: "ENG-1" },
    postcondition: ({ changed }) => {
      if (!changed) throw new Error("postcondition: empty diff");
    },
  });

  const rows = listByTicket(db, ticketId);
  db.close();
  expect(out.changed).toBe(true);
  expect(out.sha).toMatch(/^[0-9a-f]{7,40}$/);
  expect(rows.length).toBe(1);
  expect(rows[0]?.outcome).toBe("clean-success");
  expect(rows[0]?.model).toBe("claude-sonnet-4-6"); // implement → sonnet
});

test("a CL-PROFILE miss (unresolved prompt var) throws before running the agent", async () => {
  const { db, ticketId } = makeTestDb();
  const repo = gitRepo();
  const step = insertPending(db, { ticketId, stepKey: "implement:wu1:dispatch", stepType: "dispatch" });
  const ticket = getTicket(db, ticketId);
  if (!ticket) throw new Error("no ticket");
  let ran = false;
  const runner = new FakeClaudeRunner(() => {
    ran = true;
    return { completed: true, exitCode: 0, stdout: "", stderr: "", timedOut: false, costUsd: null, tokensIn: null, tokensOut: null };
  });
  const call = runAgentDispatch({ db, ticket, step, workUnitId: null }, { runner, profile: parseProfile({ slug: "demo", targetRepo: repo }), repoPath: repo, worktreePath: join(repo, "..", `wt2-${Date.now()}`), branch: "feat/ENG-1", timeoutMs: 1000 }, {
    handlerKey: "implement:dispatch",
    template: "needs {{missing_var}}",
    vars: {},
    postcondition: () => {},
  });
  await expect(call).rejects.toThrow(/CL-PROFILE|missing_var/);
  db.close();
  expect(ran).toBe(false);
});

test("a postcondition failure (empty diff) throws and records postcondition-failed", async () => {
  const { db, ticketId } = makeTestDb();
  const repo = gitRepo();
  const step = insertPending(db, { ticketId, stepKey: "implement:wu1:dispatch", stepType: "dispatch" });
  const ticket = getTicket(db, ticketId);
  if (!ticket) throw new Error("no ticket");
  // Fake claude does nothing → no diff → postcondition fails.
  const runner = new FakeClaudeRunner(() => ({ completed: true, exitCode: 0, stdout: "{}", stderr: "", timedOut: false, costUsd: null, tokensIn: null, tokensOut: null }));
  const call = runAgentDispatch({ db, ticket, step, workUnitId: null }, { runner, profile: parseProfile({ slug: "demo", targetRepo: repo }), repoPath: repo, worktreePath: join(repo, "..", `wt3-${Date.now()}`), branch: "feat/ENG-1", timeoutMs: 1000 }, {
    handlerKey: "implement:dispatch",
    template: "implement {{ident}}",
    vars: { ident: "ENG-1" },
    postcondition: ({ changed }) => {
      if (!changed) throw new Error("postcondition: empty diff");
    },
  });
  await expect(call).rejects.toThrow(/empty diff/);
  const rows = listByTicket(db, ticketId);
  db.close();
  expect(rows[0]?.outcome).toBe("postcondition-failed");
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test test/dispatch/run-dispatch.test.ts`
Expected: FAIL — `Cannot find module '../../src/dispatch/run-dispatch.ts'`.

- [ ] **Step 3: Create `src/dispatch/run-dispatch.ts`**

```ts
import { completeDispatch, insertDispatch, nextSeq } from "../db/repos/dispatch.ts";
import { setPid } from "../db/repos/workflow-step.ts";
import type { HandlerContext } from "../daemon/step-registry.ts";
import type { ClaudeRunner } from "./claude-runner.ts";
import type { Profile } from "./profile.ts";
import { allowlistFor } from "./tool-allowlists.ts";
import { resolveModel } from "./models.ts";
import { renderPrompt } from "./render-prompt.ts";
import { commitWorktree, ensureWorktree } from "./worktree.ts";
import { nowUtc } from "../util/time.ts";

export interface DispatchDeps {
  runner: ClaudeRunner;
  profile: Profile;
  repoPath: string;
  worktreePath: string;
  branch: string;
  timeoutMs: number;
}

export interface DispatchSpec {
  handlerKey: string;
  template: string;
  vars: Record<string, string>;
  loopback?: boolean;
  postcondition: (args: { worktreePath: string; changed: boolean; sha: string }) => void;
}

function dispatchId(ident: string, seq: number): string {
  return `${ident}-d${String(seq).padStart(4, "0")}`;
}

/** The shared real-dispatch flow (control-loop §4): render (CL-PROFILE) → worktree → run the
 *  agent via the injected ClaudeRunner (journaling the subprocess pid for orphan-kill) →
 *  daemon-commit (CL-COMMIT) → record the dispatch → enforce the postcondition (CL-POSTCOND).
 *  Throws on CL-PROFILE miss, transport failure, or postcondition failure (→ failure-policy). */
export async function runAgentDispatch(
  ctx: HandlerContext,
  deps: DispatchDeps,
  spec: DispatchSpec,
): Promise<{ dispatchId: string; sha: string; changed: boolean }> {
  const rendered = renderPrompt(spec.template, spec.vars);
  if (!rendered.ok) {
    throw new Error(`CL-PROFILE: unresolved prompt vars: ${rendered.missing.join(", ")}`);
  }

  ensureWorktree(deps.repoPath, deps.branch, deps.worktreePath);

  const seq = nextSeq(ctx.db, ctx.ticket.id);
  const did = dispatchId(ctx.ticket.ident, seq);
  const model = resolveModel(spec.handlerKey, { loopback: spec.loopback });
  const inserted = insertDispatch(ctx.db, {
    ticketId: ctx.ticket.id,
    dispatchId: did,
    seq,
    workUnitId: ctx.workUnitId,
    stepId: ctx.step.id,
    stage: ctx.ticket.stage,
    model,
    startedAt: nowUtc(),
    worktreePath: deps.worktreePath,
  });

  const result = await deps.runner.run({
    prompt: rendered.prompt,
    model,
    allowedTools: allowlistFor(spec.handlerKey),
    cwd: deps.worktreePath,
    timeoutMs: deps.timeoutMs,
    onSpawn: (pid) => setPid(ctx.db, ctx.step.id, pid),
  });

  if (!result.completed || result.timedOut) {
    completeDispatch(ctx.db, inserted.id, { outcome: "dispatch-failed", endedAt: nowUtc() });
    throw new Error(`dispatch ${did} transport failure (exit ${result.exitCode}, timedOut=${result.timedOut})`);
  }

  const { sha, changed } = commitWorktree(deps.worktreePath, `${did} ${spec.handlerKey}`);
  const completion = {
    branchHeadSha: sha,
    endedAt: nowUtc(),
    costUsd: result.costUsd,
    tokensIn: result.tokensIn,
    tokensOut: result.tokensOut,
  };
  try {
    spec.postcondition({ worktreePath: deps.worktreePath, changed, sha });
  } catch (err) {
    completeDispatch(ctx.db, inserted.id, { outcome: "postcondition-failed", ...completion });
    throw err;
  }
  completeDispatch(ctx.db, inserted.id, { outcome: "clean-success", ...completion });
  return { dispatchId: did, sha, changed };
}
```

(`insertDispatch` returns the created row, so its `.id` is used directly for `completeDispatch` — no re-query needed.)

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test test/dispatch/run-dispatch.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Verify lint + typecheck**

Run: `bun run lint && bun run typecheck`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/dispatch/run-dispatch.ts test/dispatch/run-dispatch.test.ts
git commit -m "feat(m3b): runAgentDispatch orchestration (render→worktree→run→commit→postcond)"
```

---

### Task 5: real handlers + `buildDispatchRegistry`

**Files:**
- Create: `src/dispatch/handlers.ts`
- Test: `test/dispatch/handlers.test.ts`

**Interfaces:**
- Consumes: `runAgentDispatch`/`DispatchDeps` (Task 4); `designVars`/`implementVars`/`DESIGN_TEMPLATE`/`IMPLEMENT_TEMPLATE` (Task 3); `branchNameFor` (Task 1); `StepRegistry`/`HandlerContext` (M2); `getProject` (project repo); work-unit `getById`/`setStatus`; `Profile`; `ClaudeRunner`.
- Produces:
  - `interface RegistryDeps { runner: ClaudeRunner; profile: Profile; worktreeRoot: string; timeoutMs?: number }`
  - `buildDispatchRegistry(deps: RegistryDeps): StepRegistry` — registers real `design:dispatch` + `implement:dispatch` handlers (the other handlerKeys are added in later milestones: extract/review M5, verify M4-daemon, merge M6).

Handler specifics:
- `design:dispatch`: build `DispatchDeps` (repoPath from `getProject(ticket.project_id).target_repo`; branch from `branchNameFor(ticket)`; worktreePath `<worktreeRoot>/<ident>`; timeout 60m); spec = {handlerKey:"design:dispatch", template:DESIGN_TEMPLATE, vars:designVars(ticket,profile), postcondition: assert a plan file committed under `docs/plans/` in the worktree (changed && a `docs/plans/*.md` exists)}.
- `implement:dispatch`: same deps (timeout 30m); load the work-unit via `getById(db, ctx.workUnitId)`; spec = {handlerKey:"implement:dispatch", template:IMPLEMENT_TEMPLATE, vars:implementVars(ticket,unit,profile), postcondition: changed (non-empty diff) else throw}; on success set `work_unit.status='verifying'` (matching M2's resolver expectation).

- [ ] **Step 1: Write the failing test** — `test/dispatch/handlers.test.ts`

```ts
import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeTestDb } from "../helpers/db.ts";
import { listByTicket } from "../../src/db/repos/dispatch.ts";
import { getTicket } from "../../src/db/repos/ticket.ts";
import { getById as getUnit, insertWorkUnit } from "../../src/db/repos/work-unit.ts";
import { getByKey, insertPending } from "../../src/db/repos/workflow-step.ts";
import { FakeClaudeRunner } from "../../src/dispatch/claude-runner.ts";
import { parseProfile } from "../../src/dispatch/profile.ts";
import { buildDispatchRegistry } from "../../src/dispatch/handlers.ts";
import { advanceOneStep } from "../../src/daemon/advance.ts";

// makeTestDb's project has target_repo "/tmp/repo"; point it at a real git repo instead.
function gitRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "styre-h-"));
  const run = (a: string[]) => Bun.spawnSync(["git", ...a], { cwd: root });
  run(["init", "-b", "main"]); run(["config", "user.email", "t@s.dev"]); run(["config", "user.name", "T"]);
  writeFileSync(join(root, "README.md"), "x"); run(["add", "-A"]); run(["commit", "-m", "init"]);
  return root;
}

test("implement:dispatch handler runs the agent, commits, and sets the unit verifying", async () => {
  const { db, ticketId, projectId } = makeTestDb();
  const repo = gitRepo();
  db.query("UPDATE project SET target_repo = ? WHERE id = ?").run(repo, projectId);
  db.query("UPDATE ticket SET stage = 'implement' WHERE id = ?").run(ticketId);
  const unit = insertWorkUnit(db, { ticketId, seq: 1, kind: "backend", verifyCheckTypes: ["test"] });

  const runner = new FakeClaudeRunner((input) => {
    writeFileSync(join(input.cwd, "impl.ts"), "export const y = 2;\n");
    return { completed: true, exitCode: 0, stdout: "{}", stderr: "", timedOut: false, costUsd: null, tokensIn: null, tokensOut: null };
  });
  const registry = buildDispatchRegistry({
    runner,
    profile: parseProfile({ slug: "demo", targetRepo: repo, commands: { test: "bun test" } }),
    worktreeRoot: mkdtempSync(join(tmpdir(), "styre-wtroot-")),
  });

  // The resolver asks for implement:wu1:dispatch; advanceOneStep runs the real handler.
  const outcome = await advanceOneStep(db, ticketId, registry);
  const afterUnit = getUnit(db, unit.id);
  const dispatches = listByTicket(db, ticketId);
  const step = getByKey(db, ticketId, "implement:wu1:dispatch");
  db.close();

  expect(outcome.kind).toBe("stepped");
  expect(afterUnit?.status).toBe("verifying");
  expect(step?.status).toBe("succeeded");
  expect(dispatches.length).toBe(1);
  expect(dispatches[0]?.model).toBe("claude-sonnet-4-6");
});

test("implement:dispatch with an empty diff fails the step (postcondition)", async () => {
  const { db, ticketId, projectId } = makeTestDb();
  const repo = gitRepo();
  db.query("UPDATE project SET target_repo = ? WHERE id = ?").run(repo, projectId);
  db.query("UPDATE ticket SET stage = 'implement' WHERE id = ?").run(ticketId);
  insertWorkUnit(db, { ticketId, seq: 1, kind: "backend", verifyCheckTypes: ["test"] });
  const runner = new FakeClaudeRunner(() => ({ completed: true, exitCode: 0, stdout: "{}", stderr: "", timedOut: false, costUsd: null, tokensIn: null, tokensOut: null }));
  const registry = buildDispatchRegistry({ runner, profile: parseProfile({ slug: "demo", targetRepo: repo }), worktreeRoot: mkdtempSync(join(tmpdir(), "styre-wtroot2-")) });

  // advanceOneStep catches the thrown postcondition failure → failure-policy → retry/escalate outcome.
  const outcome = await advanceOneStep(db, ticketId, registry);
  const step = getByKey(db, ticketId, "implement:wu1:dispatch");
  db.close();
  expect(["retry", "loopback", "escalated"]).toContain(outcome.kind);
  expect(step?.status).toBe("pending"); // failure-policy reset it (retry, attempt 1)
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test test/dispatch/handlers.test.ts`
Expected: FAIL — `Cannot find module '../../src/dispatch/handlers.ts'`.

- [ ] **Step 3: Create `src/dispatch/handlers.ts`**

```ts
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { getProject } from "../db/repos/project.ts";
import { getById as getUnit, setStatus as setUnitStatus } from "../db/repos/work-unit.ts";
import { StepRegistry } from "../daemon/step-registry.ts";
import type { HandlerContext } from "../daemon/step-registry.ts";
import { branchNameFor } from "./branch.ts";
import type { ClaudeRunner } from "./claude-runner.ts";
import type { Profile } from "./profile.ts";
import { DESIGN_TEMPLATE, IMPLEMENT_TEMPLATE, designVars, implementVars } from "./prompt-vars.ts";
import type { DispatchDeps } from "./run-dispatch.ts";
import { runAgentDispatch } from "./run-dispatch.ts";

export interface RegistryDeps {
  runner: ClaudeRunner;
  profile: Profile;
  worktreeRoot: string;
  timeoutMs?: number;
}

const DESIGN_TIMEOUT_MS = 60 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;

function depsFor(ctx: HandlerContext, deps: RegistryDeps, timeoutMs: number): DispatchDeps {
  const project = getProject(ctx.db, ctx.ticket.project_id);
  if (!project) {
    throw new Error(`handler: project ${ctx.ticket.project_id} not found`);
  }
  return {
    runner: deps.runner,
    profile: deps.profile,
    repoPath: project.target_repo,
    worktreePath: join(deps.worktreeRoot, ctx.ticket.ident),
    branch: branchNameFor(ctx.ticket),
    timeoutMs,
  };
}

/** Register the real worktree-agent handlers (control-loop §4 S1a/S2b). Other handlerKeys
 *  (design:extract/design:review/review → M5; verify → M4; merge → M6) are added later. */
export function buildDispatchRegistry(deps: RegistryDeps): StepRegistry {
  const registry = new StepRegistry();

  registry.register("design:dispatch", async (ctx: HandlerContext) => {
    return runAgentDispatch(ctx, depsFor(ctx, deps, deps.timeoutMs ?? DESIGN_TIMEOUT_MS), {
      handlerKey: "design:dispatch",
      template: DESIGN_TEMPLATE,
      vars: designVars(ctx.ticket, deps.profile),
      postcondition: ({ worktreePath, changed }) => {
        const plansDir = join(worktreePath, "docs", "plans");
        const hasPlan = changed && existsSync(plansDir) && readdirSync(plansDir).some((f) => f.endsWith(".md"));
        if (!hasPlan) {
          throw new Error("design:dispatch postcondition: no plan committed under docs/plans/");
        }
      },
    });
  });

  registry.register("implement:dispatch", async (ctx: HandlerContext) => {
    if (ctx.workUnitId === null) {
      throw new Error("implement:dispatch: missing workUnitId");
    }
    const unit = getUnit(ctx.db, ctx.workUnitId);
    if (!unit) {
      throw new Error(`implement:dispatch: work_unit ${ctx.workUnitId} not found`);
    }
    const result = await runAgentDispatch(ctx, depsFor(ctx, deps, deps.timeoutMs ?? DEFAULT_TIMEOUT_MS), {
      handlerKey: "implement:dispatch",
      template: IMPLEMENT_TEMPLATE,
      vars: implementVars(ctx.ticket, unit, deps.profile),
      postcondition: ({ changed }) => {
        if (!changed) {
          throw new Error("implement:dispatch postcondition: empty diff");
        }
      },
    });
    setUnitStatus(ctx.db, unit.id, "verifying");
    return result;
  });

  return registry;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test test/dispatch/handlers.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Verify lint + typecheck**

Run: `bun run lint && bun run typecheck`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/dispatch/handlers.ts test/dispatch/handlers.test.ts
git commit -m "feat(m3b): real design:dispatch + implement:dispatch handlers + registry"
```

---

### Task 6: offline real-handler e2e + manual `claude` smoke

**Files:**
- Create: `test/dispatch/real-dispatch-e2e.test.ts`
- Create: `scripts/smoke-claude.ts`
- Create: `docs/design/m3b-smoke.md`

**Interfaces:**
- Consumes: `buildDispatchRegistry` + `FakeClaudeRunner`; the loop `tick`/`advanceOneStep`; `recover`; signals; all repos.
- Produces: an offline e2e proving the REAL handlers (with a fake claude) drive a fast-track ticket from `design` through `implement` and onward via the loop; a runnable manual smoke (`scripts/smoke-claude.ts`) that uses `spawnClaudeRunner` against the real `claude` CLI; and `docs/design/m3b-smoke.md` documenting how to run it + the verified `claude -p` flags/JSON shape.

This task adds NO new production modules — it composes Tasks 1–5. If a bug surfaces in an owning module, STOP and report it (fix in that task, re-run).

- [ ] **Step 1: Write the offline e2e** — `test/dispatch/real-dispatch-e2e.test.ts`

```ts
import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeTestDb } from "../helpers/db.ts";
import { getTicket, setTicketTrack } from "../../src/db/repos/ticket.ts";
import { insertWorkUnit } from "../../src/db/repos/work-unit.ts";
import { FakeClaudeRunner } from "../../src/dispatch/claude-runner.ts";
import { parseProfile } from "../../src/dispatch/profile.ts";
import { buildDispatchRegistry } from "../../src/dispatch/handlers.ts";
import { advanceOneStep } from "../../src/daemon/advance.ts";

function gitRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "styre-e2e-"));
  const run = (a: string[]) => Bun.spawnSync(["git", ...a], { cwd: root });
  run(["init", "-b", "main"]); run(["config", "user.email", "t@s.dev"]); run(["config", "user.name", "T"]);
  writeFileSync(join(root, "README.md"), "x"); run(["add", "-A"]); run(["commit", "-m", "init"]);
  return root;
}

test("real design:dispatch handler (fake claude) commits a plan and advances", async () => {
  const { db, ticketId, projectId } = makeTestDb();
  const repo = gitRepo();
  db.query("UPDATE project SET target_repo = ? WHERE id = ?").run(repo, projectId);
  // design:dispatch agent writes a plan file under docs/plans; design:extract is still M5,
  // so we drive just the design:dispatch step here and assert it succeeds + commits.
  const runner = new FakeClaudeRunner((input) => {
    const dir = join(input.cwd, "docs", "plans");
    Bun.spawnSync(["mkdir", "-p", dir]);
    writeFileSync(join(dir, "ENG-1-plan.md"), "---\nlinear: ENG-1\n---\nplan\n");
    return { completed: true, exitCode: 0, stdout: "{}", stderr: "", timedOut: false, costUsd: null, tokensIn: null, tokensOut: null };
  });
  const registry = buildDispatchRegistry({ runner, profile: parseProfile({ slug: "demo", targetRepo: repo, promptVars: { stack: "bun" } }), worktreeRoot: mkdtempSync(join(tmpdir(), "styre-e2ewt-")) });

  const outcome = await advanceOneStep(db, ticketId, registry); // design:dispatch
  db.close();
  expect(outcome).toEqual({ kind: "stepped", stepKey: "design:dispatch" });
});
```

- [ ] **Step 2: Run the offline e2e**

Run: `bun test test/dispatch/real-dispatch-e2e.test.ts`
Expected: PASS — the real `design:dispatch` handler (with a fake claude that writes a plan) runs, commits, and the step succeeds. If it stalls or a handler throws unexpectedly, STOP and report which module is at fault.

- [ ] **Step 3: Write the manual smoke** — `scripts/smoke-claude.ts`

```ts
// Manual smoke (NOT run in CI): exercises the REAL claude CLI via spawnClaudeRunner.
// Usage: bun run scripts/smoke-claude.ts <path-to-git-repo>
// Requires: the `claude` CLI installed + authenticated (subscription session or ANTHROPIC_API_KEY).
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnClaudeRunner } from "../src/dispatch/claude-runner.ts";
import { allowlistFor } from "../src/dispatch/tool-allowlists.ts";
import { resolveModel } from "../src/dispatch/models.ts";
import { ensureWorktree } from "../src/dispatch/worktree.ts";

const repo = process.argv[2];
if (!repo) {
  throw new Error("usage: bun run scripts/smoke-claude.ts <git-repo-path>");
}
const wt = join(mkdtempSync(join(tmpdir(), "styre-smoke-")), "wt");
ensureWorktree(repo, "feat/styre-smoke", wt);
const runner = spawnClaudeRunner();
const result = await runner.run({
  prompt: "Create a file HELLO.txt containing the word styre. Do not commit.",
  model: resolveModel("implement:dispatch"),
  allowedTools: allowlistFor("implement:dispatch"),
  cwd: wt,
  timeoutMs: 5 * 60 * 1000,
  onSpawn: (pid) => console.log("claude pid:", pid),
});
console.log("completed:", result.completed, "exit:", result.exitCode, "timedOut:", result.timedOut);
console.log("usage:", { costUsd: result.costUsd, tokensIn: result.tokensIn, tokensOut: result.tokensOut });
console.log("stdout (first 500):", result.stdout.slice(0, 500));
```

- [ ] **Step 4: Document the smoke + verify the real `claude` flags/JSON** — `docs/design/m3b-smoke.md`

Write `docs/design/m3b-smoke.md` covering: prerequisites (`claude` CLI + auth), how to run `bun run scripts/smoke-claude.ts <repo>`, and — **after running it once against the real `claude`** — record the confirmed flags (is it `--allowedTools` or `--allowed-tools`?) and the `--output-format json` field names for cost/tokens. If they differ from `buildClaudeArgs`/`parseClaudeJson`, fix those two functions in `src/dispatch/claude-runner.ts` (and update Task 2's tests), commit, and note the correction here. (If `claude` is not available in this environment, document that the smoke is pending and the flags are unverified — do NOT block the offline suite on it.)

- [ ] **Step 5: Run the FULL suite + lint + typecheck**

Run: `bun test && bun run lint && bun run typecheck`
Expected: all M0–M3a + M3b tests pass (the smoke script is not a test — it is not run by `bun test`); Biome clean; `tsc --noEmit` exits 0.

- [ ] **Step 6: Commit**

```bash
git add test/dispatch/real-dispatch-e2e.test.ts scripts/smoke-claude.ts docs/design/m3b-smoke.md
git commit -m "test(m3b): offline real-handler e2e + manual claude smoke + smoke doc"
```

---

## M3b acceptance criteria

- [ ] `ClaudeRunner` isolates the real `claude -p`; `FakeClaudeRunner` drives all offline tests; CI never calls `claude`.
- [ ] `runAgentDispatch` renders (CL-PROFILE), ensures the worktree, runs the agent (journaling the subprocess pid), daemon-commits (CL-COMMIT), records the `dispatch` row, and enforces the postcondition — unit-tested with a fake runner + real git + real DB.
- [ ] Real `design:dispatch` (plan-committed postcondition) + `implement:dispatch` (non-empty-diff postcondition, sets unit `verifying`) handlers, registered via `buildDispatchRegistry`.
- [ ] A failing dispatch (transport or postcondition) throws → `advanceOneStep` routes it through failure-policy.
- [ ] Offline e2e: the real handlers (fake claude) drive a ticket through `design:dispatch` (commits a plan).
- [ ] A manual `claude` smoke exists; the real `claude -p` flags + JSON shape are verified (or documented pending if `claude` is unavailable).
- [ ] `bun test` green; `bun run lint && bun run typecheck` clean; the binary still builds (templates embed).

## Out of scope (later milestones)

- **`design:extract` / `design:review` / `review`** (structured-judgment via the M3a sidecar) — **M5**.
- **Real verify** (S3/S4 daemon-run profile commands, checks-system) — **M4**.
- **Rebase** (`implement:wuN:rebase`, conflict-resolution agent) — later.
- **The projector / merge steps / real external effects** — **M6**.
- **The continuous daemon, git committer-identity config, the `styre run/daemon` commands** — **M8** (the smoke documents the identity requirement).

## Done / handoff

When M3b is delivered and merged, the substrate runs a ticket through **design + implement with real agent dispatch** (verify/review/merge still mocked or daemon-stubbed). Next is **M4 — Verify real** (ground-truth profile commands + checks-system), replacing the verify mock handlers.

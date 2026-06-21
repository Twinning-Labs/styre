# M3a — Dispatch Infrastructure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the unit-testable dispatch infrastructure — the `dispatch` repo, model-tier resolution, per-step tool allowlists, the project-profile loader, the render-prompt engine + CL-PROFILE gate, the sidecar (zod) extractor, and the git worktree manager — everything M3b's real `claude -p` boundary will assemble, with **no** `claude -p` calls here.

**Architecture:** Pure functions + thin repos + real-git helpers, all testable without the network or an LLM. `src/dispatch/` holds the dispatch-time pieces; `src/db/repos/dispatch.ts` records each invocation. Model resolution and tool allowlists are pure lookups (control-loop §4). `render-prompt` substitutes `{{placeholders}}` from a profile/ticket var map and reports any unresolved ones (the CL-PROFILE gate). The sidecar extracts + zod-validates an agent's structured output block, classifying absent vs malformed (control-loop §3a). The worktree manager wraps real `git` (the daemon commits, CL-COMMIT). This is **M3a** of the M3 split; **M3b** wires these into a real `ClaudeRunner` boundary + the dispatch step + real `design:dispatch`/`implement:dispatch` handlers.

**Tech Stack:** Bun, `bun:sqlite`, `bun test`, Biome, **zod** (new dependency — the validated-interface layer, control-loop §3a / SC-3), real `git` via `Bun.spawnSync`.

## Global Constraints

- **Runtime is Bun**; SQLite via `bun:sqlite`; `bun test`; real `git` via `Bun.spawnSync`. **New dependency: `zod`** (first use — the §3a validated interface; add with `bun add zod`, `exact = true` in bunfig pins it).
- **No `claude -p` / network / LLM in M3a.** Every module here is unit- or real-git-testable offline. The actual agent invocation is M3b.
- **Capability isolation (move 4):** agents get NO outward tools (`gh`, `git push`, Linear, `curl`) and the worktree is the only writable surface. M3a encodes this as the **tool allowlists** (the data) + the **worktree manager** (the surface). The daemon commits, never the agent (CL-COMMIT) — `commitWorktree` is the daemon's, with a deterministic message carrying the `dispatch_id`.
- **Model tiers (F1 / build-operations §4):** design/review = Opus 4.8 (`claude-opus-4-8`), implement = Sonnet 4.6 (`claude-sonnet-4-6`), cheap formalize/build/docs = Haiku 4.5 (`claude-haiku-4-5-20251001`).
- **CL-PROFILE:** before a dispatch, every placeholder the rendered prompt needs must resolve from the profile/ticket vars; an unresolved placeholder is a setup error (M3a's `renderPrompt` reports the missing names; M3b escalates).
- **Validated interface, never parse a free-form blob (§3a / CL-INV-4):** structured agent output is extracted via the sidecar and **zod-validated**; absent/malformed is a *transport failure* (re-dispatch in M3b), distinct from a real verdict.
- **Timestamps stored UTC (DS-1)** via `nowUtc()`; never local time.
- **Build ON M0–M2, do not change their behavior.** Reuse `nowUtc()`, the repos, `makeTestDb()`.
- **Conventions (match existing code exactly):** `.ts` import extensions; `verbatimModuleSyntax` → type-only imports use `import type`; import repo modules consistently with the codebase (named imports, or `import * as` with row types via the namespace); Biome grouping external → `node:` → relative, alphabetical (run `bun run lint`, apply organizeImports); Biome `noNonNullAssertion` (use `if (!x) throw`, not `!`); double quotes; semicolons; 2-space/100-col; `noUnusedLocals`/`noUnusedParameters`.
- **Before committing each task:** `bun test && bun run lint && bun run typecheck` all clean (full suite — M0–M2 + prior M3a tasks stay green).
- **`.superpowers/sdd/` is gitignored scratch — never `git add -f` a report into a commit.**
- **Dev workflow:** branch-only (`feat/m3-dispatch`); no commits to `main`; Conventional Commits; no auto-merge. TDD throughout; files small + single-responsibility.

---

### Task 1: `dispatch` repo

**Files:**
- Create: `src/db/repos/dispatch.ts`
- Test: `test/db/repos/dispatch.test.ts`

**Interfaces:**
- Consumes: `nowUtc()`; `makeTestDb()`.
- Produces (all on `src/db/repos/dispatch.ts`):
  - `interface DispatchRow { id: number; ticket_id: number; work_unit_id: number | null; step_id: number | null; dispatch_id: string; seq: number; stage: string | null; kind: string | null; model: string | null; outcome: string | null; branch_head_sha: string | null; worktree_path: string | null; started_at: string | null; ended_at: string | null; duration_ms: number | null; tokens_in: number | null; tokens_out: number | null; cost_usd: number | null; partial: number; created_at: string }`
  - `nextSeq(db, ticketId: number): number`
  - `insertDispatch(db, p: { ticketId: number; dispatchId: string; seq: number; workUnitId?: number | null; stepId?: number | null; stage?: string | null; kind?: string | null; model?: string | null; startedAt?: string | null; worktreePath?: string | null }): DispatchRow`
  - `completeDispatch(db, id: number, p: { outcome: string; branchHeadSha?: string | null; endedAt?: string | null; durationMs?: number | null; tokensIn?: number | null; tokensOut?: number | null; costUsd?: number | null; partial?: number }): void`
  - `getByDispatchId(db, ticketId: number, dispatchId: string): DispatchRow | null`
  - `listByTicket(db, ticketId: number): DispatchRow[]`

- [ ] **Step 1: Write the failing test** — `test/db/repos/dispatch.test.ts`

```ts
import { expect, test } from "bun:test";
import { makeTestDb } from "../../helpers/db.ts";
import * as dispatch from "../../../src/db/repos/dispatch.ts";

test("nextSeq starts at 1 and increments per ticket", () => {
  const { db, ticketId } = makeTestDb();
  expect(dispatch.nextSeq(db, ticketId)).toBe(1);
  dispatch.insertDispatch(db, { ticketId, dispatchId: "ENG-1-d0001", seq: 1 });
  const next = dispatch.nextSeq(db, ticketId);
  db.close();
  expect(next).toBe(2);
});

test("insertDispatch records start fields with partial=0 default", () => {
  const { db, ticketId } = makeTestDb();
  const row = dispatch.insertDispatch(db, {
    ticketId,
    dispatchId: "ENG-1-d0001",
    seq: 1,
    stage: "design",
    model: "claude-opus-4-8",
    startedAt: "2026-06-20T00:00:00.000Z",
  });
  db.close();
  expect(row.dispatch_id).toBe("ENG-1-d0001");
  expect(row.stage).toBe("design");
  expect(row.model).toBe("claude-opus-4-8");
  expect(row.outcome).toBeNull();
  expect(row.partial).toBe(0);
});

test("completeDispatch records outcome + usage; getByDispatchId reads it back", () => {
  const { db, ticketId } = makeTestDb();
  const row = dispatch.insertDispatch(db, { ticketId, dispatchId: "ENG-1-d0001", seq: 1 });
  dispatch.completeDispatch(db, row.id, {
    outcome: "clean-success",
    branchHeadSha: "abc123",
    endedAt: "2026-06-20T00:01:00.000Z",
    tokensIn: 100,
    tokensOut: 50,
    costUsd: 0.42,
  });
  const after = dispatch.getByDispatchId(db, ticketId, "ENG-1-d0001");
  db.close();
  expect(after?.outcome).toBe("clean-success");
  expect(after?.branch_head_sha).toBe("abc123");
  expect(after?.tokens_in).toBe(100);
  expect(after?.cost_usd).toBe(0.42);
});

test("listByTicket returns dispatches ordered by seq", () => {
  const { db, ticketId } = makeTestDb();
  dispatch.insertDispatch(db, { ticketId, dispatchId: "ENG-1-d0002", seq: 2 });
  dispatch.insertDispatch(db, { ticketId, dispatchId: "ENG-1-d0001", seq: 1 });
  const list = dispatch.listByTicket(db, ticketId);
  db.close();
  expect(list.map((d) => d.seq)).toEqual([1, 2]);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test test/db/repos/dispatch.test.ts`
Expected: FAIL — `Cannot find module '../../../src/db/repos/dispatch.ts'`.

- [ ] **Step 3: Create `src/db/repos/dispatch.ts`**

```ts
import type { Database } from "bun:sqlite";
import { nowUtc } from "../../util/time.ts";

export interface DispatchRow {
  id: number;
  ticket_id: number;
  work_unit_id: number | null;
  step_id: number | null;
  dispatch_id: string;
  seq: number;
  stage: string | null;
  kind: string | null;
  model: string | null;
  outcome: string | null;
  branch_head_sha: string | null;
  worktree_path: string | null;
  started_at: string | null;
  ended_at: string | null;
  duration_ms: number | null;
  tokens_in: number | null;
  tokens_out: number | null;
  cost_usd: number | null;
  partial: number;
  created_at: string;
}

const COLS =
  "id, ticket_id, work_unit_id, step_id, dispatch_id, seq, stage, kind, model, outcome, " +
  "branch_head_sha, worktree_path, started_at, ended_at, duration_ms, tokens_in, tokens_out, " +
  "cost_usd, partial, created_at";

export function nextSeq(db: Database, ticketId: number): number {
  const row = db
    .query<{ m: number | null }, [number]>("SELECT MAX(seq) AS m FROM dispatch WHERE ticket_id = ?")
    .get(ticketId);
  return (row?.m ?? 0) + 1;
}

export function getByDispatchId(
  db: Database,
  ticketId: number,
  dispatchId: string,
): DispatchRow | null {
  return (
    db
      .query<DispatchRow, [number, string]>(
        `SELECT ${COLS} FROM dispatch WHERE ticket_id = ? AND dispatch_id = ?`,
      )
      .get(ticketId, dispatchId) ?? null
  );
}

export function listByTicket(db: Database, ticketId: number): DispatchRow[] {
  return db
    .query<DispatchRow, [number]>(`SELECT ${COLS} FROM dispatch WHERE ticket_id = ? ORDER BY seq`)
    .all(ticketId);
}

export function insertDispatch(
  db: Database,
  p: {
    ticketId: number;
    dispatchId: string;
    seq: number;
    workUnitId?: number | null;
    stepId?: number | null;
    stage?: string | null;
    kind?: string | null;
    model?: string | null;
    startedAt?: string | null;
    worktreePath?: string | null;
  },
): DispatchRow {
  db.query(
    `INSERT INTO dispatch
       (ticket_id, work_unit_id, step_id, dispatch_id, seq, stage, kind, model, started_at, worktree_path, created_at)
     VALUES ($t, $wu, $step, $did, $seq, $stage, $kind, $model, $started, $wt, $now)`,
  ).run({
    $t: p.ticketId,
    $wu: p.workUnitId ?? null,
    $step: p.stepId ?? null,
    $did: p.dispatchId,
    $seq: p.seq,
    $stage: p.stage ?? null,
    $kind: p.kind ?? null,
    $model: p.model ?? null,
    $started: p.startedAt ?? null,
    $wt: p.worktreePath ?? null,
    $now: nowUtc(),
  });
  const created = getByDispatchId(db, p.ticketId, p.dispatchId);
  if (!created) {
    throw new Error("insertDispatch: row missing after insert");
  }
  return created;
}

export function completeDispatch(
  db: Database,
  id: number,
  p: {
    outcome: string;
    branchHeadSha?: string | null;
    endedAt?: string | null;
    durationMs?: number | null;
    tokensIn?: number | null;
    tokensOut?: number | null;
    costUsd?: number | null;
    partial?: number;
  },
): void {
  db.query(
    `UPDATE dispatch
       SET outcome = $outcome, branch_head_sha = $sha, ended_at = $ended, duration_ms = $dur,
           tokens_in = $tin, tokens_out = $tout, cost_usd = $cost, partial = $partial
     WHERE id = $id`,
  ).run({
    $outcome: p.outcome,
    $sha: p.branchHeadSha ?? null,
    $ended: p.endedAt ?? null,
    $dur: p.durationMs ?? null,
    $tin: p.tokensIn ?? null,
    $tout: p.tokensOut ?? null,
    $cost: p.costUsd ?? null,
    $partial: p.partial ?? 0,
    $id: id,
  });
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test test/db/repos/dispatch.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Verify lint + typecheck**

Run: `bun run lint && bun run typecheck`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/db/repos/dispatch.ts test/db/repos/dispatch.test.ts
git commit -m "feat(m3a): dispatch repo (per-invocation record)"
```

---

### Task 2: model-tier resolution + tool allowlists

**Files:**
- Create: `src/dispatch/models.ts`
- Create: `src/dispatch/tool-allowlists.ts`
- Test: `test/dispatch/models.test.ts`
- Test: `test/dispatch/tool-allowlists.test.ts`

**Interfaces:**
- Produces:
  - `src/dispatch/models.ts`: `const MODELS = { opus: "claude-opus-4-8", sonnet: "claude-sonnet-4-6", haiku: "claude-haiku-4-5-20251001" }`; `resolveModel(handlerKey: string, opts?: { loopback?: boolean }): string` (throws for an unknown/non-agent handlerKey).
  - `src/dispatch/tool-allowlists.ts`: `allowlistFor(handlerKey: string): string[]` (throws for an unknown/non-agent handlerKey).

- [ ] **Step 1: Write the failing test** — `test/dispatch/models.test.ts`

```ts
import { expect, test } from "bun:test";
import { MODELS, resolveModel } from "../../src/dispatch/models.ts";

test("design and review run on Opus", () => {
  expect(resolveModel("design:dispatch")).toBe(MODELS.opus);
  expect(resolveModel("design:review")).toBe(MODELS.opus);
  expect(resolveModel("review")).toBe(MODELS.opus);
});

test("implement runs on Sonnet, Opus on loopback", () => {
  expect(resolveModel("implement:dispatch")).toBe(MODELS.sonnet);
  expect(resolveModel("implement:dispatch", { loopback: true })).toBe(MODELS.opus);
});

test("cheap formalize/docs/pr-ensure run on Haiku", () => {
  expect(resolveModel("design:extract")).toBe(MODELS.haiku);
  expect(resolveModel("docs:revise")).toBe(MODELS.haiku);
  expect(resolveModel("merge:pr-ensure")).toBe(MODELS.haiku);
});

test("an unknown handlerKey throws", () => {
  expect(() => resolveModel("verify:integration")).toThrow();
  expect(() => resolveModel("nope")).toThrow();
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test test/dispatch/models.test.ts`
Expected: FAIL — `Cannot find module '../../src/dispatch/models.ts'`.

- [ ] **Step 3: Create `src/dispatch/models.ts`**

```ts
/** Model tiers (F1 / build-operations §4): design/review = Opus, implement = Sonnet,
 *  cheap formalize/docs/pr-ensure = Haiku. */
export const MODELS = {
  opus: "claude-opus-4-8",
  sonnet: "claude-sonnet-4-6",
  haiku: "claude-haiku-4-5-20251001",
} as const;

const TIERS: Record<string, string> = {
  "design:dispatch": MODELS.opus,
  "design:review": MODELS.opus,
  review: MODELS.opus,
  "implement:dispatch": MODELS.sonnet,
  "design:extract": MODELS.haiku,
  "docs:revise": MODELS.haiku,
  "merge:pr-ensure": MODELS.haiku,
};

/** Resolve the model id for an agent handlerKey. Implement escalates to Opus on a loopback
 *  retry (control-loop §8 P4). Non-agent steps (verify/merge:push/released) never dispatch. */
export function resolveModel(handlerKey: string, opts?: { loopback?: boolean }): string {
  if (handlerKey === "implement:dispatch" && opts?.loopback) {
    return MODELS.opus;
  }
  const model = TIERS[handlerKey];
  if (model === undefined) {
    throw new Error(`resolveModel: no model tier for handlerKey '${handlerKey}'`);
  }
  return model;
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `bun test test/dispatch/models.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Write the failing test** — `test/dispatch/tool-allowlists.test.ts`

```ts
import { expect, test } from "bun:test";
import { allowlistFor } from "../../src/dispatch/tool-allowlists.ts";

test("design:dispatch gets read tools + docs Write/Edit + web, no Bash/outward", () => {
  const tools = allowlistFor("design:dispatch");
  expect(tools).toContain("Read");
  expect(tools).toContain("Write");
  expect(tools).toContain("WebSearch");
  expect(tools).not.toContain("Bash");
});

test("implement:dispatch gets full edit + Bash, no git/outward", () => {
  const tools = allowlistFor("implement:dispatch");
  expect(tools).toContain("Edit");
  expect(tools).toContain("Bash");
});

test("review and design:review are read-only (no Write/Edit/Bash)", () => {
  for (const key of ["review", "design:review", "design:extract"]) {
    const tools = allowlistFor(key);
    expect(tools).not.toContain("Write");
    expect(tools).not.toContain("Edit");
    expect(tools).not.toContain("Bash");
  }
});

test("no allowlist ever contains an outward tool", () => {
  for (const key of ["design:dispatch", "implement:dispatch", "review", "design:review", "design:extract", "docs:revise", "merge:pr-ensure"]) {
    const tools = allowlistFor(key);
    for (const outward of ["Bash(git push)", "WebFetch(gh)"]) {
      expect(tools).not.toContain(outward);
    }
    expect(tools.join(",")).not.toContain("gh");
    expect(tools.join(",")).not.toContain("git push");
  }
});

test("an unknown handlerKey throws", () => {
  expect(() => allowlistFor("verify:integration")).toThrow();
});
```

- [ ] **Step 6: Run it to verify it fails**

Run: `bun test test/dispatch/tool-allowlists.test.ts`
Expected: FAIL — `Cannot find module '../../src/dispatch/tool-allowlists.ts'`.

- [ ] **Step 7: Create `src/dispatch/tool-allowlists.ts`**

```ts
/** Per-step tool allowlists (capability isolation, move 4 / control-loop §4). Tool-NAME sets
 *  passed to `claude -p --allowed-tools`. NO outward tools anywhere (no gh/git push/Linear/curl);
 *  the worktree is the only writable surface. Fine-grained path scoping (design Write/Edit → docs/**,
 *  implement Bash → profile runners) is layered at the real dispatch + scope-check in M3b. */
const READ_ONLY = ["Read", "Grep", "Glob"];

const ALLOWLISTS: Record<string, string[]> = {
  "design:dispatch": [...READ_ONLY, "Write", "Edit", "WebSearch", "WebFetch"],
  "implement:dispatch": [...READ_ONLY, "Write", "Edit", "Bash"],
  "docs:revise": [...READ_ONLY, "Write", "Edit"],
  "design:extract": [...READ_ONLY],
  "design:review": [...READ_ONLY],
  review: [...READ_ONLY],
  "merge:pr-ensure": [...READ_ONLY],
};

export function allowlistFor(handlerKey: string): string[] {
  const tools = ALLOWLISTS[handlerKey];
  if (tools === undefined) {
    throw new Error(`allowlistFor: no tool allowlist for handlerKey '${handlerKey}'`);
  }
  return [...tools];
}
```

- [ ] **Step 8: Run both tests to verify they pass**

Run: `bun test test/dispatch/models.test.ts test/dispatch/tool-allowlists.test.ts`
Expected: PASS (4 + 5 tests).

- [ ] **Step 9: Verify lint + typecheck**

Run: `bun run lint && bun run typecheck`
Expected: clean.

- [ ] **Step 10: Commit**

```bash
git add src/dispatch/models.ts src/dispatch/tool-allowlists.ts test/dispatch/models.test.ts test/dispatch/tool-allowlists.test.ts
git commit -m "feat(m3a): model-tier resolution + per-step tool allowlists"
```

---

### Task 3: project-profile loader + schema (adds zod)

**Files:**
- Modify: `package.json` (add `zod` dependency)
- Create: `src/dispatch/profile.ts`
- Test: `test/dispatch/profile.test.ts`

**Interfaces:**
- Produces (all on `src/dispatch/profile.ts`):
  - `ProfileSchema` (a zod schema); `type Profile = z.infer<typeof ProfileSchema>` with fields `{ slug: string; targetRepo: string; defaultBranch: string; checksSystem: "github" | "external" | "none"; commands: Record<string,string>; promptVars: Record<string,string> }` (defaults: `defaultBranch="main"`, `checksSystem="none"`, `commands={}`, `promptVars={}`).
  - `parseProfile(raw: unknown): Profile` (throws a zod error on invalid input).
  - `loadProfile(path: string): Profile` (reads a JSON file, then `parseProfile`).

- [ ] **Step 1: Add the zod dependency**

Run: `bun add zod`
Expected: `zod` added to `package.json` dependencies and pinned in `bun.lock` (bunfig `exact = true`).

- [ ] **Step 2: Write the failing test** — `test/dispatch/profile.test.ts`

```ts
import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadProfile, parseProfile } from "../../src/dispatch/profile.ts";

test("parseProfile fills defaults for optional fields", () => {
  const p = parseProfile({ slug: "demo", targetRepo: "/tmp/demo" });
  expect(p.slug).toBe("demo");
  expect(p.defaultBranch).toBe("main");
  expect(p.checksSystem).toBe("none");
  expect(p.commands).toEqual({});
  expect(p.promptVars).toEqual({});
});

test("parseProfile keeps provided values", () => {
  const p = parseProfile({
    slug: "demo",
    targetRepo: "/tmp/demo",
    defaultBranch: "trunk",
    checksSystem: "github",
    commands: { test: "bun test" },
    promptVars: { stack: "bun" },
  });
  expect(p.defaultBranch).toBe("trunk");
  expect(p.checksSystem).toBe("github");
  expect(p.commands.test).toBe("bun test");
  expect(p.promptVars.stack).toBe("bun");
});

test("parseProfile rejects a missing required field", () => {
  expect(() => parseProfile({ slug: "demo" })).toThrow();
});

test("loadProfile reads + validates a JSON file", () => {
  const dir = mkdtempSync(join(tmpdir(), "styre-profile-"));
  const path = join(dir, "profile.json");
  writeFileSync(path, JSON.stringify({ slug: "demo", targetRepo: "/tmp/demo" }));
  const p = loadProfile(path);
  expect(p.slug).toBe("demo");
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `bun test test/dispatch/profile.test.ts`
Expected: FAIL — `Cannot find module '../../src/dispatch/profile.ts'`.

- [ ] **Step 4: Create `src/dispatch/profile.ts`**

```ts
import { readFileSync } from "node:fs";
import { z } from "zod";

/** The project-profile: canonical stack truth the daemon reads (build-operations §5).
 *  M3a defines the minimal fields render-prompt + dispatch need; the full versioned
 *  artifact contract is M7. Validated via zod (§3a / SC-3). */
export const ProfileSchema = z.object({
  slug: z.string(),
  targetRepo: z.string(),
  defaultBranch: z.string().default("main"),
  checksSystem: z.enum(["github", "external", "none"]).default("none"),
  commands: z.record(z.string(), z.string()).default({}),
  promptVars: z.record(z.string(), z.string()).default({}),
});

export type Profile = z.infer<typeof ProfileSchema>;

export function parseProfile(raw: unknown): Profile {
  return ProfileSchema.parse(raw);
}

export function loadProfile(path: string): Profile {
  return parseProfile(JSON.parse(readFileSync(path, "utf8")));
}
```

- [ ] **Step 5: Run it to verify it passes**

Run: `bun test test/dispatch/profile.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 6: Verify lint + typecheck**

Run: `bun run lint && bun run typecheck`
Expected: clean (zod types resolve).

- [ ] **Step 7: Commit**

```bash
git add package.json bun.lock src/dispatch/profile.ts test/dispatch/profile.test.ts
git commit -m "feat(m3a): project-profile loader + zod schema"
```

---

### Task 4: render-prompt engine + CL-PROFILE gate

**Files:**
- Create: `src/dispatch/render-prompt.ts`
- Test: `test/dispatch/render-prompt.test.ts`

**Interfaces:**
- Produces (all on `src/dispatch/render-prompt.ts`):
  - `type RenderResult = { ok: true; prompt: string } | { ok: false; missing: string[] }`
  - `placeholders(template: string): string[]` (the distinct `{{name}}` names, in first-seen order).
  - `renderPrompt(template: string, vars: Record<string, string>): RenderResult` — substitute `{{name}}`; if any placeholder has no value in `vars`, return `{ ok: false, missing }` (the CL-PROFILE failure); else return `{ ok: true, prompt }`.

- [ ] **Step 1: Write the failing test** — `test/dispatch/render-prompt.test.ts`

```ts
import { expect, test } from "bun:test";
import { placeholders, renderPrompt } from "../../src/dispatch/render-prompt.ts";

test("placeholders extracts distinct names in order", () => {
  expect(placeholders("a {{x}} b {{ y }} c {{x}}")).toEqual(["x", "y"]);
});

test("renderPrompt substitutes all placeholders when vars resolve", () => {
  const r = renderPrompt("Build {{ticket}} on {{branch}}", { ticket: "ENG-1", branch: "feat/x" });
  expect(r).toEqual({ ok: true, prompt: "Build ENG-1 on feat/x" });
});

test("renderPrompt reports missing placeholders (CL-PROFILE failure)", () => {
  const r = renderPrompt("Build {{ticket}} on {{branch}}", { ticket: "ENG-1" });
  expect(r.ok).toBe(false);
  if (!r.ok) {
    expect(r.missing).toEqual(["branch"]);
  }
});

test("renderPrompt with no placeholders returns the template unchanged", () => {
  const r = renderPrompt("static text", {});
  expect(r).toEqual({ ok: true, prompt: "static text" });
});

test("an empty-string value counts as resolved (not missing)", () => {
  const r = renderPrompt("x={{x}}", { x: "" });
  expect(r).toEqual({ ok: true, prompt: "x=" });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test test/dispatch/render-prompt.test.ts`
Expected: FAIL — `Cannot find module '../../src/dispatch/render-prompt.ts'`.

- [ ] **Step 3: Create `src/dispatch/render-prompt.ts`**

```ts
export type RenderResult = { ok: true; prompt: string } | { ok: false; missing: string[] };

const PLACEHOLDER = /\{\{\s*([\w.]+)\s*\}\}/g;

/** Distinct `{{name}}` placeholder names in first-seen order. */
export function placeholders(template: string): string[] {
  const seen = new Set<string>();
  const names: string[] = [];
  for (const match of template.matchAll(PLACEHOLDER)) {
    const name = match[1];
    if (name !== undefined && !seen.has(name)) {
      seen.add(name);
      names.push(name);
    }
  }
  return names;
}

/** Render a prompt template, substituting `{{name}}` from `vars`. Any placeholder with no
 *  value is the CL-PROFILE failure — returned as `missing` (M3b escalates a setup error). */
export function renderPrompt(template: string, vars: Record<string, string>): RenderResult {
  const missing = placeholders(template).filter((name) => !(name in vars));
  if (missing.length > 0) {
    return { ok: false, missing };
  }
  const prompt = template.replace(PLACEHOLDER, (_match, name: string) => vars[name] ?? "");
  return { ok: true, prompt };
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `bun test test/dispatch/render-prompt.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Verify lint + typecheck**

Run: `bun run lint && bun run typecheck`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/dispatch/render-prompt.ts test/dispatch/render-prompt.test.ts
git commit -m "feat(m3a): render-prompt engine + CL-PROFILE placeholder gate"
```

---

### Task 5: sidecar extractor (zod-validated)

**Files:**
- Create: `src/dispatch/sidecar.ts`
- Test: `test/dispatch/sidecar.test.ts`

**Interfaces:**
- Consumes: `zod` (`ZodType`).
- Produces (all on `src/dispatch/sidecar.ts`):
  - `type SidecarResult<T> = { ok: true; value: T } | { ok: false; reason: "absent" | "malformed"; detail: string }`
  - `extractSidecar<T>(output: string, schema: ZodType<T>, opts?: { fence?: string }): SidecarResult<T>` — find a fenced ```` ```<fence> ... ``` ```` block (default fence `styre-sidecar`), `JSON.parse` it, then `schema.parse`. No fence → `absent`; JSON or schema failure → `malformed` (with detail). (§3a: absent/malformed is a transport failure, distinct from a real verdict.)

- [ ] **Step 1: Write the failing test** — `test/dispatch/sidecar.test.ts`

```ts
import { expect, test } from "bun:test";
import { z } from "zod";
import { extractSidecar } from "../../src/dispatch/sidecar.ts";

const Schema = z.object({ units: z.number() });

function block(body: string): string {
  return ["Here is my answer.", "```styre-sidecar", body, "```", "Done."].join("\n");
}

test("extracts and validates a well-formed sidecar block", () => {
  const r = extractSidecar(block(`{ "units": 2 }`), Schema);
  expect(r.ok).toBe(true);
  if (r.ok) {
    expect(r.value.units).toBe(2);
  }
});

test("reports absent when there is no sidecar fence", () => {
  const r = extractSidecar("just prose, no block", Schema);
  expect(r).toMatchObject({ ok: false, reason: "absent" });
});

test("reports malformed on invalid JSON", () => {
  const r = extractSidecar(block("{ not json }"), Schema);
  expect(r).toMatchObject({ ok: false, reason: "malformed" });
});

test("reports malformed when JSON fails the schema", () => {
  const r = extractSidecar(block(`{ "units": "two" }`), Schema);
  expect(r).toMatchObject({ ok: false, reason: "malformed" });
});

test("respects a custom fence label", () => {
  const out = ["```findings", `{ "units": 1 }`, "```"].join("\n");
  const r = extractSidecar(out, Schema, { fence: "findings" });
  expect(r.ok).toBe(true);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test test/dispatch/sidecar.test.ts`
Expected: FAIL — `Cannot find module '../../src/dispatch/sidecar.ts'`.

- [ ] **Step 3: Create `src/dispatch/sidecar.ts`**

```ts
import type { ZodType } from "zod";

export type SidecarResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: "absent" | "malformed"; detail: string };

/** Extract + zod-validate an agent's structured-output sidecar block (control-loop §3a).
 *  A fenced ```<fence> ... ``` block holds JSON. Absent fence vs malformed JSON/shape are
 *  distinguished: both are transport failures (M3b re-dispatches), never a real verdict. */
export function extractSidecar<T>(
  output: string,
  schema: ZodType<T>,
  opts?: { fence?: string },
): SidecarResult<T> {
  const fence = opts?.fence ?? "styre-sidecar";
  const re = new RegExp("```" + fence + "\\s*\\n([\\s\\S]*?)\\n```");
  const match = output.match(re);
  if (!match || match[1] === undefined) {
    return { ok: false, reason: "absent", detail: `no \`\`\`${fence} block found` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(match[1]);
  } catch (err) {
    return { ok: false, reason: "malformed", detail: `invalid JSON: ${String(err)}` };
  }
  const result = schema.safeParse(parsed);
  if (!result.success) {
    return { ok: false, reason: "malformed", detail: result.error.message };
  }
  return { ok: true, value: result.data };
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `bun test test/dispatch/sidecar.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Verify lint + typecheck**

Run: `bun run lint && bun run typecheck`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/dispatch/sidecar.ts test/dispatch/sidecar.test.ts
git commit -m "feat(m3a): zod-validated sidecar extractor (absent vs malformed)"
```

---

### Task 6: git worktree manager (real git)

**Files:**
- Create: `src/dispatch/worktree.ts`
- Test: `test/dispatch/worktree.test.ts`

**Interfaces:**
- Produces (all on `src/dispatch/worktree.ts`):
  - `ensureWorktree(repoPath: string, branch: string, worktreePath: string): void` — create a worktree on `branch` (from current HEAD) if absent; reuse if present.
  - `worktreeHasChanges(worktreePath: string): boolean` — true if `git status --porcelain` is non-empty.
  - `commitWorktree(worktreePath: string, message: string): { sha: string; changed: boolean }` — `git add -A`; if nothing changed, return the current HEAD sha + `changed:false`; else commit with `message` and return the new sha + `changed:true`. (CL-COMMIT: the daemon commits, with a deterministic message carrying the dispatch_id — the caller builds the message.)
  - `removeWorktree(repoPath: string, worktreePath: string): void` — `git worktree remove --force`.

- [ ] **Step 1: Write the failing test** — `test/dispatch/worktree.test.ts`

```ts
import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  commitWorktree,
  ensureWorktree,
  removeWorktree,
  worktreeHasChanges,
} from "../../src/dispatch/worktree.ts";

const roots: string[] = [];
afterAll(() => {
  for (const r of roots) {
    rmSync(r, { recursive: true, force: true });
  }
});

// Make a real git repo with one commit on `main`; return its path.
function makeRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "styre-wt-"));
  roots.push(root);
  const run = (args: string[]) => {
    const res = Bun.spawnSync(["git", ...args], { cwd: root });
    if (!res.success) {
      throw new Error(`git ${args.join(" ")}: ${res.stderr.toString()}`);
    }
  };
  run(["init", "-b", "main"]);
  run(["config", "user.email", "test@styre.dev"]);
  run(["config", "user.name", "Styre Test"]);
  writeFileSync(join(root, "README.md"), "# repo\n");
  run(["add", "-A"]);
  run(["commit", "-m", "init"]);
  return root;
}

test("ensureWorktree creates a worktree on a branch; idempotent on reuse", () => {
  const repo = makeRepo();
  const wt = join(repo, "..", `wt-${Date.now()}`);
  roots.push(wt);
  ensureWorktree(repo, "feat/eng-1", wt);
  expect(existsSync(join(wt, "README.md"))).toBe(true);
  // calling again is a no-op (does not throw)
  ensureWorktree(repo, "feat/eng-1", wt);
});

test("commitWorktree commits changes and reports changed=true with a sha", () => {
  const repo = makeRepo();
  const wt = join(repo, "..", `wt-${Date.now()}-c`);
  roots.push(wt);
  ensureWorktree(repo, "feat/eng-2", wt);
  writeFileSync(join(wt, "file.txt"), "hello");
  expect(worktreeHasChanges(wt)).toBe(true);
  const result = commitWorktree(wt, "feat: ENG-2-d0001 implement");
  expect(result.changed).toBe(true);
  expect(result.sha).toMatch(/^[0-9a-f]{7,40}$/);
  expect(worktreeHasChanges(wt)).toBe(false);
});

test("commitWorktree on a clean tree reports changed=false (no-op)", () => {
  const repo = makeRepo();
  const wt = join(repo, "..", `wt-${Date.now()}-n`);
  roots.push(wt);
  ensureWorktree(repo, "feat/eng-3", wt);
  const result = commitWorktree(wt, "feat: nothing");
  expect(result.changed).toBe(false);
  expect(result.sha).toMatch(/^[0-9a-f]{7,40}$/);
});

test("removeWorktree detaches the worktree", () => {
  const repo = makeRepo();
  const wt = join(repo, "..", `wt-${Date.now()}-r`);
  roots.push(wt);
  ensureWorktree(repo, "feat/eng-4", wt);
  removeWorktree(repo, wt);
  expect(existsSync(join(wt, "README.md"))).toBe(false);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test test/dispatch/worktree.test.ts`
Expected: FAIL — `Cannot find module '../../src/dispatch/worktree.ts'`.

- [ ] **Step 3: Create `src/dispatch/worktree.ts`**

```ts
import { existsSync } from "node:fs";
import { join } from "node:path";

/** Run git in `cwd`, returning trimmed stdout; throws on failure. */
function git(args: string[], cwd: string): string {
  const res = Bun.spawnSync(["git", ...args], { cwd });
  if (!res.success) {
    throw new Error(`git ${args.join(" ")} failed: ${res.stderr.toString().trim()}`);
  }
  return res.stdout.toString().trim();
}

/** Create a worktree on `branch` (reset to current HEAD) if absent; reuse if present.
 *  The worktree is the agent's only writable surface (capability isolation, move 4). */
export function ensureWorktree(repoPath: string, branch: string, worktreePath: string): void {
  if (existsSync(join(worktreePath, ".git"))) {
    return;
  }
  git(["worktree", "add", "-B", branch, worktreePath], repoPath);
}

export function worktreeHasChanges(worktreePath: string): boolean {
  return git(["status", "--porcelain"], worktreePath) !== "";
}

/** Stage everything and commit (CL-COMMIT — the daemon commits, never the agent).
 *  No changes → no commit; returns the current HEAD sha with changed=false. */
export function commitWorktree(
  worktreePath: string,
  message: string,
): { sha: string; changed: boolean } {
  git(["add", "-A"], worktreePath);
  if (git(["status", "--porcelain"], worktreePath) === "") {
    return { sha: git(["rev-parse", "HEAD"], worktreePath), changed: false };
  }
  git(["commit", "-m", message], worktreePath);
  return { sha: git(["rev-parse", "HEAD"], worktreePath), changed: true };
}

export function removeWorktree(repoPath: string, worktreePath: string): void {
  git(["worktree", "remove", "--force", worktreePath], repoPath);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test test/dispatch/worktree.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Run the FULL suite + lint + typecheck**

Run: `bun test && bun run lint && bun run typecheck`
Expected: all M0–M2 + M3a tests pass; Biome clean; `tsc --noEmit` exits 0.

- [ ] **Step 6: Commit**

```bash
git add src/dispatch/worktree.ts test/dispatch/worktree.test.ts
git commit -m "feat(m3a): git worktree manager (CL-COMMIT, daemon-commits)"
```

---

## M3a acceptance criteria

- [ ] `dispatch` repo records + reads per-invocation rows (start fields, completion outcome/usage).
- [ ] `resolveModel` maps agent handlerKeys to the correct tier (Opus/Sonnet/Haiku; Opus on implement loopback) and throws for non-agent keys.
- [ ] `allowlistFor` returns the per-step tool set; **no allowlist contains an outward tool**; throws for non-agent keys.
- [ ] `loadProfile`/`parseProfile` validate the profile via zod (defaults filled, bad input rejected).
- [ ] `renderPrompt` substitutes placeholders and reports unresolved ones (the CL-PROFILE gate).
- [ ] `extractSidecar` extracts + zod-validates, distinguishing `absent` vs `malformed` (§3a).
- [ ] worktree manager creates/commits(CL-COMMIT)/cleans a real git worktree, reporting `changed`.
- [ ] `bun test` green; `bun run lint && bun run typecheck` clean; the binary still builds + runs.

## Out of scope (M3b and later)

- **The real `ClaudeRunner` boundary** (`Bun.spawn` `claude -p --allowed-tools … --model …` under a timeout, pid journaling, transcript/usage capture) — **M3b** (injectable so M2's tests stay offline).
- **The dispatch step** (assemble model+allowlist+rendered-prompt+timeout → run → journal `dispatch` row → daemon-commit via `commitWorktree` → enforce postconditions) and the **real `design:dispatch` + `implement:dispatch` handlers** replacing M2's mocks — **M3b**.
- **The ported prompt assets** (`prompts/*.md` from the legacy `AGENT_PROMPTS.md`) consumed by `renderPrompt` — **M3b** (M3a builds the engine; tests use inline templates).
- **Fine-grained tool path scoping** (design Write/Edit → `docs/**`, implement Bash → profile runners) + the scope-check leaf — **M3b/later**.
- **The structured-judgment steps** `design:extract` / `design:review` / `review` consuming the sidecar — **M5**.
- **The full project-profile artifact contract** (the §5 versioned public API) — **M7**; M3a's `Profile` is the minimal subset render-prompt/dispatch need.

## Done / handoff

When M3a is delivered, **pause to confirm M3a's delivered shape** with the operator (per the M2 cadence) — that review informs M3b. Then plan/execute **M3b**: the real `claude -p` boundary + the dispatch step + real `design:dispatch`/`implement:dispatch` handlers + a manual real-`claude` smoke.

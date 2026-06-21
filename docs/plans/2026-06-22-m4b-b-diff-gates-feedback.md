# M4b-b — Diff-Inspection Verify Gates + Failure Feedback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the verify gates that inspect the coding diff — a behavioral chunk's test check fails unless a test file was actually added/changed (with an "add a test" nudge back to the coder), and an advisory scope note compares changed files against the plan — and, the connective piece, feed every verify failure back into the re-coding prompt so the coder is never re-run blind.

**Architecture:** A new `changedFilesAt(sha, worktree)` git helper exposes the files a coding attempt's commit touched (read from the recorded `branch_head_sha`). The behavioral gate runs inside `verify:check` only for a behavioral unit's *test* check: if the command is green but the diff has no test file, it records the test result as a fail with a distinguishing `detail.reason` and throws (so the existing route-by-kind bounces the unit back). `scope_diff` is computed daemon-side as an advisory signal (never throws), recorded once per unit/commit. Failure feedback is built from the prior attempt's failing signals and injected into the implement prompt via a new `{{feedback}}` template variable, so a bounce-back (including the "add a test" case) tells the coder exactly what to fix. Test-file classification uses a built-in default heuristic, overridable by a new optional `profile.testFilePattern`.

**Tech Stack:** Bun (1.3.5), `bun:sqlite`, `bun test`, Biome.

## Global Constraints

- **Behavioral gate is deterministic** (control-loop §S3/A1): `behavioral=1` ⇒ the test check requires *a test file in the dispatch diff* AND the test command green. Whether the test is *good* is the reviewer's job, never the daemon's.
- **scope_diff is advisory** (control-loop §S3/A3): it produces a signal that is input to review; it NEVER fails the verify step.
- **Ground truth gates the step; verify is daemon-run, read-only, no agent, no commit; single-writer** (unchanged from M4a/M4b-a).
- **History is append-only:** signals are only inserted, never deleted; each carries its `branch_head_sha`.
- **The resolver stays pure** (SQLite only). The diff inspection happens in the *handlers* (which already run in the worktree), never in the resolver.
- **Provider-agnostic intact:** no `src/agent/*` change; no Claude/model literal introduced.
- **Two schema files in sync:** any schema change goes in BOTH `src/db/schema.sql` (runtime) and `docs/architecture/schema.sql`. (This milestone needs NO SQL schema change — `testFilePattern` is a zod Profile field, not a DB column; `scope_diff`/`behavioral-no-test` use the existing open-vocab `signal_type`/`detail_json`.)
- **Timestamps UTC** via `nowUtc()`.
- **Bun conventions:** `.ts` import extensions; `import type` for type-only; double quotes; semicolons; 2-space/100-col; no non-null assertions (`if (!x) throw` / `?? null`); `noUnusedLocals`/`noUnusedParameters`; Biome `organizeImports` (run `bun run lint`; apply `./node_modules/.bin/biome check --write .` if flagged).
- **Full gate before each commit:** `bun test && bun run lint && bun run typecheck` clean (existing suite stays green).
- **Conventional Commits.** Branch `feat/m4b-b-diff-gates` only — never `main`, no push, no PR (the operator opens/merges).

## CARRY — not built in this milestone

- **The `styre setup` auto-probe that populates `profile.testFilePattern`.** There is no `setup` command / profile-probe yet (only `loadProfile(path)`). M4b-b adds the profile FIELD + a built-in default so the gate works now; auto-detecting the pattern at setup time is wired when `styre setup` is built (a later CLI milestone). Until then `testFilePattern` is operator-settable in the profile, with the default heuristic as fallback.

## DEFERRED to later milestones (do NOT build here)

- CI / `external_checks` polling → M6. Independent-reviewer / structured judgment (`design:review`, `review`) → M5. Cross-stage re-run after a review bounce-back → M5. Distinct-count / spend budgets → later.

## Vocabulary (plain ↔ code)

- "coding diff" = the files changed by a unit's latest coding attempt's commit (`dispatch.branch_head_sha`).
- "behavioral gate" = A1; "scope note" = scope_diff (A3); "add-a-test nudge" = I5.
- "feedback" = the text fed into the re-coding prompt describing what failed.

## File Structure

- **Create `src/dispatch/test-file.ts`** — `isTestFile(path, pattern?)` (built-in heuristic + optional regex override). One responsibility: classify a path as a test file.
- **Create `src/dispatch/feedback.ts`** — `implementFeedback(db, workUnitId)` builds the re-coding feedback string from the prior attempt's failing signals.
- **Modify `src/dispatch/worktree.ts`** — add `changedFilesAt(sha, worktreePath)`.
- **Modify `src/db/repos/work-unit.ts`** — add `parseFilesToTouch(row)`.
- **Modify `src/dispatch/profile.ts`** — add optional `testFilePattern`.
- **Modify `src/dispatch/handlers.ts`** — A1 gate + scope_diff in `verify:check`; feedback wired into `implement:dispatch`.
- **Modify `src/dispatch/prompt-vars.ts`** + **`prompts/implement.md`** — the `{{feedback}}` variable.
- **Tests** alongside each + an e2e.

---

### Task 1: diff-inspection substrate

**Files:**
- Create: `src/dispatch/test-file.ts`, `test/dispatch/test-file.test.ts`
- Modify: `src/dispatch/worktree.ts`, `test/dispatch/worktree.test.ts`
- Modify: `src/db/repos/work-unit.ts`, `test/db/repos/work-unit.test.ts`
- Modify: `src/dispatch/profile.ts`, `test/dispatch/profile.test.ts`

**Interfaces:**
- Produces:
  - `changedFilesAt(sha: string, worktreePath: string): string[]` — the files changed by commit `sha` (its diff vs its parent), via `git diff-tree --no-commit-id -r --name-only <sha>`.
  - `parseFilesToTouch(row: WorkUnitRow): string[]` — the unit's declared file paths (`[]` if null).
  - `isTestFile(path: string, pattern?: string): boolean` — true if `path` looks like a test file. If `pattern` is given, `new RegExp(pattern).test(path)`; else the built-in heuristic.
  - `ProfileSchema` gains `testFilePattern: z.string().optional()`.

- [ ] **Step 1: Write the failing tests**

`test/dispatch/test-file.test.ts`:
```ts
import { expect, test } from "bun:test";
import { isTestFile } from "../../src/dispatch/test-file.ts";

test("built-in heuristic recognizes common test files", () => {
  expect(isTestFile("src/foo.test.ts")).toBe(true);
  expect(isTestFile("src/foo.spec.js")).toBe(true);
  expect(isTestFile("test/foo.ts")).toBe(true);
  expect(isTestFile("pkg/__tests__/foo.tsx")).toBe(true);
  expect(isTestFile("foo_test.go")).toBe(true);
  expect(isTestFile("tests/test_foo.py")).toBe(true);
  expect(isTestFile("src/foo.ts")).toBe(false);
  expect(isTestFile("README.md")).toBe(false);
});

test("an explicit pattern overrides the heuristic", () => {
  expect(isTestFile("src/foo.ts", "\\.ts$")).toBe(true);
  expect(isTestFile("src/foo.test.ts", "checks/")).toBe(false);
});
```

Append to `test/dispatch/worktree.test.ts` (create it if absent — follow the existing temp-git-repo pattern from `verify-handlers.test.ts`):
```ts
import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { changedFilesAt } from "../../src/dispatch/worktree.ts";

test("changedFilesAt returns the files a commit touched", () => {
  const root = mkdtempSync(join(tmpdir(), "styre-cf-"));
  const run = (a: string[]) => Bun.spawnSync(["git", ...a], { cwd: root });
  run(["init", "-b", "main"]); run(["config", "user.email", "t@s.dev"]); run(["config", "user.name", "T"]);
  writeFileSync(join(root, "README.md"), "x"); run(["add", "-A"]); run(["commit", "-m", "init"]);
  writeFileSync(join(root, "feature.ts"), "export const x = 1;\n");
  writeFileSync(join(root, "feature.test.ts"), "test\n");
  run(["add", "-A"]); run(["commit", "-m", "work"]);
  const sha = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: root }).stdout.toString().trim();
  const files = changedFilesAt(sha, root);
  expect(files.sort()).toEqual(["feature.test.ts", "feature.ts"]);
});
```

Append to `test/db/repos/work-unit.test.ts`:
```ts
test("parseFilesToTouch returns the declared paths, [] when null", () => {
  const { db, ticketId } = makeTestDb();
  const u1 = insertWorkUnit(db, { ticketId, seq: 1, kind: "backend", filesToTouch: ["a.ts", "b.ts"] });
  const u2 = insertWorkUnit(db, { ticketId, seq: 2, kind: "backend" });
  db.close();
  expect(parseFilesToTouch(u1)).toEqual(["a.ts", "b.ts"]);
  expect(parseFilesToTouch(u2)).toEqual([]);
});
```
> NOTE: `insertWorkUnit` does not currently accept `filesToTouch`. Add an optional `filesToTouch?: string[] | null` param to it (mirror how `verifyCheckTypes`/`dependsOn` are JSON-stringified into the existing `files_to_touch` column) as part of this task — the column already exists. Import `parseFilesToTouch` in the test.

Append to `test/dispatch/profile.test.ts`:
```ts
test("testFilePattern is optional and parses when present", () => {
  expect(parseProfile({ slug: "s", targetRepo: "/r" }).testFilePattern).toBeUndefined();
  expect(parseProfile({ slug: "s", targetRepo: "/r", testFilePattern: "\\.spec\\." }).testFilePattern).toBe("\\.spec\\.");
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `bun test test/dispatch/test-file.test.ts test/dispatch/worktree.test.ts test/db/repos/work-unit.test.ts test/dispatch/profile.test.ts`
Expected: FAIL — `isTestFile`/`changedFilesAt`/`parseFilesToTouch`/`testFilePattern` undefined or `filesToTouch` param missing.

- [ ] **Step 3: Create `src/dispatch/test-file.ts`**

```ts
/** Classify a path as a test file. With an explicit `pattern` (a regex source string from the
 *  project profile) that regex decides; otherwise a built-in heuristic covering common stacks.
 *  Used by the behavioral gate (A1) — "did the coding diff add/modify a test?". */
const DEFAULT_TEST_FILE = /(?:^|\/)(?:tests?|specs?|__tests__)\/|(?:\.(?:test|spec)\.[jt]sx?$)|(?:_test\.[a-z0-9]+$)|(?:(?:^|\/)test_[^/]+$)/i;

export function isTestFile(path: string, pattern?: string): boolean {
  if (pattern !== undefined && pattern !== "") {
    return new RegExp(pattern).test(path);
  }
  return DEFAULT_TEST_FILE.test(path);
}
```

- [ ] **Step 4: Add `changedFilesAt` to `src/dispatch/worktree.ts`**

```ts
/** The files changed by commit `sha` (its diff vs its parent). Read-only; used by the verify
 *  gates to inspect what a coding attempt actually touched. */
export function changedFilesAt(sha: string, worktreePath: string): string[] {
  const out = git(["diff-tree", "--no-commit-id", "-r", "--name-only", sha], worktreePath);
  return out === "" ? [] : out.split("\n").filter((l) => l !== "");
}
```
> `git(...)` is the existing private helper in this file (returns trimmed stdout, throws on failure).

- [ ] **Step 5: Add `parseFilesToTouch` + the `filesToTouch` insert param to `src/db/repos/work-unit.ts`**

Add the param to `insertWorkUnit` (alongside `verifyCheckTypes`/`dependsOn`): accept `filesToTouch?: string[] | null`, and in the INSERT bind `files_to_touch` = `p.filesToTouch == null ? null : JSON.stringify(p.filesToTouch)` (the `files_to_touch` column already exists in the INSERT column list — if it is not currently inserted, add it in the same position in both the column list and VALUES). Append:
```ts
export function parseFilesToTouch(row: WorkUnitRow): string[] {
  return row.files_to_touch === null ? [] : (JSON.parse(row.files_to_touch) as string[]);
}
```

- [ ] **Step 6: Add `testFilePattern` to `src/dispatch/profile.ts`**

In `ProfileSchema`, add (after `promptVars`):
```ts
  testFilePattern: z.string().optional(),
```

- [ ] **Step 7: Run the tests + full suite + lint + typecheck**

Run: `bun test && bun run lint && bun run typecheck`
Expected: the four files' new tests pass; full suite green (all additive).

- [ ] **Step 8: Commit**

```bash
git add src/dispatch/test-file.ts test/dispatch/test-file.test.ts src/dispatch/worktree.ts test/dispatch/worktree.test.ts src/db/repos/work-unit.ts test/db/repos/work-unit.test.ts src/dispatch/profile.ts test/dispatch/profile.test.ts
git commit -m "feat(m4b-b): diff-inspection substrate (changedFilesAt, parseFilesToTouch, isTestFile, testFilePattern)"
```

---

### Task 2: behavioral gate (A1) — test must be in the diff

**Files:**
- Modify: `src/dispatch/handlers.ts`
- Test: `test/dispatch/verify-handlers.test.ts`

**Interfaces:**
- Consumes: `changedFilesAt` (Task 1); `isTestFile` (Task 1); `getById` from work-unit (the unit's `behavioral`); `getLatestByWorkUnit` (the unit's commit sha); existing `verify:check` structure.
- Produces: in `verify:check`, for a behavioral unit's `test` check, when the command is green but the diff has no test file → record the `test` signal as `result: "fail"` with `detail: { reason: "behavioral-no-test" }` and throw (so route-by-kind bounces the unit back). Non-behavioral units, and non-`test` checks, are unaffected.

**Behavior:** the gate is checked ONLY when `checkType === "test"`, the unit is `behavioral === 1`, AND the command passed (`run.exitCode === 0`). It reads the unit's latest coding commit (`getLatestByWorkUnit`), lists its changed files (`changedFilesAt`), and if none is a test file (`isTestFile(p, deps.profile.testFilePattern)`), it overrides the pass to a `behavioral-no-test` fail. If the command did not pass, the normal fail path already applies (don't double-handle).

- [ ] **Step 1: Write the failing test** — append to `test/dispatch/verify-handlers.test.ts`

```ts
test("behavioral unit: green test command but no test in the diff fails with behavioral-no-test", async () => {
  const { db, ticketId, projectId } = makeTestDb();
  const repo = gitRepo();
  db.query("UPDATE project SET target_repo = ? WHERE id = ?").run(repo, projectId);
  db.query("UPDATE ticket SET stage = 'implement' WHERE id = ?").run(ticketId);
  const unit = insertWorkUnit(db, { ticketId, seq: 1, kind: "backend", behavioral: 1, verifyCheckTypes: ["test"] });

  // Coding attempt writes a NON-test file; daemon commits it; profile test command always passes.
  const runner = new FakeAgentRunner((input) => {
    writeFileSync(join(input.cwd, "feature.ts"), "export const x = 1;\n");
    return { completed: true, exitCode: 0, stdout: "{}", stderr: "", timedOut: false, costUsd: null, tokensIn: null, tokensOut: null };
  });
  const registry = buildDispatchRegistry({
    runner, agentConfig: DEFAULT_AGENT_CONFIG,
    profile: parseProfile({ slug: "demo", targetRepo: repo, commands: { test: "true" } }),
    worktreeRoot: mkdtempSync(join(tmpdir(), "styre-a1-")),
  });

  // implement (writes feature.ts, commits) then verify:check test (true passes, but no test file).
  await advanceOneStep(db, ticketId, registry); // implement
  await advanceOneStep(db, ticketId, registry); // verify:check test → A1 fail
  const sig = listByUnit(db, unit.id).find((s) => s.signal_type === "test");
  db.close();
  if (!sig) throw new Error("no test signal");
  expect(sig.result).toBe("fail");
  expect(JSON.parse(sig.detail_json ?? "{}").reason).toBe("behavioral-no-test");
});

test("behavioral unit: a test file in the diff passes the test check", async () => {
  const { db, ticketId, projectId } = makeTestDb();
  const repo = gitRepo();
  db.query("UPDATE project SET target_repo = ? WHERE id = ?").run(repo, projectId);
  db.query("UPDATE ticket SET stage = 'implement' WHERE id = ?").run(ticketId);
  const unit = insertWorkUnit(db, { ticketId, seq: 1, kind: "backend", behavioral: 1, verifyCheckTypes: ["test"] });
  const runner = new FakeAgentRunner((input) => {
    writeFileSync(join(input.cwd, "feature.ts"), "export const x = 1;\n");
    writeFileSync(join(input.cwd, "feature.test.ts"), "test('x', () => {});\n");
    return { completed: true, exitCode: 0, stdout: "{}", stderr: "", timedOut: false, costUsd: null, tokensIn: null, tokensOut: null };
  });
  const registry = buildDispatchRegistry({
    runner, agentConfig: DEFAULT_AGENT_CONFIG,
    profile: parseProfile({ slug: "demo", targetRepo: repo, commands: { test: "true" } }),
    worktreeRoot: mkdtempSync(join(tmpdir(), "styre-a1ok-")),
  });
  await advanceOneStep(db, ticketId, registry); // implement
  await advanceOneStep(db, ticketId, registry); // verify:check test → pass (test file present)
  const sig = listByUnit(db, unit.id).find((s) => s.signal_type === "test");
  db.close();
  expect(sig?.result).toBe("pass");
});
```
> Confirm `insertWorkUnit` accepts `behavioral` (it does). Import what the file doesn't already have.

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test test/dispatch/verify-handlers.test.ts`
Expected: FAIL — the first test currently records `pass` (no behavioral gate yet).

- [ ] **Step 3: Edit `src/dispatch/handlers.ts`** — add the gate inside `verify:check`

Add imports: `changedFilesAt` from `./worktree.ts` (extend the existing import); `isTestFile` from `./test-file.ts`; `getById as getUnit` from `../db/repos/work-unit.ts` (extend the existing work-unit import).

In `verify:check`, after computing `run` and `branchHeadSha` and the base `result`, BEFORE the `insertSignal` call, insert the behavioral-gate override:

```ts
  let result =
    run.exitCode === 0 ? "pass" : run.timedOut || run.exitCode === null ? "error" : "fail";
  let detail: Record<string, unknown> = {
    exitCode: run.exitCode,
    timedOut: run.timedOut,
    stderr: run.stderr.slice(0, 2000),
  };

  // Behavioral gate (A1): a behavioral unit's green test check still fails if the coding diff
  // added no test file. Deterministic; "is the test good?" is the reviewer's job (M5).
  if (result === "pass" && checkType === "test") {
    const unit = getUnit(ctx.db, ctx.workUnitId);
    if (unit && unit.behavioral === 1) {
      const changed = branchHeadSha === undefined ? [] : changedFilesAt(branchHeadSha, worktreePath);
      const hasTest = changed.some((p) => isTestFile(p, deps.profile.testFilePattern));
      if (!hasTest) {
        result = "fail";
        detail = { reason: "behavioral-no-test", changed };
      }
    }
  }

  insertSignal(ctx.db, {
    ticketId: ctx.ticket.id,
    workUnitId: ctx.workUnitId,
    signalType: checkType,
    result,
    command,
    branchHeadSha,
    detail,
  });
  if (result !== "pass") {
    throw new Error(`verify:check ${checkType}: ${result}`);
  }
  return { check: checkType, result };
```
> This replaces the existing `const result = ...; insertSignal({... detail: {...}}); if (result !== "pass") throw...; return ...` tail. Keep the missing-command branch above it unchanged. `result`/`detail` become `let`.

- [ ] **Step 4: Run the test + full suite**

Run: `bun test test/dispatch/verify-handlers.test.ts && bun test`
Expected: PASS; full suite green.

- [ ] **Step 5: Lint + typecheck + commit**

Run: `bun run lint && bun run typecheck`
```bash
git add src/dispatch/handlers.ts test/dispatch/verify-handlers.test.ts
git commit -m "feat(m4b-b): behavioral gate — test must be in the coding diff (A1)"
```

---

### Task 3: scope_diff advisory note

**Files:**
- Modify: `src/dispatch/handlers.ts`
- Test: `test/dispatch/verify-handlers.test.ts`

**Interfaces:**
- Consumes: `changedFilesAt`, `parseFilesToTouch`, `getLatestByWorkUnit`, `getUnit`, `listByUnit` (to record once per commit).
- Produces: in `verify:check`, after the main signal is recorded, compute (once per unit/commit) a `scope_diff` advisory signal: `result: "pass"` if every changed file is in the unit's `files_to_touch` (or `files_to_touch` is empty → nothing to compare → pass), else `result: "fail"` with `detail: { out_of_scope: [...] }`. It NEVER throws and NEVER affects the step outcome.

**Behavior:** scope_diff is advisory — it must not be a scheduled check-type (it has no command and must not gate verification). Compute it as a side-effect of `verify:check`, guarded to record at most once per (unit, commit): skip if a `scope_diff` signal already exists at the current `branch_head_sha` for the unit. Skip entirely if the unit has no `files_to_touch` or there is no commit sha.

- [ ] **Step 1: Write the failing test** — append to `test/dispatch/verify-handlers.test.ts`

```ts
test("scope_diff records an advisory fail for out-of-scope files but does NOT fail the step", async () => {
  const { db, ticketId, projectId } = makeTestDb();
  const repo = gitRepo();
  db.query("UPDATE project SET target_repo = ? WHERE id = ?").run(repo, projectId);
  db.query("UPDATE ticket SET stage = 'implement' WHERE id = ?").run(ticketId);
  // Unit declares it will touch only allowed.ts; non-behavioral so A1 doesn't interfere.
  const unit = insertWorkUnit(db, { ticketId, seq: 1, kind: "backend", behavioral: 0, verifyCheckTypes: ["test"], filesToTouch: ["allowed.ts"] });
  const runner = new FakeAgentRunner((input) => {
    writeFileSync(join(input.cwd, "allowed.ts"), "export const a = 1;\n");
    writeFileSync(join(input.cwd, "sneaky.ts"), "export const b = 2;\n"); // out of scope
    return { completed: true, exitCode: 0, stdout: "{}", stderr: "", timedOut: false, costUsd: null, tokensIn: null, tokensOut: null };
  });
  const registry = buildDispatchRegistry({
    runner, agentConfig: DEFAULT_AGENT_CONFIG,
    profile: parseProfile({ slug: "demo", targetRepo: repo, commands: { test: "true" } }),
    worktreeRoot: mkdtempSync(join(tmpdir(), "styre-sd-")),
  });
  await advanceOneStep(db, ticketId, registry); // implement
  const outcome = await advanceOneStep(db, ticketId, registry); // verify:check test (passes) + scope_diff advisory
  const sigs = listByUnit(db, unit.id);
  const scope = sigs.find((s) => s.signal_type === "scope_diff");
  const testSig = sigs.find((s) => s.signal_type === "test");
  db.close();
  expect(outcome.kind).toBe("stepped"); // step succeeded — advisory did NOT fail it
  expect(testSig?.result).toBe("pass");
  expect(scope?.result).toBe("fail");
  expect(JSON.parse(scope?.detail_json ?? "{}").out_of_scope).toEqual(["sneaky.ts"]);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test test/dispatch/verify-handlers.test.ts`
Expected: FAIL — no `scope_diff` signal recorded yet.

- [ ] **Step 3: Edit `src/dispatch/handlers.ts`** — record the advisory after the main signal

Add imports: `parseFilesToTouch` from `../db/repos/work-unit.ts` (extend the import).

In `verify:check`, AFTER the `insertSignal(...)` for the main check and BEFORE the `if (result !== "pass") throw`, add the advisory computation (it must run even when the main check is about to throw — so place it before the throw):

```ts
  // scope_diff (A3) — advisory only: compare the coding diff against the unit's declared files.
  // Recorded once per (unit, commit); NEVER throws, NEVER gates the step.
  if (branchHeadSha !== undefined) {
    const unitRow = getUnit(ctx.db, ctx.workUnitId);
    const declared = unitRow ? parseFilesToTouch(unitRow) : [];
    const already = listByUnit(ctx.db, ctx.workUnitId).some(
      (s) => s.signal_type === "scope_diff" && s.branch_head_sha === branchHeadSha,
    );
    if (declared.length > 0 && !already) {
      const changed = changedFilesAt(branchHeadSha, worktreePath);
      const outOfScope = changed.filter((p) => !declared.includes(p));
      insertSignal(ctx.db, {
        ticketId: ctx.ticket.id,
        workUnitId: ctx.workUnitId,
        signalType: "scope_diff",
        result: outOfScope.length === 0 ? "pass" : "fail",
        branchHeadSha,
        detail: { changed, out_of_scope: outOfScope },
      });
    }
  }

  if (result !== "pass") {
    throw new Error(`verify:check ${checkType}: ${result}`);
  }
  return { check: checkType, result };
```
> Note: `getUnit` may already be imported (Task 2). Reuse it. The `already` guard keeps it once-per-commit even though `verify:check` runs per check-type.

- [ ] **Step 4: Run the test + full suite**

Run: `bun test test/dispatch/verify-handlers.test.ts && bun test`
Expected: PASS; full suite green.

- [ ] **Step 5: Lint + typecheck + commit**

Run: `bun run lint && bun run typecheck`
```bash
git add src/dispatch/handlers.ts test/dispatch/verify-handlers.test.ts
git commit -m "feat(m4b-b): scope_diff advisory note (never gates the step)"
```

---

### Task 4: failure feedback into the re-coding prompt

**Files:**
- Create: `src/dispatch/feedback.ts`, `test/dispatch/feedback.test.ts`
- Modify: `src/dispatch/prompt-vars.ts`, `prompts/implement.md`, `src/dispatch/handlers.ts`
- Test: `test/dispatch/prompt-vars.test.ts`

**Interfaces:**
- Consumes: `getLatestByWorkUnit` (the prior attempt's sha); `listByUnit` (its failing signals).
- Produces:
  - `implementFeedback(db, workUnitId: number): string` — feedback text from the prior coding attempt's non-pass signals at that attempt's commit; `""` if none (first attempt).
  - `implementVars(ticket, unit, profile, feedback?)` gains a trailing optional `feedback: string` → included as the `feedback` var (default `""`).
  - `prompts/implement.md` gains a `{{feedback}}` line.

**Behavior:** `implementFeedback` finds the unit's latest coding attempt's `branch_head_sha`, takes the non-`pass` signals recorded at that sha, and renders a short instruction: for a `detail.reason === "behavioral-no-test"` signal → "Your previous attempt changed behavior but added no test. Add a test that exercises the new behavior."; for other failing checks → "The <check> check failed: <stderr/exit detail>." Empty string when there are no prior failures (first attempt) so the template renders cleanly.

- [ ] **Step 1: Write the failing tests**

`test/dispatch/feedback.test.ts`:
```ts
import { expect, test } from "bun:test";
import { insertSignal } from "../../src/db/repos/ground-truth-signal.ts";
import { completeDispatch, insertDispatch, nextSeq } from "../../src/db/repos/dispatch.ts";
import { insertWorkUnit } from "../../src/db/repos/work-unit.ts";
import { implementFeedback } from "../../src/dispatch/feedback.ts";
import { makeTestDb } from "../helpers/db.ts";

function seedAttempt(db: ReturnType<typeof makeTestDb>["db"], ticketId: number, unitId: number, sha: string) {
  const d = insertDispatch(db, { ticketId, dispatchId: `ENG-1-d${sha}`, seq: nextSeq(db, ticketId), workUnitId: unitId });
  completeDispatch(db, d.id, { outcome: "clean-success", branchHeadSha: sha });
}

test("empty feedback when the unit has no prior failures", () => {
  const { db, ticketId } = makeTestDb();
  const u = insertWorkUnit(db, { ticketId, seq: 1, kind: "backend" });
  expect(implementFeedback(db, u.id)).toBe("");
  db.close();
});

test("behavioral-no-test failure yields an add-a-test instruction", () => {
  const { db, ticketId } = makeTestDb();
  const u = insertWorkUnit(db, { ticketId, seq: 1, kind: "backend" });
  seedAttempt(db, ticketId, u.id, "sha1");
  insertSignal(db, { ticketId, workUnitId: u.id, signalType: "test", result: "fail", branchHeadSha: "sha1", detail: { reason: "behavioral-no-test" } });
  const fb = implementFeedback(db, u.id);
  db.close();
  expect(fb.toLowerCase()).toContain("add a test");
});

test("a failing check yields a what-failed instruction", () => {
  const { db, ticketId } = makeTestDb();
  const u = insertWorkUnit(db, { ticketId, seq: 1, kind: "backend" });
  seedAttempt(db, ticketId, u.id, "sha1");
  insertSignal(db, { ticketId, workUnitId: u.id, signalType: "build", result: "fail", branchHeadSha: "sha1", detail: { stderr: "boom" } });
  const fb = implementFeedback(db, u.id);
  db.close();
  expect(fb).toContain("build");
});
```

Append to `test/dispatch/prompt-vars.test.ts`:
```ts
test("implementVars carries the feedback var (empty by default)", () => {
  const profile = parseProfile({ slug: "demo", targetRepo: "/r", commands: { test: "bun test" } });
  const ticket = { ident: "ENG-1", title: "T" };
  const unit = { seq: 1, kind: "backend", title: "U" };
  expect(implementVars(ticket, unit, profile).feedback).toBe("");
  expect(implementVars(ticket, unit, profile, "fix the build").feedback).toBe("fix the build");
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `bun test test/dispatch/feedback.test.ts test/dispatch/prompt-vars.test.ts`
Expected: FAIL — `implementFeedback` undefined; `implementVars` has no `feedback`.

- [ ] **Step 3: Create `src/dispatch/feedback.ts`**

```ts
import type { Database } from "bun:sqlite";
import { getLatestByWorkUnit } from "../db/repos/dispatch.ts";
import { listByUnit } from "../db/repos/ground-truth-signal.ts";

/** Build the corrective feedback for re-coding a bounced-back unit, from the prior coding
 *  attempt's non-pass check results. Empty string on the first attempt (no prior failures). */
export function implementFeedback(db: Database, workUnitId: number): string {
  const sha = getLatestByWorkUnit(db, workUnitId)?.branch_head_sha ?? null;
  if (sha === null) {
    return "";
  }
  const failures = listByUnit(db, workUnitId).filter(
    (s) => s.branch_head_sha === sha && s.result !== "pass",
  );
  if (failures.length === 0) {
    return "";
  }
  const lines = failures.map((s) => {
    const detail = s.detail_json === null ? {} : (JSON.parse(s.detail_json) as Record<string, unknown>);
    if (detail.reason === "behavioral-no-test") {
      return "- Your previous attempt changed behavior but added no test. Add a test that exercises the new behavior, then make it pass.";
    }
    const why = typeof detail.stderr === "string" && detail.stderr !== "" ? `: ${detail.stderr.slice(0, 500)}` : "";
    return `- The ${s.signal_type} check ${s.result}${why}`;
  });
  return `Your previous attempt did not pass verification. Fix these before finishing:\n${lines.join("\n")}`;
}
```

- [ ] **Step 4: Add `feedback` to `implementVars` (`src/dispatch/prompt-vars.ts`)**

```ts
export function implementVars(
  ticket: { ident: string; title: string | null },
  unit: { seq: number; kind: string; title: string | null },
  profile: Profile,
  feedback = "",
): Record<string, string> {
  return {
    ident: ticket.ident,
    slug: profile.slug,
    unit_seq: String(unit.seq),
    unit_kind: unit.kind,
    unit_title: unit.title ?? "",
    test_command: profile.commands.test ?? "",
    stack: "",
    feedback,
    ...profile.promptVars,
  };
}
```

- [ ] **Step 5: Add `{{feedback}}` to `prompts/implement.md`**

Append a final line (the template renders `feedback` empty on a first attempt, which is fine):
```markdown

{{feedback}}
```

- [ ] **Step 6: Wire feedback into the `implement:dispatch` handler (`src/dispatch/handlers.ts`)**

Add import: `implementFeedback` from `./feedback.ts`. In the `implement:dispatch` handler, build the feedback and pass it to `implementVars`:
```ts
      vars: implementVars(ctx.ticket, unit, deps.profile, implementFeedback(ctx.db, unit.id)),
```
> This replaces the existing `vars: implementVars(ctx.ticket, unit, deps.profile),`.

- [ ] **Step 7: Run the tests + full suite + lint + typecheck**

Run: `bun test && bun run lint && bun run typecheck`
Expected: PASS; full suite green. (The design/implement prompt templates embed via text import — the existing prompt-vars "every placeholder resolves" test must still pass with the new `{{feedback}}` placeholder, since `implementVars` now provides `feedback`.)

- [ ] **Step 8: Commit**

```bash
git add src/dispatch/feedback.ts test/dispatch/feedback.test.ts src/dispatch/prompt-vars.ts prompts/implement.md src/dispatch/handlers.ts test/dispatch/prompt-vars.test.ts
git commit -m "feat(m4b-b): feed verify failures back into the re-coding prompt (incl. add-a-test)"
```

---

### Task 5: e2e — behavioral bounce-back converges; integration→reconcile re-runs

**Files:**
- Create: `test/dispatch/diff-gates-e2e.test.ts`

**Interfaces:**
- Consumes: `buildDispatchRegistry`, `advanceOneStep`, `FakeAgentRunner`, repos. No new production code — if a real bug surfaces, STOP and report it (don't patch the test).

**Behavior:** two e2es. (a) A behavioral unit whose first coding attempt writes only a non-test file → the behavioral gate fails it → bounce-back → the second attempt (the FakeAgentRunner, on its 2nd call) writes a test file → converges to `verified`, with a `behavioral-no-test` fail result kept in history. (b) The carried integration cycle: a unit verifies, integration fails once, a reconcile unit is spawned + coded, then integration passes — asserting integration ends with a PASS signal at a new branch commit.

- [ ] **Step 1: Write the e2es** — `test/dispatch/diff-gates-e2e.test.ts`

```ts
import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeAgentRunner } from "../../src/agent/fake-runner.ts";
import { DEFAULT_AGENT_CONFIG } from "../../src/config/agent-config.ts";
import { advanceOneStep } from "../../src/daemon/advance.ts";
import { listByUnit } from "../../src/db/repos/ground-truth-signal.ts";
import { getById as getUnit, insertWorkUnit } from "../../src/db/repos/work-unit.ts";
import { buildDispatchRegistry } from "../../src/dispatch/handlers.ts";
import { parseProfile } from "../../src/dispatch/profile.ts";
import { makeTestDb } from "../helpers/db.ts";

function gitRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "styre-dg-"));
  const run = (a: string[]) => Bun.spawnSync(["git", ...a], { cwd: root });
  run(["init", "-b", "main"]); run(["config", "user.email", "t@s.dev"]); run(["config", "user.name", "T"]);
  writeFileSync(join(root, "README.md"), "x"); run(["add", "-A"]); run(["commit", "-m", "init"]);
  return root;
}

test("behavioral unit converges after the add-a-test bounce-back", async () => {
  const { db, ticketId, projectId } = makeTestDb();
  const repo = gitRepo();
  db.query("UPDATE project SET target_repo = ? WHERE id = ?").run(repo, projectId);
  db.query("UPDATE ticket SET stage = 'implement' WHERE id = ?").run(ticketId);
  const unit = insertWorkUnit(db, { ticketId, seq: 1, kind: "backend", behavioral: 1, verifyCheckTypes: ["test"] });

  let attempt = 0;
  const runner = new FakeAgentRunner((input) => {
    attempt += 1;
    writeFileSync(join(input.cwd, `feature-${attempt}.ts`), `export const v = ${attempt};\n`);
    if (attempt >= 2) writeFileSync(join(input.cwd, "feature.test.ts"), "test('v', () => {});\n");
    return { completed: true, exitCode: 0, stdout: "{}", stderr: "", timedOut: false, costUsd: null, tokensIn: null, tokensOut: null };
  });
  const registry = buildDispatchRegistry({
    runner, agentConfig: DEFAULT_AGENT_CONFIG,
    profile: parseProfile({ slug: "demo", targetRepo: repo, commands: { test: "true" } }),
    worktreeRoot: mkdtempSync(join(tmpdir(), "styre-dgwt-")),
  });

  for (let i = 0; i < 12; i++) {
    if (getUnit(db, unit.id)?.status === "verified") break;
    await advanceOneStep(db, ticketId, registry);
  }
  const results = listByUnit(db, unit.id);
  const finalUnit = getUnit(db, unit.id);
  db.close();
  expect(finalUnit?.status).toBe("verified");
  expect(results.some((r) => r.signal_type === "test" && r.result === "fail")).toBe(true); // the A1 failure kept
  expect(results.some((r) => r.signal_type === "test" && r.result === "pass")).toBe(true);
});

test("integration fails then a reconcile unit makes it pass", async () => {
  const { db, ticketId, projectId } = makeTestDb();
  const repo = gitRepo();
  db.query("UPDATE project SET target_repo = ? WHERE id = ?").run(repo, projectId);
  db.query("UPDATE ticket SET stage = 'implement' WHERE id = ?").run(ticketId);
  const unit = insertWorkUnit(db, { ticketId, seq: 1, kind: "backend", behavioral: 0, verifyCheckTypes: ["test"] });

  // Integration command passes only once a RECONCILE marker file exists; the reconcile unit writes it.
  let coded = 0;
  const runner = new FakeAgentRunner((input) => {
    coded += 1;
    writeFileSync(join(input.cwd, `c-${coded}.ts`), `export const v = ${coded};\n`);
    // The reconcile unit (2nd+ coding) writes the marker that makes integration pass.
    if (coded >= 2) writeFileSync(join(input.cwd, "RECONCILED"), "ok");
    return { completed: true, exitCode: 0, stdout: "{}", stderr: "", timedOut: false, costUsd: null, tokensIn: null, tokensOut: null };
  });
  const registry = buildDispatchRegistry({
    runner, agentConfig: DEFAULT_AGENT_CONFIG,
    profile: parseProfile({ slug: "demo", targetRepo: repo, commands: { test: "true", build: "test -f RECONCILED || test -f STOP" } }),
    worktreeRoot: mkdtempSync(join(tmpdir(), "styre-dgint-")),
  });

  // Drive until integration PASSES — checked at the top BEFORE each tick, so we stop before the
  // tick that would advance implement→review (no review handler exists yet; that would throw).
  const integrationPassed = () =>
    (db
      .query("SELECT COUNT(*) AS n FROM ground_truth_signal WHERE ticket_id = ? AND signal_type = 'integration' AND result = 'pass'")
      .get(ticketId) as { n: number }).n > 0;
  for (let i = 0; i < 20; i++) {
    if (integrationPassed()) break;
    await advanceOneStep(db, ticketId, registry);
  }
  const intSigs = db
    .query("SELECT result, branch_head_sha FROM ground_truth_signal WHERE ticket_id = ? AND signal_type = 'integration' ORDER BY id")
    .all(ticketId) as Array<{ result: string; branch_head_sha: string | null }>;
  db.close();
  // integration failed at least once, then passed at a later commit (after the reconcile unit).
  expect(intSigs.some((s) => s.result === "fail")).toBe(true);
  expect(intSigs.some((s) => s.result === "pass")).toBe(true);
  expect(new Set(intSigs.map((s) => s.branch_head_sha)).size).toBeGreaterThan(1);
});
```
> The integration e2e is intricate; if its control flow proves flaky to drive deterministically, simplify it to assert the reconcile unit is spawned + integration re-runs at a new sha rather than full advance — but do NOT weaken the behavioral e2e. If a real bug surfaces, STOP and report.

- [ ] **Step 2: Run the e2es**

Run: `bun test test/dispatch/diff-gates-e2e.test.ts`
Expected: PASS. If a handler throws unexpectedly or it doesn't converge, STOP and report which module is at fault.

- [ ] **Step 3: Run the FULL gate**

Run: `bun test && bun run lint && bun run typecheck && bun run build && ./dist/styre --version`
Expected: full suite green, Biome clean, `tsc --noEmit` exit 0, binary builds + prints version.

- [ ] **Step 4: Commit**

```bash
git add test/dispatch/diff-gates-e2e.test.ts
git commit -m "test(m4b-b): e2e behavioral bounce-back converges + integration reconcile re-runs"
```

---

## M4b-b acceptance criteria

- [ ] `changedFilesAt` returns a commit's changed files; `isTestFile` classifies via a built-in default or a profile pattern; `parseFilesToTouch` parses the declared paths; `profile.testFilePattern` is an optional field.
- [ ] A behavioral unit's test check fails (`behavioral-no-test`) when the command is green but no test file is in the coding diff; passes when a test file is present.
- [ ] `scope_diff` records an advisory pass/fail (changed vs declared) once per unit/commit and NEVER fails the step.
- [ ] A bounce-back feeds the prior failure into the re-coding prompt (`{{feedback}}`), including a specific "add a test" instruction for the behavioral-no-test case.
- [ ] e2e: a behavioral unit converges to `verified` after the add-a-test bounce-back, with the A1 failure kept in history.
- [ ] `bun test` green; lint + typecheck clean; binary builds. No `src/agent/*` change; no SQL schema change.

## Out of scope / carries
- The `styre setup` auto-probe that populates `profile.testFilePattern` (no setup command yet) → wired when the CLI setup is built.
- CI/`external_checks` → M6. Independent reviewer / structured judgment → M5.

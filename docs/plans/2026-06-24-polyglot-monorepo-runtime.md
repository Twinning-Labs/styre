# Polyglot-Monorepo Runtime Implementation Plan (Plan 1 of 2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace styre's flat per-repo `commands` record with a path-glob `components[]` model and make verify + the implement Bash allowlist route per-stack by the committed diff — so a polyglot monorepo (e.g. a Tauri app: Svelte + Rust) tests each stack with the right command.

**Architecture:** The profile gains `components[]` (each with path-globs + a per-check-type command map) and `repoCommands`. At verify, the daemon computes a work-unit's *cumulative* changed files (across all its commits) and runs each declared check-type's command for every component whose paths the diff touched. A declared check that resolves to zero runnable commands is an **error**, never a vacuous pass. The implement agent's Bash allowlist is scoped to the unit's expected components. No agent reasoning changes — only substrate + plumbing.

**Tech Stack:** TypeScript (Bun runtime), `bun:sqlite`, zod, `bun:test`, biome. Glob matching via `Bun.Glob`.

**Scope boundary:** This plan (Plan 1) covers the schema + runtime/verify + allowlist + prompt-var. Detection (`styre setup` producing `components[]`) is **Plan 2** (`2026-06-24-polyglot-monorepo-detection.md`) and depends on Task 1 here. Plan 1 is testable on its own via hand-written `components[]` profile fixtures.

## Global Constraints

- **Verify gate is ground-truth only:** decisions come from exit codes + the committed diff; never from an agent blob. No agent runs in `verify:*`.
- **Three-way check resolution (silent-green fix + decision C).** For a declared check-type, per impacted component: (a) real command → run it; (b) explicitly `{ unavailable: true }` → reviewer-only degrade (do NOT fail) + a PR-visible `untested-merge-risk` signal; (c) absent/unknown → `result: "error"`, never a vacuous `pass`. Must-have classes `build`/`test`/`check` are forced to (a)/(b) at setup, so they never hit (c). "Pass" still requires ≥1 real command ran and all that ran were green. An **empty cumulative diff / no-component-matched** is a *distinct* error diagnostic, not (c).
- **Implement Bash allowlist: scope to the unit's components; never bare unscoped `Bash`.** Scope to the unit's expected components (`files_to_touch ∩ paths`); fall back to the scoped union of all components' string commands when that set is empty; when there are **no string commands at all**, the implement agent gets **no `Bash`** (Write/Edit only). This requires modifying `allowlistFor` so `implement:dispatch` never returns the bare `"Bash"` token.
- **No back-compat:** `profile.schemaVersion` is `2`; `parseProfile` hard-fails with a clear message on a legacy flat-`commands` profile.
- **`CommandValue = string | { unavailable: true }`.** Never a blank/missing slot in a persisted must-have.
- **Formatting:** biome, 2-space indent, line width 100. Run `bun run lint` and `bun run typecheck` before each commit.
- **Tests:** `bun:test` (`import { expect, test } from "bun:test"`); in-memory DB via `makeTestDb()` from `test/helpers/db.ts`; profile fixtures via `parseProfile({...})`; a real git repo via the `gitRepo()` helper pattern (see Task 3).

---

## File Structure

- `src/dispatch/profile.ts` — **modify**: replace `commands` + `testFilePattern` with `components[]` + `repoCommands`; bump `schemaVersion`; hard-fail loader. (Schema + types — the shared foundation.)
- `src/dispatch/components.ts` — **create**: pure helpers over `components[]` (glob match, impacted set, command lookup, runner-scoping). One responsibility: component routing math, no I/O.
- `src/dispatch/worktree.ts` — **modify**: add `changedFilesBetween(base, head, worktreePath)`.
- `src/db/schema.sql` — **modify**: add `base_sha TEXT` to `work_unit`.
- `src/db/repos/work-unit.ts` — **modify**: add `base_sha` to `WorkUnitRow`, a `setBaseSha` setter, and select it.
- `src/dispatch/handlers.ts` — **modify**: `implement:dispatch` (capture base_sha + pass scoped runners), `verify:check` (component routing + Rule 4 + per-component A1 + untested signal), `verify:integration` (all components + repoCommands).
- `src/dispatch/run-dispatch.ts` — **modify**: `DispatchSpec.runnerCommands?`; stop reading `profile.commands`.
- `src/dispatch/prompt-vars.ts` — **modify**: `implementVars` re-sources `test_command` from impacted components.
- Existing tests using `commands:{...}` fixtures — **modify** to the `components[]` shape (Task 1, Step 6).

---

## Task 1: Profile component model + pure routing helpers

**Files:**
- Modify: `src/dispatch/profile.ts:64-84`
- Create: `src/dispatch/components.ts`
- Test: `test/dispatch/profile.test.ts` (extend), `test/dispatch/components.test.ts` (create)
- Modify (Step 6): all test files building `parseProfile({... commands ...})`

**Interfaces:**
- Produces:
  - `CommandValue = string | { unavailable: true }`
  - `Component = { name: string; kind: string; paths: string[]; commands: Record<string, CommandValue>; testFilePattern?: string }`
  - `Profile.components: Component[]`, `Profile.repoCommands: Record<string,string>`, `Profile.schemaVersion: 2`
  - `parseProfile(raw): Profile` (hard-fails on legacy `commands`)
  - `components.ts`: `commandFor(c, checkType): string | undefined` · `isUnavailable(c, checkType): boolean` · `matchesComponent(c, path): boolean` · `impactedComponents(components, files): Component[]` · `realRunnerCommands(components): string[]` · `scopedRunnersForFiles(components, files): string[]` · `isScriptRunner(cmd): boolean`

- [ ] **Step 1: Write failing schema tests**

Add to `test/dispatch/profile.test.ts`:
```typescript
import { expect, test } from "bun:test";
import { parseProfile } from "../../src/dispatch/profile.ts";

test("parses a v2 components profile", () => {
  const p = parseProfile({
    slug: "demo",
    targetRepo: "/tmp/repo",
    components: [
      { name: "core", kind: "rust", paths: ["src-tauri/**"], commands: { test: "cargo test" } },
      { name: "fe", kind: "sveltekit", paths: ["src/**"], commands: { test: { unavailable: true } } },
    ],
    repoCommands: { integration: "playwright test" },
  });
  expect(p.schemaVersion).toBe(2);
  expect(p.components).toHaveLength(2);
  expect(p.components[1].commands.test).toEqual({ unavailable: true });
  expect(p.repoCommands.integration).toBe("playwright test");
});

test("hard-fails on a legacy flat-commands profile", () => {
  expect(() =>
    parseProfile({ slug: "demo", targetRepo: "/tmp/repo", commands: { test: "true" } }),
  ).toThrow(/legacy flat .commands/i);
});
```

- [ ] **Step 2: Run, expect failure**

Run: `bun test test/dispatch/profile.test.ts`
Expected: FAIL (current schema has `commands`, no `components`; no hard-fail).

- [ ] **Step 3: Rewrite the schema in `src/dispatch/profile.ts`**

Replace lines 64-84 (the `ProfileSchema`, `Profile`, `parseProfile`, `loadProfile`) with:
```typescript
export const CommandValueSchema = z.union([
  z.string().min(1),
  z.object({ unavailable: z.literal(true) }).strict(),
]);
export type CommandValue = z.infer<typeof CommandValueSchema>;

export const ComponentSchema = z.object({
  name: z.string().min(1),
  kind: z.string().min(1),
  paths: z.array(z.string().min(1)).min(1),
  commands: z.record(z.string(), CommandValueSchema).default({}),
  testFilePattern: z.string().optional(),
});
export type Component = z.infer<typeof ComponentSchema>;

/** The project-profile: canonical stack truth the daemon reads (build-operations §5).
 *  schemaVersion 2 introduces the components[] model (polyglot-monorepo support). */
export const ProfileSchema = z.object({
  schemaVersion: z.literal(2).default(2),
  slug: z.string(),
  targetRepo: z.string(),
  defaultBranch: z.string().default("main"),
  checksSystem: z.enum(["github", "external", "none"]).default("none"),
  components: z.array(ComponentSchema).default([]),
  repoCommands: z.record(z.string(), z.string()).default({}),
  promptVars: z.record(z.string(), z.string()).default({}),
  runtimeContext: RuntimeContextSchema,
});

export type Profile = z.infer<typeof ProfileSchema>;

export function parseProfile(raw: unknown): Profile {
  if (raw && typeof raw === "object" && "commands" in raw) {
    throw new Error(
      "profile: legacy flat `commands` field (schemaVersion 1) is no longer supported. " +
        "Re-run `styre setup` to regenerate a components[] profile (schemaVersion 2).",
    );
  }
  return ProfileSchema.parse(raw);
}

export function loadProfile(path: string): Profile {
  return parseProfile(JSON.parse(readFileSync(path, "utf8")));
}
```

- [ ] **Step 4: Create `src/dispatch/components.ts`**

```typescript
import type { Component } from "./profile.ts";

/** True if `cmd` is itself a shell invocation (`bash x.sh`, `./x`) — it cannot be tightly
 *  Bash-scoped via `Bash(cmd:*)`, so callers warn when one is used as a runner. */
export function isScriptRunner(cmd: string): boolean {
  return /^(?:bash|sh|zsh|\.\/)/.test(cmd.trim());
}

/** The real command string for a check-type on a component, or undefined when the slot is
 *  absent or explicitly `{ unavailable: true }`. */
export function commandFor(c: Component, checkType: string): string | undefined {
  const v = c.commands[checkType];
  return typeof v === "string" ? v : undefined;
}

/** True iff the component declares this check-type as explicitly unavailable. */
export function isUnavailable(c: Component, checkType: string): boolean {
  const v = c.commands[checkType];
  return typeof v === "object" && v.unavailable === true;
}

/** True if any of the component's path-globs matches `path`. */
export function matchesComponent(c: Component, path: string): boolean {
  return c.paths.some((g) => new Bun.Glob(g).match(path));
}

/** Components whose paths the changed-file set touches (union — a file matching several
 *  components marks all of them). Order preserved from `components`. */
export function impactedComponents(components: Component[], files: string[]): Component[] {
  return components.filter((c) => files.some((f) => matchesComponent(c, f)));
}

/** Every real (string) command across all components — the scoped-union allowlist fallback. */
export function realRunnerCommands(components: Component[]): string[] {
  const out: string[] = [];
  for (const c of components) {
    for (const v of Object.values(c.commands)) {
      if (typeof v === "string") out.push(v);
    }
  }
  return [...new Set(out)];
}

/** Real commands of just the components a file set impacts — the implement Bash scope. */
export function scopedRunnersForFiles(components: Component[], files: string[]): string[] {
  return realRunnerCommands(impactedComponents(components, files));
}
```

- [ ] **Step 5: Write + run helper tests**

Create `test/dispatch/components.test.ts`:
```typescript
import { expect, test } from "bun:test";
import {
  commandFor,
  impactedComponents,
  isScriptRunner,
  isUnavailable,
  realRunnerCommands,
  scopedRunnersForFiles,
} from "../../src/dispatch/components.ts";
import type { Component } from "../../src/dispatch/profile.ts";

const rust: Component = {
  name: "core", kind: "rust", paths: ["src-tauri/**", "crates/**"],
  commands: { test: "cargo test", build: "cargo build" },
};
const fe: Component = {
  name: "fe", kind: "sveltekit", paths: ["src/**"],
  commands: { build: "vite build", test: { unavailable: true } },
};
const comps = [rust, fe];

test("impactedComponents unions across globs", () => {
  expect(impactedComponents(comps, ["src-tauri/lib.rs", "src/app.ts"]).map((c) => c.name))
    .toEqual(["core", "fe"]);
  expect(impactedComponents(comps, ["README.md"])).toHaveLength(0);
});

test("commandFor / isUnavailable distinguish string vs unavailable", () => {
  expect(commandFor(rust, "test")).toBe("cargo test");
  expect(commandFor(fe, "test")).toBeUndefined();
  expect(isUnavailable(fe, "test")).toBe(true);
  expect(commandFor(rust, "lint")).toBeUndefined();
});

test("scopedRunnersForFiles narrows; realRunnerCommands unions; objects filtered", () => {
  expect(scopedRunnersForFiles(comps, ["src/app.ts"])).toEqual(["vite build"]);
  expect(realRunnerCommands(comps).sort()).toEqual(["cargo build", "cargo test", "vite build"]);
});

test("isScriptRunner flags shell invocations", () => {
  expect(isScriptRunner("bash build.sh")).toBe(true);
  expect(isScriptRunner("cargo test")).toBe(false);
});
```
Run: `bun test test/dispatch/profile.test.ts test/dispatch/components.test.ts`
Expected: PASS.

- [ ] **Step 6: Migrate ALL old-shape sites + bridge `probe.ts` to one component**

The whole tree must typecheck after this task (`bun run typecheck` compiles everything, including `test/setup/probe.test.ts`), so migrate every site now — not just literal fixtures. Find them with TWO greps:
```bash
grep -rln "commands:\s*{" test/ src/                 # fixtures that BUILD a flat profile
grep -rnE "\.commands\b|\.testFilePattern\b|schemaVersion" test/ src/   # sites that READ removed fields
```
Fixes:
1. **Fixtures (literal builders).** Rewrite each `parseProfile({... commands: {...} ...})` to the N=1 component form:
```typescript
// BEFORE
parseProfile({ slug: "demo", targetRepo: repo, commands: { test: "true" } })
// AFTER
parseProfile({
  slug: "demo", targetRepo: repo,
  components: [{ name: "app", kind: "app", paths: ["**"], commands: { test: "true" } }],
})
```
2. **Empty-command fixtures change verdict — handle explicitly.** A fixture with `commands: {}` whose unit declares a check (e.g. `verifyCheckTypes:["test"]`) previously passed vacuously but now hits the three-way: the N=1 component has the check **absent** → `error`. For each such fixture (notably `test/helpers/run-harness.ts` ~`commands: {}` and the e2e harnesses), give the N=1 component a real command for every check-type its units declare (e.g. `commands: { build: "true", test: "true" }`), OR drop the declared check-type if the test never intended to gate on it. Do NOT leave `commands: {}` under a unit that declares a check.
3. **Property reads.** Update assertions: `expect(p.schemaVersion).toBe(1)` → `toBe(2)`; `p.commands.test` → `p.components[0].commands.test`; `p.testFilePattern` → `p.components[0].testFilePattern`. This includes the existing assertions in `test/dispatch/profile.test.ts` (the Step 1 tests only ADD cases) and **`test/setup/probe.test.ts`** (migrate it here, in Plan 1).
4. **Bridge `src/setup/probe.ts` to one component (real, not a throwaway).** `probe.ts` must keep typechecking under the new schema AND keep `detectCommands` used (`noUnusedLocals` is on). Replace the `commands:` field with a single synthesized component wrapping the detected commands:
```typescript
// in probeProfile(), replace `commands: detectCommands(targetRepo)` with:
const detected = detectCommands(targetRepo);
// ...and in the returned profile object:
  components: Object.keys(detected).length > 0
    ? [{ name: "app", kind: "app", paths: ["**"], commands: detected }]
    : [],
  repoCommands: {},
```
This is a functional N=1 bridge (single-stack repos work end-to-end after Plan 1); Plan 2 Task 7 replaces it with real multi-component detection. `src/cli/setup.ts` needs no change yet (it consumes the profile object).

Run: `bun run typecheck` then `bun test`
Expected: PASS (whole suite green — no deferred typecheck failures).

- [ ] **Step 7: Commit**

```bash
git add src/dispatch/profile.ts src/dispatch/components.ts test/dispatch/profile.test.ts test/dispatch/components.test.ts test/ src/setup/probe.ts
git commit -m "feat(profile): components[] model + routing helpers (polyglot foundation)"
```

---

## Task 2: Cumulative per-unit diff (`base_sha` + `changedFilesBetween`)

**Files:**
- Modify: `src/db/schema.sql` (work_unit table, ~line 150)
- Modify: `src/db/repos/work-unit.ts` (`WorkUnitRow`, `getById`/`listByTicket` selects, add `setBaseSha`)
- Modify: `src/dispatch/worktree.ts` (add `changedFilesBetween`)
- Test: `test/dispatch/worktree.test.ts` (extend or create)

**Interfaces:**
- Consumes: `WorkUnitRow` (Task 1 unaffected).
- Produces: `WorkUnitRow.base_sha: string | null`; `setBaseSha(db, id, sha): void`; `changedFilesBetween(baseSha, headSha, worktreePath): string[]`.

- [ ] **Step 1: Write failing test for `changedFilesBetween`**

`test/dispatch/worktree.test.ts` ALREADY EXISTS (it tests `changedFilesAt`/`branchHeadSha`) — **extend** it, do not overwrite. Add this test (and its local `git` helper if the file doesn't already have one):
```typescript
import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { changedFilesBetween } from "../../src/dispatch/worktree.ts";

function git(a: string[], cwd: string) {
  const r = Bun.spawnSync(["git", ...a], { cwd });
  if (!r.success) throw new Error(r.stderr.toString());
  return r.stdout.toString().trim();
}

test("changedFilesBetween returns the cumulative diff across commits", () => {
  const repo = mkdtempSync(join(tmpdir(), "styre-cfb-"));
  git(["init", "-b", "main"], repo);
  git(["config", "user.email", "t@s.dev"], repo);
  git(["config", "user.name", "T"], repo);
  writeFileSync(join(repo, "base.txt"), "x");
  git(["add", "-A"], repo);
  git(["commit", "-m", "base"], repo);
  const base = git(["rev-parse", "HEAD"], repo);
  writeFileSync(join(repo, "a.ts"), "1");
  git(["add", "-A"], repo);
  git(["commit", "-m", "c1"], repo);
  writeFileSync(join(repo, "b.ts"), "2");
  git(["add", "-A"], repo);
  git(["commit", "-m", "c2"], repo);
  const head = git(["rev-parse", "HEAD"], repo);

  expect(changedFilesBetween(base, head, repo).sort()).toEqual(["a.ts", "b.ts"]);
});
```

- [ ] **Step 2: Run, expect failure**

Run: `bun test test/dispatch/worktree.test.ts`
Expected: FAIL ("changedFilesBetween is not a function").

- [ ] **Step 3: Add `changedFilesBetween` to `src/dispatch/worktree.ts`**

Append after `changedFilesAt`:
```typescript
/** Files changed between two commits (cumulative, `base..head`). Used by verify to attribute a
 *  work-unit's FULL diff — across all its commits, including loopback re-codes — to components. */
export function changedFilesBetween(baseSha: string, headSha: string, worktreePath: string): string[] {
  if (baseSha === headSha) return [];
  const out = git(["diff", "--name-only", `${baseSha}..${headSha}`], worktreePath);
  return out === "" ? [] : out.split("\n").filter((l) => l !== "");
}
```

- [ ] **Step 4: Run, expect pass**

Run: `bun test test/dispatch/worktree.test.ts`
Expected: PASS.

- [ ] **Step 5: Add `base_sha` to the schema + repo**

In `src/db/schema.sql`, inside `CREATE TABLE work_unit`, add after the `depends_on` column:
```sql
    base_sha          TEXT,                              -- HEAD before the unit's first implement
                                                         -- commit; verify diffs base_sha..HEAD (all
                                                         -- the unit's commits, incl. loopbacks).
```
In `src/db/repos/work-unit.ts`:
- Add `base_sha: string | null;` to `WorkUnitRow`.
- This repo uses an **explicit column list (a `COLS` constant), NOT `SELECT *`** — add `base_sha` to that `COLS` constant so `getById`/`listByTicket` select it. The INSERT column list does not need it (the column is nullable and defaults null).
- Add (`nowUtc` is imported from `../../util/time.ts`):
```typescript
export function setBaseSha(db: Database, id: number, sha: string): void {
  db.query("UPDATE work_unit SET base_sha = ?, updated_at = ? WHERE id = ?").run(sha, nowUtc(), id);
}
```
(Import `nowUtc` from `../../util/time.ts` if not already imported.)

- [ ] **Step 6: Write + run the repo test**

Add to `test/db/work-unit.test.ts` (or create):
```typescript
import { expect, test } from "bun:test";
import { getById, insertWorkUnit, setBaseSha } from "../../src/db/repos/work-unit.ts";
import { makeTestDb } from "../helpers/db.ts";

test("setBaseSha persists and reads back", () => {
  const { db, ticketId } = makeTestDb();
  const u = insertWorkUnit(db, { ticketId, seq: 1, kind: "backend" });
  expect(getById(db, u.id)?.base_sha).toBeNull();
  setBaseSha(db, u.id, "abc123");
  expect(getById(db, u.id)?.base_sha).toBe("abc123");
  db.close();
});
```
Run: `bun test test/db/work-unit.test.ts` → PASS.

- [ ] **Step 7: Commit**

```bash
git add src/db/schema.sql src/db/repos/work-unit.ts src/dispatch/worktree.ts test/dispatch/worktree.test.ts test/db/work-unit.test.ts
git commit -m "feat(verify): cumulative per-unit diff via base_sha + changedFilesBetween"
```

---

## Task 3: `verify:check` — component routing, Rule 4 (no silent-green), per-component A1, untested signal

**Files:**
- Modify: `src/dispatch/handlers.ts:264-289` (`implement:dispatch` — capture base_sha) and `:291-378` (`verify:check`)
- Test: `test/dispatch/verify-routing.test.ts` (create)

**Interfaces:**
- Consumes: `impactedComponents`, `commandFor`, `isUnavailable` (Task 1); `changedFilesBetween`, `setBaseSha`, `WorkUnitRow.base_sha` (Task 2); `insertSignal` (`{ticketId, workUnitId?, signalType, result, command?, branchHeadSha?, detail?}`, result ∈ pass/fail/error); `branchHeadSha` (worktree.ts).
- Produces: one aggregate `ground_truth_signal` per check-type (so the resolver's `passingShasFor(signalType=check)` is unchanged); an `untested-merge-risk` signal for behavioral units in test-`unavailable` stacks.

- [ ] **Step 1: Capture `base_sha` on the unit's first implement dispatch**

In `implement:dispatch` (`handlers.ts`), before `runAgentDispatch`, insert:
```typescript
const { repoPath, worktreePath, branch } = worktreeFor(ctx, deps);
ensureWorktree(repoPath, branch, worktreePath);
if (unit.base_sha === null) {
  const base = branchHeadSha(repoPath, branch);
  if (base !== null) setBaseSha(ctx.db, unit.id, base);
}
```
Add imports: `setBaseSha` from `../db/repos/work-unit.ts`; `branchHeadSha` from `./worktree.ts` (extend the existing import line).

- [ ] **Step 2: Write the failing routing tests**

Create `test/dispatch/verify-routing.test.ts`. Use the `gitRepo()` + `advanceOneStep` pattern. The three behaviors that MUST hold:
```typescript
import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
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
  const root = mkdtempSync(join(tmpdir(), "styre-vr-"));
  const run = (a: string[]) => Bun.spawnSync(["git", ...a], { cwd: root });
  run(["init", "-b", "main"]);
  run(["config", "user.email", "t@s.dev"]);
  run(["config", "user.name", "T"]);
  writeFileSync(join(root, "README.md"), "x");
  run(["add", "-A"]);
  run(["commit", "-m", "init"]);
  return root;
}

function rig(repo: string, profileExtra: object) {
  const profile = parseProfile({ slug: "demo", targetRepo: repo, ...profileExtra });
  return { profile, worktreeRoot: mkdtempSync(join(tmpdir(), "styre-vrwt-")) };
}

test("declared check that hits NO component is an error, not a vacuous pass", async () => {
  const { db, ticketId, projectId } = makeTestDb();
  const repo = gitRepo();
  db.query("UPDATE project SET target_repo = ? WHERE id = ?").run(repo, projectId);
  db.query("UPDATE ticket SET stage = 'implement' WHERE id = ?").run(ticketId);
  const unit = insertWorkUnit(db, {
    ticketId, seq: 1, kind: "backend", behavioral: 0, verifyCheckTypes: ["test"],
  });
  // Agent writes a file under NO declared component path.
  const runner = new FakeAgentRunner((input) => {
    writeFileSync(join(input.cwd, "untracked-area/x.py"), "x", { flag: "w" });
    return { completed: true, exitCode: 0, stdout: "{}", stderr: "", timedOut: false, costUsd: null, tokensIn: null, tokensOut: null };
  });
  // ^ note: create the dir first inside the handler-run; simpler: write at repo root in a path no component matches.
  const { profile, worktreeRoot } = rig(repo, {
    components: [{ name: "rust", kind: "rust", paths: ["src-tauri/**"], commands: { test: "true" } }],
  });
  const registry = buildDispatchRegistry({ runner, agentConfig: DEFAULT_AGENT_CONFIG, profile, worktreeRoot });
  for (let i = 0; i < 4; i++) await advanceOneStep(db, ticketId, registry);
  const sig = listByUnit(db, unit.id).find((s) => s.signal_type === "test");
  db.close();
  expect(sig?.result).toBe("error");
});
```
(For the no-match case, make the FakeAgentRunner write to a path no component glob matches, e.g. `docs/note.md` with components only covering `src-tauri/**`. Create parent dirs with `mkdirSync({recursive:true})` inside the runner before `writeFileSync`.)

Add these tests in the same file (they cover the full three-way + the first-unit edge):
- **"a stack with a real command runs and passes"**: component `paths:["**"]`, `commands:{test:"true"}`, behavioral 0 → after ticks, the `test` signal `result === "pass"` and unit `verified`. (Also exercises the FIRST-UNIT path: base_sha is the design commit, head is the first code commit, so `changedFilesBetween` is non-empty and impacted is non-empty — guards against the base==head misroute.)
- **"behavioral unit in a test-unavailable stack degrades to reviewer-only"**: component `paths:["src/**"]`, `commands:{ test: { unavailable: true } }`, unit behavioral 1, agent writes `src/app.ts` → an `untested-merge-risk` signal exists AND the `test` signal `result === "pass"` (decision C — NOT an error).
- **"a declared check absent on an impacted component errors (loud)"**: component `paths:["src/**"]`, `commands:{ build:"true" }` (NO `lint` key, not unavailable), unit `verifyCheckTypes:["lint"]`, agent writes `src/app.ts` → the `lint` signal `result === "error"` with `detail.reason === "check-absent"`. (Confirms (c); only non-must-have checks can reach it.)
- **"mixed tested + untested behavioral unit: tested stack gates, untested stack flags"**: components rust `paths:["src-tauri/**"] commands:{test:"true"}` + fe `paths:["src/**"] commands:{test:{unavailable:true}}`, behavioral 1, agent writes BOTH `src-tauri/lib.rs` (with a rust test file) and `src/app.ts` → `test` signal `pass`, AND a `untested-merge-risk` signal exists for `fe`.

- [ ] **Step 3: Run, expect failure**

Run: `bun test test/dispatch/verify-routing.test.ts`
Expected: FAIL (current handler uses `profile.commands[checkType]`, which no longer exists → typecheck/runtime error).

- [ ] **Step 4: Rewrite the `verify:check` handler body**

Replace the body of `registry.register("verify:check", ...)` (after parsing `checkType` and `ensureWorktree`) with:
```typescript
    const unit = getUnit(ctx.db, ctx.workUnitId);
    if (!unit) throw new Error(`verify:check: work_unit ${ctx.workUnitId} not found`);

    const latestSha = getLatestByWorkUnit(ctx.db, ctx.workUnitId)?.branch_head_sha ?? undefined;

    // Cumulative per-unit diff (base_sha..HEAD, across all the unit's commits incl. loopbacks).
    // Empty-diff is a DISTINCT diagnostic, not a missing-command error — and when base==head (the
    // first-unit edge), fall back to the latest commit's own files so a legitimate unit never
    // misroutes to an empty impacted set.
    const changed =
      unit.base_sha && latestSha && unit.base_sha !== latestSha
        ? changedFilesBetween(unit.base_sha, latestSha, worktreePath)
        : latestSha
          ? changedFilesAt(latestSha, worktreePath)
          : [];
    const impacted = impactedComponents(deps.profile.components, changed);

    // No impacted component → distinct diagnostic (empty diff vs. a diff that matched no component).
    // NOT the "missing command" case; never a vacuous pass.
    if (impacted.length === 0) {
      insertSignal(ctx.db, {
        ticketId: ctx.ticket.id,
        workUnitId: ctx.workUnitId,
        signalType: checkType,
        result: "error",
        branchHeadSha: latestSha,
        detail: { reason: changed.length === 0 ? "empty-diff" : "no-component-matched", checkType, changed },
      });
      throw new Error(
        `verify:check ${checkType}: ${changed.length === 0 ? "no changes detected for unit" : "diff matched no component"}`,
      );
    }

    // THREE-WAY resolution per impacted component (the silent-green fix + decision C):
    //   (a) real command → run it · (b) explicitly { unavailable } → reviewer-only degrade +
    //   PR-visible untested-merge-risk · (c) absent/unknown → error (loud). Must-haves
    //   build/test/check are forced to (a)/(b) at setup, so they never hit (c).
    const toRun = impacted
      .filter((c) => commandFor(c, checkType) !== undefined)
      .map((c) => ({ component: c.name, command: commandFor(c, checkType) as string }));
    const unavailable = impacted.filter((c) => isUnavailable(c, checkType));
    const absent = impacted.filter(
      (c) => commandFor(c, checkType) === undefined && !isUnavailable(c, checkType),
    );

    // (c) absent/unknown on an impacted component → loud error (e.g. a unit declares `lint` but a
    // touched stack has no lint command and never marked it unavailable). Aligning the extract
    // agent's declared check-types to the profile is follow-on (1).
    if (absent.length > 0) {
      insertSignal(ctx.db, {
        ticketId: ctx.ticket.id,
        workUnitId: ctx.workUnitId,
        signalType: checkType,
        result: "error",
        branchHeadSha: latestSha,
        detail: { reason: "check-absent", checkType, components: absent.map((c) => c.name) },
      });
      throw new Error(
        `verify:check ${checkType}: no command configured on ${absent.map((c) => c.name).join(",")}`,
      );
    }

    // (b) every impacted component marked this check unavailable → reviewer-only degrade, NOT error.
    if (toRun.length === 0) {
      for (const c of unavailable) {
        insertSignal(ctx.db, {
          ticketId: ctx.ticket.id,
          workUnitId: ctx.workUnitId,
          signalType: "untested-merge-risk",
          result: "fail",
          branchHeadSha: latestSha,
          detail: { component: c.name, checkType, reason: "check-unavailable" },
        });
      }
      insertSignal(ctx.db, {
        ticketId: ctx.ticket.id,
        workUnitId: ctx.workUnitId,
        signalType: checkType,
        result: "pass",
        branchHeadSha: latestSha,
        detail: { degraded: "reviewer-only", unavailable: unavailable.map((c) => c.name) },
      });
      return { check: checkType, result: "pass", degraded: true };
    }

    // (a) run each impacted component's real command; aggregate.
    const ran: Array<{ component: string; exitCode: number | null; timedOut: boolean }> = [];
    let result: "pass" | "fail" | "error" = "pass";
    let lastCommand = "";
    let lastStderr = "";
    for (const { component, command } of toRun) {
      lastCommand = command;
      const run = await runCommand(command, { cwd: worktreePath, timeoutMs: deps.timeoutMs ?? VERIFY_TIMEOUT_MS });
      ran.push({ component, exitCode: run.exitCode, timedOut: run.timedOut });
      if (run.exitCode !== 0) {
        result = run.timedOut || run.exitCode === null ? "error" : "fail";
        lastStderr = run.stderr.slice(0, 2000);
        break;
      }
    }
    let detail: Record<string, unknown> = { ran, stderr: lastStderr };

    // Per-component A1 behavioral gate: each impacted component with a real test command needs a
    // matching test file in its paths; impacted components with test unavailable emit a PR-visible
    // untested-merge-risk (reviewer-only) without failing the aggregate (decision C).
    if (checkType === "test" && unit.behavioral === 1) {
      for (const c of unavailable) {
        insertSignal(ctx.db, {
          ticketId: ctx.ticket.id,
          workUnitId: ctx.workUnitId,
          signalType: "untested-merge-risk",
          result: "fail",
          branchHeadSha: latestSha,
          detail: { component: c.name, reason: "behavioral-unit-no-test-command" },
        });
      }
      if (result === "pass") {
        for (const c of impacted) {
          if (commandFor(c, "test") === undefined) continue;
          const inComponent = changed.filter((p) => matchesComponent(c, p));
          const hasTest = inComponent.some((p) => isTestFile(p, c.testFilePattern));
          if (!hasTest) {
            result = "fail";
            detail = { reason: "behavioral-no-test", component: c.name, changed: inComponent };
            break;
          }
        }
      }
    }

    insertSignal(ctx.db, {
      ticketId: ctx.ticket.id,
      workUnitId: ctx.workUnitId,
      signalType: checkType,
      result,
      command: lastCommand,
      branchHeadSha: latestSha,
      detail,
    });

    // scope_diff (A3) — advisory; now over the cumulative diff. Recorded once per (unit, sha).
    if (latestSha !== undefined) {
      const declared = parseFilesToTouch(unit);
      const already = listByUnit(ctx.db, ctx.workUnitId).some(
        (s) => s.signal_type === "scope_diff" && s.branch_head_sha === latestSha,
      );
      if (declared.length > 0 && !already) {
        const outOfScope = changed.filter((p) => !declared.includes(p));
        insertSignal(ctx.db, {
          ticketId: ctx.ticket.id,
          workUnitId: ctx.workUnitId,
          signalType: "scope_diff",
          result: outOfScope.length === 0 ? "pass" : "fail",
          branchHeadSha: latestSha,
          detail: { changed, out_of_scope: outOfScope },
        });
      }
    }

    if (result !== "pass") throw new Error(`verify:check ${checkType}: ${result}`);
    return { check: checkType, result };
```
Update the imports in `handlers.ts`: extend the existing `./worktree.ts` import with `changedFilesBetween` (`changedFilesAt` is already imported); add `commandFor, impactedComponents, isUnavailable, matchesComponent` from `./components.ts`. Delete the now-dead `command === undefined` block (the old `profile.commands[checkType]` lookup).

- [ ] **Step 5: Run, expect pass**

Run: `bun test test/dispatch/verify-routing.test.ts`
Expected: PASS (all four routing tests + the first-unit/mixed cases).

- [ ] **Step 6: Surface `untested-merge-risk` in the PR body (decision C — make the degrade visible)**

The signal alone is not read by the resolver (intentionally — it must not gate). Make it visible where a human sees it: in `renderPrBody` (`handlers.ts`), list any `untested-merge-risk` signals for the ticket so the PR shows which stacks merged un-tested. Add to `renderPrBody`, after the work-unit lines:
```typescript
  const risks = listSignalsByTicket(db, ticket.id).filter((s) => s.signal_type === "untested-merge-risk");
  const riskLines = risks.length > 0
    ? ["", "⚠ Untested stacks (reviewer-only — no automated test gate):",
       ...risks.map((s) => `- ${(JSON.parse(s.detail_json ?? "{}").component) ?? "?"}`)]
    : [];
```
and splice `riskLines` into the returned body. Use the existing `listByTicket` from `../db/repos/ground-truth-signal.ts` (import as `listSignalsByTicket`). Add a test in `test/dispatch/verify-routing.test.ts` (or a `renderPrBody` test) asserting the body contains the untested component name when such a signal exists.

- [ ] **Step 7: Migrate `verify-handlers.test.ts` (a real behavioral-contract change, not a fixture rename)**

`test/dispatch/verify-handlers.test.ts` has a `seedVerifying()` helper that puts a unit straight into `verifying` **without** an `implement:dispatch` — so there is no commit and no `base_sha`. The new `verify:check` requires a cumulative diff: with no `base_sha`/dispatch, `changed = []` → `impacted = []` → it now records `error` (correct in production — a unit only reaches `verifying` after `implement` commits). The existing "pass"/"fail" tests there will now error. Migrate them to **drive implement-first** so a real commit + `base_sha` exist before verify: replace `seedVerifying()` with the `gitRepo()` + `FakeAgentRunner` (writes a file) + `advanceOneStep` pattern from `verify-routing.test.ts` (Step 2), and give the profile an N=1 component `{ name:"app", paths:["**"], commands:{ test:"true"/"false" } }` to exercise pass/fail. The "missing profile command" test becomes the **absent-check → error** case (Step 2's third test) — fold it in or delete the now-redundant one.

- [ ] **Step 8: Full suite + lint**

Run: `bun run typecheck && bun run lint && bun test`
Expected: PASS. (Also fix any fixture in `test/dispatch/handlers.test.ts`/`verify-e2e.test.ts` still on the old shape per Task 1 Step 6.)

- [ ] **Step 9: Commit**

```bash
git add src/dispatch/handlers.ts test/dispatch/verify-routing.test.ts test/dispatch/verify-handlers.test.ts
git commit -m "feat(verify): three-way per-component routing; absent=error; reviewer-only degrade + PR-visible untested-merge-risk"
```

---

## Task 4: `verify:integration` — all components + repoCommands

**Files:**
- Modify: `src/dispatch/handlers.ts:380-427`
- Test: `test/dispatch/verify-integration.test.ts` (create)

**Interfaces:**
- Consumes: `Profile.components`, `Profile.repoCommands`, `commandFor` (Task 1).
- Produces: one `integration` signal aggregating every component's build+test + each repoCommand.

- [ ] **Step 1: Write failing test**

Create `test/dispatch/verify-integration.test.ts` — register the registry with a profile whose two components have `build`/`test` = `"true"` and `repoCommands: { integration: "true" }`; drive `verify:integration` (set ticket stage so the resolver emits it, or invoke the handler directly via the registry) and assert the `integration` signal `result === "pass"` and its `detail.ran` lists each component+repoCommand. Include a failing variant where one component's `test` is `"false"` → `result === "fail"`.

- [ ] **Step 2: Run, expect failure** — `bun test test/dispatch/verify-integration.test.ts` → FAIL (handler reads `profile.commands`).

- [ ] **Step 3: Rewrite the `verify:integration` body**

Replace the `commands` assembly (lines ~384-396) and the run loop with:
```typescript
    const jobs: Array<{ label: string; command: string }> = [];
    for (const c of deps.profile.components) {
      for (const key of ["build", "test"] as const) {
        const cmd = commandFor(c, key);
        if (cmd) jobs.push({ label: `${c.name}:${key}`, command: cmd });
      }
    }
    for (const [name, cmd] of Object.entries(deps.profile.repoCommands)) {
      jobs.push({ label: `repo:${name}`, command: cmd });
    }
    if (jobs.length === 0) {
      insertSignal(ctx.db, {
        ticketId: ctx.ticket.id,
        signalType: "integration",
        result: "error",
        detail: { reason: "no component build/test or repoCommands declared" },
      });
      throw new Error("verify:integration: nothing to run");
    }
    const branchHeadSha = getLatestForTicket(ctx.db, ctx.ticket.id)?.branch_head_sha ?? undefined;
    const ran: Array<{ label: string; exitCode: number | null; timedOut: boolean }> = [];
    let result: "pass" | "fail" | "error" = "pass";
    let lastCommand = "";
    for (const { label, command } of jobs) {
      lastCommand = command;
      const run = await runCommand(command, { cwd: worktreePath, timeoutMs: deps.timeoutMs ?? VERIFY_TIMEOUT_MS });
      ran.push({ label, exitCode: run.exitCode, timedOut: run.timedOut });
      if (run.exitCode !== 0) {
        result = run.timedOut || run.exitCode === null ? "error" : "fail";
        break;
      }
    }
    insertSignal(ctx.db, {
      ticketId: ctx.ticket.id,
      signalType: "integration",
      result,
      command: lastCommand,
      branchHeadSha,
      detail: { ran },
    });
    if (result !== "pass") throw new Error(`verify:integration: ${result}`);
    return { integration: result };
```

- [ ] **Step 4: Run, expect pass** — `bun test test/dispatch/verify-integration.test.ts` → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/dispatch/handlers.ts test/dispatch/verify-integration.test.ts
git commit -m "feat(verify): integration runs all components' build/test + repoCommands"
```

---

## Task 5: Implement Bash allowlist — scope to the unit's components, never unscoped

**Files:**
- Modify: `src/dispatch/tool-allowlists.ts` (`allowlistFor` — never return bare `Bash` for `implement`)
- Modify: `src/dispatch/run-dispatch.ts:28-34` (`DispatchSpec`), `:84-93` (allowlist call)
- Modify: `src/dispatch/handlers.ts` (`implement:dispatch` — compute + pass `runnerCommands`)
- Test: `test/dispatch/implement-allowlist.test.ts` (create), `test/dispatch/tool-allowlists.test.ts` (extend)

**Interfaces:**
- Consumes: `scopedRunnersForFiles`, `realRunnerCommands` (Task 1); `parseFilesToTouch` (work-unit repo).
- Produces: `DispatchSpec.runnerCommands?: string[]`; `run-dispatch` passes `spec.runnerCommands ?? []` to `allowlistFor` (no longer reads `profile.commands`); `allowlistFor("implement:dispatch", {runnerCommands: []})` returns READ_ONLY+Write+Edit with **no `Bash`**.

- [ ] **Step 1: Write failing test**

Create `test/dispatch/implement-allowlist.test.ts`. Build a profile with two components (`rust` paths `src-tauri/**` cmds `{build:"cargo build", test:"cargo test"}`; `fe` paths `src/**` cmds `{build:"vite build", test:{unavailable:true}}`). Insert a unit with `filesToTouch: ["src-tauri/lib.rs"]`. Use a `FakeAgentRunner` that records `input.allowedTools`. Drive `implement:dispatch` and assert:
- `allowedTools` includes `Bash(cargo build:*)` and `Bash(cargo test:*)`,
- does NOT include `Bash(vite build:*)`,
- contains no bare `"Bash"` and no object/`[object Object]` artifact.
Add a second case: a unit with empty `filesToTouch` → falls back to the scoped union (`cargo build`, `cargo test`, `vite build`), still no bare `"Bash"`.
Add a THIRD case (the isolation hole the reviewers found): a profile whose every command is `{ unavailable: true }` (so `realRunnerCommands` returns `[]`) → `implement` `allowedTools` contains **no `Bash` token at all** (not bare `"Bash"`, not any `Bash(...)`), but still includes `Write`/`Edit`.

- [ ] **Step 2: Run, expect failure** — FAIL (run-dispatch still reads `Object.values(profile.commands)`; no longer typechecks).

- [ ] **Step 3: Make `allowlistFor` never return bare `Bash` for `implement`**

In `src/dispatch/tool-allowlists.ts`, the `implement:dispatch` entry currently contains a bare `"Bash"` that survives when `runnerCommands` is empty (`allowlistFor` returns `tools` unchanged). Change `allowlistFor` so that for `implement:dispatch`: when `runners.length > 0`, substitute `Bash(cmd:*)` per runner (as today); when `runners.length === 0`, **drop the `Bash` token entirely** (return the allowlist with no Bash — the agent can still `Write`/`Edit`). Concretely, in the `handlerKey === "implement:dispatch"` branch:
```typescript
    const bash = runners.map((c) => `Bash(${c}:*)`);
    return tools.flatMap((t) => (t === "Bash" ? bash : [t])); // runners=[] ⇒ Bash removed, never bare
```
(The existing `runners.length > 0` guard that returned bare `tools` on empty must be removed — the `flatMap` above already yields no Bash when `runners` is empty.) Also **update the now-false comments** in `tool-allowlists.ts` (the "falls back to unscoped `Bash`" lines at the top and in `allowlistFor`) to say empty runners → no `Bash`.

Two `tool-allowlists.test.ts` changes (this is a behavioral contract change, not just an addition):
- **FIX the existing assertion** (`test/dispatch/tool-allowlists.test.ts`, currently `expect(allowlistFor("implement:dispatch")).toContain("Bash")`): it must now assert the bare `"Bash"` is **absent** when no runners are supplied.
- **ADD** a case: `allowlistFor("implement:dispatch", { runnerCommands: ["cargo test"] })` contains `"Bash(cargo test:*)"`, and `allowlistFor("implement:dispatch", { runnerCommands: [] })` contains neither `"Bash"` nor any `"Bash("`-prefixed entry (but still includes `"Write"`/`"Edit"`).

- [ ] **Step 4: Thread `runnerCommands` through `DispatchSpec`**

In `run-dispatch.ts`, add to `DispatchSpec`:
```typescript
  /** Bash runner commands to scope the implement allowlist to (string commands only). Other
   *  handlers omit this (their allowlists do not scope Bash). */
  runnerCommands?: string[];
```
Change the `allowedTools` call (lines 87-89) to:
```typescript
    allowedTools: allowlistFor(spec.handlerKey, { runnerCommands: spec.runnerCommands ?? [] }),
```
Remove the now-unused `Object.values(deps.profile.commands)`.

- [ ] **Step 5: Compute the scoped runners in `implement:dispatch`**

In the `implement:dispatch` handler — **after** the `base_sha` capture added in Task 3 Step 1, before `runAgentDispatch` — build the scoped list and pass it on the spec:
```typescript
    const filesToTouch = parseFilesToTouch(unit);
    const scoped = scopedRunnersForFiles(deps.profile.components, filesToTouch);
    const runnerCommands = scoped.length > 0 ? scoped : realRunnerCommands(deps.profile.components);
```
Add `runnerCommands,` to the `DispatchSpec` object passed to `runAgentDispatch`. Add imports: `scopedRunnersForFiles, realRunnerCommands` from `./components.ts` (`parseFilesToTouch` is already imported). (Note: when `runnerCommands` resolves to `[]` — an all-`unavailable` profile — Step 3 ensures the agent simply gets no Bash; never bare Bash.)

- [ ] **Step 6: Run, expect pass** — `bun test test/dispatch/implement-allowlist.test.ts test/dispatch/tool-allowlists.test.ts` → PASS.

- [ ] **Step 7: Full suite** — `bun run typecheck && bun run lint && bun test` → PASS.

- [ ] **Step 8: Commit**

```bash
git add src/dispatch/tool-allowlists.ts src/dispatch/run-dispatch.ts src/dispatch/handlers.ts test/dispatch/implement-allowlist.test.ts test/dispatch/tool-allowlists.test.ts
git commit -m "fix(isolation): scope implement Bash to the unit's components; never bare unscoped Bash"
```

---

## Task 6: `prompt-vars` — re-source `test_command` from impacted components

**Files:**
- Modify: `src/dispatch/prompt-vars.ts:67-84` (`implementVars`)
- Modify: `src/dispatch/handlers.ts` (the `implementVars(...)` call — pass the unit's `filesToTouch`)
- Test: `test/dispatch/prompt-vars.test.ts` (extend or create)

**Interfaces:**
- Consumes: `scopedRunnersForFiles` is component-wide; here we want the *test* commands specifically — add `scopedTestCommands(components, files): string[]` to `components.ts` (one-liner) or compute inline. Use inline to stay minimal.

- [ ] **Step 1: Write failing test**

Add to `test/dispatch/prompt-vars.test.ts`:
```typescript
import { expect, test } from "bun:test";
import { parseProfile } from "../../src/dispatch/profile.ts";
import { implementVars } from "../../src/dispatch/prompt-vars.ts";

test("implementVars sources test_command from the unit's impacted components", () => {
  const profile = parseProfile({
    slug: "demo", targetRepo: "/tmp/r",
    components: [
      { name: "rust", kind: "rust", paths: ["src-tauri/**"], commands: { test: "cargo test" } },
      { name: "fe", kind: "sveltekit", paths: ["src/**"], commands: { test: { unavailable: true } } },
    ],
  });
  // implementVars only reads seq/kind/title/files_to_touch; cast the partial literal to WorkUnitRow.
  const unit = { seq: 1, kind: "backend", title: "x", files_to_touch: JSON.stringify(["src-tauri/lib.rs"]) } as unknown as import("../../src/db/repos/work-unit.ts").WorkUnitRow;
  const vars = implementVars({ ident: "ENG-1", title: "t" }, unit, profile);
  expect(vars.test_command).toBe("cargo test");
});
```

- [ ] **Step 2: Run, expect failure** — FAIL (current `implementVars` reads `profile.commands.test`, gone).

- [ ] **Step 3: Update `implementVars`**

Type the `unit` param as the full `WorkUnitRow` (the call site passes the full row — `handlers.ts:278`), so there is no narrowed-vs-full ambiguity, and replace `test_command`. Import `WorkUnitRow` from `../db/repos/work-unit.ts`:
```typescript
export function implementVars(
  ticket: { ident: string; title: string | null },
  unit: WorkUnitRow,
  profile: Profile,
  feedback = "",
): Record<string, string> {
  const files: string[] = unit.files_to_touch ? JSON.parse(unit.files_to_touch) : [];
  const impacted = impactedComponents(profile.components, files);
  const source = impacted.length > 0 ? impacted : profile.components;
  const testCommands = source
    .map((c) => commandFor(c, "test"))
    .filter((c): c is string => c !== undefined);
  return {
    ident: ticket.ident,
    slug: profile.slug,
    unit_seq: String(unit.seq),
    unit_kind: unit.kind,
    unit_title: unit.title ?? "",
    test_command: testCommands.join(" && "),
    stack: "",
    feedback,
    ...profile.promptVars,
  };
}
```
Add imports to `prompt-vars.ts`: `commandFor, impactedComponents` from `./components.ts`.

In `handlers.ts`, the `implement:dispatch` call already has `unit` (a `WorkUnitRow`, which has `files_to_touch`) — pass it directly: `implementVars(ctx.ticket, unit, deps.profile, implementFeedback(ctx.db, unit.id))`. (No change needed if `unit` is the full row; confirm `WorkUnitRow` is passed, not a narrowed object.)

- [ ] **Step 4: Run, expect pass** — `bun test test/dispatch/prompt-vars.test.ts` → PASS.

- [ ] **Step 5: Full suite** — `bun run typecheck && bun run lint && bun test` → PASS.

- [ ] **Step 6: Commit**

```bash
git add src/dispatch/prompt-vars.ts src/dispatch/handlers.ts test/dispatch/prompt-vars.test.ts
git commit -m "feat(implement): source test_command from the unit's impacted components"
```

---

## Self-Review

**Spec coverage (against the design doc §3/§6/§7):** §3 component model → Task 1. §6 check-type→command resolution + Rule 4 → Task 3 Step 4. §6 cumulative multi-commit diff → Task 2 + Task 3 Step 1. §6 per-component A1 → Task 3 Step 4. §6 untested-merge-risk signal (decision C) → Task 3 Step 4. §6 integration + repoCommands → Task 4. §6 unmatched-files (decision B) → subsumed by Rule 4 (Task 3) + component `paths` including root files (Plan 2 detection). §7 allowlist (CRITICAL) → Task 5. §5 `test_command` prompt-var (§2 seam) → Task 6. §2 schemaVersion hard-fail → Task 1 Step 3. **Detection/§4/§5 TTY ladder → Plan 2** (out of this plan).

**Placeholder scan:** none — every step has runnable code/commands. The one prose-described test (Task 4 Step 1) names exact assertions; expand to code at execution if desired.

**Type consistency:** `CommandValue`, `Component`, `commandFor`/`impactedComponents`/`isUnavailable`/`matchesComponent`/`scopedRunnersForFiles`/`realRunnerCommands` are defined in Task 1 and used identically in Tasks 3/4/5/6. `setBaseSha`/`base_sha`/`changedFilesBetween` defined in Task 2, used in Task 3. `DispatchSpec.runnerCommands` defined and consumed in Task 5.

**Cross-plan note:** between Plan 1 and Plan 2 the tree stays green because Task 1 Step 6 bridges `probe.ts` to a single N=1 component wrapping `detectCommands` output (a real, functional single-stack profile — not a `components: []` stub). Plan 2 Task 7 replaces that bridge with real multi-component detection.

---

## Revision log (post plan review — 4 independent reviewers)

- **CRITICAL — isolation never-bare-Bash now actually enforced (Task 5 Step 3, new):** `allowlistFor` is modified so `implement:dispatch` with empty runners drops the `Bash` token entirely (Write/Edit only) instead of falling back to bare `"Bash"`. Added the all-`unavailable`-profile test. (Reviewers: Adversarial F1/F2, Feasibility H3.)
- **CRITICAL — silent-green fixed + reconciled with decision C (Task 3 Step 4 rewrite):** three-way per-component resolution — real→run, `{unavailable}`→reviewer-only degrade + PR-visible `untested-merge-risk`, absent/unknown→error. Fixes the mixed tested+untested behavioral case (no longer silent) and the single-untested case (now degrades, not errors). (Adversarial F3; Coherence #2 vocab.)
- **HIGH — first-unit / empty-diff guard (Task 3 Step 4):** empty cumulative diff is a distinct diagnostic with a single-commit fallback, so a legitimate first unit can't misroute to Rule 4 and churn into a spurious escalation. Added first-unit + mixed-stack tests. (Adversarial F4/F5.)
- **PR-visibility of the degrade (Task 3 Step 6, new):** `untested-merge-risk` is surfaced in `renderPrBody` (decision C promised PR-visible).
- **Build-blockers (Task 1 Step 6):** migration now covers property-reads (`.commands`/`.schemaVersion`/`.testFilePattern`), migrates `probe.test.ts` in Plan 1, handles empty-command fixtures (they now error under the three-way), and replaces the non-typechecking stopgap with a real N=1 `probe.ts` bridge. (Feasibility C1/C2/C3.)
- **Task 2:** extend (not create) `worktree.test.ts`; add `base_sha` to the explicit `COLS` constant (repo is not `SELECT *`). (Feasibility H1/H2.)
- **Task 6:** `implementVars` param typed as full `WorkUnitRow` (removes the signature/call-site ambiguity). (Coherence #1.)
- **Empirically validated (no change needed):** `Bun.Glob` co-located boundary holds (`src/**` ∌ `src-tauri/`), baseline green (409/0), `globalThis.prompt`/`extractSidecar({fence})`/`allowlistFor(one-arg)` all valid.

### Round 3 (second plan review — both CRITICAL fixes confirmed HOLD)
- **Existing-test contract migration (Task 3 Step 7, new):** `verify-handlers.test.ts` seeded units into `verifying` with no commit/`base_sha`; under the three-way that now errors. Migrate those tests to drive implement-first (real commit + `base_sha`). (Feasibility blocker #1.)
- **Existing-test assertion fix (Task 5 Step 3):** `tool-allowlists.test.ts` asserted implement `.toContain("Bash")`; the never-bare-Bash fix makes that false — the assertion is now updated, plus the stale "falls back to unscoped Bash" comments. (Feasibility blocker #2 + N4.)
- **Confirmed non-issues (empirical):** the early `return {…, degraded:true}` compiles (`StepHandler` returns `unknown`); the mid-file import passes `tsc` + `biome check`; `allowlistFor` flatMap yields no Bash for empty runners. Both CRITICAL fixes (isolation, silent-green three-way) re-traced and HOLD.

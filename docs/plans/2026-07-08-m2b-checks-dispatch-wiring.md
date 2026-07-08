# M2b — the `checks:dispatch` wiring (resolver hoist + plan-blind author + RED-first ground truth) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

Implements the **wiring half** of M2 of
`docs/brainstorms/2026-07-08-change-scoped-verify-m2-checks-step-design.md` (v2). Read that design first
(especially §2 resolver re-sequence + provision hoist + "resolver is PURE", §3 allowlist has **NO Bash**,
§4 the zod sidecar, §5 identity = **added-file only** + selects-≥1, in-suite execution, coarse semantics,
§8 postcondition, §9 delete-then-insert persist + the `red/green/error → pass/fail/error` vocab map).

Consumes the **M2a substrate** (already merged in this tree):
- `src/dispatch/check-selector.ts` — `frameworkFor`, `buildCheckSelector`, `interpretRunOutput`,
  `signalResultForCoarse`, types `CheckFramework` / `CoarseResult` / `CoarseOrNone` / `RunOutcome`.
- `src/dispatch/checks-schema.ts` — `ChecksOutputSchema` (`{ checksAuthored: {ac_id,test_file,test_name}[] }`).
- `src/db/repos/ac-check.ts` — `insertAcCheck({…,redFirstResult})`, `deleteByTicket`.

---

## Should M2b be one plan or split further?

**One plan (this document).** M2 was *already* split once (M2a substrate / M2b wiring). M2b is the single
coherent wiring milestone — every piece exists only to make one new loop step (`checks:dispatch`) real —
and the operator's cadence is one plan per Mx slice. Splitting again (e.g. "author skeleton" vs "ground
truth") would leave an awkward intermediate `main` where `checks:dispatch` commits authored test files but
records no `ac_check` rows. That is release-inert and harmless, but it fragments a milestone that reads as
one thing.

The tasks are ordered so **Tasks 1–5 land isolated, independently unit-tested leaves** (git helpers,
binary assembler, the RED-first executor, tier/allowlist, prompt) — a natural review checkpoint — and
**Task 6 is the one necessarily-larger integration task** (handler + resolver hoist + the affected-test
updates), because the handler and the resolver flip are mutually dependent for a green end-to-end test.
Task 7 is a small guard.

---

## Goal

Add the plan-blind `checks:dispatch` step to the loop: **hoist `provision`** to run once at design-HEAD,
then dispatch a capability-isolated agent that **authors one new native test file per acceptance
criterion** (no plan, no Bash), have the **runner** verify each authored file's identity (added-file +
name-present + selects-≥1), run each check **RED-first in-suite on clean HEAD**, and persist a **coarse**
`red`/`green`/`error` verdict + selector into `ac_check` (delete-then-insert for resume-safety) plus a
`ground_truth_signal` row with full raw output. Nothing gates yet (M4). The resolver stays **pure**
(descriptors only); `deriveAndPersistAcs` runs inside the handler.

## Architecture

Layered `handler → dispatch helpers → repo`, never the reverse. New/changed surfaces:

- **`src/daemon/resolver.ts`** — in `case "design"`, before `advance → implement`, emit `provision`
  (hoisted) then `checks:dispatch`, each `done()`-gated. Pure: still only returns descriptors.
- **`src/dispatch/worktree.ts`** — `addedFilesAt(sha, worktreePath)` (git-status `A` only) +
  `fileContentAt(sha, file, worktreePath)` (committed content, `null` if absent) — the identity substrate.
- **`src/dispatch/check-selector.ts`** — `binaryFor(fw, {interp})` — the framework→binary assembler (M2a
  decision 3: go/cargo binary carries the subcommand; maven/gradle/vitest carry it in `runArgs`).
- **`src/dispatch/checks-run.ts`** (new) — `runCheckForRed(...)`: assemble `<binary> <runArgs>`, run in the
  component dir via an **injectable** runner, read `interpretRunOutput`. Injectable so the RED-first
  ground-truth path is unit-testable without a real framework on PATH (precedent: `reuse.ts`'s `CmdRunner`).
- **`prompts/checks.md`** (new) + **`checksVars` / `CHECKS_TEMPLATE`** in `src/dispatch/prompt-vars.ts` —
  the builder-of-checks prompt (AC rows + stacks, NOT the plan).
- **`src/dispatch/tool-allowlists.ts`** + **`src/agent/tiers.ts`** — mandatory `checks:dispatch` entries
  (both throw on unknown): allowlist `Read,Grep,Glob,Write,Edit` (**no Bash**), tier `standard`.
- **`src/dispatch/handlers.ts`** — the `checks:dispatch` handler + `RegistryDeps.runCheckCommand?`.

## Tech Stack

TypeScript, Bun (`bun test`, `bun run typecheck`, `bun run lint`), embedded SQLite (`bun:sqlite`), zod.
No new dependencies. `runCommand` = `sh -c` (`src/util/run-command.ts`); git via `Bun.spawnSync`
(`src/dispatch/worktree.ts`).

## Global Constraints (M2 invariants — from the design + CLAUDE.md)

- **Resolver stays PURE (§2).** It emits `step`/`advance` descriptors only. `deriveAndPersistAcs` writes
  rows, so it runs **inside the handler**, first thing — never from the resolver.
- **Provision hoist preserves the reset path (§2).** Implement's existing provision gates
  (`resolver.ts` `case "implement"`) are **not removed** — once `provision` is `done` they find it and
  skip. `resetProvisionIfManifestTouched` in `implement:dispatch` **stays**: a dependency-adding implement
  diff re-arms provision. State it as *"no **redundant** re-provision,"* not "no re-provision."
- **Capability isolation — authoring only, NO Bash (§3).** `checks:dispatch` allowlist =
  `Read,Grep,Glob,Write,Edit`. The agent authors; the **runner** executes. No `gh`/Linear/branch tools;
  the runner commits (CL-COMMIT). No Bash ⇒ no per-handler Bash-scoping (that special-case stays
  `implement:dispatch`-only).
- **Structured output through the validated interface (§4).** Parse `ChecksOutputSchema` via
  `extractSidecar`. Absent/malformed ⇒ **transport failure** (throw → re-dispatch), never "no checks".
  The agent reports only facts it authored — no selector, no verdict.
- **Identity = added-file only + name-present + selects-≥1 (§5.1).** A check is valid iff: `test_file` is
  git-status **`A`** in the checks-commit (an `M`/edit is rejected — the file-scoped selector is only safe
  because the added file holds *nothing but* styre's check); `test_name` is present in the committed added
  content; and the constructed selector **selects ≥1** (`interpretRunOutput` returning `selected-none` ⇒
  identity reject). A rejected check does **not** cover its AC.
- **Ground truth over self-report (§5.3/§5.4).** Coarse verdict from the framework process's exit state via
  `interpretRunOutput` (`green`=ran+passed, `red`=ran+did-not-pass incl. import/absence, `error`=couldn't
  attempt), run **in the component dir** on clean HEAD after the checks-commit, in-suite.
- **Vocab map (§9).** `ground_truth_signal.result ∈ {pass,fail,error}`; `ac_check.red_first_result ∈
  {red,green,error}`. Always write the signal via `signalResultForCoarse(coarse)` — **never** write `'red'`
  into `ground_truth_signal` (its CHECK forbids it).
- **Resume-dedup (§9).** `checks:dispatch` is effectful and `ac_check` has no uniqueness, so persist by
  **delete-then-insert in one transaction**: `deleteByTicket` then per check `insertAcCheck` +
  `insertSignal`. A crashed-and-resumed run re-runs `execute` from scratch; the delete clears prior partial
  rows → no duplicates.
- **No schema change.** M2a added the columns + the writer. Do not touch either `schema.sql` copy.
- Commit after each task. `bun test`, `bun run typecheck`, `bun run lint` green before every commit.

### Plan-time decisions (design under-specification resolved here)

1. **Persist lives in the handler's `execute`, wrapped in ONE `db.transaction` (delete-then-insert), NOT
   in `runStep`'s `onSucceed`.** §9 says "the same transaction that marks the step succeeded," but every
   existing effectful handler (`verify:check`, `provision`, `completeness`) writes its `ground_truth_signal`
   rows directly in `execute`, and `onSucceed` is reserved in `advance.ts` for the verdict-application
   special case (`applyReviewVerdict`, `VERDICT_BEARING_STEPS`). markSucceeded-atomicity is **not required**
   for correctness here: `deleteByTicket` provides idempotency wherever the boundary sits (a crash before
   markSucceeded re-runs `execute` → delete wipes the prior insert → re-insert). So M2b follows the
   established effectful-handler pattern. *(Flagged in the return summary as a deliberate divergence from
   §9's literal wording; not forky — deleteByTicket is the real safety mechanism.)*
2. **A check's component/framework is resolved from its `test_file` path** via
   `impactedComponents(components, [test_file])[0]` (the design says "the target component's test command"
   but does not pin the mapping). No owning component, or `frameworkFor` returns `null` ⇒ the check is
   recorded coarse **`error`** (can't attempt), not rejected — matching §5.2 ("M2b records that check as
   coarse `error`"). Its `selector` column (NOT NULL) is stored as the `test_file` path (honest: no scoped
   selector was buildable).
3. **The framework→binary map (M2a decision 3), `binaryFor`:** `pytest → "<interp> -m pytest"` (interp via
   `resolvePythonInterpreter`; none resolvable ⇒ that check is `error`), `jest → "jest"`,
   `vitest → "vitest"`, `go → "go test"`, `cargo → "cargo test"`, `junit-maven → "mvn"`,
   `junit-gradle → "gradle"`, `rspec → "rspec"`, `minitest → "ruby -Itest"`, `phpunit → "phpunit"`.
   *(Known risk, deferred to M3/bench with a grounded rationale: bare `jest`/`vitest`/`rspec`/`phpunit` are
   vended via `node_modules/.bin` / bundler / `vendor/bin`, not on PATH, so a bare call exits **127 → coarse
   `error`** (`interpretRunOutput` maps 127→error). This is **non-wedging** and the check **still covers its
   AC** (§8) — NOT a crash. Net: node (always) + ruby/php (usually) record `error` instead of the intended
   `red`; go/rust/maven/gradle are typically on PATH; **pytest — the bench/astropy path — works** via
   `resolvePythonInterpreter`. Since M2 gates nothing (release-inert) and M3 is what reads `red`, degraded
   `error` on node/ruby/php has no live consequence yet. Fixing now = per-ecosystem PATH/bundler/vendor
   detection that is only validatable against real repos → M3/bench work, not a guess. Named in design §11.)*
4. **The RED-first executor is injectable for tests.** `RegistryDeps.runCheckCommand?: CmdRunner` (default
   the real `runCommand`) lets the handler's ground-truth path be driven deterministically in tests without
   a real framework binary. Precedent: `reuse.ts`'s `CmdRunner` seam. Only `checks:dispatch` reads it.
5. **`ac_id` in the sidecar is the `acceptance_criterion.id` (DB id), not the seq.** The prompt lists each
   AC by its DB id; the handler rejects a check whose `ac_id` is not a known AC id for the ticket. Avoids a
   seq→id remap and keeps the `ac_check.ac_id` FK correct.
6. **Zero-AC tickets no-op.** If `deriveAndPersistAcs` yields 0 ACs (empty description), the handler returns
   `{authored: 0}` and succeeds without dispatching — nothing to author, and the postcondition is vacuous.

---

## File Structure

- **Modify** `src/dispatch/worktree.ts` — add `addedFilesAt`, `fileContentAt`.
- **Modify** `test/dispatch/worktree.test.ts` — add/extend tests for the two helpers (create the file if absent).
- **Modify** `src/dispatch/check-selector.ts` — add `binaryFor`.
- **Modify** `test/dispatch/check-selector.test.ts` — add `binaryFor` tests.
- **Create** `src/dispatch/checks-run.ts` — `runCheckForRed`.
- **Create** `test/dispatch/checks-run.test.ts` — `runCheckForRed` tests (fake runner).
- **Modify** `src/agent/tiers.ts` — `"checks:dispatch": "standard"`.
- **Modify** `src/dispatch/tool-allowlists.ts` — `"checks:dispatch": [...READ_ONLY, "Write", "Edit"]`.
- **Modify** `test/dispatch/tool-allowlists.test.ts` / `test/agent/tiers.test.ts` — assert the new entries (create if absent).
- **Create** `prompts/checks.md` — the builder-of-checks prompt.
- **Modify** `src/dispatch/prompt-vars.ts` — `CHECKS_TEMPLATE`, `checksVars`.
- **Modify** `test/dispatch/prompt-vars.test.ts` — `checksVars` renders with no missing placeholders (create if absent).
- **Modify** `src/dispatch/handlers.ts` — the `checks:dispatch` handler + `RegistryDeps.runCheckCommand?`.
- **Modify** `src/daemon/resolver.ts` — hoist `provision`, insert `checks:dispatch`.
- **Modify** `test/daemon/resolver.test.ts`, `test/daemon/advance.test.ts`,
  `test/dispatch/design-size-e2e.test.ts`, `test/dispatch/design-review-e2e.test.ts` — the affected loop tests.
- **Create/modify** `test/dispatch/checks-handler.test.ts` — the `checks:dispatch` integration test (FakeAgentRunner).

> Where a named test file does not yet exist, create it. Confirm with
> `ls test/dispatch/ test/agent/` before assuming.

---

## Task 1: Identity substrate — `addedFilesAt` + `fileContentAt`

The runner needs the added (`A`) files of the checks-commit and their committed content to verify identity
(§5.1). `changedFilesAt` returns *all* changed filenames; neither the added-only filter nor a content read
exists yet.

**Files:**
- Modify: `src/dispatch/worktree.ts`
- Test: `test/dispatch/worktree.test.ts`

**Interfaces — Produces:**
- `addedFilesAt(sha: string, worktreePath: string): string[]` — files added (git-status `A`) by commit `sha`.
- `fileContentAt(sha: string, file: string, worktreePath: string): string | null` — the committed content of
  `file` at `sha`, or `null` when the path is absent at that commit.

- [ ] **Step 1: Write the failing test.** Append to (or create) `test/dispatch/worktree.test.ts`:

```ts
import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addedFilesAt, fileContentAt } from "../../src/dispatch/worktree.ts";

function repoWithCommits(): { root: string; addSha: string; modSha: string } {
  const root = mkdtempSync(join(tmpdir(), "styre-wt-"));
  const git = (a: string[]) => {
    const r = Bun.spawnSync(["git", ...a], { cwd: root });
    if (!r.success) throw new Error(`git ${a.join(" ")}: ${r.stderr.toString()}`);
    return r.stdout.toString().trim();
  };
  git(["init", "-b", "main"]);
  git(["config", "user.email", "t@s.dev"]);
  git(["config", "user.name", "T"]);
  writeFileSync(join(root, "existing.py"), "x = 1\n");
  git(["add", "-A"]);
  git(["commit", "-m", "base"]);
  // commit that ADDS a new file
  writeFileSync(join(root, "new_test.py"), "def test_ok():\n    assert False\n");
  git(["add", "-A"]);
  git(["commit", "-m", "add"]);
  const addSha = git(["rev-parse", "HEAD"]);
  // commit that MODIFIES an existing file
  writeFileSync(join(root, "existing.py"), "x = 2\n");
  git(["add", "-A"]);
  git(["commit", "-m", "mod"]);
  const modSha = git(["rev-parse", "HEAD"]);
  return { root, addSha, modSha };
}

test("addedFilesAt returns only git-status A (added) files, not modified ones", () => {
  const { root, addSha, modSha } = repoWithCommits();
  expect(addedFilesAt(addSha, root)).toEqual(["new_test.py"]);
  expect(addedFilesAt(modSha, root)).toEqual([]); // a modify commit adds nothing
});

test("fileContentAt reads committed content, null when the path is absent at that sha", () => {
  const { root, addSha } = repoWithCommits();
  expect(fileContentAt(addSha, "new_test.py", root)).toContain("def test_ok()");
  expect(fileContentAt(addSha, "does_not_exist.py", root)).toBeNull();
});
```

- [ ] **Step 2: Run it — fails.**

```
bun test test/dispatch/worktree.test.ts
```

Expected: `addedFilesAt`/`fileContentAt` not exported.

- [ ] **Step 3: Minimal implementation.** Append to `src/dispatch/worktree.ts` (after `changedFilesBetween`):

```ts
/** Files ADDED (git-status `A`) by commit `sha` — its diff vs its parent, `--diff-filter=A` only.
 *  M2's checks-identity (§5.1) accepts a check ONLY when its test file is newly added: the file-scoped
 *  selector is safe precisely because the added file contains nothing but styre's check. A modified
 *  (`M`) file is rejected — it would re-admit the pre-existing tests around the edit. */
export function addedFilesAt(sha: string, worktreePath: string): string[] {
  const out = git(
    ["diff-tree", "--no-commit-id", "-r", "--name-only", "--diff-filter=A", sha],
    worktreePath,
  );
  return out === "" ? [] : out.split("\n").filter((l) => l !== "");
}

/** The committed content of `file` at `sha` (`git show <sha>:<file>`), or `null` when the path is
 *  absent at that commit. Used by checks-identity (§5.1) to confirm the authored `test_name` is
 *  present in the committed added file (every line of an added file is a `+` line, so "on a `+`
 *  line" reduces to substring presence — M2a plan-time decision 2). */
export function fileContentAt(sha: string, file: string, worktreePath: string): string | null {
  const res = Bun.spawnSync(["git", "show", `${sha}:${file}`], { cwd: worktreePath });
  return res.success ? res.stdout.toString() : null;
}
```

- [ ] **Step 4: Run it — passes.**

```
bun test test/dispatch/worktree.test.ts
```

- [ ] **Step 5: Commit.**

```
bun run typecheck && bun run lint && bun test test/dispatch/worktree.test.ts
git add src/dispatch/worktree.ts test/dispatch/worktree.test.ts
git commit -m "feat(checks): addedFilesAt + fileContentAt — the checks-identity git substrate"
```

---

## Task 2: The framework→binary assembler — `binaryFor`

`buildCheckSelector` emits selection *args*; the runner assembles `<binary> <runArgs>` (M2a decision 3).
Keep `binaryFor` next to the selector so the pair stays coherent.

**Files:**
- Modify: `src/dispatch/check-selector.ts`
- Test: `test/dispatch/check-selector.test.ts`

**Interfaces — Produces:**
- `binaryFor(fw: CheckFramework, opts?: { interp?: string }): string`

`interp` is the resolved python interpreter for pytest (from `resolvePythonInterpreter`); omitted ⇒
`"python3"` fallback (the handler resolves it for real and downgrades to `error` when none exists).

- [ ] **Step 1: Write the failing test.** Append to `test/dispatch/check-selector.test.ts`:

```ts
import { binaryFor } from "../../src/dispatch/check-selector.ts";

describe("binaryFor (M2a decision 3: go/cargo carry the subcommand; maven/gradle/vitest carry it in runArgs)", () => {
  test("pytest uses the resolved interpreter", () => {
    expect(binaryFor("pytest", { interp: "/venv/bin/python" })).toBe("/venv/bin/python -m pytest");
    expect(binaryFor("pytest")).toBe("python3 -m pytest");
  });
  test("go/cargo binary carries the test subcommand", () => {
    expect(binaryFor("go")).toBe("go test");
    expect(binaryFor("cargo")).toBe("cargo test");
  });
  test("maven/gradle/vitest binaries are bare (the subcommand rides in runArgs)", () => {
    expect(binaryFor("junit-maven")).toBe("mvn");
    expect(binaryFor("junit-gradle")).toBe("gradle");
    expect(binaryFor("vitest")).toBe("vitest");
  });
  test("jest/rspec/phpunit are bare binaries; minitest is ruby -Itest", () => {
    expect(binaryFor("jest")).toBe("jest");
    expect(binaryFor("rspec")).toBe("rspec");
    expect(binaryFor("phpunit")).toBe("phpunit");
    expect(binaryFor("minitest")).toBe("ruby -Itest");
  });
});
```

- [ ] **Step 2: Run it — fails.** `bun test test/dispatch/check-selector.test.ts` → `binaryFor is not a function`.

- [ ] **Step 3: Minimal implementation.** Append to `src/dispatch/check-selector.ts`:

```ts
/** The framework binary the runner prepends to `buildCheckSelector`'s `runArgs` (M2a decision 3). The
 *  go/cargo binaries carry the `test` subcommand (their runArgs omit it → `go test -run … ./pkg`);
 *  maven/gradle/vitest carry their goal/task/`run` IN the runArgs, so their binary is bare. pytest
 *  uses the resolved interpreter (`resolvePythonInterpreter`) so it runs against the provisioned env,
 *  not a bare `pytest` that may be absent. */
export function binaryFor(fw: CheckFramework, opts?: { interp?: string }): string {
  switch (fw) {
    case "pytest":
      return `${opts?.interp ?? "python3"} -m pytest`;
    case "jest":
      return "jest";
    case "vitest":
      return "vitest";
    case "go":
      return "go test";
    case "cargo":
      return "cargo test";
    case "junit-maven":
      return "mvn";
    case "junit-gradle":
      return "gradle";
    case "rspec":
      return "rspec";
    case "minitest":
      return "ruby -Itest";
    case "phpunit":
      return "phpunit";
  }
}
```

- [ ] **Step 4: Run it — passes.** `bun test test/dispatch/check-selector.test.ts`

- [ ] **Step 5: Commit.**

```
bun run typecheck && bun run lint && bun test test/dispatch/check-selector.test.ts
git add src/dispatch/check-selector.ts test/dispatch/check-selector.test.ts
git commit -m "feat(checks): binaryFor — framework→binary assembler (M2a decision 3)"
```

---

## Task 3: The RED-first executor — `runCheckForRed` (injectable runner)

Assemble `<binary> <runArgs>`, run it in the component dir, and read `interpretRunOutput`. Isolated in its
own module with an **injectable** runner so the ground-truth path is unit-testable without a real framework
on PATH (decision 4).

**Files:**
- Create: `src/dispatch/checks-run.ts`
- Test: `test/dispatch/checks-run.test.ts`

**Interfaces — Produces:**
- `interface CheckRunResult { coarse: CoarseOrNone; command: string; rawOutput: string }`
- `runCheckForRed(p: { framework: CheckFramework; runArgs: string; binary: string; cwd: string;
  timeoutMs: number; run?: CmdRunner }): Promise<CheckRunResult>`

- [ ] **Step 1: Write the failing test.**

```ts
// test/dispatch/checks-run.test.ts
import { describe, expect, test } from "bun:test";
import type { CommandResult } from "../../src/util/run-command.ts";
import { runCheckForRed } from "../../src/dispatch/checks-run.ts";

const fakeRun =
  (out: Partial<CommandResult>) =>
  async (command: string, _opts: { cwd: string; timeoutMs: number }): Promise<CommandResult> => {
    lastCommand = command;
    return { exitCode: 0, stdout: "", stderr: "", timedOut: false, ...out };
  };
let lastCommand = "";

describe("runCheckForRed", () => {
  test("assembles `<binary> <runArgs>` and reads a RED from a failing pytest run", async () => {
    const res = await runCheckForRed({
      framework: "pytest",
      binary: "python3 -m pytest",
      runArgs: "'tests/t.py::test_ok'",
      cwd: "/repo",
      timeoutMs: 1000,
      run: fakeRun({ exitCode: 1, stdout: "1 failed" }),
    });
    expect(res.command).toBe("python3 -m pytest 'tests/t.py::test_ok'");
    expect(res.coarse).toBe("red");
    expect(res.rawOutput).toContain("1 failed");
  });

  test("passes selected-none straight through (identity reject signal, §5.1)", async () => {
    const res = await runCheckForRed({
      framework: "pytest",
      binary: "python3 -m pytest",
      runArgs: "'tests/t.py::wrong_name'",
      cwd: "/repo",
      timeoutMs: 1000,
      run: fakeRun({ exitCode: 5 }), // pytest: no tests collected
    });
    expect(res.coarse).toBe("selected-none");
  });

  test("a timeout is error", async () => {
    const res = await runCheckForRed({
      framework: "go",
      binary: "go test",
      runArgs: "-run '^TestX$' ./pkg",
      cwd: "/repo",
      timeoutMs: 1,
      run: fakeRun({ exitCode: null, timedOut: true }),
    });
    expect(res.coarse).toBe("error");
  });
});
```

- [ ] **Step 2: Run it — fails.** `bun test test/dispatch/checks-run.test.ts` → module not found.

- [ ] **Step 3: Minimal implementation.**

```ts
// src/dispatch/checks-run.ts
import type { CmdRunner } from "./reuse.ts";
import { runCommand } from "../util/run-command.ts";
import { type CheckFramework, type CoarseOrNone, interpretRunOutput } from "./check-selector.ts";

export interface CheckRunResult {
  /** The coarse RED-first bucket, or `selected-none` (identity reject, §5.1). */
  coarse: CoarseOrNone;
  /** The exact assembled command line that ran (for the ac_check selector / observability). */
  command: string;
  /** Combined stdout+stderr, stored in ground_truth_signal.detail_json (M3 subdivides `red` from it). */
  rawOutput: string;
}

/** Run ONE authored check RED-first, in-suite: assemble `<binary> <runArgs>`, run it in the component
 *  dir `cwd` (so the suite's setup context — conftest / jest config / session fixtures / migrations —
 *  still applies, §5.3), and read the coarse verdict via `interpretRunOutput` (ground truth, never the
 *  agent's word). The runner is injectable for tests (decision 4); production passes the real
 *  `runCommand` (scrubbed env, capability isolation). */
export async function runCheckForRed(p: {
  framework: CheckFramework;
  binary: string;
  runArgs: string;
  cwd: string;
  timeoutMs: number;
  run?: CmdRunner;
}): Promise<CheckRunResult> {
  const command = `${p.binary} ${p.runArgs}`;
  const out = await (p.run ?? runCommand)(command, { cwd: p.cwd, timeoutMs: p.timeoutMs });
  return {
    coarse: interpretRunOutput(p.framework, out),
    command,
    rawOutput: `${out.stdout}\n${out.stderr}`.trim(),
  };
}
```

- [ ] **Step 4: Run it — passes.** `bun test test/dispatch/checks-run.test.ts`

- [ ] **Step 5: Commit.**

```
bun run typecheck && bun run lint && bun test test/dispatch/checks-run.test.ts
git add src/dispatch/checks-run.ts test/dispatch/checks-run.test.ts
git commit -m "feat(checks): runCheckForRed — assemble + run + interpret one authored check (injectable)"
```

---

## Task 4: Tier + allowlist registration (both throw on unknown)

`allowlistFor` and `resolveTier` both throw for an unregistered handler, so `checks:dispatch` needs both
before it can dispatch. Allowlist = authoring only, **no Bash** (§3); tier = `standard` (Sonnet) — authoring
native tests from ACs + reading the repo is implement-class generative work (M2a carried decision).

**Files:**
- Modify: `src/dispatch/tool-allowlists.ts`, `src/agent/tiers.ts`
- Test: `test/dispatch/tool-allowlists.test.ts`, `test/agent/tiers.test.ts` (create if absent)

- [ ] **Step 1: Write the failing tests.**

```ts
// test/dispatch/tool-allowlists.test.ts  (add these; create the file if it does not exist)
import { expect, test } from "bun:test";
import { allowlistFor } from "../../src/dispatch/tool-allowlists.ts";

test("checks:dispatch is authoring-only — Read/Grep/Glob/Write/Edit and NO Bash", () => {
  const tools = allowlistFor("checks:dispatch");
  expect(tools).toEqual(["Read", "Grep", "Glob", "Write", "Edit"]);
  expect(tools).not.toContain("Bash");
});
```

```ts
// test/agent/tiers.test.ts  (add these; create the file if it does not exist)
import { expect, test } from "bun:test";
import { resolveTier } from "../../src/agent/tiers.ts";

test("checks:dispatch is the standard tier (implement-class authoring)", () => {
  expect(resolveTier("checks:dispatch")).toBe("standard");
});
```

- [ ] **Step 2: Run them — fail.**

```
bun test test/dispatch/tool-allowlists.test.ts test/agent/tiers.test.ts
```

Expected: `allowlistFor: no tool allowlist for handlerKey 'checks:dispatch'` / `resolveTier: no tier …`.

- [ ] **Step 3: Minimal implementation.**

In `src/dispatch/tool-allowlists.ts`, add to `ALLOWLISTS` (no Bash ⇒ no scoping needed):

```ts
  "checks:dispatch": [...READ_ONLY, "Write", "Edit"],
```

In `src/agent/tiers.ts`, add to `TIERS`:

```ts
  "checks:dispatch": "standard",
```

- [ ] **Step 4: Run them — pass.**

```
bun test test/dispatch/tool-allowlists.test.ts test/agent/tiers.test.ts
```

- [ ] **Step 5: Commit.**

```
bun run typecheck && bun run lint && bun test test/dispatch/tool-allowlists.test.ts test/agent/tiers.test.ts
git add src/dispatch/tool-allowlists.ts src/agent/tiers.ts test/dispatch/tool-allowlists.test.ts test/agent/tiers.test.ts
git commit -m "feat(checks): checks:dispatch tier=standard + allowlist (Read/Grep/Glob/Write/Edit, no Bash)"
```

---

## Task 5: The prompt — `prompts/checks.md` + `checksVars`

The builder-of-checks prompt (§3): the AC rows (by DB id) + the project's stacks/test-commands, **NOT** the
plan. `checksVars` mirrors the existing `*Vars` builders and reuses `detectedStacksVar`.

**Files:**
- Create: `prompts/checks.md`
- Modify: `src/dispatch/prompt-vars.ts`
- Test: `test/dispatch/prompt-vars.test.ts` (create if absent)

**Interfaces — Produces:**
- `CHECKS_TEMPLATE` (the imported prompt text)
- `checksVars(ticket, profile, acs: { id: number; text: string }[]): Record<string, string>`

- [ ] **Step 1: Write the failing test.**

```ts
// test/dispatch/prompt-vars.test.ts  (add these; create the file if it does not exist)
import { expect, test } from "bun:test";
import { CHECKS_TEMPLATE, checksVars } from "../../src/dispatch/prompt-vars.ts";
import { parseProfile } from "../../src/dispatch/profile.ts";
import { renderPrompt } from "../../src/dispatch/render-prompt.ts";

test("checksVars fills every placeholder in the checks template (no CL-PROFILE miss)", () => {
  const profile = parseProfile({
    slug: "demo",
    targetRepo: "/tmp/r",
    components: [{ name: "api", kind: "python", paths: ["api/**"], commands: { test: "pytest -q" } }],
  });
  const vars = checksVars({ ident: "ENG-1", title: "T" }, profile, [
    { id: 7, text: "returns 200 on GET /health" },
    { id: 8, text: "rejects an unauthenticated request" },
  ]);
  const rendered = renderPrompt(CHECKS_TEMPLATE, vars);
  expect(rendered.ok).toBe(true);
  if (rendered.ok) {
    expect(rendered.prompt).toContain("ac_id=7");
    expect(rendered.prompt).toContain("returns 200 on GET /health");
    expect(rendered.prompt).toContain("api (kind: python)");
  }
});
```

- [ ] **Step 2: Run it — fails.** `bun test test/dispatch/prompt-vars.test.ts` → `CHECKS_TEMPLATE`/`checksVars` not exported.

- [ ] **Step 3: Create the prompt.** `prompts/checks.md`:

```md
You are authoring acceptance checks for ticket {{ident}} ("{{title}}") in project {{slug}}.

For each acceptance criterion below, author ONE **new** test file in this repository's own test
framework whose test(s) **FAIL on the current code** because the criterion is not yet met, and would
pass once it is. You are given the criteria and the project's detected stacks and test commands — you are
NOT given the implementation plan. Read the repository (Read/Grep/Glob) enough to write a *valid,
runnable* failing test; do not guess blindly.

Rules — follow them exactly:
- **One new file per criterion.** Create a brand-new test file. Do NOT edit, extend, or add to any
  existing test file — the runner will reject a check whose file is not newly added.
- Put the file where this component's test command discovers it, with a framework-appropriate name that
  will not collide (include the ticket ident, e.g. `…/styre_checks/{{ident}}_ac<id>_test.<ext>`). For Go
  or Rust, give the file its own package/module directory.
- The file must contain **only** this criterion's check(s) — nothing else.
- You do NOT run anything and you do NOT report a verdict — the runner executes your checks. Report only
  what you wrote.

## Acceptance criteria (author one check file per `ac_id`)

{{acceptance_criteria}}

## Detected stacks (from `styre setup` — ground truth; use the matching framework + test command)

{{detected_stacks}}

Emit your answer as a single fenced block, exactly:

```styre-sidecar
{
  "checksAuthored": [
    { "ac_id": 7, "test_file": "api/tests/styre_checks/ENG-1_ac7_test.py", "test_name": "test_health_returns_200" }
  ]
}
```

Report, per check: the acceptance-criterion `ac_id` it targets, the repo-relative `test_file` you created,
and the `test_name` (function/case name) you wrote. Report no selector and no result.
```

- [ ] **Step 4: Add the import + builder to `src/dispatch/prompt-vars.ts`.**

At the top, with the other prompt imports:

```ts
import checksTemplate from "../../prompts/checks.md" with { type: "text" };
```

With the other `*_TEMPLATE` exports:

```ts
export const CHECKS_TEMPLATE = checksTemplate;
```

Append the builder (uses the file-private `detectedStacksVar`):

```ts
/** Prompt vars for the plan-blind `checks:dispatch` author (M2 design §3): the ticket's acceptance
 *  criteria (each by its DB `id`, which the agent echoes as `ac_id`) + the detected stacks/test-commands.
 *  Deliberately NOT the implementation plan — the step is plan-blind. */
export function checksVars(
  ticket: { ident: string; title: string | null },
  profile: Profile,
  acs: { id: number; text: string }[],
): Record<string, string> {
  return {
    ident: ticket.ident,
    title: ticket.title ?? "",
    slug: profile.slug,
    detected_stacks: detectedStacksVar(profile),
    acceptance_criteria: acs.map((a) => `- ac_id=${a.id}: ${a.text}`).join("\n"),
    ...profile.promptVars,
  };
}
```

- [ ] **Step 5: Run it — passes.** `bun test test/dispatch/prompt-vars.test.ts`

- [ ] **Step 6: Commit.**

```
bun run typecheck && bun run lint && bun test test/dispatch/prompt-vars.test.ts
git add prompts/checks.md src/dispatch/prompt-vars.ts test/dispatch/prompt-vars.test.ts
git commit -m "feat(checks): prompts/checks.md + checksVars — the plan-blind builder-of-checks prompt"
```

---

## Task 6: The `checks:dispatch` handler + resolver hoist (the integration)

The one necessarily-larger task: the handler and the resolver flip are mutually dependent for a green
end-to-end test (a step the resolver emits but no handler serves would throw "no handler registered").
Land them together, then fix the loop tests the flip disturbs.

**Files:**
- Modify: `src/dispatch/handlers.ts` (handler + `RegistryDeps.runCheckCommand?`)
- Modify: `src/daemon/resolver.ts` (hoist provision, insert `checks:dispatch`)
- Test: `test/dispatch/checks-handler.test.ts` (new integration test)
- Update: `test/daemon/resolver.test.ts`, `test/daemon/advance.test.ts`,
  `test/dispatch/design-size-e2e.test.ts`, `test/dispatch/design-review-e2e.test.ts`

### 6a — Write the failing integration test first

```ts
// test/dispatch/checks-handler.test.ts
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeAgentRunner } from "../../src/agent/fake-runner.ts";
import { DEFAULT_AGENT_CONFIG } from "../../src/config/agent-config.ts";
import { advanceOneStep } from "../../src/daemon/advance.ts";
import { listByTicket as listAcChecks } from "../../src/db/repos/ac-check.ts";
import { listByTicket as listSignals } from "../../src/db/repos/ground-truth-signal.ts";
import { getByKey } from "../../src/db/repos/workflow-step.ts";
import { insertWorkUnit } from "../../src/db/repos/work-unit.ts";
import { setTicketTrack } from "../../src/db/repos/ticket.ts";
import { buildDispatchRegistry } from "../../src/dispatch/handlers.ts";
import { parseProfile } from "../../src/dispatch/profile.ts";
import { runStep } from "../../src/engine/step-journal.ts";
import { makeTestDb } from "../helpers/db.ts";

function gitRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "styre-ch-"));
  const run = (a: string[]) => Bun.spawnSync(["git", ...a], { cwd: root });
  run(["init", "-b", "main"]);
  run(["config", "user.email", "t@s.dev"]);
  run(["config", "user.name", "T"]);
  writeFileSync(join(root, "README.md"), "x");
  run(["add", "-A"]);
  run(["commit", "-m", "init"]);
  return root;
}

// Drive the loop until it steps `checks:dispatch` (design:dispatch done + a unit + fast track already set).
async function markDesignDone(db: Parameters<typeof runStep>[0], ticketId: number) {
  await runStep(db, {
    ticketId,
    stepKey: "design:dispatch",
    stepType: "dispatch",
    execute: () => ({ ok: true }),
  });
}

test("checks:dispatch authors, verifies identity, runs RED-first, and persists a coarse red", async () => {
  const { db, ticketId, projectId } = makeTestDb();
  const repo = gitRepo();
  db.query("UPDATE project SET target_repo = ? WHERE id = ?").run(repo, projectId);
  // A checklist description → deriveAndPersistAcs yields two ACs.
  db.query("UPDATE ticket SET description = ? WHERE id = ?").run(
    "- [ ] returns ok\n- [ ] rejects bad input\n",
    ticketId,
  );
  // Force the resolver to the design→(provision→checks)→implement seam:
  //   design:dispatch done + one unit + track=fast (skips review) → provision, then checks:dispatch.
  await markDesignDone(db, ticketId);
  insertWorkUnit(db, { ticketId, seq: 1, kind: "python", verifyCheckTypes: ["test"] });
  setTicketTrack(db, ticketId, "fast");

  // The agent authors one NEW test file per AC and returns the sidecar. ac_id = the AC DB ids (1,2).
  const runner = new FakeAgentRunner((input) => {
    const dir = join(input.cwd, "checks");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "ac1.py"), "def test_ac1():\n    assert False\n");
    writeFileSync(join(dir, "ac2.py"), "def test_ac2():\n    assert False\n");
    return {
      completed: true,
      exitCode: 0,
      stdout:
        '```styre-sidecar\n{"checksAuthored":[' +
        '{"ac_id":1,"test_file":"checks/ac1.py","test_name":"test_ac1"},' +
        '{"ac_id":2,"test_file":"checks/ac2.py","test_name":"test_ac2"}' +
        "]}\n```",
      stderr: "",
      timedOut: false,
      costUsd: null,
      tokensIn: null,
      tokensOut: null,
    };
  });

  const registry = buildDispatchRegistry({
    runner,
    agentConfig: DEFAULT_AGENT_CONFIG,
    profile: parseProfile({
      slug: "demo",
      targetRepo: repo,
      components: [{ name: "api", kind: "python", paths: ["**"], commands: { test: "pytest -q" } }],
    }),
    worktreeRoot: mkdtempSync(join(tmpdir(), "styre-chwt-")),
    // Inject the RED-first runner: a failing (red) run for every check (decision 4).
    runCheckCommand: async () => ({ exitCode: 1, stdout: "1 failed", stderr: "", timedOut: false }),
  });

  // The loop collapses design→provision (no prepare → no-op) then steps checks:dispatch.
  let outcome = await advanceOneStep(db, ticketId, registry); // provision
  outcome = await advanceOneStep(db, ticketId, registry); // checks:dispatch
  const checks = listAcChecks(db, ticketId);
  const signals = listSignals(db, ticketId).filter((s) => s.signal_type === "ac-check-red-first");
  const step = getByKey(db, ticketId, "checks:dispatch");
  db.close();

  expect(outcome.kind).toBe("stepped");
  expect(step?.status).toBe("succeeded");
  expect(checks.length).toBe(2);
  expect(checks.every((c) => c.red_first_result === "red")).toBe(true);
  expect(checks.every((c) => c.selector !== "" && c.test_path !== null)).toBe(true);
  // Vocab map (§9): red → fail in ground_truth_signal (never 'red').
  expect(signals.length).toBe(2);
  expect(signals.every((s) => s.result === "fail")).toBe(true);
});

test("checks:dispatch rejects a MODIFIED file (identity: added-only) → postcondition fails", async () => {
  const { db, ticketId, projectId } = makeTestDb();
  const repo = gitRepo();
  db.query("UPDATE project SET target_repo = ? WHERE id = ?").run(repo, projectId);
  db.query("UPDATE ticket SET description = ? WHERE id = ?").run("- [ ] one thing\n", ticketId);
  await markDesignDone(db, ticketId);
  insertWorkUnit(db, { ticketId, seq: 1, kind: "python", verifyCheckTypes: ["test"] });
  setTicketTrack(db, ticketId, "fast");

  // The agent EDITS the pre-existing README.md instead of adding a new file → identity reject.
  const runner = new FakeAgentRunner((input) => {
    writeFileSync(join(input.cwd, "README.md"), "edited\ndef test_x(): pass\n");
    return {
      completed: true,
      exitCode: 0,
      stdout: '```styre-sidecar\n{"checksAuthored":[{"ac_id":1,"test_file":"README.md","test_name":"test_x"}]}\n```',
      stderr: "",
      timedOut: false,
      costUsd: null,
      tokensIn: null,
      tokensOut: null,
    };
  });
  const registry = buildDispatchRegistry({
    runner,
    agentConfig: DEFAULT_AGENT_CONFIG,
    profile: parseProfile({
      slug: "demo",
      targetRepo: repo,
      components: [{ name: "api", kind: "python", paths: ["**"], commands: { test: "pytest -q" } }],
    }),
    worktreeRoot: mkdtempSync(join(tmpdir(), "styre-chwt2-")),
    runCheckCommand: async () => ({ exitCode: 1, stdout: "1 failed", stderr: "", timedOut: false }),
  });
  await advanceOneStep(db, ticketId, registry); // provision
  const outcome = await advanceOneStep(db, ticketId, registry); // checks:dispatch → postcondition fail
  const step = getByKey(db, ticketId, "checks:dispatch");
  const checks = listAcChecks(db, ticketId);
  db.close();
  // No AC covered → postcondition throws → failure-policy (retry/escalate), nothing persisted.
  expect(["retry", "escalated"]).toContain(outcome.kind);
  expect(step?.status).toBe("failed");
  expect(checks.length).toBe(0);
});
```

- [ ] Run it: `bun test test/dispatch/checks-handler.test.ts` → fails (no `checks:dispatch` handler; resolver
  doesn't emit provision/checks in the design seam).

### 6b — Add `RegistryDeps.runCheckCommand` + the handler

In `src/dispatch/handlers.ts`, extend `RegistryDeps` (decision 4):

```ts
export interface RegistryDeps {
  runner: AgentRunner;
  agentConfig: AgentConfig;
  profile: Profile;
  worktreeRoot: string;
  inPlace?: boolean;
  timeoutMs?: number;
  resumeContext?: { stepKey: string; transcript: string };
  /** RED-first check executor override (tests inject a scripted runner; production uses runCommand).
   *  Only `checks:dispatch` reads it (M2b decision 4). */
  runCheckCommand?: import("./reuse.ts").CmdRunner;
}
```

Add the imports the handler needs (top of file, respecting biome import order):

```ts
import { listByTicket as listAcs } from "../db/repos/acceptance-criterion.ts";
import { deleteByTicket, insertAcCheck } from "../db/repos/ac-check.ts";
import {
  binaryFor,
  buildCheckSelector,
  frameworkFor,
  signalResultForCoarse,
  type CoarseResult,
} from "./check-selector.ts";
import { ChecksOutputSchema } from "./checks-schema.ts";
import { runCheckForRed } from "./checks-run.ts";
import { deriveAndPersistAcs } from "./derive-acs.ts";
import { CHECKS_TEMPLATE, checksVars } from "./prompt-vars.ts";
// extend the existing worktree.ts import with: addedFilesAt, fileContentAt
// extend the existing components.ts import with: impactedComponents (already imported)
// resolvePythonInterpreter is already imported from ./provision.ts
```

Register the handler inside `buildDispatchRegistry` (place it after `design:review`):

```ts
  registry.register("checks:dispatch", async (ctx: HandlerContext) => {
    // deriveAndPersistAcs runs HERE, not in the resolver (resolver is pure, §2). Idempotent (§6).
    deriveAndPersistAcs(ctx.db, ctx.ticket.id);
    const acs = listAcs(ctx.db, ctx.ticket.id);
    if (acs.length === 0) return { authored: 0, acs: 0 }; // no ACs → nothing to author (decision 6)
    const acIds = new Set(acs.map((a) => a.id));

    // Dispatch the plan-blind author (no Bash; commits via CL-COMMIT → sha).
    const { sha, output } = await runAgentDispatch(
      ctx,
      depsFor(ctx, deps, deps.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      {
        handlerKey: "checks:dispatch",
        template: CHECKS_TEMPLATE,
        vars: checksVars(ctx.ticket, deps.profile, acs),
        // Identity + coverage are verified below against the committed diff, not on the raw diff here.
        postcondition: () => {},
      },
    );

    // Structured output through the validated interface (§4): absent/malformed = transport failure.
    const parsed = extractSidecar(output, ChecksOutputSchema);
    if (!parsed.ok) {
      throw new Error(`checks:dispatch sidecar ${parsed.reason}: ${parsed.detail}`);
    }

    const { worktreePath } = worktreeFor(ctx, deps);
    const added = new Set(addedFilesAt(sha, worktreePath));
    const components = deps.profile.components;
    const run = deps.runCheckCommand;

    // Per authored check: identity (§5.1) → framework → RED-first execution (§5.3) → coarse (§5.4).
    const records: Array<{
      acId: number;
      selector: string;
      testPath: string;
      coarse: CoarseResult;
      rawOutput: string;
    }> = [];
    const covered = new Set<number>();

    for (const c of parsed.value.checksAuthored) {
      if (!acIds.has(c.ac_id)) continue; // unknown AC id → reject (decision 5)
      if (!added.has(c.test_file)) continue; // not git-status A → reject (§5.1 added-only)
      const content = fileContentAt(sha, c.test_file, worktreePath);
      if (content === null || !content.includes(c.test_name)) continue; // name absent → reject

      const comp = impactedComponents(components, [c.test_file])[0]; // decision 2
      const fw = comp ? frameworkFor(comp) : null;

      let coarse: CoarseResult;
      let selector = c.test_file; // NOT-NULL fallback when no framework (decision 2)
      let rawOutput = "";

      if (!comp || !fw) {
        coarse = "error"; // can't attempt — no framework (§5.2)
      } else {
        let interp: string | undefined;
        if (fw === "pytest") {
          try {
            interp = resolvePythonInterpreter();
          } catch {
            interp = undefined;
          }
        }
        if (fw === "pytest" && interp === undefined) {
          coarse = "error"; // no interpreter → can't attempt
        } else {
          const sel = buildCheckSelector(fw, { testFile: c.test_file, testName: c.test_name });
          selector = sel.runArgs;
          const res = await runCheckForRed({
            framework: fw,
            binary: binaryFor(fw, { interp }),
            runArgs: sel.runArgs,
            cwd: join(worktreePath, comp.dir ?? ""),
            timeoutMs: deps.timeoutMs ?? VERIFY_TIMEOUT_MS,
            run,
          });
          rawOutput = res.rawOutput;
          if (res.coarse === "selected-none") continue; // selects 0 → identity reject (§5.1)
          coarse = res.coarse;
        }
      }
      records.push({ acId: c.ac_id, selector, testPath: c.test_file, coarse, rawOutput });
      covered.add(c.ac_id);
    }

    // Postcondition (§8): ≥1 identity-verified check per AC, else fail (bounded retry / escalate).
    const uncovered = acs.filter((a) => !covered.has(a.id));
    if (uncovered.length > 0) {
      throw new Error(
        `checks:dispatch postcondition: no valid check for AC seq ${uncovered.map((a) => a.seq).join(", ")}`,
      );
    }

    // Persist (§9): delete-then-insert in ONE transaction (resume-dedup, decision 1) + the signal row
    // via the vocab map (never write 'red' into ground_truth_signal).
    ctx.db.transaction(() => {
      deleteByTicket(ctx.db, ctx.ticket.id);
      for (const r of records) {
        const row = insertAcCheck(ctx.db, {
          ticketId: ctx.ticket.id,
          acId: r.acId,
          selector: r.selector,
          testPath: r.testPath,
          redFirstResult: r.coarse,
        });
        insertSignal(ctx.db, {
          ticketId: ctx.ticket.id,
          signalType: "ac-check-red-first",
          result: signalResultForCoarse(r.coarse),
          branchHeadSha: sha,
          detail: { rawOutput: r.rawOutput, acCheckId: row.id },
        });
      }
    })();

    return { authored: records.length, acs: acs.length };
  });
```

> Note: `insertSignal`, `extractSidecar`, `worktreeFor`, `depsFor`, `impactedComponents`,
> `resolvePythonInterpreter`, `DEFAULT_TIMEOUT_MS`, `VERIFY_TIMEOUT_MS` are already imported/defined in
> `handlers.ts`. Extend the existing `./worktree.ts` import with `addedFilesAt, fileContentAt`.

### 6c — Hoist provision + insert `checks:dispatch` in the resolver (stays pure)

In `src/daemon/resolver.ts`, `case "design"`, replace the final `return { kind: "advance", … }` with the
gated chain (design §2):

```ts
      if (ticket.track === "full" && !done(db, ticketId, "design:review")) {
        return step("design:review", "dispatch", "design:review", null);
      }
      // Hoist: provision runs ONCE at design-HEAD (reused by implement — whose provision gates stay,
      // finding it done and skipping; resetProvisionIfManifestTouched still re-arms it, §2).
      if (!done(db, ticketId, "provision")) {
        return step("provision", "provision", "provision", null);
      }
      if (!done(db, ticketId, "checks:dispatch")) {
        return step("checks:dispatch", "dispatch", "checks:dispatch", null);
      }
      return { kind: "advance", from: "design", to: "implement" };
```

- [ ] Run the new integration test: `bun test test/dispatch/checks-handler.test.ts` → passes.

### 6d — Update the loop tests the flip disturbs

Run the full suite and fix the tests that assumed design advanced straight to implement:

```
bun test
```

Expected breakages + fixes:
- **`test/daemon/resolver.test.ts`** — the "design fast-track … advances to implement" test now sees
  `provision` first. Update it to drive `provision` → `checks:dispatch` → advance, e.g.:

  ```ts
  test("design fast-track: units + track=fast → provision, then checks:dispatch, then advance", async () => {
    const { db, ticketId } = makeTestDb();
    await succeed(db, ticketId, "design:dispatch");
    setTicketTrack(db, ticketId, "fast");
    insertWorkUnit(db, { ticketId, seq: 1, kind: "backend", verifyCheckTypes: ["test"] });
    expect(nextStepKey(db, ticketId)).toMatchObject({ stepKey: "provision" });
    await succeed(db, ticketId, "provision");
    expect(nextStepKey(db, ticketId)).toMatchObject({ stepKey: "checks:dispatch" });
    await succeed(db, ticketId, "checks:dispatch");
    expect(nextStepKey(db, ticketId)).toEqual({ kind: "advance", from: "design", to: "implement" });
    db.close();
  });
  ```
  Add a full-track variant that first succeeds `design:review`, then asserts the same provision→checks chain.

- **`test/daemon/advance.test.ts`** — only **"an advance descriptor sets the stage"** breaks: its inline
  `StepRegistry` registers only `design:dispatch`/`design:extract`/`implement:dispatch`, so the hoisted
  `provision`/`checks:dispatch` would throw `"no handler registered"`. Fix: register both + mark them
  succeeded (via `succeed(...)`) so the final `advanceOneStep` collapses design→implement to
  `implement:wu1:dispatch` — marking-succeeded is **necessary** (a registered-but-unrun `provision` would make
  the call return `stepped/provision`, not the implement step). Keep the `implement:wu1:dispatch` assertion.
  *(Do NOT touch "advance + mark-verified" — it seeds at `implement` (`:36`) and never crosses the design
  seam, so the hoist can't break it.)*

- **`test/dispatch/design-size-e2e.test.ts`** and **`test/dispatch/design-review-e2e.test.ts`** — these loop
  `while stage === "design"` and their FakeAgentRunners **throw on any unexpected call**. Their `makeTestDb`
  tickets have a **null description** → `parseAcChecklist(null)` → **0 ACs** → `checks:dispatch` hits the
  decision-6 **0-AC no-op** (`return {authored:0}`) *before* `runAgentDispatch` — **no runner call**; and
  their `kind:"app"` profiles have **no `prepare`** → the hoisted `provision` no-ops (`planProvision` → 0
  actions, no agent). So **change NOTHING in these two except confirm they still pass** (both new steps
  no-op; the ticket still reaches `stage === "implement"`). **Do NOT add a checklist description or a
  `runCheckCommand`** — that would make `checks:dispatch` actually dispatch → an unexpected runner call → the
  throw-on-unexpected runner fails → the step fails → `stage` never reaches `implement`, breaking the core
  assertions. If an iteration budget is tight (they're already 10–15, need ~5+2), bump it by ~2 for the two
  no-op steps; otherwise leave as-is.

- [ ] Re-run the full suite until green: `bun test`

### 6e — Commit

```
bun run typecheck && bun run lint && bun test
git add src/dispatch/handlers.ts src/daemon/resolver.ts test/
git commit -m "feat(checks): checks:dispatch handler + provision hoist — plan-blind RED-first authoring wired into the loop"
```

---

## Task 7: Guard — provision's reset path survives the hoist

The hoist must **preserve** `resetProvisionIfManifestTouched` (§2): a manifest-touching implement diff still
re-arms `provision`. This is already implemented (unchanged in `implement:dispatch`); add a regression test
that pins it now that `provision` is `done` before implement.

**Files:**
- Test: `test/dispatch/checks-provision-reset.test.ts` (new) — or extend an existing provision test.

- [ ] **Step 1: Write the test.**

```ts
// test/dispatch/checks-provision-reset.test.ts
import { expect, test } from "bun:test";
import { getByKey } from "../../src/db/repos/workflow-step.ts";
import { resetProvisionIfManifestTouched } from "../../src/dispatch/provision.ts";
import { runStep } from "../../src/engine/step-journal.ts";
import { makeTestDb } from "../helpers/db.ts";

test("a manifest-touching diff re-arms a hoisted, already-done provision (no redundant re-provision otherwise)", async () => {
  const { db, ticketId } = makeTestDb();
  // Hoisted provision already succeeded at design-HEAD.
  await runStep(db, {
    ticketId,
    stepKey: "provision",
    stepType: "provision",
    execute: () => ({ provisioned: 0 }),
  });
  expect(getByKey(db, ticketId, "provision")?.status).toBe("succeeded");

  // A non-manifest implement diff leaves provision done (no redundant re-provision).
  resetProvisionIfManifestTouched(db, ticketId, ["src/api.py"]);
  expect(getByKey(db, ticketId, "provision")?.status).toBe("succeeded");

  // A dependency-manifest diff re-arms it (resetProvision flips succeeded→pending) → the resolver's
  // implement provision gate will re-run.
  resetProvisionIfManifestTouched(db, ticketId, ["pyproject.toml"]);
  expect(getByKey(db, ticketId, "provision")?.status).toBe("pending");
  db.close();
});
```

> `resetProvisionIfManifestTouched` recognizes `MANIFEST_BASENAMES` in `src/dispatch/provision.ts`
> (`package.json`, `pyproject.toml`, `setup.py`, `Pipfile`, lockfiles, …) — **note `requirements.txt` is
> NOT in the set**, so use `pyproject.toml`/`package.json` for the re-arm case and a plain source file for
> the no-op case. `resetProvision` flips a `succeeded` provision step to `pending`.

- [ ] **Step 2: Run it.** `bun test test/dispatch/checks-provision-reset.test.ts` — should pass immediately
  (the behavior already exists; this guards it against a future "hoist removed the reset" regression). If it
  fails, the reset path was disturbed — restore it.

- [ ] **Step 3: Commit.**

```
bun run typecheck && bun run lint && bun test
git add test/dispatch/checks-provision-reset.test.ts
git commit -m "test(checks): guard that the provision hoist preserves resetProvisionIfManifestTouched"
```

---

## Done-when (M2b acceptance)

- `bun test`, `bun run typecheck`, `bun run lint` all green.
- The resolver emits `provision` then `checks:dispatch` between design and implement, gated by `done()`,
  and stays pure (descriptors only). Implement's provision gates + `resetProvisionIfManifestTouched` are
  intact (Task 7).
- `checks:dispatch` dispatches a **no-Bash** authoring agent (`Read,Grep,Glob,Write,Edit`), tier `standard`.
- `deriveAndPersistAcs` runs inside the handler (idempotent), never in the resolver.
- Identity is enforced: added-file only (`M` rejected), `test_name` present in the committed added file, and
  selector selects ≥1 (`selected-none` → reject). A rejected check does not cover its AC; an AC with no valid
  check fails the postcondition → bounded retry / escalate.
- RED-first runs in the component dir on clean HEAD via `<binary> <runArgs>`, coarse verdict from
  `interpretRunOutput`; no-framework / no-interpreter → coarse `error`.
- Persist is delete-then-insert in one transaction: `ac_check` rows carry the selector + coarse
  `red_first_result`; `ground_truth_signal` rows use `signal_type = "ac-check-red-first"` and the
  `signalResultForCoarse` vocab map (`green→pass, red→fail, error→error`) with full raw output in
  `detail_json`. `'red'` is never written to `ground_truth_signal`.
- No schema change; both `schema.sql` copies untouched.
- The affected loop tests (resolver, advance, design-size-e2e, design-review-e2e) are updated for the new
  steps and pass.

## Not in M2b (deferred, named — design §10)

Graded RED taxonomy + green-on-HEAD adjudication + the re-author loop (M3) · the verify-gate rework /
advisory-demote (M4) · the implement-sees-checks seam · dispositions (M6) · any feature flag
(release-gated inertness). M2 gates nothing.

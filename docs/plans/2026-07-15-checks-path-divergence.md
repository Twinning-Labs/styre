# checks:dispatch path-divergence — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make styre trust the RED-first test the checks agent *actually wrote* (found by its canonical filename in the committed diff) instead of the path it *declared*, so a write-vs-declare divergence stops hard-failing `checks:dispatch`; plus a specific main-path retry message for the residual slips.

**Architecture:** A new pure helper (`check-path.ts`) resolves the authoritative test path from the committed added files by the canonical filename `{ident}_ac{acId}_test.*`, with the declared path as a backward-compat fallback. The scope guard becomes a factory that also admits canonically-named files at any directory. The two author sites in `handlers.ts` (main + re-author) consume the resolver so `ac_check.test_path` is the real path — fixing every downstream reader for free. The main-path uncovered throw carries a specific per-AC message via the existing `error_json`→retry-prefix channel.

**Tech Stack:** TypeScript, Bun (`bun test`), embedded SQLite. No schema change; no gate removed.

**Design doc:** `docs/brainstorms/2026-07-15-checks-path-divergence-design.md` (read it first — it carries the rationale, the independent-review revisions, and the caller-trace refinement).

## Global Constraints

- **No schema change, no gate removed, no new dependency.** All changes live in `src/dispatch/*` (+ tests).
- **Canonical filename convention:** a check test for AC `acId` on ticket `ident` has basename beginning `` `${ident}_ac${acId}_test.` `` — extension-agnostic and multi-dot-tolerant (e.g. `ENG-293_ac1_test.tests.ts`, `ENG-294_ac1_test.py`, `x_ac2_test.go`). Match by `basename.startsWith(base + ".")`, **never** a fixed extension.
- **Three-way path resolution (the core rule), applied at both author sites:** `(a)` the single committed added file matching the canonical basename wins (divergence-proof override); else `(b)` the declared `test_file` if it was committed as an added file (backward-compat: non-canonically-named-but-correct, e.g. Go/Rust); else `(c)` unresolved → the AC is uncovered.
- **Feedback channel = the existing generic `error_json`→`RETRY_FEEDBACK` retry-prefix** (`run-dispatch.ts:65-108`). Do **NOT** use `checksFeedback`/`{{checks_feedback}}`/`loop:"checks"` events — that channel cross-wires re-author AC scoping (design C1/C2). No `checksVars` change.
- **Re-author path keeps its `"rejected"` contract** — do NOT convert it to a throw (it feeds the `checks:reauthor` escalate counter). It gets the structural reconcile only.
- **Backward compatibility is mandatory:** when the agent writes == declares (canonical or not), behavior is identical to today.
- **Commit footer:** end every commit message with `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.
- **Branch:** work is on `fix/eng-296-checks-path-divergence` (already created off `origin/main`; the design doc is already committed there).

## File Structure

- **Create `src/dispatch/check-path.ts`** — pure helpers: `canonicalCheckBase`, `isCanonicalCheckPath`, `matchAuthoredTest`, `resolveAuthoredTestPath`. One responsibility: mapping (ident, acId, committed files, declared path) → the authoritative test path. No I/O.
- **Create `test/dispatch/check-path.test.ts`** — pure unit tests for the above.
- **Modify `src/dispatch/commit-scope.ts`** — replace `checksScope` with a `checksScopeFor(ident, acIds)` factory that also admits canonically-named new files.
- **Modify `test/dispatch/commit-scope.test.ts`** — update the two `checksScope` tests to `checksScopeFor` + add a canonical-name case.
- **Modify `src/dispatch/handlers.ts`** — main `checks:dispatch` body (~544–660) and `reauthorCheckWrong` (~236–316): consume the resolver; rewire both `commitScope:` sites to `checksScopeFor`; specific main-path uncovered message.
- **Modify `test/dispatch/checks-handler.test.ts`** — integration coverage of divergence (main path) via `FakeAgentRunner`.

---

### Task 1: `check-path.ts` — canonical-filename resolver (pure)

**Files:**
- Create: `src/dispatch/check-path.ts`
- Test: `test/dispatch/check-path.test.ts`

**Interfaces:**
- Consumes: nothing (pure, stdlib only).
- Produces:
  - `canonicalCheckBase(ident: string, acId: number): string` → `` `${ident}_ac${acId}_test` ``
  - `isCanonicalCheckPath(path: string, ident: string, acIds: Iterable<number>): boolean`
  - `matchAuthoredTest(addedPaths: string[], ident: string, acId: number): string | null` — the single added path whose basename starts with `` `${canonicalCheckBase(ident, acId)}.` ``; `null` on 0 or ≥2 matches.
  - `resolveAuthoredTestPath(addedPaths: string[], ident: string, acId: number, declaredTestFile: string): string | null` — `matchAuthoredTest(...)` else (`declaredTestFile` ∈ `addedPaths` ? `declaredTestFile` : `null`).

- [ ] **Step 1: Write the failing tests**

Create `test/dispatch/check-path.test.ts`:

```ts
import { expect, test } from "bun:test";
import {
  canonicalCheckBase,
  isCanonicalCheckPath,
  matchAuthoredTest,
  resolveAuthoredTestPath,
} from "../../src/dispatch/check-path.ts";

test("canonicalCheckBase composes ident + acId", () => {
  expect(canonicalCheckBase("ENG-294", 1)).toBe("ENG-294_ac1_test");
});

test("matchAuthoredTest finds the canonical file under any directory, extension-agnostic", () => {
  const added = [
    "astropy/modeling/tests/styre_checks/ENG-294_ac1_test.py",
    "astropy/other.py",
  ];
  expect(matchAuthoredTest(added, "ENG-294", 1)).toBe(
    "astropy/modeling/tests/styre_checks/ENG-294_ac1_test.py",
  );
  // multi-dot extension (darkreader shape)
  expect(matchAuthoredTest(["a/b/ENG-293_ac1_test.tests.ts"], "ENG-293", 1)).toBe(
    "a/b/ENG-293_ac1_test.tests.ts",
  );
});

test("matchAuthoredTest returns null when absent, and does not confuse ac1 with ac10", () => {
  expect(matchAuthoredTest(["tests/foo_test.py"], "ENG-294", 1)).toBeNull();
  expect(matchAuthoredTest(["t/ENG-1_ac10_test.py"], "ENG-1", 1)).toBeNull();
});

test("matchAuthoredTest returns null on ambiguity (two canonical matches)", () => {
  const added = ["a/ENG-1_ac1_test.py", "b/ENG-1_ac1_test.py"];
  expect(matchAuthoredTest(added, "ENG-1", 1)).toBeNull();
});

test("isCanonicalCheckPath matches for any acId in the set, else false", () => {
  expect(isCanonicalCheckPath("x/ENG-1_ac2_test.go", "ENG-1", [1, 2])).toBe(true);
  expect(isCanonicalCheckPath("x/ENG-1_ac3_test.go", "ENG-1", [1, 2])).toBe(false);
  expect(isCanonicalCheckPath("x/random.go", "ENG-1", [1, 2])).toBe(false);
});

test("resolveAuthoredTestPath: (a) canonical override wins over a wrong declared path", () => {
  const added = ["tests/styre_checks/ENG-294_ac1_test.py"];
  expect(
    resolveAuthoredTestPath(added, "ENG-294", 1, "tests/ENG-294_ac1_test.py"),
  ).toBe("tests/styre_checks/ENG-294_ac1_test.py");
});

test("resolveAuthoredTestPath: (b) falls back to a correctly-declared non-canonical file", () => {
  const added = ["pkg/separable_test.go"];
  expect(resolveAuthoredTestPath(added, "ENG-1", 1, "pkg/separable_test.go")).toBe(
    "pkg/separable_test.go",
  );
});

test("resolveAuthoredTestPath: (c) null when neither canonical nor declared-added", () => {
  const added = ["pkg/unrelated.go"];
  expect(resolveAuthoredTestPath(added, "ENG-1", 1, "pkg/missing_test.go")).toBeNull();
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd /Users/rajatgoyal/code/styre/.claude/worktrees/fix+checks-red-first && bun test test/dispatch/check-path.test.ts`
Expected: FAIL — `Cannot find module '../../src/dispatch/check-path.ts'`.

- [ ] **Step 3: Write the implementation**

Create `src/dispatch/check-path.ts`:

```ts
/** Canonical RED-first check filenames tie a committed test file to one AC by its BASENAME —
 *  `{ident}_ac{acId}_test.{ext}` (prompts/checks.md) — independent of directory. The runner resolves
 *  the authoritative test path from what the agent actually committed, not from the path it declared
 *  (ENG-296: write-vs-declare divergence). Pure; no I/O. */

/** The extension-less canonical basename for a check test, e.g. `ENG-294_ac1_test`. */
export function canonicalCheckBase(ident: string, acId: number): string {
  return `${ident}_ac${acId}_test`;
}

/** The last path segment (git paths are always forward-slash). */
function basename(path: string): string {
  const parts = path.split("/");
  return parts[parts.length - 1] ?? path;
}

/** True iff `path`'s basename is the canonical check filename for SOME acId in `acIds`. Matches any
 *  extension (single or multi-dot) by requiring the basename to start with `${base}.`. */
export function isCanonicalCheckPath(
  path: string,
  ident: string,
  acIds: Iterable<number>,
): boolean {
  const b = basename(path);
  for (const acId of acIds) {
    if (b.startsWith(`${canonicalCheckBase(ident, acId)}.`)) return true;
  }
  return false;
}

/** The single committed added path whose basename is the canonical check filename for `acId`.
 *  `null` when zero match OR ≥2 match (ambiguous → caller falls back / reports uncovered). */
export function matchAuthoredTest(
  addedPaths: string[],
  ident: string,
  acId: number,
): string | null {
  const prefix = `${canonicalCheckBase(ident, acId)}.`;
  const hits = addedPaths.filter((p) => basename(p).startsWith(prefix));
  return hits.length === 1 ? hits[0]! : null;
}

/** The authoritative test path for `acId`: (a) the canonically-named committed file (divergence-proof
 *  override); else (b) the declared path if it was itself committed (backward-compat for non-canonical
 *  names, e.g. Go/Rust module files); else (c) `null` (uncovered). */
export function resolveAuthoredTestPath(
  addedPaths: string[],
  ident: string,
  acId: number,
  declaredTestFile: string,
): string | null {
  const canonical = matchAuthoredTest(addedPaths, ident, acId);
  if (canonical !== null) return canonical;
  if (addedPaths.includes(declaredTestFile)) return declaredTestFile;
  return null;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd /Users/rajatgoyal/code/styre/.claude/worktrees/fix+checks-red-first && bun test test/dispatch/check-path.test.ts`
Expected: PASS — 8/8.

- [ ] **Step 5: Commit**

```bash
cd /Users/rajatgoyal/code/styre/.claude/worktrees/fix+checks-red-first
git add src/dispatch/check-path.ts test/dispatch/check-path.test.ts
git commit -F - <<'EOF'
feat(checks): canonical-filename test-path resolver (ENG-296)

Pure helper mapping (ident, acId, committed added files, declared path) to the
authoritative RED-first test path by the canonical basename
`{ident}_ac{acId}_test.*` (extension-agnostic), with the declared path as a
backward-compat fallback. Foundation for making styre trust the file the agent
actually wrote instead of the path it declared.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
```

---

### Task 2: `checksScopeFor` — scope guard admits canonically-named tests

**Files:**
- Modify: `src/dispatch/commit-scope.ts:21-32` (replace `checksScope`)
- Modify: `src/dispatch/handlers.ts:250,566` (rewire the two `commitScope:` sites)
- Test: `test/dispatch/commit-scope.test.ts:25-41` (update the two `checksScope` tests)

**Interfaces:**
- Consumes: `isCanonicalCheckPath` (Task 1).
- Produces: `checksScopeFor(ident: string, acIds: number[]): CommitScope` (replaces the `checksScope` const export).

- [ ] **Step 1: Update the failing tests**

In `test/dispatch/commit-scope.test.ts`: change the import (lines 2–7) to import `checksScopeFor` instead of `checksScope`:

```ts
import {
  checksScopeFor,
  docScope,
  implementScope,
  planScope,
} from "../../src/dispatch/commit-scope.ts";
```

Replace the two `checksScope` tests (lines 25–41) with:

```ts
test("checksScopeFor: authored test_file allowed; extra new_files helper allowed; undeclared rejected", () => {
  const inScope = checksScopeFor("ENG-1", [1])(
    sidecar({
      checksAuthored: [{ ac_id: 1, test_file: "tests/test_x.py", test_name: "test_x" }],
      new_files: ["tests/conftest.py"],
    }),
  );
  expect(inScope("tests/test_x.py", true)).toBe(true);
  expect(inScope("tests/conftest.py", true)).toBe(true);
  expect(inScope("scratch.py", true)).toBe(false);
});

test("checksScopeFor: a canonically-named test at an UNDECLARED dir is in scope (divergence)", () => {
  const inScope = checksScopeFor("ENG-294", [1])(
    sidecar({
      // agent DECLARED a flat path but WROTE under styre_checks/ — the written file is undeclared
      checksAuthored: [
        { ac_id: 1, test_file: "tests/ENG-294_ac1_test.py", test_name: "test_bug" },
      ],
    }),
  );
  expect(inScope("tests/styre_checks/ENG-294_ac1_test.py", true)).toBe(true); // canonical name → admitted
  expect(inScope("tests/reproduce_bug.py", true)).toBe(false); // scratch → still rejected
});

test("checksScopeFor: unparseable sidecar → DEFERS (allows everything) so the handler decides", () => {
  const inScope = checksScopeFor("ENG-1", [1])("no sidecar");
  expect(inScope("anything.py", true)).toBe(true);
  expect(inScope("tests/test_x.py", true)).toBe(true);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd /Users/rajatgoyal/code/styre/.claude/worktrees/fix+checks-red-first && bun test test/dispatch/commit-scope.test.ts`
Expected: FAIL — `checksScopeFor` is not exported (import error / not a function).

- [ ] **Step 3: Replace `checksScope` with the factory**

In `src/dispatch/commit-scope.ts`, add the import at the top (after line 1's existing import):

```ts
import { isCanonicalCheckPath } from "./check-path.ts";
```

Replace the `checksScope` export (lines 21–32) with:

```ts
/** checks: tracked edits in scope; a NEW file must be an authored test_file, a declared helper, OR a
 *  canonically-named RED-first test (`{ident}_ac{acId}_test.*`) for an in-scope AC — the last clause
 *  admits the file the agent actually wrote even when it declared a different path (ENG-296). Scratch
 *  files stay out of scope (reject-and-retry). On an UNPARSEABLE sidecar the scope DEFERS (allows
 *  everything) so the two call sites keep their existing post-commit failure semantics. */
export function checksScopeFor(ident: string, acIds: number[]): CommitScope {
  return (output) => {
    const parsed = extractSidecar(output, ChecksOutputSchema);
    if (!parsed.ok) return () => true;
    const declared = new Set<string>([
      ...parsed.value.checksAuthored.map((c) => norm(c.test_file)),
      ...parsed.value.new_files.map(norm),
    ]);
    return (path, isNew) =>
      !isNew || declared.has(norm(path)) || isCanonicalCheckPath(norm(path), ident, acIds);
  };
}
```

In `src/dispatch/handlers.ts`, rewire the two `commitScope: checksScope` sites:
- Line 566 (main dispatch — `acIds` is the `Set<number>` built at line 543, `ctx.ticket.ident` is the ident):

```ts
      commitScope: checksScopeFor(ctx.ticket.ident, [...acIds]),
```

- Line 250 (re-author dispatch — single AC `ac.id`):

```ts
      commitScope: checksScopeFor(ctx.ticket.ident, [ac.id]),
```

- Update the import in `handlers.ts`: wherever `checksScope` is imported from `./commit-scope.ts`, change it to `checksScopeFor`.

- [ ] **Step 4: Run the focused tests, then typecheck + full suite**

Run: `cd /Users/rajatgoyal/code/styre/.claude/worktrees/fix+checks-red-first && bun test test/dispatch/commit-scope.test.ts`
Expected: PASS — including the two new divergence assertions.

Run: `cd /Users/rajatgoyal/code/styre/.claude/worktrees/fix+checks-red-first && bunx tsc --noEmit`
Expected: no errors (confirms both `handlers.ts` call sites compile with the new signature and the old `checksScope` import is gone).

Run: `cd /Users/rajatgoyal/code/styre/.claude/worktrees/fix+checks-red-first && bun test test/dispatch/`
Expected: PASS — no regressions (the handler still passes a `CommitScope` to `runAgentDispatch`).

- [ ] **Step 5: Commit**

```bash
cd /Users/rajatgoyal/code/styre/.claude/worktrees/fix+checks-red-first
git add src/dispatch/commit-scope.ts src/dispatch/handlers.ts test/dispatch/commit-scope.test.ts
git commit -F - <<'EOF'
feat(checks): scope guard admits canonically-named tests (ENG-296)

Replace `checksScope` with `checksScopeFor(ident, acIds)`: a new file is in
scope if declared OR its basename is the canonical `{ident}_ac{acId}_test.*`
for an in-scope AC. This stops the scope guard from rejecting the RED-first
test the agent actually wrote when it declared a different path. Scratch files
remain out of scope. Wired at both checks:dispatch commitScope sites.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
```

---

### Task 3: main-path reconcile + specific uncovered message

**Files:**
- Modify: `src/dispatch/handlers.ts:543-660` (the main `checks:dispatch` per-AC loop + uncovered throw)
- Test: `test/dispatch/checks-handler.test.ts` (add divergence + backward-compat integration tests)

**Interfaces:**
- Consumes: `resolveAuthoredTestPath` (Task 1); `checksScopeFor` already wired (Task 2).
- Produces: no new export. `ac_check.test_path` is now the resolved real path; the uncovered throw message is specific.

- [ ] **Step 1: Write the failing integration tests**

Add to `test/dispatch/checks-handler.test.ts` (it already imports `FakeAgentRunner`, `gitRepo`, `makeTestDb`, `buildDispatchRegistry`, `parseProfile`, `runStep`, `advanceOneStep`, `getByKey`, `listAcChecks`, `markDesignDone`, `insertWorkUnit`, `setTicketTrack` — no new imports needed). **`advanceOneStep`'s real signature is `(db, ticketId, registry)`** — mind the arg order. Model the two tests on the existing "authors, verifies identity…" test (lines 48–~110): set a one-item checklist description so `deriveAndPersistAcs` yields ONE AC, drive to `checks:dispatch`, script the agent, then advance and assert. The AC DB id and the ticket ident come from the db — fetch them:

```ts
test("checks:dispatch reconciles a divergent path: written under styre_checks/, declared flat → ac_check.test_path is the REAL written path", async () => {
  const { db, ticketId, projectId } = makeTestDb();
  const repo = gitRepo();
  db.query("UPDATE project SET target_repo = ? WHERE id = ?").run(repo, projectId);
  db.query("UPDATE ticket SET description = ? WHERE id = ?").run("- [ ] bug no longer reproduces\n", ticketId);
  await markDesignDone(db, ticketId);
  insertWorkUnit(db, { ticketId, seq: 1, kind: "python", verifyCheckTypes: ["test"] });
  setTicketTrack(db, ticketId, "fast");

  const ident = (db.query("SELECT ident FROM ticket WHERE id = ?").get(ticketId) as { ident: string }).ident;
  const acId = (db.query("SELECT id FROM acceptance_criterion WHERE ticket_id = ? ORDER BY seq LIMIT 1").get(ticketId) as { id: number }).id;

  const runner = new FakeAgentRunner((input) => {
    const dir = join(input.cwd, "tests", "styre_checks");
    mkdirSync(dir, { recursive: true });
    // WROTE the canonical name under styre_checks/, but DECLARE a flat, different path.
    writeFileSync(join(dir, `${ident}_ac${acId}_test.py`), "def test_bug():\n    assert False\n");
    return {
      completed: true,
      exitCode: 0,
      stdout:
        '```styre-sidecar\n{"checksAuthored":[' +
        `{"ac_id":${acId},"test_file":"tests/${ident}_ac${acId}_test.py","test_name":"test_bug"}` +
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
    runCheckCommand: async () => ({ exitCode: 1, stdout: "1 failed", stderr: "", timedOut: false }),
  });

  // Drive until checks:dispatch resolves (correct arg order: db, ticketId, registry). Stop on its
  // status so we don't over-advance into checks:classify/implement.
  for (let i = 0; i < 12; i++) {
    await advanceOneStep(db, ticketId, registry);
    if (getByKey(db, ticketId, "checks:dispatch")?.status === "succeeded") break;
  }

  const checks = listAcChecks(db, ticketId);
  expect(checks.length).toBe(1);
  expect(checks[0]!.test_path).toBe(`tests/styre_checks/${ident}_ac${acId}_test.py`); // REAL written path, not declared
});

test("checks:dispatch backward-compat: non-canonical name declared correctly still works (no regression)", async () => {
  const { db, ticketId, projectId } = makeTestDb();
  const repo = gitRepo();
  db.query("UPDATE project SET target_repo = ? WHERE id = ?").run(repo, projectId);
  db.query("UPDATE ticket SET description = ? WHERE id = ?").run("- [ ] bug no longer reproduces\n", ticketId);
  await markDesignDone(db, ticketId);
  insertWorkUnit(db, { ticketId, seq: 1, kind: "python", verifyCheckTypes: ["test"] });
  setTicketTrack(db, ticketId, "fast");
  const acId = (db.query("SELECT id FROM acceptance_criterion WHERE ticket_id = ? ORDER BY seq LIMIT 1").get(ticketId) as { id: number }).id;

  const runner = new FakeAgentRunner((input) => {
    const dir = join(input.cwd, "tests");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "regression_x.py"), "def test_x():\n    assert False\n"); // NON-canonical name
    return {
      completed: true,
      exitCode: 0,
      stdout:
        '```styre-sidecar\n{"checksAuthored":[' +
        `{"ac_id":${acId},"test_file":"tests/regression_x.py","test_name":"test_x"}` + // declared == written
        "]}\n```",
      stderr: "", timedOut: false, costUsd: null, tokensIn: null, tokensOut: null,
    };
  });

  const registry = buildDispatchRegistry({
    runner, agentConfig: DEFAULT_AGENT_CONFIG,
    profile: parseProfile({
      slug: "demo", targetRepo: repo,
      components: [{ name: "api", kind: "python", paths: ["**"], commands: { test: "pytest -q" } }],
    }),
    worktreeRoot: mkdtempSync(join(tmpdir(), "styre-chwt-")),
    runCheckCommand: async () => ({ exitCode: 1, stdout: "1 failed", stderr: "", timedOut: false }),
  });
  for (let i = 0; i < 12; i++) {
    await advanceOneStep(db, ticketId, registry);
    if (getByKey(db, ticketId, "checks:dispatch")?.status === "succeeded") break;
  }

  const checks = listAcChecks(db, ticketId);
  expect(checks.length).toBe(1);
  expect(checks[0]!.test_path).toBe("tests/regression_x.py"); // fallback (b): declared path honored
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd /Users/rajatgoyal/code/styre/.claude/worktrees/fix+checks-red-first && bun test test/dispatch/checks-handler.test.ts`
Expected: FAIL — the divergence test fails because today `!added.has(c.test_file)` (declared `tests/…` ≠ written `tests/styre_checks/…`) makes the AC uncovered → the dispatch throws/rejects, so no `ac_check` row with the real path. (The backward-compat test may already pass; the divergence test must fail before Step 3.)

- [ ] **Step 3: Reconcile the main-path loop + specific message**

In `src/dispatch/handlers.ts`, add the import (with the other `./` dispatch imports near the top):

```ts
import { resolveAuthoredTestPath } from "./check-path.ts";
```

Just before the per-AC loop, capture the added files as an array and the ident, and a miss-reason map. Replace line 578 `const added = new Set(addedFilesAt(sha, worktreePath));` with (note: the old `added` Set is no longer used after the loop rewrite below — do NOT keep it, or `noUnusedLocals` fails):

```ts
      const addedArr = addedFilesAt(sha, worktreePath);
      const ident = ctx.ticket.ident;
      const missReason = new Map<number, string>(); // ac.id → why it was uncovered (specific retry msg)
```

Replace the loop body's identity/path section — lines 595–599:

```ts
      for (const c of parsed.value.checksAuthored) {
        if (!acIds.has(c.ac_id)) continue; // unknown AC id → reject (decision 5)
        if (!added.has(c.test_file)) continue; // not git-status A → reject (§5.1 added-only)
        const content = fileContentAt(sha, c.test_file, worktreePath);
        if (content === null || !content.includes(c.test_name)) continue; // name absent → reject
```

with (resolve the real path; record a specific miss reason on each `continue`):

```ts
      for (const c of parsed.value.checksAuthored) {
        if (!acIds.has(c.ac_id)) continue; // unknown AC id → reject (decision 5)
        // ENG-296: trust the file actually committed (canonical basename), not the declared path;
        // fall back to the declared path when it was itself committed (non-canonical-but-correct).
        const testPath = resolveAuthoredTestPath(addedArr, ident, c.ac_id, c.test_file);
        if (testPath === null) {
          missReason.set(
            c.ac_id,
            `no check test named \`${ident}_ac${c.ac_id}_test.*\` was committed, and your declared test_file \`${c.test_file}\` wasn't created either — save the RED-first test with exactly that filename`,
          );
          continue;
        }
        const content = fileContentAt(sha, testPath, worktreePath);
        if (content === null || !content.includes(c.test_name)) {
          missReason.set(
            c.ac_id,
            `\`${testPath}\` does not contain a test named \`${c.test_name}\``,
          );
          continue; // name absent → reject
        }
```

Then in the remainder of the loop body (lines 601–644), replace every `c.test_file` with `testPath`:
- `const comp = impactedComponents(components, [testPath])[0];`
- `let selector = testPath;`
- `const sel = buildCheckSelector(fw, { testFile: testPath, testName: c.test_name });`
- `testPath: testPath,` in the `records.push({ ... })` (the object key stays `testPath`; its value becomes the local `testPath`).

Also give the `selected-none` reject a specific reason so its uncovered AC gets an actionable message (it otherwise falls to the generic default). Replace line ~637 `if (res.coarse === "selected-none") continue;` with:

```ts
            if (res.coarse === "selected-none") {
              missReason.set(c.ac_id, `the selector for \`${testPath}\` matched no test`);
              continue; // selects 0 → identity reject (§5.1)
            }
```

Replace the uncovered postcondition throw (lines 654–659) with a specific per-AC message:

```ts
      // Postcondition (§8): ≥1 identity-verified check per AC, else fail (bounded retry / escalate).
      // ENG-296: name the specific reason per uncovered AC so the retry-prefix informs the re-dispatch.
      const uncovered = acs.filter((a) => !covered.has(a.id));
      if (uncovered.length > 0) {
        const detail = uncovered
          .map((a) => `AC ${a.seq}: ${missReason.get(a.id) ?? "no valid check authored for this AC"}`)
          .join("; ");
        throw new Error(`checks:dispatch postcondition: ${detail}`);
      }
```

- [ ] **Step 4: Run the tests to verify they pass, then typecheck + full suite**

Run: `cd /Users/rajatgoyal/code/styre/.claude/worktrees/fix+checks-red-first && bun test test/dispatch/checks-handler.test.ts`
Expected: PASS — both new tests green; the divergence test's `ac_check.test_path` is the real `tests/styre_checks/…` path; the existing checks-handler tests still pass (they declare == write, so branch (b)/(a) both resolve to the same path).

Run: `cd /Users/rajatgoyal/code/styre/.claude/worktrees/fix+checks-red-first && bunx tsc --noEmit`
Expected: no errors.

Run: `cd /Users/rajatgoyal/code/styre/.claude/worktrees/fix+checks-red-first && bun test test/dispatch/`
Expected: PASS — no regressions.

- [ ] **Step 5: Commit**

```bash
cd /Users/rajatgoyal/code/styre/.claude/worktrees/fix+checks-red-first
git add src/dispatch/handlers.ts test/dispatch/checks-handler.test.ts
git commit -F - <<'EOF'
fix(checks): main-path reconcile of authored test path + specific retry msg (ENG-296)

The main checks:dispatch loop now resolves each AC's test path from the file
actually committed (canonical `{ident}_ac{acId}_test.*`), falling back to the
declared path when it was itself committed — so a write-vs-declare divergence
sets ac_check.test_path to the REAL path instead of failing the AC as
uncovered. The uncovered-postcondition throw now carries a specific per-AC
reason (misnamed/not-committed vs wrong test_name), surfaced verbatim on the
next attempt via the existing error_json retry-prefix. Downstream
(freeze/replay/re-run/selectors) inherit the correct path for free.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
```

---

### Task 4: re-author-path reconcile (structural; keeps fail-closed contract)

**Files:**
- Modify: `src/dispatch/handlers.ts:254-316` (`reauthorCheckWrong`)
- Test: `test/dispatch/checks-handler.test.ts` or `test/dispatch/checks-reauthor-e2e.test.ts` (a divergent re-author now installs)

**Interfaces:**
- Consumes: `resolveAuthoredTestPath` (Task 1, already imported in `handlers.ts` by Task 3).
- Produces: no new export. The re-author uses the resolved real path; its `"installed" | "rejected"` contract is unchanged (no throw).

- [ ] **Step 1: Write the failing test**

Add a test that drives a check-wrong re-author where the re-author agent writes the canonical file under a divergent directory while declaring a flat path, and assert the re-authored `ac_check.test_path` is the real written path (i.e. it **installed**, not rejected). Follow the existing `test/dispatch/checks-reauthor-e2e.test.ts` setup for routing a check-wrong AC into `checks:reauthor`; script the `FakeAgentRunner` re-author dispatch to:

```ts
// inside the re-author FakeAgentRunner callback (input.cwd = worktree):
const dir = join(input.cwd, "tests", "styre_checks");
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, `${ident}_ac${acId}_test.py`), "def test_re():\n    assert False\n");
// declare a DIFFERENT (flat) path in the sidecar:
//   {"checksAuthored":[{"ac_id":<acId>,"test_file":"tests/<ident>_ac<acId>_test.py","test_name":"test_re"}]}
```

Assert after the `checks:reauthor` step: the AC's active check row has `test_path === \`tests/styre_checks/${ident}_ac${acId}_test.py\`` and the `ac-check-reauthor` signal `result === "pass"` (installed), i.e. the divergence no longer causes a rejection.

(Match the exact routing/fixtures of `checks-reauthor-e2e.test.ts`; the reusable helpers there — building a check-wrong generation and a `latestReauthorRoute` — are the harness. If that file's scaffolding is heavy, add the test there next to its siblings rather than re-deriving it in `checks-handler.test.ts`.)

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd /Users/rajatgoyal/code/styre/.claude/worktrees/fix+checks-red-first && bun test test/dispatch/checks-reauthor-e2e.test.ts`
Expected: FAIL — today `handlers.ts:260` `addedFilesAt(reauthorSha).has(authored.test_file)` misses (declared flat ≠ written `styre_checks/`) → `return "rejected"` → the signal is `fail` and the old check stays active, so the asserted install/real-path does not happen.

- [ ] **Step 3: Reconcile the re-author path**

In `reauthorCheckWrong` (`src/dispatch/handlers.ts`), after `const authored = ...; if (!authored) return "rejected";` (lines 256–257), resolve the real path once and thread it through. Replace lines 259–262:

```ts
  // 2) Identity: added file + the test name present in the committed content.
  if (!new Set(addedFilesAt(reauthorSha, worktreePath)).has(authored.test_file)) return "rejected";
  const content = fileContentAt(reauthorSha, authored.test_file, worktreePath);
  if (content === null || !content.includes(authored.test_name)) return "rejected";
```

with (resolve via the canonical file actually committed; fail closed as today if unresolvable):

```ts
  // 2) Identity: resolve the real committed test path (ENG-296: trust what was written, not declared),
  //    then require the test name present in that file. Unresolvable/name-absent stays fail-closed
  //    ("rejected" is a designed disposition feeding the escalate counter — never a throw here).
  const testPath = resolveAuthoredTestPath(
    addedFilesAt(reauthorSha, worktreePath),
    ctx.ticket.ident,
    acId,
    authored.test_file,
  );
  if (testPath === null) return "rejected";
  const content = fileContentAt(reauthorSha, testPath, worktreePath);
  if (content === null || !content.includes(authored.test_name)) return "rejected";
```

Then replace every remaining `authored.test_file` in `reauthorCheckWrong` (lines 269, 281, 291, 295, 304) with `testPath`:
- `testFile: testPath,` (the `replayCheckAtBaseline` call, line 269)
- `testPath: testPath,` (the `adjudicateOne` call, line 281 — key stays `testPath`)
- `impactedComponents(deps.profile.components, [testPath])[0]` (line 291)
- `buildCheckSelector(installFw, { testFile: testPath, testName: authored.test_name })` (line 295)
- `testPath: testPath,` in the `insertAcCheck({ ... })` (line 304)

Leave `authored.test_name` untouched everywhere. Leave all other `return "rejected"` statements (baselineSha null, replay ≠ red, classification, install failure) exactly as they are — those are oracle verdicts, not path slips.

- [ ] **Step 4: Run the test to verify it passes, then typecheck + full suite**

Run: `cd /Users/rajatgoyal/code/styre/.claude/worktrees/fix+checks-red-first && bun test test/dispatch/checks-reauthor-e2e.test.ts`
Expected: PASS — the divergent re-author installs; `ac_check.test_path` is the real `styre_checks/` path; the `ac-check-reauthor` signal is `pass`.

Run: `cd /Users/rajatgoyal/code/styre/.claude/worktrees/fix+checks-red-first && bunx tsc --noEmit`
Expected: no errors.

Run: `cd /Users/rajatgoyal/code/styre/.claude/worktrees/fix+checks-red-first && bun test`
Expected: PASS — full suite, no regressions.

- [ ] **Step 5: Commit**

```bash
cd /Users/rajatgoyal/code/styre/.claude/worktrees/fix+checks-red-first
git add src/dispatch/handlers.ts test/dispatch/checks-reauthor-e2e.test.ts
git commit -F - <<'EOF'
fix(checks): reconcile re-author test path (structural) (ENG-296)

reauthorCheckWrong now resolves the real committed test path (canonical
basename, with declared-path fallback) instead of trusting the declared path,
so a write-vs-declare divergence in a check-wrong re-author installs against the
real file instead of rejecting. Threads the resolved path through identity,
replay overlay, adjudicate, selector, and insertAcCheck. The "rejected" return
contract is unchanged (it is a fail-closed disposition feeding the checks:reauthor
escalate counter — never a throw), so a genuinely-unresolvable re-author still
fails closed exactly as before.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
```

---

## Self-Review

**1. Spec coverage.**
- Structural "trust what was saved" (design Components 1–2) → Task 1 (`resolveAuthoredTestPath`) + Task 2 (scope) + Task 3 (main wiring) + Task 4 (re-author wiring). ✓
- Declared-path fallback / no non-canonical regression (review I1) → `resolveAuthoredTestPath` branch (b), Task 1 test + Task 3 backward-compat test. ✓
- Feedback on the `error_json` retry-prefix, main-path only, specific message (design Component 3, C1/C2) → Task 3 uncovered throw + `missReason`. ✓
- Re-author keeps `"rejected"` (caller-trace refinement) → Task 4 leaves the contract, reconcile only. ✓
- Downstream "fixed for free" via `ac_check.test_path` → Tasks 3/4 set `testPath` into `insertAcCheck`; no downstream edits. ✓
- Scratch-file feedback rides the existing generic scope message → no code; Task 2 keeps scratch out of scope. ✓
- darkreader/astropy (AC#4) → Task 3 divergence test = the astropy class; existing declare==write tests = darkreader class. ✓

**2. Placeholder scan.** No TBD/vague steps. Task 4's Step 1 references `checks-reauthor-e2e.test.ts`'s existing scaffolding rather than reproducing its full routing — that file exists and is the correct harness; the divergence-specific scripting and assertion are given explicitly. Every code step shows the code and the exact command + expected output.

**3. Type consistency.** `resolveAuthoredTestPath(addedPaths: string[], ident, acId, declaredTestFile)` and `checksScopeFor(ident: string, acIds: number[])` are used with matching signatures across Tasks 2–4. `ident = ctx.ticket.ident`, `acIds` from the `Set<number>` at `handlers.ts:543` (spread to an array at the call site), `addedArr = addedFilesAt(...)`. The `records[].testPath` object key is unchanged; only its value source changes. `matchAuthoredTest`/`isCanonicalCheckPath` names are identical between Task 1's definition and Tasks 2–3's consumption.

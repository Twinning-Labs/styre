# ENG-323 — admit legitimate `styre_checks/` support files — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the `checks:dispatch` commit scope guard admit a legitimate support file (e.g. Python `__init__.py`/`conftest.py`) the checks agent writes into a `styre_checks/` directory next to its canonical RED-first test, so a correct package marker no longer escalates the ticket.

**Architecture:** A pure `isCheckSupportFile` helper in `check-path.ts` implements a 4-part deterministic rule (in a `styre_checks/` dir + co-located with a canonical check this dispatch adds + same extension + within a per-dir cap). `checksScopeFor` gains one admission clause that calls it; the `CommitScope` predicate is widened with an **optional** `newPaths` param so the guard can see sibling files; `run-dispatch` passes the dispatch's new-file set at the single call site. The guard's reject-not-drop semantics and all other scopes are unchanged.

**Tech Stack:** TypeScript, Bun (`bun test`), Biome (`bun run lint`).

## Global Constraints

- **The `newPaths` param MUST be OPTIONAL** (`newPaths?: string[]`). A *required* param would break the ~20 two-argument call sites in `test/dispatch/commit-scope.test.ts` (e.g. `inScope("pkg/existing.py", false)`) with TS2554 — and `tsconfig.json` has no `exclude`, so `tsc --noEmit` compiles `test/`. Optional keeps every 2-arg definition and call compiling; only `checksScopeFor` reads the 3rd arg.
- **Only an ADDITIONAL admission clause for checks.** The guard's reject-not-drop behavior, the unparseable-sidecar deferral, canonical-name admission (ENG-296), and `implementScope`/`planScope`/`docScope` are unchanged. A non-`styre_checks/` undeclared new file is still rejected.
- **Deterministic + retry-stable:** the cap uses a lexicographic sort; admission keys off the *physical* new-file set (not the sidecar), so it works even under ENG-296 write-vs-declare divergence.
- **Per-dir support cap = 2** (covers Python's `__init__.py` + `conftest.py`).
- **Verify before every commit:** `bunx tsc --noEmit`, the named `bun test` file(s), AND `bun run lint` (Biome — `noNonNullAssertion`, `useTemplate`, `organizeImports`, 100-col formatting). No `!`, no string `+`. The code blocks below show *intent*; before the lint step, run **`bun run format`** (biome format --write) to normalize whitespace/line-wraps/import order — biome's formatting is deterministic and auto-fixable, so let it reflow rather than hand-matching every column.
- **Every commit message ends with:**
  ```
  Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01U6QL6JTMgv66PKAbFe4uk7
  ```

---

## File Structure

- `src/dispatch/check-path.ts` — add `isCheckSupportFile` + module-private `dirname`/`finalExt` (Task 1).
- `test/dispatch/check-path.test.ts` — `isCheckSupportFile` unit tests (Task 1).
- `src/dispatch/commit-scope.ts` — widen `CommitScope`; add the clause to `checksScopeFor` (Task 2).
- `test/dispatch/commit-scope.test.ts` — `checksScopeFor` support-file integration test (Task 2).
- `src/dispatch/run-dispatch.ts` — pass `newPaths` to the predicate + reuse it for staging (Task 3).
- `test/dispatch/run-dispatch.test.ts` — end-to-end wiring test (Task 3).

---

## Task 1: `isCheckSupportFile` helper + unit tests

**Files:**
- Modify: `src/dispatch/check-path.ts` (add `dirname`, `finalExt`, `isCheckSupportFile`)
- Test: `test/dispatch/check-path.test.ts`

**Interfaces:**
- Produces: `export function isCheckSupportFile(path: string, addedNewPaths: string[], ident: string, acIds: Iterable<number>): boolean` — true iff `path` is a legit support file to auto-admit into a `styre_checks/` dir. Assumes inputs are already normalized (forward-slash, no `./`); callers pass `normPath`-ed values.

- [ ] **Step 1: Write the failing tests**

Add `isCheckSupportFile` to the existing import block at the top of `test/dispatch/check-path.test.ts` — in sorted position, between `isCanonicalCheckPath` and `matchAuthoredTest` (biome `organizeImports` enforces alphabetical order). Then append these tests:

```ts
test("isCheckSupportFile: admits a co-located same-ext marker in a styre_checks/ dir (Python __init__.py)", () => {
  const added = ["a/b/styre_checks/ENG-1_ac1_test.py", "a/b/styre_checks/__init__.py"];
  expect(isCheckSupportFile("a/b/styre_checks/__init__.py", added, "ENG-1", [1])).toBe(true);
});

test("isCheckSupportFile: admits a second support file (conftest.py) within the cap", () => {
  const added = [
    "t/styre_checks/ENG-1_ac1_test.py",
    "t/styre_checks/__init__.py",
    "t/styre_checks/conftest.py",
  ];
  expect(isCheckSupportFile("t/styre_checks/__init__.py", added, "ENG-1", [1])).toBe(true);
  expect(isCheckSupportFile("t/styre_checks/conftest.py", added, "ENG-1", [1])).toBe(true);
});

test("isCheckSupportFile: rejects when the styre_checks/ dir has no canonical check this dispatch", () => {
  const added = ["t/styre_checks/__init__.py"]; // no canonical test added in this dir
  expect(isCheckSupportFile("t/styre_checks/__init__.py", added, "ENG-1", [1])).toBe(false);
});

test("isCheckSupportFile: rejects a wrong-extension sibling (.md)", () => {
  const added = ["t/styre_checks/ENG-1_ac1_test.py", "t/styre_checks/NOTES.md"];
  expect(isCheckSupportFile("t/styre_checks/NOTES.md", added, "ENG-1", [1])).toBe(false);
});

test("isCheckSupportFile: rejects a marker NOT inside a styre_checks/ dir", () => {
  const added = ["pkg/ENG-1_ac1_test.py", "pkg/__init__.py"]; // flat, not under styre_checks/
  expect(isCheckSupportFile("pkg/__init__.py", added, "ENG-1", [1])).toBe(false);
});

test("isCheckSupportFile: rejects the 3rd same-ext support file (per-dir cap of 2, stable tie-break)", () => {
  const added = [
    "t/styre_checks/ENG-1_ac1_test.py",
    "t/styre_checks/a_helper.py",
    "t/styre_checks/b_helper.py",
    "t/styre_checks/c_helper.py",
  ];
  expect(isCheckSupportFile("t/styre_checks/a_helper.py", added, "ENG-1", [1])).toBe(true);
  expect(isCheckSupportFile("t/styre_checks/b_helper.py", added, "ENG-1", [1])).toBe(true);
  expect(isCheckSupportFile("t/styre_checks/c_helper.py", added, "ENG-1", [1])).toBe(false); // over cap
});

test("isCheckSupportFile: matches a multi-dot canonical extension (.tests.ts)", () => {
  const added = ["g/styre_checks/ENG-2_ac1_test.tests.ts", "g/styre_checks/helper.ts"];
  expect(isCheckSupportFile("g/styre_checks/helper.ts", added, "ENG-2", [1])).toBe(true);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test test/dispatch/check-path.test.ts`
Expected: FAIL — `isCheckSupportFile` is not exported (import error).

- [ ] **Step 3: Implement the helpers**

Append to `src/dispatch/check-path.ts` (after `resolveAuthoredTestPath`). The `basename` helper already exists in this file (line 12) — reuse it.

```ts
/** Everything before the last `/`; "" for a bare basename. */
function dirname(path: string): string {
  const i = path.lastIndexOf("/");
  return i === -1 ? "" : path.slice(0, i);
}

/** The final extension segment of a path's basename (after its last `.`), or "" if none.
 *  `__init__.py` → "py", `x.tests.ts` → "ts", `.gitignore`/`Makefile` → "" (dotfiles/no-dot = no ext). */
function finalExt(path: string): string {
  const b = basename(path);
  const i = b.lastIndexOf(".");
  return i <= 0 ? "" : b.slice(i + 1);
}

/** Per-directory cap on auto-admitted support files (covers Python's `__init__.py` + `conftest.py`). */
const CHECK_SUPPORT_CAP = 2;

/** True iff `path` is a legitimate support file to auto-admit into a `styre_checks/` directory
 *  (ENG-323): (1) its immediate parent dir is named `styre_checks`; (2) that same dir holds a
 *  canonical `{ident}_ac<id>_test.*` file in `addedNewPaths` (this dispatch's new files); (3) it shares
 *  the final extension of SOME co-located canonical check; (4) it is within `CHECK_SUPPORT_CAP` of the
 *  same-dir, same-ext, non-canonical new files (lexicographic tie-break → deterministic + retry-stable).
 *  Does NOT re-admit a canonical test (that is `isCanonicalCheckPath`'s job). Inputs are assumed
 *  normalized (forward-slash, no `./`). Pure; no I/O. */
export function isCheckSupportFile(
  path: string,
  addedNewPaths: string[],
  ident: string,
  acIds: Iterable<number>,
): boolean {
  const dir = dirname(path);
  if (basename(dir) !== "styre_checks") return false;
  const ids = [...acIds];
  const ext = finalExt(path);
  if (ext === "") return false;
  const canonicalSiblings = addedNewPaths.filter(
    (p) => dirname(p) === dir && isCanonicalCheckPath(p, ident, ids),
  );
  if (!canonicalSiblings.some((p) => finalExt(p) === ext)) return false;
  const supportCandidates = addedNewPaths
    .filter(
      (p) => dirname(p) === dir && finalExt(p) === ext && !isCanonicalCheckPath(p, ident, ids),
    )
    .sort();
  const rank = supportCandidates.indexOf(path);
  return rank !== -1 && rank < CHECK_SUPPORT_CAP;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test test/dispatch/check-path.test.ts`
Expected: PASS (the 7 new tests + all pre-existing check-path tests).

- [ ] **Step 5: Verify typecheck + lint**

Run: `bunx tsc --noEmit`
Expected: no errors.

Run: `bun run lint`
Expected: no Biome errors.

- [ ] **Step 6: Commit**

```bash
git add src/dispatch/check-path.ts test/dispatch/check-path.test.ts
git commit -m "feat(dispatch): isCheckSupportFile — admit co-located styre_checks/ markers (ENG-323)"
```

---

## Task 2: widen `CommitScope` + add the `checksScopeFor` clause

**Files:**
- Modify: `src/dispatch/commit-scope.ts` (import, `CommitScope` type, `checksScopeFor` predicate)
- Test: `test/dispatch/commit-scope.test.ts`

**Interfaces:**
- Consumes: `isCheckSupportFile` (Task 1).
- Produces: `CommitScope` inner predicate now `(path: string, isNew: boolean, newPaths?: string[]) => boolean`.

- [ ] **Step 1: Write the failing integration test**

Append to `test/dispatch/commit-scope.test.ts` (the `sidecar` helper at line 9 is already in the file):

```ts
test("checksScopeFor: admits a co-located styre_checks/__init__.py support file (ENG-323)", () => {
  const testPath = "astropy/modeling/tests/styre_checks/ENG-294_ac1_test.py";
  const initPath = "astropy/modeling/tests/styre_checks/__init__.py";
  const newPaths = [testPath, initPath];
  const inScope = checksScopeFor(
    "ENG-294",
    [1],
  )(
    // agent declared a FLAT path (ENG-296 divergence) and did NOT declare __init__.py:
    sidecar({
      checksAuthored: [
        { ac_id: 1, test_file: "astropy/modeling/tests/ENG-294_ac1_test.py", test_name: "t" },
      ],
    }),
  );
  // the written canonical test is admitted (canonical name), and the undeclared __init__.py too:
  expect(inScope(testPath, true, newPaths)).toBe(true);
  expect(inScope(initPath, true, newPaths)).toBe(true);
  // a non-styre_checks/ undeclared file is still rejected:
  expect(inScope("astropy/modeling/tests/reproduce_bug.py", true, newPaths)).toBe(false);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test test/dispatch/commit-scope.test.ts`
Expected: the new test FAILS — today the undeclared `styre_checks/__init__.py` is not admitted (no support-file clause), so `inScope(...__init__.py..., true, newPaths)` returns `false`. (The other assertions and all pre-existing tests still pass — the extra `newPaths` arg is accepted by the widened optional signature once Step 3 lands, and ignored before it since JS tolerates extra args.)

- [ ] **Step 3: Widen the type and add the clause**

In `src/dispatch/commit-scope.ts`:

Change the import on line 1 from:

```ts
import { isCanonicalCheckPath, normPath } from "./check-path.ts";
```

to:

```ts
import { isCanonicalCheckPath, isCheckSupportFile, normPath } from "./check-path.ts";
```

Change the `CommitScope` type (lines 7-9) from:

```ts
/** Given the agent's stdout, a predicate over each pending path: true ⇒ in scope (deliverable).
 *  `isNew` is true only for a brand-new untracked file. */
export type CommitScope = (output: string) => (path: string, isNew: boolean) => boolean;
```

to:

```ts
/** Given the agent's stdout, a predicate over each pending path: true ⇒ in scope (deliverable).
 *  `isNew` is true only for a brand-new untracked file. `newPaths` (OPTIONAL — omit for the 2-arg
 *  callers) is every brand-new file this dispatch created, so a scope can reason about siblings
 *  (checks support-file admission, ENG-323). Optional so the 2-arg scope definitions and every
 *  existing 2-arg call site keep compiling; only checksScopeFor reads it. */
export type CommitScope = (
  output: string,
) => (path: string, isNew: boolean, newPaths?: string[]) => boolean;
```

Replace the `checksScopeFor` returned predicate (lines 33-34) — currently:

```ts
    return (path, isNew) =>
      !isNew || declared.has(normPath(path)) || isCanonicalCheckPath(normPath(path), ident, acIds);
```

with:

```ts
    return (path, isNew, newPaths) => {
      const p = normPath(path);
      const news = (newPaths ?? []).map(normPath);
      return (
        !isNew ||
        declared.has(p) ||
        isCanonicalCheckPath(p, ident, acIds) ||
        isCheckSupportFile(p, news, ident, acIds)
      );
    };
```

Leave `implementScope`, `planScope`, `docScope`, and the unparseable-sidecar deferral (`if (!parsed.ok) return () => true`) exactly as they are — they satisfy the widened type unchanged.

- [ ] **Step 4: Run the commit-scope tests to verify they pass**

Run: `bun test test/dispatch/commit-scope.test.ts`
Expected: PASS — the new ENG-323 test passes, and all pre-existing tests (implementScope, the existing checksScopeFor divergence/defer tests, plan/doc) stay green (the optional param keeps their 2-arg calls valid).

- [ ] **Step 5: Verify typecheck + lint**

Run: `bunx tsc --noEmit`
Expected: no errors (the optional param is why `commit-scope.test.ts`'s 2-arg calls still typecheck).

Run: `bun run lint`
Expected: no Biome errors.

- [ ] **Step 6: Commit**

```bash
git add src/dispatch/commit-scope.ts test/dispatch/commit-scope.test.ts
git commit -m "feat(dispatch): checksScopeFor admits co-located support files (ENG-323)"
```

---

## Task 3: thread the new-file set through `run-dispatch`

**Files:**
- Modify: `src/dispatch/run-dispatch.ts` (the `if (spec.commitScope)` block)
- Test: `test/dispatch/run-dispatch.test.ts`

**Interfaces:**
- Consumes: the widened `CommitScope` predicate (Task 2).

- [ ] **Step 1: Write the failing wiring test**

Add `mkdirSync` to the existing `node:fs` import in `test/dispatch/run-dispatch.test.ts` if absent, and add `checksScopeFor` to the `../../src/dispatch/commit-scope.ts` import in sorted position — before `implementScope` (biome `organizeImports` enforces alphabetical order). Then append:

```ts
test("checks support file: an undeclared styre_checks/__init__.py co-located with the canonical check is admitted (ENG-323)", async () => {
  const { db, ticketId } = makeTestDb();
  const repo = gitRepo();
  const wt = join(repo, "..", `wt-support-${Date.now()}`);
  const runner = new FakeAgentRunner((input) => {
    mkdirSync(join(input.cwd, "tests", "styre_checks"), { recursive: true });
    writeFileSync(
      join(input.cwd, "tests", "styre_checks", "ENG-1_ac1_test.py"),
      "def test_x():\n    assert False\n",
    );
    writeFileSync(join(input.cwd, "tests", "styre_checks", "__init__.py"), ""); // undeclared marker
    return {
      completed: true,
      exitCode: 0,
      stdout:
        '```styre-sidecar\n{"checksAuthored":[{"ac_id":1,"test_file":"tests/styre_checks/ENG-1_ac1_test.py","test_name":"test_x"}],"new_files":[]}\n```',
      stderr: "",
      timedOut: false,
      costUsd: null,
      tokensIn: null,
      tokensOut: null,
    };
  });
  const res = await runAgentDispatch(
    ctxFor(db, ticketId),
    { runner, ...depsFor(repo, wt) },
    {
      handlerKey: "checks:dispatch",
      template: "checks {{ident}}",
      vars: { ident: "ENG-1" },
      commitScope: checksScopeFor("ENG-1", [1]),
      postcondition: () => {},
    },
  );

  expect(listByTicket(db, ticketId)[0]?.outcome).toBe("clean-success"); // NOT rejected
  expect(res.changed).toBe(true);
  const committed = Bun.spawnSync(["git", "show", "--name-only", "--format=", "HEAD"], {
    cwd: wt,
  }).stdout.toString();
  expect(committed).toContain("tests/styre_checks/ENG-1_ac1_test.py");
  expect(committed).toContain("tests/styre_checks/__init__.py");
  db.close();
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test test/dispatch/run-dispatch.test.ts`
Expected: FAIL — without `newPaths` threaded to the predicate, `isCheckSupportFile` sees an empty sibling set, so the undeclared `__init__.py` is an offender → the dispatch throws `out-of-scope files … __init__.py` and records `dispatch-failed`, not `clean-success`.

- [ ] **Step 3: Pass `newPaths` at the call site**

In `src/dispatch/run-dispatch.ts`, inside the `if (spec.commitScope) {` block, replace:

```ts
    const inScope = spec.commitScope(result.stdout);
    const offenders = judged.filter((e) => !inScope(e.path, e.isNew));
```

with:

```ts
    const inScope = spec.commitScope(result.stdout);
    const newPaths = judged.filter((e) => e.isNew).map((e) => e.path);
    const offenders = judged.filter((e) => !inScope(e.path, e.isNew, newPaths));
```

Then, in the same block, replace the `commitWorktree` new-files argument — currently:

```ts
    ({ sha, changed } = commitWorktree(
      deps.worktreePath,
      `${did} ${spec.handlerKey}`,
      judged.filter((e) => e.isNew).map((e) => e.path),
    ));
```

with (reuse the `newPaths` just computed — DRY, same value):

```ts
    ({ sha, changed } = commitWorktree(deps.worktreePath, `${did} ${spec.handlerKey}`, newPaths));
```

- [ ] **Step 4: Run the wiring test to verify it passes**

Run: `bun test test/dispatch/run-dispatch.test.ts`
Expected: PASS — the `__init__.py` is admitted as a co-located support file, both files commit, outcome is `clean-success`. The pre-existing scope-reject test (repo-root `test_bug.py`, not in a `styre_checks/` dir) still rejects.

- [ ] **Step 5: Verify — typecheck, the dispatch suites, and lint**

Run: `bunx tsc --noEmit`
Expected: no errors.

Run: `bun test test/dispatch/run-dispatch.test.ts test/dispatch/commit-scope.test.ts test/dispatch/check-path.test.ts`
Expected: PASS.

Run: `bun run lint`
Expected: no Biome errors.

- [ ] **Step 6: Commit**

```bash
git add src/dispatch/run-dispatch.ts test/dispatch/run-dispatch.test.ts
git commit -m "feat(dispatch): thread new-file set to the checks scope guard (ENG-323)"
```

---

## Final Verification (after all tasks)

- [ ] Full suite: `bun test` (expect prior green count + the new tests, 0 fail).
- [ ] `bunx tsc --noEmit` clean, `bun run lint` clean.
- [ ] Whole-branch review (opus) via superpowers:requesting-code-review, then superpowers:finishing-a-development-branch (push + draft PR to Twinning-Labs/styre, base main).

# ENG-342 — Collection-failure message legibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a `checks:dispatch` RED-first test cannot collect because a discarded Python support file (`__init__.py`/`conftest.py`) is missing, name the cause in the retry message and stop the poisoned check from shipping — then delete the now-redundant ENG-323 auto-admit heuristic.

**Architecture:** Extend the existing discard guard. Two new pure functions in `check-selector.ts` — a shape matcher that ties a discarded `__init__.py`/`conftest.py` to the collection error, and a one-line error excerpt — feed a richer diagnosis message in the checks handler. Then delete `isCheckSupportFile` and its callers/tests, and add one line to `checks.md`. No schema, config, or detector change.

**Tech Stack:** TypeScript + Bun; SQLite SoT; pytest is the framework under test. Tests are `bun test`.

## Global Constraints

- **Verification gate before every commit = THREE commands:** `bun run typecheck` (`tsc --noEmit`) **+** `bun run lint` (biome) **+** `bun test`. Biome does NOT type-check; run all three. `noUnusedLocals` and `noUnusedParameters` are on — a deleted function's now-orphaned helpers/params fail the typecheck.
- **Diagnosis-only (INV-B):** every failure/retry message states a fact (the cause, the file, the real error). It never carries an instruction or a convention. The "declare your support files" convention lives only in the forward prompt `checks.md` (INV-A).
- **Conservative matching (option A, operator-chosen):** implicate a discarded file only when the error names it or matches a support-file shape. Accept documented misses (a residual silent ship) rather than risk wrongly rejecting a legitimate fail-first test. A wrong implication only costs one retry; never widen to "any discard + any import error".
- **Python only.** `__init__.py`/`conftest.py` are Python concepts. Do not touch other frameworks' vocabulary (that is ENG-343).
- **No schema/config/detector/`styre setup` change.** Pure functions + one handler message + one prompt line + the deletion.
- **Branch:** `feat/checks-collection-legibility-eng-342` (already created). Never commit to `main`. One PR; a Conventional-Commits PR title.

---

## File Structure

- `src/dispatch/check-selector.ts` — **modify.** Add support-file shape matching inside `importErrorImplicatesDiscarded`; add `collectionErrorExcerpt`; add two import-error indicator phrases + a fixture-not-found regex. (Task 1)
- `src/dispatch/handlers.ts` — **modify** (`checks:dispatch`, ~:683-692). Compose the richer diagnosis from the implicated files + the excerpt. (Task 2)
- `src/dispatch/check-path.ts` — **modify.** Delete `isCheckSupportFile`, `CHECK_SUPPORT_CAP`, and the two helpers used only by it (`dirname`, `finalExt`). (Task 3)
- `src/dispatch/commit-scope.ts` — **modify.** Drop the `isCheckSupportFile` clause, the `news` local, the `newPaths` parameter, and the `CommitScope` type's third argument. (Task 3)
- `src/dispatch/run-dispatch.ts` — **modify** (~:206). Stop passing the retired third argument to `inScope`. (Task 3)
- `prompts/checks.md` — **modify** (~:40-43). Name `__init__.py`/package markers in the existing "declare support files" instruction. (Task 3)
- Tests: `test/dispatch/check-selector.test.ts` (Task 1), a handler-level test in `test/dispatch/checks-handler.test.ts` (Task 2), and edits to `test/dispatch/check-path.test.ts` + `test/dispatch/commit-scope.test.ts` (Task 3).

---

## Task 1: Support-file shape matching + error excerpt (`check-selector.ts`)

**Files:**
- Modify: `src/dispatch/check-selector.ts` (`IMPORT_ERROR_INDICATORS` ~:273; `importErrorImplicatesDiscarded` ~:296-327; add new helpers + `collectionErrorExcerpt`)
- Test: `test/dispatch/check-selector.test.ts`

**Interfaces:**
- Consumes: existing `moduleLeaf`, `escapeRegex`, `IMPORT_ERROR_INDICATORS`, `IMPORT_ERROR_NAMING`.
- Produces:
  - `importErrorImplicatesDiscarded(rawOutput: string, discarded: string[]): string[]` — unchanged signature; now also implicates a discarded `__init__.py`/`conftest.py` by shape.
  - `collectionErrorExcerpt(rawOutput: string): string | undefined` — the one-line cause, original casing, ≤200 chars.

- [ ] **Step 1: Write the failing tests** — append to `test/dispatch/check-selector.test.ts`. (Import `importErrorImplicatesDiscarded` and `collectionErrorExcerpt` from `../../src/dispatch/check-selector.ts` — extend the existing import if one is present.)

```ts
import { collectionErrorExcerpt, importErrorImplicatesDiscarded } from "../../src/dispatch/check-selector.ts";

// --- package-init (__init__.py) shape matching ---
test("implicates a discarded __init__.py when the missing module IS its package (shallow)", () => {
  const out = "E   ModuleNotFoundError: No module named 'pkg'";
  expect(importErrorImplicatesDiscarded(out, ["pkg/__init__.py"])).toEqual(["pkg/__init__.py"]);
});

test("implicates a discarded nested __init__.py by its full dotted package", () => {
  const out = "ModuleNotFoundError: No module named 'a.b'";
  expect(importErrorImplicatesDiscarded(out, ["a/b/__init__.py"])).toEqual(["a/b/__init__.py"]);
});

test("implicates a discarded __init__.py when a SUBMODULE of its package is imported", () => {
  const out = "ModuleNotFoundError: No module named 'pkg.sub'";
  expect(importErrorImplicatesDiscarded(out, ["pkg/__init__.py"])).toEqual(["pkg/__init__.py"]);
});

test("implicates a discarded __init__.py under a src/ prefix via a >=2-seg suffix", () => {
  const out = "ModuleNotFoundError: No module named 'mypkg.sub'";
  expect(importErrorImplicatesDiscarded(out, ["src/mypkg/sub/__init__.py"])).toEqual([
    "src/mypkg/sub/__init__.py",
  ]);
});

test("does NOT implicate a discarded nested __init__.py for an unrelated top-level import (no false reject)", () => {
  // a/b/__init__.py discarded, but the test legitimately fails importing an unrelated top-level `b`.
  const out = "ModuleNotFoundError: No module named 'b'";
  expect(importErrorImplicatesDiscarded(out, ["a/b/__init__.py"])).toEqual([]);
});

test("does NOT implicate a discarded __init__.py for an unrelated feature module", () => {
  const out = "ModuleNotFoundError: No module named 'unrelated_feature'";
  expect(importErrorImplicatesDiscarded(out, ["pkg/__init__.py"])).toEqual([]);
});

// --- conftest.py shape matching ---
test("implicates a discarded conftest.py on a fixture-not-found error", () => {
  const out = "E       fixture 'db' not found";
  expect(importErrorImplicatesDiscarded(out, ["tests/conftest.py"])).toEqual(["tests/conftest.py"]);
});

test("does NOT implicate a discarded conftest.py on a plain assertion failure (no collection/fixture error)", () => {
  const out = "E       assert 1 == 2";
  expect(importErrorImplicatesDiscarded(out, ["tests/conftest.py"])).toEqual([]);
});

// --- existing general tier still works (regression) ---
test("still implicates a directly-named discarded helper", () => {
  const out = "ModuleNotFoundError: No module named 'helper'";
  expect(importErrorImplicatesDiscarded(out, ["tests/helper.py"])).toEqual(["tests/helper.py"]);
});

// --- collectionErrorExcerpt ---
test("collectionErrorExcerpt prefers the pytest ERROR summary line and preserves casing", () => {
  const out = [
    "    import pkg",
    "E   ModuleNotFoundError: No module named 'pkg'",
    "=== short test summary info ===",
    "ERROR tests/x_test.py - ModuleNotFoundError: No module named 'pkg'",
  ].join("\n");
  expect(collectionErrorExcerpt(out)).toBe(
    "ERROR tests/x_test.py - ModuleNotFoundError: No module named 'pkg'",
  );
});

test("collectionErrorExcerpt falls back to the last indicator line when no summary line exists", () => {
  const out = "line one\nE   ModuleNotFoundError: No module named 'pkg'\ntrailing noise";
  expect(collectionErrorExcerpt(out)).toBe("ModuleNotFoundError: No module named 'pkg'");
});

test("collectionErrorExcerpt surfaces a fixture-not-found line", () => {
  expect(collectionErrorExcerpt("E       fixture 'db' not found")).toBe("fixture 'db' not found");
});

test("collectionErrorExcerpt returns undefined when no collection/import indicator is present", () => {
  expect(collectionErrorExcerpt("E   assert 1 == 2")).toBeUndefined();
});
```

- [ ] **Step 2: Run the tests to confirm they fail**

Run: `bun test test/dispatch/check-selector.test.ts`
Expected: FAIL — `collectionErrorExcerpt` is not exported; the `__init__.py`/`conftest.py` cases return `[]`.

- [ ] **Step 3: Add the two indicator phrases + the fixture regex** — in `src/dispatch/check-selector.ts`, extend `IMPORT_ERROR_INDICATORS` (currently ends at `"errors during collection",`) and add a fixture regex just after it:

```ts
const IMPORT_ERROR_INDICATORS = [
  "modulenotfounderror",
  "importerror",
  "no module named",
  "cannot find module",
  "cannot import name",
  "error collecting",
  "errors during collection",
  "import file mismatch", // pytest prepend-import-mode mismatch (a moved/removed package marker)
  "error importing test module",
];

/** pytest's fixture-not-found line (a discarded `conftest.py` that provided the fixture). Kept out of
 *  IMPORT_ERROR_INDICATORS so the generic basename tier stays precise; used only by the conftest tier
 *  and by collectionErrorExcerpt. */
const FIXTURE_NOT_FOUND = /fixture ['"]?[\w.-]+['"]? not found/i;
```

- [ ] **Step 4: Add the shape helpers** — in `src/dispatch/check-selector.ts`, just above `importErrorImplicatesDiscarded`:

```ts
/** A dotted, lower-cased module reference from a "No module named 'X'" capture: slashes → dots,
 *  trimmed of leading/trailing dots. `a/b` → `a.b`, `Pkg.Sub` → `pkg.sub`. Pure. */
function moduleDotted(ref: string): string {
  return ref
    .replace(/[\\/]/g, ".")
    .replace(/^\.+|\.+$/g, "")
    .toLowerCase();
}

/** True iff `a`'s segments are the trailing segments of `b` (a is a suffix of b). */
function isSegSuffix(a: string[], b: string[]): boolean {
  if (a.length === 0 || a.length > b.length) return false;
  const off = b.length - a.length;
  return a.every((s, i) => s === b[off + i]);
}

/** True iff `long` starts with every segment of `short` (short is a leading prefix of long). */
function isSegPrefix(short: string[], long: string[]): boolean {
  if (short.length === 0 || short.length > long.length) return false;
  return short.every((s, i) => s === long[i]);
}

/** CONSERVATIVE match tying a discarded `__init__.py` to a missing-module error (option A). Derive the
 *  package from the file's DIRECTORY, then implicate iff some named module M: (1) equals the full dotted
 *  dir; (2) strictly extends it as a prefix (a submodule import); or (3) is a >=2-segment trailing suffix
 *  of the dir (absorbs a `src/` or component prefix). A bare single-segment interior name (e.g. `b` for
 *  `a/b/__init__.py`) never matches — that is the no-false-reject guarantee. Residuals (documented, not
 *  closed): a single-segment error against a deeper dir (`pkg` vs `src/pkg/__init__.py`); PEP 420
 *  namespace packages; a deep submodule with a dir prefix. Pure. */
function packageInitImplicated(initPath: string, namedModules: string[]): boolean {
  const dirSegs = initPath.split("/").slice(0, -1).filter((s) => s.length > 0);
  if (dirSegs.length === 0) return false;
  for (const mod of namedModules) {
    const modSegs = mod.split(".").filter((s) => s.length > 0);
    if (modSegs.length === 0) continue;
    if (modSegs.length === dirSegs.length && isSegPrefix(modSegs, dirSegs)) return true; // (1) exact
    if (modSegs.length > dirSegs.length && isSegPrefix(dirSegs, modSegs)) return true; // (2) submodule
    if (modSegs.length >= 2 && isSegSuffix(modSegs, dirSegs)) return true; // (3) prefixed dir
  }
  return false;
}
```

- [ ] **Step 5: Extend `importErrorImplicatesDiscarded`** — replace the body of the existing function (`src/dispatch/check-selector.ts` ~:296-327) with this. It adds a raw `namedModules` collection and the two shape tiers, before the existing basename fallback:

```ts
export function importErrorImplicatesDiscarded(rawOutput: string, discarded: string[]): string[] {
  if (discarded.length === 0 || rawOutput.trim() === "") return [];
  const hay = rawOutput.toLowerCase();
  const hasIndicator = IMPORT_ERROR_INDICATORS.some((k) => hay.includes(k));
  const hasFixtureError = FIXTURE_NOT_FOUND.test(rawOutput);

  // module identifiers named by an import/module-error phrase: leaf-reduced (existing tier) AND raw
  // dotted (new package-init tier — the prefix/suffix test is meaningless on a leaf-reduced name).
  const named = new Set<string>();
  const namedModules: string[] = [];
  const re = new RegExp(IMPORT_ERROR_NAMING, "gi");
  let m: RegExpExecArray | null;
  // biome-ignore lint/suspicious/noAssignInExpressions: canonical exec-loop over a /g regex.
  while ((m = re.exec(rawOutput)) !== null) {
    if (m[1]) {
      named.add(moduleLeaf(m[1]));
      namedModules.push(moduleDotted(m[1]));
    }
  }

  const matched: string[] = [];
  for (const d of discarded) {
    const base = d.split(/[\\/]/).pop() ?? d;

    // (A) support-file shapes (Python): a marker/fixture whose ABSENCE names the package/fixture, not
    // the file — the exact blind spot the general tiers below miss.
    if (base === "__init__.py" && packageInitImplicated(d, namedModules)) {
      matched.push(d);
      continue;
    }
    if (base === "conftest.py" && (hasIndicator || hasFixtureError)) {
      matched.push(d);
      continue;
    }

    // (B) general tiers (unchanged): the error NAMES the discarded file's module leaf, or its exact
    // basename appears as a bounded token while an import indicator is present.
    const leaf = moduleLeaf(d);
    if (leaf !== "" && named.has(leaf)) {
      matched.push(d);
      continue;
    }
    if (hasIndicator && base.includes(".")) {
      const bounded = new RegExp(`(?:^|[\\s"'\`/(])${escapeRegex(base)}(?:[\\s"'\`:)]|$)`, "im");
      if (bounded.test(rawOutput)) matched.push(d);
    }
  }
  return matched;
}
```

- [ ] **Step 6: Add `collectionErrorExcerpt`** — in `src/dispatch/check-selector.ts`, immediately after `importErrorImplicatesDiscarded`:

```ts
/** The one line that states a collection/import/fixture cause, in original casing, ≤200 chars. Prefers
 *  pytest's short-test-summary line (`ERROR path - Cause`, printed last and authoritative); else the
 *  LAST matching line (the first is often a re-raised error deep in a third-party traceback).
 *  `undefined` when the output carries no collection/import/fixture indicator. Pure. */
export function collectionErrorExcerpt(rawOutput: string): string | undefined {
  let summary: string | undefined;
  let lastMatch: string | undefined;
  for (const line of rawOutput.split(/\r?\n/)) {
    const low = line.toLowerCase();
    const isMatch = IMPORT_ERROR_INDICATORS.some((k) => low.includes(k)) || FIXTURE_NOT_FOUND.test(line);
    if (!isMatch) continue;
    lastMatch = line;
    if (/^\s*ERROR\b/.test(line)) summary = line;
  }
  const chosen = (summary ?? lastMatch)?.trim();
  if (chosen === undefined || chosen === "") return undefined;
  return chosen.length > 200 ? `${chosen.slice(0, 197)}...` : chosen;
}
```

- [ ] **Step 7: Run the tests to confirm they pass**

Run: `bun test test/dispatch/check-selector.test.ts`
Expected: PASS (all new cases green; existing cases unaffected).

- [ ] **Step 8: Run the full gate and commit**

```bash
bun run typecheck && bun run lint && bun test
git add src/dispatch/check-selector.ts test/dispatch/check-selector.test.ts
git commit -m "feat(checks): match discarded __init__.py/conftest.py to collection errors"
```

---

## Task 2: Legible diagnosis in the checks handler (`handlers.ts`)

**Files:**
- Modify: `src/dispatch/handlers.ts` (the discard guard in `checks:dispatch`, ~:683-692; add `collectionErrorExcerpt` to the existing `check-selector` import)
- Test: `test/dispatch/checks-handler.test.ts` (its harness already injects `runCheckCommand` and drives `checks:dispatch` end-to-end — reuse it; do NOT invent a new harness)

**Interfaces:**
- Consumes: `importErrorImplicatesDiscarded`, `collectionErrorExcerpt` (Task 1); the guard already has `rawOutput`, `discarded`, `missReason`, `c.ac_id` in scope. The test harness seam is `buildDispatchRegistry({ runCheckCommand })` (inject the RED-first run's `{ exitCode, stdout, stderr, timedOut }`) and `FakeAgentRunner((input) => …)` which writes files into `input.cwd` (the worktree).
- Produces: no new export — a richer `missReason` string that flows through the existing postcondition throw (`handlers.ts:710-722`) into `workflow_step.error_json` and the retry prefix.

- [ ] **Step 1: Write the failing handler-level test** — append to `test/dispatch/checks-handler.test.ts`, reusing that file's existing imports and helpers (`gitRepo`, `markDesignDone`, `FakeAgentRunner`, `buildDispatchRegistry`, `parseProfile`, `advanceOneStep`, `listAcChecks`, `getByKey`, `insertWorkUnit`, `setTicketTrack`, `makeTestDb`, and the node-fs/path imports). The fake agent writes the declared canonical test AND an undeclared `pkg/__init__.py` (so it is discarded); the injected RED-first run returns a pytest collection error naming `pkg`:

```ts
test("checks:dispatch — a discarded __init__.py yields a legible, non-persisted collection failure", async () => {
  const { db, ticketId, projectId } = makeTestDb();
  const repo = gitRepo();
  db.query("UPDATE project SET target_repo = ? WHERE id = ?").run(repo, projectId);
  db.query("UPDATE ticket SET description = ? WHERE id = ?").run("- [ ] returns ok\n", ticketId);
  await markDesignDone(db, ticketId);
  insertWorkUnit(db, { ticketId, seq: 1, kind: "python", verifyCheckTypes: ["test"] });
  setTicketTrack(db, ticketId, "fast");

  // Agent writes the declared canonical test AND an UNDECLARED pkg/__init__.py (→ discarded).
  const runner = new FakeAgentRunner((input) => {
    const checksDir = join(input.cwd, "checks");
    mkdirSync(checksDir, { recursive: true });
    writeFileSync(join(checksDir, "ac1.py"), "import pkg\n\ndef test_ac1():\n    assert pkg.x\n");
    const pkgDir = join(input.cwd, "pkg");
    mkdirSync(pkgDir, { recursive: true });
    writeFileSync(join(pkgDir, "__init__.py"), "x = 1\n"); // undeclared → discarded
    return {
      completed: true,
      exitCode: 0,
      stdout:
        '```styre-sidecar\n{"checksAuthored":[' +
        '{"ac_id":1,"test_file":"checks/ac1.py","test_name":"test_ac1"}]}\n```',
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
    // RED-first run: a collection error naming the package whose __init__.py was discarded.
    runCheckCommand: async () => ({
      exitCode: 2,
      stdout:
        "E   ModuleNotFoundError: No module named 'pkg'\n" +
        "ERROR checks/ac1.py - ModuleNotFoundError: No module named 'pkg'",
      stderr: "",
      timedOut: false,
    }),
  });

  await advanceOneStep(db, ticketId, registry); // provision (no-op)
  await advanceOneStep(db, ticketId, registry); // checks:dispatch → postcondition throws
  const checks = listAcChecks(db, ticketId);
  const step = getByKey(db, ticketId, "checks:dispatch");
  const message: string = JSON.parse(step?.error_json ?? "{}").message ?? "";
  db.close();

  // (a) the poisoned collection-error red is NOT installed as a covered check:
  expect(checks.length).toBe(0);
  // (b) the failure names the cause, the discarded file, and the real pytest line:
  expect(message).toContain("import or collection error");
  expect(message).toContain("pkg/__init__.py");
  expect(message).toContain("No module named 'pkg'");
});
```

- [ ] **Step 2: Run the test to confirm it fails**

Run: `bun test test/dispatch/checks-handler.test.ts`
Expected: FAIL — today's message is the generic `"references files styre discarded this attempt"`, missing `"import or collection error"` and the `No module named` excerpt.

- [ ] **Step 3: Add `collectionErrorExcerpt` to the import** — in `src/dispatch/handlers.ts`, add it to the existing `check-selector` import (the one that already brings in `importErrorImplicatesDiscarded`):

```ts
import { /* …existing… */ collectionErrorExcerpt, importErrorImplicatesDiscarded } from "./check-selector.ts";
```

- [ ] **Step 4: Compose the richer message** — replace the guard's `missReason.set(...)` block (`src/dispatch/handlers.ts` ~:685-690):

```ts
        if (discarded.length > 0 && coarse !== "green") {
          const implicated = importErrorImplicatesDiscarded(rawOutput, discarded);
          if (implicated.length > 0) {
            const excerpt = collectionErrorExcerpt(rawOutput);
            const base = `the check could not be collected (import or collection error) — this attempt discarded ${implicated.join(", ")} (undeclared)`;
            missReason.set(c.ac_id, excerpt ? `${base}. Framework said: ${excerpt}` : `${base}.`);
            continue; // uncovered → loud retry path, no poisoned check persisted
          }
        }
```

(The surrounding `if (discarded.length > 0 && coarse !== "green")` and the `importErrorImplicatesDiscarded` call already exist — keep them; only the message construction changes. Note the guard already runs on `coarse !== "green"`, so it covers pytest exit 1/2/4, not just exit 2.)

- [ ] **Step 5: Run the test to confirm it passes**

Run: `bun test test/dispatch/checks-handler.test.ts`
Expected: PASS.

- [ ] **Step 6: Run the full gate and commit**

```bash
bun run typecheck && bun run lint && bun test
git add src/dispatch/handlers.ts test/dispatch/checks-handler.test.ts
git commit -m "feat(checks): name the collection cause in the discard retry message"
```

---

## Task 3: Delete the ENG-323 heuristic + name `__init__.py` in checks.md

**Files:**
- Modify: `src/dispatch/check-path.ts` (delete `isCheckSupportFile` :88-110, `CHECK_SUPPORT_CAP` :78-79, `dirname` :64-68, `finalExt` :70-76)
- Modify: `src/dispatch/commit-scope.ts` (drop the `isCheckSupportFile` import + clause + `news` + `newPaths` + the type's third arg)
- Modify: `src/dispatch/run-dispatch.ts` (:206 — stop passing the third arg)
- Modify: `prompts/checks.md` (~:40-43)
- Test: `test/dispatch/check-path.test.ts`, `test/dispatch/commit-scope.test.ts`

**Interfaces:**
- Produces: `CommitScope = (output: string) => (path: string, isNew: boolean) => boolean` (two-arg predicate — the `newPaths?` third arg is removed).

- [ ] **Step 1: Update the two affected tests first (they encode the OLD behavior)** — in `test/dispatch/check-path.test.ts`, remove `isCheckSupportFile` from the import (line ~5) and delete every `isCheckSupportFile` test (the block ~:75-119). In `test/dispatch/commit-scope.test.ts`, replace the `"admits a co-located styre_checks/__init__.py support file (ENG-323)"` test (~:60-79) with the new declare-or-discard behavior:

```ts
test("checksScopeFor: an UNDECLARED co-located __init__.py is now out of scope (discarded, not auto-admitted)", () => {
  const initPath = "astropy/modeling/tests/styre_checks/__init__.py";
  const inScope = checksScopeFor("ENG-294", [1])(
    sidecar({
      checksAuthored: [
        { ac_id: 1, test_file: "astropy/modeling/tests/styre_checks/ENG-294_ac1_test.py", test_name: "t" },
      ],
    }),
  );
  expect(inScope("astropy/modeling/tests/styre_checks/ENG-294_ac1_test.py", true)).toBe(true); // canonical name
  expect(inScope(initPath, true)).toBe(false); // undeclared support file → discarded
});

test("checksScopeFor: a DECLARED __init__.py (in new_files) is in scope", () => {
  const initPath = "astropy/modeling/tests/styre_checks/__init__.py";
  const inScope = checksScopeFor("ENG-294", [1])(
    sidecar({
      checksAuthored: [
        { ac_id: 1, test_file: "astropy/modeling/tests/styre_checks/ENG-294_ac1_test.py", test_name: "t" },
      ],
      new_files: [initPath],
    }),
  );
  expect(inScope(initPath, true)).toBe(true);
});
```

(If any other test in `commit-scope.test.ts` calls `inScope(path, isNew, newPaths)` with a third arg, drop the third arg — the predicate is now two-arg. Check the `sidecar` helper accepts a `new_files` field; it should, since `checksAuthored` and `new_files` are the sidecar shape.)

- [ ] **Step 2: Run the tests to confirm they fail**

Run: `bun test test/dispatch/check-path.test.ts test/dispatch/commit-scope.test.ts`
Expected: FAIL — the new commit-scope test expects `false` for an undeclared `__init__.py`, but the old `isCheckSupportFile` still admits it.

- [ ] **Step 3: Delete the heuristic from `check-path.ts`** — remove `CHECK_SUPPORT_CAP` (:78-79), `isCheckSupportFile` (:81-110 incl. its doc comment), and the two helpers used ONLY by it: `dirname` (:64-68) and `finalExt` (:70-76). Keep `basename`, `normPath`, `isCanonicalCheckPath`, `matchAuthoredTest`, `resolveAuthoredTestPath`, `canonicalCheckBase` (all used elsewhere).

- [ ] **Step 4: Delete the clause + plumbing from `commit-scope.ts`** — remove `isCheckSupportFile` from the import (line 1), and change `checksScopeFor`'s returned predicate + the `CommitScope` type:

```ts
// import line 1 — drop isCheckSupportFile:
import { isCanonicalCheckPath, normPath } from "./check-path.ts";

// type (:12-14) — drop the third arg + rewrite the doc comment:
/** Given the agent's stdout, a predicate over each pending path: true ⇒ in scope (deliverable).
 *  `isNew` is true only for a brand-new untracked file. */
export type CommitScope = (output: string) => (path: string, isNew: boolean) => boolean;

// checksScopeFor returned predicate (:43-52) — drop newPaths + news + the isCheckSupportFile clause:
    return (path, isNew) => {
      const p = normPath(path);
      return !isNew || declared.has(p) || isCanonicalCheckPath(p, ident, acIds);
    };
```

- [ ] **Step 5: Update the one call site in `run-dispatch.ts`** — at `:206`, drop the retired third argument:

```ts
    const offenders = judged.filter((e) => !inScope(e.path, e.isNew));
```

(Leave `newPaths` at `:205` — it is still used at `:250`.)

- [ ] **Step 6: Name `__init__.py` in `checks.md`** — in `prompts/checks.md` (~:40-43), extend the existing declare instruction so a package marker is named as a helper:

```markdown
- **Declare every new file that is part of your check** — the RED-first test via `checksAuthored`
  (`test_file`) and any genuine test helper (a fixture, `conftest.py`, or a package marker such as
  `__init__.py`) via `new_files`. Any undeclared new file you create is treated as throwaway and won't be
  committed; you don't need a special folder for scratch, and you must not park throwaway files in
  `new_files`.
```

- [ ] **Step 7: Run the full gate**

Run: `bun run typecheck && bun run lint && bun test`
Expected: PASS — no orphaned `dirname`/`finalExt`/`news`/`newPaths` (typecheck clean), and every suite green. `test/dispatch/checks-prompt.test.ts` only asserts the prompt `.toContain("new_files")`, so the wording change is safe.

- [ ] **Step 8: Commit**

```bash
git add src/dispatch/check-path.ts src/dispatch/commit-scope.ts src/dispatch/run-dispatch.ts prompts/checks.md test/dispatch/check-path.test.ts test/dispatch/commit-scope.test.ts
git commit -m "feat(checks): delete the ENG-323 co-located support-file heuristic"
```

---

## Manual acceptance gate (not an automated test)

After the branch is green, the ticket's SMOKE acceptance ("a check that needs a support file still resolves once declared") is validated live via the styre-bench `ONLY=<id>` option against a single Python instance. This is the same manual gate used for axis 1; it is not part of the automated suite.

---

## Self-review notes

- **Spec coverage:** design §2 Half A (delete `isCheckSupportFile` + helpers, commit-scope clause, run-dispatch plumbing, ENG-323 tests, checks.md line) → Task 3. §3.1 package-init + conftest matching → Task 1. §3.2 excerpt → Task 1. §3.3 richer message + INV-B → Task 2. §3.4 masquerade-stop (implicated → uncovered → not persisted) → Task 2 handler test. §4 tests → Tasks 1-2 (incl. the critical `a/b/__init__.py` + `No module named 'b'` no-false-reject). §6 residuals → documented in `packageInitImplicated`'s comment.
- **Type consistency:** `importErrorImplicatesDiscarded(rawOutput, discarded)` and `collectionErrorExcerpt(rawOutput)` are named identically across Tasks 1-2; `CommitScope` becomes two-arg consistently across `commit-scope.ts` + `run-dispatch.ts` (Task 3).
- **Ordering:** Task 1 (primitives) → Task 2 (handler consumes them) → Task 3 (deletion). All land in one PR.

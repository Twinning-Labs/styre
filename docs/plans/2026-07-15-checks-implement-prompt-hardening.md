# ENG-297 — checks/implement prompt hardening + resolver-norm Minor — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Lower the frequency of two checks-agent slips (RED-first path mis-declaration, scratch-file spree) by hardening `prompts/checks.md` and `prompts/implement.md`, and close the deferred `check-path.ts` resolver-normalization Minor.

**Architecture:** Three independent changes. Part C is a pure-TS fix (hoist a shared `normPath` into `check-path.ts`, normalize the resolver fallback, swap `commit-scope.ts` to import it). Parts A and B are prompt-wording edits, each TDD-anchored by a template-assertion test (`prompts/*.md` are imported as text via `with { type: "text" }`, so editing the `.md` updates the compiled template the test asserts on). Tasks are order-independent; execute C → A → B.

**Tech Stack:** TypeScript, Bun (`bun test`), Biome (`bun run lint`). Prompt templates are markdown imported as text in `src/dispatch/prompt-vars.ts`.

## Global Constraints

- **Prompt-wording changes only in Parts A/B** — no change to RED-first semantics, gate order, or the scope-guard *behavior* (the guard still rejects undeclared new files; only the prompt's framing changes).
- **Part A must NOT drop test-command discoverability** — `styre_checks/` is a subdirectory *of the test root the component's test command already discovers*, not an override of discovery.
- **Scratch redirect is file-placement guidance, not an executable sandbox** — the agent's Bash is scoped to the profile's runner commands; the prompt says "keep scratch out of the work tree," it does not promise a runnable `/tmp` sandbox.
- **Part C returns the git-form *added* path** (not the raw declared string) — that value is stored as `ac_check.test_path` and later read verbatim via git by `check-integrity.ts` / `post-implement-rerun.ts` / `feedback.ts`.
- **Part C is scoped to the fallback only** — do NOT normalize inside `matchAuthoredTest`; its `addedPaths` are always git-clean.
- **Verification before every commit:** `bunx tsc --noEmit`, the named `bun test` file(s), AND `bun run lint` (Biome — enforces `noNonNullAssertion`, `useTemplate`, formatting; tsc+test passing does NOT imply lint passes).
- **Every commit message ends with:**
  ```
  Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01U6QL6JTMgv66PKAbFe4uk7
  ```

---

## File Structure

- `src/dispatch/check-path.ts` — pure path resolver (Part C: add `normPath`, normalize fallback).
- `src/dispatch/commit-scope.ts` — scope guards (Part C: import `normPath`, delete local `norm`).
- `test/dispatch/check-path.test.ts` — unit tests (Part C: add normalization cases).
- `prompts/checks.md` — checks-agent prompt (Part A: pin path + scratch redirect + narrow `new_files`).
- `test/dispatch/checks-prompt.test.ts` — checks template assertions (Part A: rewrite the "escape hatch" test).
- `prompts/implement.md` — implement-agent prompt (Part B: scratch redirect + narrow `new_files`).
- `test/dispatch/prompt-vars.test.ts` — implement template assertions (Part B: strengthen).

---

## Task 1 (Part C): resolver-fallback normalization + shared `normPath`

**Files:**
- Modify: `src/dispatch/check-path.ts` (add `normPath`; rewrite `resolveAuthoredTestPath` fallback)
- Modify: `src/dispatch/commit-scope.ts:1,11,18-19,32-33,36` (import `normPath`, delete local `norm`, rename call sites)
- Test: `test/dispatch/check-path.test.ts` (add cases)

**Interfaces:**
- Produces: `export function normPath(p: string): string` in `check-path.ts` — `p.replace(/\\/g, "/").replace(/^\.\//, "")`.
- `resolveAuthoredTestPath(addedPaths, ident, acId, declaredTestFile)` signature unchanged; fallback now matches on normalized equality and returns the matching **added** path.

- [ ] **Step 1: Write the failing tests**

Add to the end of `test/dispatch/check-path.test.ts`, and add `normPath` to the existing import block (lines 2-7):

```ts
test("normPath strips a leading ./ and normalizes backslashes", () => {
  expect(normPath("./a/b.py")).toBe("a/b.py");
  expect(normPath("a\\b\\c.py")).toBe("a/b/c.py");
  expect(normPath("a/b.py")).toBe("a/b.py");
});

test("resolveAuthoredTestPath: (b') normalizes the declared path before the fallback and returns the git-form added path", () => {
  const added = ["pkg/separable_test.go"];
  // agent declared a leading ./ — git's added form has none; must still resolve, to the added form
  expect(resolveAuthoredTestPath(added, "ENG-1", 1, "./pkg/separable_test.go")).toBe(
    "pkg/separable_test.go",
  );
});
```

Update the import at the top of the file to include `normPath`:

```ts
import {
  canonicalCheckBase,
  isCanonicalCheckPath,
  matchAuthoredTest,
  normPath,
  resolveAuthoredTestPath,
} from "../../src/dispatch/check-path.ts";
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test test/dispatch/check-path.test.ts`
Expected: FAIL — `normPath` is not exported (import error) and/or the `./`-prefix case returns `null`.

- [ ] **Step 3: Implement `normPath` and normalize the fallback**

In `src/dispatch/check-path.ts`, add `normPath` (place it just below the `basename` helper, before `isCanonicalCheckPath`):

```ts
/** Normalize a path for comparison: backslashes → forward slashes, strip a leading `./`.
 *  The single source of this rule — the commit scope guard imports it so guard and resolver agree. */
export function normPath(p: string): string {
  return p.replace(/\\/g, "/").replace(/^\.\//, "");
}
```

Replace the body of `resolveAuthoredTestPath` (currently lines 46-56) with:

```ts
export function resolveAuthoredTestPath(
  addedPaths: string[],
  ident: string,
  acId: number,
  declaredTestFile: string,
): string | null {
  const canonical = matchAuthoredTest(addedPaths, ident, acId);
  if (canonical !== null) return canonical;
  const target = normPath(declaredTestFile);
  return addedPaths.find((p) => normPath(p) === target) ?? null;
}
```

Update the doc comment above `resolveAuthoredTestPath` clause (b) to note normalization:

```ts
/** The authoritative test path for `acId`: (a) the canonically-named committed file (divergence-proof
 *  override); else (b) the declared path if it was itself committed — compared after `normPath` so a
 *  `./`-prefixed or backslashed declaration still matches, returning git's added form; else (c) `null`. */
```

- [ ] **Step 4: Run the Part-C tests to verify they pass**

Run: `bun test test/dispatch/check-path.test.ts`
Expected: PASS (all cases, including the two new ones and the unchanged (a)/(b)/(c) cases).

- [ ] **Step 5: Swap `commit-scope.ts` to the shared `normPath`**

In `src/dispatch/commit-scope.ts`:

Change the import on line 1 from:

```ts
import { isCanonicalCheckPath } from "./check-path.ts";
```

to:

```ts
import { isCanonicalCheckPath, normPath } from "./check-path.ts";
```

Delete the local definition on line 11:

```ts
const norm = (p: string): string => p.replace(/\\/g, "/").replace(/^\.\//, "");
```

Replace **every remaining `norm` identifier with `normPath`** — all 6 usages, which include two bare callback references `.map(norm)` (lines 18 and 33) that are NOT written as `norm(` calls; if you rename only `norm(` calls you will leave `.map(norm)` dangling and `tsc` will error on an undefined `norm`. The usages are: the `implementScope` predicate at lines 18-19, and the `checksScopeFor` block at lines 32-33 and 36. After the change those lines read:

```ts
  const declared = new Set(parsed.ok ? parsed.value.new_files.map(normPath) : []);
  return (path, isNew) => !isNew || declared.has(normPath(path));
```

```ts
    const declared = new Set<string>([
      ...parsed.value.checksAuthored.map((c) => normPath(c.test_file)),
      ...parsed.value.new_files.map(normPath),
    ]);
    return (path, isNew) =>
      !isNew || declared.has(normPath(path)) || isCanonicalCheckPath(normPath(path), ident, acIds);
```

- [ ] **Step 6: Verify — typecheck, the two suites, and lint**

Run: `bunx tsc --noEmit`
Expected: no errors.

Run: `bun test test/dispatch/check-path.test.ts test/dispatch/commit-scope.test.ts`
Expected: PASS (commit-scope behavior is unchanged — `normPath` is byte-identical to the deleted `norm`).

Run: `bun run lint`
Expected: no Biome errors (no `!`, no string concat introduced).

- [ ] **Step 7: Commit**

```bash
git add src/dispatch/check-path.ts src/dispatch/commit-scope.ts test/dispatch/check-path.test.ts
git commit -m "fix(dispatch): normalize resolver fallback + share normPath (ENG-297)"
```

---

## Task 2 (Part A): `checks.md` — pin canonical path, redirect scratch, narrow `new_files`

**Files:**
- Modify: `prompts/checks.md:14-16` (path bullet), `:32-36` (scratch bullet), `:57-61` (new_files reporting)
- Test: `test/dispatch/checks-prompt.test.ts:18-25` (rewrite)

**Interfaces:**
- Consumes: `CHECKS_TEMPLATE` (exported from `src/dispatch/prompt-vars.ts`, = the text of `prompts/checks.md`).

- [ ] **Step 1: Rewrite the failing assertion test**

Replace the test at `test/dispatch/checks-prompt.test.ts:18-25` (the "forbids leftover scratch … escape hatch" test) with:

```ts
test("checks prompt pins the canonical written==declared path and keeps scratch out of the work tree", () => {
  const t = CHECKS_TEMPLATE.toLowerCase();
  // Canonical RED-first path is pinned (not a soft e.g.), and declared MUST equal written.
  expect(t).toContain("styre_checks/");
  expect(t).toMatch(/byte-identical|character for character/); // declared == written path
  // Scratch is redirected OUT of the work tree, not parked in new_files.
  expect(t).toMatch(/\$tmpdir|\/tmp|outside the repository/);
  expect(t).toContain("reject"); // guard still rejects undeclared new files
  expect(t).toContain("new_files"); // retained, now scoped to genuine helpers only
});
```

Leave the other two tests in the file (`:4` observable-assertion, `:10` RED-first/`vacuous`/verdict) unchanged — Part A does not touch the prompt lines they assert.

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test test/dispatch/checks-prompt.test.ts`
Expected: the new test FAILS (current prompt has no `byte-identical`/`character for character` phrasing and no `$TMPDIR`/`/tmp`); the other two tests still PASS.

- [ ] **Step 3: Edit `prompts/checks.md` — the path bullet (lines 14-16)**

Replace:

```
- Put the file where this component's test command discovers it, with a framework-appropriate name that
  will not collide (include the ticket ident, e.g. `…/styre_checks/{{ident}}_ac<id>_test.<ext>`). For Go
  or Rust, give the file its own package/module directory.
```

with:

```
- **Write the file at the canonical path** `<test-root>/styre_checks/{{ident}}_ac<id>_test.<ext>`, where
  `<test-root>` is a directory this component's test command already discovers. The `styre_checks/`
  subdirectory only selects *where under the discovered root* — it does NOT override discovery: if your
  location is not picked up by the test command, the RED-first self-check below will ERROR
  (collection/import) instead of failing on the assertion, which means the placement is wrong — fix it.
  Use the stack-appropriate extension; for Go or Rust give the file its own package/module directory under
  that path.
- **Declare the byte-identical path you wrote.** The `test_file` you report in `checksAuthored` (below)
  MUST be exactly the repo-relative path you created — the same string, character for character, with no
  dropped or added path segment (do not omit `styre_checks/`) and no leading `./`. A declared path that
  differs from the written path is a defect.
```

- [ ] **Step 4: Edit `prompts/checks.md` — the scratch bullet (lines 32-36)**

Replace:

```
- **Do NOT leave throwaway, debug, or reproduction files behind.** If you write a scratch script to
  understand the bug or try out an assertion, delete it before you finish. The commit is REJECTED if it
  contains any NEW file you did not declare — your check files (listed in `checksAuthored` via
  `test_file`) plus any genuine non-test helper (listed in `new_files`, below) — and you will have to
  redo this step.
```

with:

```
- **Keep scratch OUT of the work tree.** Do any bug-reproduction, debugging, or throwaway scripting
  outside the repository — under `$TMPDIR` or `/tmp` — or do not create it at all. Never write repro/
  debug/scratch files into the work tree "to delete later," and never park them in `new_files`. The
  commit is REJECTED if it contains any NEW file you did not declare — your check files (listed in
  `checksAuthored` via `test_file`) plus any genuine non-test helper (listed in `new_files`, below) — so
  the only correct outcome is: check files declared, real helpers declared, and nothing else added.
```

- [ ] **Step 5: Edit `prompts/checks.md` — the new_files reporting note (lines 57-61)**

Replace:

```
Report, per check: the acceptance-criterion `ac_id` it targets, the repo-relative `test_file` you created,
and the `test_name` (function/case name) you wrote. Report no selector and no result. If — and only if — a
check genuinely needs a NEW non-test helper (a fixture / `conftest.py`), list its repo-relative path in
`new_files`; your test files are already declared via `test_file` and must NOT be repeated there. Otherwise
leave `new_files` empty.
```

with:

```
Report, per check: the acceptance-criterion `ac_id` it targets, the repo-relative `test_file` you created,
and the `test_name` (function/case name) you wrote. Report no selector and no result. If — and only if — a
check genuinely needs a NEW non-test helper (a fixture / `conftest.py`) — never a reproduction or debug
script — list its repo-relative path in `new_files`; your test files are already declared via `test_file`
and must NOT be repeated there. Otherwise leave `new_files` empty.
```

- [ ] **Step 6: Run the checks-prompt test to verify it passes**

Run: `bun test test/dispatch/checks-prompt.test.ts`
Expected: all three tests PASS.

- [ ] **Step 7: Verify the wider prompt suite + lint**

Run: `bun test test/dispatch/prompt-vars.test.ts test/dispatch/checks-prompt.test.ts`
Expected: PASS (no other test asserts the reworded checks.md lines).

Run: `bun run lint`
Expected: no Biome errors.

- [ ] **Step 8: Commit**

```bash
git add prompts/checks.md test/dispatch/checks-prompt.test.ts
git commit -m "fix(checks): pin canonical RED-first path + redirect scratch out of tree (ENG-297)"
```

---

## Task 3 (Part B): `implement.md` — redirect scratch, narrow `new_files`

**Files:**
- Modify: `prompts/implement.md:20-30` (scratch bullet + new_files intro)
- Test: `test/dispatch/prompt-vars.test.ts:244-248` (strengthen)

**Interfaces:**
- Consumes: `IMPLEMENT_TEMPLATE` (exported from `src/dispatch/prompt-vars.ts`, = the text of `prompts/implement.md`).

- [ ] **Step 1: Strengthen the failing assertion test**

Replace the test at `test/dispatch/prompt-vars.test.ts:244-248` (`"implement prompt instructs new_files declaration + scratch prevention"`) with the test below. Note the last matcher is the **strict `/\$tmpdir|\/tmp/`** — NOT one that also allows "outside the repository": the current prompt already says "keep it outside the repository," so a looser matcher would pass today and would not be RED-first. We are asserting the new *explicit out-of-tree* redirect.

```ts
test("implement prompt instructs new_files declaration + scratch prevention", () => {
  expect(IMPLEMENT_TEMPLATE).toContain("new_files");
  expect(IMPLEMENT_TEMPLATE.toLowerCase()).toContain("do not leave");
  expect(IMPLEMENT_TEMPLATE).toContain("```styre-sidecar");
  // scratch is redirected to an explicit out-of-tree location (not merely "deleted later")
  expect(IMPLEMENT_TEMPLATE.toLowerCase()).toMatch(/\$tmpdir|\/tmp/);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test test/dispatch/prompt-vars.test.ts`
Expected: FAIL on the `/\$tmpdir|\/tmp/` matcher — current implement.md names no `$TMPDIR`/`/tmp` location.

- [ ] **Step 3: Edit `prompts/implement.md` — scratch bullet + new_files intro (lines 20-30)**

Replace:

```
Do NOT leave throwaway, debug, or reproduction files in the repository. If you write a script to
reproduce the bug or exercise your change, delete it — or keep it outside the repository — before you
finish. The commit is REJECTED if it contains any file you did not declare below, and you will have to
redo the change.

For every NEW file that is a genuine part of the fix, list its repo-relative path in a sidecar block
at the very end of your output:
```

with:

```
Do NOT leave throwaway, debug, or reproduction files in the repository. Do any bug-reproduction or
debugging scripting outside the repository — under `$TMPDIR` or `/tmp` — or do not create it at all;
never write scratch into the work tree "to delete later." The commit is REJECTED if it contains any
file you did not declare below, and you will have to redo the change.

For every NEW file that is a genuine part of the fix, list its repo-relative path in a sidecar block
at the very end of your output. `new_files` is ONLY for real deliverables of the fix (source, its
tests, a needed fixture) — never a reproduction or debug script:
```

Leave lines 28-32 (the sidecar block and the "only edits existing files" note) unchanged.

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test test/dispatch/prompt-vars.test.ts`
Expected: PASS — `do not leave`, `new_files`, ` ```styre-sidecar `, and `$TMPDIR`/`/tmp` all present.

- [ ] **Step 5: Verify typecheck + lint**

Run: `bunx tsc --noEmit`
Expected: no errors.

Run: `bun run lint`
Expected: no Biome errors.

- [ ] **Step 6: Commit**

```bash
git add prompts/implement.md test/dispatch/prompt-vars.test.ts
git commit -m "fix(implement): redirect scratch out of tree + narrow new_files (ENG-297)"
```

---

## Final Verification (after all tasks)

- [ ] Run the full dispatch suite: `bun test test/dispatch/`
- [ ] `bunx tsc --noEmit` clean, `bun run lint` clean.
- [ ] Whole-branch review (opus) via superpowers:requesting-code-review, then superpowers:finishing-a-development-branch.

# Completeness name-reconciliation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the completeness gate from false-flagging "under-delivered" when correct work lands at a path the design agent could not name exactly — by matching declared `files_to_touch` entries against the actual diff with placeholder-aware wildcards, and by having design declare only implement-authored artifacts (not the checks-owned verification test).

**Architecture:** Two changes, no schema/handler change. (1) `reconcileScope` in `src/dispatch/completeness.ts` (a pure function the completeness handler already calls) gains a `declaredMatches` matcher: token-free entries match exactly (today's behavior); entries containing `<token>` placeholders match by wildcard (each `<token>` → one path segment). (2) `prompts/design-extract.md` states the declaration stance: `files_to_touch` lists implement's outputs (code, docs, product tests) with `<token>` placeholders for un-nameable artifacts, and does **not** list the checks-owned verification test.

**Tech Stack:** TypeScript, Bun (`bun test`), embedded SQLite (unaffected here). Tests live under `test/` and run with `bun test`.

## Global Constraints

- No schema change. No change to `src/dispatch/handlers.ts`. `reconcileScope`'s signature stays `(declared: string[], cumulativeTouched: string[], ownTouched: string[]) => ScopeReconciliation`.
- Token-free declared paths MUST match by exact string equality — identical to current behavior — so the existing `completeness-e2e` suite and `completeness.test.ts` exact cases are unchanged.
- Placeholder token syntax: `<...>` (angle brackets, any inner text). Each token expands to `[^/]*` — a **single path segment**, non-slash. All other characters match literally (regex-escaped); the whole path is anchored `^…$`.
- A declared entry with a literal `<` but no closing `>` has no token → treated as an exact literal.
- A placeholder that matches no diff file MUST remain in `under` (a required-but-absent artifact is a real gap).
- The verification (RED-first) test is NOT declared in `files_to_touch`; it is gated by the checks-postcondition + RED-first, unchanged.
- Do NOT reintroduce a registry-existence / `ac_check` check in completeness (considered and dropped — redundant, breaks existing e2e tests). See design doc §6.

---

### Task 1: Wildcard placeholder matching in `reconcileScope`

**Files:**
- Modify: `src/dispatch/completeness.ts` (add `declaredMatches`; rewrite `reconcileScope` body)
- Test: `test/dispatch/completeness.test.ts` (add a `declaredMatches` describe block + wildcard `reconcileScope` cases)

**Interfaces:**
- Consumes: nothing new.
- Produces: `export function declaredMatches(declared: string, actual: string): boolean`. `reconcileScope(declared, cumulativeTouched, ownTouched): ScopeReconciliation` — signature unchanged; `under`/`over` now computed via `declaredMatches` instead of set membership.

- [ ] **Step 1: Write the failing tests**

Append to `test/dispatch/completeness.test.ts` (keep the existing imports; add `declaredMatches` to the import from `../../src/dispatch/completeness.ts`):

```ts
import { classifyDisposition, declaredMatches, reconcileScope } from "../../src/dispatch/completeness.ts";

describe("declaredMatches", () => {
  test("token-free entry matches by exact equality", () => {
    expect(declaredMatches("src/parse.ts", "src/parse.ts")).toBe(true);
    expect(declaredMatches("src/parse.ts", "src/other.ts")).toBe(false);
  });

  test("a <token> matches a single path segment", () => {
    const decl = "docs/changes/modeling/<id>.bugfix.rst";
    expect(declaredMatches(decl, "docs/changes/modeling/12907.bugfix.rst")).toBe(true);
    expect(declaredMatches(decl, "docs/changes/modeling/pr-4242.bugfix.rst")).toBe(true);
  });

  test("a <token> does NOT match across a / boundary", () => {
    const decl = "docs/changes/modeling/<id>.bugfix.rst";
    expect(declaredMatches(decl, "docs/changes/modeling/sub/12907.bugfix.rst")).toBe(false);
  });

  test("wrong literal around a token does not match", () => {
    const decl = "docs/changes/modeling/<id>.bugfix.rst";
    expect(declaredMatches(decl, "docs/changes/modeling/12907.feature.rst")).toBe(false);
  });

  test("multiple tokens in one path", () => {
    expect(declaredMatches("a/<x>/b/<y>.ts", "a/1/b/2.ts")).toBe(true);
    expect(declaredMatches("a/<x>/b/<y>.ts", "a/1/2/b/3.ts")).toBe(false);
  });

  test("a literal < with no closing > is an exact literal", () => {
    expect(declaredMatches("a<b.ts", "a<b.ts")).toBe(true);
    expect(declaredMatches("a<b.ts", "axb.ts")).toBe(false);
  });
});

describe("reconcileScope wildcard", () => {
  test("a placeholder entry is satisfied by its produced file (not under-delivered)", () => {
    const r = reconcileScope(
      ["docs/changes/modeling/<id>.bugfix.rst"],
      ["docs/changes/modeling/12907.bugfix.rst"],
      [],
    );
    expect(r.under).toEqual([]);
  });

  test("a placeholder that matches nothing stays under-delivered", () => {
    const r = reconcileScope(
      ["docs/changes/modeling/<id>.bugfix.rst"],
      ["src/other.ts"],
      [],
    );
    expect(r.under).toEqual(["docs/changes/modeling/<id>.bugfix.rst"]);
  });

  test("over is resolution-aware: the produced file of a placeholder is not over-delivery", () => {
    const r = reconcileScope(
      ["<id>.bugfix.rst"],
      ["12907.bugfix.rst"],
      ["12907.bugfix.rst"],
    );
    expect(r.over).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test test/dispatch/completeness.test.ts`
Expected: FAIL — `declaredMatches` is not exported (import error), and the wildcard cases fail against the current exact-string `reconcileScope`.

- [ ] **Step 3: Implement `declaredMatches` and rewire `reconcileScope`**

In `src/dispatch/completeness.ts`, add `declaredMatches` above `reconcileScope`, and replace the body of `reconcileScope` (keep the existing doc comment and `classifyDisposition` untouched):

```ts
/** Does a declared `files_to_touch` entry match an actual produced path?
 *  A declared entry may contain `<token>` placeholders (angle brackets, any inner text) for an
 *  artifact whose exact name is not known at design time — e.g. a changelog fragment named by an
 *  unborn PR number: `docs/changes/modeling/<id>.bugfix.rst`. Each `<token>` matches exactly one
 *  path segment (`[^/]*`); every other character matches literally. A declared entry with no valid
 *  `<...>` token is matched by exact string equality (the pre-existing behavior). */
export function declaredMatches(declared: string, actual: string): boolean {
  if (!/<[^>]*>/.test(declared)) return declared === actual;
  const literals = declared.split(/<[^>]*>/g);
  const escaped = literals.map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const pattern = `^${escaped.join("[^/]*")}$`;
  return new RegExp(pattern).test(actual);
}

export function reconcileScope(
  declared: string[],
  cumulativeTouched: string[],
  ownTouched: string[],
): ScopeReconciliation {
  return {
    under: declared.filter((d) => !cumulativeTouched.some((t) => declaredMatches(d, t))),
    over: ownTouched.filter((t) => !declared.some((d) => declaredMatches(d, t))),
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test test/dispatch/completeness.test.ts`
Expected: PASS — all new cases plus the two pre-existing `reconcileScope` exact cases and the `classifyDisposition` cases.

- [ ] **Step 5: Run the completeness integration suite for no regression**

Run: `bun test test/dispatch/completeness-e2e.test.ts`
Expected: PASS unchanged — every unit there declares token-free paths, which still match by exact equality.

- [ ] **Step 6: Typecheck + lint**

Run: `bunx tsc --noEmit` (expect no NEW errors in `src/dispatch/completeness.ts`) and `bunx biome check --write src/dispatch/completeness.ts test/dispatch/completeness.test.ts`
Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add src/dispatch/completeness.ts test/dispatch/completeness.test.ts
git commit -m "fix(completeness): match declared files_to_touch with <token> placeholders"
```

---

### Task 2: Design-extract declaration stance

**Files:**
- Modify: `prompts/design-extract.md` (the `files_to_touch` bullet + a placeholder note by the changelog nudge)
- Verify (no edit): `src/dispatch/extract-schema.ts` — confirm `validateExtraction` does not require a test file in `files_to_touch`.

**Interfaces:**
- Consumes: nothing.
- Produces: prompt guidance only; no exported symbols.

- [ ] **Step 1: Confirm `validateExtraction` compatibility (read-only)**

Run: `grep -nE "files_to_touch|test|behavioral|≥1|at least one" src/dispatch/extract-schema.ts`
Expected observation: the only test-related rule is that a behavioral unit's `verify_check_types` must include `"test"` (it does NOT require a test file path in `files_to_touch`), and each unit must name ≥1 file. A behavioral code unit still names its code file, and a product-test unit still names its test files, so both satisfy "≥1 file" without declaring a verification test. No code change needed. If this observation does not hold, STOP and escalate — the stance change would need a schema adjustment not in this plan.

- [ ] **Step 2: Edit the `files_to_touch` bullet**

In `prompts/design-extract.md`, replace the line:

```
- **files_to_touch**: the files this unit is expected to change.
```

with:

```
- **files_to_touch**: the files this unit's implement step will create or change — production code, docs, and, when the ticket's deliverable *is* tests (e.g. a test-coverage ticket), the product test files. Do NOT list the behavioral regression/verification test that proves an acceptance criterion — `checks:dispatch` authors and names that test; you declare the need for it via `verify_check_types: ["test"]`, not as a file here. When an artifact's exact filename is not knowable at design time (e.g. a changelog fragment named by the not-yet-existing PR number), declare it with an angle-bracket placeholder for the unknown segment — e.g. `docs/changes/modeling/<id>.bugfix.rst` — the build system matches the placeholder against the file actually produced.
```

- [ ] **Step 3: Add a matching note at the changelog soft-gate nudge**

In `prompts/design-extract.md`, find the documentation soft-gate paragraph (contains "significant change warrants a doc note (README/changelog)"). Immediately after its sentence about setting `cdotImpact.documentation.applies: true`, append:

```
When you add a changelog/doc-fragment work unit whose filename encodes a value you cannot know yet (a PR or issue number), put an angle-bracket placeholder in its `files_to_touch` path (e.g. `docs/changes/<area>/<id>.bugfix.rst`) rather than guessing a literal number.
```

- [ ] **Step 4: Verify the prompt still parses in the design-extract tests**

Run: `bun test test/dispatch/design-extract.test.ts`
Expected: PASS — these tests exercise the extraction/validation logic, not the prose; the edits are additive prose and must not break them.

- [ ] **Step 5: Commit**

```bash
git add prompts/design-extract.md
git commit -m "docs(prompt): design declares implement outputs + <token> placeholders, not the verification test"
```

---

## Self-Review

**1. Spec coverage** (design doc §3):
- Wildcard matcher for `under` and `over`, single-segment tokens, exact for token-free → Task 1. ✓
- `over` resolution-aware → Task 1 (same matcher). ✓
- Placeholder-matches-nothing stays `under` → Task 1 Step 1 test. ✓
- Design declares implement outputs incl. product tests; not the verification test; placeholders for un-nameable → Task 2. ✓
- No handler change / no schema change → both tasks respect the Global Constraints; `reconcileScope` signature preserved. ✓
- Registry check NOT reintroduced → not present in either task; called out in Global Constraints. ✓

**2. Placeholder scan:** No "TBD"/"handle edge cases"/vague steps — every code step shows complete code; every run step shows the command + expected result. ✓

**3. Type consistency:** `declaredMatches(declared: string, actual: string): boolean` is defined in Task 1 and used only there. `reconcileScope`'s signature and `ScopeReconciliation` shape are unchanged, so the completeness handler and existing callers compile without edit. ✓

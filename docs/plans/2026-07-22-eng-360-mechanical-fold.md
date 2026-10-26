# Language Stack Registry — Mechanical Fold Implementation Plan (ENG-360)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrate the remaining scattered per-ecosystem tables onto `src/dispatch/stack-registry.ts`, adding each registry field alongside the consumer that reads it.

**Blocked by:** ENG-344 — the registry module and the preflight fix must land first. This plan assumes `src/dispatch/stack-registry.ts` exists with `STACKS`, `stackFacts`, `isModeledKind` and its boundary tests (including the literal `SNAPSHOT`).

**Sibling, independent — either order:** ENG-361 (stop persisting `extensions`; derive it and `SOURCE_EXTS` from the registry; `schemaVersion` 3 → 4). It touches no file this plan touches.

**Architecture:** Each task adds its field(s) to `StackFacts` *and* re-points its consumer in the same commit, so no field is ever speculative (the ticket's rule: don't add fields nothing reads). Every field addition also updates the literal `SNAPSHOT` in `test/dispatch/stack-registry.test.ts` — that is deliberate, not friction: the snapshot is the load-bearing boundary assertion, and changing an ecosystem fact should require a reviewable double entry.

**Split rationale:** ENG-344 originally carried all of this. Three independent adversarial reviews found it violated the one-concern rule (`CLAUDE.md`; `docs/architecture/ticket-template.md:309-312`, which cites ENG-332 as the exemplar of an independently-shippable ticket): 11 tasks across `cli`/`dispatch`/`setup` shipping five independent behavior changes in four unrelated subsystems — five independent revert reasons in one PR. This plan carries the pure-refactor remainder.

**Land ENG-358 first if you can.** `MANIFEST_BASENAMES` (`provision.ts:192`) omits `Gemfile`/`composer.json`, so a mid-run Ruby/PHP dependency edit never re-arms provision. That is a ~2-line fix needing no registry. If it has landed, **this plan is a pure refactor with no behavior change** except the one noted in Task 4. If it has not, Task 3 silently carries the bug fix and this plan stops being reviewable as a no-op.

## Global Constraints

- **Never commit to `main`.** Branch with the `refactor/` prefix. No `gh pr merge`, ever.
- **Every task ends green with `bun run format && bun run lint && bun run typecheck && bun test`** — all four. `bun run lint` is `biome check .` (no `--write`) and the repo enforces `lineWidth: 100` + `organizeImports`, so hand-wrapped pasted code FAILS lint unless formatted first. `bun run typecheck` is what CI runs (`.github/workflows/ci.yml:18`); Biome does not type-check and `bun test` strips types, so a duplicate import or type slip commits green and explodes in CI later.
- **Import placement and order.** Biome sorts specifiers naturally, so `"bun:test"` sorts BEFORE `"node:fs"`. Never add an import mid-file — merge into the existing import statement for that module.
- **The registry holds no functions, getters, or class instances.** Strings, booleans, and readonly arrays of strings only. This is what keeps the `runtime-deps` parser functions out in Task 6. Do not weaken the boundary tests to make a task easier — if a task seems to need a function in the table, the logic belongs in the consumer.
- **Update the `SNAPSHOT` whenever you add a field.** Regenerate it, don't hand-edit:
  `bun -e 'import("./src/dispatch/stack-registry.ts").then(m => console.log(JSON.stringify(m.STACKS, null, 2)))'`
- **Do NOT touch** `src/dispatch/check-selector.ts` or `check-rules.ts:347` (`CHECK_RULES`) — framework-keyed, and PR 2's job. Do NOT touch `src/dispatch/components.ts` or `check-rules.ts:4` (`SOURCE_EXTS`) — ENG-361's job.
- **Do NOT add `checkFrameworks` or `testFilePattern`** to `StackFacts`. Both are PR 2 fields with no consumer here.
- **Conditional detector logic is out of scope.** Do not modify `src/setup/lang/*.ts` in any task.
- Commit messages: conventional-commit with a scope, e.g. `refactor(dispatch): …`, ending with:
  ```
  Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01BBT2nDt4wFTDrk5MDcHQB8
  ```

## File Structure

| File | Status | Responsibility |
|---|---|---|
| `src/dispatch/stack-registry.ts` | modify | Gains `installMarkers`, `installOutputDir`, `manifests`, `manifestPatterns`, `interpreters`, `detectAnchors`, `ignoreDirs`, `GENERIC_IGNORE_DIRS` |
| `src/dispatch/provision.ts` | modify | Markers, install dir, manifests, interpreters from the registry (Tasks 1-3) |
| `src/setup/manifests.ts` | modify | `SKIP` derived (Task 4) |
| `src/dispatch/worktree.ts` | modify | `SWEEP_SKIP_DIRS` derived (Task 4) |
| `src/setup/detect-components.ts` | modify | Detect anchors derived (Task 5) |
| `src/setup/runtime-deps/collect.ts` | modify | Rows bound to registry kinds; parsers stay local (Task 6) |
| `docs/architecture/conventions.md` | modify | Updated as fields land (Task 7) |


---

### Tasks 3 and 4 — MOVED to ENG-361

The `EXTENSIONS_BY_KIND` fold and the `SOURCE_EXTS` derivation that stood here have moved to **ENG-361 — stop persisting component file extensions in profile.json (schemaVersion 4)**.

**Why they moved.** They would have built the wrong thing first. Both tasks kept `Component.extensions` as a field materialized into `profile.json` at setup time and merely changed *where the value came from*. But `profile.json` travels to CI runners and fleet workers while the registry is read live from the running binary — so the same fact would have existed in two places with different lifecycles, and adding an extension to the registry would leave deployed profiles routing without it. That is the bug class this whole effort exists to delete, recreated by it.

The operator chose to remove the second copy outright rather than document an invariant against it, so `extensions` is deleted from the profile schema and derived at the point of use. Doing the fold here first would mean building the persisted version and undoing it days later.

ENG-361 also absorbs the `SOURCE_EXTS` derivation, since it is the same fact.

**Sequencing:** ENG-361 and this plan are independent of each other; both depend only on ENG-344. Either order works.

---


### Task 1: `isComponentReady` reads markers from the registry

**Files:**
- Modify: `src/dispatch/provision.ts:14-50`
- Test: `test/dispatch/provision.test.ts`

**Interfaces:**
- Consumes: `stackFacts` (from ENG-344).
- Produces: adds `installMarkers`, `installOutputDir`, `manifests` to `StackFacts`. `isComponentReady(kind, compAbsDir)` keeps its signature.
- **This task introduces `import { stackFacts } from "./stack-registry.ts";` into `provision.ts`** — Tasks 2 and 3 widen that same import rather than adding new ones.

- [ ] **Step 1: Write the failing test**

Add to `test/dispatch/provision.test.ts`, reusing the file's existing `mkdtempSync`/`roots[]`/`afterAll` fixture convention:

```ts
test("readiness generalizes by marker presence, not a node/sveltekit kind check", () => {
  const dir = mkdtempSync(join(tmpdir(), "styre-ready-"));
  roots.push(dir);
  mkdirSync(join(dir, "node_modules"), { recursive: true });
  writeFileSync(join(dir, "package.json"), "{}");
  writeFileSync(join(dir, "node_modules", ".package-lock.json"), "{}");

  expect(isComponentReady("node", dir)).toBe(true);
  expect(isComponentReady("sveltekit", dir)).toBe(true);
  // Kinds with no install markers are never "ready" — they always re-install.
  expect(isComponentReady("python", dir)).toBe(false);
  expect(isComponentReady("php", dir)).toBe(false);
  expect(isComponentReady("go", dir)).toBe(false);
  expect(isComponentReady("elixir", dir)).toBe(false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/dispatch/provision.test.ts`
Expected: PASS at this point — today's kind check happens to give the same answers. That is the point: this test pins the behavior BEFORE the refactor so Step 3 cannot silently change it. Proceed.

- [ ] **Step 3: Rewrite using registry facts**

In `src/dispatch/provision.ts`, delete `NODE_INSTALL_MARKERS` (line 18) and `NODE_MANIFEST_FILES` (line 22) with their doc comments, add the import, and replace `isComponentReady`:

```ts
import { stackFacts } from "./stack-registry.ts";
```

```ts
/** Is this component's dependency install already complete? **Content-aware** per ecosystem: ready
 *  iff one of the kind's `installMarkers` exists under its `installOutputDir` AND that marker's
 *  mtime is >= the newest mtime among the kind's `manifests` present in `compAbsDir`. A manifest
 *  edited (loopback dependency change) after the last install makes the marker stale → not ready →
 *  `planProvision` reinstalls, closing the silent no-op where a later manifest touch reset
 *  `provision` to pending but the marker still read "ready".
 *
 *  A kind with no `installMarkers` (python, php, ruby, and every no-install kind) is never ready, so
 *  it always re-installs — correct for python, where the guarantee comes from the post-install
 *  worktree-source check instead. Before ENG-344 this was a hardcoded `kind !== "node" &&
 *  kind !== "sveltekit"`; the marker list IS the fact, so the check now generalizes. */
export function isComponentReady(kind: string, compAbsDir: string): boolean {
  const facts = stackFacts(kind);
  if (facts.installMarkers.length === 0 || facts.installOutputDir === undefined) return false;

  const outDir = join(compAbsDir, facts.installOutputDir);
  const markerMtimes = facts.installMarkers
    .map((m) => join(outDir, m))
    .filter((p) => existsSync(p))
    .map((p) => statSync(p).mtimeMs);
  if (markerMtimes.length === 0) return false;
  const freshestMarkerMtime = Math.max(...markerMtimes);

  const manifestMtimes = facts.manifests
    .map((f) => join(compAbsDir, f))
    .filter((p) => existsSync(p))
    .map((p) => statSync(p).mtimeMs);
  if (manifestMtimes.length === 0) return true; // no manifest present to compare against

  return freshestMarkerMtime >= Math.max(...manifestMtimes);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test test/dispatch/provision.test.ts`
Expected: PASS, including the pre-existing yarn/pnpm marker tests and the mtime-staleness tests. Those are the regression surface — they must not change.

**Then verify the refactor actually happened.** This task has zero observable behavior delta, so a subagent that writes the test, sees green, and never edits `provision.ts` also produces a green branch. Run:

```bash
grep -n 'kind === "node"\|kind !== "node"\|kind === "sveltekit"' src/dispatch/provision.ts || true
```
Expected: no output. Non-empty means the rewrite was skipped.

- [ ] **Step 5: Lint and commit**

```bash
bun run lint && bun test
git add src/dispatch/provision.ts test/dispatch/provision.test.ts
git commit -m "refactor(provision): read install markers from the stack registry (ENG-344)

isComponentReady's hardcoded 'kind !== node && kind !== sveltekit' becomes
'this kind declares no install markers'. Same answers for all nine kinds;
the fact now lives in one place.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01BBT2nDt4wFTDrk5MDcHQB8"
```

---

### Task 2: `resolveInterpreter(kind)` reads the fallback order from the registry

**Files:**
- Modify: `src/dispatch/provision.ts:176-185`, `src/dispatch/check-selector.ts:394`
- Test: `test/dispatch/provision.test.ts`

**Interfaces:**
- Consumes: `stackFacts` from Task 1.
- Produces: `resolveInterpreter(kind: string): string` (new export). `resolvePythonInterpreter(): string` is retained as a thin wrapper — three call sites depend on it and its error string is asserted in tests.

- [ ] **Step 1: Write the failing test**

```ts
import { resolveInterpreter, resolvePythonInterpreter } from "../../src/dispatch/provision.ts";

test("resolveInterpreter('python') matches the legacy python3-then-python order", () => {
  expect(resolveInterpreter("python")).toBe(resolvePythonInterpreter());
  expect(["python3", "python"]).toContain(resolveInterpreter("python"));
});

test("a kind that declares no interpreter throws rather than guessing", () => {
  expect(() => resolveInterpreter("go")).toThrow(/no interpreter/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/dispatch/provision.test.ts`
Expected: FAIL — `resolveInterpreter` is not exported.

- [ ] **Step 3: Generalize the resolver**

Replace `resolvePythonInterpreter` in `src/dispatch/provision.ts`:

```ts
/** Resolve the interpreter for a kind: the first of its registry `interpreters` present on PATH.
 *  Never hardcodes a name. None present is a distinct provisioning-infra failure, so this throws
 *  (the caller escalates) rather than silently skipping a check or falling through to a bare,
 *  possibly-absent binary. */
export function resolveInterpreter(kind: string): string {
  const candidates = stackFacts(kind).interpreters;
  for (const candidate of candidates) {
    if (Bun.which(candidate)) return candidate;
  }
  throw new Error(
    candidates.length === 0
      ? `provision: kind "${kind}" declares no interpreter`
      : `provision: no ${candidates.join(" or ")} interpreter found on PATH`,
  );
}

/** The python interpreter for the source-check probe and the remediation reinstall (Fix D).
 *  Thin wrapper — the fallback order now lives in the stack registry. */
export function resolvePythonInterpreter(): string {
  return resolveInterpreter("python");
}
```

The thrown message for python is byte-identical to today's (`provision: no python3 or python interpreter found on PATH`), so any existing assertion on it still passes.

**Do NOT touch `check-selector.ts`.** An earlier draft changed its `binaryFor` pytest default to `opts?.interp ?? stackFacts("python").interpreters[0]`. All three reviewers flagged it: the expression evaluates to the literal `"python3"`, so it resolves nothing (unlike `resolveInterpreter`, which probes PATH); it existed only to manufacture a second consumer for `interpreters`; and it contradicts the Global Constraint that PR 1 leaves `check-selector.ts` alone. `binaryFor` is PR 2's job.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test test/dispatch/provision.test.ts`
Expected: PASS.

Note the Step-1 test must tolerate a machine with neither `python3` nor `python`, as `test/dispatch/provision.test.ts:214-222` already does — wrap in `try/catch` rather than asserting unconditionally, or a python-less CI container errors instead of skipping.

- [ ] **Step 5: Lint and commit**

```bash
bun run lint && bun test
git add src/dispatch/provision.ts test/dispatch/provision.test.ts
git commit -m "refactor(provision): read interpreter fallback order from the registry (ENG-344)

resolvePythonInterpreter becomes a wrapper over resolveInterpreter(kind).
Same order, same error string. The bare-pip/python portability follow-up
will consume this same field.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01BBT2nDt4wFTDrk5MDcHQB8"
```

---

### Task 3: `diffTouchesManifest` unions the registry's manifests

Fixes the live bug: `Gemfile` and `composer.json` never re-armed provision.

**Files:**
- Modify: `src/dispatch/provision.ts:187-216`
- Test: `test/dispatch/provision.test.ts`

**Interfaces:**
- Consumes: `STACKS` from Task 1.
- Produces: `diffTouchesManifest(changedPaths: string[]): boolean` — signature unchanged.

- [ ] **Step 1: Write the failing test**

```ts
test("a Gemfile or composer.json edit re-arms provision (spec §6.3)", () => {
  // Both ecosystems are prepare-bearing, so missing them meant a mid-run
  // dependency change silently skipped the reinstall.
  expect(diffTouchesManifest(["Gemfile"])).toBe(true);
  expect(diffTouchesManifest(["Gemfile.lock"])).toBe(true);
  expect(diffTouchesManifest(["composer.json"])).toBe(true);
  expect(diffTouchesManifest(["composer.lock"])).toBe(true);
});

test("the union also covers the no-prepare ecosystems (cheap no-op re-arm)", () => {
  for (const p of ["Cargo.toml", "go.mod", "pom.xml", "build.gradle", "build.gradle.kts"]) {
    expect(diffTouchesManifest([p])).toBe(true);
  }
});

test("every manifest the old hardcoded set knew still matches", () => {
  for (const p of [
    "package.json", "package-lock.json", "yarn.lock", "pnpm-lock.yaml",
    "pyproject.toml", "setup.py", "setup.cfg", "poetry.lock", "Pipfile", "Pipfile.lock",
  ]) {
    expect(diffTouchesManifest([p])).toBe(true);
  }
});

test("requirements*.txt still matches by pattern, and is path-independent", () => {
  expect(diffTouchesManifest(["requirements.txt"])).toBe(true);
  expect(diffTouchesManifest(["requirements-dev.txt"])).toBe(true);
  expect(diffTouchesManifest(["apps/api/pyproject.toml"])).toBe(true);
});

test("a non-manifest file does not re-arm", () => {
  expect(diffTouchesManifest(["src/index.ts", "README.md"])).toBe(false);
  expect(diffTouchesManifest([])).toBe(false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/dispatch/provision.test.ts`
Expected: FAIL — `expected true, got false` for `Gemfile`, `composer.json`, `Cargo.toml`, `go.mod`, `pom.xml`, `build.gradle`.

- [ ] **Step 3: Derive the union**

In `src/dispatch/provision.ts`, replace `MANIFEST_BASENAMES` (lines 192-203) and `REQUIREMENTS_RE` (line 205):

```ts
/** Every dependency manifest/lockfile basename across all supported ecosystems, unioned from the
 *  stack registry. Before ENG-344 this was a hand-maintained set that omitted `Gemfile` and
 *  `composer.json` — both prepare-bearing — so a mid-run dependency edit in a Ruby or PHP repo
 *  never re-armed provision. */
const MANIFEST_BASENAMES: ReadonlySet<string> = new Set(
  Object.values(STACKS).flatMap((f) => [...f.manifests]),
);

/** Manifests a fixed basename can't express (python's `requirements*.txt` — pip's convention allows
 *  an arbitrary suffix), compiled from the registry's pattern sources. */
const MANIFEST_PATTERNS: readonly RegExp[] = [
  ...new Set(Object.values(STACKS).flatMap((f) => [...f.manifestPatterns])),
].map((src) => new RegExp(src));
```

Update `diffTouchesManifest` (line 211) to use the compiled patterns:

```ts
export function diffTouchesManifest(changedPaths: string[]): boolean {
  return changedPaths.some((p) => {
    const base = basename(p);
    return MANIFEST_BASENAMES.has(base) || MANIFEST_PATTERNS.some((re) => re.test(base));
  });
}
```

Add `STACKS` to the `stack-registry.ts` import added in Task 1.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test test/dispatch/provision.test.ts test/dispatch/checks-provision-reset.test.ts`
Expected: PASS.

- [ ] **Step 5: Lint and commit**

```bash
bun run lint && bun test
git add src/dispatch/provision.ts test/dispatch/provision.test.ts
git commit -m "fix(provision): re-arm on Gemfile/composer.json dependency edits (ENG-344)

MANIFEST_BASENAMES was hand-maintained and omitted Gemfile and
composer.json, both prepare-bearing — so an implement dispatch that added
a Ruby gem or PHP package never triggered the reinstall before verify.
Unioning the registry's per-kind manifests closes that and also picks up
the no-prepare ecosystems, where the re-arm is a cheap no-op because
planProvision emits nothing for a component without a prepare.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01BBT2nDt4wFTDrk5MDcHQB8"
```

---

### Task 4: Derive the repo-walk skip sets

**Files:**
- Modify: `src/setup/manifests.ts:4-21`, `src/dispatch/worktree.ts:255`
- Test: `test/setup/manifests.test.ts`, `test/dispatch/worktree.test.ts` (or wherever `sweepScratch` is covered — find with `grep -rln "sweepScratch" test/`)

**Interfaces:**
- Consumes: `STACKS`, `GENERIC_IGNORE_DIRS` from Task 1.
- Produces: `SKIP: ReadonlySet<string>` stays exported from `manifests.ts` with the same name and membership.

- [ ] **Step 1: Write the failing test**

Add to `test/setup/manifests.test.ts`:

`test/setup/manifests.test.ts:5` currently imports only `findManifests`. **Edit that line** to `import { SKIP, findManifests } from "../../src/setup/manifests.ts";` — a second mid-file import trips `organizeImports`.

```ts
test("SKIP membership is unchanged by the registry derivation", () => {
  // Set EQUALITY, not superset: SKIP prunes the walk, so an extra entry would
  // silently find fewer components (spec §6.5).
  expect([...SKIP].sort()).toEqual([
    ".git", ".gradle", ".mvn", ".nox", ".svelte-kit", ".tox", ".venv",
    "Pods", "__pycache__", "build", "dist", "node_modules", "target",
    "testdata", "vendor", "venv",
  ]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/setup/manifests.test.ts`
Expected: PASS — the literal set already matches. This pins membership before the refactor; Step 3 must keep it green. Proceed.

- [ ] **Step 3: Derive both sets**

In `src/setup/manifests.ts`, replace lines 1-21:

```ts
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { GENERIC_IGNORE_DIRS, STACKS } from "../dispatch/stack-registry.ts";

/** Directory names the manifest walk must not descend into: every ecosystem's vendored/build-output
 *  dirs, plus the ones belonging to no single ecosystem (`.git`, `dist`, `Pods`). Derived from the
 *  stack registry so adding a language brings its ignore dirs with it.
 *  `test/setup/manifests.test.ts` pins membership — this set PRUNES the walk, so an accidental
 *  addition would silently under-detect components. */
export const SKIP: ReadonlySet<string> = new Set([
  ...GENERIC_IGNORE_DIRS,
  ...Object.values(STACKS).flatMap((f) => [...f.ignoreDirs]),
]);
```

In `src/dispatch/worktree.ts`, add `import { STACKS } from "./stack-registry.ts";` **to the existing import block at the top of the file** (Biome's `organizeImports` errors on a mid-file import), then replace line 255 with:

```ts
/** Dirs `sweepScratch` must not descend into: VCS metadata plus every ecosystem's install output
 *  (`node_modules`, `vendor`). A `styre_scratch/` inside a dependency tree is not the worker's. */
const SWEEP_SKIP_DIRS = new Set([
  ".git",
  ...Object.values(STACKS)
    .map((f) => f.installOutputDir)
    .filter((d): d is string => d !== undefined),
]);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test test/setup/manifests.test.ts test/setup/detect-components.test.ts test/dispatch/worktree.test.ts`
Expected: PASS. The `SKIP` equality test failing means a kind's `ignoreDirs` is wrong — fix the registry entry in Task 1's file, never the assertion.

- [ ] **Step 5: Add the sweep behavior-delta test**

Add to the file covering `sweepScratch`:

```ts
test("sweepScratch does not descend into a vendored dependency tree", () => {
  const root = mkdtempSync(join(tmpdir(), "styre-sweep-"));
  roots.push(root);
  mkdirSync(join(root, "vendor", "acme", "styre_scratch"), { recursive: true });
  mkdirSync(join(root, "src", "styre_scratch"), { recursive: true });

  const removed = sweepScratch(root);
  expect(removed).toEqual(["src/styre_scratch"]);
  expect(existsSync(join(root, "vendor", "acme", "styre_scratch"))).toBe(true);
});
```

Run: `bun test test/dispatch/worktree.test.ts`
Expected: PASS.

- [ ] **Step 6: Lint and commit**

```bash
bun run lint && bun test
git add src/setup/manifests.ts src/dispatch/worktree.ts test/setup/manifests.test.ts test/dispatch/worktree.test.ts
git commit -m "refactor(setup): derive the repo-walk skip sets from the registry (ENG-344)

SKIP membership is unchanged (asserted by set equality — it prunes the
walk, so a superset would silently under-detect components). SWEEP_SKIP_DIRS
becomes .git plus every ecosystem's install output, which adds vendor:
sweepScratch no longer descends into a PHP dependency tree.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01BBT2nDt4wFTDrk5MDcHQB8"
```

---

### Task 5: Derive `TARGETED_LANG_MANIFESTS` from detect anchors

**Files:**
- Modify: `src/setup/detect-components.ts:59-64`
- Test: `test/setup/detect-components.test.ts`

**Interfaces:**
- Consumes: `STACKS` from Task 1 (already imported for `stackFacts` in Task 3).
- Produces: `unrootedManifestWarnings(repoDir: string): string[]` — signature and message strings unchanged.

- [ ] **Step 1: Write the failing test**

`test/setup/detect-components.test.ts` has **no `roots` array and no `afterAll`** — it uses a local `fixture(files)` helper (lines 7-15). Use that, and export `TARGETED_LANG_MANIFESTS` so the derivation itself is asserted:

```ts
// The behavioral test alone is BLIND: a wrong derivation using `.manifests`
// instead of `.detectAnchors` passes all 20 tests in this file, because the
// fixture writes Gemfile/composer.json — the FIRST element of both lists —
// and the loop breaks there. Assert the derived structure directly.
test("targeted-language manifests derive to exactly today's table", () => {
  expect(TARGETED_LANG_MANIFESTS).toEqual([
    ["jvm-maven", ["pom.xml"]],
    ["jvm-gradle", ["build.gradle", "build.gradle.kts"]],
    ["ruby", ["Gemfile"]],
    ["php", ["composer.json"]],
  ]);
});

test("a lockfile-only subdir produces NO warning (the .manifests mis-derivation)", () => {
  // Gemfile.lock is in ruby.manifests but NOT ruby.detectAnchors.
  expect(unrootedManifestWarnings(fixture({ "svc/Gemfile.lock": "" }))).toEqual([]);
});

test("unrooted-manifest warnings still cover the targeted languages", () => {
  const warnings = unrootedManifestWarnings(
    fixture({ "svc/Gemfile": "", "svc/composer.json": "{}" }),
  );
  expect(warnings.some((w) => w.includes("Gemfile") && w.includes("no ruby component"))).toBe(true);
  expect(warnings.some((w) => w.includes("composer.json") && w.includes("no php component"))).toBe(true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/setup/detect-components.test.ts`
Expected: PASS — behavior is already correct. This pins it before the refactor. Proceed.

- [ ] **Step 3: Derive the list**

In `src/setup/detect-components.ts`, replace lines 59-64. Add `STACKS` to the existing `stack-registry.ts` import:

```ts
/** The languages whose detection is root-only (§5.4), paired with their detect anchors from the
 *  stack registry. Node/rust/python/go do a bounded nested walk instead, so they need no warning.
 *  Kept as an explicit kind list — WHICH languages are root-only is a detector policy, not an
 *  ecosystem fact, so it does not belong in the registry. */
const TARGETED_LANG_KINDS = ["jvm-maven", "jvm-gradle", "ruby", "php"] as const;

export const TARGETED_LANG_MANIFESTS: Array<[string, readonly string[]]> = TARGETED_LANG_KINDS.map(
  (kind) => [kind, STACKS[kind].detectAnchors],
);
```

The loop at line 70 (`for (const [lang, names] of TARGETED_LANG_MANIFESTS)`) is unchanged.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test test/setup/detect-components.test.ts`
Expected: PASS, including the pre-existing `unrootedManifestWarnings` assertions.

- [ ] **Step 5: Lint and commit**

```bash
bun run lint && bun test
git add src/setup/detect-components.ts test/setup/detect-components.test.ts
git commit -m "refactor(setup): derive targeted-language manifests from detect anchors (ENG-344)

The manifest filenames come from the registry; WHICH languages are
root-only stays an explicit detector-policy list, since that is not an
ecosystem fact.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01BBT2nDt4wFTDrk5MDcHQB8"
```

---

### Task 6: Bind `runtime-deps` rows to registry kinds

The parser functions stay local — putting them in the registry would break the no-functions boundary. The mapping is *verified against* the registry rather than *derived from* it, because deriving is ambiguous: `package.json` appears in both `node.manifests` and `sveltekit.manifests`, so a file→kind union has no single answer.

**Files:**
- Modify: `src/setup/runtime-deps/collect.ts:17-31`
- Test: `test/setup/runtime-deps/collect.test.ts`

**Interfaces:**
- Consumes: `STACKS`, `stackFacts` from Task 1.
- Produces: the module-private `MANIFESTS` rows gain a `kind` field typed as a registry key; the emitted `Lang` label is unchanged (`"jvm"` stays coarse).

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, test } from "bun:test";
import { MANIFEST_ROWS } from "../../../src/setup/runtime-deps/collect.ts";
import { STACKS, isModeledKind } from "../../../src/dispatch/stack-registry.ts";

describe("runtime-deps rows are bound to the registry", () => {
  test("every row names a modeled kind", () => {
    for (const row of MANIFEST_ROWS) expect(isModeledKind(row.kind)).toBe(true);
  });

  test("every row's file is a manifest, anchor, or pattern of its kind", () => {
    for (const row of MANIFEST_ROWS) {
      const f = STACKS[row.kind];
      const known =
        f.manifests.includes(row.file) ||
        f.detectAnchors.includes(row.file) ||
        f.manifestPatterns.some((p) => new RegExp(p).test(row.file));
      expect(known ? null : `${row.file} is not a known manifest of ${row.kind}`).toBeNull();
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/setup/runtime-deps/collect.test.ts`
Expected: FAIL — `MANIFEST_ROWS` is not exported.

- [ ] **Step 3: Re-key the rows**

In `src/setup/runtime-deps/collect.ts`, replace lines 17-31:

```ts
/** The coarse label emitted in the enrichment output. Deliberately coarser than component `kind`:
 *  maven and gradle both surface as "jvm" to the prompt. */
type Lang = "node" | "rust" | "python" | "go" | "ruby" | "php" | "jvm";

/** Component kinds → the coarse output label. */
const LANG_FOR_KIND: Record<string, Lang> = {
  node: "node", rust: "rust", python: "python", go: "go",
  ruby: "ruby", php: "php", "jvm-maven": "jvm", "jvm-gradle": "jvm",
};

/** Which manifest a parser handles, and which registry kind it belongs to. The parser is a
 *  FUNCTION, so it cannot live in the stack registry (that module is data-only by construction —
 *  see its header). The `kind` field binds each row to the registry instead, and
 *  `test/setup/runtime-deps/collect.test.ts` asserts every `file` is a known manifest of its kind,
 *  so a registry rename cannot silently orphan a parser.
 *
 *  Not derived from the registry: `package.json` belongs to both `node` and `sveltekit`, so a
 *  file→kind union would be ambiguous. */
export const MANIFEST_ROWS: {
  file: string;
  kind: string;
  parse: (c: string) => string[];
}[] = [
  { file: "package.json", kind: "node", parse: parsePackageJson },
  { file: "Cargo.toml", kind: "rust", parse: parseCargoToml },
  { file: "pyproject.toml", kind: "python", parse: parsePyproject },
  { file: "requirements.txt", kind: "python", parse: parseRequirementsTxt },
  { file: "go.mod", kind: "go", parse: parseGoMod },
  { file: "Gemfile", kind: "ruby", parse: parseGemfile },
  { file: "composer.json", kind: "php", parse: parseComposerJson },
  { file: "pom.xml", kind: "jvm-maven", parse: parsePomXml },
  { file: "build.gradle", kind: "jvm-gradle", parse: parseBuildGradle },
  { file: "build.gradle.kts", kind: "jvm-gradle", parse: parseBuildGradle },
  { file: "libs.versions.toml", kind: "jvm-gradle", parse: parseGradleCatalog },
];

const MANIFESTS = MANIFEST_ROWS.map((r) => ({
  file: r.file,
  lang: LANG_FOR_KIND[r.kind] as Lang,
  parse: r.parse,
}));
```

Everything downstream of `MANIFESTS` is unchanged.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test test/setup/runtime-deps/`
Expected: PASS, including the pre-existing collect/parse tests — the emitted `lang` labels are byte-identical.

- [ ] **Step 5: Lint and commit**

```bash
bun run lint && bun test
git add src/setup/runtime-deps/collect.ts test/setup/runtime-deps/collect.test.ts
git commit -m "refactor(setup): bind runtime-deps manifest rows to registry kinds (ENG-344)

The parsers are functions, so they stay out of the data-only registry. The
rows now name a registry kind and a test asserts every file is a known
manifest of that kind, so a registry rename cannot orphan a parser. The
coarse 'jvm' output label is unchanged.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01BBT2nDt4wFTDrk5MDcHQB8"
```

---

### Task 7: Document the registry and verify the whole branch

**Files:**
- Modify: `docs/architecture/conventions.md`
- Verify: whole repo

**Interfaces:**
- Consumes: everything above.
- Produces: nothing consumed by later tasks.

- [ ] **Step 1: Confirm no table survived the migration**

```bash
grep -rn "EXTENSIONS_BY_KIND\|NODE_INSTALL_MARKERS\|NODE_MANIFEST_FILES" src/ test/ || true
```
Expected: exactly **one** hit — the stale doc comment at `src/setup/lang/types.ts:3` (`materialized from \`EXTENSIONS_BY_KIND\``). Fix that comment now to say "materialized from the stack registry". Any other hit is an un-migrated consumer.

(`|| true` again: `grep -r` exits 1 when it matches nothing.)

```bash
grep -rn 'kind === "node"\|kind !== "node"\|kind === "sveltekit"' src/dispatch/provision.ts
```
Expected: no output.

- [ ] **Step 2: Confirm the boundary still holds**

```bash
grep -cE "^\s*(import|const .* = require)" src/dispatch/stack-registry.ts || true
```
Expected: `0`. Note the `|| true`: `grep -c` **exits 1 on a zero count**, so without it the success case reads as a failed step.

This grep is a convenience only. The real guarantee is Task 1's literal-snapshot test (spec §5.2) — `grep` cannot see `Bun.file()`, `process.cwd()`, a dynamic `import()`, or a lazy getter, all of which reach repo state with no import statement.

- [ ] **Step 3: Document the extension point**

Append to `docs/architecture/conventions.md`:

```markdown
## The language stack registry

`src/dispatch/stack-registry.ts` is the single source of **invariant** per-ecosystem facts, keyed by
component `kind`: file extensions, detect anchors, ignore dirs, dependency manifests, install output
dir / bin dirs / provided tools / completeness markers, and interpreter fallback order. Detectors,
provision, the toolchain preflight, the repo walk, and the checks module all read from it, so a fact
cannot be true in one module and false in another.

**The boundary.** The module imports nothing and contains no functions. That is not style: a module
that cannot reach `node:fs` cannot branch on repo state, which turns "the registry holds no
repo-specific logic" into an assertion `test/dispatch/stack-registry.test.ts` actually checks.

**What does NOT go in it.** Anything conditional on a specific repo's contents: which package
manager it uses (lockfile scan), which test runner (tox/nox/pytest config scan), its python import
name (pyproject parse), which check framework its test command implies (a command sniff). Those stay
as detector logic. Adding a conditional to the registry is the failure mode it exists to prevent.

**Adding a language:** add a `StackFacts` entry, add a `LangDef` under `src/setup/lang/`, register it
in `src/setup/registry.ts`. Nothing else should need a new `kind` branch — if it does, that fact is
probably missing from the registry.

*(Framework-keyed check facts — `CHECK_RULES`, `binaryFor`, the selector and exit-code tables — move
into this module in a follow-up. `kind → framework` is 1:many resolved by a command sniff, so they
need a second key, not a merge into `StackFacts`.)*
```

- [ ] **Step 4: Full verification**

```bash
bun run lint && bun test && bun run build
```
Expected: lint clean, all tests pass, build produces the binary.

- [ ] **Step 5: Commit and push**

```bash
git add docs/architecture/conventions.md
git commit -m "docs(architecture): document the language stack registry (ENG-344)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01BBT2nDt4wFTDrk5MDcHQB8"
git push
```

---

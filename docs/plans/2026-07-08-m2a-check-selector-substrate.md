# M2a — the check-selector substrate (per-stack selector + coarse run-output reader + `ac_check` writer) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

Implements the **pure, agent-free, loop-free** half of M2 of
`docs/brainstorms/2026-07-08-change-scoped-verify-m2-checks-step-design.md` (v2). Read that design first
(especially §4 the zod contract, §5 identity + selector + coarse semantics, §9 recording + the vocab map).
Builds on M1 (`docs/plans/2026-07-08-m1-ac-identity-check-registry.md`): the `acceptance_criterion` /
`ac_check` schema and their repos are merged in `main`.

---

## Why M2 is split into M2a (this plan) + M2b

**Recommendation: split.** M2's design (§5, §12) is explicit that the largest net-new build is
**not** the resolver re-sequence — it is *"the per-stack selector constructor (all stacks) + …
selects-≥1 verification"* and the coarse `red`/`green`/`error` reader. That work is **pure string/
data logic over 7+ frameworks** (pytest, jest, vitest, go, cargo, JUnit-maven, JUnit-gradle, rspec,
minitest, phpunit) and is **unit-testable in complete isolation** — no agent, no git, no resolver,
no provisioned env. It mirrors M1's "data foundation first" shape exactly.

- **M2a (this plan) — the pure substrate.** Framework detection, the per-stack selector constructor,
  the per-stack coarse run-output reader (`green`/`red`/`error`/`selected-none`), the coarse→signal
  vocabulary map (§9), the zod sidecar contract (§4), and the two net-new `ac_check` repo functions
  (insert-with-result + `deleteByTicket` for resume-dedup, §9). Every deliverable is a pure function
  or a SQL-only repo call. No loop change; the full suite stays green because nothing wires it in yet.
- **M2b (outlined at the end) — the wiring.** Resolver re-sequence (hoist `provision`, insert
  `checks:dispatch`), the `checks:dispatch` handler (`deriveAndPersistAcs` at start + prompt +
  `prompt-vars` + allowlist + tier), added-file identity verification against the committed diff,
  RED-first in-suite execution, and the delete-then-insert persist transaction. M2b *consumes* every
  M2a function; building it first would mean stubbing all of them.

M2a is the smaller, self-contained, high-branch-count slice — the right thing to land and test first.

---

## Goal

Ship the pure decision core the M2b `checks:dispatch` handler will call: given a profile component
and an authored `(test_file, test_name)`, (1) detect the test framework, (2) construct the scoped
per-stack selector that runs **only** that one authored check, (3) read a completed run's exit state
into a **coarse** `green`/`red`/`error` verdict (plus a distinct `selected-none` identity-reject),
(4) map that coarse verdict to the `ground_truth_signal` `pass`/`fail`/`error` vocabulary, (5) validate
the agent's structured `checksAuthored[]` sidecar, and (6) persist an `ac_check` row **with** its
selector + coarse result and delete-then-insert a ticket's rows for resume-safety. No behavior change
to the running loop (M2b wires these in).

## Architecture

Two pure `src/dispatch/` modules + a small repo extension, layered `dispatch → repo` (never the
reverse):

- **`src/dispatch/check-selector.ts`** — the substrate. `CheckFramework` + `frameworkFor(component)`
  (detect from `kind` + the component's `test` command string); `buildCheckSelector(fw, {testFile,
  testName})` → `{ runArgs, precision }` (the framework-native selection tokens the runner appends to
  the framework binary); `interpretRunOutput(fw, run)` → `CoarseOrNone`
  (`"green"|"red"|"error"|"selected-none"`); and `signalResultForCoarse(coarse)` → `"pass"|"fail"|"error"`
  (the §9 vocab map, since `ground_truth_signal.result` has a `CHECK` that forbids `'red'`).
- **`src/dispatch/checks-schema.ts`** — the zod sidecar contract (§4), mirroring `extract-schema.ts`:
  `ChecksOutputSchema` = `{ checksAuthored: Array<{ac_id, test_file, test_name}> }`.
- **`src/db/repos/ac-check.ts`** (extend the merged M1 repo) — `insertAcCheck` gains an optional
  `redFirstResult`; add `deleteByTicket` (resume-dedup: M2b deletes-then-inserts in the persist txn).

## Tech Stack

TypeScript, Bun (`bun test`, `bun run typecheck`, `bun run lint`), embedded SQLite (`bun:sqlite`),
zod (already a dependency). No new dependencies.

## Global Constraints (M2 invariants — copied from the design + CLAUDE.md)

- **Ground truth over self-report (move 5).** The coarse verdict comes from the framework process's
  exit state (`interpretRunOutput`), never the agent's word. The agent reports only facts it authored
  (`ac_id`/`test_file`/`test_name`, §4) — never a selector (runner-constructed, §5.2) and never a
  verdict. `interpretRunOutput` is the ground-truth reader.
- **Single-writer SoT (B2).** Only the runner persists. `ac_check` writes are runner-side repo calls;
  no agent path reaches them.
- **The coarse buckets are pinned so M3 *subdivides*, not reclassifies (§5.4).** `green` = ran and
  passed; `red` = ran and did not pass **including an import/collection/absence signal**; `error` =
  could not attempt at all (env/launch/timeout). A framework that ran but **matched zero tests** is a
  distinct **`selected-none`** — the "selects-≥1" identity guard (§5.1); M2b treats it as a
  transport/identity reject (re-dispatch), NOT a recorded verdict. Keep these four separate.
- **The file floor is NOT universal (§5.2).** For file-addressable frameworks the authored file is
  its own scope (it contains only styre's check, guaranteed by M2b's added-file identity). Go operates
  on **packages** and Rust on the **crate** — no "run just this file" — so those selectors are
  package/crate-scoped + name-anchored (`-run '^name$'`, `--test <stem> -- --exact <name>`). The code
  must not pretend file-path universality.
- **Selector name-anchoring is best-effort per framework; the executed-count is the real guard.**
  Where a framework can anchor a name (`pytest` node-id, `jest -t '^x$'`, `go -run '^x$'`) we anchor;
  where it can only substring-filter (`rspec -e`, `phpunit --filter`) the **file scope** already makes
  it correct because the file is styre's own. Either way the false-green closes via `interpretRunOutput`
  returning `selected-none` when zero tests actually ran.
- **The two `ground_truth_signal` / `ac_check` vocabularies differ (§9).** `ac_check.red_first_result
  ∈ {red,green,error}`; `ground_truth_signal.result ∈ {pass,fail,error}`. `signalResultForCoarse`
  is the only place the map lives (`green→pass, red→fail, error→error`).
- **No schema change (avoid a version bump).** M1's `ac_check` (`red_first_result` column, no
  UNIQUE) is merged. Resume-dedup is delete-then-insert (M2b), enabled by `deleteByTicket` here — NOT
  a new UNIQUE constraint. Do **not** touch either `schema.sql` copy in M2a.
- **YAGNI on the loop.** M2a wires nothing into the resolver — the full suite must stay green with
  only new files + one repo extension. M2b calls these.
- Commit after each task. `bun test`, `bun run typecheck`, `bun run lint` green before every commit.

### Plan-time decisions (design under-specification resolved here)

1. **The "selects-≥1" check is read from the RED-first run itself, not a separate collect step.**
   jest/go/cargo have no clean pre-run collect mode, so a uniform pre-run count is impossible.
   Instead `interpretRunOutput` returns `selected-none` when the framework reports zero tests ran
   (`pytest` exit 5, `jest`/`vitest` "No tests found", `go` "no tests to run", `cargo` "running 0
   tests", maven "No tests were executed", gradle "No tests found for given includes", `rspec` "0
   examples", `phpunit` "No tests executed"). M2b maps `selected-none` → identity reject. This
   satisfies §5.1's "a collect/dry-run count ≥ 1" using the run as the dry-run and closes the exact
   false-green §5.1 names (Go/jest `--passWithNoTests` → exit 0 → wrongly green).
2. **The `+`-line content check reduces to substring presence.** Because M2b's identity requires the
   file be git-status **`A` (added)**, every line in it is a `+` line — so "`test_name` on a `+` line"
   (§5.1) is exactly "`test_name` is present in the added file". No diff-line parsing is needed; the
   anchored selector + `selected-none` guard provides the semantic teeth. (This is an M2b note; M2a
   just makes the selector honest.)
3. **`buildCheckSelector` returns framework-native *args*, not a full command.** The framework binary
   and cwd are runtime concerns M2b assembles (reusing `resolvePythonInterpreter` for python). **The
   binary carries the subcommand for go/cargo but NOT for maven/gradle:** the go/cargo `runArgs` omit
   the test subcommand, so M2b's binary must be `go test` / `cargo test` (→ `go test -run '^X$' ./pkg`,
   `cargo test --test stem name -- --exact`); maven/gradle carry their goal/task *in* `runArgs`
   (`… test`, `test --tests …`), so their binary is bare `mvn` / `gradle`; vitest carries `run` in
   `runArgs`. So the binaries are `python3 -m pytest` (resolved interp), `jest`, `vitest`, `go test`,
   `cargo test`, `mvn`, `gradle`, `rspec`, `ruby -Itest` (minitest), `phpunit`. M2a stays pure: it emits
   the selection tokens + a `precision` tag (for observability/risk). M2b runs `<framework-binary>
   <runArgs>` **in the component dir** so the suite's setup context (conftest/jest config/session
   fixtures/migrations) still applies (§5.3 "in-suite"). Running the framework's canonical selection
   command — not the profile's possibly-wrapping `tox`/`npm test` — is what guarantees scoping to
   only styre's added file, aligning with `reuse.ts`'s "swap, don't append" philosophy.

---

## File Structure

- **Create** `src/dispatch/check-selector.ts` — `CheckFramework`, `SelectorPrecision`, `CoarseResult`,
  `CoarseOrNone`, `frameworkFor`, `buildCheckSelector`, `interpretRunOutput`, `signalResultForCoarse`.
- **Create** `test/dispatch/check-selector.test.ts` — framework-detection, selector, run-output, and
  vocab-map unit tests across all stacks.
- **Create** `src/dispatch/checks-schema.ts` — `AuthoredCheckSchema`, `ChecksOutputSchema`, `ChecksOutput`.
- **Create** `test/dispatch/checks-schema.test.ts` — sidecar shape validation tests.
- **Modify** `src/db/repos/ac-check.ts` — `insertAcCheck` optional `redFirstResult`; add `deleteByTicket`.
- **Modify** `test/db/repos/ac-check.test.ts` — add insert-with-result + delete-dedup tests.

---

## Task 1: Framework detection — `frameworkFor` (+ the module's types)

**Files:**
- Create: `src/dispatch/check-selector.ts`
- Test: `test/dispatch/check-selector.test.ts`

**Interfaces — Produces:**
- `type CheckFramework = "pytest" | "jest" | "vitest" | "go" | "cargo" | "junit-maven" | "junit-gradle" | "rspec" | "minitest" | "phpunit"`
- `frameworkFor(component: { kind: string; commands: Record<string, unknown> }): CheckFramework | null`

`null` is honest: an unknown kind, or a node/ruby component whose test command names no recognizable
framework, cannot have a selector built — M2b records that check as coarse `error` (can't attempt).

- [ ] **Step 1: Write the failing test.**

```ts
// test/dispatch/check-selector.test.ts
import { describe, expect, test } from "bun:test";
import { frameworkFor } from "../../src/dispatch/check-selector.ts";

const comp = (kind: string, test?: string) => ({
  kind,
  commands: test === undefined ? {} : { test },
});

describe("frameworkFor", () => {
  test("python → pytest (the assumed python runner, incl. tox-wrapped)", () => {
    expect(frameworkFor(comp("python", "pytest -q"))).toBe("pytest");
    expect(frameworkFor(comp("python", "tox -e py311"))).toBe("pytest");
    expect(frameworkFor(comp("python"))).toBe("pytest");
  });

  test("node/sveltekit → jest or vitest by the command; null when ambiguous", () => {
    expect(frameworkFor(comp("node", "jest"))).toBe("jest");
    expect(frameworkFor(comp("node", "vitest run"))).toBe("vitest");
    expect(frameworkFor(comp("sveltekit", "vitest"))).toBe("vitest");
    expect(frameworkFor(comp("node", "npm test"))).toBeNull(); // no framework named
  });

  test("go → go, rust → cargo", () => {
    expect(frameworkFor(comp("go", "go test ./..."))).toBe("go");
    expect(frameworkFor(comp("rust", "cargo test"))).toBe("cargo");
  });

  test("jvm-maven → junit-maven, jvm-gradle → junit-gradle", () => {
    expect(frameworkFor(comp("jvm-maven", "mvn test"))).toBe("junit-maven");
    expect(frameworkFor(comp("jvm-gradle", "gradle test"))).toBe("junit-gradle");
  });

  test("ruby → rspec or minitest by the command; php → phpunit", () => {
    expect(frameworkFor(comp("ruby", "bundle exec rspec"))).toBe("rspec");
    expect(frameworkFor(comp("ruby", "rake test"))).toBe("minitest");
    expect(frameworkFor(comp("ruby", "bin/rails test"))).toBe("minitest");
    expect(frameworkFor(comp("ruby", "bundle exec ruby"))).toBeNull();
    expect(frameworkFor(comp("php", "phpunit"))).toBe("phpunit");
  });

  test("unknown/custom kind → null", () => {
    expect(frameworkFor(comp("app", "bun test"))).toBeNull();
    expect(frameworkFor(comp("elixir", "mix test"))).toBeNull();
  });
});
```

- [ ] **Step 2: Run it — fails.**

```
bun test test/dispatch/check-selector.test.ts
```

Expected: module-not-found for `check-selector.ts`.

- [ ] **Step 3: Minimal implementation.** Create `src/dispatch/check-selector.ts` with the types and
`frameworkFor` (later tasks append to this file):

```ts
// src/dispatch/check-selector.ts

/** A concrete test framework the selector constructor + coarse run-output reader understand.
 *  Derived from a profile component's `kind` and its `test` command string. */
export type CheckFramework =
  | "pytest"
  | "jest"
  | "vitest"
  | "go"
  | "cargo"
  | "junit-maven"
  | "junit-gradle"
  | "rspec"
  | "minitest"
  | "phpunit";

/** How a check's selector is scoped (observability + risk-tier only). `precise` = an exact node/
 *  method id; `anchored` = file/package scope + an anchored name; `package` = package/crate scope +
 *  anchored name (Go/Rust — no file-level run, §5.2); `file` = the styre-authored file is the scope
 *  (safe because M2b's added-file identity guarantees it holds only this check) + a name filter. */
export type SelectorPrecision = "precise" | "anchored" | "package" | "file";

/** The coarse RED-first bucket recorded in `ac_check.red_first_result` (§5.4). */
export type CoarseResult = "green" | "red" | "error";

/** `interpretRunOutput`'s result: a coarse bucket, OR `selected-none` — the framework ran but
 *  matched ZERO tests (the "selects-≥1" identity guard, §5.1). `selected-none` is NOT a verdict;
 *  M2b treats it as a transport/identity reject (re-dispatch). */
export type CoarseOrNone = CoarseResult | "selected-none";

/** The `test` command string configured for a component, if any (mirrors `commandFor` without a
 *  Component import — this module stays dependency-light and unit-testable on plain objects). */
function testCommandOf(component: { commands: Record<string, unknown> }): string {
  const v = component.commands.test;
  return typeof v === "string" ? v : "";
}

/** Detect the test framework for a component from its `kind` and `test` command. Returns `null`
 *  when it cannot be determined (unknown kind, or a node/ruby command that names no framework) —
 *  M2b records such a check as coarse `error` rather than guessing. */
export function frameworkFor(component: {
  kind: string;
  commands: Record<string, unknown>;
}): CheckFramework | null {
  const cmd = testCommandOf(component);
  switch (component.kind) {
    case "python":
      return "pytest"; // pytest is styre's python assumption (tox/nox wrap it)
    case "node":
    case "sveltekit":
      if (/\bvitest\b/.test(cmd)) return "vitest";
      if (/\bjest\b/.test(cmd)) return "jest";
      return null; // e.g. bare `npm test` — framework unknown
    case "go":
      return "go";
    case "rust":
      return "cargo";
    case "jvm-maven":
      return "junit-maven";
    case "jvm-gradle":
      return "junit-gradle";
    case "ruby":
      if (/\brspec\b/.test(cmd)) return "rspec";
      if (/\b(minitest|rake test|rails test)\b/.test(cmd)) return "minitest";
      return null;
    case "php":
      return "phpunit";
    default:
      return null;
  }
}
```

- [ ] **Step 4: Run it — passes.**

```
bun test test/dispatch/check-selector.test.ts
```

Expected: all `frameworkFor` tests pass.

- [ ] **Step 5: Commit.**

```
bun run typecheck && bun run lint && bun test test/dispatch/check-selector.test.ts
git add src/dispatch/check-selector.ts test/dispatch/check-selector.test.ts
git commit -m "feat(checks): frameworkFor — detect the test framework from a profile component"
```

---

## Task 2: The per-stack selector constructor — `buildCheckSelector`

**Files:**
- Modify: `src/dispatch/check-selector.ts`
- Test: `test/dispatch/check-selector.test.ts`

**Interfaces — Produces:**
- `interface CheckSelector { runArgs: string; precision: SelectorPrecision }`
- `buildCheckSelector(fw: CheckFramework, p: { testFile: string; testName: string }): CheckSelector`

`runArgs` are the framework-native selection tokens M2b appends to the framework binary (decision 3).
`testFile` is repo-relative; Go/Rust derive their package/crate scope from its path (§5.2 non-universal
file floor).

- [ ] **Step 1: Write the failing test.** Append to `test/dispatch/check-selector.test.ts`:

```ts
import { buildCheckSelector } from "../../src/dispatch/check-selector.ts";

describe("buildCheckSelector", () => {
  test("pytest → an exact node id (precise)", () => {
    expect(buildCheckSelector("pytest", { testFile: "tests/test_api.py", testName: "test_ok" })).toEqual({
      runArgs: "tests/test_api.py::test_ok",
      precision: "precise",
    });
  });

  test("jest/vitest → file scope + an anchored -t name (regex-escaped)", () => {
    expect(buildCheckSelector("jest", { testFile: "src/a.test.ts", testName: "returns 200" })).toEqual({
      runArgs: "src/a.test.ts -t '^returns 200$'",
      precision: "anchored",
    });
    expect(buildCheckSelector("vitest", { testFile: "src/a.test.ts", testName: "a.b" })).toEqual({
      runArgs: "run src/a.test.ts -t '^a\\.b$'",
      precision: "anchored",
    });
  });

  test("go → package (dir) scope + anchored -run (no file-level run, §5.2)", () => {
    expect(buildCheckSelector("go", { testFile: "pkg/api/api_test.go", testName: "TestOK" })).toEqual({
      runArgs: "-run '^TestOK$' ./pkg/api",
      precision: "package",
    });
  });

  test("cargo → crate + exact name via the file stem as the integration test (§5.2 one-file-one-crate)", () => {
    expect(buildCheckSelector("cargo", { testFile: "tests/api.rs", testName: "returns_ok" })).toEqual({
      runArgs: "--test api returns_ok -- --exact",
      precision: "package",
    });
  });

  test("junit maven/gradle → Class#method from the file stem (precise)", () => {
    expect(buildCheckSelector("junit-maven", { testFile: "src/test/java/ApiTest.java", testName: "ok" })).toEqual({
      runArgs: "-Dtest=ApiTest#ok test",
      precision: "precise",
    });
    expect(buildCheckSelector("junit-gradle", { testFile: "src/test/java/ApiTest.java", testName: "ok" })).toEqual({
      runArgs: "test --tests 'ApiTest.ok'",
      precision: "precise",
    });
  });

  test("rspec/minitest/phpunit → file scope (styre's own file) + a name filter", () => {
    expect(buildCheckSelector("rspec", { testFile: "spec/api_spec.rb", testName: "is ok" })).toEqual({
      runArgs: "spec/api_spec.rb -e 'is ok'",
      precision: "file",
    });
    expect(buildCheckSelector("minitest", { testFile: "test/api_test.rb", testName: "test_ok" })).toEqual({
      runArgs: "test/api_test.rb -n '/^test_ok$/'",
      precision: "file",
    });
    expect(buildCheckSelector("phpunit", { testFile: "tests/ApiTest.php", testName: "testOk" })).toEqual({
      runArgs: "--filter '/::testOk$/' tests/ApiTest.php",
      precision: "file",
    });
  });
});
```

- [ ] **Step 2: Run it — fails.**

```
bun test test/dispatch/check-selector.test.ts
```

Expected: `buildCheckSelector is not a function`.

- [ ] **Step 3: Minimal implementation.** Add the `import` at the **top** of `src/dispatch/check-selector.ts` (biome `organizeImports` requires imports first — do NOT leave it mid-file where this append lands), then append the rest:

```ts
// at the TOP of the file:
import { basename, dirname } from "node:path";

// appended below the Task 1 code:
export interface CheckSelector {
  runArgs: string;
  precision: SelectorPrecision;
}

/** Escape regex metacharacters so a plain test NAME can be anchored inside `^…$` (jest -t / go -run
 *  / minitest -n all take a regex). */
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The class name for a JVM/PHP test = the file's basename without extension (styre authors one
 *  public test class per file, named after the file). */
function classFromFile(testFile: string): string {
  return basename(testFile).replace(/\.[^.]+$/, "");
}

/** Construct the framework-native selection args that run ONLY the one authored check (§5.2). The
 *  returned `runArgs` are appended to the framework binary by M2b; `precision` records the scoping
 *  tier (precise > anchored > package > file). For file-addressable frameworks the styre-authored
 *  file is itself the scope (M2b's added-file identity guarantees it holds only this check); Go/Rust
 *  have no file-level run, so they scope to the package/crate + an anchored/exact name. */
export function buildCheckSelector(
  fw: CheckFramework,
  p: { testFile: string; testName: string },
): CheckSelector {
  const { testFile, testName } = p;
  switch (fw) {
    case "pytest":
      return { runArgs: `${testFile}::${testName}`, precision: "precise" };
    case "jest":
      return { runArgs: `${testFile} -t '^${escapeRegex(testName)}$'`, precision: "anchored" };
    case "vitest":
      return { runArgs: `run ${testFile} -t '^${escapeRegex(testName)}$'`, precision: "anchored" };
    case "go":
      return { runArgs: `-run '^${escapeRegex(testName)}$' ./${dirname(testFile)}`, precision: "package" };
    case "cargo":
      // One-file-one-crate integration test (§5.2 Rust mandate): `--test <stem>` selects the crate,
      // `<name> -- --exact` the single test function.
      return { runArgs: `--test ${classFromFile(testFile)} ${testName} -- --exact`, precision: "package" };
    case "junit-maven":
      return { runArgs: `-Dtest=${classFromFile(testFile)}#${testName} test`, precision: "precise" };
    case "junit-gradle":
      return { runArgs: `test --tests '${classFromFile(testFile)}.${testName}'`, precision: "precise" };
    case "rspec":
      // rspec -e is a substring match; the styre-authored file is the real scope (safe by identity).
      return { runArgs: `${testFile} -e '${testName}'`, precision: "file" };
    case "minitest":
      return { runArgs: `${testFile} -n '/^${escapeRegex(testName)}$/'`, precision: "file" };
    case "phpunit":
      return { runArgs: `--filter '/::${escapeRegex(testName)}$/' ${testFile}`, precision: "file" };
  }
}
```

- [ ] **Step 4: Run it — passes.**

```
bun test test/dispatch/check-selector.test.ts
```

Expected: all `frameworkFor` + `buildCheckSelector` tests pass.

- [ ] **Step 5: Commit.**

```
bun run typecheck && bun run lint && bun test test/dispatch/check-selector.test.ts
git add src/dispatch/check-selector.ts test/dispatch/check-selector.test.ts
git commit -m "feat(checks): buildCheckSelector — per-stack scoped selector for a single authored check"
```

---

## Task 3: The coarse run-output reader + the vocab map — `interpretRunOutput`, `signalResultForCoarse`

**Files:**
- Modify: `src/dispatch/check-selector.ts`
- Test: `test/dispatch/check-selector.test.ts`

**Interfaces — Produces:**
- `type RunOutcome = CommandResult` (aliased from `src/util/run-command.ts` — `{exitCode:number|null, stdout, stderr, timedOut}`)
- `interpretRunOutput(fw: CheckFramework, run: RunOutcome): CoarseOrNone`
- `signalResultForCoarse(coarse: CoarseResult): "pass" | "fail" | "error"`

The coarse buckets are pinned by §5.4 so M3 subdivides `red` from raw output; `selected-none` is the
distinct "matched zero tests" identity signal (decision 1). `signalResultForCoarse` is the §9 vocab
map (the ONLY place `green→pass, red→fail, error→error` lives).

- [ ] **Step 1: Write the failing test.** Append to `test/dispatch/check-selector.test.ts`:

```ts
import { interpretRunOutput, signalResultForCoarse } from "../../src/dispatch/check-selector.ts";

const run = (o: Partial<{ exitCode: number | null; stdout: string; stderr: string; timedOut: boolean }>) => ({
  exitCode: 0,
  stdout: "",
  stderr: "",
  timedOut: false,
  ...o,
});

describe("interpretRunOutput", () => {
  test("a timeout or a failure to launch is always error (couldn't attempt)", () => {
    expect(interpretRunOutput("pytest", run({ timedOut: true, exitCode: null }))).toBe("error");
    expect(interpretRunOutput("go", run({ exitCode: null }))).toBe("error");
    expect(interpretRunOutput("jest", run({ exitCode: 127, stderr: "jest: command not found" }))).toBe("error");
  });

  test("pytest: 0=green, 1=red (assertion), 2=red (collection/import), 5=selected-none", () => {
    expect(interpretRunOutput("pytest", run({ exitCode: 0 }))).toBe("green");
    expect(interpretRunOutput("pytest", run({ exitCode: 1 }))).toBe("red");
    expect(interpretRunOutput("pytest", run({ exitCode: 2, stdout: "errors during collection" }))).toBe("red");
    expect(interpretRunOutput("pytest", run({ exitCode: 5 }))).toBe("selected-none");
  });

  test("jest/vitest: green, red on failure/import error, selected-none on no-match", () => {
    expect(interpretRunOutput("jest", run({ exitCode: 0 }))).toBe("green");
    expect(interpretRunOutput("jest", run({ exitCode: 0, stderr: "No tests found, exiting with code 0" }))).toBe("selected-none");
    // file loaded but the anchored -t matched zero tests (nested describe) → exit 0, "0 total"
    expect(interpretRunOutput("jest", run({ exitCode: 0, stdout: "Tests:       0 total" }))).toBe("selected-none");
    expect(interpretRunOutput("jest", run({ exitCode: 1, stderr: "Cannot find module '../prefs'" }))).toBe("red");
    expect(interpretRunOutput("jest", run({ exitCode: 1, stdout: "1 failed" }))).toBe("red");
    expect(interpretRunOutput("vitest", run({ exitCode: 1, stderr: "No test files found" }))).toBe("selected-none");
  });

  test("go: green, red on FAIL or build error, selected-none on no tests to run", () => {
    expect(interpretRunOutput("go", run({ exitCode: 0, stdout: "ok  pkg/api  0.01s" }))).toBe("green");
    expect(interpretRunOutput("go", run({ exitCode: 0, stdout: "testing: warning: no tests to run" }))).toBe("selected-none");
    expect(interpretRunOutput("go", run({ exitCode: 1, stdout: "--- FAIL: TestOK" }))).toBe("red");
    expect(interpretRunOutput("go", run({ exitCode: 2, stderr: "undefined: Prefs" }))).toBe("red");
  });

  test("cargo: green, red on failure/compile error, selected-none on 0 tests", () => {
    expect(interpretRunOutput("cargo", run({ exitCode: 0, stdout: "test result: ok. 1 passed" }))).toBe("green");
    expect(interpretRunOutput("cargo", run({ exitCode: 0, stdout: "running 0 tests" }))).toBe("selected-none");
    expect(interpretRunOutput("cargo", run({ exitCode: 101, stdout: "test result: FAILED" }))).toBe("red");
  });

  test("junit maven/gradle: selected-none on no-match, red on failure/compile", () => {
    expect(interpretRunOutput("junit-maven", run({ exitCode: 0 }))).toBe("green");
    expect(interpretRunOutput("junit-maven", run({ exitCode: 1, stdout: "No tests were executed!" }))).toBe("selected-none");
    expect(interpretRunOutput("junit-maven", run({ exitCode: 1, stdout: "COMPILATION ERROR" }))).toBe("red");
    expect(interpretRunOutput("junit-gradle", run({ exitCode: 1, stderr: "No tests found for given includes" }))).toBe("selected-none");
    expect(interpretRunOutput("junit-gradle", run({ exitCode: 1, stdout: "Tests FAILED" }))).toBe("red");
  });

  test("rspec/minitest/phpunit: green, selected-none on 0 examples, red otherwise", () => {
    expect(interpretRunOutput("rspec", run({ exitCode: 0, stdout: "1 example, 0 failures" }))).toBe("green");
    expect(interpretRunOutput("rspec", run({ exitCode: 0, stdout: "0 examples, 0 failures" }))).toBe("selected-none");
    expect(interpretRunOutput("rspec", run({ exitCode: 1, stdout: "10 examples, 1 failure" }))).toBe("red"); // \b: not selected-none
    expect(interpretRunOutput("rspec", run({ exitCode: 1, stdout: "1 example, 1 failure" }))).toBe("red");
    expect(interpretRunOutput("minitest", run({ exitCode: 0, stdout: "0 runs, 0 assertions" }))).toBe("selected-none");
    expect(interpretRunOutput("phpunit", run({ exitCode: 0, stdout: "No tests executed!" }))).toBe("selected-none");
    expect(interpretRunOutput("phpunit", run({ exitCode: 2, stdout: "Error" }))).toBe("red");
  });
});

describe("signalResultForCoarse", () => {
  test("maps the coarse bucket to the ground_truth_signal vocabulary (§9)", () => {
    expect(signalResultForCoarse("green")).toBe("pass");
    expect(signalResultForCoarse("red")).toBe("fail");
    expect(signalResultForCoarse("error")).toBe("error");
  });
});
```

- [ ] **Step 2: Run it — fails.**

```
bun test test/dispatch/check-selector.test.ts
```

Expected: `interpretRunOutput is not a function`.

- [ ] **Step 3: Minimal implementation.** Append to `src/dispatch/check-selector.ts`:

```ts
// at the TOP of the file (with the node:path import — biome requires imports first):
import type { CommandResult } from "../util/run-command.ts";

// appended below:
/** A completed framework run — aliased to the shared CommandResult (`src/util/run-command.ts`) so
 *  M2b's `runCommand` result flows in directly and the two shapes can never drift. */
export type RunOutcome = CommandResult;

/** True iff the combined output contains any of `needles` (case-insensitive, substring). */
function outputHas(run: RunOutcome, ...needles: string[]): boolean {
  const hay = `${run.stdout}\n${run.stderr}`.toLowerCase();
  return needles.some((n) => hay.includes(n.toLowerCase()));
}

/** True iff the combined output matches `re` — used for count phrases that need a word boundary so
 *  "10 examples" / "10 runs" does not false-match a "0 examples" / "0 runs" substring. */
function outputMatches(run: RunOutcome, re: RegExp): boolean {
  return re.test(`${run.stdout}\n${run.stderr}`);
}

/** Read a COMPLETED framework run into a coarse bucket (§5.4), or `selected-none` when the framework
 *  ran but matched ZERO tests (the selects-≥1 identity guard, §5.1). Ground truth: decides purely on
 *  the process's exit state + recognizable no-match/compile phrases — never the agent's word. A
 *  timeout or a failure to launch (null exit / shell 127) is `error` for every framework. The per-
 *  framework detail is deliberately coarse; M3 subdivides `red` (assertion vs absence vs env) from
 *  the raw output stored in `ground_truth_signal.detail_json`. */
export function interpretRunOutput(fw: CheckFramework, run: RunOutcome): CoarseOrNone {
  if (run.timedOut || run.exitCode === null) return "error";
  const code = run.exitCode;
  if (code === 127) return "error"; // command not found → couldn't attempt

  switch (fw) {
    case "pytest":
      if (code === 0) return "green";
      if (code === 5) return "selected-none"; // pytest: no tests collected
      if (code === 1 || code === 2) return "red"; // 1=failures, 2=collection/import error (absence)
      return "error"; // 3=internal, 4=usage, etc.
    case "jest":
    case "vitest":
      // "no tests found" = no file matched. "tests: 0 total" / "no tests ran" = the file loaded but
      // the anchored -t name matched ZERO tests (jest matches the CONCATENATED describe+it title, so
      // `^name$` can miss a nested test) — exits 0 with no "not found" phrase. Both are selects-none,
      // regardless of exit code. This closes the §5.1 false-green the file-substring check can't see.
      if (
        outputHas(run, "no tests found", "no test files found") ||
        outputMatches(run, /tests:\s*0 total/i) ||
        outputMatches(run, /no tests? ran/i)
      ) {
        return "selected-none";
      }
      return code === 0 ? "green" : "red";
    case "go":
      if (outputHas(run, "no tests to run")) return "selected-none";
      if (code === 0) return "green";
      return code === 1 || code === 2 ? "red" : "error"; // 1=FAIL, 2=build error (absence)
    case "cargo":
      if (outputHas(run, "running 0 tests")) return "selected-none";
      if (code === 0) return "green";
      return code === 101 ? "red" : "error"; // 101=test failure OR compile error
    case "junit-maven":
      if (outputHas(run, "no tests were executed", "there are no tests to run")) return "selected-none";
      return code === 0 ? "green" : "red";
    case "junit-gradle":
      if (outputHas(run, "no tests found for given includes")) return "selected-none";
      return code === 0 ? "green" : "red";
    case "rspec":
      if (outputMatches(run, /\b0 examples/i)) return "selected-none"; // \b so "10 examples" ≠ match
      return code === 0 ? "green" : "red";
    case "minitest":
      if (outputMatches(run, /\b0 runs/i)) return "selected-none"; // \b so "10 runs" ≠ match
      return code === 0 ? "green" : "red";
    case "phpunit":
      if (outputHas(run, "no tests executed", "no tests found")) return "selected-none";
      return code === 0 ? "green" : "red";
  }
}

/** Map a coarse `ac_check.red_first_result` bucket to the `ground_truth_signal.result` vocabulary
 *  (§9): the two tables' CHECK constraints differ (`ac_check` allows `red`; `ground_truth_signal`
 *  does not), so `green→pass, red→fail, error→error`. This is the ONLY place the map lives. */
export function signalResultForCoarse(coarse: CoarseResult): "pass" | "fail" | "error" {
  return coarse === "green" ? "pass" : coarse === "red" ? "fail" : "error";
}
```

- [ ] **Step 4: Run it — passes.**

```
bun test test/dispatch/check-selector.test.ts
```

Expected: the whole `check-selector` suite passes.

- [ ] **Step 5: Commit.**

```
bun run typecheck && bun run lint && bun test test/dispatch/check-selector.test.ts
git add src/dispatch/check-selector.ts test/dispatch/check-selector.test.ts
git commit -m "feat(checks): interpretRunOutput coarse reader + signalResultForCoarse vocab map"
```

---

## Task 4: The agent output contract — `ChecksOutputSchema` (zod sidecar)

**Files:**
- Create: `src/dispatch/checks-schema.ts`
- Test: `test/dispatch/checks-schema.test.ts`

**Interfaces — Produces:**
- `AuthoredCheckSchema` = `{ ac_id: number>0, test_file: string≥1, test_name: string≥1 }`
- `ChecksOutputSchema` = `{ checksAuthored: AuthoredCheck[] }`
- `type ChecksOutput`

Mirrors `extract-schema.ts` — M2b parses it via the existing `extractSidecar(output, ChecksOutputSchema)`
(`sidecar.ts`), so an absent/malformed payload is a transport failure (§4), never "no checks". The
agent reports only facts it authored — no selector, no verdict (§4).

- [ ] **Step 1: Write the failing test.**

```ts
// test/dispatch/checks-schema.test.ts
import { expect, test } from "bun:test";
import { ChecksOutputSchema } from "../../src/dispatch/checks-schema.ts";

test("accepts a well-formed checksAuthored array", () => {
  const parsed = ChecksOutputSchema.safeParse({
    checksAuthored: [{ ac_id: 1, test_file: "tests/test_api.py", test_name: "test_ok" }],
  });
  expect(parsed.success).toBe(true);
});

test("accepts an empty array (postcondition, not schema, enforces ≥1 per AC)", () => {
  expect(ChecksOutputSchema.safeParse({ checksAuthored: [] }).success).toBe(true);
});

test("rejects a non-positive ac_id, empty paths/names, and a missing field", () => {
  expect(ChecksOutputSchema.safeParse({ checksAuthored: [{ ac_id: 0, test_file: "a", test_name: "b" }] }).success).toBe(false);
  expect(ChecksOutputSchema.safeParse({ checksAuthored: [{ ac_id: 1, test_file: "", test_name: "b" }] }).success).toBe(false);
  expect(ChecksOutputSchema.safeParse({ checksAuthored: [{ ac_id: 1, test_file: "a", test_name: "" }] }).success).toBe(false);
  expect(ChecksOutputSchema.safeParse({ checksAuthored: [{ ac_id: 1, test_file: "a" }] }).success).toBe(false);
});

test("rejects a missing checksAuthored key", () => {
  expect(ChecksOutputSchema.safeParse({}).success).toBe(false);
});
```

- [ ] **Step 2: Run it — fails.**

```
bun test test/dispatch/checks-schema.test.ts
```

Expected: module-not-found for `checks-schema.ts`.

- [ ] **Step 3: Minimal implementation.**

```ts
// src/dispatch/checks-schema.ts
import { z } from "zod";

/** One authored native check the plan-blind `checks:dispatch` agent wrote (control-loop §3a / M2
 *  design §4). The agent reports ONLY facts it knows because it wrote them — the target acceptance
 *  criterion, the NEW test file it created, and the test function/case name. It reports NO selector
 *  (runner-constructed, §5.2) and NO verdict (ground truth, §5). */
export const AuthoredCheckSchema = z.object({
  ac_id: z.number().int().positive(),
  test_file: z.string().min(1),
  test_name: z.string().min(1),
});

export type AuthoredCheck = z.infer<typeof AuthoredCheckSchema>;

/** The `checks:dispatch` structured-output contract. An absent/malformed sidecar is a transport
 *  failure (re-dispatch), not "no checks" (§4). The "≥1 authored check per AC" rule is a
 *  postcondition (design §8), enforced by the M2b handler — not by this schema (an empty array is
 *  well-formed). */
export const ChecksOutputSchema = z.object({
  checksAuthored: z.array(AuthoredCheckSchema),
});

export type ChecksOutput = z.infer<typeof ChecksOutputSchema>;
```

- [ ] **Step 4: Run it — passes.**

```
bun test test/dispatch/checks-schema.test.ts
```

Expected: all schema tests pass.

- [ ] **Step 5: Commit.**

```
bun run typecheck && bun run lint && bun test test/dispatch/checks-schema.test.ts
git add src/dispatch/checks-schema.ts test/dispatch/checks-schema.test.ts
git commit -m "feat(checks): ChecksOutputSchema — the checks:dispatch zod sidecar contract"
```

---

## Task 5: `ac_check` repo — insert-with-result + `deleteByTicket` (resume-dedup substrate)

**Files:**
- Modify: `src/db/repos/ac-check.ts`
- Test: `test/db/repos/ac-check.test.ts`

**Interfaces — Produces (additive; the M1 `insertAcCheck`/`listByTicket`/`listByAc` stay):**
- `insertAcCheck(db, p: { ticketId; acId; selector; testPath?; redFirstResult? }): AcCheckRow` — M2
  inserts the row **with** its coarse result at record time (`selector` is `NOT NULL`, so this is an
  insert-with-result, not a later update — design §9). `redFirstResult` is optional; omitted ⇒ `NULL`
  (M1 callers/tests unchanged).
- `deleteByTicket(db, ticketId): number` — delete every `ac_check` for a ticket, returning the count.
  M2b calls this then re-inserts inside the persist transaction, so a crashed-and-resumed effectful
  `checks:dispatch` never duplicates rows (`ac_check` has no uniqueness — design §9). Returns the
  count for observability/testing.

- [ ] **Step 1: Write the failing test.** Append to `test/db/repos/ac-check.test.ts`:

```ts
test("insertAcCheck records a coarse red_first_result when given one", () => {
  const { db, ticketId } = makeTestDb();
  const acId = seedAc(db, ticketId);
  const row = acChecks.insertAcCheck(db, {
    ticketId,
    acId,
    selector: "tests/t.py::test_ok",
    testPath: "tests/t.py",
    redFirstResult: "red",
  });
  db.close();
  expect(row.red_first_result).toBe("red");
  expect(row.red_class).toBeNull(); // M3 fills this
});

test("insertAcCheck rejects an out-of-vocab red_first_result (the CHECK constraint)", () => {
  const { db, ticketId } = makeTestDb();
  const acId = seedAc(db, ticketId);
  expect(() =>
    // @ts-expect-error — deliberately violating the "red"|"green"|"error" union at runtime
    acChecks.insertAcCheck(db, { ticketId, acId, selector: "s", redFirstResult: "pass" }),
  ).toThrow();
  db.close();
});

test("deleteByTicket removes this ticket's rows and returns the count (resume-dedup)", () => {
  const { db, ticketId } = makeTestDb();
  const acId = seedAc(db, ticketId);
  acChecks.insertAcCheck(db, { ticketId, acId, selector: "s1", redFirstResult: "green" });
  acChecks.insertAcCheck(db, { ticketId, acId, selector: "s2", redFirstResult: "red" });
  const deleted = acChecks.deleteByTicket(db, ticketId);
  const remaining = acChecks.listByTicket(db, ticketId);
  db.close();
  expect(deleted).toBe(2);
  expect(remaining).toEqual([]);
});
```

(The `seedAc` helper + `acChecks`/`acs`/`makeTestDb` imports already exist at the top of this M1 test file.)

- [ ] **Step 2: Run it — fails.**

```
bun test test/db/repos/ac-check.test.ts
```

Expected: the new tests fail — `redFirstResult` is ignored (result is `null`, not `"red"`), the
CHECK-violation case does not throw, and `deleteByTicket is not a function`.

- [ ] **Step 3: Minimal implementation.** Edit `src/db/repos/ac-check.ts`.

Extend `insertAcCheck` to accept + persist `redFirstResult`:

```ts
export function insertAcCheck(
  db: Database,
  p: {
    ticketId: number;
    acId: number;
    selector: string;
    testPath?: string | null;
    redFirstResult?: "red" | "green" | "error" | null;
  },
): AcCheckRow {
  const now = nowUtc();
  const res = db
    .query(
      `INSERT INTO ac_check (ticket_id, ac_id, selector, test_path, red_first_result, created_at, updated_at)
       VALUES ($t, $ac, $sel, $path, $red, $now, $now)`,
    )
    .run({
      $t: p.ticketId,
      $ac: p.acId,
      $sel: p.selector,
      $path: p.testPath ?? null,
      $red: p.redFirstResult ?? null,
      $now: now,
    });
  const created = db
    .query<AcCheckRow, [number]>(`SELECT ${COLS} FROM ac_check WHERE id = ?`)
    .get(Number(res.lastInsertRowid));
  if (!created) {
    throw new Error("insertAcCheck: row missing after insert");
  }
  return created;
}
```

Add `deleteByTicket` (after `listByAc`):

```ts
/** Delete every ac_check row for a ticket, returning the count removed. M2's `checks:dispatch`
 *  persists checks by delete-then-insert inside the step's success transaction (design §9): the
 *  step is effectful and `ac_check` has no uniqueness, so a crashed-and-resumed run would otherwise
 *  duplicate rows. This is the "delete" half; the insert-with-result is `insertAcCheck`. */
export function deleteByTicket(db: Database, ticketId: number): number {
  const res = db.query(`DELETE FROM ac_check WHERE ticket_id = ?`).run(ticketId);
  return Number(res.changes);
}
```

- [ ] **Step 4: Run it — passes.**

```
bun test test/db/repos/ac-check.test.ts
```

Expected: all `ac-check` repo tests pass (the M1 tests still green — `redFirstResult` is optional so
the "defaults to NULL" test is unaffected).

- [ ] **Step 5: Full suite + gates green, then commit.**

```
bun test && bun run typecheck && bun run lint
git add src/db/repos/ac-check.ts test/db/repos/ac-check.test.ts
git commit -m "feat(db): ac_check insert-with-result + deleteByTicket (M2 resume-dedup substrate)"
```

Expected: the whole suite is green — M2a added only new files + one additive repo change; no loop
behavior changed, so no existing loop test is touched.

---

## Done-when (M2a acceptance)

- `bun test`, `bun run typecheck`, `bun run lint` all green.
- `frameworkFor` detects the framework for every supported `kind` (and returns `null` honestly for
  unknown kinds / unnamed node/ruby runners).
- `buildCheckSelector` produces a scoped selector for all 10 frameworks, with Go/Rust package/crate-
  scoped (not a fake file floor, §5.2).
- `interpretRunOutput` maps a completed run to `green`/`red`/`error`/`selected-none` per framework,
  with the coarse buckets pinned so M3 subdivides `red` (§5.4).
- `signalResultForCoarse` implements the `green→pass, red→fail, error→error` vocab map (§9).
- `ChecksOutputSchema` validates the §4 sidecar shape; `ac_check` supports insert-with-result +
  `deleteByTicket`.
- **No change to the running loop** (nothing imports these from the resolver/handlers yet — that is M2b).
- No schema change; both `schema.sql` copies untouched.

---

## M2b — the `checks:dispatch` wiring (OUTLINE only; next plan)

M2b consumes every M2a function. Sized from the design §12 task shape + the code touchpoints. Task
list (to be expanded into a full TDD plan after M2a lands):

1. **Resolver re-sequence (`src/daemon/resolver.ts` `case "design"`).** After `design:review`/size,
   before `advance to implement`, emit `provision` (hoisted) then `checks:dispatch`
   (`if (!done("provision")) return step("provision",…); if (!done("checks:dispatch")) return
   step("checks:dispatch","dispatch","checks:dispatch",null);`). Resolver stays pure. Update
   `test/daemon/resolver.test.ts` (design chain now ends provision → checks:dispatch → advance) and
   the `advance`/handlers/loop tests that drive design→implement.
2. **Preserve `provision`'s reset path.** Implement's `resolver.ts:113,133` provision gates stay
   (they find it `done` and skip); `resetProvisionIfManifestTouched` in `implement:dispatch` stays
   (a dependency-adding implement diff re-arms provision). Add a test that a manifest-touching
   implement diff still re-provisions after the hoist.
3. **Tier + allowlist registration (both throw on unknown).** Add `"checks:dispatch": "standard"` to
   `src/agent/tiers.ts` (authoring tests from ACs is implement-like generative work — see the
   resolved under-specification below) and `"checks:dispatch": [...READ_ONLY, "Write", "Edit"]` (NO
   `Bash` — §3) to `src/dispatch/tool-allowlists.ts`.
4. **The prompt (`prompts/checks.md`, new) + `prompt-vars` entry (`checksVars`).** Builder-of-checks
   posture (§3): the AC rows (id + text + source) + the profile stacks/test-commands, NOT the plan.
   Register `CHECKS_TEMPLATE` in `src/dispatch/prompt-vars.ts`.
5. **The `checks:dispatch` handler (`src/dispatch/handlers.ts`).** `deriveAndPersistAcs(ctx.db,
   ctx.ticket.id)` first (idempotent, §6); build `checksVars`; `runAgentDispatch` (trivial
   postcondition — identity is verified after); parse `ChecksOutputSchema` via `extractSidecar`
   (absent/malformed → throw = transport, §4).
6. **Added-file identity verification (§5.1).** New worktree helper `addedFilesAt(sha, worktreePath)`
   (`git diff-tree --diff-filter=A --name-only`) in `src/dispatch/worktree.ts`; per authored check
   confirm `test_file` is added (not modified) and `test_name` is present in the committed added file
   (`git show <sha>:<path>` — every line of an added file is a `+` line, resolved decision 2). Reject
   → re-dispatch.
7. **RED-first in-suite execution.** For each check: `frameworkFor` → `buildCheckSelector` → run
   `<framework-binary> <runArgs>` in the component dir via `runCommand` (python binary via
   `resolvePythonInterpreter`, mirroring `reuse.ts`), on clean HEAD after the checks-commit; feed the
   result to `interpretRunOutput`. `selected-none` → identity reject; else coarse `green`/`red`/`error`.
8. **Persist + record (delete-then-insert transaction, §9).** In the step-success transaction:
   `deleteByTicket` then, per check, `insertAcCheck({… selector, testPath, redFirstResult: coarse})`
   + `insertSignal({ signalType: "ac-check-red-first", result: signalResultForCoarse(coarse),
   branchHeadSha: HEAD, detail: { rawOutput, acCheckId } })`.
9. **Postcondition (§8).** ≥1 authored check per AC with verified identity + a recorded coarse
   verdict; else fail (bounded-retry / escalate, mirroring `design:dispatch`).

**M2b resolved under-specification (carried):** the `checks:dispatch` tier is **standard** (Sonnet) —
authoring native tests from ACs + reading the repo is implement-class generative work, not deep
design/review; matching `implement:dispatch`. Revisit if bench data shows Sonnet under-authors.

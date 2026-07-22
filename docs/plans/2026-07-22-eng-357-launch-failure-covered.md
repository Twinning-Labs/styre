# ENG-357 — Launch failure (exit 127/126) must not mark its criterion covered — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop a check whose test runner is missing (shell exit 127 = command-not-found, or 126 = found-but-not-executable) from being recorded as covering its acceptance criterion; route it to the existing uncovered/loud-retry path with a message naming the missing launcher.

**Architecture:** A structural exit-code guard. Add a one-line predicate `isLaunchFailure(exitCode)` (`{126,127}`) next to the coarse bucketing, then extend the existing ENG-347 covered-guard at the `checks:dispatch` call site so it also fires on a launch failure — keyed **directly on the exit code**, *not* on `coarse === "error"`, because `interpretRunOutput` buckets exit 126 as `red` on 7 of 10 frameworks. The coarse bucketer, the prior-classifier, and the downstream `environmental → advisory` rule are all left untouched; the fix stops the bad input from reaching them, exactly as ENG-347 did.

**Tech Stack:** TypeScript on Bun; `bun:sqlite`; tests with `bun test`.

**Design doc:** `docs/brainstorms/2026-07-22-eng-357-launch-failure-covered-decision.md` (decided).

## Global Constraints

- **Never commit to `main`.** Work on a `fix/` branch; merge via PR only; no auto-merge.
- **Build/test/lint:** `bun run build`, `bun test`, `bun run lint` — all must be green before the final commit.
- **Diagnosis-only (INV-B):** every uncovered-reason message states a fact and names the launcher; it gives **no instruction** (no "install X", no "add to PATH").
- **Out of scope — do not modify:** `interpretRunOutput` (the coarse bucketing) in `check-selector.ts`; `classify-prior.ts`; `post-implement-rerun.ts`. Do not add a `126 → error` mapping to `interpretRunOutput` — the guard owns launch-failure recognition.
- **Launch-failure codes are exactly `{126, 127}`.** No other `error`-bucket code (pytest 3/4, Go/Cargo internal, timeout/null) changes behavior.

---

## File Structure

- **`src/dispatch/check-selector.ts`** — add `LAUNCH_FAILURE_EXIT_CODES` + `isLaunchFailure(exitCode)` beside `interpretRunOutput`/`binaryFor`. One responsibility: recognise, structurally, a shell launch-failure exit code.
- **`src/dispatch/handlers.ts`** — at the `checks:dispatch` per-check loop (~660–727): (a) set a launcher-naming `errorReason` when `isLaunchFailure(exitCode)`; (b) extend the ENG-347 covered-guard to fire on a launch failure. Import `isLaunchFailure` from `check-selector.ts`.
- **`test/dispatch/check-selector.test.ts`** — unit test for the predicate.
- **`test/dispatch/checks-handler.test.ts`** — a shared dispatch helper + the per-framework 127 matrix, the non-vacuous 126 test, and the covered-vs-uncovered contrast/regression cell.

No new files; all changes extend existing modules following their established patterns.

---

## Task 1: The `isLaunchFailure` predicate

**Files:**
- Modify: `src/dispatch/check-selector.ts` (add exported predicate near `interpretRunOutput`, ~line 233, and `binaryFor`, ~line 378)
- Test: `test/dispatch/check-selector.test.ts` (add one test + import)

**Interfaces:**
- Produces: `export const LAUNCH_FAILURE_EXIT_CODES: ReadonlySet<number>` and `export function isLaunchFailure(exitCode: number | null): boolean`.

- [ ] **Step 1: Write the failing test**

Add to `test/dispatch/check-selector.test.ts`. First add `isLaunchFailure` to the existing import from `../../src/dispatch/check-selector.ts`, then:

```ts
test("isLaunchFailure recognises shell launch-failure codes only (ENG-357)", () => {
  expect(isLaunchFailure(127)).toBe(true); // command not found
  expect(isLaunchFailure(126)).toBe(true); // found but not executable
  expect(isLaunchFailure(0)).toBe(false); // success
  expect(isLaunchFailure(1)).toBe(false); // ordinary test failure / jest-rspec red
  expect(isLaunchFailure(2)).toBe(false); // go build error / pytest collection
  expect(isLaunchFailure(101)).toBe(false); // cargo test failure
  expect(isLaunchFailure(null)).toBe(false); // timeout / spawn error
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/dispatch/check-selector.test.ts`
Expected: FAIL — `isLaunchFailure` is not exported / not a function.

- [ ] **Step 3: Write minimal implementation**

Add to `src/dispatch/check-selector.ts`, immediately after `interpretRunOutput` (i.e. after its closing `}` at ~line 233):

```ts
/** POSIX shell "could not execute the command" exit codes: 127 = command not found, 126 = found but
 *  not executable (permission denied / is a directory / broken interpreter line). These come from the
 *  shell/loader failing to *start* the process — never from a framework reporting a test result — so a
 *  run carrying one means the check could not be attempted (ENG-357). Recognised structurally at the
 *  guard site, independent of the coarse bucket: `interpretRunOutput` maps 127 → `error` (above) but
 *  leaves 126 in the per-framework switch (→ `red` on jest/vitest/junit/rspec/minitest/phpunit), so the
 *  covered-guard must key off the exit code directly rather than on `coarse === "error"`. */
export const LAUNCH_FAILURE_EXIT_CODES: ReadonlySet<number> = new Set([126, 127]);

export function isLaunchFailure(exitCode: number | null): boolean {
  return exitCode !== null && LAUNCH_FAILURE_EXIT_CODES.has(exitCode);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/dispatch/check-selector.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/dispatch/check-selector.ts test/dispatch/check-selector.test.ts
git commit -m "feat(checks): add isLaunchFailure predicate for shell launch codes (ENG-357)"
```

---

## Task 2: Fire the covered-guard on a launch failure

**Files:**
- Modify: `src/dispatch/handlers.ts` — import block ~56–65; `errorReason` assignment ~680–682; covered-guard ~720
- Test: `test/dispatch/checks-handler.test.ts` (add a shared helper + one driving test)

**Interfaces:**
- Consumes: `isLaunchFailure` (Task 1); the existing `binaryFor(fw, { interp })`, `exitCode` local, `errorReason` local, `missReason` map.
- Produces: on a launch-failure run, `covered` never gains the AC; `missReason` carries a launcher-naming reason; the dispatch retries/escalates.

- [ ] **Step 1: Add the shared test helper**

Add to `test/dispatch/checks-handler.test.ts` (after the existing `markDesignDone` helper, ~line 46). It runs one single-AC `checks:dispatch` where the injected check runner returns a fixed `CommandResult`:

```ts
// ENG-357 helper: run a single-AC checks:dispatch for `kind`/`testCmd`, with the injected check
// runner returning a fixed CommandResult, and report what the covered-gate did.
async function runSingleCheckDispatch(fixture: {
  kind: string;
  testCmd: string;
  ext: string;
  run: () => { exitCode: number | null; stdout: string; stderr: string; timedOut: boolean };
}) {
  const { db, ticketId, projectId } = makeTestDb();
  const repo = gitRepo();
  db.query("UPDATE project SET target_repo = ? WHERE id = ?").run(repo, projectId);
  db.query("UPDATE ticket SET description = ? WHERE id = ?").run("- [ ] one thing\n", ticketId);
  await markDesignDone(db, ticketId);
  insertWorkUnit(db, { ticketId, seq: 1, kind: fixture.kind, verifyCheckTypes: ["test"] });
  setTicketTrack(db, ticketId, "fast");
  const runner = new FakeAgentRunner((input) => {
    const dir = join(input.cwd, "checks");
    mkdirSync(dir, { recursive: true });
    // Content must include the declared test_name ("test_x") — the M2b name-in-content identity gate.
    writeFileSync(join(dir, `ENG-1_ac1_test.${fixture.ext}`), "test_x placeholder\n");
    return {
      completed: true,
      exitCode: 0,
      stdout:
        '```styre-sidecar\n{"checksAuthored":[' +
        `{"ac_id":1,"test_file":"checks/ENG-1_ac1_test.${fixture.ext}","test_name":"test_x"}]}\n` +
        "```",
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
      components: [
        { name: "c", kind: fixture.kind, paths: ["**"], commands: { test: fixture.testCmd } },
      ],
    }),
    worktreeRoot: mkdtempSync(join(tmpdir(), "styre-chwt-")),
    runCheckCommand: async () => fixture.run(),
  });
  await advanceOneStep(db, ticketId, registry); // provision
  const outcome = await advanceOneStep(db, ticketId, registry); // checks:dispatch
  const checks = listAcChecks(db, ticketId);
  const step = getByKey(db, ticketId, "checks:dispatch");
  const message = step?.error_json != null ? (JSON.parse(step.error_json).message ?? "") : "";
  const stepStatus = step?.status;
  db.close();
  return { checks, message, outcome, stepStatus };
}
```

- [ ] **Step 2: Write the failing driving test**

Add to `test/dispatch/checks-handler.test.ts`:

```ts
test("rspec: a missing launcher (exit 127, non-empty stderr) → AC uncovered, launcher named (ENG-357)", async () => {
  const { checks, message, outcome, stepStatus } = await runSingleCheckDispatch({
    kind: "ruby",
    testCmd: "rspec",
    ext: "rb",
    run: () => ({ exitCode: 127, stdout: "", stderr: "sh: 1: rspec: not found", timedOut: false }),
  });
  expect(checks).toHaveLength(0); // NOT recorded as covering
  expect(["retry", "escalated"]).toContain(outcome.kind);
  expect(stepStatus).toBe("pending");
  expect(message).toContain("could not be executed (exit 127)");
  expect(message).toContain("rspec");
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `bun test test/dispatch/checks-handler.test.ts -t "missing launcher (exit 127"`
Expected: FAIL — the ENG-347 guard only checks `rawOutput.trim() === ""`; the 127 run has non-empty stderr, so the check is recorded (`checks` length 1) and the message does not name the launcher.

- [ ] **Step 4: Add the import**

In `src/dispatch/handlers.ts`, add `isLaunchFailure,` to the existing `./check-selector.ts` import block (lines 56–65), keeping alphabetical order after `importErrorImplicatesDiscarded`:

```ts
import {
  type CheckFramework,
  type CoarseResult,
  binaryFor,
  buildCheckSelector,
  collectionErrorExcerpt,
  frameworkFor,
  importErrorImplicatesDiscarded,
  isLaunchFailure,
  signalResultForCoarse,
} from "./check-selector.ts";
```

- [ ] **Step 5: Set a launcher-naming `errorReason`**

In `src/dispatch/handlers.ts`, replace the existing coarse-error `errorReason` assignment (currently lines 680–682):

```ts
            coarse = res.coarse;
            if (coarse === "error")
              errorReason = `the check for \`${testPath}\` timed out or could not be launched and produced no output`;
```

with (keyed on the exit code, so it is set even where a 126 buckets as `red`):

```ts
            coarse = res.coarse;
            // ENG-357: a shell launch failure (127 command-not-found / 126 not-executable) means the
            // runner never started — name the missing launcher. Keyed on the exit code, NOT on
            // `coarse === "error"`: exit 126 buckets as `red` on jest/vitest/junit/rspec/minitest/phpunit
            // (interpretRunOutput leaves 126 in the per-framework switch), where a coarse-gated
            // assignment would leave errorReason unset. Diagnosis-only (INV-B): names the fact, no advice.
            if (isLaunchFailure(exitCode))
              errorReason = `the test launcher \`${binaryFor(fw, { interp })}\` for \`${testPath}\` could not be executed (exit ${exitCode}) — the check could not be attempted`;
            else if (coarse === "error")
              errorReason = `the check for \`${testPath}\` timed out or could not be launched and produced no output`;
```

- [ ] **Step 6: Extend the covered-guard**

In `src/dispatch/handlers.ts`, change the ENG-347 covered-guard condition (currently line 720):

```ts
        if (coarse === "error" && rawOutput.trim() === "") {
```

to (add the launch-failure clause as a standalone `||`, NOT `&&`-ed under `coarse === "error"`):

```ts
        // ENG-357: also reject a shell launch failure (127/126) whose output is NON-empty ("command not
        // found" on stderr) — ENG-347's empty-only clause cannot see it. Keyed directly on the exit code
        // so it fires even where interpretRunOutput buckets 126 as `red`. Safe: no framework returns
        // 126/127 as a test verdict, so a `red`-coarse launch failure can never be a genuine failing
        // test. Same uncovered/loud-retry path — the launch failure is never recorded as covering.
        if (isLaunchFailure(exitCode) || (coarse === "error" && rawOutput.trim() === "")) {
```

Leave the guard body (the `missReason.set(...)` with `errorReason ?? <fallback>` and `continue;`) unchanged — `errorReason` is now set for the launch-failure path (Step 5), so the fallback is not used.

- [ ] **Step 7: Run the driving test to verify it passes**

Run: `bun test test/dispatch/checks-handler.test.ts -t "missing launcher (exit 127"`
Expected: PASS.

- [ ] **Step 8: Run the full dispatch suite (guard against regressions)**

Run: `bun test test/dispatch/checks-handler.test.ts`
Expected: PASS — including the existing ENG-347 empty-output and timeout tests (unchanged behavior).

- [ ] **Step 9: Commit**

```bash
git add src/dispatch/handlers.ts test/dispatch/checks-handler.test.ts
git commit -m "fix(checks): a missing test launcher (exit 127/126) no longer marks its AC covered (ENG-357)"
```

---

## Task 3: Per-framework matrix, the non-vacuous 126 test, and the covered-vs-uncovered contrast

**Files:**
- Test: `test/dispatch/checks-handler.test.ts` (add matrix + 126 + contrast/regression, all using the Task 2 helper)

**Interfaces:**
- Consumes: `runSingleCheckDispatch` (Task 2, Step 1); `red_first_result` on the `ac_check` row (from `listAcChecks`).

- [ ] **Step 1: Write the per-framework 127 matrix**

Add to `test/dispatch/checks-handler.test.ts`:

```ts
// Every non-pytest framework: a launcher that exits 127 must not mark its AC covered, and the reason
// must name that framework's launcher (binaryFor). junit-maven/junit-gradle/vitest ride the same
// structural path as go/cargo/jest/rspec/minitest/phpunit — included so "covers them for free" is non-vacuous.
const LAUNCH_FAILURE_FRAMEWORKS: Array<{
  fw: string;
  kind: string;
  testCmd: string;
  ext: string;
  launcher: string;
}> = [
  { fw: "go", kind: "go", testCmd: "go test ./...", ext: "go", launcher: "go test" },
  { fw: "cargo", kind: "rust", testCmd: "cargo test", ext: "rs", launcher: "cargo test" },
  { fw: "jest", kind: "node", testCmd: "jest", ext: "js", launcher: "jest" },
  { fw: "vitest", kind: "node", testCmd: "vitest", ext: "ts", launcher: "vitest" },
  { fw: "junit-maven", kind: "jvm-maven", testCmd: "mvn test", ext: "java", launcher: "mvn" },
  { fw: "junit-gradle", kind: "jvm-gradle", testCmd: "gradle test", ext: "java", launcher: "gradle" },
  { fw: "rspec", kind: "ruby", testCmd: "rspec", ext: "rb", launcher: "rspec" },
  { fw: "minitest", kind: "ruby", testCmd: "rake test", ext: "rb", launcher: "ruby -Itest" },
  { fw: "phpunit", kind: "php", testCmd: "phpunit", ext: "php", launcher: "phpunit" },
];

for (const f of LAUNCH_FAILURE_FRAMEWORKS) {
  test(`${f.fw}: a missing test launcher (exit 127) → AC uncovered, launcher named (ENG-357)`, async () => {
    const { checks, message, outcome } = await runSingleCheckDispatch({
      kind: f.kind,
      testCmd: f.testCmd,
      ext: f.ext,
      run: () => ({
        exitCode: 127,
        stdout: "",
        stderr: `sh: 1: ${f.launcher}: not found`,
        timedOut: false,
      }),
    });
    expect(checks).toHaveLength(0); // NOT recorded as covering
    expect(["retry", "escalated"]).toContain(outcome.kind);
    expect(message).toContain("could not be executed (exit 127)");
    expect(message).toContain(f.launcher);
  });
}
```

- [ ] **Step 2: Write the non-vacuous 126 test (red-default framework)**

Add to `test/dispatch/checks-handler.test.ts`:

```ts
test("rspec: exit 126 (launcher not executable) → coarse red, yet AC uncovered — decoupled guard (ENG-357)", async () => {
  // interpretRunOutput leaves 126 in the switch; rspec buckets any non-zero, non-"0 examples" exit as
  // `red` (check-selector.ts). So coarse === "red" here — a guard gated on `coarse === "error"` would
  // MISS this and record it as a covered red. The exit-code-keyed guard must still reject it.
  const { checks, message, outcome } = await runSingleCheckDispatch({
    kind: "ruby",
    testCmd: "rspec",
    ext: "rb",
    run: () => ({
      exitCode: 126,
      stdout: "",
      stderr: "sh: 1: rspec: Permission denied",
      timedOut: false,
    }),
  });
  expect(checks).toHaveLength(0); // decoupled guard fires even though coarse === "red"
  expect(["retry", "escalated"]).toContain(outcome.kind);
  expect(message).toContain("could not be executed (exit 126)");
  expect(message).toContain("rspec");
});
```

- [ ] **Step 3: Write the contrast/regression test (a genuine red is STILL covered)**

Add to `test/dispatch/checks-handler.test.ts`. This is the positive half of the contrast pair — it proves the guard rejects the launch failure **without** over-rejecting a legitimate failing test (RED-first expects a red before implementation):

```ts
test("ENG-357 contrast: a genuine non-zero red (exit 1) IS recorded as covering (rspec)", async () => {
  const { checks, outcome } = await runSingleCheckDispatch({
    kind: "ruby",
    testCmd: "rspec",
    ext: "rb",
    run: () => ({
      exitCode: 1,
      stdout: "1 example, 1 failure",
      stderr: "",
      timedOut: false,
    }),
  });
  expect(checks).toHaveLength(1); // genuine red → covered
  expect(checks[0]?.red_first_result).toBe("red");
  expect(outcome.kind).toBe("stepped"); // succeeded, not a retry/escalation
});
```

- [ ] **Step 4: Run the new tests to verify they pass**

Run: `bun test test/dispatch/checks-handler.test.ts`
Expected: PASS — the 9 matrix cases, the 126 case, and the contrast/regression case all green, alongside the existing tests.

- [ ] **Step 5: Full suite + lint + build**

Run: `bun test`
Expected: PASS (whole suite green).

Run: `bun run lint`
Expected: clean.

Run: `bun run build`
Expected: succeeds.

- [ ] **Step 6: Commit**

```bash
git add test/dispatch/checks-handler.test.ts
git commit -m "test(checks): per-framework 127 matrix + non-vacuous 126 + covered-vs-uncovered contrast (ENG-357)"
```

---

## Self-Review

**1. Spec coverage** (against `docs/brainstorms/2026-07-22-eng-357-launch-failure-covered-decision.md`):

| Spec item | Task |
|---|---|
| §2.1 structural approach (exit-code guard, not textual/probe) | Task 1 predicate + Task 2 guard |
| §2.2 launch-failure codes `{127, 126}` | Task 1 `LAUNCH_FAILURE_EXIT_CODES` |
| §2.3 other error codes stay `environmental` (untouched) | Global Constraints (out-of-scope list) — no code touches `interpretRunOutput`/`classify-prior`/`post-implement-rerun` |
| §3a predicate | Task 1 |
| §3b launcher-naming `errorReason`, keyed on `isLaunchFailure` | Task 2 Step 5 |
| §3c guard decoupled from `coarse === "error"` | Task 2 Step 6 |
| §5 unit test per affected framework | Task 3 Step 1 (9 frameworks) |
| §5 non-vacuous 126 on a red-default framework | Task 3 Step 2 |
| §5 contrast pair (missing binary → uncovered vs genuine red → covered) | Task 3 Steps 1–3 (matrix = negative; regression = positive) |
| §5 full suite green | Task 3 Step 5 |

No gaps.

**2. Placeholder scan:** none — every code step shows complete code and every command shows expected output. (The `writeFileSync` content `"test_x placeholder\n"` is deliberate: only the substring `test_x` matters to the identity gate.)

**3. Type consistency:** `isLaunchFailure(exitCode: number | null): boolean` defined in Task 1, consumed with the same signature in Task 2 (`exitCode` is the `number | null` local at `handlers.ts:641/674`). `binaryFor(fw, { interp })` matches the existing call at `handlers.ts:667`. `red_first_result` matches `AcCheckRow` (`src/db/repos/ac-check.ts:10`). `outcome.kind` values (`"stepped"`, `"retry"`, `"escalated"`) match `src/daemon/advance.ts`.

**Note on docs:** ENG-347 (the sibling fix) added a brainstorm decision doc and code but did not edit `docs/architecture/` — the covered-guard behavior is not a documented reference behavior. This plan mirrors that: the decision doc is the record; no architecture reference needs updating. If the executor finds an architecture doc that states the coarse-`error` coverage contract, update it in the same PR.

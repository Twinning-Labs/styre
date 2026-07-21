# ENG-347 — Errored check with empty output must not mark its criterion covered — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** At the `checks:dispatch` call site, a check whose coarse result is `error` with empty output is routed to the uncovered (loud-retry) path instead of being recorded as covering its acceptance criterion.

**Architecture:** One new guard in `src/dispatch/handlers.ts`, placed immediately after the existing discard-poison guard and before `records.push`/`covered.add`. It fires on `coarse === "error" && rawOutput.trim() === ""`, calling the same `missReason.set(...) + continue` uncovered path the discard-poison guard uses. A per-cause `errorReason` string is captured where each `error` coarse is assigned, so the uncovered message names *why* the check could not be attempted (no framework / no interpreter / timeout). No downstream stage changes.

**Tech Stack:** TypeScript on Bun; `bun test`; embedded SQLite; real-git-worktree handler harness.

## Global Constraints

- **Breadth = WIDE (decided, see `docs/brainstorms/2026-07-21-eng-347-errored-empty-output-covered-decision.md`):** the guard fires for EVERY errored-empty check, independent of whether files were discarded this attempt. Do NOT gate on `discarded.length > 0`.
- **"No output" means `rawOutput.trim() === ""`.** A timeout that produced truncated-but-non-empty output is deliberately OUT of scope and stays on the existing `error → environmental` path.
- **Diagnosis-only (INV-B):** the `missReason` message states the fact (what could not be attempted and why); it gives no instruction.
- **Scope OUT (do not touch):** `interpretRunOutput`, `classify-prior.ts`, `post-implement-rerun.ts`, the discard-poison matcher vocabulary / language registry.
- **Never commit to `main`; `fix/` branch; PR only, no auto-merge.** (Already on `fix/checks-errored-empty-output-covered-eng-347`.)
- Every code step is TDD: failing test first, watch it fail, minimal code, watch it pass.

## File Structure

- **Modify:** `src/dispatch/handlers.ts` — capture `errorReason` at each `error`-coarse assignment; add the empty-output guard before `records.push`.
- **Test (unit/handler):** `test/dispatch/checks-handler.test.ts` — two focused tests: Ruby `framework=null` (AC #3) and timeout-empty, each asserting the AC ends UNCOVERED.
- **Test (smoke matrix):** `test/dispatch/scope-disposition-smoke.test.ts` — a new `A21` ⚔ cell (error+empty → uncovered) with its `A22` contrast (error+non-empty → stays covered); the two differ only in output-emptiness.
- **Docs:** `docs/brainstorms/2026-07-21-eng-347-errored-empty-output-covered-decision.md` — the breadth decision + rationale (AC #4). **Already written** in this branch; Task 4 only verifies/adjusts it.

---

### Task 1: Handler guard + Ruby `framework=null` unit test (AC #3)

**Files:**
- Test: `test/dispatch/checks-handler.test.ts` (add one test near the existing "persists a coarse red" test)
- Modify: `src/dispatch/handlers.ts` (the `checks:dispatch` per-AC loop)

**Interfaces:**
- Consumes: `buildDispatchRegistry`, `advanceOneStep`, `listByTicket as listAcChecks`, `getByKey`, `makeTestDb`, `FakeAgentRunner`, `parseProfile` — all already imported in `checks-handler.test.ts`.
- Produces: no new exported symbols. Behavior change only: an errored-empty check yields `listAcChecks(...).length === 0` for that AC and a `checks:dispatch` postcondition error naming the reason.

- [ ] **Step 1: Write the failing test** — append to `test/dispatch/checks-handler.test.ts`:

```ts
test("a ruby check whose test command names neither rspec nor minitest → framework null, empty output → AC uncovered (ENG-347)", async () => {
  const { db, ticketId, projectId } = makeTestDb();
  const repo = gitRepo();
  db.query("UPDATE project SET target_repo = ? WHERE id = ?").run(repo, projectId);
  db.query("UPDATE ticket SET description = ? WHERE id = ?").run("- [ ] one thing\n", ticketId);
  await markDesignDone(db, ticketId);
  insertWorkUnit(db, { ticketId, seq: 1, kind: "ruby", verifyCheckTypes: ["test"] });
  setTicketTrack(db, ticketId, "fast");
  const runner = new FakeAgentRunner((input) => {
    const dir = join(input.cwd, "checks");
    mkdirSync(dir, { recursive: true });
    // canonical basename `${ident}_ac${n}_test.*`; ident is ENG-1 in this harness
    writeFileSync(join(dir, "ENG-1_ac1_test.rb"), "def test_x\n  assert true\nend\n");
    return {
      completed: true,
      exitCode: 0,
      stdout:
        '```styre-sidecar\n{"checksAuthored":[' +
        '{"ac_id":1,"test_file":"checks/ENG-1_ac1_test.rb","test_name":"test_x"}]}\n```',
      stderr: "",
      timedOut: false,
      costUsd: null,
      tokensIn: null,
      tokensOut: null,
    };
  });
  // A ruby component whose `test` command is a wrapper — frameworkFor returns null → coarse error,
  // rawOutput "". runCheckCommand is never called on this path.
  const registry = buildDispatchRegistry({
    runner,
    agentConfig: DEFAULT_AGENT_CONFIG,
    profile: parseProfile({
      slug: "demo",
      targetRepo: repo,
      components: [{ name: "app", kind: "ruby", paths: ["**"], commands: { test: "bin/test" } }],
    }),
    worktreeRoot: mkdtempSync(join(tmpdir(), "styre-chwt-")),
    runCheckCommand: async () => {
      throw new Error("runCheckCommand must not be called when no framework is detected");
    },
  });
  let outcome = await advanceOneStep(db, ticketId, registry); // provision
  outcome = await advanceOneStep(db, ticketId, registry); // checks:dispatch
  const checks = listAcChecks(db, ticketId);
  const step = getByKey(db, ticketId, "checks:dispatch");
  const message = step?.error_json != null ? (JSON.parse(step.error_json).message ?? "") : "";
  db.close();
  expect(["retry", "escalated"]).toContain(outcome.kind);
  expect(step?.status).toBe("pending");
  expect(checks).toHaveLength(0); // NOT recorded as covering
  expect(message).toMatch(/no test framework could be detected/);
  expect(message).toMatch(/could not be attempted/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/dispatch/checks-handler.test.ts -t "framework null"`
Expected: FAIL — today the check is recorded as covering, so `checks` has length 1 (`red_first_result === "error"`) and `outcome.kind === "stepped"`, so `toHaveLength(0)` and the `retry`/`escalated` assertions fail.

- [ ] **Step 3: Write minimal implementation** — in `src/dispatch/handlers.ts`.

3a. Add an `errorReason` accumulator alongside the other per-check `let`s (the block that declares `let coarse`, `let selector`, `let rawOutput`, `let exitCode`, `let command`):

```ts
        let command: string | null = null;
        let errorReason: string | null = null; // ENG-347: why an `error` coarse could not be attempted
```

3b. Set it at each `error`-coarse assignment. Replace the no-framework branch:

```ts
        if (!comp || !fw) {
          coarse = "error"; // can't attempt — no framework (§5.2)
          errorReason = comp
            ? `no test framework could be detected for \`${testPath}\` (its component's \`test\` command names none) — the check could not be attempted`
            : `no impacted component was found for \`${testPath}\` — the check could not be attempted`;
        } else {
```

Replace the no-interpreter branch:

```ts
          if (fw === "pytest" && interp === undefined) {
            coarse = "error"; // no interpreter → can't attempt
            errorReason = `no Python interpreter could be resolved for \`${testPath}\` — the check could not be attempted`;
          } else {
```

After `coarse = res.coarse;` (the runner path), add:

```ts
            coarse = res.coarse;
            if (coarse === "error")
              errorReason = `the check for \`${testPath}\` timed out or could not be launched and produced no output`;
```

3c. Add the guard immediately AFTER the discard-poison guard block (the one ending `continue; // uncovered → loud retry path, no poisoned check persisted` + its closing braces) and BEFORE `records.push({`:

```ts
        // ENG-347: a check that demonstrably could not be attempted — coarse `error` with no usable
        // output (no framework detected, no interpreter, or a timeout that produced nothing) — must
        // NEVER mark its criterion covered. Downstream it would be stamped `environmental`
        // (classify-prior.ts) and downgraded to a non-gating advisory (post-implement-rerun.ts),
        // shipping the criterion unverified. The text-based discard-poison guard above cannot see
        // this path: there is no output to match. Route it to the SAME uncovered path (loud retry,
        // reason named), for EVERY errored-empty check regardless of discards — the framework=null
        // case is discard-independent (see docs/brainstorms/2026-07-21-eng-347-…). Diagnosis-only.
        if (coarse === "error" && rawOutput.trim() === "") {
          missReason.set(
            c.ac_id,
            errorReason ??
              `the check for \`${testPath}\` could not be attempted (no framework detected, no interpreter, or a timeout) and produced no output`,
          );
          continue; // uncovered → loud retry path, no unverified check recorded as covering
        }

```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/dispatch/checks-handler.test.ts -t "framework null"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/dispatch/handlers.ts test/dispatch/checks-handler.test.ts
git commit -m "fix(checks): errored check with empty output is no longer marked covered (ENG-347)"
```

---

### Task 2: Timeout-empty unit test (second cause)

**Files:**
- Test: `test/dispatch/checks-handler.test.ts`

**Interfaces:**
- Consumes: same harness as Task 1. No production change (the Task 1 guard already covers the timeout cause via the runner path).

- [ ] **Step 1: Write the failing test** — append to `test/dispatch/checks-handler.test.ts`. Uses a pytest profile so authoring is unchanged, and forces the timeout cause through the injected runner:

```ts
test("a check that times out with empty output → error, empty → AC uncovered (ENG-347)", async () => {
  const { db, ticketId, projectId } = makeTestDb();
  const repo = gitRepo();
  db.query("UPDATE project SET target_repo = ? WHERE id = ?").run(repo, projectId);
  db.query("UPDATE ticket SET description = ? WHERE id = ?").run("- [ ] one thing\n", ticketId);
  await markDesignDone(db, ticketId);
  insertWorkUnit(db, { ticketId, seq: 1, kind: "python", verifyCheckTypes: ["test"] });
  setTicketTrack(db, ticketId, "fast");
  const runner = new FakeAgentRunner((input) => {
    const dir = join(input.cwd, "checks");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "ENG-1_ac1_test.py"), "def test_x():\n    assert True\n");
    return {
      completed: true,
      exitCode: 0,
      stdout:
        '```styre-sidecar\n{"checksAuthored":[' +
        '{"ac_id":1,"test_file":"checks/ENG-1_ac1_test.py","test_name":"test_x"}]}\n```',
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
    runCheckCommand: async () => ({ exitCode: null, stdout: "", stderr: "", timedOut: true }),
  });
  let outcome = await advanceOneStep(db, ticketId, registry); // provision
  outcome = await advanceOneStep(db, ticketId, registry); // checks:dispatch
  const checks = listAcChecks(db, ticketId);
  const step = getByKey(db, ticketId, "checks:dispatch");
  const message = step?.error_json != null ? (JSON.parse(step.error_json).message ?? "") : "";
  db.close();
  expect(["retry", "escalated"]).toContain(outcome.kind);
  expect(step?.status).toBe("pending");
  expect(checks).toHaveLength(0);
  expect(message).toMatch(/timed out or could not be launched/);
});
```

- [ ] **Step 2: Run test to verify it passes for the right reason**

Run: `bun test test/dispatch/checks-handler.test.ts -t "times out with empty output"`
Expected: PASS (Task 1's guard handles it). To prove the test is non-vacuous, temporarily change the guard predicate to `rawOutput.trim() === "NEVER"`, re-run → FAIL, then revert. (This is the "watch it fail" step, done via mutation since the impl already exists.)

- [ ] **Step 3: Commit**

```bash
git add test/dispatch/checks-handler.test.ts
git commit -m "test(checks): pin timeout-empty errored check → uncovered (ENG-347)"
```

---

### Task 3: Non-vacuous smoke cell `A21` + `A22` contrast

**Files:**
- Test: `test/dispatch/scope-disposition-smoke.test.ts` (append after the last A-block cell, `A20`, ~end of file)

**Interfaces:**
- Consumes: `setupChecks`, `driveChecks`, `checksRunner`, `canonicalDeclared`, `listAcChecks`, `pythonProfile` (all defined in this file). `driveChecks(h, runner, { runCheck })` injects the coarse oracle; returns `{ outcome, step, wt, message }`.

The two cells differ ONLY in output-emptiness (the guarded dimension): both time out (coarse `error`), A21 with empty output, A22 with non-empty output.

- [ ] **Step 1: Write the cells** — append:

```ts
// --- A21 ⚔ (ENG-347: coarse `error` with EMPTY output → uncovered, NOT recorded-then-advisory) -----
// A check that could not be attempted at all — the run timed out and produced nothing (coarse error,
// empty rawOutput). The text-based discard-poison guard cannot see this (no text to match). ENG-347
// routes it to the same uncovered path: the AC is NOT marked covered, and the reason is surfaced.
// Non-vacuous via the A22 contrast, which differs only in that its errored run DID produce output.
test("A21 ⚔ an errored check with empty output → AC uncovered, reason surfaced", async () => {
  const h = await setupChecks("- [ ] one thing\n");
  const runner = checksRunner(
    h,
    (cwd, acId, ident) => {
      const dir = join(cwd, "checks");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, `${ident}_ac${acId}_test.py`), "def test_x():\n    assert True\n");
    },
    (acId, ident) => canonicalDeclared(acId, ident),
  );
  const { outcome, step, wt, message } = await driveChecks(h, runner, {
    runCheck: async () => ({ exitCode: null, stdout: "", stderr: "", timedOut: true }),
  });
  const checks = listAcChecks(h.db, h.ticketId);
  h.db.close();
  expect(["retry", "escalated"]).toContain(outcome.kind);
  expect(step?.status).toBe("pending");
  expect(committedAtHead(wt)).not.toContain("_ac1_test.py"); // reverted, no unverified check committed
  expect(checks).toHaveLength(0); // NOT covered
  expect(message).toMatch(/could not be attempted|timed out or could not be launched/);
});

// --- A22 ⚔ (CONTRAST for A21: coarse `error` WITH output stays covered — out of ENG-347 scope) ------
// Same timeout → coarse error, but the run produced output. ENG-347 fires ONLY on empty output, so
// this stays on the existing error→environmental path: the check IS recorded (as error). This proves
// A21's discriminator is the emptiness of the output, not merely the error coarse.
test("A22 ⚔ an errored check WITH output stays covered (recorded as error)", async () => {
  const h = await setupChecks("- [ ] one thing\n");
  const runner = checksRunner(
    h,
    (cwd, acId, ident) => {
      const dir = join(cwd, "checks");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, `${ident}_ac${acId}_test.py`), "def test_x():\n    assert True\n");
    },
    (acId, ident) => canonicalDeclared(acId, ident),
  );
  const { outcome, step, wt } = await driveChecks(h, runner, {
    runCheck: async () => ({
      exitCode: null,
      stdout: "Timeout: killed after 120s\n<partial pytest output>",
      stderr: "",
      timedOut: true,
    }),
  });
  const checks = listAcChecks(h.db, h.ticketId);
  h.db.close();
  expect(outcome.kind).toBe("stepped"); // NOT rejected
  expect(step?.status).toBe("succeeded");
  expect(committedAtHead(wt)).toContain("_ac1_test.py"); // the check IS committed
  expect(checks).toHaveLength(1);
  expect(checks[0]?.red_first_result).toBe("error"); // recorded as error (environmental path, unchanged)
});
```

- [ ] **Step 2: Run the two cells**

Run: `bun test test/dispatch/scope-disposition-smoke.test.ts -t "A21"` then `… -t "A22"`
Expected: both PASS. Confirm `committedAtHead` is the helper name used in this file (the subagent report shows `committedAtHead(wt)` and `headHas(wt, …)` both in use; use whichever the surrounding A-cells use — `committedAtHead` returns the committed paths list).

- [ ] **Step 3: Commit**

```bash
git add test/dispatch/scope-disposition-smoke.test.ts
git commit -m "test(checks): smoke cell A21/A22 — errored empty vs errored-with-output (ENG-347)"
```

---

### Task 4: Design doc (AC #4) + full-suite gate

**Files:**
- Docs: `docs/brainstorms/2026-07-21-eng-347-errored-empty-output-covered-decision.md` (already written — verify it states the WIDE decision + rationale and marks ENG-343 §5 residual 6 closed).

- [ ] **Step 1: Verify the design note** covers: the breadth decision (wide), the AC-#3 rationale, the "no output = `rawOutput.trim() === ""`" definition, and the residual-6 closure. Adjust wording only if the implementation diverged.

- [ ] **Step 2: Full suite green**

Run: `bun test` then `bun run lint` then `bun run build`
Expected: all green; no warnings.

- [ ] **Step 3: Commit any doc tweak**

```bash
git add docs/brainstorms/2026-07-21-eng-347-errored-empty-output-covered-decision.md
git commit -m "docs(checks): record ENG-347 breadth decision, close residual 6 (ENG-347)"
```

- [ ] **Step 4: Push + open draft PR**

```bash
git push -u origin fix/checks-errored-empty-output-covered-eng-347
gh pr create --draft --title "fix(checks): errored check with empty output no longer marked covered (ENG-347)" --body "<summary + acceptance-criteria checklist>"
```

---

## Self-Review

**Spec coverage (ENG-347 acceptance criteria):**
1. "error + empty output no longer marks covered" → Task 1 guard + Task 1/2 tests. ✓
2. "routed to uncovered path with a message naming why" → `missReason.set(errorReason)` + message assertions. ✓
3. "Ruby command naming neither rspec nor minitest no longer covered/advisory" → Task 1 test (kind ruby, `bin/test`). ✓
4. "chosen breadth documented with rationale" → Task 4 design note (wide). ✓
5. "Unit tests plus a non-vacuous smoke cell; full suite green" → Tasks 1–3 (units + A21/A22 contrast); Task 4 `bun test`/lint/build. ✓

**Placeholder scan:** none — all code and commands are concrete. The one verification-time check (helper name `committedAtHead` vs `headHas`) is flagged in Task 3 Step 2 to reconcile against the file's existing A-cells.

**Type consistency:** `errorReason: string | null`; guard predicate `coarse === "error" && rawOutput.trim() === ""`; message tokens ("could not be attempted", "no test framework could be detected", "timed out or could not be launched") match between impl (Task 1 Step 3) and the test assertions (Tasks 1–3).

**OUT-of-scope untouched:** `interpretRunOutput`, `classify-prior.ts`, `post-implement-rerun.ts`, matcher vocabulary — no task edits them.

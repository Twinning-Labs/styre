# Checks scope-guard disposition (declare-or-discard) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop `checks:dispatch` from rejecting-and-wedging on undeclared throwaway files by *discarding* them instead, while keeping `implement`/`plan`/`docs` on today's reject behavior.

**Architecture:** Add an optional `disposition: "reject" | "discard"` to `DispatchSpec`. `runAgentDispatch` handles out-of-scope files by disposition: `reject` throws (today's behavior); `discard` deletes undeclared new files, records a telemetry note, and continues. Out-of-scope *tracked edits* always reject. A rename-safety guard never discards an undeclared new file when the dispatch also deletes a tracked file. The `checks:dispatch` handler sets `discard`; `implement` reads it from a new `implementDisposition` runtime-config flag (default `reject`).

**Tech Stack:** TypeScript, Bun test runner (`bun test`), embedded SQLite, zod.

## Global Constraints

- **Default is `reject`.** `DispatchSpec.disposition` is optional and defaults to `reject`, so `plan`, `docs`, and any un-migrated call site are unchanged. Only `checks:dispatch`/re-author opt into `discard`; `implement` reads the flag (default `reject`).
- **INV-B — feedback is diagnosis-only.** Reject messages state *why* (the fact), never an instruction ("declare it", "delete it", "put it in styre_scratch"). No scratch lore in any thrown message.
- **INV-A — checks.md only.** Remove the `styre_scratch/` paragraph from `prompts/checks.md`. **Do NOT touch `prompts/implement.md`** (implement still rejects and still needs the drawer).
- **Never silently drop a legit file.** Discard deletes only *undeclared new untracked* files; a tracked edit is never reverted by discard, and an undeclared new file coinciding with a tracked deletion is rejected (rename-safety), not discarded.
- **Keep both sweeps.** `sweepScratch` stays; both its call sites (`run-dispatch.ts` primary, `handlers.ts` pre-verify) stay. This plan does NOT remove the primary sweep.
- **Ground truth over self-report** (CLAUDE.md): recovery of a discarded-but-needed checks helper comes from a legible RED-first failure, not from an instruction.
- Run tests with `bun test <path>`; the full suite is `bun test`; `bunx tsc --noEmit` and `bunx biome check` must stay clean.

---

## Task 1: Disposition mechanism in `runAgentDispatch` (CRUX)

**Files:**
- Modify: `src/dispatch/worktree.ts` (add `isDeleted` to `PendingEntry`; add `discardPaths`)
- Modify: `src/dispatch/run-dispatch.ts` (add `disposition` to `DispatchSpec`; rework the offender block; return `discarded`)
- Test: `test/dispatch/worktree.test.ts`, `test/dispatch/run-dispatch.test.ts`

**Interfaces:**
- Consumes: `PendingEntry { path, isNew }` (`worktree.ts:125-128`), `pendingEntries`, `commitWorktree`, `undoAttempt`, `appendEvent(db, {ticketId, kind, reason, payload})`.
- Produces:
  - `PendingEntry { path: string; isNew: boolean; isDeleted: boolean }`
  - `discardPaths(worktreePath: string, paths: string[]): void`
  - `DispatchSpec.disposition?: "reject" | "discard"` (default `reject`)
  - `runAgentDispatch(...)` return gains `discarded: string[]`.

- [ ] **Step 1: Write the failing test for `isDeleted`**

In `test/dispatch/worktree.test.ts`, add:

```ts
test("pendingEntries flags a deleted tracked file as isDeleted", () => {
  const wt = makeWorktreeWithCommit({ "keep.txt": "a", "gone.txt": "b" }); // helper: commits both files
  rmSync(join(wt, "gone.txt"));
  writeFileSync(join(wt, "new.txt"), "c"); // undeclared new file
  const entries = pendingEntries(wt);
  const gone = entries.find((e) => e.path === "gone.txt");
  const neu = entries.find((e) => e.path === "new.txt");
  expect(gone).toEqual({ path: "gone.txt", isNew: false, isDeleted: true });
  expect(neu).toEqual({ path: "new.txt", isNew: true, isDeleted: false });
});
```

(If `makeWorktreeWithCommit` doesn't exist, build the worktree inline with the file's existing helpers — the existing worktree tests already create temp git repos; mirror that setup.)

- [ ] **Step 2: Run it, verify it fails**

Run: `bun test test/dispatch/worktree.test.ts -t "isDeleted"`
Expected: FAIL — `isDeleted` is `undefined` on the returned entries.

- [ ] **Step 3: Add `isDeleted` to `PendingEntry` and populate it**

In `src/dispatch/worktree.ts`, change the interface (`:125-128`) and the parse loop (`:148-155`):

```ts
export interface PendingEntry {
  path: string;
  isNew: boolean;
  /** True iff this entry is a deletion of a tracked file (porcelain status contains `D`). Used by
   *  the discard disposition's rename-safety guard: an undeclared new file coinciding with a tracked
   *  deletion may be a move git did not detect, so it must not be silently discarded. */
  isDeleted: boolean;
}
```

```ts
  for (let i = 0; i < tokens.length; i++) {
    const entry = tokens[i];
    const status = entry.slice(0, 2); // XY
    entries.push({ path: entry.slice(3), isNew: status === "??", isDeleted: status.includes("D") });
    if (status.includes("R") || status.includes("C")) {
      i++;
      // original path of a git-DETECTED rename/copy: the tracked source is being moved. It is not a
      // new file (isNew=false) and not a bare deletion (git paired it) → isDeleted=false.
      if (i < tokens.length) entries.push({ path: tokens[i], isNew: false, isDeleted: false });
    }
  }
```

- [ ] **Step 4: Run it, verify it passes**

Run: `bun test test/dispatch/worktree.test.ts -t "isDeleted"`
Expected: PASS. Also run the whole file — the existing `pendingEntries`/`pendingChanges` tests must still pass (adding a field is additive).
Run: `bun test test/dispatch/worktree.test.ts`

- [ ] **Step 5: Write the failing test for `discardPaths`**

In `test/dispatch/worktree.test.ts`:

```ts
test("discardPaths removes only the named untracked files, leaving the rest", () => {
  const wt = makeTmpGitRepo();
  writeFileSync(join(wt, "keep.py"), "1");
  mkdirSync(join(wt, "sub"), { recursive: true });
  writeFileSync(join(wt, "sub", "junk.py"), "2");
  discardPaths(wt, ["sub/junk.py"]);
  expect(existsSync(join(wt, "sub", "junk.py"))).toBe(false);
  expect(existsSync(join(wt, "keep.py"))).toBe(true);
});

test("discardPaths is a no-op on empty input and never throws on a missing path", () => {
  const wt = makeTmpGitRepo();
  expect(() => discardPaths(wt, [])).not.toThrow();
  expect(() => discardPaths(wt, ["does/not/exist.py"])).not.toThrow();
});
```

- [ ] **Step 6: Run it, verify it fails**

Run: `bun test test/dispatch/worktree.test.ts -t "discardPaths"`
Expected: FAIL — `discardPaths` is not exported.

- [ ] **Step 7: Implement `discardPaths`**

In `src/dispatch/worktree.ts`, next to `undoAttempt`:

```ts
/** Delete the named untracked files from the worktree — the discard disposition (checks): each path
 *  is a brand-new untracked file this dispatch created and did not declare. Mirrors undoAttempt's
 *  `git clean -fd` idiom (removes files and any now-empty untracked dirs it created), scoped to
 *  exactly these pathspecs so pre-existing cruft is spared. No-op / never throws on empty input. */
export function discardPaths(worktreePath: string, paths: string[]): void {
  if (paths.length === 0) return;
  git(["clean", "-fd", "--", ...paths], worktreePath);
}
```

- [ ] **Step 8: Run it, verify it passes**

Run: `bun test test/dispatch/worktree.test.ts`
Expected: PASS (all worktree tests).

- [ ] **Step 9: Write the failing tests for the disposition mechanism**

In `test/dispatch/run-dispatch.test.ts`, add a describe block. Use the file's existing dispatch harness (a fake `AgentRunner` whose `run` writes files into the worktree and returns a stdout with a sidecar). Model the four cases:

```ts
describe("disposition", () => {
  // A checks-style scope: new file in scope iff declared; tracked edits always in scope.
  const declaredScope = (declared: string[]): CommitScope => () => (path, isNew) =>
    !isNew || declared.includes(path);

  test("discard: undeclared new file is deleted, declared file + edit committed, note emitted, no throw", async () => {
    // runner: edits tracked `src/a.ts`, creates declared `src/b.ts`, creates loose `scratch.py`
    const res = await runDispatchFixture({
      disposition: "discard",
      commitScope: declaredScope(["src/b.ts"]),
      writes: { "src/a.ts": "edited", "src/b.ts": "new", "scratch.py": "junk" },
      sidecar: { new_files: ["src/b.ts"] },
    });
    expect(existsSync(join(res.worktree, "scratch.py"))).toBe(false); // discarded
    expect(res.committedPaths).toContain("src/b.ts");
    expect(res.committedPaths).toContain("src/a.ts");
    expect(res.committedPaths).not.toContain("scratch.py");
    expect(res.discarded).toEqual(["scratch.py"]);
    expect(res.notes).toContainEqual(
      expect.objectContaining({ reason: expect.stringContaining("scope-discarded") }),
    );
  });

  test("discard + tracked deletion: undeclared new file is REJECTED (rename-safety), not discarded", async () => {
    await expect(
      runDispatchFixture({
        disposition: "discard",
        commitScope: declaredScope([]),
        deletes: ["src/old.ts"], // tracked file removed
        writes: { "src/new.ts": "moved content" }, // undeclared new
        sidecar: { new_files: [] },
      }),
    ).rejects.toThrow(/tracked deletion|possible move/);
  });

  test("reject disposition: undeclared new file throws (today's behavior)", async () => {
    await expect(
      runDispatchFixture({
        disposition: "reject",
        commitScope: declaredScope([]),
        writes: { "scratch.py": "junk" },
        sidecar: { new_files: [] },
      }),
    ).rejects.toThrow(/not listed in new_files|undeclared new/);
  });

  test("default disposition is reject", async () => {
    await expect(
      runDispatchFixture({
        // disposition omitted
        commitScope: declaredScope([]),
        writes: { "scratch.py": "junk" },
        sidecar: { new_files: [] },
      }),
    ).rejects.toThrow(/undeclared new/);
  });

  test("out-of-scope tracked edit rejects even in discard mode", async () => {
    // plan/docs-style path scope: only docs/** allowed.
    const docScope: CommitScope = () => (path) => path.startsWith("docs/");
    await expect(
      runDispatchFixture({
        disposition: "discard",
        commitScope: docScope,
        writes: { "src/leak.ts": "edited-tracked" }, // pre-existing tracked file edited out of scope
        preTracked: { "src/leak.ts": "orig" },
        sidecar: {},
      }),
    ).rejects.toThrow(/out-of-scope tracked edit/);
  });
});
```

(Adapt `runDispatchFixture` to the file's actual harness — reuse whatever the existing `run-dispatch.test.ts` uses to seed a worktree, run a fake agent, and read back the commit + event notes. Do NOT invent a parallel harness if one exists.)

- [ ] **Step 10: Run them, verify they fail**

Run: `bun test test/dispatch/run-dispatch.test.ts -t "disposition"`
Expected: FAIL — `disposition` is not on `DispatchSpec`; discard path doesn't exist.

- [ ] **Step 11: Add `disposition` to `DispatchSpec`**

In `src/dispatch/run-dispatch.ts` (`DispatchSpec`, near `:50`):

```ts
  /** Per-step commit scope (control-loop §4). */
  commitScope?: CommitScope;
  /** How out-of-scope NEW files are handled: "reject" (default — revert + throw, today's behavior)
   *  or "discard" (delete the undeclared new files + emit a note + continue). Out-of-scope tracked
   *  EDITS always reject regardless. Only checks:dispatch/re-author set "discard"; implement reads it
   *  from runtime-config; plan/docs/omitted callers get "reject". */
  disposition?: "reject" | "discard";
```

- [ ] **Step 12: Rework the offender block**

In `src/dispatch/run-dispatch.ts`, replace the `if (spec.commitScope) { ... }` offender branch (`:190-207`) with:

```ts
  let sha: string;
  let changed: boolean;
  let discarded: string[] = [];
  if (spec.commitScope) {
    const inScope = spec.commitScope(result.stdout);
    const newPaths = judged.filter((e) => e.isNew).map((e) => e.path);
    const offenders = judged.filter((e) => !inScope(e.path, e.isNew, newPaths));
    const offendingEdits = offenders.filter((e) => !e.isNew).map((e) => e.path);
    const offendingNew = offenders.filter((e) => e.isNew).map((e) => e.path);
    const disposition = spec.disposition ?? "reject";
    const hasTrackedDeletion = judged.some((e) => e.isDeleted);

    // INV-B: every reason is a diagnosis (the fact), never an instruction.
    const rejectReasons: string[] = [];
    if (offendingEdits.length > 0) {
      rejectReasons.push(`out-of-scope tracked edit(s): ${offendingEdits.join(", ")}`);
    }
    if (offendingNew.length > 0) {
      if (disposition === "reject") {
        rejectReasons.push(`undeclared new file(s) (not listed in new_files): ${offendingNew.join(", ")}`);
      } else if (hasTrackedDeletion) {
        // rename-safety: git did not pair these; discarding the new half while committing the
        // deletion would be silent data loss on a move.
        rejectReasons.push(
          `undeclared new file(s) alongside a tracked deletion — possible move, not discarded: ${offendingNew.join(", ")}`,
        );
      }
    }
    if (rejectReasons.length > 0) {
      undoAttempt(deps.worktreePath, untrackedBefore);
      completeDispatch(ctx.db, inserted.id, {
        outcome: "dispatch-failed",
        branchHeadSha: preHead,
        endedAt: nowUtc(),
      });
      throw new Error(`dispatch ${did}: ${rejectReasons.join("; ")}`);
    }

    if (disposition === "discard" && offendingNew.length > 0) {
      discardPaths(deps.worktreePath, offendingNew);
      discarded = offendingNew;
      appendEvent(ctx.db, {
        ticketId: ctx.ticket.id,
        kind: "note",
        reason: `scope-discarded:${spec.handlerKey}`,
        payload: { discarded },
      });
    }

    const inScopeNew = newPaths.filter((p) => !offendingNew.includes(p));
    ({ sha, changed } = commitWorktree(deps.worktreePath, `${did} ${spec.handlerKey}`, inScopeNew));
  } else {
    // read-only branch — UNCHANGED
    const stray = judged.filter((e) => e.isNew).map((e) => e.path);
    if (stray.length > 0) {
      appendEvent(ctx.db, {
        ticketId: ctx.ticket.id,
        kind: "note",
        reason: `scratch-ignored:${spec.handlerKey}`,
        payload: { stray },
      });
    }
    ({ sha, changed } = commitWorktree(deps.worktreePath, `${did} ${spec.handlerKey}`, []));
  }
```

Add the `discardPaths` import to the existing `./worktree.ts` import block (`:15-22`).

- [ ] **Step 13: Return `discarded` from `runAgentDispatch`**

Change the return (`:238`) and its type signature (`:97`):

```ts
): Promise<{ dispatchId: string; sha: string; changed: boolean; output: string; discarded: string[] }> {
```
```ts
  return { dispatchId: did, sha, changed, output: result.stdout, discarded };
```

- [ ] **Step 14: Run the disposition tests + the whole file**

Run: `bun test test/dispatch/run-dispatch.test.ts`
Expected: PASS. Existing tests that asserted the old reject message string may need their expected substring updated to the new diagnosis-only text (`undeclared new file(s) (not listed in new_files)`), since reject-mode behavior is preserved but the *message* changed. Update those assertions to the new text; do not change behavior.

- [ ] **Step 15: tsc + biome + commit**

Run: `bunx tsc --noEmit && bunx biome check src/dispatch/run-dispatch.ts src/dispatch/worktree.ts`
```bash
git add src/dispatch/run-dispatch.ts src/dispatch/worktree.ts test/dispatch/run-dispatch.test.ts test/dispatch/worktree.test.ts
git commit -m "feat(dispatch): add discard disposition to the commit scope guard"
```

---

## Task 2: Wire handlers + the implement flag

**Files:**
- Modify: `src/config/runtime-config.ts` (add `implementDisposition`)
- Modify: `src/dispatch/handlers.ts` (checks + re-author set `discard`; implement reads the flag + discard-path malformed-sidecar guard)
- Test: `test/config/runtime-config.test.ts` (or the nearest existing config test), `test/dispatch/handlers*.test.ts` (the checks + implement handler tests)

**Interfaces:**
- Consumes: `DispatchSpec.disposition` (Task 1), `ctx.config: RuntimeConfig`, `extractSidecar`, `ImplementOutputSchema`, `resetWorktreeHard(worktreePath, sha)`, `worktreeHead`.
- Produces: `RuntimeConfig.implementDisposition: "reject" | "discard"` (default `"reject"`).

- [ ] **Step 1: Write the failing test for the config default**

In the runtime-config test file:

```ts
test("implementDisposition defaults to reject", () => {
  expect(DEFAULT_RUNTIME_CONFIG.implementDisposition).toBe("reject");
});
test("implementDisposition accepts discard", () => {
  expect(RuntimeConfigSchema.parse({ implementDisposition: "discard" }).implementDisposition).toBe("discard");
});
```

- [ ] **Step 2: Run it, verify it fails**

Run: `bun test test/config/runtime-config.test.ts -t "implementDisposition"`
Expected: FAIL — field absent.

- [ ] **Step 3: Add the field**

In `src/config/runtime-config.ts`, inside `RuntimeConfigSchema`:

```ts
  // Checks-disposition arc: how implement handles undeclared new files. Default "reject" (proven,
  // today's behavior). "discard" opts implement into the checks-style discard path (guarded by
  // rename-safety + a malformed-sidecar re-dispatch). Off by default; the escape hatch, not the norm.
  implementDisposition: z.enum(["reject", "discard"]).default("reject"),
```

- [ ] **Step 4: Run it, verify it passes**

Run: `bun test test/config/runtime-config.test.ts -t "implementDisposition"`
Expected: PASS.

- [ ] **Step 5: Write the failing test for handler wiring**

In the checks + implement handler tests, assert disposition reaches `runAgentDispatch`. If the handler tests stub `runAgentDispatch`, assert the `disposition` in the spec it receives:

```ts
test("checks:dispatch runs with disposition=discard", async () => {
  const spec = await captureChecksDispatchSpec(/* seed a ticket with ACs */);
  expect(spec.disposition).toBe("discard");
});
test("implement:dispatch uses config.implementDisposition (default reject)", async () => {
  const spec = await captureImplementDispatchSpec({ config: DEFAULT_RUNTIME_CONFIG });
  expect(spec.disposition).toBe("reject");
});
test("implement:dispatch honors config.implementDisposition=discard", async () => {
  const spec = await captureImplementDispatchSpec({
    config: { ...DEFAULT_RUNTIME_CONFIG, implementDisposition: "discard" },
  });
  expect(spec.disposition).toBe("discard");
});
```

(Use whatever capture/stub the existing handler tests use. If they run `runAgentDispatch` for real against a fake runner, assert the observable outcome — checks discards a loose file; implement default rejects it — instead of the spec field.)

- [ ] **Step 6: Run them, verify they fail**

Run: `bun test test/dispatch -t "disposition"`
Expected: FAIL — handlers don't set `disposition`.

- [ ] **Step 7: Wire the handlers**

In `src/dispatch/handlers.ts`, `checks:dispatch` spec (add after `commitScope`, `:576`):

```ts
      commitScope: checksScopeFor(ctx.ticket.ident, [...acIds]),
      disposition: "discard",
```

Apply the **same** `disposition: "discard"` to the re-author dispatch spec (`:252` area — the other `checksScopeFor` call site).

In the `implement:dispatch` spec (after `commitScope: implementScope`, `:930`):

```ts
        commitScope: implementScope,
        disposition: ctx.config.implementDisposition,
```

- [ ] **Step 8: Add the implement discard-path malformed-sidecar guard**

Still in the `implement:dispatch` handler: capture `preHead` before the dispatch (mirror checks `:563`), and after `runAgentDispatch` returns, when discard is active, re-validate the sidecar — a *present-but-malformed* sidecar is a transport failure (CLAUDE.md §3a) and must re-dispatch, never discard-all-and-succeed:

```ts
    const implPreHead = worktreeHead(implWorktreePath);
    const result = await runAgentDispatch(/* ... existing args ... */);
    // Discard-path guard (blocker): in reject mode a malformed sidecar already rejects → re-dispatch.
    // In discard mode implementScope would treat malformed-as-empty and DISCARD every new file, turning
    // a transport failure into a silent partial commit. Detect present-but-malformed and re-dispatch.
    if (ctx.config.implementDisposition === "discard") {
      const parsed = extractSidecar(result.output, ImplementOutputSchema);
      if (!parsed.ok && parsed.reason !== "absent") {
        resetWorktreeHard(implWorktreePath, implPreHead);
        throw new Error(`implement:dispatch sidecar ${parsed.reason}: ${parsed.detail}`);
      }
    }
```

(Verify `extractSidecar`'s `reason` value for a missing block — the guard must fire only on *malformed*, not *absent* per `ImplementOutputSchema`'s "absent is not a transport failure" contract. If the reason token differs, match the actual token.)

Add `resetWorktreeHard`, `extractSidecar`, `ImplementOutputSchema` to imports if not already present.

- [ ] **Step 9: Run the handler + config tests, then the full suite**

Run: `bun test test/dispatch test/config`
Expected: PASS. Then `bun test` (full suite) to catch e2e handler tests that assert the old checks reject behavior — reconcile any that seed a checks throwaway file and expect an escalation; they should now expect a discard + success.

- [ ] **Step 10: tsc + biome + commit**

Run: `bunx tsc --noEmit && bunx biome check src/config/runtime-config.ts src/dispatch/handlers.ts`
```bash
git add src/config/runtime-config.ts src/dispatch/handlers.ts test/config/runtime-config.test.ts test/dispatch
git commit -m "feat(dispatch): checks discards, implement flag-gated (default reject)"
```

---

## Task 3: Legible discard feedback for checks (blocker 3)

**Files:**
- Modify: `src/dispatch/handlers.ts` (checks:dispatch postcondition path)
- Test: the checks handler test file

**Interfaces:**
- Consumes: `runAgentDispatch(...).discarded` (Task 1); the existing `missReason` map + uncovered-AC throw (`handlers.ts:590,664-665,687-693`).

- [ ] **Step 1: Write the failing test**

```ts
test("checks: a discarded helper a check imports surfaces in the failure feedback", async () => {
  // seed a ticket + 1 AC; fake agent writes the canonical test ENG-x_ac1_test.py that imports
  // `util`, plus a loose undeclared `util.py` (outside styre_checks/ → discarded), and a sidecar
  // declaring only the test. The RED-first run yields selected-none (collection error).
  await expect(runChecksDispatchFixture(/* ... */)).rejects.toThrow(/discarded this attempt: .*util\.py/);
});
```

- [ ] **Step 2: Run it, verify it fails**

Run: `bun test <checks handler test> -t "discarded helper"`
Expected: FAIL — the thrown message names no discarded files.

- [ ] **Step 3: Thread `discarded` into the uncovered-AC message**

In `checks:dispatch`, capture `discarded` from the dispatch result (`:567-571`):

```ts
    const { sha, output, dispatchId: did, discarded } = await runAgentDispatch(/* ... */);
```

At the uncovered-AC throw (`:687-693`), append a diagnosis-only line naming discarded files when any were discarded (INV-B — a *why-it-failed* fact, not an instruction):

```ts
      if (uncovered.length > 0) {
        const detail = uncovered
          .map((a) => `AC ${a.seq}: ${missReason.get(a.id) ?? "no valid check authored for this AC"}`)
          .join("; ");
        const discardNote =
          discarded.length > 0
            ? ` (note: these undeclared files were discarded this attempt and are not in the commit: ${discarded.join(", ")})`
            : "";
        throw new Error(`checks:dispatch postcondition: ${detail}${discardNote}`);
      }
```

- [ ] **Step 4: Run it, verify it passes**

Run: `bun test <checks handler test> -t "discarded helper"`
Expected: PASS.

- [ ] **Step 5: tsc + biome + commit**

Run: `bunx tsc --noEmit && bunx biome check src/dispatch/handlers.ts`
```bash
git add src/dispatch/handlers.ts test/dispatch
git commit -m "feat(checks): name discarded files in the collection-failure feedback"
```

---

## Task 4: INV-A prompt (checks.md) + docstring reconcile

**Files:**
- Modify: `prompts/checks.md` (remove the `styre_scratch/` paragraph)
- Modify: `src/dispatch/commit-scope.ts` (docstring text only — no logic change)
- Test: `test/dispatch/checks-prompt.test.ts` (+ any prompt-assertion test for checks)

**Interfaces:** none (prompt + comments).

- [ ] **Step 1: Update the failing prompt-assertion test**

In `test/dispatch/checks-prompt.test.ts`, replace the assertion that the prompt mentions `styre_scratch/` with one asserting the new declare-or-discard guidance and the *absence* of the scratch paragraph:

```ts
test("checks.md tells the agent undeclared new files are not committed (no styre_scratch drawer)", () => {
  const prompt = readFileSync("prompts/checks.md", "utf8");
  expect(prompt).not.toContain("styre_scratch");
  expect(prompt).toMatch(/undeclared[^.]*won'?t be committed|treated as throwaway/i);
});
```

Leave any `implement.md` (`prompt-vars.test.ts`) scratch assertions **unchanged** — implement keeps its guidance.

- [ ] **Step 2: Run it, verify it fails**

Run: `bun test test/dispatch/checks-prompt.test.ts`
Expected: FAIL — the prompt still contains `styre_scratch`.

- [ ] **Step 3: Edit `prompts/checks.md`**

Delete the `styre_scratch/` bullet (`:40-48`) and replace with:

```markdown
- **Declare every new file that is part of your check** in `checksAuthored` (the RED-first test via
  `test_file`) and any genuine test helper in `new_files`. Any new file you create but do NOT declare
  is treated as throwaway and will not be committed — you don't need a special folder for scratch, and
  you must not park throwaway files in `new_files`.
```

- [ ] **Step 4: Run it, verify it passes**

Run: `bun test test/dispatch/checks-prompt.test.ts`
Expected: PASS.

- [ ] **Step 5: Reconcile stale docstrings (no logic change)**

In `src/dispatch/commit-scope.ts`, update the `implementScope`/`checksScopeFor` docstrings (`:16-18`, `:25-29`) that say "reject-and-retry, never a silent drop": note that the *disposition* (in `run-dispatch.ts`) now decides reject-vs-discard for out-of-scope new files, and these predicates only classify in/out of scope. Keep it factual; do not change any code.

- [ ] **Step 6: Full suite + tsc + biome + commit**

Run: `bun test && bunx tsc --noEmit && bunx biome check`
Expected: full suite green.
```bash
git add prompts/checks.md src/dispatch/commit-scope.ts test/dispatch/checks-prompt.test.ts
git commit -m "docs(checks): replace styre_scratch guidance with declare-or-discard (INV-A)"
```

---

## Self-Review (author checklist — done)

**Spec coverage:** §4 disposition per step → Tasks 1+2; §5 mechanism + rename-safety → Task 1; §5 keep-both-sweeps → Global Constraints (no sweep removal task, corrected from design §5); §6 INV-A → Task 4, INV-B diagnosis-only → Task 1 messages; §6 blocker-3 feedback → Task 3; §8 implement flag + malformed-sidecar guard → Task 2; §7 ENG-323 untouched → no task (correct); §11 tests → each task's tests; §12 AC → covered.

**Plan-vs-design deltas (intentional, flagged to operator):** (1) the design's §5 "remove the primary sweep" is NOT done — it would break implement's reject+`styre_scratch/` path; both sweeps stay. (2) rename-safety uses a new `PendingEntry.isDeleted` flag; git-detected renames are already safe (paired as `isNew=false`).

**Placeholder scan:** none — every code step has concrete code; test harness names (`runDispatchFixture`, `captureChecksDispatchSpec`) are explicitly "adapt to the existing harness," not invented requirements.

**Type consistency:** `PendingEntry.isDeleted` (Task 1) used by the same-task mechanism; `disposition` field (Task 1) set by handlers (Task 2); `discarded` return (Task 1) consumed by Task 3; `implementDisposition` (Task 2) read in the same task.

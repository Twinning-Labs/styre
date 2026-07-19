# Checks scope-guard disposition (declare-or-discard) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop `checks:dispatch` from rejecting-and-wedging on undeclared throwaway files by *discarding* them instead, while keeping `implement`/`plan`/`docs` on today's reject behavior.

**Architecture:** Add an optional `disposition: "reject" | "discard"` to `DispatchSpec`. `runAgentDispatch` handles out-of-scope files by disposition: `reject` throws (today's behavior); `discard` deletes undeclared new files, records a telemetry note, and continues. Out-of-scope *tracked edits* always reject. A rename-safety guard never discards an undeclared new file when the dispatch also deletes a tracked file. The `checks:dispatch`/re-author handlers set `discard`; `implement` reads it from a new `implementDisposition` runtime-config flag (default `reject`).

**Tech Stack:** TypeScript, Bun test runner (`bun test`), embedded SQLite, zod.

## Global Constraints

- **Default is `reject`.** `DispatchSpec.disposition` is optional and defaults to `reject`, so `plan`, `docs`, and any un-migrated call site are unchanged. Only `checks:dispatch`/re-author opt into `discard`; `implement` reads the flag (default `reject`).
- **Reject messages keep the `out-of-scope files` prefix and are scope-neutral & diagnosis-only (INV-B).** Do NOT print "declare them or delete them" (an instruction) and do NOT print "not listed in new_files" (false for the path-based `plan`/`docs` scopes). The existing tests assert `/out-of-scope files/`; keep that substring.
- **INV-A — checks.md only.** Remove only the `styre_scratch/` throwaway line from `prompts/checks.md`. **Do NOT touch `prompts/implement.md`** (implement still rejects and still needs the drawer).
- **Never silently drop a legit file.** Discard deletes only *undeclared new untracked* files; a tracked edit is never reverted by discard; an undeclared new file coinciding with a tracked deletion is rejected (rename-safety); and an implement discard triggered by an absent/malformed sidecar re-dispatches (transport failure, §3a).
- **Keep both sweeps.** `sweepScratch` and BOTH its call sites (`run-dispatch.ts` primary, `handlers.ts` pre-verify) stay. Removing the primary sweep would make implement's `styre_scratch/` files reject (the pre-verify sweep sits *after* the commit gate). This plan does NOT remove any sweep. (This intentionally overrides the design doc's original §5/§11/§12 "remove the primary sweep" — the design has been reconciled to keep-both.)
- Run tests with `bun test <path>`; the full suite is `bun test`; `bunx tsc --noEmit` and `bunx biome check` must stay clean.

**Test harness (the real one — use it; do NOT invent fixtures):**
- `test/dispatch/run-dispatch.test.ts` already defines `gitRepo()` (temp repo, commits `README.md`), `ctxFor(db, ticketId)`, `depsFor(repo, wt)`, and drives real dispatches via `new FakeAgentRunner((input) => { writeFileSync(join(input.cwd, ...)); return { completed:true, exitCode:0, stdout, stderr:"", timedOut:false, costUsd, tokensIn, tokensOut }; })`. The sidecar rides in `stdout` as a ` ```styre-sidecar ` block. Read dispatch rows with `listByTicket(db, ticketId)` (from `db/repos/dispatch.ts`); read events with `listEvents(db, ticketId)` (imported as `listByTicket as listEvents` from `db/repos/event-log.ts`). To check what got committed, inspect the worktree (`existsSync(join(wt, path))`) or `git show --name-only`.
- `test/dispatch/worktree.test.ts` defines `repo()` (commits `tracked.txt` + `deleteme.txt`). It ALREADY has the `isNew` test at `:247` and the staged-rename test at `:259` — extend those, don't duplicate.

---

## Task 1: Disposition mechanism in `runAgentDispatch` (CRUX)

**Files:**
- Modify: `src/dispatch/worktree.ts` (add `isDeleted` to `PendingEntry`; add `discardPaths`)
- Modify: `src/dispatch/run-dispatch.ts` (add `disposition` to `DispatchSpec`; rework the offender block; return `discarded`)
- Test: `test/dispatch/worktree.test.ts`, `test/dispatch/run-dispatch.test.ts`

**Interfaces produced (later tasks rely on these):**
- `PendingEntry { path: string; isNew: boolean; isDeleted: boolean }`
- `discardPaths(worktreePath: string, paths: string[]): void`
- `DispatchSpec.disposition?: "reject" | "discard"` (default `reject`)
- `runAgentDispatch(...)` return gains `discarded: string[]`.

- [ ] **Step 1: Extend the existing `pendingEntries` test to assert `isDeleted`**

In `test/dispatch/worktree.test.ts`, update the test at `:247` ("pendingEntries: new file → isNew…"): after the existing `isNew` assertions add:

```ts
  expect(entries.find((e) => e.path === "deleteme.txt")?.isDeleted).toBe(true);
  expect(entries.find((e) => e.path === "brand_new.py")?.isDeleted).toBe(false);
  expect(entries.find((e) => e.path === "tracked.txt")?.isDeleted).toBe(false);
```

- [ ] **Step 2: Run it, verify it fails**

Run: `bun test test/dispatch/worktree.test.ts -t "pendingEntries: new file"`
Expected: FAIL — `isDeleted` is `undefined`.

- [ ] **Step 3: Add `isDeleted` to `PendingEntry` and populate it**

In `src/dispatch/worktree.ts`, change the interface (`:125-128`) and the parse loop (`:148-155`):

```ts
export interface PendingEntry {
  path: string;
  isNew: boolean;
  /** True iff this entry deletes a tracked file (porcelain status contains `D`). The discard
   *  disposition's rename-safety guard uses it: an undeclared new file coinciding with a tracked
   *  deletion may be a move git did not pair, so it must not be silently discarded. */
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
      // original path of a git-DETECTED rename/copy: a tracked move, not a new file and not a bare
      // deletion (git paired it) → isNew=false, isDeleted=false.
      if (i < tokens.length) entries.push({ path: tokens[i], isNew: false, isDeleted: false });
    }
  }
```

- [ ] **Step 4: Run it, verify it passes (and the whole file, incl. the rename test at :259)**

Run: `bun test test/dispatch/worktree.test.ts`
Expected: PASS. The staged-rename test at `:259` must still pass (rename status `R ` has no `D` → `isDeleted=false`).

- [ ] **Step 5: Write the failing test for `discardPaths`**

In `test/dispatch/worktree.test.ts` (use the existing `repo()` helper):

```ts
test("discardPaths removes only the named untracked files, spares the rest", () => {
  const dir = repo();
  writeFileSync(join(dir, "keep.py"), "1\n");
  mkdirSync(join(dir, "sub"), { recursive: true });
  writeFileSync(join(dir, "sub", "junk.py"), "2\n");
  discardPaths(dir, ["sub/junk.py"]);
  expect(existsSync(join(dir, "sub", "junk.py"))).toBe(false);
  expect(existsSync(join(dir, "keep.py"))).toBe(true);
});

test("discardPaths is a no-op on empty input and never throws on a missing path", () => {
  const dir = repo();
  expect(() => discardPaths(dir, [])).not.toThrow();
  expect(() => discardPaths(dir, ["does/not/exist.py"])).not.toThrow();
});
```

(Add `discardPaths` to the import from `../../src/dispatch/worktree.ts`, and `existsSync`/`mkdirSync` to the node:fs import if missing.)

- [ ] **Step 6: Run it, verify it fails**

Run: `bun test test/dispatch/worktree.test.ts -t "discardPaths"`
Expected: FAIL — `discardPaths` is not exported.

- [ ] **Step 7: Implement `discardPaths`**

In `src/dispatch/worktree.ts`, next to `undoAttempt`:

```ts
/** Delete the named untracked files from the worktree — the discard disposition (checks): each path
 *  is a brand-new untracked file this dispatch created and did not declare. Mirrors undoAttempt's
 *  `git clean -fd` idiom (removes the files + any now-empty untracked dirs they created), scoped to
 *  exactly these pathspecs so pre-existing cruft is spared. No-op / never throws on empty input. */
export function discardPaths(worktreePath: string, paths: string[]): void {
  if (paths.length === 0) return;
  git(["clean", "-fd", "--", ...paths], worktreePath);
}
```

- [ ] **Step 8: Run it, verify it passes**

Run: `bun test test/dispatch/worktree.test.ts`
Expected: PASS.

- [ ] **Step 9: Write the failing disposition tests (real harness)**

In `test/dispatch/run-dispatch.test.ts`, add `import type { CommitScope } from "../../src/dispatch/commit-scope.ts";` and this block. A small local helper keeps the four cases readable:

```ts
// A checks-style scope: a NEW file is in scope iff declared; tracked edits are always in scope.
const declaredScope = (declared: string[]): CommitScope => () => (path, isNew) =>
  !isNew || declared.includes(path);

// Run one dispatch: the fake agent applies `apply(cwd)` then returns `stdout`. Returns the db +
// ticketId + worktree so the test can inspect the commit and the event log.
async function runWith(opts: {
  disposition?: "reject" | "discard";
  commitScope: CommitScope;
  apply: (cwd: string) => void;
  stdout: string;
}) {
  const { db, ticketId } = makeTestDb();
  const repo = gitRepo();
  const wt = join(repo, "..", `wt-${Math.random().toString(36).slice(2)}`);
  const runner = new FakeAgentRunner((input) => {
    opts.apply(input.cwd);
    return { completed: true, exitCode: 0, stdout: opts.stdout, stderr: "", timedOut: false, costUsd: 0, tokensIn: 1, tokensOut: 1 };
  });
  const promise = runAgentDispatch(ctxFor(db, ticketId), { runner, ...depsFor(repo, wt) }, {
    handlerKey: "checks:dispatch",
    template: "t {{ident}}",
    vars: { ident: "ENG-1" },
    commitScope: opts.commitScope,
    disposition: opts.disposition,
    postcondition: () => {},
  });
  return { db, ticketId, wt, promise };
}
const sidecar = (obj: unknown) => `x\n\`\`\`styre-sidecar\n${JSON.stringify(obj)}\n\`\`\``;

test("discard: undeclared new file is deleted + noted, declared file + tracked edit committed, no throw", async () => {
  const { db, ticketId, wt, promise } = await runWith({
    disposition: "discard",
    commitScope: declaredScope(["b.ts"]),
    apply: (cwd) => {
      writeFileSync(join(cwd, "README.md"), "edited\n"); // tracked edit (README is committed by gitRepo)
      writeFileSync(join(cwd, "b.ts"), "declared\n");     // declared new
      writeFileSync(join(cwd, "scratch.py"), "junk\n");   // undeclared new
    },
    stdout: sidecar({ new_files: ["b.ts"] }),
  });
  const out = await promise;
  expect(out.discarded).toEqual(["scratch.py"]);
  expect(existsSync(join(wt, "scratch.py"))).toBe(false);        // discarded from worktree
  const committed = Bun.spawnSync(["git", "show", "--name-only", "--format=", "HEAD"], { cwd: wt }).stdout.toString();
  expect(committed).toContain("b.ts");
  expect(committed).toContain("README.md");
  expect(committed).not.toContain("scratch.py");
  const notes = listEvents(db, ticketId).filter((e) => e.reason?.startsWith("scope-discarded"));
  expect(notes.length).toBe(1);
  db.close();
});

test("discard + tracked deletion: undeclared new file is REJECTED (rename-safety), not discarded", async () => {
  const { db, wt, promise } = await runWith({
    disposition: "discard",
    commitScope: declaredScope([]),
    apply: (cwd) => {
      rmSync(join(cwd, "README.md")); // delete the one tracked file → a bare deletion
      writeFileSync(join(cwd, "moved.ts"), "content\n"); // undeclared new
    },
    stdout: sidecar({ new_files: [] }),
  });
  await expect(promise).rejects.toThrow(/out-of-scope files.*deletion|possible move/);
  db.close();
});

test("reject disposition: undeclared new file throws with out-of-scope files", async () => {
  const { db, promise } = await runWith({
    disposition: "reject",
    commitScope: declaredScope([]),
    apply: (cwd) => writeFileSync(join(cwd, "scratch.py"), "junk\n"),
    stdout: sidecar({ new_files: [] }),
  });
  await expect(promise).rejects.toThrow(/out-of-scope files/);
  db.close();
});

test("default disposition is reject", async () => {
  const { db, promise } = await runWith({
    // disposition omitted
    commitScope: declaredScope([]),
    apply: (cwd) => writeFileSync(join(cwd, "scratch.py"), "junk\n"),
    stdout: sidecar({ new_files: [] }),
  });
  await expect(promise).rejects.toThrow(/out-of-scope files/);
  db.close();
});
```

(Add `rmSync` to the node:fs import.)

- [ ] **Step 10: Run them, verify they fail**

Run: `bun test test/dispatch/run-dispatch.test.ts -t "disposition"` (and the discard/reject tests)
Expected: FAIL — `disposition` isn't on `DispatchSpec`; discard path doesn't exist.

- [ ] **Step 11: Add `disposition` to `DispatchSpec`**

In `src/dispatch/run-dispatch.ts` (`DispatchSpec`, after `commitScope?`, near `:50`):

```ts
  /** How out-of-scope NEW files are handled: "reject" (default — revert + throw, today's behavior) or
   *  "discard" (delete the undeclared new files + emit a note + continue). Out-of-scope tracked EDITS
   *  always reject regardless. checks:dispatch/re-author set "discard"; implement reads it from
   *  runtime-config; plan/docs/omitted callers get "reject". */
  disposition?: "reject" | "discard";
```

- [ ] **Step 12: Rework the offender block (replace `run-dispatch.ts:188-220` — the `let sha/changed` decls through the end of the `else` read-only branch)**

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

    // INV-B: every reason is a diagnosis (the fact), never an instruction. Keep the scope-neutral
    // "out-of-scope files" prefix (existing tests + all steps assert it).
    const reasons: string[] = [];
    if (offendingEdits.length > 0) {
      reasons.push(`tracked edits outside this step's scope: ${offendingEdits.join(", ")}`);
    }
    if (offendingNew.length > 0) {
      if (disposition === "reject") {
        reasons.push(`undeclared new files: ${offendingNew.join(", ")}`);
      } else if (hasTrackedDeletion) {
        // rename-safety: git did not pair these; discarding the new half while committing the
        // deletion would be silent data loss on a move.
        reasons.push(`undeclared new files alongside a tracked deletion (possible move): ${offendingNew.join(", ")}`);
      }
    }
    if (reasons.length > 0) {
      undoAttempt(deps.worktreePath, untrackedBefore);
      completeDispatch(ctx.db, inserted.id, { outcome: "dispatch-failed", branchHeadSha: preHead, endedAt: nowUtc() });
      throw new Error(`dispatch ${did} out-of-scope files — ${reasons.join("; ")}`);
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
    const stray = judged.filter((e) => e.isNew).map((e) => e.path);
    if (stray.length > 0) {
      appendEvent(ctx.db, { ticketId: ctx.ticket.id, kind: "note", reason: `scratch-ignored:${spec.handlerKey}`, payload: { stray } });
    }
    ({ sha, changed } = commitWorktree(deps.worktreePath, `${did} ${spec.handlerKey}`, []));
  }
```

Add `discardPaths` to the `./worktree.ts` import block (`:15-22`).

- [ ] **Step 13: Return `discarded`**

Change the return type (`:97`) and the return (`:238`):

```ts
): Promise<{ dispatchId: string; sha: string; changed: boolean; output: string; discarded: string[] }> {
```
```ts
  return { dispatchId: did, sha, changed, output: result.stdout, discarded };
```

- [ ] **Step 14: Run the disposition tests + the FULL suite**

Run: `bun test test/dispatch/run-dispatch.test.ts` then `bun test`.
Expected: the new tests PASS. Three pre-existing tests assert the reject message via `/out-of-scope files/` and still pass because the prefix is preserved: `run-dispatch.test.ts:363`, `test/dispatch/worktree-guard.test.ts:151`, `test/dispatch/docs-revise-handler.test.ts:143`. If any asserted the removed "declare them…" instruction text, update it to match the new diagnosis-only message (behavior unchanged). Full suite must be green before committing.

- [ ] **Step 15: tsc + biome + commit**

Run: `bunx tsc --noEmit && bunx biome check src/dispatch/run-dispatch.ts src/dispatch/worktree.ts`
```bash
git add src/dispatch/run-dispatch.ts src/dispatch/worktree.ts test/dispatch/run-dispatch.test.ts test/dispatch/worktree.test.ts
git commit -m "feat(dispatch): add discard disposition to the commit scope guard"
```

---

## Task 2: Wire handlers + the `implementDisposition` flag

**Files:**
- Modify: `src/config/runtime-config.ts`
- Modify: `src/dispatch/handlers.ts` (checks `:576`, re-author `:252`, implement `:930` + a discard-mode sidecar guard)
- Test: the nearest runtime-config test; the checks + implement handler tests (`test/dispatch/checks-handler.test.ts`, `test/dispatch/handlers*.test.ts` — full-loop harness; assert OBSERVABLE outcomes, there is no spec-capture seam)

**Interfaces consumed:** `DispatchSpec.disposition`, `runAgentDispatch(...).discarded` (Task 1); `ctx.config: RuntimeConfig`; `extractSidecar` → `{ ok:false; reason:"absent"|"malformed"; detail }` (`sidecar.ts:5`); `resetWorktreeHard`, `worktreeHead` (already imported in handlers.ts); `ImplementOutputSchema` (import it — the only symbol not already imported).
**Interfaces produced:** `RuntimeConfig.implementDisposition: "reject" | "discard"` (default `"reject"`).

- [ ] **Step 1: Failing test for the config field**

```ts
test("implementDisposition defaults to reject", () => {
  expect(DEFAULT_RUNTIME_CONFIG.implementDisposition).toBe("reject");
});
test("implementDisposition accepts discard", () => {
  expect(RuntimeConfigSchema.parse({ implementDisposition: "discard" }).implementDisposition).toBe("discard");
});
```

- [ ] **Step 2: Run it, verify it fails**

Run: `bun test -t "implementDisposition"` — FAIL (field absent).

- [ ] **Step 3: Add the field** (in `RuntimeConfigSchema`, `runtime-config.ts`)

```ts
  // Checks-disposition arc: how implement handles undeclared new files. Default "reject" (proven,
  // today's behavior). "discard" opts implement into the checks-style discard path (guarded by
  // rename-safety + a sidecar re-dispatch guard). Off by default — the escape hatch, not the norm.
  implementDisposition: z.enum(["reject", "discard"]).default("reject"),
```

- [ ] **Step 4: Run it, verify it passes** — `bun test -t "implementDisposition"` → PASS.

- [ ] **Step 5: Failing handler-wiring tests (observable outcomes, full-loop harness)**

Using the `checks-handler.test.ts` / handler-test pattern (a `FakeAgentRunner` + the real registry), assert the OUTCOME, since handlers build `DispatchSpec` internally:

```ts
test("checks:dispatch discards an undeclared loose file instead of rejecting", async () => {
  // seed a ticket with 1 AC; fake agent writes the canonical ENG-x_ac1_test.* (declared) AND a loose
  // `scratch.py`, sidecar declares only the test. Expect: dispatch succeeds (no escalation), scratch.py
  // is not committed, a scope-discarded note exists.
});
test("implement:dispatch (default reject) rejects an undeclared loose file", async () => {
  // config = DEFAULT_RUNTIME_CONFIG; fake agent creates undeclared `junk.py`; expect the dispatch to
  // fail/loopback (today's behavior), junk.py not committed.
});
test("implement:dispatch honors implementDisposition=discard", async () => {
  // config.implementDisposition="discard"; agent creates undeclared `junk.py`; expect success + a
  // scope-discarded note + junk.py not committed.
});
test("implement discard + malformed sidecar re-dispatches (transport failure), does not clean-success", async () => {
  // config.implementDisposition="discard"; agent edits README + emits a MALFORMED sidecar block; expect
  // the step to throw/re-dispatch and the dispatch row NOT to be a clean-success pointing at a live commit.
});
test("implement discard + absent sidecar WITH undeclared new files re-dispatches", async () => {
  // config.implementDisposition="discard"; agent creates undeclared `x.ts` and emits NO sidecar; expect
  // re-dispatch (not silent discard), per design §8 / no-silent-drop.
});
```

(Model these on the existing handler tests' seeding. If the loop harness makes "reject/re-dispatch" hard to assert directly, assert the dispatch-row `outcome` (`listByTicket`) + committed files + the presence/absence of a `scope-discarded` note.)

- [ ] **Step 6: Run them, verify they fail** — `bun test test/dispatch -t "discard"` → FAIL.

- [ ] **Step 7: Wire the three call sites**

`handlers.ts` — checks:dispatch (`:576`, after `commitScope`): add `disposition: "discard",`. Apply the **same** to the re-author dispatch (`:252`). implement:dispatch (`:930`, after `commitScope: implementScope`): add `disposition: ctx.config.implementDisposition,`.

- [ ] **Step 8: Add the implement discard-mode sidecar guard (+ dispatch-row hygiene)**

In the implement handler, capture `preHead` before the dispatch (mirror checks `:563`) and, after `runAgentDispatch`, when in discard mode, treat a malformed sidecar (always) OR an absent sidecar that caused a discard (undeclared new files with no declaration) as a transport failure → roll back + re-dispatch (design §3a / §8; never silent-drop). Mirror the checks reverted-marking so no `clean-success` row points at a reset-away commit:

```ts
    const implPreHead = worktreeHead(implWorktreePath);
    const result = await runAgentDispatch(/* ...existing args, now incl. disposition... */);
    if (ctx.config.implementDisposition === "discard") {
      const parsed = extractSidecar(result.output, ImplementOutputSchema);
      const malformed = !parsed.ok && parsed.reason === "malformed";
      const absentButDiscarded = !parsed.ok && parsed.reason === "absent" && result.discarded.length > 0;
      if (malformed || absentButDiscarded) {
        resetWorktreeHard(implWorktreePath, implPreHead);
        markReverted(ctx.db, result.dispatchId, implPreHead); // mirror checks' reverted-marking (handlers.ts:738-747)
        throw new Error(
          `implement:dispatch sidecar transport failure (${parsed.ok ? "ok" : parsed.reason}); ` +
            `discarded=[${result.discarded.join(", ")}] — re-dispatching`,
        );
      }
    }
```

(Use whatever the checks handler calls to re-mark the dispatch row `reverted` at `:738-747` — reuse that exact repo function, don't invent one. Add `ImplementOutputSchema` to the imports.)

- [ ] **Step 9: Run handler + config tests, then the full suite**

Run: `bun test test/dispatch test/config` then `bun test`.
Expected: PASS. Reconcile any e2e handler test that seeded a checks throwaway file and expected an escalation — it should now expect discard + success. (Grep confirms `commit-scope.test.ts` is a predicate unit test unaffected by disposition; checks uncovered-AC postcondition behavior is unchanged.)

- [ ] **Step 10: tsc + biome + commit**

Run: `bunx tsc --noEmit && bunx biome check src/config/runtime-config.ts src/dispatch/handlers.ts`
```bash
git add src/config/runtime-config.ts src/dispatch/handlers.ts test/config test/dispatch
git commit -m "feat(dispatch): checks discards, implement flag-gated (default reject) with sidecar guard"
```

---

## Task 3: Legible discard feedback for checks (blocker 3)

**Files:** Modify `src/dispatch/handlers.ts` (checks:dispatch); Test: the checks handler test file.
**Interfaces consumed:** `runAgentDispatch(...).discarded` (Task 1); the uncovered-AC throw (`handlers.ts:687-693`).

- [ ] **Step 1: Failing test**

```ts
test("checks: a discarded helper a check imports is named in the failure feedback", async () => {
  // seed 1 AC; agent writes canonical ENG-x_ac1_test.py importing `util`, plus a loose undeclared
  // `util.py` (discarded), sidecar declares only the test. RED-first yields selected-none → uncovered.
  // Assert the thrown/loopback message names util.py.
  await expect(runChecks(/* ... */)).rejects.toThrow(/discarded this attempt: .*util\.py/);
});
```

- [ ] **Step 2: Run it, verify it fails** — the thrown message names no discarded files → FAIL.

- [ ] **Step 3: Thread `discarded` into the uncovered-AC message**

Capture `discarded` from the dispatch result (`:567-571`): `const { sha, output, dispatchId: did, discarded } = await runAgentDispatch(...)`. At the uncovered-AC throw (`:687-693`), keep the phrasing in sync with the test regex:

```ts
      if (uncovered.length > 0) {
        const detail = uncovered
          .map((a) => `AC ${a.seq}: ${missReason.get(a.id) ?? "no valid check authored for this AC"}`)
          .join("; ");
        const discardNote =
          discarded.length > 0 ? ` — undeclared files discarded this attempt: ${discarded.join(", ")}` : "";
        throw new Error(`checks:dispatch postcondition: ${detail}${discardNote}`);
      }
```

(The message contains `discarded this attempt: <paths>`, matching the Step-1 regex `/discarded this attempt: .*util\.py/`.)

- [ ] **Step 4: Run it, verify it passes.** **Step 5: tsc + biome + commit**

```bash
git add src/dispatch/handlers.ts test/dispatch
git commit -m "feat(checks): name discarded files in the collection-failure feedback"
```

---

## Task 4: INV-A prompt (checks.md) + docstring reconcile

**Files:** Modify `prompts/checks.md`, `src/dispatch/commit-scope.ts` (comments only); Test: `test/dispatch/checks-prompt.test.ts`.

- [ ] **Step 1: Update the one breaking assertion**

`checks-prompt.test.ts:24` asserts `expect(CHECKS_TEMPLATE).toContain("styre_scratch/")` (the only assertion that breaks — `"reject"` at `checks.md:13` and `"styre_checks/"` at `:14,15,23,63` survive). Replace that line's assertion with:

```ts
  expect(CHECKS_TEMPLATE).not.toContain("styre_scratch");
  expect(CHECKS_TEMPLATE).toMatch(/undeclared[^.]*(won'?t be committed|throwaway)/i);
```

Keep asserting against `CHECKS_TEMPLATE` (it already IS the file's text via `prompt-vars.ts`); do not switch to `readFileSync`. Leave `prompt-vars.test.ts` (implement) untouched.

- [ ] **Step 2: Run it, verify it fails** — `bun test test/dispatch/checks-prompt.test.ts` → FAIL (prompt still has `styre_scratch`).

- [ ] **Step 3: Edit `prompts/checks.md`** — delete the `styre_scratch/` throwaway bullet (`:40-48`), replace with:

```markdown
- **Declare every new file that is part of your check** — the RED-first test via `checksAuthored`
  (`test_file`) and any genuine test helper (fixture, `conftest.py`) via `new_files`. Any new file you
  create but do NOT declare is treated as throwaway and won't be committed; you don't need a special
  folder for scratch, and you must not park throwaway files in `new_files`.
```

- [ ] **Step 4: Run it, verify it passes** — `bun test test/dispatch/checks-prompt.test.ts` → PASS.

- [ ] **Step 5: Reconcile stale docstrings (no logic change)** — in `commit-scope.ts` (`:16-18`, `:25-29`), the "reject-and-retry, never a silent drop" lines are now only true for `reject` disposition; note that `run-dispatch.ts`'s disposition decides reject-vs-discard for out-of-scope new files, and these predicates only classify in/out of scope. Comment-only.

- [ ] **Step 6: Full suite + tsc + biome + commit**

Run: `bun test && bunx tsc --noEmit && bunx biome check`
```bash
git add prompts/checks.md src/dispatch/commit-scope.ts test/dispatch/checks-prompt.test.ts
git commit -m "docs(checks): replace styre_scratch guidance with declare-or-discard (INV-A)"
```

---

## Self-Review (author checklist — done, incl. plan-review fold)

**Spec coverage:** §4 disposition → Tasks 1+2; §5 mechanism + rename-safety → Task 1; §5 keep-both-sweeps → Global Constraints (design reconciled); §6 INV-A → Task 4; INV-B diagnosis-only + scope-neutral message → Task 1 Step 12; §6 blocker-3 → Task 3; §8 implement flag + sidecar guard (malformed always, absent-with-discard) → Task 2; §7 ENG-323 untouched → no task.

**Plan-review fixes folded:** scope-neutral "out-of-scope files" message keeps the 3 existing tests green and stops the false new_files claim (was C1/C2); Task 3 message/regex agree (was C3); implement discard-path tests added incl. malformed + absent-with-discard (was C4); real harness (`gitRepo`/`ctxFor`/`depsFor`/`FakeAgentRunner`/`repo()`) replaces invented fixtures; case-1 uses README.md as the tracked edit (was I1); dispatch-row reverted-marking added (fidelity finding 3); Task 4 targets only the one breaking assertion and keeps `CHECKS_TEMPLATE`; Task 1 replaces `:188-220`; `CommitScope` type + `ImplementOutputSchema` imports called out.

**Behavior note (documented, low-risk):** pre-commit, git reports a move as ` D old` + `?? new` (unpaired), so the rename-safety guard's conservative branch runs — a checks agent that deletes/renames a tracked file *and* drops throwaway will reject (safe floor), not discard. Acceptable; checks:dispatch rarely deletes tracked source.

**Type consistency:** `PendingEntry.isDeleted` (T1) → used same task; `disposition` (T1) → set by handlers (T2); `discarded` return (T1) → consumed by T2 guard + T3 feedback; `implementDisposition` (T2) → read same task.

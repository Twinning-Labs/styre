# ENG-300 — styre_scratch/ sweep-based scratch drawer — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the checks/implement worker a reserved throwaway folder `styre_scratch/` that styre deletes itself, so scratch never reaches the commit scope guard (no reject→retry→escalate) and never survives into a broad test run.

**Architecture:** A pure `sweepScratch(worktreePath)` helper deletes every `styre_scratch/` directory at any depth. It is called in `runAgentDispatch` right after the agent runs and before the scope-guard enumeration (primary, covers every dispatch), and once more before the verify suite (defense-in-depth). The commit scope guard is unchanged — only the reserved folder name is swept. Prompts point scratch at `styre_scratch/`, replacing ENG-297's `/tmp` guidance (which couldn't run in-repo imports).

**Tech Stack:** TypeScript, Bun (`bun test`), Biome (`bun run lint`). Filesystem via `node:fs`. Prompt templates are markdown imported as text in `src/dispatch/prompt-vars.ts`.

## Global Constraints

- **The commit scope guard, its predicates (`commit-scope.ts`), and its reject-not-drop semantics are UNCHANGED.** Only the reserved `styre_scratch/` name is swept. A non-`styre_scratch/` undeclared new file is still rejected-and-retried exactly as today.
- **The sweep is a filesystem delete**, not a git operation — `styre_scratch/` folders are untracked, so git never enumerates them.
- **No `.git/info/exclude` write; no per-framework runner-ignore config.** The sweep is the sole mechanism.
- **`sweepScratch` never throws** — an unreadable dir or failed remove is best-effort and non-fatal.
- **Verify before every commit:** `bunx tsc --noEmit`, the named `bun test` file(s), AND `bun run lint` (Biome — enforces `noNonNullAssertion`, `useTemplate`, `noEmptyBlockStatements`, formatting). No `!` non-null assertions, no string `+` concatenation, no empty `{}` blocks (put a comment inside a deliberately-empty `catch`).
- **Every commit message ends with:**
  ```
  Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01U6QL6JTMgv66PKAbFe4uk7
  ```

---

## File Structure

- `src/dispatch/worktree.ts` — add `sweepScratch` + a module-private recursive `walk` (Task 1).
- `test/dispatch/worktree.test.ts` — `sweepScratch` unit tests (Task 1).
- `src/dispatch/run-dispatch.ts` — primary sweep + non-gating `note` telemetry (Task 2).
- `src/dispatch/handlers.ts` — defense-in-depth sweep in the `verify:check` handler (Task 2).
- `test/dispatch/run-dispatch.test.ts` — wiring test (Task 2).
- `prompts/checks.md`, `prompts/implement.md` — scratch → `styre_scratch/` (Task 3).
- `test/dispatch/checks-prompt.test.ts`, `test/dispatch/prompt-vars.test.ts` — assertion updates (Task 3).

---

## Task 1: `sweepScratch` helper + unit tests

**Files:**
- Modify: `src/dispatch/worktree.ts` (add `sweepScratch` + private `walk`; add `node:fs` imports)
- Test: `test/dispatch/worktree.test.ts`

**Interfaces:**
- Produces: `export function sweepScratch(worktreePath: string): string[]` — deletes every directory named `styre_scratch` under `worktreePath` (any depth), skips `.git` and `node_modules`, never throws, returns the repo-relative POSIX paths removed.

- [ ] **Step 1: Write the failing tests**

Add to `test/dispatch/worktree.test.ts`. Ensure these `node:fs`/`node:os` imports exist at the top (add any missing to the existing import lines): `mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync` from `node:fs`, `tmpdir` from `node:os`, `join` from `node:path`. Add `sweepScratch` to the existing `../../src/dispatch/worktree.ts` import.

```ts
test("sweepScratch removes every styre_scratch/ dir at any depth and returns their repo-relative paths", () => {
  const root = mkdtempSync(join(tmpdir(), "sweep-"));
  mkdirSync(join(root, "a", "b", "styre_scratch"), { recursive: true });
  writeFileSync(join(root, "a", "b", "styre_scratch", "repro.py"), "x");
  mkdirSync(join(root, "pkg", "styre_scratch"), { recursive: true });
  mkdirSync(join(root, "src", "styre_checks"), { recursive: true }); // sibling convention — must be spared
  writeFileSync(join(root, "keep.ts"), "x");

  const removed = sweepScratch(root).sort();

  expect(removed).toEqual(["a/b/styre_scratch", "pkg/styre_scratch"]);
  expect(existsSync(join(root, "a", "b", "styre_scratch"))).toBe(false);
  expect(existsSync(join(root, "pkg", "styre_scratch"))).toBe(false);
  expect(existsSync(join(root, "src", "styre_checks"))).toBe(true); // spared
  expect(existsSync(join(root, "keep.ts"))).toBe(true);
  rmSync(root, { recursive: true, force: true });
});

test("sweepScratch is a no-op (returns []) with no drawer, and skips .git and node_modules", () => {
  const root = mkdtempSync(join(tmpdir(), "sweep-"));
  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(join(root, ".git", "styre_scratch"), { recursive: true }); // inside .git → skipped
  mkdirSync(join(root, "node_modules", "dep", "styre_scratch"), { recursive: true }); // skipped

  const removed = sweepScratch(root);

  expect(removed).toEqual([]);
  expect(existsSync(join(root, ".git", "styre_scratch"))).toBe(true); // never descended into
  expect(existsSync(join(root, "node_modules", "dep", "styre_scratch"))).toBe(true);
  rmSync(root, { recursive: true, force: true });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test test/dispatch/worktree.test.ts`
Expected: FAIL — `sweepScratch` is not exported (import error).

- [ ] **Step 3: Implement `sweepScratch` + `walk`**

In `src/dispatch/worktree.ts`, extend the top imports. The file currently imports `{ existsSync } from "node:fs"` and `{ join } from "node:path"` (lines 1-2). Change them to:

```ts
import { existsSync, readdirSync, rmSync } from "node:fs";
import { join, relative } from "node:path";
```

Append at the end of the file:

```ts
const SWEEP_SKIP_DIRS = new Set([".git", "node_modules"]);

/** Recursively delete every directory named `styre_scratch/` under `worktreePath` — the worker's
 *  sanctioned throwaway drawer (ENG-300). Placed by the worker next to the code it exercises so its
 *  imports resolve; styre wipes it so scratch never reaches the commit scope guard or a broad test
 *  run. Skips `.git`/`node_modules`; never throws (best-effort). Returns the repo-relative POSIX
 *  paths removed, for non-gating telemetry. */
export function sweepScratch(worktreePath: string): string[] {
  const removed: string[] = [];
  sweepWalk(worktreePath, worktreePath, removed);
  return removed;
}

function sweepWalk(dir: string, root: string, removed: string[]): void {
  let ents: ReturnType<typeof readdirSync>;
  try {
    ents = readdirSync(dir, { withFileTypes: true });
  } catch {
    return; // unreadable dir — skip, never throw
  }
  for (const ent of ents) {
    if (!ent.isDirectory()) continue;
    const full = join(dir, ent.name);
    if (ent.name === "styre_scratch") {
      try {
        rmSync(full, { recursive: true, force: true });
        removed.push(relative(root, full));
      } catch {
        // best-effort: a failed remove is non-fatal — the guard and telemetry still proceed
      }
      continue; // removed — do not recurse into it
    }
    if (SWEEP_SKIP_DIRS.has(ent.name)) continue;
    sweepWalk(full, root, removed);
  }
}
```

Note: `relative()` on macOS/Linux (styre's only targets) yields POSIX `/` separators, matching the tests' expected values.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test test/dispatch/worktree.test.ts`
Expected: PASS (both new tests + all pre-existing worktree tests).

- [ ] **Step 5: Verify typecheck + lint**

Run: `bunx tsc --noEmit`
Expected: no errors.

Run: `bun run lint`
Expected: no Biome errors (the deliberately-empty `catch` carries a comment, so `noEmptyBlockStatements` passes).

- [ ] **Step 6: Commit**

```bash
git add src/dispatch/worktree.ts test/dispatch/worktree.test.ts
git commit -m "feat(dispatch): sweepScratch helper — delete styre_scratch/ drawers (ENG-300)"
```

---

## Task 2: Wire the sweep into the dispatch flow + verify + telemetry

**Files:**
- Modify: `src/dispatch/run-dispatch.ts` (primary sweep after the transport-failure block, before `pendingEntries`; add `sweepScratch` import)
- Modify: `src/dispatch/handlers.ts` (defense-in-depth sweep in `verify:check` after `ensureWorktree`; add `sweepScratch` import)
- Test: `test/dispatch/run-dispatch.test.ts`

**Interfaces:**
- Consumes: `sweepScratch(worktreePath: string): string[]` (Task 1); `appendEvent(db, { ticketId, kind, reason, payload })` (already imported in `run-dispatch.ts`, used at the read-only stray branch).

- [ ] **Step 1: Write the failing wiring test**

Add to `test/dispatch/run-dispatch.test.ts`. Add `mkdirSync` to the existing `node:fs` import if absent. This mirrors the existing scope-reject test (`run-dispatch.test.ts:330`) but the undeclared scratch lives in a `styre_scratch/` drawer, so the sweep must make the dispatch succeed instead of reject.

```ts
test("scratch drawer: styre_scratch/ is swept before judging → not an offender, not committed, note emitted", async () => {
  const { db, ticketId } = makeTestDb();
  const repo = gitRepo();
  const wt = join(repo, "..", `wt-scratch-${Date.now()}`);
  const runner = new FakeAgentRunner((input) => {
    writeFileSync(join(input.cwd, "fix.ts"), "export const x = 1;\n"); // declared deliverable
    mkdirSync(join(input.cwd, "pkg", "styre_scratch"), { recursive: true });
    writeFileSync(join(input.cwd, "pkg", "styre_scratch", "repro.py"), "scratch\n"); // undeclared drawer
    return {
      completed: true,
      exitCode: 0,
      stdout: '```styre-sidecar\n{"new_files":["fix.ts"]}\n```',
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
      handlerKey: "implement:dispatch",
      template: "implement {{ident}}",
      vars: { ident: "ENG-1" },
      commitScope: implementScope,
      postcondition: () => {},
    },
  );

  expect(listByTicket(db, ticketId)[0]?.outcome).toBe("clean-success"); // swept, so NOT rejected
  expect(existsSync(join(wt, "pkg", "styre_scratch"))).toBe(false); // drawer gone
  expect(res.changed).toBe(true);
  const committed = Bun.spawnSync(["git", "show", "--name-only", "--format=", "HEAD"], {
    cwd: wt,
  }).stdout.toString();
  expect(committed).toContain("fix.ts");
  expect(committed).not.toContain("repro.py");
  const notes = listEvents(db, ticketId).filter(
    (e) => e.kind === "note" && e.reason?.startsWith("scratch-swept"),
  );
  expect(notes.length).toBe(1);
  expect(JSON.parse(notes[0]?.payload_json ?? "{}").swept).toContain("pkg/styre_scratch");
  db.close();
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test test/dispatch/run-dispatch.test.ts`
Expected: FAIL — today the undeclared `pkg/styre_scratch/repro.py` is an offender, so the dispatch throws `out-of-scope files` and rejects (outcome `dispatch-failed`), not `clean-success`.

- [ ] **Step 3: Add the primary sweep to `runAgentDispatch`**

In `src/dispatch/run-dispatch.ts`, add `sweepScratch` to the existing `worktree.ts` import block (which currently imports `commitWorktree, ensureWorktree, pendingEntries, undoAttempt` at lines 16-19):

```ts
  commitWorktree,
  ensureWorktree,
  pendingEntries,
  sweepScratch,
  undoAttempt,
```

Then, immediately after the transport-failure `if (!result.completed || result.timedOut) { … }` block closes (the block ending at line 167) and **before** `const preHead = worktreeHead(deps.worktreePath);` (line 169), insert:

```ts
  // The worker's sanctioned throwaway drawer(s): delete every styre_scratch/ before judging/committing
  // so scratch is never an offender and never survives into a later broad test run (ENG-300). Runs on
  // the success path — which undoAttempt never touches — for both write and read-only dispatches.
  const swept = sweepScratch(deps.worktreePath);
  if (swept.length > 0) {
    appendEvent(ctx.db, {
      ticketId: ctx.ticket.id,
      kind: "note",
      reason: `scratch-swept:${spec.handlerKey}`,
      payload: { swept },
    });
  }
```

- [ ] **Step 4: Run the wiring test to verify it passes**

Run: `bun test test/dispatch/run-dispatch.test.ts`
Expected: PASS — the drawer is swept before enumeration, so `fix.ts` commits, `repro.py` is gone, outcome is `clean-success`, and one `scratch-swept:implement:dispatch` note is recorded. The pre-existing scope-reject test (`test_bug.py` at the repo root, NOT in a drawer) still fails-and-rejects — confirming the guard is unchanged for non-drawer files.

- [ ] **Step 5: Add the defense-in-depth sweep to `verify:check`**

In `src/dispatch/handlers.ts`, add `sweepScratch` to its `worktree.ts` import (the file already imports helpers like `ensureWorktree`, `changedFilesBetween` from there). Then, in the `verify:check` handler, immediately after `ensureWorktree(repoPath, branch, worktreePath);` (line 1137), insert:

```ts
    sweepScratch(worktreePath); // defense-in-depth: no styre_scratch/ reaches the broad verify run (ENG-300)
```

This call is a trivial invocation of the Task-1-tested helper; its removal logic is fully covered by `sweepScratch`'s unit tests, so it carries no separate integration test by design (it is belt-and-suspenders — every agent dispatch already swept its own scratch via Step 3 before verify runs).

- [ ] **Step 6: Verify — typecheck, the dispatch suite, and lint**

Run: `bunx tsc --noEmit`
Expected: no errors.

Run: `bun test test/dispatch/run-dispatch.test.ts test/dispatch/worktree.test.ts`
Expected: PASS.

Run: `bun run lint`
Expected: no Biome errors.

- [ ] **Step 7: Commit**

```bash
git add src/dispatch/run-dispatch.ts src/dispatch/handlers.ts test/dispatch/run-dispatch.test.ts
git commit -m "feat(dispatch): sweep styre_scratch/ in runAgentDispatch + verify (ENG-300)"
```

---

## Task 3: Prompt changes — scratch goes in `styre_scratch/`

**Files:**
- Modify: `prompts/checks.md:40-45` (scratch bullet)
- Modify: `prompts/implement.md:20-23` (scratch paragraph)
- Test: `test/dispatch/checks-prompt.test.ts:24`, `test/dispatch/prompt-vars.test.ts:249`

**Interfaces:**
- Consumes: `CHECKS_TEMPLATE`, `IMPLEMENT_TEMPLATE` (exported from `src/dispatch/prompt-vars.ts`, the text of the two prompts; imported `with { type: "text" }`, so editing the `.md` updates the compiled template).

- [ ] **Step 1: Update the failing assertion tests**

In `test/dispatch/checks-prompt.test.ts`, the test at line 18 currently asserts the `/tmp` stance at line 24: `expect(t).toMatch(/\$tmpdir|\/tmp|outside the repository/);`. Replace that single line with the drawer assertion (leave the other assertions in that test — `styre_checks/`, `byte-identical`, `reject`, `new_files` — unchanged):

```ts
  expect(t).toContain("styre_scratch/"); // scratch goes in the swept drawer, not /tmp
```

Also update that test's title to reflect the new stance — change `"…keeps scratch out of the work tree"` to `"…and routes scratch to the styre_scratch/ drawer"`.

In `test/dispatch/prompt-vars.test.ts`, the test at line 244 asserts the implement scratch stance at line 249: `expect(IMPLEMENT_TEMPLATE.toLowerCase()).toMatch(/\$tmpdir|\/tmp/);`. Replace that line with:

```ts
  // scratch goes in the swept styre_scratch/ drawer (ENG-300), not /tmp
  expect(IMPLEMENT_TEMPLATE).toContain("styre_scratch/");
```

Leave the retained assertions in that test (`new_files`, `do not leave`, ` ```styre-sidecar `) unchanged.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test test/dispatch/checks-prompt.test.ts test/dispatch/prompt-vars.test.ts`
Expected: the two updated assertions FAIL — neither prompt currently contains `styre_scratch/` in its scratch guidance (only `styre_checks/` appears, in `checks.md`).

- [ ] **Step 3: Edit `prompts/checks.md` — the scratch bullet (lines 40-45)**

Replace:

```
- **Keep scratch OUT of the work tree.** Do any bug-reproduction, debugging, or throwaway scripting
  outside the repository — under `$TMPDIR` or `/tmp` — or do not create it at all. Never write repro/
  debug/scratch files into the work tree "to delete later," and never park them in `new_files`. The
  commit is REJECTED if it contains any NEW file you did not declare — your check files (listed in
  `checksAuthored` via `test_file`) plus any genuine non-test helper (listed in `new_files`, below) — so
  the only correct outcome is: check files declared, real helpers declared, and nothing else added.
```

with:

```
- **Put scratch in a `styre_scratch/` folder — never loose in the work tree.** For any bug-reproduction,
  debugging, or throwaway scripting, create a `styre_scratch/` directory next to the code you are
  exercising and put those files there. styre ignores and wipes every `styre_scratch/` folder, so
  nothing in it is committed, reviewed, or run as part of the suite — it is the throwaway sibling of the
  `styre_checks/` folder your real check goes in. Do NOT scatter throwaway files anywhere else, and do
  NOT park them in `new_files`. The commit is REJECTED if it contains any NEW file you did not declare —
  your check files (listed in `checksAuthored` via `test_file`) plus any genuine non-test helper (listed
  in `new_files`, below) — so the only correct outcome is: check files declared, real helpers declared,
  scratch in `styre_scratch/`, and nothing else added.
```

- [ ] **Step 4: Edit `prompts/implement.md` — the scratch paragraph (lines 20-23)**

Replace:

```
Do NOT leave throwaway, debug, or reproduction files in the repository. Do any bug-reproduction or
debugging scripting outside the repository — under `$TMPDIR` or `/tmp` — or do not create it at all;
never write scratch into the work tree "to delete later." The commit is REJECTED if it contains any
file you did not declare below, and you will have to redo the change.
```

with:

```
Do NOT leave throwaway, debug, or reproduction files loose in the repository. Do any bug-reproduction or
debugging scripting in a `styre_scratch/` folder next to the code you are exercising — styre ignores and
wipes every `styre_scratch/` folder, so nothing in it is committed or run. The commit is REJECTED if it
contains any NEW file (outside `styre_scratch/`) you did not declare below, and you will have to redo the
change.
```

(This keeps the literal `Do NOT leave` and the REJECTED sentence the assertion test and reviewers expect; lines 25-33 — the `new_files` intro, the sidecar block, and the "only edits existing files" note — are unchanged.)

- [ ] **Step 5: Run the assertion tests to verify they pass**

Run: `bun test test/dispatch/checks-prompt.test.ts test/dispatch/prompt-vars.test.ts`
Expected: PASS — both prompts now contain `styre_scratch/`; the retained assertions (`styre_checks/`, `byte-identical`, `reject`, `new_files`, `do not leave`, ` ```styre-sidecar `) still hold.

- [ ] **Step 6: Verify typecheck + lint**

Run: `bunx tsc --noEmit`
Expected: no errors.

Run: `bun run lint`
Expected: no Biome errors.

- [ ] **Step 7: Commit**

```bash
git add prompts/checks.md prompts/implement.md test/dispatch/checks-prompt.test.ts test/dispatch/prompt-vars.test.ts
git commit -m "fix(prompts): route scratch to styre_scratch/ drawer, replacing /tmp (ENG-300)"
```

---

## Final Verification (after all tasks)

- [ ] Full suite: `bun test` (expect the pre-change green count + the new tests, 0 fail).
- [ ] `bunx tsc --noEmit` clean, `bun run lint` clean.
- [ ] Whole-branch review (opus) via superpowers:requesting-code-review, then superpowers:finishing-a-development-branch (push + draft PR to Twinning-Labs/styre, base main).

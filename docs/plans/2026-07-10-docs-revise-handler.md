# `docs:revise` Handler — Bug A Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the spec'd-but-unbuilt `docs:revise` step so a docs-flagged ticket syncs documentation and advances to review instead of crashing (`no handler registered for 'docs:revise'`).

**Architecture:** A Haiku doc-sync dispatch handler, guarded by an opt-in pre-commit scope gate on `runAgentDispatch` (offending non-doc edits never commit → HEAD stays at the verified baseline), and a carry-forward that records the verified gate+integration verdict at the docs commit sha so the resolver's HEAD-keyed re-checks pass and it advances to review.

**Tech Stack:** TypeScript, Bun, `bun:sqlite`. Tests are `bun test`. TDD throughout.

## Global Constraints

- **Never invalidate verify.** The pre-commit `commitGuard` must reject any commit whose working-tree delta touches a non-doc path — computed over the FULL delta **including untracked files** (`git … status --porcelain=v1 -z`), NOT a bare `git diff` (an agent with `Write` can *create* an untracked source file). On offense: revert + no commit + head unchanged. (design §2, review B1)
- **Carry-forward only for a proven-docs-only sha.** `carryVerifiedVerdictForward` is called ONLY on `changed === true` after a clean `commitGuard` pass, so it never blesses an unverified source change. (design §2/§4)
- **Carry the integration signal verbatim** (result + `detail`), always; carry `ac-check-gate` `result:"pass"` **iff** `listActiveByTicket(db, ticketId).length > 0` (matches the resolver's `gateHasChecks` guard). (design §3.6)
- **`isDocPath` is repo-root scoped + fail-closed:** repo-root `^docs/` tree, or repo-root (no `/`) `README*`/`CHANGELOG*`/`CONTRIBUTING*`/`mkdocs.yml`, case-insensitive. A nested `src/docs/x` or `src/README.md` is NOT a doc path. (design §3.2, review I2/Important-3)
- **Opt-in only.** The `commitGuard` field is optional; every existing `runAgentDispatch` caller passes none and is byte-for-byte unaffected. (design §3.1)
- No schema, resolver, tier, or tool-allowlist change — those already exist for `docs:revise`.
- Run `bun run lint` + `bun run format` + `bun run typecheck` (all exit 0) before every commit — CI enforces them and the brief snippets are verbatim.

---

## File Structure

- **Modify** `src/dispatch/worktree.ts` — add `worktreeHead`, `pendingChanges`, `revertWorktree` git helpers (Task 1).
- **Modify** `src/dispatch/run-dispatch.ts` — add opt-in `commitGuard` to `DispatchSpec` + wire it in (Task 2).
- **Create** `src/dispatch/docs-paths.ts` — `isDocPath` + `DOC_PATHS_HINT` (Task 3).
- **Create** `prompts/docs-revise.md`; **Modify** `src/dispatch/prompt-vars.ts` — `DOCS_REVISE_TEMPLATE` import + `docsVars` (Task 4).
- **Create** `src/dispatch/carry-forward.ts` — `carryVerifiedVerdictForward` (Task 5).
- **Modify** `src/dispatch/handlers.ts` — register `docs:revise` (Task 6).
- **Tests:** `test/dispatch/worktree-guard.test.ts` (T1/T2), `test/dispatch/docs-paths.test.ts` (T3), `test/dispatch/docs-vars.test.ts` (T4), `test/dispatch/carry-forward.test.ts` (T5), `test/dispatch/docs-revise-handler.test.ts` (T6), `test/daemon/docs-revise-resolve.test.ts` (T7).

---

## Task 1: worktree git helpers (`worktreeHead`, `pendingChanges`, `revertWorktree`)

**Files:**
- Modify: `src/dispatch/worktree.ts` (append after the existing `changedFilesBetween`/`fileContentAt` helpers)
- Test: `test/dispatch/worktree-guard.test.ts`

**Interfaces:**
- Consumes: the module-private `git(args: string[], cwd: string): string` already used throughout `worktree.ts` (runs git, returns trimmed stdout, throws on non-zero).
- Produces:
  - `worktreeHead(worktreePath: string): string` — `git rev-parse HEAD`.
  - `pendingChanges(worktreePath: string): string[]` — every path in the uncommitted working-tree delta, **including untracked and both sides of a rename**.
  - `revertWorktree(worktreePath: string): void` — discard all uncommitted changes (tracked + untracked), restoring HEAD.

- [ ] **Step 1: Write the failing test**

Create `test/dispatch/worktree-guard.test.ts`:

```ts
import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  pendingChanges,
  revertWorktree,
  worktreeHead,
} from "../../src/dispatch/worktree.ts";

function tmpRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "styre-wt-"));
  const g = (args: string[]) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" });
  g(["init", "-q"]);
  g(["config", "user.email", "t@t"]);
  g(["config", "user.name", "t"]);
  writeFileSync(join(dir, "README.md"), "hi\n");
  writeFileSync(join(dir, "app.py"), "print(1)\n");
  g(["add", "-A"]);
  g(["commit", "-q", "-m", "init"]);
  return dir;
}

test("pendingChanges lists tracked modifications AND untracked additions", () => {
  const dir = tmpRepo();
  writeFileSync(join(dir, "README.md"), "changed\n"); // tracked mod
  writeFileSync(join(dir, "docs.md"), "new\n"); // untracked add
  const pending = pendingChanges(dir).sort();
  expect(pending).toEqual(["README.md", "docs.md"]);
  rmSync(dir, { recursive: true, force: true });
});

test("pendingChanges includes a deleted file and both sides of a rename", () => {
  const dir = tmpRepo();
  execFileSync("git", ["-C", dir, "mv", "app.py", "core.py"]); // rename → app.py (old) + core.py (new)
  const pending = pendingChanges(dir);
  expect(pending).toContain("app.py");
  expect(pending).toContain("core.py");
  rmSync(dir, { recursive: true, force: true });
});

test("revertWorktree restores HEAD (tracked + untracked discarded)", () => {
  const dir = tmpRepo();
  const before = worktreeHead(dir);
  writeFileSync(join(dir, "app.py"), "print(2)\n"); // tracked mod
  writeFileSync(join(dir, "evil.py"), "bad\n"); // untracked add
  revertWorktree(dir);
  expect(pendingChanges(dir)).toEqual([]);
  expect(worktreeHead(dir)).toBe(before);
  rmSync(dir, { recursive: true, force: true });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test test/dispatch/worktree-guard.test.ts`
Expected: FAIL — `pendingChanges`/`revertWorktree`/`worktreeHead` are not exported.

- [ ] **Step 3: Implement the helpers**

Append to `src/dispatch/worktree.ts` (reuse the existing module-private `git`):

```ts
/** The current HEAD commit sha of the worktree. */
export function worktreeHead(worktreePath: string): string {
  return git(["rev-parse", "HEAD"], worktreePath);
}

/** Every path in the uncommitted working-tree delta vs HEAD — tracked modifications/deletions,
 *  untracked additions, and BOTH sides of a rename/copy. Uses `--porcelain=v1 -z` (NUL-delimited,
 *  never octal-quoted, `core.quotePath=false`) so no path escaping/quoting can hide an entry.
 *  Load-bearing for the docs:revise commitGuard: an agent with Write can CREATE an untracked
 *  source file, which a bare `git diff` would miss (review finding B1). */
export function pendingChanges(worktreePath: string): string[] {
  const out = git(
    ["-c", "core.quotePath=false", "status", "--porcelain=v1", "-z"],
    worktreePath,
  );
  if (out === "") return [];
  const tokens = out.split("\0").filter((t) => t !== "");
  const paths: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const entry = tokens[i];
    const status = entry.slice(0, 2); // XY
    paths.push(entry.slice(3)); // the (new) path
    // Rename/copy entries are followed by a second token: the ORIGINAL path.
    if (status.includes("R") || status.includes("C")) {
      i++;
      if (i < tokens.length) paths.push(tokens[i]);
    }
  }
  return paths;
}

/** Discard every uncommitted change (tracked restore + untracked removal), restoring HEAD.
 *  `git clean -fd` (no `-x`) spares ignored files, so the ephemeral SQLite under XDG state is
 *  untouched even when `worktreePath === repoPath` (in-place). */
export function revertWorktree(worktreePath: string): void {
  git(["checkout", "--", "."], worktreePath);
  git(["clean", "-fd"], worktreePath);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test test/dispatch/worktree-guard.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Lint/typecheck + commit**

```bash
bun run lint && bun run typecheck
git add src/dispatch/worktree.ts test/dispatch/worktree-guard.test.ts
git commit -m "feat(dispatch): worktree helpers — pendingChanges (incl untracked), revertWorktree, worktreeHead"
```

---

## Task 2: opt-in `commitGuard` on `runAgentDispatch`

**Files:**
- Modify: `src/dispatch/run-dispatch.ts` (`DispatchSpec` type ~line 34; the flow ~line 113, before `commitWorktree`)
- Test: append to `test/dispatch/worktree-guard.test.ts`

**Interfaces:**
- Consumes: `pendingChanges`, `revertWorktree`, `worktreeHead` (Task 1); existing `commitWorktree`, `completeDispatch`.
- Produces: `DispatchSpec.commitGuard?: (args: { worktreePath: string; pending: string[] }) => void`. When present, `runAgentDispatch` computes `pending` after the agent runs and before committing; on the guard's throw it reverts the worktree, records the dispatch `dispatch-failed` with the head UNCHANGED, and rethrows.

- [ ] **Step 1: Write the failing test**

Append to `test/dispatch/worktree-guard.test.ts`:

```ts
import { FakeAgentRunner } from "../../src/agent/fake-runner.ts";
import { DEFAULT_AGENT_CONFIG } from "../../src/config/agent-config.ts";
import { runAgentDispatch } from "../../src/dispatch/run-dispatch.ts";
import { parseProfile } from "../../src/dispatch/profile.ts";
import { makeTestDb } from "../helpers/db.ts";
import { getByDispatchId } from "../../src/db/repos/dispatch.ts";
import { worktreeHasChanges } from "../../src/dispatch/worktree.ts";

// Minimal ctx/deps builder: a FakeAgentRunner whose run() writes `files` into the worktree
// (relative path → content), then the dispatch commits/guards.
function dispatchHarness(files: Record<string, string>) {
  const { db, ticketId } = makeTestDb();
  const repo = tmpRepo(); // reuse Task-1 helper (same file)
  const runner = new FakeAgentRunner(async () => {
    for (const [rel, content] of Object.entries(files)) {
      const abs = join(repo, rel);
      execFileSync("mkdir", ["-p", join(repo, rel.split("/").slice(0, -1).join("/") || ".")]);
      writeFileSync(abs, content);
    }
    return { completed: true, timedOut: false, stdout: "{}", exitCode: 0 };
  });
  // ctx + deps are the shapes runAgentDispatch consumes; mirror an existing dispatch test.
  return { db, ticketId, repo, runner };
}
```

> NOTE to the implementer: `runAgentDispatch` takes `(ctx: HandlerContext, deps: DispatchDeps, spec: DispatchSpec)`. **Copy the ctx/deps harness from `test/dispatch/real-dispatch-e2e.test.ts`** (the closest existing `runAgentDispatch` test), setting `deps.worktreePath` to a real temp git repo. `FakeAgentRunner(handler)`: the handler receives `input` and must **write the prescribed files into `input.cwd`** (which is `deps.worktreePath`, the worktree) then return an `AgentRunResult` (`{ completed: true, timedOut: false, exitCode: 0, stdout: "{}" }`). The ticket must have a `workflow_step` row so `ctx.step` resolves. The three assertions below are the contract:

```ts
test("commitGuard: docs-only edit commits (clean-success)", async () => {
  // ... build ctx/deps with FakeAgentRunner writing { "docs/x.md": "hi" } ...
  // spec.commitGuard: throw if any pending path is not under docs/
  // assert: runAgentDispatch resolves; changed === true; the dispatch row outcome === "clean-success"
});

test("commitGuard: a non-doc edit (incl a NEW untracked source file) does NOT commit, reverts, head unchanged", async () => {
  // FakeAgentRunner writes { "src/evil.py": "bad", "docs/x.md": "hi" }
  // spec.commitGuard throws on "src/evil.py"
  // assert: runAgentDispatch REJECTS (throws); the worktree has NO uncommitted changes
  //   (worktreeHasChanges(repo) === false — reverted); worktreeHead(repo) === the pre-dispatch head;
  //   the dispatch row outcome === "dispatch-failed" and its branch_head_sha === the pre-dispatch head
});

test("no commitGuard → behavior unchanged (commits, clean-success)", async () => {
  // same as test 1 but spec has NO commitGuard; FakeAgentRunner writes { "src/foo.py": "x" }
  // assert: commits, changed === true, outcome === "clean-success" (guard path never runs)
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test test/dispatch/worktree-guard.test.ts`
Expected: FAIL — `commitGuard` is not a field on `DispatchSpec` / not honored.

- [ ] **Step 3: Implement**

In `src/dispatch/run-dispatch.ts`, add to the `DispatchSpec` interface (after `postcondition`):

```ts
  /** Optional PRE-commit scope gate. When set, `runAgentDispatch` computes the full working-tree
   *  delta (incl untracked) after the agent runs and BEFORE committing, and calls this. A throw
   *  means "do not commit": the worktree is reverted, the dispatch is recorded `dispatch-failed`
   *  with the head UNCHANGED, and the error rethrows (→ failure-policy). Handlers that omit it are
   *  unaffected. Used by `docs:revise` to guarantee a docs-only commit. */
  commitGuard?: (args: { worktreePath: string; pending: string[] }) => void;
```

Add the imports at the top (extend the existing `./worktree.ts` import):

```ts
import {
  commitWorktree,
  ensureWorktree,
  pendingChanges,
  revertWorktree,
  worktreeHead,
} from "./worktree.ts";
```

Insert the guard immediately **before** `const { sha, changed } = commitWorktree(...)` (~line 113):

```ts
  if (spec.commitGuard) {
    const preHead = worktreeHead(deps.worktreePath);
    const pending = pendingChanges(deps.worktreePath);
    try {
      spec.commitGuard({ worktreePath: deps.worktreePath, pending });
    } catch (err) {
      revertWorktree(deps.worktreePath);
      completeDispatch(ctx.db, inserted.id, {
        outcome: "dispatch-failed",
        branchHeadSha: preHead,
        endedAt: nowUtc(),
      });
      throw err;
    }
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test test/dispatch/worktree-guard.test.ts`
Expected: PASS (6 tests total). Then `bun test` (full suite) — no other `runAgentDispatch` caller regresses (they pass no `commitGuard`).

- [ ] **Step 5: Lint/typecheck + commit**

```bash
bun run lint && bun run typecheck
git add src/dispatch/run-dispatch.ts test/dispatch/worktree-guard.test.ts
git commit -m "feat(dispatch): opt-in commitGuard on runAgentDispatch (pre-commit scope gate, revert-on-offense)"
```

---

## Task 3: `docs-paths.ts` — `isDocPath` + `DOC_PATHS_HINT`

**Files:**
- Create: `src/dispatch/docs-paths.ts`
- Test: `test/dispatch/docs-paths.test.ts`

**Interfaces:**
- Produces: `isDocPath(file: string): boolean`; `DOC_PATHS_HINT: string`.

- [ ] **Step 1: Write the failing test**

Create `test/dispatch/docs-paths.test.ts`:

```ts
import { expect, test } from "bun:test";
import { isDocPath, DOC_PATHS_HINT } from "../../src/dispatch/docs-paths.ts";

test("accepts repo-root docs/ tree and root doc-family (case-insensitive)", () => {
  for (const p of ["docs/x.rst", "docs/a/b.md", "README.md", "README.rst", "CHANGELOG.md",
    "CONTRIBUTING.md", "mkdocs.yml", "Docs/x.md"]) {
    expect(isDocPath(p)).toBe(true);
  }
});

test("rejects source/tests and nested docs (fail-closed)", () => {
  for (const p of ["src/foo.py", "test/foo_test.py", "src/README.md", "src/docs/Component.tsx",
    "pkg/docs/gen.go", "docsource/x.md", "app/mkdocs.yml"]) {
    expect(isDocPath(p)).toBe(false);
  }
});

test("normalizes ./ prefix and backslashes", () => {
  expect(isDocPath("./docs/x.md")).toBe(true);
  expect(isDocPath("docs\\x.md")).toBe(true);
  expect(isDocPath("./src/foo.py")).toBe(false);
});

test("DOC_PATHS_HINT is a non-empty human-readable string", () => {
  expect(DOC_PATHS_HINT.length).toBeGreaterThan(0);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test test/dispatch/docs-paths.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement**

Create `src/dispatch/docs-paths.ts`:

```ts
/** The single source of truth for "what docs:revise may edit", shared by the commitGuard
 *  (enforcement) and the prompt (guidance) so they can never drift. Repo-root-scoped and
 *  fail-closed: a nested `src/docs/x` or `src/README.md` is NOT a doc path (a source file under a
 *  dir named `docs`, or a co-located README, must not be editable — it could change what the
 *  checks run and invalidate the carry-forward premise). */

const ROOT_DOCS_TREE = /^docs\//i; // repo-root docs/ directory only
const ROOT_DOC_FILE = /^(readme|changelog|contributing)[^/]*$/i; // repo-root, any extension
const MKDOCS = /^mkdocs\.yml$/i;

/** True iff `file` (a repo-root-relative path) is documentation styre may sync. */
export function isDocPath(file: string): boolean {
  const p = file.replace(/\\/g, "/").replace(/^\.\//, "");
  if (ROOT_DOCS_TREE.test(p)) return true;
  if (!p.includes("/") && (ROOT_DOC_FILE.test(p) || MKDOCS.test(p))) return true;
  return false;
}

/** Human-readable allowed-path list for the docs:revise prompt (kept in lockstep with isDocPath). */
export const DOC_PATHS_HINT =
  "the repo-root `docs/` directory tree, and the repo-root files README*, CHANGELOG*, " +
  "CONTRIBUTING*, and mkdocs.yml — nothing else (no source, tests, or config)";
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test test/dispatch/docs-paths.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Lint/typecheck + commit**

```bash
bun run lint && bun run typecheck
git add src/dispatch/docs-paths.ts test/dispatch/docs-paths.test.ts
git commit -m "feat(dispatch): docs-paths — repo-root isDocPath predicate + DOC_PATHS_HINT"
```

---

## Task 4: prompt `docs-revise.md` + `DOCS_REVISE_TEMPLATE` + `docsVars`

**Files:**
- Create: `prompts/docs-revise.md`
- Modify: `src/dispatch/prompt-vars.ts` (add the template import ~line 10 + export ~line 65; add `docsVars`)
- Test: `test/dispatch/docs-vars.test.ts`

**Interfaces:**
- Consumes: `DOC_PATHS_HINT` (Task 3); `Profile`; existing `renderPrompt`.
- Produces: `DOCS_REVISE_TEMPLATE: string`; `docsVars(ticket: { ident: string; title: string | null }, profile: Profile): Record<string, string>` (mirrors `reviewVars` + `doc_paths`).

- [ ] **Step 1: Write the failing test**

Create `test/dispatch/docs-vars.test.ts`:

```ts
import { expect, test } from "bun:test";
import { DOCS_REVISE_TEMPLATE, docsVars } from "../../src/dispatch/prompt-vars.ts";
import { renderPrompt } from "../../src/dispatch/render-prompt.ts";
import { parseProfile } from "../../src/dispatch/profile.ts";

const profile = parseProfile({ slug: "demo", targetRepo: "/tmp/x", defaultBranch: "main" });

test("docsVars carries ident/title/slug + the doc_paths hint", () => {
  const v = docsVars({ ident: "ENG-1", title: "Fix bug" }, profile);
  expect(v.ident).toBe("ENG-1");
  expect(v.title).toBe("Fix bug");
  expect(v.slug).toBe("demo");
  expect(v.doc_paths.length).toBeGreaterThan(0);
});

test("the docs-revise template renders with docsVars (no missing vars)", () => {
  const r = renderPrompt(DOCS_REVISE_TEMPLATE, docsVars({ ident: "ENG-1", title: null }, profile));
  expect(r.ok).toBe(true);
  if (r.ok) expect(r.prompt).toContain("ENG-1");
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test test/dispatch/docs-vars.test.ts`
Expected: FAIL — `DOCS_REVISE_TEMPLATE`/`docsVars` not exported.

- [ ] **Step 3: Implement**

Create `prompts/docs-revise.md` (use only the vars `docsVars` provides — `{{ident}}`, `{{title}}`, `{{slug}}`, `{{doc_paths}}`, and any `profile.promptVars` keys the other prompts use; keep it self-contained):

```markdown
# Documentation sync — {{ident}} {{title}}

The implementation for this ticket is complete and committed in this worktree, and it has already
passed the project's verification. Your job is to update the project's **documentation** so it
reflects the change — nothing else.

Read, to understand what changed:
- the implementation plan under `docs/plans/` for this ticket ({{ident}}),
- the changed source in the worktree,
- the existing documentation.

Then update the documentation to match: public API/behavior changes, new or changed options, and
any user-facing notes or changelog entry the change warrants.

Hard rules:
- Edit **only** documentation: {{doc_paths}}. Do NOT edit source, tests, or configuration — a
  commit that touches anything else will be rejected and this step retried.
- If the change needs no documentation update, make **no changes** and finish. That is a valid,
  common outcome — do not invent edits.
- Do not run commands; you have no shell. Read the worktree and the plan directly.
```

In `src/dispatch/prompt-vars.ts`: add the import alongside the other `prompts/*.md` imports:

```ts
import docsReviseTemplate from "../../prompts/docs-revise.md" with { type: "text" };
```

Add the export near the other `export const *_TEMPLATE` lines:

```ts
export const DOCS_REVISE_TEMPLATE = docsReviseTemplate;
```

Add the import of the hint (top of file, with the other `./` imports) and the `docsVars` function
(next to `reviewVars`):

```ts
import { DOC_PATHS_HINT } from "./docs-paths.ts";

/** Prompt vars for `docs:revise` — mirrors `reviewVars` (Bash-less, reads the worktree + plan) plus
 *  the allowed-doc-paths hint, kept in lockstep with the commitGuard's `isDocPath`. */
export function docsVars(
  ticket: { ident: string; title: string | null },
  profile: Profile,
): Record<string, string> {
  return {
    ident: ticket.ident,
    title: ticket.title ?? "",
    slug: profile.slug,
    ...profile.promptVars,
    doc_paths: DOC_PATHS_HINT,
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test test/dispatch/docs-vars.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Lint/typecheck + commit**

```bash
bun run lint && bun run typecheck
git add prompts/docs-revise.md src/dispatch/prompt-vars.ts test/dispatch/docs-vars.test.ts
git commit -m "feat(dispatch): docs-revise prompt + DOCS_REVISE_TEMPLATE + docsVars"
```

---

## Task 5: `carryVerifiedVerdictForward`

**Files:**
- Create: `src/dispatch/carry-forward.ts`
- Test: `test/dispatch/carry-forward.test.ts`

**Interfaces:**
- Consumes: `insertSignal`, `listByTicket` (`ground-truth-signal.ts`); `listActiveByTicket` (`ac-check.ts`).
- Produces: `carryVerifiedVerdictForward(db: Database, ticketId: number, sha: string): void` — writes, at `sha`: the verified `integration` signal verbatim (result + detail + command), always; and an `ac-check-gate` `result:"pass"` signal iff the ticket has ≥1 active ac-check.

- [ ] **Step 1: Write the failing test**

Create `test/dispatch/carry-forward.test.ts`:

```ts
import { expect, test } from "bun:test";
import { insertSignal, listByTicket } from "../../src/db/repos/ground-truth-signal.ts";
import { insertAc } from "../../src/db/repos/acceptance-criterion.ts";
import { insertAcCheck } from "../../src/db/repos/ac-check.ts";
import { carryVerifiedVerdictForward } from "../../src/dispatch/carry-forward.ts";
import { makeTestDb } from "../helpers/db.ts";

test("carries the integration signal verbatim (result+detail) to the new sha; ac-check-gate only if checks exist", () => {
  const { db, ticketId } = makeTestDb();
  // verified integration at V (advisory tox fail)
  insertSignal(db, { ticketId, signalType: "integration", result: "fail", command: "tox",
    branchHeadSha: "V", detail: { ran: [{ label: "backend:test", exitCode: 1 }], advisory: true } });
  // one active ac-check
  const ac = insertAc(db, { ticketId, seq: 1, text: "x", source: "checklist" });
  insertAcCheck(db, { ticketId, acId: ac.id, selector: "s", testPath: "t" });

  carryVerifiedVerdictForward(db, ticketId, "C1");

  const atC1 = listByTicket(db, ticketId).filter((s) => s.branch_head_sha === "C1");
  const integ = atC1.find((s) => s.signal_type === "integration");
  expect(integ?.result).toBe("fail");
  expect(JSON.parse(integ?.detail_json ?? "{}").advisory).toBe(true);
  expect(integ?.command).toBe("tox");
  const gate = atC1.find((s) => s.signal_type === "ac-check-gate");
  expect(gate?.result).toBe("pass");
});

test("no ac-check-gate carry when the ticket has no active checks", () => {
  const { db, ticketId } = makeTestDb();
  insertSignal(db, { ticketId, signalType: "integration", result: "pass", branchHeadSha: "V" });
  carryVerifiedVerdictForward(db, ticketId, "C1");
  const atC1 = listByTicket(db, ticketId).filter((s) => s.branch_head_sha === "C1");
  expect(atC1.some((s) => s.signal_type === "ac-check-gate")).toBe(false);
  expect(atC1.some((s) => s.signal_type === "integration")).toBe(true);
});
```

> Verify the `insertAcCheck` signature against `src/db/repos/ac-check.ts` before writing:
> `insertAcCheck(db, { ticketId, acId, selector, testPath? })` — confirmed.

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test test/dispatch/carry-forward.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement**

Create `src/dispatch/carry-forward.ts`:

```ts
import type { Database } from "bun:sqlite";
import { listActiveByTicket } from "../db/repos/ac-check.ts";
import { insertSignal, listByTicket } from "../db/repos/ground-truth-signal.ts";

/** After a proven docs-only commit that moved HEAD (V→sha), record that the verified verdict still
 *  holds at `sha`, so the resolver's HEAD-keyed gate/integration re-checks pass at `sha` and it
 *  advances to review instead of re-gating (design §2, Blocker-1 fix). Sound because the
 *  commitGuard proved `sha` differs from V only in doc paths. Writes, in one transaction:
 *   - the verified `integration` signal replicated verbatim (result + detail + command) — always
 *     (S4 integration always runs; `ranShasFor` is result-agnostic);
 *   - an `ac-check-gate` `pass` signal — ONLY when the ticket has active ac-checks (matches the
 *     resolver's `gateHasChecks` guard). */
export function carryVerifiedVerdictForward(db: Database, ticketId: number, sha: string): void {
  const integ = listByTicket(db, ticketId)
    .filter((s) => s.signal_type === "integration")
    .at(-1);
  db.transaction(() => {
    if (integ) {
      insertSignal(db, {
        ticketId,
        signalType: "integration",
        result: integ.result,
        command: integ.command ?? undefined,
        branchHeadSha: sha,
        detail: integ.detail_json ? JSON.parse(integ.detail_json) : undefined,
      });
    }
    if (listActiveByTicket(db, ticketId).length > 0) {
      insertSignal(db, {
        ticketId,
        signalType: "ac-check-gate",
        result: "pass",
        branchHeadSha: sha,
        detail: { carriedForward: true },
      });
    }
  })();
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test test/dispatch/carry-forward.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Lint/typecheck + commit**

```bash
bun run lint && bun run typecheck
git add src/dispatch/carry-forward.ts test/dispatch/carry-forward.test.ts
git commit -m "feat(dispatch): carryVerifiedVerdictForward — replicate verified gate+integration at the docs sha"
```

---

## Task 6: register the `docs:revise` handler

**Files:**
- Modify: `src/dispatch/handlers.ts` (add imports; register `docs:revise` next to the other dispatch handlers)
- Test: `test/dispatch/docs-revise-handler.test.ts`

**Interfaces:**
- Consumes: `runAgentDispatch` + `commitGuard` (Task 2), `isDocPath` (Task 3), `DOCS_REVISE_TEMPLATE`/`docsVars` (Task 4), `carryVerifiedVerdictForward` (Task 5), existing `depsFor`, `DEFAULT_TIMEOUT_MS`.
- Produces: a registered `docs:revise` handler returning `{ docsRevised: boolean }`.

- [ ] **Step 1: Write the failing test**

Create `test/dispatch/docs-revise-handler.test.ts` — drive the registered handler via a FakeAgentRunner (mirror an existing handler unit test, e.g. `checks:dispatch`/`design` tests, for the ctx/registry/deps harness):

```ts
// Harness: build the dispatch registry (buildDispatchRegistry) with a FakeAgentRunner that writes
// prescribed files; seed a stage='implement' ticket with a docs:revise workflow_step; invoke the
// handler; assert. (Copy the harness shape from an existing handlers test.)

// Test A — a docs-only edit: the handler commits and calls carry-forward.
//   FakeAgentRunner writes { "docs/api.md": "updated" }.
//   assert: result.docsRevised === true; an `integration` (and, if the ticket has ac-checks, an
//   `ac-check-gate` pass) signal now exists at the new commit sha (carry-forward ran).

// Test B — a source edit: the handler's commitGuard rejects → the dispatch throws, nothing commits,
//   HEAD unchanged, and NO carry-forward signal is written at any new sha.
//   FakeAgentRunner writes { "src/evil.py": "bad" }.

// Test C — no-op: FakeAgentRunner writes nothing → result.docsRevised === false, no carry-forward.
```

> Because the handler wires already-tested units, keep these assertions focused on the WIRING:
> (A) docs edit → committed + carry-forward signals present; (B) source edit → no commit + no
> carry-forward; (C) no-op → docsRevised false. The deep behavior of each unit is covered by T2/T5.

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test test/dispatch/docs-revise-handler.test.ts`
Expected: FAIL — no handler registered for `docs:revise` (the bug) / imports missing.

- [ ] **Step 3: Implement**

In `src/dispatch/handlers.ts`: extend the `./prompt-vars.ts` import to include `DOCS_REVISE_TEMPLATE` and `docsVars`; add `import { isDocPath } from "./docs-paths.ts";` and `import { carryVerifiedVerdictForward } from "./carry-forward.ts";`. Register the handler alongside the other dispatch handlers:

```ts
  registry.register("docs:revise", async (ctx: HandlerContext) => {
    const { sha, changed } = await runAgentDispatch(
      ctx,
      depsFor(ctx, deps, deps.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      {
        handlerKey: "docs:revise",
        template: DOCS_REVISE_TEMPLATE,
        vars: docsVars(ctx.ticket, deps.profile),
        commitGuard: ({ pending }) => {
          const offenders = pending.filter((f) => !isDocPath(f));
          if (offenders.length > 0) {
            throw new Error(
              `docs:revise may only edit documentation; refusing to commit: ${offenders.join(", ")}`,
            );
          }
        },
        postcondition: () => {},
      },
    );
    if (changed) carryVerifiedVerdictForward(ctx.db, ctx.ticket.id, sha);
    return { docsRevised: changed };
  });
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test test/dispatch/docs-revise-handler.test.ts` then `bun test` (full suite).
Expected: PASS.

- [ ] **Step 5: Lint/typecheck + commit**

```bash
bun run lint && bun run typecheck
git add src/dispatch/handlers.ts test/dispatch/docs-revise-handler.test.ts
git commit -m "feat(loop): register docs:revise handler (Bug A — closes the no-handler crash)"
```

---

## Task 7: resolver end-to-end — docs:revise advances to review (the crux, reproduces & fixes the wedge)

**Files:**
- Test: `test/daemon/docs-revise-resolve.test.ts`

**Interfaces:**
- Consumes: everything above, driven through the real `tick`/resolver.

- [ ] **Step 1: Write the failing test**

Create `test/daemon/docs-revise-resolve.test.ts`. Seed a ticket at `stage='implement'`, `needs_docs=1`, with all work units `verified` and (if using the ac-check path) an `ac-check-gate` pass + `integration` signal at the verified HEAD `V`; build the registry with a FakeAgentRunner. Mirror `merge-e2e.test.ts` / `verify-routing.test.ts` for the tick-driving harness.

```ts
// Seed: stage='implement', needs_docs=1, all units verified, ac-check-gate PASS + integration at V.
//
// Test A (the crux — reproduces the astropy wedge, proves the fix):
//   FakeAgentRunner for docs:revise writes a REAL doc edit { "docs/x.md": "sync" }.
//   Drive ticks. ASSERT: the ticket REACHES stage='review' (or serves the `review` step) WITHOUT
//   throwing "no handler registered for 'docs:revise'" and WITHOUT spinning to no-progress
//   (iterations < cap). A `docs:revise` dispatch row exists; carry-forward signals exist at the
//   docs sha.
//
// Test B (offense doesn't wedge): FakeAgentRunner writes { "src/evil.py": "bad" } for docs:revise.
//   Drive ticks with a small cap. ASSERT: it does NOT advance to review, does NOT wedge to
//   no-progress silently — it retries then escalates (status waiting / escalated event), and the
//   branch HEAD never carries src/evil.py.
//
// Test C (no-op advances): FakeAgentRunner writes nothing for docs:revise → advances to review.
```

- [ ] **Step 2: Run the test to verify it fails, then passes**

Run: `bun test test/daemon/docs-revise-resolve.test.ts`
Expected: with Tasks 1–6 merged, Test A/C PASS (advances to review) and B behaves (escalate, no wedge). If Test A instead spins/does not reach review, the carry-forward is not satisfying the resolver — STOP and debug (do not loosen the assertion).

- [ ] **Step 3: Run the full suite**

Run: `bun test`
Expected: all green (no regression). Investigate any failure before proceeding.

- [ ] **Step 4: Lint/typecheck + commit**

```bash
bun run lint && bun run typecheck
git add test/daemon/docs-revise-resolve.test.ts
git commit -m "test(loop): docs:revise advances to review (reproduces & fixes the astropy no-handler wedge)"
```

---

## Self-Review (completed by plan author)

**Spec coverage.** design §2 flow → Tasks 2 (commitGuard) + 5 (carry-forward) + 6 (handler); §3.1 commitGuard → T2; §3.2 isDocPath → T3; §3.3 prompt + §3.5 docsVars → T4; §3.6 carry-forward → T5; §3.4 handler → T6; §6 tests (isDocPath table, commitGuard pass/fail/**untracked B1**/no-op, carry-forward, real-edit-advances-to-review, offense-no-wedge, no-op) → T1/T2/T3/T5/T6/T7. B1 (untracked) → T1 `pendingChanges` + T2 test. I1 soundness assumption is documented, not code. isDocPath repo-root scope → T3.

**Placeholder scan.** The T2/T6/T7 harness bodies are described-not-coded because they must copy an existing dispatch/tick test harness (ctx/registry/deps) that varies; every ASSERTION is spelled out as the contract, and the pure/leaf tasks (T1/T3/T4/T5) carry complete code. Flagged explicitly so the implementer copies the nearest existing harness rather than inventing one.

**Type consistency.** `commitGuard?: (args:{worktreePath:string; pending:string[]})=>void` identical in T2 defn and T6 use; `pendingChanges/revertWorktree/worktreeHead` signatures identical T1↔T2; `isDocPath(file:string):boolean` T3↔T6; `docsVars(ticket,profile)` T4↔T6; `carryVerifiedVerdictForward(db,ticketId,sha)` T5↔T6; `DOCS_REVISE_TEMPLATE` T4↔T6.

**One flagged verification for the implementer:** confirm `depsFor` and `DEFAULT_TIMEOUT_MS` are exported/in-scope in `handlers.ts` (they are — `handlers.ts:169` / `:140`) and copy the ctx/registry harness from an existing handler test for T2/T6/T7 rather than hand-rolling it.

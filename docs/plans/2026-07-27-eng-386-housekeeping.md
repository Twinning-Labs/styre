# ENG-386 Housekeeping — `styre ls` + `styre clean` Implementation Plan (rev 2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the two operator-facing housekeeping commands that complete the ENG-380 epic: `styre ls` (list styre's leftover efforts) and `styre clean <ident> | --all [--purge]` (reap those leftovers on disk, optionally deleting the branch/PR too). **`clean` never changes ticket status** and makes **no** assumption about a PR's fate.

**Architecture:** A shared read-only enumeration substrate (`listCheckpoints`) walks the state dir (`~/.local/state/styre/<slug>/<ident>/run.db`) and classifies each leftover *effort* by inspecting its `run.db` (single-ticket SoT) + sidecar files + run-lock. `ls` renders the resumable subset (+ a preview of finished leftovers). `clean` reaps an effort's disk artifacts (worktree via the liveness-gated `reconcileWorktree`, then the checkpoint dir); `--all` bulk-reaps only *finished* efforts and protects resumable ones (Scope B); `--purge` additionally deletes the local + remote branch (closing the PR), and is a silent no-op when there is no branch/PR.

**Tech Stack:** Bun + TypeScript, `citty` subcommands, `bun:sqlite`, existing `src/dispatch/worktree.ts` / `src/cli/run-lock.ts` / `src/db/repos/*` helpers. No new runtime dependencies.

## What changed from rev 1 (why this rev exists)

The independent review + operator feedback rejected two premises rev 1 was built on:
1. **`clean` does NOT abandon the ticket.** Reaping styre's *effort* on a ticket ≠ the *ticket* being a dead end. So rev 1's `setTicketStatus(…,"abandoned")` is **removed entirely** — not just because it was a no-op (it wrote to a db it then deleted), but because it was conceptually wrong. In this epic **nothing produces the `abandoned` ticket status** (design §3.5, revised).
2. **No merge-state / age "staleness" heuristic.** styre is a one-shot binary with no PR polling, and the project **squash-merges** (so `git merge-base --is-ancestor` — rev 1's Task 4 — is always false for merged PRs and would silently reap nothing). Removed. `--all` reaps by the effort's own terminal *kind* (Scope B), which styre knows locally.
3. **New `--purge`** covers the operator's real need (fully reset a ticket to re-run it): opt-in deletion of the local + remote branch. The deeper root cause (a plain push can't overwrite a leftover remote branch on re-run) is split out to **ENG-387** (force-with-lease), not built here.

## Global Constraints

- **`clean` never changes ticket status.** No `setTicketStatus` anywhere. `abandoned` gets no producer (design §3.5).
- **By default `clean` never touches branches or the PR.** The remote branch *is* the PR; deleting it is the opt-in `--purge` action only.
- **`--purge` is idempotent / silent-pass.** Deleting a local branch that doesn't exist, or a remote branch/PR that doesn't exist, is a **silent success**, never an error.
- **No schema change; no new runtime dependencies.** Use `node:fs`, `bun:sqlite`, existing helpers.
- **Never blind-force-remove a worktree.** All worktree freeing goes through `reconcileWorktree` (liveness-gated). `clean` refuses to touch an effort whose `run.lock` is held by a *live, non-self* process (`runLockStatus`), before any deletion.
- **Read-only enumeration never throws on a bad checkpoint.** A malformed/half-written/schema-drifted `run.db` is skipped (best-effort, `priorRunIdAt` idiom, `park.ts:85-100`).
- **Gates:** every task ends with `bun test`, `bun run lint`, AND `bun run typecheck` all green (typecheck is a real CI gate).
- **Output:** human text via `src/cli/output.ts` `formatMessage`; `ls`/`clean` write results to **stdout** (they are not telemetry runs, whose stdout is reserved for NDJSON — `run.ts:163,330`). Errors/refusals go through `guard()` to stderr.
- **Wiring:** each command is a `citty` `defineCommand` in its own file, body wrapped in `guard("<cmd>", …)`, registered in `src/index.ts` `subCommands`; args a hand-typed interface cast from `ctx.args` (the `migrate.ts` pattern).

## Resolved decisions (were open in rev 1)

1. **Staleness heuristic:** REMOVED. `--all` = Scope B (kind-based), no merge/age guessing.
2. **`--all` scope:** **Scope B** — reap finished/handed-off leftovers (`pr-ready`/`done`/`other`), skip resumable pauses (`needs_you`/`budget`) and live runs.
3. **`ls` content:** resumable pauses (with resume hints) + a second "finished leftovers" section previewing what `clean --all` reaps.
4. **`abandoned`:** no producer; `clean` exits 0 on success (no terminal give-up semantics).
5. **`--purge`:** single-ident only. `--all --purge` is a **usage error** (it won't mass-close PRs).

## Ground truth (verified against source)

- Every run journals to `parkDir/run.db` and `finishRunResult` never deletes the dir (`park.ts:62-76`), so the state dir accumulates `run.db` for `needs_you`, `budget`, `pr-ready`, AND `done` efforts.
- Terminal classification (`run-ticket.ts:108-154`, `park.ts` `finishRunResult`/`dumpPark`):
  - `needs_you` → pending `human_resume` signal (`reason` = honest-note) + ticket `waiting`.
  - `budget` → `dumpPark` writes `transcript.json` `{cause,resetAt,…}`; NO signal, ticket not `waiting`.
  - `pr-ready` → ticket `stage==="merge"` && `status!=="done"` && pending `human_merge_approval`; process exits (no daemon).
  - `done` → ticket `status==="done"`.
- Re-run branch handling: `ensureWorktree` uses `git worktree add -B <branch>` (`worktree.ts:51,59`) — a stale **local** branch is force-reset, never a blocker. The push is a plain `git push origin <branch>` (`github.ts:106`) — a stale **remote** branch blocks a divergent redo (→ ENG-387).
- Signatures (exact): `parkDir` (`park.ts:79`), `stateDir()` (`config/paths.ts:5`), `runLockStatus(dir):{pid,self}|null` (`run-lock.ts:27`), `listPending`/`SignalRow.{signal_type,reason}` (`signal.ts:4-31`), `getTicket`/`TicketRow.{ident,stage,status,branch_name,branch_prefix}` (`ticket.ts`), `branchNameFor({ident,branch_name,branch_prefix})` (`branch.ts:3`), `reconcileWorktree(repoPath,branch,stale?|undefined,newWorktreePath,checkpointDir?):{freed,skipped}` (`worktree.ts:181`), `getLatestWorktreePath(db,ticketId)` (`dispatch.ts:190`), `Profile.{slug,targetRepo,defaultBranch}` (`profile.ts:116`), `loadProfileByConvention(slug)`/`slugForCwd()` (`config/discover.ts:33,48`), `guard`/`formatMessage` (`output.ts:4,30`), `openDb` (`client.ts:4`), `migrate` (`db/migrate.ts`). `subCommands` map at `index.ts:25`.

---

### Task 1: Checkpoint enumeration substrate (`listCheckpoints`)

**Files:**
- Create: `src/cli/checkpoints.ts`
- Create: `test/helpers/checkpoint.ts` (the shared `seedCheckpoint` fixture — extracted so Tasks 2–5 reuse it)
- Test: `test/cli/checkpoints.test.ts`

**Interfaces:**
- Consumes: `stateDir`, `runLockStatus`, `listPending`/`SignalRow`, `getTicket`/`TicketRow`, `branchNameFor`, `bun:sqlite` `Database`, `node:fs`.
- Produces:
  ```ts
  export type CheckpointKind = "needs_you" | "budget" | "pr-ready" | "done" | "other";
  export interface Checkpoint {
    slug: string;
    ident: string;
    dir: string;            // parkDir(slug, ident)
    dbPath: string;         // join(dir, "run.db")
    ticketId: number;
    status: string;         // ticket.status
    stage: string;          // ticket.stage
    branch: string;         // branchNameFor(ticket)
    kind: CheckpointKind;   // the design §5 "reason"
    note: string | null;    // the design §5 "honest-note" (needs_you detail / "out of budget…" / null)
    ageMs: number;          // now - run.db mtime
    live: boolean;          // runLockStatus(dir) is a live, non-self process
  }
  export function classifyCheckpointDb(db: Database, dir: string):
    { ticketId: number; status: string; stage: string; branch: string; kind: CheckpointKind; note: string | null } | null;
  export function listCheckpoints(root?: string): Checkpoint[];
  ```
  `listCheckpoints` walks `root ?? stateDir()`: each directory entry is a `<slug>`; each sub-dir containing `run.db` is one effort. Unreadable/malformed `run.db` → skipped (never throws). Returned in walk order (callers sort).

- [ ] **Step 1: Write `test/helpers/checkpoint.ts` (fixture) then the failing test**

`test/helpers/checkpoint.ts`:
```ts
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { openDb } from "../../src/db/client.ts";
import { migrate } from "../../src/db/migrate.ts";
import { insertProject } from "../../src/db/repos/project.ts";
import { insertTicket } from "../../src/db/repos/ticket.ts";

/** Build <root>/<slug>/<ident>/run.db with a single ticket, shaped by `shape`. Returns the dir. */
export function seedCheckpoint(
  root: string,
  slug: string,
  ident: string,
  shape: (db: Database, ticketId: number) => void,
): string {                       // ← real return type (rev 1's `: void` tripped typecheck)
  const dir = join(root, slug, ident);
  mkdirSync(dir, { recursive: true });
  const dbPath = join(dir, "run.db");
  migrate(dbPath);
  const db = openDb(dbPath);
  const projectId = insertProject(db, { slug, targetRepo: "/tmp/x", defaultBranch: "main" });
  const ticketId = insertTicket(db, { projectId, ident, title: ident });
  shape(db, ticketId);
  db.close();
  return dir;
}
```
*(Confirm `insertProject`/`insertTicket` arg shapes against `src/db/repos/project.ts` / `ticket.ts` — the review verified `insertProject(db,{slug,targetRepo,defaultBranch})` and `insertTicket(db,{projectId,ident,title})`. If they differ, mirror `test/helpers/git-project.ts`.)*

`test/cli/checkpoints.test.ts`:
```ts
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTicketStage, setTicketStatus } from "../../src/db/repos/ticket.ts";
import { insertPending } from "../../src/db/repos/signal.ts";
import { listCheckpoints } from "../../src/cli/checkpoints.ts";
import { seedCheckpoint } from "../helpers/checkpoint.ts";

describe("listCheckpoints", () => {
  test("classifies needs_you, pr-ready, and done efforts", () => {
    const root = mkdtempSync(join(tmpdir(), "styre-ckpt-"));
    try {
      seedCheckpoint(root, "proj", "ENG-1", (db, id) => {
        setTicketStatus(db, id, "waiting");
        insertPending(db, { ticketId: id, signalType: "human_resume", reason: "needs you: composer not installed" });
      });
      seedCheckpoint(root, "proj", "ENG-2", (db, id) => {
        setTicketStage(db, id, "merge");
        insertPending(db, { ticketId: id, signalType: "human_merge_approval" });
      });
      seedCheckpoint(root, "proj", "ENG-3", (db, id) => setTicketStatus(db, id, "done"));

      const found = listCheckpoints(root);
      const by = (ident: string) => found.find((c) => c.ident === ident);
      expect(by("ENG-1")?.kind).toBe("needs_you");
      expect(by("ENG-1")?.note).toBe("needs you: composer not installed");
      expect(by("ENG-2")?.kind).toBe("pr-ready");
      expect(by("ENG-3")?.kind).toBe("done");
      expect(found.every((c) => c.live === false)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run to verify FAIL** — `src/cli/checkpoints.ts` does not exist.

- [ ] **Step 3: Implement `src/cli/checkpoints.ts`**

Classification order (matches real `driveToTerminal` precedence): `done` (status) → `needs_you` (pending `human_resume`) → `pr-ready` (`stage==="merge" && status!=="done" && pending human_merge_approval`) → `budget` (`transcript.json` present) → `other`.
```ts
import { Database } from "bun:sqlite";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { branchNameFor } from "../agent/branch.ts";
import { stateDir } from "../config/paths.ts";
import { listPending } from "../db/repos/signal.ts";
import { getTicket } from "../db/repos/ticket.ts";
import { runLockStatus } from "./run-lock.ts";

export type CheckpointKind = "needs_you" | "budget" | "pr-ready" | "done" | "other";
export interface Checkpoint { /* …as declared above… */ }

function singleTicketId(db: Database): number | null {
  return db.query<{ id: number }, []>("SELECT id FROM ticket ORDER BY id LIMIT 1").get()?.id ?? null;
}
function budgetNote(dir: string): string {
  try {
    const j = JSON.parse(readFileSync(join(dir, "transcript.json"), "utf8")) as { resetAt?: string | null };
    return j.resetAt ? `out of budget (resets ${j.resetAt})` : "out of budget";
  } catch { return "out of budget"; }
}

export function classifyCheckpointDb(db: Database, dir: string) {
  const ticketId = singleTicketId(db);
  if (ticketId === null) return null;
  const t = getTicket(db, ticketId);
  if (t === null) return null;
  const branch = branchNameFor(t);
  const pending = listPending(db, ticketId);
  const humanResume = pending.find((s) => s.signal_type === "human_resume");
  const prReady = t.stage === "merge" && t.status !== "done"
    && pending.some((s) => s.signal_type === "human_merge_approval");
  let kind: CheckpointKind; let note: string | null;
  if (t.status === "done") { kind = "done"; note = null; }
  else if (humanResume) { kind = "needs_you"; note = humanResume.reason; }
  else if (prReady) { kind = "pr-ready"; note = "PR open, awaiting merge"; }
  else if (existsSync(join(dir, "transcript.json"))) { kind = "budget"; note = budgetNote(dir); }
  else { kind = "other"; note = null; }
  return { ticketId, status: t.status, stage: t.stage, branch, kind, note };
}

export function listCheckpoints(root: string = stateDir()): Checkpoint[] {
  const out: Checkpoint[] = [];
  let slugs: string[];
  try { slugs = readdirSync(root); } catch { return out; }
  const now = Date.now();
  for (const slug of slugs) {
    const slugDir = join(root, slug);
    let idents: string[];
    try { if (!statSync(slugDir).isDirectory()) continue; idents = readdirSync(slugDir); } catch { continue; }
    for (const ident of idents) {
      const dir = join(slugDir, ident);
      const dbPath = join(dir, "run.db");
      if (!existsSync(dbPath)) continue;
      let cls: ReturnType<typeof classifyCheckpointDb> = null;
      try { const db = new Database(dbPath, { readonly: true }); try { cls = classifyCheckpointDb(db, dir); } finally { db.close(); } }
      catch { continue; }
      if (cls === null) continue;
      let ageMs = 0; try { ageMs = now - statSync(dbPath).mtimeMs; } catch { ageMs = 0; }
      const lock = runLockStatus(dir);
      out.push({ slug, ident, dir, dbPath, ...cls, ageMs, live: lock !== null && !lock.self });
    }
  }
  return out;
}
```

- [ ] **Step 4: Run GREEN + full gates** (`bun test test/cli/checkpoints.test.ts`, then `bun test`, `bun run lint`, `bun run typecheck`).

- [ ] **Step 5: Commit**
```bash
git add src/cli/checkpoints.ts test/helpers/checkpoint.ts test/cli/checkpoints.test.ts
git commit -m "feat(housekeeping): listCheckpoints enumeration substrate (ENG-386)"
```

---

### Task 2: `styre ls`

**Files:** Create `src/cli/ls.ts`; Modify `src/index.ts`; Test `test/cli/ls.test.ts`.

**Interfaces:** Consumes `listCheckpoints`/`Checkpoint`, `guard`. Produces `lsCommand` + `export async function lsImpl(opts?: { root?: string }): Promise<void>` writing to **stdout**. Resumable section = `kind ∈ {needs_you, budget}`, newest-first (`ageMs` asc), each with a `resume: styre run --resume <ident> --slug <slug>` hint (matches `run.ts:95,102,339`). Finished-leftovers section = `kind ∈ {pr-ready, done, other}`. `humanAge(ms)` helper renders `12m`/`3h`/`2d`.

- [ ] **Step 1: Write the failing test** — seed a `needs_you` effort under a temp `root`, capture `process.stdout.write` (restore in `finally`, per `test/cli/setup.test.ts`), assert the output contains the ident, the honest-note, and `styre run --resume ENG-1`.
- [ ] **Step 2: Run FAIL** — `src/cli/ls.ts` absent.
- [ ] **Step 3: Implement** `lsImpl` (columns: `ident  [kind, age]  note` + resume hint per resumable row; a "Stale/finished leftovers (reap with `styre clean --all`)" section for the rest; "No paused efforts." when empty) and register `ls: lsCommand` in `index.ts`.
- [ ] **Step 4: GREEN + full gates.**
- [ ] **Step 5: Commit** `feat(housekeeping): styre ls lists resumable efforts + leftover preview (ENG-386)`.

---

### Task 3: `styre clean <ident>` — reap one effort's disk artifacts (no status change)

**Files:** Create `src/cli/clean.ts`; Modify `src/index.ts`; Test `test/cli/clean.test.ts`.

**Interfaces:** Consumes `parkDir`, `runLockStatus`, `reconcileWorktree`/`getLatestWorktreePath`, `branchNameFor`, `getTicket`, profile loaders, `StyreError`/`EXIT`, `guard`. Produces `cleanCommand` (positional `ident?`, booleans `all`/`purge`, string `slug`/`profile`) + `cleanImpl(args, opts?)`. This task implements the **single-ident** path and the shared `reapEffort(targetRepo, c: Checkpoint | {branch;dir;ticketId;dbPath})` helper.

`reapEffort(targetRepo, c)`: read `stale = <the effort's recorded worktree>` (open the db read-only for `getLatestWorktreePath(db, c.ticketId)`, or reuse an already-open handle), then `reconcileWorktree(targetRepo, c.branch, stale ?? undefined, join(c.dir,"wt"), c.dir)` (the `join(c.dir,"wt")` sentinel is a non-repo path used only for reconcile's in-place `=== repoPath` check — verified inert, same idiom as ENG-385 Task 4), then `rmSync(c.dir, { recursive: true, force: true })`.

Single-ident `cleanImpl` flow (NO `setTicketStatus` anywhere):
1. Resolve `slug` (`args.slug ?? slugForCwd()`), `profile` (`opts?.profile ?? loadProfileByConvention(slug)`), `targetRepo = opts?.targetRepo ?? profile.targetRepo`, `root = opts?.root` (defaults inside `parkDir`/`stateDir`).
2. `dir = parkDir(slug, ident)`; if `!existsSync(join(dir,"run.db"))` → `StyreError` "no styre effort on `<ident>`" (exit `EXIT.USAGE` 64).
3. `const lock = runLockStatus(dir); if (lock && !lock.self)` → `StyreError` "a run is in progress (pid …); refusing to clean" (exit 65) — before any deletion.
4. Build the `Checkpoint` for `dir` (reuse `classifyCheckpointDb` or a thin read for `branch`/`ticketId`), then `reapEffort(targetRepo, c)`.
5. Print `styre clean: reaped <ident> (freed worktree, removed checkpoint)` to stdout; exit 0.

*(Test seam: add explicit `opts?: { root?: string; targetRepo?: string; profile?: Profile }` to `cleanImpl` — do NOT claim to "mirror `runImpl`", which has no such params (review nit). Inject a temp state root + a real temp git `targetRepo`.)*

- [ ] **Step 1: Failing test** — a `needs_you`/`pr-ready` effort under temp `root`, with a real styre-owned worktree holding its branch in a temp git `targetRepo` (`git worktree add -B <branch>` into a `mkdtempSync(…, "styre-wt-")` path — mirror `test/cli/run-live-location.test.ts`). After `cleanImpl({ ident, slug }, { root, targetRepo })`: worktree gone from `listWorktrees(targetRepo)` AND checkpoint dir gone. Plus a **refuse** test: seed a live `run.lock` (`writeFileSync(join(dir,"run.lock"), String(process.ppid))`) → refuses (exit 65), worktree + dir untouched.
- [ ] **Step 2: Run FAIL** — `src/cli/clean.ts` absent.
- [ ] **Step 3: Implement** the single-ident path + `reapEffort`; register `clean: cleanCommand`. If neither `ident` nor `--all` → `StyreError` usage (64). If `args.all && args.purge` → `StyreError` "--purge targets a single effort" (64) — the Task 5 guard, added now so the arg contract is complete.
- [ ] **Step 4: GREEN + full gates.**
- [ ] **Step 5: Commit** `feat(housekeeping): styre clean <ident> reaps one effort's disk artifacts (ENG-386)`.

---

### Task 4: `styre clean --all` — Scope B (reap finished leftovers, protect resumable + live)

**Files:** Modify `src/cli/clean.ts`; Test `test/cli/clean.test.ts` (extend).

**Interfaces:** `cleanImpl` `--all` branch: `listCheckpoints(root)`, keep `kind ∈ {pr-ready, done, other}` AND `!live`, `reapEffort(targetRepo, c)` each. Skip `needs_you`/`budget` (resumable) and any `live`. Report `reaped N finished leftover(s); kept M resumable (clean them by name)`. Exit 0. NO merge/age heuristic.

- [ ] **Step 1: Failing test** — seed three efforts under one `root`+`targetRepo`: a `pr-ready` (with worktree), a `done` (with worktree), and a `needs_you` (with worktree). `cleanImpl({ all: true, slug }, { root, targetRepo })` → the `pr-ready` and `done` worktrees + dirs are gone; the `needs_you` worktree + dir **survive**. Assert the counts line.
- [ ] **Step 2: Run FAIL.**
- [ ] **Step 3: Implement** the `--all` branch.
- [ ] **Step 4: GREEN + full gates.**
- [ ] **Step 5: Commit** `feat(housekeeping): styre clean --all reaps finished leftovers, protects resumable (ENG-386)`.

---

### Task 5: `--purge` — also delete the local + remote branch (silent when absent)

**Files:** Modify `src/dispatch/worktree.ts` (add branch-delete helpers); Modify `src/cli/clean.ts` (`--purge` after reap); Test `test/cli/clean.test.ts` (extend), `test/dispatch/*worktree*.test.ts` (extend).

**Interfaces:**
- Produces in `worktree.ts`:
  ```ts
  /** Delete the local branch if it exists; a missing branch is a silent success. */
  export function deleteLocalBranch(repoPath: string, branch: string): void {
    Bun.spawnSync(["git", "branch", "-D", branch], { cwd: repoPath }); // ignore exit (absent = fine)
  }
  /** Delete the remote branch (closing its PR) if it exists; a missing remote ref is a silent
   *  success. A real failure (auth/network) is surfaced as a non-fatal warning, never thrown —
   *  the effort reap has already succeeded. */
  export function deleteRemoteBranch(repoPath: string, branch: string): void {
    const res = Bun.spawnSync(["git", "push", "origin", "--delete", branch], { cwd: repoPath });
    if (res.exitCode === 0) return;
    const err = res.stderr.toString();
    if (/remote ref does not exist|not found|does not exist/i.test(err)) return; // silent no-op
    process.stderr.write(`styre clean: could not delete remote branch ${branch}: ${err.trim()}\n`);
  }
  ```
- `cleanImpl` (single-ident path only): after `reapEffort` succeeds, if `args.purge` → `deleteLocalBranch(targetRepo, c.branch)` then `deleteRemoteBranch(targetRepo, c.branch)`. (`--all --purge` is already rejected in Task 3.) Order matters: the worktree is freed by `reapEffort` first, so the local branch is no longer checked out and `-D` succeeds.

- [ ] **Step 1: Failing test — `deleteLocalBranch`/`deleteRemoteBranch` silent-pass + effect.** In a temp git repo with a bare "origin" remote (`git init --bare` + `git remote add origin` + push): (a) delete an existing local+remote branch → both gone; (b) delete a branch that exists in neither → **no throw, no error output** (silent). Assert the remote ref list before/after.
- [ ] **Step 2: Run FAIL** — helpers absent.
- [ ] **Step 3: Implement** the two helpers in `worktree.ts`.
- [ ] **Step 4: Failing test — `clean <ident> --purge`.** An effort whose branch exists locally + on a bare origin, with a styre-owned worktree. `cleanImpl({ ident, slug, purge: true }, { root, targetRepo })` → worktree + checkpoint gone AND local + remote branch gone. A second case: same but with NO branch anywhere → `--purge` still reaps the effort and does not error (silent-pass). Assert `--all --purge` throws a usage error (exit 64).
- [ ] **Step 5: Run FAIL → Implement the `--purge` tail in `cleanImpl` → GREEN.**
- [ ] **Step 6: Full gates + commit**
```bash
git add src/dispatch/worktree.ts src/cli/clean.ts test/cli/clean.test.ts test/dispatch/*worktree*.test.ts
git commit -m "feat(housekeeping): styre clean --purge deletes local+remote branch, silent when absent (ENG-386)"
```

---

## Self-Review

**Spec coverage (ENG-386 AC + design §5/§10, revised):**
- `styre ls` lists resumable efforts + reason + resume hint → Task 2. ✓ (+ leftover preview)
- `styre clean <ident>` frees its worktree (+ checkpoint), NO status change → Task 3. ✓
- `styre clean --all` sweeps finished leftovers, protects resumable → Task 4 (Scope B). ✓
- `styre clean <ident> --purge` deletes local+remote branch, silent when absent → Task 5. ✓
- `abandoned` gets NO producer (design §3.5 revised) → nothing sets ticket status. ✓
- No merge/age heuristic (squash-merge finding) → removed; ENG-387 owns the push-side fix. ✓
- `bun run lint` + `bun test` + `typecheck` green → every task's gate. ✓

**Placeholder scan:** the "confirm when writing" notes (seed helper arg shapes vs `project.ts`/`ticket.ts`; the `cleanImpl` `opts` seam) cite their source + a concrete fallback — grounded, not TBDs. Rev-1 defects fixed: `seedCheckpoint` returns `string`; the seam note no longer claims a nonexistent `runImpl` precedent; `kind`/`note` field names disambiguate design §5's "reason"/"honest-note".

**Type consistency:** `Checkpoint`/`CheckpointKind` defined in Task 1, consumed unchanged by 2–5; `reapEffort` introduced in Task 3, reused in 4–5; `deleteLocalBranch`/`deleteRemoteBranch` added in Task 5 with the signatures the `--purge` tail calls. `reconcileWorktree` 5-arg + `branchNameFor({ident,branch_name,branch_prefix})` match real signatures (verified).

## Residual notes (for the human)

- **`clean` needs no `migrate()` before opening a checkpoint db** — Task 3/5 open read-only for `getLatestWorktreePath`/classification; enumeration already best-effort-skips a schema-drifted db. (Resume migrates first, `park.ts:224`, because it re-runs the run; clean does not.)
- **`deleteRemoteBranch` uses the repo's configured git auth.** In the local-operator model that is the same credential a run's push uses. A real auth failure is a non-fatal warning (the reap already happened), not an error — matches the "silent pass" intent for the common no-PR case without hiding a genuine auth problem.
- **Done-checkpoint accumulation** — `--all` now reaps `done`/`other` leftovers too (not just `pr-ready`), so the state dir no longer grows unbounded on success. Resumable pauses are the only kind `--all` leaves behind.

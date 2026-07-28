# ENG-386 Housekeeping — `styre ls` + `styre clean` Implementation Plan (rev 3)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the two operator-facing housekeeping commands that complete the ENG-380 epic: `styre ls` (list styre's leftover efforts) and `styre clean <ident> | --all [--purge]` (reap those leftovers on disk, optionally deleting the branch/PR too). **`clean` never changes ticket status** and makes **no** assumption about a PR's fate.

**Architecture:** A shared read-only enumeration substrate (`listCheckpoints`) walks the state dir (`~/.local/state/styre/<slug>/<ident>/run.db`) and classifies each leftover *effort* by inspecting its `run.db` (single-ticket SoT) + sidecar files + run-lock. `ls` renders the resumable subset (+ a preview of finished leftovers). `clean` reaps an effort's disk artifacts (worktree via the liveness-gated `reconcileWorktree`, then the checkpoint dir); `--all` bulk-reaps ONLY the two provably-finished kinds (`pr-ready`, `done`) and protects everything else; `--purge` additionally deletes the local + remote branch (closing the PR), and is a silent no-op when there is no branch/PR.

**Tech Stack:** Bun + TypeScript, `citty` subcommands, `bun:sqlite`, existing `src/dispatch/worktree.ts` / `src/cli/run-lock.ts` / `src/db/repos/*` helpers. No new runtime dependencies.

## What changed across revisions

- **rev 2** (from rev 1, per operator + review): `clean` no longer touches ticket status (`abandoned` gets no producer — design §3.5); the merge/age "staleness" heuristic was removed (styre squash-merges, so `git merge-base --is-ancestor` is always false for merged PRs); `--purge` added; force-with-lease push split to **ENG-387**.
- **rev 3** (this rev, from the rev-2 review):
  - **`--all` reaps ONLY `{pr-ready, done}`** — the two kinds styre can *prove* are finished. It protects `needs_you`/`budget`/**`interrupted`**/`other`. Rev 2 reaped `other`, which silently included **crashed/SIGINT'd runs whose `run.db` is resumable** (live-location leaves a durable SoT at the checkpoint) — reaping them is exactly the silent-orphaning this epic exists to prevent.
  - **New `interrupted` kind** — a lock-less `status="active"` checkpoint with no terminal marker (a crashed run). Surfaced by `ls` as resumable; protected from `--all`.
  - **`--purge` remote-delete is locale-proof** — probe existence with `git ls-remote --heads origin <branch>` instead of parsing English error text.
  - **`ls` never shows a live run as resumable or reapable** — live efforts go under an advisory `Running:` line.
  - **`--all` isolates per-effort failures** (try/catch, collect, report) so one refusal/race doesn't abort the sweep.
  - **Live-run refuse exits `75` (TEMPFAIL, "busy — try later")**, not `65` (which `errorKindForExit` maps to `resume_refused`).

## Global Constraints

- **`clean` never changes ticket status.** No `setTicketStatus` in any production path. `abandoned` gets no producer (design §3.5).
- **By default `clean` never touches branches or the PR.** The remote branch *is* the PR; deleting it is the opt-in `--purge` action only.
- **`--purge` is idempotent / silent-pass.** Deleting a local branch that doesn't exist, or a remote branch/PR that doesn't exist, is a **silent success**, never an error.
- **`--all` only reaps what styre can prove is finished** (`pr-ready`, `done`). It never reaps a resumable pause (`needs_you`, `budget`, `interrupted`), an unclassifiable effort (`other`), or a live run.
- **No schema change; no new runtime dependencies.** `node:fs`, `bun:sqlite`, existing helpers.
- **Never blind-force-remove a worktree.** All worktree freeing goes through `reconcileWorktree` (liveness-gated). `clean` refuses to touch an effort whose `run.lock` is held by a *live, non-self* process (`runLockStatus`), before any deletion.
- **Read-only enumeration never throws on a bad checkpoint** (best-effort, `priorRunIdAt` idiom, `park.ts:85-100`).
- **Gates:** every task ends with `bun test`, `bun run lint`, AND `bun run typecheck` all green.
- **Output:** human text via `src/cli/output.ts` `formatMessage`; `ls`/`clean` results to **stdout** (not telemetry runs, whose stdout is NDJSON — `run.ts:163,330`). Errors/refusals via `guard()` to stderr.
- **Wiring:** each command a `citty` `defineCommand` in its own file, body wrapped in `guard("<cmd>", …)`, registered in `src/index.ts` `subCommands`; args a hand-typed interface cast from `ctx.args` (`migrate.ts` pattern).

## Resolved decisions

1. **Staleness heuristic:** REMOVED. `--all` is kind-based, no merge/age guessing.
2. **`--all` scope:** reap ONLY `{pr-ready, done}` (provably finished); protect `{needs_you, budget, interrupted, other}` and live runs. Those are cleared only by name (`clean <ident>`).
3. **`ls` content:** resumable efforts (`needs_you`/`budget`/`interrupted`, with resume hints) + a "finished leftovers" preview (`pr-ready`/`done`, what `--all` reaps) + an advisory `Running:` line for live efforts. Live efforts never appear as resumable or reapable.
4. **`abandoned`:** no producer; `clean` exits 0 on success.
5. **`--purge`:** single-ident only. `--all --purge` is a usage error (exit 64).
6. **Live-run refuse:** exit 75 (TEMPFAIL).

## Ground truth (verified against source)

- Every run journals to `parkDir/run.db` from its first write (`run.ts:225-226`) and `finishRunResult` never deletes the dir (`park.ts:62-76`) — so the state dir accumulates `run.db` for `needs_you`, `budget`, `pr-ready`, `done`, AND crashed (`interrupted`) efforts.
- Terminal classification markers (`run-ticket.ts:108-154`, `park.ts`):
  - `needs_you` → pending `human_resume` signal (`reason` = honest-note) + ticket `waiting`.
  - `budget` → `dumpPark` writes `transcript.json` `{cause,resetAt,…}`; NO signal, ticket not `waiting`.
  - `pr-ready` → ticket `stage==="merge"` && `status!=="done"` && pending `human_merge_approval`; process exits (one-shot, no daemon).
  - `done` → ticket `status==="done"`.
  - **crashed/interrupted** → `run.db` present, `status="active"`, no `human_resume`, not `pr-ready`, no `transcript.json` (the run died mid-work; live-location left the SoT durable and resumable — design §3.2/§6).
- Re-run branch handling: `ensureWorktree` uses `git worktree add -B <branch>` (`worktree.ts:51,59`) — a stale **local** branch is force-reset, never a blocker. The push is plain `git push origin <branch>` (`github.ts:106`) — a stale **remote** branch blocks a divergent redo (→ ENG-387).
- Signatures (exact): `parkDir` (`park.ts:79`), `stateDir()` (`config/paths.ts:5`), `runLockStatus(dir):{pid,self}|null` (`run-lock.ts:27`), `listPending`/`SignalRow.{signal_type,reason}` (`signal.ts:4-31`), `getTicket`/`TicketRow.{ident,stage,status,branch_name,branch_prefix}` (`ticket.ts`), `branchNameFor({ident,branch_name,branch_prefix})` (`branch.ts:3`), `reconcileWorktree(repoPath,branch,stale?|undefined,newWorktreePath,checkpointDir?):{freed,skipped}` (`worktree.ts:181`), `getLatestWorktreePath(db,ticketId)` (`dispatch.ts:190`), `Profile.{slug,targetRepo,defaultBranch}` (`profile.ts:116`), `loadProfileByConvention(slug)`/`slugForCwd()` (`config/discover.ts:33,48`), `guard`/`formatMessage` (`output.ts:4,30`), `EXIT`/`StyreError` (`errors.ts`), `openDb` (`client.ts:4`), `migrate` (`db/migrate.ts`). `subCommands` map at `index.ts:25`.

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
  export type CheckpointKind = "needs_you" | "budget" | "pr-ready" | "interrupted" | "done" | "other";
  export interface Checkpoint {
    slug: string;
    ident: string;
    dir: string;            // parkDir(slug, ident)
    dbPath: string;         // join(dir, "run.db")
    ticketId: number;
    status: string;
    stage: string;
    branch: string;         // branchNameFor(ticket)
    kind: CheckpointKind;   // the design §5 "reason"
    note: string | null;    // the design §5 "honest-note"
    ageMs: number;          // now - run.db mtime
    live: boolean;          // runLockStatus(dir) is a live, non-self process
    resumable: boolean;     // kind ∈ {needs_you, budget, interrupted}
  }
  export function classifyCheckpointDb(db: Database, dir: string):
    { ticketId: number; status: string; stage: string; branch: string; kind: CheckpointKind; note: string | null } | null;
  export function listCheckpoints(root?: string): Checkpoint[];
  ```
  `resumable` is a derived convenience: `kind === "needs_you" || kind === "budget" || kind === "interrupted"`. `listCheckpoints` walks `root ?? stateDir()`; unreadable/malformed `run.db` → skipped (never throws); returned in walk order (callers sort).

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
): string {
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
*(Verified: `insertProject(db,{slug,targetRepo,defaultBranch})→number`, `insertTicket(db,{projectId,ident,title})→number` (defaults `status:"active"`, `stage:"design"`). If either differs, mirror `test/helpers/git-project.ts`.)*

`test/cli/checkpoints.test.ts` — classify all five terminal shapes, including a **crashed → interrupted** effort:
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
  test("classifies needs_you, pr-ready, done, and crashed→interrupted efforts", () => {
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
      seedCheckpoint(root, "proj", "ENG-4", () => {}); // active, no signal, no transcript → interrupted

      const found = listCheckpoints(root);
      const by = (ident: string) => found.find((c) => c.ident === ident);
      expect(by("ENG-1")?.kind).toBe("needs_you");
      expect(by("ENG-1")?.note).toBe("needs you: composer not installed");
      expect(by("ENG-2")?.kind).toBe("pr-ready");
      expect(by("ENG-3")?.kind).toBe("done");
      expect(by("ENG-4")?.kind).toBe("interrupted");
      expect(by("ENG-4")?.resumable).toBe(true);
      expect(found.every((c) => c.live === false)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run to verify FAIL** — `src/cli/checkpoints.ts` does not exist.

- [ ] **Step 3: Implement `src/cli/checkpoints.ts`**

Classification order — `done` → `needs_you` → `pr-ready` → `budget` (`transcript.json`) → `interrupted` (`status==="active"`, no terminal marker) → `other`. This is **equivalence-safe, not a literal copy of `driveToTerminal`** (which tests `budget`/parked first): the persisted markers are disjoint (budget = `transcript.json` + no signal; needs_you = pending `human_resume`), and `needs_you` is tested before `budget` so a parked-then-escalated effort still resolves to `needs_you`.
```ts
import { Database } from "bun:sqlite";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { branchNameFor } from "../agent/branch.ts";
import { stateDir } from "../config/paths.ts";
import { listPending } from "../db/repos/signal.ts";
import { getTicket } from "../db/repos/ticket.ts";
import { runLockStatus } from "./run-lock.ts";

export type CheckpointKind = "needs_you" | "budget" | "pr-ready" | "interrupted" | "done" | "other";
export interface Checkpoint { /* …as declared above (incl. resumable) … */ }

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
  else if (t.status === "active") { kind = "interrupted"; note = "interrupted mid-run — resume to continue"; }
  else { kind = "other"; note = null; }
  return { ticketId, status: t.status, stage: t.stage, branch, kind, note };
}

const RESUMABLE: ReadonlySet<CheckpointKind> = new Set(["needs_you", "budget", "interrupted"]);

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
      out.push({ slug, ident, dir, dbPath, ...cls, ageMs, live: lock !== null && !lock.self, resumable: RESUMABLE.has(cls.kind) });
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

**Interfaces:** Consumes `listCheckpoints`/`Checkpoint`, `guard`. Produces `lsCommand` + `export async function lsImpl(opts?: { root?: string }): Promise<void>` writing to **stdout**.
- **Resumable section** = `resumable && !live`, newest-first (`ageMs` asc), each with a `resume: styre run --resume <ident> --slug <slug>` hint (matches `run.ts:95,102,339`).
- **Finished-leftovers preview** (what `clean --all` reaps) = `kind ∈ {pr-ready, done} && !live`.
- **`Running:` line** = `live` efforts (advisory; never shown as resumable or reapable).
- `humanAge(ms)` renders `12m`/`3h`/`2d`.

- [ ] **Step 1: Write the failing test** — seed a `needs_you` effort under a temp `root`; capture `process.stdout.write` (restore in `finally`, per `test/telemetry/events.test.ts`); assert output contains the ident, the honest-note, and `styre run --resume ENG-1`.
- [ ] **Step 2: Run FAIL** — `src/cli/ls.ts` absent.
- [ ] **Step 3: Implement** `lsImpl` (resumable rows `ident  [kind, age]  note` + resume hint; a "Finished leftovers (reap with `styre clean --all`):" section for `{pr-ready,done} && !live`; a "Running:" line for `live`; "No paused efforts." when the resumable set is empty) and register `ls: lsCommand` in `index.ts`.
- [ ] **Step 4: GREEN + full gates.**
- [ ] **Step 5: Commit** `feat(housekeeping): styre ls lists resumable efforts + leftover preview (ENG-386)`.

---

### Task 3: `styre clean <ident>` — reap one effort's disk artifacts (no status change)

**Files:** Create `src/cli/clean.ts`; Modify `src/index.ts`; Test `test/cli/clean.test.ts`.

**Interfaces:** Consumes `parkDir`, `runLockStatus`, `reconcileWorktree`/`getLatestWorktreePath`, `branchNameFor`, profile loaders, `StyreError`/`EXIT`, `guard`. Produces `cleanCommand` (positional `ident?`, booleans `all`/`purge`, string `slug`/`profile`) + `cleanImpl(args, opts?)`. Implements the **single-ident** path + the shared `reapEffort(targetRepo, c)` helper.

`reapEffort(targetRepo, c)`: open the db read-only to read `stale = getLatestWorktreePath(db, c.ticketId)`, then `reconcileWorktree(targetRepo, c.branch, stale ?? undefined, join(c.dir,"wt"), c.dir)` (the `join(c.dir,"wt")` sentinel is a non-repo path used only for reconcile's in-place `=== repoPath` check — verified inert; identical idiom ships at `run.ts:252-258`), then `rmSync(c.dir, { recursive: true, force: true })`.

Single-ident `cleanImpl` flow (NO `setTicketStatus`):
1. Resolve `slug` (`args.slug ?? slugForCwd()`), `profile` (`opts?.profile ?? loadProfileByConvention(slug)`), `targetRepo = opts?.targetRepo ?? profile.targetRepo`, optional `root = opts?.root`.
2. `dir = parkDir(slug, ident)`; if `!existsSync(join(dir,"run.db"))` → `StyreError` "no styre effort on `<ident>`" (exit `EXIT.USAGE` 64).
3. `const lock = runLockStatus(dir); if (lock && !lock.self)` → `StyreError` "a run is in progress (pid …); refusing to clean" (exit **`EXIT.TEMPFAIL` 75** — "busy, try again later"; NOT 65, which telemetry buckets as `resume_refused`) — before any deletion.
4. Build the `Checkpoint` for `dir` (via `classifyCheckpointDb` / a thin read for `branch`+`ticketId`), then `reapEffort(targetRepo, c)`.
5. Print `styre clean: reaped <ident> (freed worktree, removed checkpoint)` to stdout; exit 0.

*(Test seam: explicit `opts?: { root?: string; targetRepo?: string; profile?: Profile }` on `cleanImpl` — inject a temp state root + a real temp git `targetRepo`. Do not claim to mirror `runImpl` — it has no such params.)*

- [ ] **Step 1: Failing test** — a `pr-ready` effort under temp `root` with a real styre-owned worktree holding its branch in a temp git `targetRepo` (`git worktree add -B <branch>` into a `mkdtempSync(…, "styre-wt-")` path — mirror `test/cli/run-live-location.test.ts:113`). After `cleanImpl({ ident, slug }, { root, targetRepo })`: worktree gone from `listWorktrees(targetRepo)` AND checkpoint dir gone. Plus a **refuse** test: seed a live `run.lock` (`writeFileSync(join(dir,"run.lock"), String(process.ppid))`) → refuses (exit 75), worktree + dir untouched.
- [ ] **Step 2: Run FAIL.**
- [ ] **Step 3: Implement** the single-ident path + `reapEffort`; register `clean: cleanCommand`. If neither `ident` nor `--all` → `StyreError` usage (64). If `args.all && args.purge` → `StyreError` "--purge targets a single effort; name an ident" (64).
- [ ] **Step 4: GREEN + full gates.**
- [ ] **Step 5: Commit** `feat(housekeeping): styre clean <ident> reaps one effort's disk artifacts (ENG-386)`.

---

### Task 4: `styre clean --all` — reap only the provably-finished (`pr-ready`/`done`), protect the rest

**Files:** Modify `src/cli/clean.ts`; Test `test/cli/clean.test.ts` (extend).

**Interfaces:** `cleanImpl` `--all` branch: `listCheckpoints(root)`, keep `kind ∈ {pr-ready, done}` AND `!live`; wrap each `reapEffort(targetRepo, c)` in try/catch, collecting `{ident, error}` failures. Protect `needs_you`/`budget`/`interrupted`/`other` and any `live` (never reaped). Report `reaped N finished leftover(s); kept M resumable/unknown; F failed`. Exit 0. NO merge/age heuristic.

- [ ] **Step 1: Failing test** — seed four efforts under one `root`+`targetRepo`, each with a styre-owned worktree: `pr-ready`, `done`, `needs_you`, and `interrupted` (active, no markers). `cleanImpl({ all: true, slug }, { root, targetRepo })` → the `pr-ready` and `done` worktrees + dirs are gone; the `needs_you` AND `interrupted` worktrees + dirs **survive**. Assert the counts line reports 2 reaped / 2 kept.
- [ ] **Step 2: Run FAIL.**
- [ ] **Step 3: Implement** the `--all` branch (kind filter `{pr-ready,done}`, per-effort try/catch, counts line).
- [ ] **Step 4: GREEN + full gates.**
- [ ] **Step 5: Commit** `feat(housekeeping): styre clean --all reaps finished leftovers, protects resumable/interrupted (ENG-386)`.

---

### Task 5: `--purge` — also delete the local + remote branch (silent when absent)

**Files:** Modify `src/dispatch/worktree.ts` (branch-delete helpers); Modify `src/cli/clean.ts` (`--purge` tail); Test `test/cli/clean.test.ts` (extend), `test/dispatch/*worktree*.test.ts` (extend).

**Interfaces:**
- Produces in `worktree.ts`:
  ```ts
  /** Delete the local branch if it exists; a missing branch is a silent success. */
  export function deleteLocalBranch(repoPath: string, branch: string): void {
    Bun.spawnSync(["git", "branch", "-D", branch], { cwd: repoPath }); // ignore exit (absent = fine)
  }
  /** Delete the remote branch (closing its PR) if it exists; a missing remote ref is a silent
   *  success. Existence is probed first (locale-proof — no stderr parsing); a real delete failure
   *  is a non-fatal warning (the effort reap already succeeded), never thrown. */
  export function deleteRemoteBranch(repoPath: string, branch: string): void {
    const ls = Bun.spawnSync(["git", "ls-remote", "--heads", "origin", branch], { cwd: repoPath });
    if (ls.exitCode !== 0 || ls.stdout.toString().trim() === "") return; // no remote / branch absent → silent
    const res = Bun.spawnSync(["git", "push", "origin", "--delete", branch], { cwd: repoPath });
    if (res.exitCode !== 0) {
      process.stderr.write(`styre clean: could not delete remote branch ${branch}: ${res.stderr.toString().trim()}\n`);
    }
  }
  ```
- `cleanImpl` (single-ident path only): after `reapEffort` succeeds, if `args.purge` → `deleteLocalBranch(targetRepo, c.branch)` then `deleteRemoteBranch(targetRepo, c.branch)`. Ordering: `reapEffort` frees the worktree first (via `reconcileWorktree`'s `git worktree remove --force`), so the local branch is no longer checked out and `-D` succeeds. *(In-place edge: for an in-place run the recorded worktree path == `targetRepo`, so reconcile skips and the branch stays checked out in the repo root; `git branch -D` then no-ops silently. `--purge` still reaps the checkpoint and deletes the remote branch. Documented — in-place is the disposable-container path.)*

- [ ] **Step 1: Failing test — `deleteLocalBranch`/`deleteRemoteBranch` silent-pass + effect.** In a temp git repo with a **bare** origin (`git init --bare` + `git remote add origin` + push): (a) delete an existing local+remote branch → both gone (assert via `git ls-remote --heads origin` before/after); (b) delete a branch that exists in neither → **no throw, no stderr output** (capture stderr, assert empty). This is net-new test infra (no existing test uses a bare origin).
- [ ] **Step 2: Run FAIL** — helpers absent.
- [ ] **Step 3: Implement** the two helpers in `worktree.ts`.
- [ ] **Step 4: Failing test — `clean <ident> --purge`.** An effort whose branch exists locally + on a bare origin, with a styre-owned worktree. `cleanImpl({ ident, slug, purge: true }, { root, targetRepo })` → worktree + checkpoint gone AND local + remote branch gone. Second case: same but with NO branch anywhere → `--purge` still reaps the effort and produces no error output (silent-pass). Assert `--all --purge` throws a usage error (exit 64).
- [ ] **Step 5: Run FAIL → Implement the `--purge` tail in `cleanImpl` → GREEN.**
- [ ] **Step 6: Full gates + commit**
```bash
git add src/dispatch/worktree.ts src/cli/clean.ts test/cli/clean.test.ts test/dispatch/*worktree*.test.ts
git commit -m "feat(housekeeping): styre clean --purge deletes local+remote branch, silent when absent (ENG-386)"
```

---

## Self-Review

**Spec coverage (ENG-386 AC + design §5/§10, revised):**
- `styre ls` lists resumable efforts (incl. `interrupted`) + reason + resume hint, never shows live as reapable → Task 2. ✓
- `styre clean <ident>` frees worktree (+ checkpoint), NO status change → Task 3. ✓
- `styre clean --all` reaps only `pr-ready`/`done`, protects `needs_you`/`budget`/`interrupted`/`other`/live → Task 4. ✓
- `styre clean <ident> --purge` deletes local+remote branch, silent when absent → Task 5. ✓
- `abandoned` gets NO producer → nothing sets ticket status. ✓
- No merge/age heuristic → removed; ENG-387 owns the push-side fix. ✓
- `bun run lint` + `bun test` + `typecheck` green → every task's gate. ✓

**Placeholder scan:** the "confirm/verify when writing" notes cite their source + a concrete fallback — grounded, not TBDs. Review-flagged defects fixed: `seedCheckpoint` returns `string`; stdout-capture cite is `test/telemetry/events.test.ts`; the classification note says "equivalence-safe, not a literal precedence copy"; `deleteRemoteBranch` uses an existence probe (locale-proof); the live-run refuse exits 75; `--all` isolates per-effort failures; in-place `--purge` documented.

**Type consistency:** `Checkpoint`/`CheckpointKind` (with `interrupted`, `resumable`) defined in Task 1, consumed unchanged by 2–5; `reapEffort` introduced in Task 3, reused in 4–5; `deleteLocalBranch`/`deleteRemoteBranch` added in Task 5 with the signatures the `--purge` tail calls.

## Residual notes (for the human)

- **`--all` reaps only the provably-finished** (`pr-ready`/`done`). Crashed (`interrupted`) and unclassifiable (`other`) efforts are protected — cleared only by explicit `clean <ident>`. This honors the epic's anti-orphaning thesis (never silently discard resumable run state).
- **`clean` needs no `migrate()`** before opening a checkpoint db — it opens read-only for classification / `getLatestWorktreePath`; enumeration already best-effort-skips a schema-drifted db.
- **`deleteRemoteBranch` uses the repo's configured git auth** (same credential a run's push uses). A real auth failure is a non-fatal warning (the reap already happened), not an error.
- **State-dir growth on success** — with `--all` reaping `pr-ready`/`done`, the two success terminals no longer accumulate unbounded; only resumable/interrupted/unknown efforts persist until reaped by name.

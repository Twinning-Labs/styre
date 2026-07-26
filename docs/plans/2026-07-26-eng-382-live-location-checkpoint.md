# ENG-382: Live-location checkpoint + per-ticket run lock + refuse-guard + find-or-create Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a fresh `styre run` journal its SoT directly to the durable per-ticket checkpoint (`~/.local/state/styre/<slug>/<ident>/run.db`) from the start — so a crash/escalation/block leaves a resumable checkpoint with no orphaned temp DB — guarded by a per-ticket run lock, a refuse-on-existing-checkpoint guard with a `--fresh` escape, and find-or-create DB inserts.

**Architecture:** Today a fresh run journals to a throwaway temp DB (`run.ts:199-202`) and only a `parked` outcome copies it to the checkpoint (`dumpPark`, `park.ts:104-136`); every other halt orphans the temp DB. This plan hoists the ticket→ident resolution ahead of DB creation so the run opens its DB *at* `parkDir(slug, ident)/run.db`, deletes `dumpPark`'s copy machinery (the WAL fold is retained), adds a lockfile in the checkpoint dir to prevent two concurrent runs of one ticket, refuses to clobber an existing checkpoint (with `--fresh` to discard it), makes the project/ticket inserts idempotent so re-entry can't UNIQUE-crash, and upgrades ENG-381's prunable-only `reconcileWorktree` gate to free a worktree whose owning run is provably dead (via the lock).

**Tech Stack:** Bun + TypeScript; `bun:sqlite` (WAL journal mode); biome (`bun run lint`); `bun test`. No new dependencies.

## Global Constraints

- Every task ends `bun run lint` + `bun test` green.
- No new runtime dependencies; use `node:fs` primitives already imported in the touched files.
- Follow existing repo patterns: repo helpers are plain functions taking `db: Database`; tests use real temp git repos + `makeTestDb`/`gitRepoWithProject` and override `XDG_STATE_HOME` to redirect the state dir.
- `--db <path>` stays a full test/override escape: when set, it bypasses live-location journaling, the refuse-guard, and the lock (the caller manages the DB).
- Preserve the ENG-381 reconcile invariant: a live / non-prunable / foreign worktree is NEVER force-removed.
- **Out of scope (do NOT implement):** outcome-enum/exit-code/telemetry changes (ENG-384); `pauseTicket`/blocked-no-progress routing (ENG-383); the full `--resume` gate and `--fresh`'s resume-gate semantics (ENG-385). `--fresh` here is ONLY the refuse-guard escape (discard checkpoint → fresh run).

---

### Task 1: Find-or-create project/ticket inserts

**Files:**
- Modify: `src/db/repos/project.ts` (add `getBySlug`; make `insertProject` get-or-create)
- Modify: `src/db/repos/ticket.ts` (add `getByIdent`; make `insertTicket` get-or-create)
- Test: `test/db/repos/find-or-create.test.ts` (create)

**Interfaces:**
- Consumes: `makeTestDb` from `test/helpers/db.ts` (seeds project `test-project` + ticket `ENG-1`).
- Produces:
  - `getBySlug(db: Database, slug: string): ProjectRow | null`
  - `getByIdent(db: Database, projectId: number, ident: string): TicketRow | null`
  - `insertProject(db, {slug, targetRepo, defaultBranch?}): number` — returns the existing row id when `slug` already exists, else inserts.
  - `insertTicket(db, {...}): number` — returns the existing row id when `(project_id, ident)` already exists, else inserts.

- [ ] **Step 1: Write the failing test**

Create `test/db/repos/find-or-create.test.ts`:
```ts
import { expect, test } from "bun:test";
import { getBySlug, insertProject } from "../../../src/db/repos/project.ts";
import { getByIdent, insertTicket } from "../../../src/db/repos/ticket.ts";
import { makeTestDb } from "../../helpers/db.ts";

test("insertProject is find-or-create: a second insert with the same slug returns the same id", () => {
  const { db, projectId } = makeTestDb();
  const again = insertProject(db, { slug: "test-project", targetRepo: "/tmp/other" });
  expect(again).toBe(projectId); // existing id, not a new row / not 0
  expect(getBySlug(db, "test-project")?.id).toBe(projectId);
  expect(getBySlug(db, "absent")).toBeNull();
  db.close();
});

test("insertTicket is find-or-create on (project_id, ident): same ident returns the same id", () => {
  const { db, projectId, ticketId } = makeTestDb();
  const again = insertTicket(db, { projectId, ident: "ENG-1", title: "changed" });
  expect(again).toBe(ticketId);
  expect(getByIdent(db, projectId, "ENG-1")?.id).toBe(ticketId);
  expect(getByIdent(db, projectId, "ENG-2")).toBeNull();
  db.close();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/db/repos/find-or-create.test.ts`
Expected: FAIL — `getBySlug`/`getByIdent` are not exported (import error), and today's `insertProject` would throw a UNIQUE error on the duplicate slug.

- [ ] **Step 3: Add the natural-key readers + get-or-create in `project.ts`**

In `src/db/repos/project.ts`, add after `getProject` (`project.ts:27-29`):
```ts
export function getBySlug(db: Database, slug: string): ProjectRow | null {
  return db.query<ProjectRow, [string]>(`SELECT ${COLS} FROM project WHERE slug = ?`).get(slug) ?? null;
}
```
Change `insertProject` (`project.ts:13-25`) to check first:
```ts
export function insertProject(
  db: Database,
  p: { slug: string; targetRepo: string; defaultBranch?: string },
): number {
  const existing = getBySlug(db, p.slug);
  if (existing !== null) return existing.id; // find-or-create: never a UNIQUE crash on re-entry
  const now = nowUtc();
  const res = db
    .query(
      `INSERT INTO project (slug, target_repo, default_branch, created_at, updated_at)
       VALUES ($slug, $repo, $branch, $now, $now)`,
    )
    .run({ $slug: p.slug, $repo: p.targetRepo, $branch: p.defaultBranch ?? "main", $now: now });
  return Number(res.lastInsertRowid);
}
```

- [ ] **Step 4: Add the natural-key reader + get-or-create in `ticket.ts`**

In `src/db/repos/ticket.ts`, add after `getTicket` (`ticket.ts:64-66`):
```ts
export function getByIdent(db: Database, projectId: number, ident: string): TicketRow | null {
  return (
    db
      .query<TicketRow, [number, string]>(`SELECT ${COLS} FROM ticket WHERE project_id = ? AND ident = ?`)
      .get(projectId, ident) ?? null
  );
}
```
Change `insertTicket` (`ticket.ts:22-62`) to check first — add at the top of the body, before `const now = nowUtc();`:
```ts
  const existing = getByIdent(db, t.projectId, t.ident);
  if (existing !== null) return existing.id; // find-or-create on (project_id, ident)
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun test test/db/repos/find-or-create.test.ts`
Expected: PASS.

- [ ] **Step 6: Full suite + lint**

Run: `bun test && bun run lint`
Expected: PASS (no existing test relies on `insertProject`/`insertTicket` throwing on a duplicate; `makeTestDb` seeds distinct keys).

- [ ] **Step 7: Commit**

```bash
git add src/db/repos/project.ts src/db/repos/ticket.ts test/db/repos/find-or-create.test.ts
git commit -m "feat(db): find-or-create insertProject/insertTicket with natural-key readers (ENG-382)"
```

---

### Task 2: Per-ticket run lock

**Files:**
- Create: `src/cli/run-lock.ts`
- Test: `test/cli/run-lock.test.ts` (create)

**Interfaces:**
- Consumes: `node:fs` (`existsSync`, `readFileSync`, `writeFileSync`, `mkdirSync`, `rmSync`); the `process.kill(pid, 0)` liveness idiom (mirrors `recover.ts:38`).
- Produces:
  - `type RunLock = { dir: string; pid: number }`
  - `runLockStatus(dir: string): { pid: number; self: boolean } | null` — null when the lock is absent OR its pid is dead (stale); `self=true` when held by THIS process.
  - `acquireRunLock(dir: string): RunLock | null` — writes `dir/run.lock` with `process.pid` and returns the handle; returns `null` when a LIVE lock is already held by a different process. A stale (dead-pid) lock is overwritten.
  - `releaseRunLock(lock: RunLock): void` — removes `dir/run.lock` iff it still holds `lock.pid` (never deletes another process's lock).

- [ ] **Step 1: Write the failing test**

Create `test/cli/run-lock.test.ts`:
```ts
import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireRunLock, releaseRunLock, runLockStatus } from "../../src/cli/run-lock.ts";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "styre-lock-"));
}

test("acquire writes our pid; status reports self; release removes it", () => {
  const dir = tmp();
  const lock = acquireRunLock(dir);
  expect(lock?.pid).toBe(process.pid);
  expect(existsSync(join(dir, "run.lock"))).toBe(true);
  expect(runLockStatus(dir)).toEqual({ pid: process.pid, self: true });
  if (lock) releaseRunLock(lock);
  expect(existsSync(join(dir, "run.lock"))).toBe(false);
  expect(runLockStatus(dir)).toBeNull();
  rmSync(dir, { recursive: true, force: true });
});

test("a stale (dead-pid) lock is treated as absent and can be re-acquired", () => {
  const dir = tmp();
  writeFileSync(join(dir, "run.lock"), "999999999"); // a pid that cannot be alive
  expect(runLockStatus(dir)).toBeNull(); // dead → stale → null
  const lock = acquireRunLock(dir); // overwrites the stale lock
  expect(lock?.pid).toBe(process.pid);
  rmSync(dir, { recursive: true, force: true });
});

test("acquire returns null when a LIVE lock is held by a different pid", () => {
  const dir = tmp();
  writeFileSync(join(dir, "run.lock"), String(process.pid + 0)); // our own pid → live, but different-owner path:
  // simulate a different live process by writing the current pid then asserting status.self, then a foreign-live case:
  rmSync(join(dir, "run.lock"));
  writeFileSync(join(dir, "run.lock"), String(process.ppid)); // parent pid: alive, not us
  expect(acquireRunLock(dir)).toBeNull();
  expect(runLockStatus(dir)?.self).toBe(false);
  rmSync(dir, { recursive: true, force: true });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/cli/run-lock.test.ts`
Expected: FAIL — module `src/cli/run-lock.ts` does not exist.

- [ ] **Step 3: Write the implementation**

Create `src/cli/run-lock.ts`:
```ts
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type RunLock = { dir: string; pid: number };

/** True iff `pid` is a live process (mirrors recover.ts's liveness probe). */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** The lock's live owner, or null when the lock is absent OR its pid is dead (stale). */
export function runLockStatus(dir: string): { pid: number; self: boolean } | null {
  const file = join(dir, "run.lock");
  if (!existsSync(file)) return null;
  const pid = Number.parseInt(readFileSync(file, "utf8").trim(), 10);
  if (!Number.isInteger(pid) || !isAlive(pid)) return null; // malformed or dead → stale
  return { pid, self: pid === process.pid };
}

/** Take the per-ticket run lock in `dir`. Returns null when a LIVE lock is held by another process;
 *  a stale (dead-pid) or absent lock is (over)written with our pid. */
export function acquireRunLock(dir: string): RunLock | null {
  const held = runLockStatus(dir);
  if (held !== null && !held.self) return null; // a different live process owns it
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "run.lock"), String(process.pid));
  return { dir, pid: process.pid };
}

/** Release the lock iff it still holds our pid (never clobbers another process's lock). */
export function releaseRunLock(lock: RunLock): void {
  const file = join(lock.dir, "run.lock");
  if (!existsSync(file)) return;
  const pid = Number.parseInt(readFileSync(file, "utf8").trim(), 10);
  if (pid === lock.pid) rmSync(file, { force: true });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test test/cli/run-lock.test.ts`
Expected: PASS.

- [ ] **Step 5: Full suite + lint, then commit**

Run: `bun test && bun run lint`
```bash
git add src/cli/run-lock.ts test/cli/run-lock.test.ts
git commit -m "feat(cli): per-ticket run lock (pid-liveness, stale-tolerant) (ENG-382)"
```

---

### Task 3: Live-location checkpoint + ident-ordering + refuse-guard (delete dumpPark copy)

**Files:**
- Modify: `src/daemon/run-ticket.ts:140-172` (accept a pre-fetched `ingested` to avoid a double tracker fetch)
- Modify: `src/cli/run.ts:199-241` (resolve ident before DB creation; journal to `parkDir`; refuse-guard; acquire/release lock; pass `ingested`)
- Modify: `src/cli/park.ts:104-136` (delete `dumpPark`'s copy machinery + `priorRunIdAt`; keep the WAL fold)
- Remove: `test/cli/dump-park-warning.test.ts` (asserts the deleted overwrite warning)
- Test: `test/cli/run-live-location.test.ts` (create)

**Interfaces:**
- Consumes: `parkDir` (`park.ts:75-77`), `acquireRunLock`/`releaseRunLock` (Task 2), `insertProject`/`insertTicket` find-or-create (Task 1), `IngestedTicket` (`src/integrations/ticket-source.ts:6`), `makeProjectorPorts`.
- Produces: `runTicket` deps gain `ingested?: IngestedTicket` — when present, `runTicket` skips its own `fetchTicket`. Fresh runs write `run.db` at `parkDir(profile.slug, ingested.ident)`.

**Decision — ident-ordering (design decision #1):** `ident` is only known after `fetchTicket`. Hoist that single tracker read into `run.ts` (the read already happens once per run; we move it earlier and pass the result down, so there is still exactly ONE `fetchTicket` call). `runTicket` accepts an optional `ingested` and uses it when provided.

- [ ] **Step 1: Write the failing test**

Create `test/cli/run-live-location.test.ts`. It drives a fresh run to completion with a fake tracker + fake agent, `XDG_STATE_HOME` redirected, and asserts the SoT lives at `parkDir` (not a temp dir) and that a second run refuses. Model it on `test/helpers/run-harness.ts` (`runParkedTicket` sets `XDG_STATE_HOME`, builds `gitRepoWithProject`, drives a `FakeAgentRunner`; `PARK_SLUG="test-project"`, `PARK_IDENT="ENG-1"`).
```ts
import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { parkDir } from "../../src/cli/park.ts";
import { runFreshTicket } from "../helpers/run-harness.ts"; // NEW harness helper (Step 2)

test("a fresh run journals its SoT to parkDir/run.db, not a temp dir", async () => {
  const run = await runFreshTicket(); // drives to a terminal, returns { checkpointDir, dbPath, exitCode, _tempDirs }
  expect(run.dbPath).toBe(join(parkDir("test-project", "ENG-1"), "run.db"));
  expect(existsSync(run.dbPath)).toBe(true); // checkpoint is the live SoT
  run.cleanup();
});

test("a second fresh run on an existing checkpoint refuses (usage error), does not clobber", async () => {
  const first = await runFreshTicket();
  await expect(runFreshTicket({ reuseStateOf: first })).rejects.toThrow(/checkpoint already exists|--fresh/i);
  first.cleanup();
});
```
Add `runFreshTicket` to `test/helpers/run-harness.ts` mirroring `runParkedTicket` but driving the fake agent to a NON-parked terminal (pr-ready) and calling the real `runImpl`/`run.ts` fresh path with a `--db`-less config so it journals to `parkDir`; expose `checkpointDir`, `dbPath`, `exitCode`, `cleanup`, and a `reuseStateOf` option that points `XDG_STATE_HOME` at a prior run's state dir.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/cli/run-live-location.test.ts`
Expected: FAIL — `runFreshTicket` unexported; the fresh path still mints a temp DB so `dbPath` is under `styre-run-*`, not `parkDir`.

- [ ] **Step 3: `runTicket` accepts a pre-fetched `ingested`**

In `src/daemon/run-ticket.ts`, add `ingested?: IngestedTicket;` to the deps object type (`run-ticket.ts:140-148`) and import the type (`import type { IngestedTicket } from "../integrations/ticket-source.ts";`). Change line 149:
```ts
  const ingested = deps.ingested ?? (await deps.ports.issueTracker.fetchTicket(deps.ticketRef));
```
(Everything downstream — `insertProject`/`insertTicket` using `ingested.*` — is unchanged.)

- [ ] **Step 4: `run.ts` — resolve ident first, journal to parkDir, refuse-guard, lock**

In `src/cli/run.ts`, replace the block at `run.ts:199-224` (temp-DB mint → registry). New shape:
```ts
    // Ports first (no DB dependency), then the single tracker read so we know the ident BEFORE
    // creating the DB — the SoT must live at the durable checkpoint from the first write.
    const ports = makeProjectorPorts(runtimeConfig, profile);
    const ingested = await ports.issueTracker.fetchTicket(args.ticket);
    const ident = ingested.ident;

    const explicitDb = args.db && args.db.length > 0;
    const checkpointDir = parkDir(profile.slug, ident);
    const dbPath = explicitDb ? (args.db as string) : join(checkpointDir, "run.db");

    // Refuse to clobber an existing checkpoint (live-location only). --fresh discards it (Task 4).
    if (!explicitDb && existsSync(dbPath)) {
      throw usageError(
        `a checkpoint already exists for ${ident} at ${checkpointDir}`,
        `Resume it with 'styre run --resume ${ident}', or discard it with 'styre run ${ident} --fresh'.`,
      );
    }
    if (!explicitDb) mkdirSync(checkpointDir, { recursive: true });

    // Per-ticket lock: refuse a second concurrent run of the same ticket (live-location only).
    const lock = explicitDb ? null : acquireRunLock(checkpointDir);
    if (!explicitDb && lock === null) {
      throw usageError(
        `another 'styre run ${ident}' is already in progress (${checkpointDir}/run.lock)`,
        "Wait for it to finish, or remove the stale lock if that process is gone.",
      );
    }
    try {
      migrate(dbPath);
      const db = openDb(dbPath);
      recover(db, realRecoverDeps());
      // ... (run-identity guard, registry, runStarted, runTicket, runCompleted, finishRunResult) ...
    } finally {
      if (lock) releaseRunLock(lock);
    }
```
Notes for the implementer:
- Wrap the existing body from `run.ts:207` (`const ports = ...` is now hoisted; keep the run-identity guard at `:210-216`, registry `:218-224`, `runStarted`, `runTicket`, `runCompleted`, the parked-hint block `:257-266`, and `finishRunResult` `:267`) inside the `try`, and release the lock in `finally`.
- Pass the pre-fetched ticket into `runTicket`: add `ingested,` to the `runTicket({...})` args (`run.ts:233-241`). This keeps `fetchTicket` at exactly one call.
- Add imports to `run.ts`: `existsSync`, `mkdirSync` from `node:fs`; `acquireRunLock`, `releaseRunLock` from `./run-lock.ts`; `parkDir` is already imported from `./park.ts` (`run.ts:36`). `usageError` is already imported (`run.ts` errors import).
- Remove the now-unused `mkdtempSync(join(tmpdir(), "styre-run-"))`; `mkdtempSync`/`tmpdir` are still used for `worktreeRoot` (`run.ts:222`), so keep those imports.

- [ ] **Step 5: Delete `dumpPark`'s copy machinery**

The fresh SoT now already lives at `parkDir/run.db`, so `dumpPark` never needs to copy. In `src/cli/park.ts`, simplify `dumpPark` (`park.ts:104-136`) to fold WAL + write the transcript sidecar in place:
```ts
export function dumpPark(db: Database, _dbPath: string, slug: string, ident: string, park: ParkInfo): string {
  const dir = parkDir(slug, ident);
  mkdirSync(dir, { recursive: true });
  db.exec("PRAGMA wal_checkpoint(TRUNCATE);"); // fold WAL into the single run.db before close
  db.close();
  writeFileSync(
    join(dir, "transcript.json"),
    JSON.stringify({
      dispatchId: park.dispatchId,
      cause: park.cause,
      resetAt: park.resetAt,
      transcript: park.transcript,
    }),
  );
  return dir;
}
```
Delete `priorRunIdAt` (`park.ts:79-96`) and drop the now-unused imports (`copyFileSync`, `Database`-for-readonly-open if unused elsewhere, `getRun` if unused elsewhere — verify with the compiler/lint). `finishRunResult` (`park.ts:58-72`) is unchanged (it still calls `dumpPark` for `parked`; `_dbPath` kept for signature stability with its one caller).

- [ ] **Step 6: Remove the obsolete overwrite-warning test**

`test/cli/dump-park-warning.test.ts` asserts the `overwriting parked run …` stderr line that only the deleted copy path produced. Delete the file:
```bash
git rm test/cli/dump-park-warning.test.ts
```

- [ ] **Step 7: Run tests to verify GREEN**

Run: `bun test test/cli/run-live-location.test.ts test/cli/park.test.ts test/cli/park-resume-e2e.test.ts && bun run lint`
Expected: PASS. The new test sees `dbPath === parkDir/run.db`; the second run rejects with the refuse-guard message; resume-e2e still resumes (its dump now IS the live file — `dbPath === destPath`, which the old copy already skipped).

- [ ] **Step 8: Full suite + commit**

Run: `bun test && bun run lint`
```bash
git add src/cli/run.ts src/daemon/run-ticket.ts src/cli/park.ts test/helpers/run-harness.ts test/cli/run-live-location.test.ts
git rm test/cli/dump-park-warning.test.ts
git commit -m "feat(run): journal to the live checkpoint dir + refuse-guard + run lock; drop dumpPark copy (ENG-382)"
```

---

### Task 4: `--fresh` flag (refuse-guard escape)

**Files:**
- Modify: `src/cli/run.ts` (add the `--fresh` boolean arg; when set, delete the whole checkpoint dir before the refuse-guard)
- Test: `test/cli/run-live-location.test.ts` (extend)

**Interfaces:**
- Consumes: `rmSync` from `node:fs`; the `checkpointDir` computed in Task 3.
- Produces: `RunArgs.fresh?: boolean`. `--fresh` deletes `checkpointDir` recursively (`run.db` + `-wal` + `-shm` + `transcript.json` + `run.lock`) then proceeds as a fresh run. **ENG-382 scope is the refuse-guard escape ONLY — the resume-gate `--fresh` semantics (reconcile + carry-over) are ENG-385.**

- [ ] **Step 1: Write the failing test** (append to `test/cli/run-live-location.test.ts`)
```ts
test("--fresh discards an existing checkpoint (whole dir) and starts over", async () => {
  const first = await runFreshTicket();
  expect(existsSync(first.dbPath)).toBe(true);
  const second = await runFreshTicket({ reuseStateOf: first, fresh: true }); // must NOT reject
  expect(existsSync(second.dbPath)).toBe(true); // a brand-new checkpoint exists
  // no orphaned -wal from the discarded run reattached:
  expect(existsSync(`${first.dbPath}-wal`)).toBe(false);
  second.cleanup();
});
```
(Extend `runFreshTicket` to thread a `fresh?: boolean` through to the `--fresh` arg.)

- [ ] **Step 2: Run to verify FAIL**

Run: `bun test test/cli/run-live-location.test.ts`
Expected: FAIL — with a checkpoint present, the second run hits the refuse-guard (`--fresh` not wired).

- [ ] **Step 3: Add the `--fresh` arg + whole-dir delete**

In `src/cli/run.ts`: add to the citty `args` block (near `"in-place"`, `run.ts:98-102`):
```ts
    fresh: {
      type: "boolean",
      description: "Discard an existing checkpoint for this ticket and start over",
    },
```
Add `fresh?: boolean;` to `RunArgs` (`run.ts:64-74`). Then, in the Task-3 block, BEFORE the refuse-guard:
```ts
    if (!explicitDb && args.fresh && existsSync(checkpointDir)) {
      rmSync(checkpointDir, { recursive: true, force: true }); // whole dir: run.db + -wal/-shm + sidecars
    }
```
Add `rmSync` to the `node:fs` import. (With the dir gone, the refuse-guard's `existsSync(dbPath)` is false and the run proceeds.)

- [ ] **Step 4: Run to verify GREEN**

Run: `bun test test/cli/run-live-location.test.ts && bun run lint`
Expected: PASS.

- [ ] **Step 5: Full suite + commit**

Run: `bun test && bun run lint`
```bash
git add src/cli/run.ts test/cli/run-live-location.test.ts test/helpers/run-harness.ts
git commit -m "feat(run): --fresh discards an existing checkpoint (whole dir) and restarts (ENG-382)"
```

---

### Task 5: reconcileWorktree pid-liveness upgrade

**Files:**
- Modify: `src/dispatch/worktree.ts:177-207` (add a `checkpointDir?` param; free a non-prunable holder whose owning run is provably dead; gate the recorded-stale force-remove on dead-owner)
- Modify: `src/cli/park.ts:286-296` (pass the resumed ticket's `checkpointDir`)
- Modify: `src/dispatch/worktree.ts:51-59` (ensureWorktree passes no checkpointDir → unchanged prunable-only behaviour)
- Test: `test/dispatch/worktree.test.ts` (extend the reconcile suite)

**Interfaces:**
- Consumes: `runLockStatus` from `src/cli/run-lock.ts` (Task 2).
- Produces: `reconcileWorktree(repoPath, branch, staleWorktreePath, newWorktreePath, checkpointDir?): ReconcileResult`. New rule: a non-prunable holder is freed when `checkpointDir` is given AND `runLockStatus(checkpointDir)` is `null` (no live owner) — i.e. the run that made this worktree is dead. A holder with a LIVE, non-self lock → still refuse. The recorded-stale force-remove is likewise skipped when a different-live lock owns the checkpoint. Absent `checkpointDir` → ENG-381 prunable-only behaviour (unchanged).

- [ ] **Step 1: Write the failing tests** (append to `test/dispatch/worktree.test.ts`, reusing `makeRepo`/`addWorktree`/`freshTarget`/`roots`)
```ts
import { mkdtempSync, writeFileSync } from "node:fs"; // (mkdtempSync already imported; add writeFileSync if absent)

test("reconcileWorktree frees a non-prunable holder whose owning run lock is DEAD (checkpointDir given)", () => {
  const repo = makeRepo();
  const held = addWorktree(repo, "feat/STYRE-50", "deadowner"); // dir exists → not prunable
  const checkpointDir = mkdtempSync(join(tmpdir(), "styre-ckpt-"));
  roots.push(checkpointDir);
  writeFileSync(join(checkpointDir, "run.lock"), "999999999"); // dead pid
  const res = reconcileWorktree(repo, "feat/STYRE-50", undefined, freshTarget(), checkpointDir);
  expect(res.skipped).toBeNull();
  expect(worktreeHoldingBranch(repo, "feat/STYRE-50")).toBeNull(); // freed
});

test("reconcileWorktree still REFUSES a non-prunable holder whose owning run lock is ALIVE (not us)", () => {
  const repo = makeRepo();
  const held = addWorktree(repo, "feat/STYRE-51", "liveowner");
  const checkpointDir = mkdtempSync(join(tmpdir(), "styre-ckpt-"));
  roots.push(checkpointDir);
  writeFileSync(join(checkpointDir, "run.lock"), String(process.ppid)); // a live, non-self pid
  expect(() =>
    reconcileWorktree(repo, "feat/STYRE-51", undefined, freshTarget(), checkpointDir),
  ).toThrow(/checked out at/);
  expect(existsSync(join(held, "README.md"))).toBe(true); // not force-removed
});
```

- [ ] **Step 2: Run to verify FAIL**

Run: `bun test test/dispatch/worktree.test.ts`
Expected: FAIL — the 5th param is ignored today, so the dead-owner case refuses instead of freeing (`res` undefined / throw).

- [ ] **Step 3: Implement the pid-liveness gate**

In `src/dispatch/worktree.ts`, import `runLockStatus` (`import { runLockStatus } from "../cli/run-lock.ts";`). Change the signature (`worktree.ts:177-182`) to add `checkpointDir?: string`. Replace the prunable-only refuse block (`worktree.ts:196-205`) so a non-prunable holder is also freed when its owning run is dead:
```ts
  const prunableHolder = worktreeHoldingBranch(repoPath, branch);
  if (prunableHolder?.prunable) freed.push(prunableHolder.path);
  git(["worktree", "prune"], repoPath);
  const holder = worktreeHoldingBranch(repoPath, branch);
  if (holder !== null && !holder.prunable) {
    // Non-prunable (working dir present). Free it ONLY if we can prove the run that made it is dead
    // (its checkpoint lock is absent/stale). A live, non-self owner → refuse (never destroy live work).
    const ownerAlive = checkpointDir !== undefined && runLockStatus(checkpointDir) !== null;
    if (checkpointDir === undefined || ownerAlive) {
      throw new Error(
        `branch ${branch} is checked out at ${holder.path} by a worktree styre can't safely remove; ` +
          `free it with 'git worktree remove ${holder.path}', then re-run.`,
      );
    }
    removeWorktree(repoPath, holder.path); // owner is provably dead → safe to force-remove
    git(["worktree", "prune"], repoPath);
    freed.push(holder.path);
  }
  return { freed, skipped: null };
```
Gate the recorded-stale force-remove (`worktree.ts:187-194`) too — wrap it so it is skipped when a DIFFERENT live owner holds the checkpoint:
```ts
  const foreignLive =
    checkpointDir !== undefined &&
    (() => {
      const s = runLockStatus(checkpointDir);
      return s !== null && !s.self;
    })();
  if (staleWorktreePath !== undefined && !foreignLive) {
    try {
      removeWorktree(repoPath, staleWorktreePath);
      freed.push(staleWorktreePath);
    } catch {
      // already gone / never registered — the prune below clears any dangling ref
    }
  }
```
(On a normal resume the resuming process holds the lock → `self` is true → `foreignLive` false → the recorded stale path is freed as before. Only a concurrent DIFFERENT live run blocks it.)

- [ ] **Step 4: park.ts passes the checkpointDir**

In `src/cli/park.ts`, at the reconcile call (`park.ts:290`), pass the resumed ticket's checkpoint dir (the resume already computes `dir = parkDir(profile.slug, args.resume)` at `park.ts:200`):
```ts
  if (!inPlace && staleWorktreePath) {
    reconcileWorktree(project.target_repo, branch, staleWorktreePath, targetWorktreePath, dir);
  }
```
`ensureWorktree`'s call (`worktree.ts:57`) stays 4-arg (no `checkpointDir`) → prunable-only, unchanged.

- [ ] **Step 5: Run to verify GREEN + all ENG-381 reconcile tests stay green**

Run: `bun test test/dispatch/worktree.test.ts test/cli/park-resume-e2e.test.ts && bun run lint`
Expected: PASS — the two new cases plus the existing ENG-381 reconcile suite (prunable recovery, live refusal, locked/main refusal, ReconcileResult).

- [ ] **Step 6: Full suite + commit**

Run: `bun test && bun run lint`
```bash
git add src/dispatch/worktree.ts src/cli/park.ts test/dispatch/worktree.test.ts
git commit -m "feat(worktree): reconcile frees a dead-owner worktree via the run lock; gate recorded-stale force-remove (ENG-382)"
```

---

## Self-Review

**Spec coverage (ENG-382 ticket + design §6/§7 ticket 2):**
- Live-location journaling to `parkDir/run.db` → Task 3. ✓
- Per-ticket lock → Task 2 (+ wired in Task 3). ✓
- Refuse-guard on `run.db` presence → Task 3. ✓
- `--fresh` whole-dir delete → Task 4. ✓
- Find-or-create inserts → Task 1. ✓
- Delete `dumpPark` copy machinery → Task 3 Step 5. ✓
- reconcile prunable→pid-liveness + gated recorded-stale → Task 5. ✓
- Keep ENG-381 reconcile tests green → Task 5 Step 5. ✓
- AC "crash leaves a resumable checkpoint" — implied by live-location (the SoT is already at `parkDir`); an explicit crash test is deferred to the ENG-385 resume-gate suite (noted as residual).

**Placeholder scan:** every code step carries real code; test steps carry real assertions. The one soft spot is the `runFreshTicket` harness helper (Task 3 Step 1) — it is specified by behaviour + the exact `runParkedTicket` pattern it mirrors, but its body is not fully transcribed; the implementer must write it against `run-harness.ts`. Flagged, not hidden.

**Type consistency:** `RunLock`/`runLockStatus`/`acquireRunLock`/`releaseRunLock` names are used identically in Tasks 2, 3, 5. `checkpointDir?: string` is the added reconcile param in Task 5; `ingested?: IngestedTicket` the added runTicket dep in Task 3. `getBySlug`/`getByIdent` consistent across Tasks 1 and (potentially) elsewhere.

## Residual open questions (for the plan review)

1. **Concurrency of the refuse-guard vs the lock.** The refuse-guard (checkpoint exists → refuse) already blocks the common "run the same ticket twice" case; the lock is the belt-and-suspenders for a true race (two runs between the `existsSync` check and the first write). Is the lock worth its complexity in ENG-382, or could it be deferred? (Design §6a says required; I kept it.)
2. **`runFreshTicket` harness reuse.** Whether to generalize `runParkedTicket` (which forces a session-limit park) into a shared driver with a terminal-outcome knob, vs. a separate helper. Left to the implementer; either is fine.
3. **`_dbPath` param of `dumpPark`/`finishRunResult`** is now vestigial (always equals `parkDir/run.db` for live-location). Kept for signature stability; a follow-up could drop it. Not done here to avoid touching `finishRunResult`'s callers mid-ticket.

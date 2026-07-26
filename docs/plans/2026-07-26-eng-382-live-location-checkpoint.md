# ENG-382: Live-location checkpoint + per-ticket run lock + refuse-guard + find-or-create Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a fresh `styre run` journal its SoT directly to the durable per-ticket checkpoint (`~/.local/state/styre/<slug>/<ident>/run.db`) from the start — so a crash/escalation/block leaves a resumable checkpoint with no orphaned temp DB — guarded by a per-ticket run lock, a refuse-on-existing-checkpoint guard with a `--fresh` escape, and find-or-create DB inserts.

**Architecture:** Today a fresh run journals to a throwaway temp DB (`run.ts:199-202`) and only a `parked` outcome copies it to the checkpoint (`dumpPark`, `park.ts:104-136`); every other halt orphans the temp DB. This plan hoists the ticket→ident resolution ahead of DB creation so the run opens its DB *at* `parkDir(slug, ident)/run.db`, adds a lockfile in the checkpoint dir to prevent two concurrent runs of one ticket, refuses to clobber an existing checkpoint (with `--fresh` to discard it), makes the project/ticket inserts idempotent so re-entry can't UNIQUE-crash, and upgrades ENG-381's prunable-only `reconcileWorktree` gate to free a *styre-owned* worktree whose owning run is provably dead (via the lock). `dumpPark` is **retained** (see Review revision B1).

**Tech Stack:** Bun + TypeScript; `bun:sqlite` (WAL journal mode); biome (`bun run lint`); `bun test`. No new dependencies.

## Review revisions (rev 2, after independent plan review)

- **B1** — `dumpPark`'s copy machinery is **retained**, not deleted. Its `if (dbPath !== destPath)` guard (`park.ts:119`) already skips the copy for live-location runs (`dbPath === destPath`) and keeps it for `--db`/test runs whose SoT lives in a temp DB — `copyFileSync` is the ONLY thing that materializes `run.db` at the checkpoint for them (used by `runParkedTicket`, `run-harness.ts:59-61,128`). The design doc §6's "deletes dumpPark's copy machinery" was an over-simplification; the guarded copy stays. So `_dbPath`/`dbPath` is **not** vestigial.
- **B2** — the reconcile pid-liveness gate adds a **styre-ownership** check (a holder is freed only when a live lock is absent AND the path is under a `styre-wt-*` root); a human's foreign worktree (no lock, non-styre path) is refused, never force-removed.
- **S1** — `runImpl` gains `ports?`/`runner?` test seams so the shipped fresh-path (refuse-guard, lock, journaling) is tested against real code, not a duplicated harness body.
- **S2** — `acquireRunLock` is an atomic `O_EXCL` (`flag: "wx"`) create with stale-reclaim.
- **S3** — hoisting `fetchTicket` moves a tracker-read failure ahead of `runStarted` — an intentional, flagged ordering change.
- **N4** — get-or-create returns the existing id and does not update columns on conflict (documented).

## Global Constraints

- Every task ends `bun run lint` + `bun test` green.
- No new runtime dependencies; use `node:fs` primitives already imported in the touched files.
- Follow existing repo patterns: repo helpers are plain functions taking `db: Database`; tests use real temp git repos + `makeTestDb`/`gitRepoWithProject` and override `XDG_STATE_HOME` to redirect the state dir.
- `--db <path>` stays a full test/override escape: when set, it bypasses live-location journaling, the refuse-guard, and the lock (the caller manages the DB). `dumpPark` still copies such a run's temp DB to the checkpoint on park.
- Preserve the ENG-381 reconcile invariant: a live / foreign / non-styre-owned worktree is NEVER force-removed.
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

- [ ] **Step 3: Add the natural-key reader + get-or-create in `project.ts`**

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
  // Get-or-create: returns the EXISTING row's id and does NOT update target_repo/default_branch on
  // conflict. Defense-in-depth for --db reuse; a genuine two-repos-same-slug collision is kept, not
  // surfaced (a minor divergence from design §6b's "surface" wording; slug is frozen at setup so a
  // real collision is not expected).
  const existing = getBySlug(db, p.slug);
  if (existing !== null) return existing.id;
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
Change `insertTicket` (`ticket.ts:22-62`) — add at the top of the body, before `const now = nowUtc();`:
```ts
  // Get-or-create on (project_id, ident): returns the existing id; does NOT update title/description
  // on conflict. (Same defense-in-depth rationale as insertProject.)
  const existing = getByIdent(db, t.projectId, t.ident);
  if (existing !== null) return existing.id;
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

### Task 2: Per-ticket run lock (atomic)

**Files:**
- Create: `src/cli/run-lock.ts`
- Test: `test/cli/run-lock.test.ts` (create)

**Interfaces:**
- Consumes: `node:fs` (`existsSync`, `readFileSync`, `writeFileSync` with `flag: "wx"`, `mkdirSync`, `rmSync`); the `process.kill(pid, 0)` liveness idiom (mirrors `recover.ts:38`).
- Produces:
  - `type RunLock = { dir: string; pid: number }`
  - `runLockStatus(dir: string): { pid: number; self: boolean } | null` — null when the lock is absent OR its pid is dead (stale); `self=true` when held by THIS process. (Used by reconcile in Task 5.)
  - `acquireRunLock(dir: string): RunLock | null` — **atomic** `O_EXCL` create of `dir/run.lock` with `process.pid`; returns `null` when a LIVE lock is already held by another process; a stale (dead-pid) lock is reclaimed.
  - `releaseRunLock(lock: RunLock): void` — removes `dir/run.lock` iff it still holds `lock.pid`.

- [ ] **Step 1: Write the failing test**

Create `test/cli/run-lock.test.ts`:
```ts
import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireRunLock, releaseRunLock, runLockStatus } from "../../src/cli/run-lock.ts";

const tmp = () => mkdtempSync(join(tmpdir(), "styre-lock-"));

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

test("a stale (dead-pid) lock is reclaimed by acquire", () => {
  const dir = tmp();
  writeFileSync(join(dir, "run.lock"), "999999999"); // a pid that cannot be alive
  expect(runLockStatus(dir)).toBeNull(); // dead → stale → null
  const lock = acquireRunLock(dir); // reclaims the stale lock
  expect(lock?.pid).toBe(process.pid);
  rmSync(dir, { recursive: true, force: true });
});

test("acquire returns null when a LIVE lock is held by a different pid", () => {
  const dir = tmp();
  writeFileSync(join(dir, "run.lock"), String(process.ppid)); // parent pid: alive, not us
  expect(acquireRunLock(dir)).toBeNull();
  expect(runLockStatus(dir)?.self).toBe(false);
  rmSync(dir, { recursive: true, force: true });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/cli/run-lock.test.ts`
Expected: FAIL — module `src/cli/run-lock.ts` does not exist.

- [ ] **Step 3: Write the implementation (atomic acquire)**

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

/** The lock's live owner, or null when the lock is absent OR its pid is dead/malformed (stale). */
export function runLockStatus(dir: string): { pid: number; self: boolean } | null {
  const file = join(dir, "run.lock");
  if (!existsSync(file)) return null;
  const pid = Number.parseInt(readFileSync(file, "utf8").trim(), 10);
  if (!Number.isInteger(pid) || !isAlive(pid)) return null;
  return { pid, self: pid === process.pid };
}

/** Take the per-ticket run lock in `dir` via an atomic O_EXCL create. On collision: reclaim a stale
 *  (dead-pid) lock and retry; return null when a LIVE lock is held by another process. */
export function acquireRunLock(dir: string): RunLock | null {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "run.lock");
  for (;;) {
    try {
      writeFileSync(file, String(process.pid), { flag: "wx" }); // O_EXCL — fails if it already exists
      return { dir, pid: process.pid };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      const pid = Number.parseInt(readFileSync(file, "utf8").trim(), 10);
      if (Number.isInteger(pid) && isAlive(pid)) return null; // a live owner → the ticket is locked
      rmSync(file, { force: true }); // stale (dead/malformed) → reclaim and retry the exclusive create
    }
  }
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
git commit -m "feat(cli): atomic per-ticket run lock (O_EXCL, stale-reclaim) (ENG-382)"
```

---

### Task 3: Live-location checkpoint + ident-ordering + refuse-guard (+ runImpl test seam)

**Files:**
- Modify: `src/daemon/run-ticket.ts:140-172` (accept a pre-fetched `ingested` to avoid a double tracker fetch)
- Modify: `src/cli/run.ts:107-224` (`runImpl` gains `ports?`/`runner?` seams; resolve ident before DB creation; journal to `parkDir`; refuse-guard; acquire/release lock; pass `ingested`)
- Modify: `test/helpers/run-harness.ts` (add `runFreshTicket` that drives the REAL `runImpl`)
- Test: `test/cli/run-live-location.test.ts` (create)
- **Do NOT touch `park.ts`/`dumpPark` in this task** (Review revision B1 — the copy is retained).

**Interfaces:**
- Consumes: `parkDir` (`park.ts:75-77`), `acquireRunLock`/`releaseRunLock` (Task 2), `insertProject`/`insertTicket` find-or-create (Task 1), `IngestedTicket` (`src/integrations/ticket-source.ts:6`), `makeProjectorPorts`, `resolveAgentRunner`.
- Produces:
  - `runTicket` deps gain `ingested?: IngestedTicket` — when present, `runTicket` skips its own `fetchTicket`.
  - `runImpl` deps gain `ports?: ProjectorPorts` and `runner?: AgentRunner` (types imported from their existing modules) — used when provided, else built as today. Fresh runs write `run.db` at `parkDir(profile.slug, ingested.ident)`.

**Decision — ident-ordering (design decision #1):** `ident` is only known after `fetchTicket`. Hoist that single tracker read into `run.ts` (still exactly ONE `fetchTicket` per run; we move it earlier and pass the result down). **S3 note:** this moves a tracker-read failure to *before* `a.runStarted(...)` fires (`run.ts:226-231`) — an intentional, flagged ordering change; the run simply fails earlier with a `cliError`. Broader telemetry-outcome semantics are ENG-384 scope.

- [ ] **Step 1: Write the failing test**

Create `test/cli/run-live-location.test.ts`. It drives the REAL `runImpl` (via the new seam) with a fake tracker + fake runner, `XDG_STATE_HOME` redirected, and asserts the SoT lives at `parkDir` and that a second run refuses. Use the new `runFreshTicket` harness helper.
```ts
import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { parkDir } from "../../src/cli/park.ts";
import { runFreshTicket } from "../helpers/run-harness.ts";

test("a fresh run journals its SoT to parkDir/run.db, not a temp dir", async () => {
  const run = await runFreshTicket(); // drives real runImpl to a terminal; returns { checkpointDir, dbPath, cleanup }
  expect(run.dbPath).toBe(join(parkDir("test-project", "ENG-1"), "run.db"));
  expect(existsSync(run.dbPath)).toBe(true);
  run.cleanup();
});

test("a second fresh run on an existing checkpoint refuses (usage error), does not clobber", async () => {
  const first = await runFreshTicket();
  await expect(runFreshTicket({ reuseStateOf: first })).rejects.toThrow(/checkpoint already exists|--fresh/i);
  first.cleanup();
});
```
Add `runFreshTicket(opts?)` to `test/helpers/run-harness.ts`. Unlike `runParkedTicket` (which drives `driveToTerminal` directly to force a park), `runFreshTicket` calls the **real** `runImpl({ args }, { ports, runner })`: set `XDG_STATE_HOME` to a temp dir, build a real git repo + profile (reuse `gitRepoWithProject`/`gitRepo` helpers), construct fake `ports` (a fake `issueTracker.fetchTicket` returning `ident: "ENG-1"` + a fake `forge`) and a `FakeAgentRunner` that drives to a non-parked terminal, then invoke `runImpl({ args: { ticket: "ENG-1", slug: "test-project", … } }, { ports, runner })`. Return `{ checkpointDir: parkDir("test-project","ENG-1"), dbPath: join(checkpointDir,"run.db"), cleanup }`. `reuseStateOf` points `XDG_STATE_HOME` at a prior run's state dir so the refuse-guard sees the existing checkpoint.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/cli/run-live-location.test.ts`
Expected: FAIL — `runFreshTicket` unexported; `runImpl` has no `ports`/`runner` seam; the fresh path still mints a temp DB so `dbPath` is under `styre-run-*`.

- [ ] **Step 3: `runTicket` accepts a pre-fetched `ingested`**

In `src/daemon/run-ticket.ts`, add `import type { IngestedTicket } from "../integrations/ticket-source.ts";` and add `ingested?: IngestedTicket;` to the deps object type (`run-ticket.ts:140-148`). Change line 149:
```ts
  const ingested = deps.ingested ?? (await deps.ports.issueTracker.fetchTicket(deps.ticketRef));
```
(Downstream `insertProject`/`insertTicket` using `ingested.*` are unchanged.)

- [ ] **Step 4: `runImpl` — add seams; resolve ident first; journal to parkDir; refuse-guard; lock**

In `src/cli/run.ts`:
- Extend the seam (`run.ts:107-110`):
```ts
export async function runImpl(
  { args }: { args: RunArgs },
  deps?: { analyticsClient?: AnalyticsClient; ports?: ProjectorPorts; runner?: AgentRunner },
): Promise<void> {
```
  (Import `AgentRunner` from its module; `ProjectorPorts` is already imported.)
- Replace the block at `run.ts:199-224` (temp-DB mint → registry) with:
```ts
    // Ports first (no DB dependency), then the single tracker read so we know the ident BEFORE
    // creating the DB — the SoT must live at the durable checkpoint from the first write.
    const ports = deps?.ports ?? makeProjectorPorts(runtimeConfig, profile);
    const ingested = await ports.issueTracker.fetchTicket(args.ticket);
    const ident = ingested.ident;

    const explicitDb = !!(args.db && args.db.length > 0);
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
      if (getRun(db) === null) {
        insertRun(db, { runId: randomUUID(), startedAt: nowUtc(), provider: agentConfig.provider });
      }
      const runner = deps?.runner ?? resolveAgentRunner(agentConfig);
      const registry = buildDispatchRegistry({
        runner,
        agentConfig,
        profile,
        worktreeRoot: mkdtempSync(join(tmpdir(), "styre-wt-")),
        inPlace: (args["in-place"] as boolean | undefined) ?? false,
      });
      a.runStarted({ /* unchanged, run.ts:226-231 */ });
      const out = await runTicket({ db, profile, runtimeConfig, ports, registry, ticketRef: args.ticket, ingested, emit: stdoutSink });
      // ... unchanged: runCompleted (run.ts:243-253), summary + parked-hint (run.ts:255-266),
      //     finishRunResult(db, dbPath, profile.slug, ident, out) (run.ts:267) ...
    } finally {
      if (lock) releaseRunLock(lock);
    }
```
Notes for the implementer:
- The `ports` at `run.ts:207` is now hoisted above the DB block; delete the old duplicate.
- Keep the run-identity guard, `runStarted`, `runCompleted`, the parked-hint block, and `finishRunResult` — moved inside the `try`, lock released in `finally`.
- Add `ingested,` to the `runTicket({...})` call so `fetchTicket` runs exactly once.
- Add imports to `run.ts`: `existsSync`, `mkdirSync` from `node:fs`; `acquireRunLock`, `releaseRunLock` from `./run-lock.ts`; `AgentRunner` from its module. `parkDir`, `usageError`, `mkdtempSync`, `tmpdir`, `join` are already imported.
- Remove the old temp-DB `mkdtempSync(join(tmpdir(), "styre-run-"))`; those imports remain used by `worktreeRoot`.

- [ ] **Step 5: `dumpPark` is UNCHANGED (do not delete anything)**

Confirm `src/cli/park.ts` `dumpPark` (`park.ts:104-136`), `priorRunIdAt` (`park.ts:79-96`), the `Database` import, `getRun`, `copyFileSync`, and `test/cli/dump-park-warning.test.ts` are all left intact. The existing `if (dbPath !== destPath)` guard (`park.ts:119`) is exactly what makes this correct: for a live-location run `dbPath === parkDir/run.db === destPath` so the copy is skipped (the SoT is already there); for a `--db`/harness run `dbPath` is a temp file so the copy still materializes `run.db` at the checkpoint. **No park.ts change in this ticket.** (Design §6's "deletes dumpPark's copy machinery" was an over-simplification — the guarded copy is retained.)

- [ ] **Step 6: Run tests to verify GREEN**

Run: `bun test test/cli/run-live-location.test.ts test/cli/park.test.ts test/cli/park-resume-e2e.test.ts test/cli/dump-park-warning.test.ts && bun run lint`
Expected: PASS. The new test sees `dbPath === parkDir/run.db`; the second run rejects with the refuse-guard message; `park-resume-e2e` and `dump-park-warning` stay green because `dumpPark`'s temp→checkpoint copy is untouched.

- [ ] **Step 7: Full suite + commit**

Run: `bun test && bun run lint`
```bash
git add src/cli/run.ts src/daemon/run-ticket.ts test/helpers/run-harness.ts test/cli/run-live-location.test.ts
git commit -m "feat(run): journal to the live checkpoint dir + refuse-guard + run lock + runImpl test seams (ENG-382)"
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
  expect(existsSync(second.dbPath)).toBe(true);
  expect(existsSync(`${first.dbPath}-wal`)).toBe(false); // no orphaned -wal reattaches
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
Add `rmSync` to the `node:fs` import.

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

### Task 5: reconcileWorktree pid-liveness + styre-ownership upgrade

**Files:**
- Modify: `src/dispatch/worktree.ts:177-207` (add a `checkpointDir?` param; free a non-prunable holder only when it is styre-owned AND no live run owns it; gate the recorded-stale force-remove on no-different-live-owner)
- Modify: `src/cli/park.ts:290` (pass the resumed ticket's `checkpointDir`)
- Test: `test/dispatch/worktree.test.ts` (extend the reconcile suite)

**Interfaces:**
- Consumes: `runLockStatus` from `src/cli/run-lock.ts` (Task 2).
- Produces: `reconcileWorktree(repoPath, branch, staleWorktreePath, newWorktreePath, checkpointDir?): ReconcileResult`.

**Gate rule for a NON-prunable holder (Review revision B2):**
- If a DIFFERENT live run owns the ticket (`runLockStatus(checkpointDir)` alive and not self) → **refuse** the whole reconcile (concurrent live run — touch nothing).
- Else if `checkpointDir` is undefined → **refuse** (no lock context to prove staleness — ENG-381 prunable-only behaviour).
- Else if the holder's path is styre-owned (contains `/styre-wt-` — worktree roots are `mkdtempSync(tmpdir(),"styre-wt-")`) → **free** it (a stale styre leftover, no live owner).
- Else (a human's `git worktree add`, non-styre path) → **refuse**, never force-remove.
The same different-live-owner check also gates the recorded-stale force-remove.

- [ ] **Step 1: Write the failing tests** (append to `test/dispatch/worktree.test.ts`; add `writeFileSync` to the `node:fs` import if absent)
```ts
test("reconcile frees a styre-owned non-prunable holder when the owning run lock is DEAD", () => {
  const repo = makeRepo();
  addWorktree(repo, "feat/STYRE-50", "deadowner"); // path under styre-wt-*, dir exists → not prunable
  const ckpt = mkdtempSync(join(tmpdir(), "styre-ckpt-"));
  roots.push(ckpt);
  writeFileSync(join(ckpt, "run.lock"), "999999999"); // dead pid → stale
  const res = reconcileWorktree(repo, "feat/STYRE-50", undefined, freshTarget(), ckpt);
  expect(res.skipped).toBeNull();
  expect(worktreeHoldingBranch(repo, "feat/STYRE-50")).toBeNull(); // freed
});

test("reconcile REFUSES a holder when a DIFFERENT live run owns the ticket lock", () => {
  const repo = makeRepo();
  const held = addWorktree(repo, "feat/STYRE-51", "liveowner");
  const ckpt = mkdtempSync(join(tmpdir(), "styre-ckpt-"));
  roots.push(ckpt);
  writeFileSync(join(ckpt, "run.lock"), String(process.ppid)); // alive, not us
  expect(() => reconcileWorktree(repo, "feat/STYRE-51", undefined, freshTarget(), ckpt)).toThrow(
    /checked out at/,
  );
  expect(existsSync(join(held, "README.md"))).toBe(true); // not force-removed
});

test("reconcile REFUSES a FOREIGN (non-styre-wt) non-prunable holder even with a checkpointDir + no lock", () => {
  const repo = makeRepo();
  const dir = mkdtempSync(join(tmpdir(), "human-wt-")); // NOT under styre-wt-*
  roots.push(dir);
  const wt = join(dir, "held");
  Bun.spawnSync(["git", "worktree", "add", "-b", "feat/HUMAN-1", wt], { cwd: repo });
  const ckpt = mkdtempSync(join(tmpdir(), "styre-ckpt-"));
  roots.push(ckpt); // no run.lock → no owner
  expect(() => reconcileWorktree(repo, "feat/HUMAN-1", undefined, freshTarget(), ckpt)).toThrow(
    /checked out at/,
  );
  expect(existsSync(join(wt, "README.md"))).toBe(true); // a human worktree is never force-removed
});
```

- [ ] **Step 2: Run to verify FAIL**

Run: `bun test test/dispatch/worktree.test.ts`
Expected: FAIL — the 5th param is ignored today; the dead-owner case refuses (should free). The existing ENG-381 4-arg refuse tests must stay green.

- [ ] **Step 3: Implement the gate**

In `src/dispatch/worktree.ts`: `import { runLockStatus } from "../cli/run-lock.ts";`. Add `checkpointDir?: string` to the signature (`worktree.ts:177-182`). Replace the recorded-stale removal + refuse block (`worktree.ts:187-205`) with:
```ts
  // A DIFFERENT live run owning this ticket's checkpoint means we must touch nothing.
  const foreignLive = (() => {
    if (checkpointDir === undefined) return false;
    const s = runLockStatus(checkpointDir);
    return s !== null && !s.self;
  })();

  if (staleWorktreePath !== undefined && !foreignLive) {
    try {
      removeWorktree(repoPath, staleWorktreePath); // the ticket's own recorded prior worktree
      freed.push(staleWorktreePath);
    } catch {
      // already gone / never registered — the prune below clears any dangling ref
    }
  }

  const prunableHolder = worktreeHoldingBranch(repoPath, branch);
  if (prunableHolder?.prunable) freed.push(prunableHolder.path);
  git(["worktree", "prune"], repoPath);

  const holder = worktreeHoldingBranch(repoPath, branch);
  if (holder !== null && !holder.prunable) {
    // Free ONLY a styre-owned leftover with no live owner. A concurrent live run, an unknown lock
    // context, or a human's own `git worktree add` (non-styre path) → refuse, never force-remove.
    const styreOwned = holder.path.includes("/styre-wt-");
    if (foreignLive || checkpointDir === undefined || !styreOwned) {
      throw new Error(
        `branch ${branch} is checked out at ${holder.path} by a worktree styre can't safely remove; ` +
          `free it with 'git worktree remove ${holder.path}', then re-run.`,
      );
    }
    removeWorktree(repoPath, holder.path);
    git(["worktree", "prune"], repoPath);
    freed.push(holder.path);
  }
  return { freed, skipped: null };
```

- [ ] **Step 4: park.ts passes the checkpointDir**

In `src/cli/park.ts`, at the reconcile call (`park.ts:290`), pass the resumed ticket's checkpoint dir (`dir = parkDir(profile.slug, args.resume)`, already computed at `park.ts:200`):
```ts
  if (!inPlace && staleWorktreePath) {
    reconcileWorktree(project.target_repo, branch, staleWorktreePath, targetWorktreePath, dir);
  }
```
`ensureWorktree`'s call (`worktree.ts:57`) stays 4-arg (no `checkpointDir`) → refuses non-prunable holders exactly as ENG-381 did.

- [ ] **Step 5: Run to verify GREEN + all ENG-381 reconcile tests stay green**

Run: `bun test test/dispatch/worktree.test.ts test/cli/park-resume-e2e.test.ts && bun run lint`
Expected: PASS — the three new cases plus the existing ENG-381 reconcile suite (the 4-arg refuse cases stay green because `checkpointDir` is undefined → refuse; prunable recovery unaffected).

- [ ] **Step 6: Full suite + commit**

Run: `bun test && bun run lint`
```bash
git add src/dispatch/worktree.ts src/cli/park.ts test/dispatch/worktree.test.ts
git commit -m "feat(worktree): reconcile frees a dead-owner styre worktree via the run lock; refuse foreign/live (ENG-382)"
```

---

## Self-Review

**Spec coverage (ENG-382 ticket + design §6/§7 ticket 2):**
- Live-location journaling to `parkDir/run.db` → Task 3. ✓
- Per-ticket lock (atomic) → Task 2 (+ wired in Task 3). ✓
- Refuse-guard on `run.db` presence → Task 3. ✓
- `--fresh` whole-dir delete → Task 4. ✓
- Find-or-create inserts → Task 1. ✓
- `dumpPark` copy machinery → **retained** (B1); the guarded copy serves `--db`/harness runs, skipped for live-location. ✓
- reconcile prunable→pid-liveness + styre-ownership + gated recorded-stale → Task 5. ✓
- Keep ENG-381 reconcile tests green → Task 5 Step 5 (4-arg calls → `checkpointDir` undefined → refuse). ✓
- AC "crash leaves a resumable checkpoint" — implied by live-location (the SoT is already at `parkDir`); an explicit crash-then-resume test belongs to the ENG-385 resume-gate suite (noted).

**Placeholder scan:** every code step carries real code; the fresh-path is tested against the REAL `runImpl` via the `ports`/`runner` seam (S1), so no duplicated-harness gap remains. The one authored-by-implementer piece is `runFreshTicket`'s body — specified by its exact inputs (real `runImpl`, fake `ports`/`runner`, `XDG_STATE_HOME`, `reuseStateOf`), grounded in the existing `run-harness.ts`/`gitRepoWithProject` helpers.

**Type consistency:** `RunLock`/`runLockStatus`/`acquireRunLock`/`releaseRunLock` used identically in Tasks 2, 3, 5. `checkpointDir?: string` is the added reconcile param (Task 5). `ingested?: IngestedTicket` (runTicket) and `ports?`/`runner?` (runImpl) are the added seams (Task 3). `getBySlug`/`getByIdent` consistent across Task 1 and their callers.

## Residual open questions — all resolved

- **Q1 (lock worth its complexity?)** — RESOLVED: the lock is load-bearing for Task 5's B2 gate (it's how reconcile proves a worktree's owning run is dead vs. a concurrent live run). It stays.
- **Q2 (harness duplication?)** — RESOLVED by S1: `runImpl` gains `ports`/`runner` seams and `runFreshTicket` drives the real `runImpl`, so the shipped fresh-path is tested directly (no duplicated driver).
- **Q3 (`_dbPath`/`dbPath` vestigial?)** — RESOLVED by B1: `dumpPark` is retained and still uses `dbPath` (the `dbPath !== destPath` copy guard), so the parameter is load-bearing, not vestigial.

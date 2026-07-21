# Telemetry: run identity + cost truth — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the telemetry NDJSON export honest and correlatable — stop reporting unknown cost as `$0`, populate the dead `duration_ms` column, and give every run a stable `run_id` (plus provider + timestamps) — in one `SCHEMA_VERSION 1→2` bump.

**Architecture:** Add a single-row `run` table as the run-identity substrate (SoT). The emitter reads it once (lazily, cached) and stamps `run_id`/`provider` onto every NDJSON row. `buildSummary` replaces its lossy `null→0` sum with a floor-sum-plus-per-field-coverage contract (unknown ≠ zero). `duration_ms` is computed centrally in `completeDispatch`. Emit-path zod validation is non-fatal.

**Tech Stack:** TypeScript on Bun, `bun:sqlite`, zod. Tests: `bun test`. Lint: `bun run lint`.

**Design spec:** `docs/brainstorms/2026-07-21-telemetry-run-identity-and-cost-truth-design.md` (read §2 Decisions + §7 review resolutions).

## Global Constraints

- **Never commit to `main`.** Work is on `feat/eng-339-349-telemetry-wire-v2` (already checked out in this worktree). PR only; no auto-merge.
- **`src/db/schema.sql` and `docs/architecture/schema.sql` MUST stay byte-identical** (CLAUDE.md). Every schema edit is applied to *both*.
- **Timestamps are UTC ISO-8601** via `nowUtc()` from `src/util/time.ts` (DS-1). Never `Date.now()` for stored/wire timestamps except for computing a duration delta.
- **Only the runner writes the SoT** (B2). All new writes (`run` row) are on the runner/resume path.
- **`stdout` is NDJSON telemetry only; `stderr` is human output** (CLAUDE.md stream contract). Diagnostics go to `stderr`.
- **Telemetry is best-effort/lossy (§5.3)** — the emit path must never throw on the live wire.
- Run everything from the worktree root: `/Users/rajatgoyal/code/styre/.claude/worktrees/eng-339-349-telemetry`.
- After each task: `bun test` and `bun run lint` must be green before commit.

---

## File Structure

**Create:**
- `src/db/repos/run.ts` — the `run` table repo: `RunRow`, `insertRun`, `getRun`, `ensureRunTable`, `markResumed`.
- `docs/architecture/telemetry-export.md` — the field-by-field wire spec (ENG-349 AC).

**Modify:**
- `src/db/schema.sql` + `docs/architecture/schema.sql` — add `run` table; bump `schema_meta` to 8.
- `src/db/repos/dispatch.ts` — `completeDispatch` computes `duration_ms`; widen `DispatchRow`/`COLS` with forensic fields.
- `src/db/repos/event-log.ts` — widen `EventLogRow`/`COLS` with `dispatch_id` (nullable; populated later).
- `src/telemetry/events.ts` — `SCHEMA_VERSION = 2`; nullable aggregates + `usage_coverage`; new fields on all events.
- `src/telemetry/emitter.ts` — floor-sum+coverage `buildSummary`; run-context injection; restored fields; timestamps.
- `src/telemetry/emit.ts` — non-fatal `safeParse` in `stdoutSink`.
- `src/cli/run.ts` — insert the `run` row on fresh run.
- `src/cli/park.ts` — `ensureRunTable`+read/backfill+`markResumed` on resume; dumpPark overwrite warning.
- `test/helpers/db.ts` — seed a `run` row in `makeTestDb`.
- `CLAUDE.md` + `docs/architecture/build-operations.md` — table count 16→17; §5 references the wire spec.

**Test:**
- `test/db/run.test.ts` (new) — run repo + ensureRunTable.
- `test/db/dispatch-duration.test.ts` (new) — central duration.
- `test/telemetry/emitter.test.ts` (extend) — cost truth, coverage, identity, timestamps, forensic fields.
- `test/telemetry/emit-validation.test.ts` (new) — non-fatal sink validation.

---

## Task 1: `duration_ms` computed centrally in `completeDispatch` (ENG-339)

Self-contained: `duration_ms` is already `z.number().nullable()` on the wire; it's just never populated. Fix at the single writer.

**Files:**
- Modify: `src/db/repos/dispatch.ts:111-146` (`completeDispatch`)
- Test: `test/db/dispatch-duration.test.ts` (create)

**Interfaces:**
- Produces: `completeDispatch` now sets `duration_ms = Date.parse(endedAt) − Date.parse(started_at)` when `durationMs` is not passed and both timestamps exist. Signature unchanged.

- [ ] **Step 1: Write the failing test**

Create `test/db/dispatch-duration.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { completeDispatch, insertDispatch } from "../../src/db/repos/dispatch.ts";
import { getByDispatchId } from "../../src/db/repos/dispatch.ts";
import { makeTestDb } from "../helpers/db.ts";

describe("completeDispatch duration_ms", () => {
  test("computes duration_ms from started_at and ended_at when not passed", () => {
    const { db, ticketId } = makeTestDb();
    insertDispatch(db, {
      ticketId,
      dispatchId: "ENG-1-d0001",
      seq: 1,
      startedAt: "2026-07-16T00:00:00.000Z",
    });
    const row = getByDispatchId(db, ticketId, "ENG-1-d0001")!;
    completeDispatch(db, row.id, {
      outcome: "clean-success",
      endedAt: "2026-07-16T00:00:12.500Z",
    });
    const done = getByDispatchId(db, ticketId, "ENG-1-d0001")!;
    expect(done.duration_ms).toBe(12500);
    db.close();
  });

  test("leaves duration_ms null when started_at is absent", () => {
    const { db, ticketId } = makeTestDb();
    insertDispatch(db, { ticketId, dispatchId: "ENG-1-d0002", seq: 2 });
    const row = getByDispatchId(db, ticketId, "ENG-1-d0002")!;
    completeDispatch(db, row.id, { outcome: "parked", endedAt: "2026-07-16T00:00:01.000Z" });
    expect(getByDispatchId(db, ticketId, "ENG-1-d0002")!.duration_ms).toBeNull();
    db.close();
  });

  test("an explicitly passed durationMs wins", () => {
    const { db, ticketId } = makeTestDb();
    insertDispatch(db, {
      ticketId,
      dispatchId: "ENG-1-d0003",
      seq: 3,
      startedAt: "2026-07-16T00:00:00.000Z",
    });
    const row = getByDispatchId(db, ticketId, "ENG-1-d0003")!;
    completeDispatch(db, row.id, {
      outcome: "clean-success",
      endedAt: "2026-07-16T00:00:10.000Z",
      durationMs: 999,
    });
    expect(getByDispatchId(db, ticketId, "ENG-1-d0003")!.duration_ms).toBe(999);
    db.close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/db/dispatch-duration.test.ts`
Expected: FAIL — first test gets `duration_ms` null (currently never computed), expected 12500.

- [ ] **Step 3: Implement central computation in `completeDispatch`**

In `src/db/repos/dispatch.ts`, inside `completeDispatch` (before the `UPDATE` query at line 127), compute the duration. Replace the body start so it reads:

```ts
export function completeDispatch(
  db: Database,
  id: number,
  p: {
    outcome: string;
    branchHeadSha?: string | null;
    endedAt?: string | null;
    durationMs?: number | null;
    tokensIn?: number | null;
    tokensOut?: number | null;
    cacheRead?: number | null;
    cacheCreate?: number | null;
    costUsd?: number | null;
    partial?: number;
  },
): void {
  // duration_ms is computed here — at the single writer — so every completed row carries it,
  // not just the call sites a caller remembered to pass it (ENG-339: it was a dead column).
  let durationMs = p.durationMs ?? null;
  if (durationMs === null && p.endedAt) {
    const started = db
      .query<{ started_at: string | null }, [number]>(
        "SELECT started_at FROM dispatch WHERE id = ?",
      )
      .get(id)?.started_at;
    if (started) durationMs = Date.parse(p.endedAt) - Date.parse(started);
  }
  db.query(
    `UPDATE dispatch
       SET outcome = $outcome, branch_head_sha = $sha, ended_at = $ended, duration_ms = $dur,
           tokens_in = $tin, tokens_out = $tout, cache_read = $cr, cache_create = $cc,
           cost_usd = $cost, partial = $partial
     WHERE id = $id`,
  ).run({
    $outcome: p.outcome,
    $sha: p.branchHeadSha ?? null,
    $ended: p.endedAt ?? null,
    $dur: durationMs,
    $tin: p.tokensIn ?? null,
    $tout: p.tokensOut ?? null,
    $cr: p.cacheRead ?? null,
    $cc: p.cacheCreate ?? null,
    $cost: p.costUsd ?? null,
    $partial: p.partial ?? 0,
    $id: id,
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/db/dispatch-duration.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Full suite + lint, then commit**

Run: `bun test && bun run lint`
Expected: green.

```bash
git add src/db/repos/dispatch.ts test/db/dispatch-duration.test.ts
git commit -m "fix(telemetry): compute duration_ms centrally in completeDispatch (ENG-339)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_015wsu2fhwp4o3wmJ6K5jj71"
```

---

## Task 2: `run` table + repo + schema bump + test-substrate seed (ENG-349 substrate)

**Files:**
- Modify: `src/db/schema.sql` (add table after `projection_outbox`, before the `-- §X DEFERRED` block at ~line 516; bump `schema_meta` INSERT 7→8)
- Modify: `docs/architecture/schema.sql` (byte-identical mirror of the same edits)
- Create: `src/db/repos/run.ts`
- Modify: `test/helpers/db.ts` (seed a `run` row)
- Modify: `CLAUDE.md`, `docs/architecture/build-operations.md` (16→17 table count)
- Test: `test/db/run.test.ts` (create)

**Interfaces:**
- Produces:
  - `interface RunRow { id: number; run_id: string; started_at: string; provider: string; resumed: number; attempt: number; }`
  - `insertRun(db, p: { runId: string; startedAt: string; provider: string }): RunRow`
  - `getRun(db): RunRow | null` — the single run row (there is one per DB).
  - `ensureRunTable(db): void` — `CREATE TABLE IF NOT EXISTS run (...)` for the pre-upgrade-park bridge.
  - `markResumed(db): void` — sets `resumed=1`, `attempt = attempt + 1` on the single row.

- [ ] **Step 1: Add the `run` table to BOTH schema files**

In `src/db/schema.sql`, immediately **after** the `projection_outbox` table (ends near line 490, before the `-- §X  DEFERRED` comment block at line 516), insert:

```sql
-- ----------------------------------------------------------------------------
-- run — per-invocation identity (ENG-349). Exactly one row per ephemeral run DB.
-- The telemetry export stamps run_id/provider/started_at onto every emitted row so a
-- consumer can correlate rows and tell two runs of the same ticket apart. ticket_id is a
-- run-local rowid and is NOT a cross-run key. NOTE: the CREATE below is mirrored verbatim
-- in src/db/repos/run.ts (ensureRunTable) as the pre-upgrade-park resume bridge — keep them
-- identical (schema.sql remains the source of truth).
-- ----------------------------------------------------------------------------
CREATE TABLE run (
    id          INTEGER PRIMARY KEY,
    run_id      TEXT    NOT NULL,               -- UUIDv4, minted at fresh-run start
    started_at  TEXT    NOT NULL,               -- run wall-clock start (UTC ISO-8601)
    provider    TEXT    NOT NULL,               -- run-level agent provider ('claude'|'codex'|…)
    resumed     INTEGER NOT NULL DEFAULT 0 CHECK (resumed IN (0,1)),
    attempt     INTEGER NOT NULL DEFAULT 1
);
```

Then bump the `schema_meta` INSERT (schema.sql:53-55) from version 7 to 8:

```sql
INSERT INTO schema_meta (version, applied_at, note)
VALUES (8, strftime('%Y-%m-%dT%H:%M:%SZ','now'),
        'v8: add run table for telemetry run identity (ENG-349)');
```

Apply the **exact same two edits** to `docs/architecture/schema.sql`.

- [ ] **Step 2: Verify the two schema files are still byte-identical**

Run: `diff -q src/db/schema.sql docs/architecture/schema.sql && grep -c '^CREATE TABLE' src/db/schema.sql`
Expected: no diff output; count prints `17`.

- [ ] **Step 3: Write the failing repo test**

Create `test/db/run.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { ensureRunTable, getRun, insertRun, markResumed } from "../../src/db/repos/run.ts";
import { makeTestDb } from "../helpers/db.ts";

describe("run repo", () => {
  test("insertRun + getRun roundtrip", () => {
    const { db } = makeTestDb();
    // makeTestDb already seeds a run row (Step 7); read it back.
    const seeded = getRun(db);
    expect(seeded).not.toBeNull();
    expect(typeof seeded!.run_id).toBe("string");
    expect(seeded!.attempt).toBe(1);
    expect(seeded!.resumed).toBe(0);
    db.close();
  });

  test("markResumed sets resumed and bumps attempt", () => {
    const { db } = makeTestDb();
    markResumed(db);
    const r = getRun(db)!;
    expect(r.resumed).toBe(1);
    expect(r.attempt).toBe(2);
    db.close();
  });

  test("ensureRunTable creates the table when missing (pre-upgrade park bridge)", () => {
    const { db } = makeTestDb();
    db.exec("DROP TABLE run;"); // simulate a pre-upgrade DB
    expect(() => getRun(db)).toThrow(); // no table
    ensureRunTable(db);
    expect(getRun(db)).toBeNull(); // table exists, no row yet
    insertRun(db, { runId: "backfill-id", startedAt: "2026-07-21T00:00:00.000Z", provider: "claude" });
    expect(getRun(db)!.run_id).toBe("backfill-id");
    db.close();
  });
});
```

- [ ] **Step 4: Run test to verify it fails**

Run: `bun test test/db/run.test.ts`
Expected: FAIL — `run.ts` module does not exist.

- [ ] **Step 5: Create the repo `src/db/repos/run.ts`**

```ts
import type { Database } from "bun:sqlite";

export interface RunRow {
  id: number;
  run_id: string;
  started_at: string;
  provider: string;
  resumed: number;
  attempt: number;
}

const COLS = "id, run_id, started_at, provider, resumed, attempt";

/** CREATE TABLE IF NOT EXISTS run — mirrors the definition in schema.sql verbatim. This exists
 *  only as the pre-upgrade-park resume bridge: migrate() is replay-once, so a DB bootstrapped
 *  before this table existed never gains it on resume. Keep identical to schema.sql. */
export function ensureRunTable(db: Database): void {
  db.exec(
    `CREATE TABLE IF NOT EXISTS run (
       id          INTEGER PRIMARY KEY,
       run_id      TEXT    NOT NULL,
       started_at  TEXT    NOT NULL,
       provider    TEXT    NOT NULL,
       resumed     INTEGER NOT NULL DEFAULT 0 CHECK (resumed IN (0,1)),
       attempt     INTEGER NOT NULL DEFAULT 1
     )`,
  );
}

/** The single run row for this DB (there is exactly one per ephemeral run DB), or null. */
export function getRun(db: Database): RunRow | null {
  return db.query<RunRow, []>(`SELECT ${COLS} FROM run ORDER BY id LIMIT 1`).get() ?? null;
}

export function insertRun(
  db: Database,
  p: { runId: string; startedAt: string; provider: string },
): RunRow {
  db.query(
    "INSERT INTO run (run_id, started_at, provider) VALUES ($rid, $started, $prov)",
  ).run({ $rid: p.runId, $started: p.startedAt, $prov: p.provider });
  const created = getRun(db);
  if (!created) throw new Error("insertRun: row missing after insert");
  return created;
}

/** Mark the run as resumed and bump its attempt counter (same logical run, new attempt). */
export function markResumed(db: Database): void {
  db.query("UPDATE run SET resumed = 1, attempt = attempt + 1").run();
}
```

- [ ] **Step 6: Seed a `run` row in the test substrate**

In `test/helpers/db.ts`, import the run repo and seed a row in the `seedTicket` branch so the emitter's run-identity invariant (Task 6) is satisfied in every telemetry test. Change the seeding block (lines 28-32):

```ts
import { insertRun } from "../../src/db/repos/run.ts";
import { nowUtc } from "../../src/util/time.ts";
// ...
  if (seedTicket) {
    const projectId = insertProject(db, { slug: "test-project", targetRepo: "/tmp/repo" });
    const ticketId = insertTicket(db, { projectId, ident: "ENG-1" });
    insertRun(db, { runId: "test-run-0001", startedAt: nowUtc(), provider: "claude" });
    return { db, projectId, ticketId };
  }
```

- [ ] **Step 7: Run test to verify it passes**

Run: `bun test test/db/run.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 8: Update the table-count references in docs**

In `CLAUDE.md`, find "**16 `CREATE TABLE` statements**" (in the `schema.sql` bullet) and change `16` → `17`, updating the parenthetical to note `run` is now a live table. In `docs/architecture/build-operations.md`, update any "16 tables" count the same way (grep: `grep -rn "16" docs/architecture/build-operations.md | grep -i table`).

- [ ] **Step 9: Full suite + lint, then commit**

Run: `bun test && bun run lint`
Expected: green (existing telemetry tests still pass — they now have a seeded run row but the emitter doesn't yet read it).

```bash
git add src/db/schema.sql docs/architecture/schema.sql src/db/repos/run.ts test/db/run.test.ts test/helpers/db.ts CLAUDE.md docs/architecture/build-operations.md
git commit -m "feat(telemetry): add run table for per-invocation identity (ENG-349)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_015wsu2fhwp4o3wmJ6K5jj71"
```

---

## Task 3: Mint the run row on fresh run + resume; dumpPark warning (ENG-349)

**Files:**
- Modify: `src/cli/run.ts:170-172` (insert run row after `openDb`+`recover`)
- Modify: `src/cli/park.ts:81-97` (`dumpPark` overwrite warning), `:179-181` (`ensureRunTable`+backfill+`markResumed` on resume)
- Test: covered by the repo test (Task 2) + a `dumpPark`-warning unit test below. The run.ts/park.ts wiring itself is integration-level; the extracted warning helper is unit-tested.

**Interfaces:**
- Consumes: `insertRun`, `getRun`, `ensureRunTable`, `markResumed` (Task 2); `crypto.randomUUID()`; `nowUtc()`; `agentConfig.provider`.

- [ ] **Step 1: Insert the run row on a fresh run**

In `src/cli/run.ts`, after `const db = openDb(dbPath);` + `recover(db, realRecoverDeps());` (lines 171-172) and after `agentConfig` is resolved (line 175), insert the run row. Move/ensure `agentConfig` is available, then add:

```ts
import { randomUUID } from "node:crypto";
import { insertRun } from "../db/repos/run.ts";
// ...after recover(db, realRecoverDeps()); and agentConfig resolution:
insertRun(db, {
  runId: randomUUID(),
  startedAt: nowUtc(),
  provider: (runtimeConfig.agent ?? DEFAULT_AGENT_CONFIG).provider,
});
```

(`nowUtc` and `DEFAULT_AGENT_CONFIG` are already imported in `run.ts`; if not, add the imports.)

- [ ] **Step 2: On resume, ensure the table, backfill if pre-upgrade, mark resumed**

In `src/cli/park.ts` `resumeRun`, after `const db = openDb(dbPath);` (line 180) and before `onlyTicketId(db)`, add:

```ts
import { ensureRunTable, getRun, insertRun, markResumed } from "../db/repos/run.ts";
import { randomUUID } from "node:crypto";
// ...after const db = openDb(dbPath);
ensureRunTable(db); // pre-upgrade parks (v1) have no run table; migrate() won't add it
if (getRun(db) === null) {
  // Pre-upgrade park: no identity was ever minted — assign a fresh one for the resumed portion.
  insertRun(db, {
    runId: randomUUID(),
    startedAt: nowUtc(),
    provider: (runtimeConfig.agent ?? DEFAULT_AGENT_CONFIG).provider,
  });
}
markResumed(db); // same logical run for a v2 park; resumed=1, attempt++
```

(`nowUtc` and `DEFAULT_AGENT_CONFIG` are already imported in `park.ts`.)

- [ ] **Step 3: Write the failing dumpPark-warning test**

Create `test/cli/dump-park-warning.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { priorRunIdAt } from "../../src/cli/park.ts";
import { ensureRunTable, insertRun } from "../../src/db/repos/run.ts";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function dbWithRun(runId: string): string {
  const path = join(mkdtempSync(join(tmpdir(), "dp-")), "run.db");
  const db = new Database(path);
  ensureRunTable(db);
  insertRun(db, { runId, startedAt: "2026-07-21T00:00:00.000Z", provider: "claude" });
  db.close();
  return path;
}

describe("priorRunIdAt", () => {
  test("returns the run_id of an existing dump", () => {
    expect(priorRunIdAt(dbWithRun("run-A"))).toBe("run-A");
  });
  test("returns null for a missing file", () => {
    expect(priorRunIdAt(join(tmpdir(), "does-not-exist.db"))).toBeNull();
  });
  test("returns null for a pre-upgrade dump with no run table", () => {
    const path = join(mkdtempSync(join(tmpdir(), "dp-")), "run.db");
    const db = new Database(path);
    db.exec("CREATE TABLE ticket (id INTEGER PRIMARY KEY);"); // no run table
    db.close();
    expect(priorRunIdAt(path)).toBeNull();
  });
});
```

- [ ] **Step 4: Run test to verify it fails**

Run: `bun test test/cli/dump-park-warning.test.ts`
Expected: FAIL — `priorRunIdAt` is not exported.

- [ ] **Step 5: Implement `priorRunIdAt` + wire the warning into `dumpPark`**

In `src/cli/park.ts`, add an exported helper and call it in `dumpPark` before the overwrite copy. Add near the top-level helpers:

```ts
import { existsSync } from "node:fs"; // already imported
import { Database } from "bun:sqlite";

/** Best-effort read of the run_id in an existing dump's run.db. Returns null if the file is
 *  absent or the dump predates the run table (pre-upgrade) — never throws. */
export function priorRunIdAt(destPath: string): string | null {
  if (!existsSync(destPath)) return null;
  try {
    const db = new Database(destPath, { readonly: true });
    try {
      return db.query<{ run_id: string }, []>("SELECT run_id FROM run ORDER BY id LIMIT 1").get()
        ?.run_id ?? null;
    } finally {
      db.close();
    }
  } catch {
    return null; // no run table / unreadable → treat as no prior id
  }
}
```

In `dumpPark`, before `copyFileSync(dbPath, destPath)` (line 96), warn on a differing id. The current run's id is read from the live `db` (still open here — `dumpPark` closes it at line 91 via `db.close()`; read BEFORE that close). Adjust `dumpPark` so it captures the current run_id before closing:

```ts
export function dumpPark(db, dbPath, slug, ident, park): string {
  const dir = parkDir(slug, ident);
  mkdirSync(dir, { recursive: true });
  const currentRunId = getRun(db)?.run_id ?? null; // read before we close db
  db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
  db.close();
  const destPath = join(dir, "run.db");
  if (dbPath !== destPath) {
    const prior = priorRunIdAt(destPath);
    if (prior !== null && currentRunId !== null && prior !== currentRunId) {
      process.stderr.write(
        `overwriting parked run ${prior} with ${currentRunId} for ${ident}\n`,
      );
    }
    copyFileSync(dbPath, destPath);
  }
  // ...unchanged transcript.json write + return dir
}
```

Add `import { getRun } from "../db/repos/run.ts";` if not already present.

- [ ] **Step 6: Run test to verify it passes**

Run: `bun test test/cli/dump-park-warning.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 7: Full suite + lint, then commit**

Run: `bun test && bun run lint`
Expected: green.

```bash
git add src/cli/run.ts src/cli/park.ts test/cli/dump-park-warning.test.ts
git commit -m "feat(telemetry): mint run_id on run/resume; warn on park overwrite (ENG-349)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_015wsu2fhwp4o3wmJ6K5jj71"
```

---

## Task 4: Widen `DispatchRow` (forensic fields) + `EventLogRow` (`dispatch_id`)

The dispatch forensic columns exist in `schema.sql:234-244` but are omitted from the repo row; `event_log.dispatch_id` exists but is omitted (and unpopulated — emitted as null for now, see spec §3.3).

**Files:**
- Modify: `src/db/repos/dispatch.ts:4-32` (`DispatchRow` + `COLS`)
- Modify: `src/db/repos/event-log.ts:7-24` (`EventLogRow` + `COLS`)
- Test: `test/db/row-widen.test.ts` (create)

**Interfaces:**
- Produces: `DispatchRow` gains `trigger: string | null`, `exit_code: number | null`, `effort: string | null`, `predecessor_dispatch_id: string | null`. `EventLogRow` gains `dispatch_id: string | null`.

- [ ] **Step 1: Write the failing test**

Create `test/db/row-widen.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { insertDispatch, listByTicket as listDispatches } from "../../src/db/repos/dispatch.ts";
import { appendEvent, listByTicket as listEvents } from "../../src/db/repos/event-log.ts";
import { makeTestDb } from "../helpers/db.ts";

describe("row widening", () => {
  test("DispatchRow carries forensic fields (null when unset)", () => {
    const { db, ticketId } = makeTestDb();
    insertDispatch(db, { ticketId, dispatchId: "ENG-1-d0001", seq: 1 });
    const row = listDispatches(db, ticketId)[0];
    expect(row).toHaveProperty("trigger");
    expect(row).toHaveProperty("exit_code");
    expect(row).toHaveProperty("effort");
    expect(row).toHaveProperty("predecessor_dispatch_id");
    expect(row.trigger).toBeNull();
    db.close();
  });

  test("EventLogRow carries dispatch_id (null until populated)", () => {
    const { db, ticketId } = makeTestDb();
    appendEvent(db, { ticketId, kind: "note", reason: "x" });
    const ev = listEvents(db, ticketId)[0];
    expect(ev).toHaveProperty("dispatch_id");
    expect(ev.dispatch_id).toBeNull();
    db.close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/db/row-widen.test.ts`
Expected: FAIL — rows lack the properties (they aren't in `COLS`).

- [ ] **Step 3: Widen `DispatchRow` + `COLS`**

In `src/db/repos/dispatch.ts`, add to the `DispatchRow` interface (after `step_id`, matching schema order — `trigger`/`effort`/`exit_code`/`predecessor_dispatch_id` per schema.sql:233-244):

```ts
  predecessor_dispatch_id: string | null;
  effort: string | null;
  trigger: string | null;
  exit_code: number | null;
```

And extend `COLS` (line 29-32) to include them:

```ts
const COLS =
  "id, ticket_id, work_unit_id, step_id, dispatch_id, seq, predecessor_dispatch_id, stage, kind, " +
  "model, effort, trigger, outcome, exit_code, branch_head_sha, worktree_path, started_at, " +
  "ended_at, duration_ms, tokens_in, tokens_out, cache_read, cache_create, cost_usd, partial, created_at";
```

- [ ] **Step 4: Widen `EventLogRow` + `COLS`**

In `src/db/repos/event-log.ts`, add to the `EventLogRow` interface (after `ticket_id`):

```ts
  dispatch_id: string | null;
```

And extend `COLS` (line 23-24) to include it:

```ts
const COLS =
  "id, ticket_id, dispatch_id, seq, kind, actor, from_stage, to_stage, loop, route_to, signature, reason, payload_json, created_at";
```

(`appendEvent`'s INSERT is unchanged — `dispatch_id` stays NULL until a follow-up ticket populates it. The SELECT now surfaces whatever the column holds.)

- [ ] **Step 5: Run test to verify it passes**

Run: `bun test test/db/row-widen.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 6: Full suite + lint, then commit**

Run: `bun test && bun run lint`
Expected: green.

```bash
git add src/db/repos/dispatch.ts src/db/repos/event-log.ts test/db/row-widen.test.ts
git commit -m "feat(telemetry): surface dispatch forensic fields + event dispatch_id in repo rows (ENG-349)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_015wsu2fhwp4o3wmJ6K5jj71"
```

---

## Task 5: `SCHEMA_VERSION → 2` + the v2 wire schema (events.ts)

**Files:**
- Modify: `src/telemetry/events.ts`
- Test: `test/telemetry/events-schema.test.ts` (create)

**Interfaces:**
- Produces (the v2 `TelemetryEvent` union): every member gains `run_id: string`. `SummaryEvent` aggregates become `z.number().nullable()`; adds `provider: string`, `started_at: string`, `ended_at: string`, and `usage_coverage: { dispatch_count, cost_usd, tokens_in, tokens_out, cache_read, cache_create }` (all `z.number()`). `DispatchEvent` adds `provider: string`, `trigger`/`effort`/`predecessor_dispatch_id` (`z.string().nullable()`), `exit_code` (`z.number().nullable()`). `EventEvent` adds `dispatch_id: z.string().nullable()`.

- [ ] **Step 1: Write the failing test**

Create `test/telemetry/events-schema.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { SCHEMA_VERSION, TelemetryEventSchema } from "../../src/telemetry/events.ts";

describe("v2 wire schema", () => {
  test("SCHEMA_VERSION is 2", () => {
    expect(SCHEMA_VERSION).toBe(2);
  });

  test("summary accepts null cost_usd + usage_coverage + identity", () => {
    const summary = {
      schema_version: 2, type: "summary", run_id: "r1", ticket_id: 1, ident: "ENG-1",
      provider: "codex", started_at: "2026-07-21T00:00:00Z", ended_at: "2026-07-21T00:01:00Z",
      outcome: "pr-ready", stage: "merge", status: "done", ticks: 3,
      cost_usd: null, tokens_in: 100, tokens_out: 50, cache_read: null, cache_create: null,
      usage_coverage: { dispatch_count: 2, cost_usd: 0, tokens_in: 2, tokens_out: 2, cache_read: 0, cache_create: 0 },
      dispatch_count: 2, dispatch_outcomes: { "clean-success": 2 },
      cycle_count: 0, escalation_count: 0, escalation_reasons: [],
    };
    expect(TelemetryEventSchema.parse(summary)).toMatchObject({ cost_usd: null });
  });

  test("dispatch carries run_id + provider + forensic fields", () => {
    const d = {
      schema_version: 2, type: "dispatch", run_id: "r1", dispatch_id: "ENG-1-d0001",
      ticket_id: 1, work_unit_id: null, seq: 1, stage: "implement", kind: null,
      model: "claude-opus-4-8", provider: "claude", trigger: "transition", effort: null,
      exit_code: 0, predecessor_dispatch_id: null, outcome: "clean-success",
      branch_head_sha: "abc", started_at: "t0", ended_at: "t1", duration_ms: 12,
      tokens_in: 1, tokens_out: 1, cache_read: null, cache_create: null, cost_usd: 0.5,
    };
    expect(TelemetryEventSchema.parse(d)).toMatchObject({ provider: "claude" });
  });

  test("event carries run_id + nullable dispatch_id", () => {
    const e = {
      schema_version: 2, type: "event", run_id: "r1", ticket_id: 1, dispatch_id: null,
      seq: 1, kind: "note", actor: "runner", from_stage: null, to_stage: null,
      loop: null, route_to: null, signature: null, reason: "x", created_at: "t0",
    };
    expect(TelemetryEventSchema.parse(e)).toMatchObject({ dispatch_id: null });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/telemetry/events-schema.test.ts`
Expected: FAIL — `SCHEMA_VERSION` is 1; new fields rejected.

- [ ] **Step 3: Edit `src/telemetry/events.ts`**

Bump the version (line 4):

```ts
export const SCHEMA_VERSION = 2;
```

Add `run_id: z.string()` to **every** event object (`EventEvent`, `DispatchEvent`, `SignalEvent`, `SummaryEvent`, `CiHandoffEvent`) — place it right after `type`.

In `EventEvent`, add after `ticket_id`:

```ts
  dispatch_id: z.string().nullable(),
```

In `DispatchEvent`, add after `model`:

```ts
  provider: z.string(),
  trigger: z.string().nullable(),
  effort: z.string().nullable(),
  exit_code: z.number().nullable(),
  predecessor_dispatch_id: z.string().nullable(),
```

In `SummaryEvent`, add after `ticks`:

```ts
  provider: z.string(),
  started_at: z.string(),
  ended_at: z.string(),
```

Change the five aggregate lines in `SummaryEvent` to nullable and add the coverage object:

```ts
  cost_usd: z.number().nullable(),
  tokens_in: z.number().nullable(),
  tokens_out: z.number().nullable(),
  cache_read: z.number().nullable(),
  cache_create: z.number().nullable(),
  usage_coverage: z.object({
    dispatch_count: z.number(),
    cost_usd: z.number(),
    tokens_in: z.number(),
    tokens_out: z.number(),
    cache_read: z.number(),
    cache_create: z.number(),
  }),
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/telemetry/events-schema.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Note — the emitter suite is now RED (expected)**

Run: `bun test test/telemetry/emitter.test.ts`
Expected: FAIL — the emitter (`emitter.ts`) doesn't yet produce the new fields; TypeScript will also flag `toEvent`/`toDispatch`/`buildSummary` returning objects missing `run_id` etc. This is fixed in Task 6. **Do not commit a red suite** — proceed directly to Task 6 and commit them together.

---

## Task 6: Emitter — floor-sum+coverage, run-context injection, restored fields

**Files:**
- Modify: `src/telemetry/emitter.ts`
- Test: `test/telemetry/emitter.test.ts` (extend)

**Interfaces:**
- Consumes: `getRun` (Task 2); the v2 schema (Task 5); widened rows (Task 4).
- Produces: `buildSummary` returns a valid v2 `summary` with nullable aggregates + `usage_coverage` + identity/provider/timestamps. The emitter throws a clear error if `getRun(db)` is null (D9 invariant).

- [ ] **Step 1: Write the failing tests (extend `emitter.test.ts`)**

Add to `test/telemetry/emitter.test.ts`:

```ts
import { getRun } from "../../src/db/repos/run.ts";
// existing imports: buildSummary, insertDispatch, completeDispatch, makeTestDb, etc.

test("no dispatch reports cost => cost_usd is null, not 0 (ENG-339)", () => {
  const { db, ticketId } = makeTestDb();
  // two dispatches, neither reports cost (codex-style)
  for (const [i, did] of [[1, "ENG-1-d0001"], [2, "ENG-1-d0002"]] as const) {
    insertDispatch(db, { ticketId, dispatchId: did, seq: i, startedAt: "t0" });
    const row = getByDispatchId(db, ticketId, did)!;
    completeDispatch(db, row.id, { outcome: "clean-success", endedAt: "t1", tokensIn: 10 });
  }
  const s = buildSummary(db, ticketId, { outcome: "pr-ready", stage: "merge", status: "done", iterations: 1 } as any);
  expect(s).toMatchObject({ type: "summary" });
  // @ts-expect-error narrow
  expect(s.cost_usd).toBeNull();
  // @ts-expect-error narrow
  expect(s.usage_coverage.cost_usd).toBe(0);
  // @ts-expect-error narrow
  expect(s.tokens_in).toBe(20); // both reported tokens
  // @ts-expect-error narrow
  expect(s.usage_coverage.tokens_in).toBe(2);
  db.close();
});

test("mixed cost => floor sum + partial coverage", () => {
  const { db, ticketId } = makeTestDb();
  insertDispatch(db, { ticketId, dispatchId: "ENG-1-d0001", seq: 1, startedAt: "t0" });
  completeDispatch(db, getByDispatchId(db, ticketId, "ENG-1-d0001")!.id, {
    outcome: "clean-success", endedAt: "t1", costUsd: 0.4,
  });
  insertDispatch(db, { ticketId, dispatchId: "ENG-1-d0002", seq: 2, startedAt: "t0" });
  completeDispatch(db, getByDispatchId(db, ticketId, "ENG-1-d0002")!.id, {
    outcome: "clean-success", endedAt: "t1", costUsd: null,
  });
  const s: any = buildSummary(db, ticketId, { outcome: "pr-ready", stage: "merge", status: "done", iterations: 1 } as any);
  expect(s.cost_usd).toBeCloseTo(0.4); // floor
  expect(s.usage_coverage.cost_usd).toBe(1);
  expect(s.usage_coverage.dispatch_count).toBe(2);
  db.close();
});

test("summary carries run_id, provider, timestamps", () => {
  const { db, ticketId } = makeTestDb();
  const s: any = buildSummary(db, ticketId, { outcome: "pr-ready", stage: "merge", status: "done", iterations: 1 } as any);
  expect(s.run_id).toBe(getRun(db)!.run_id);
  expect(s.provider).toBe("claude");
  expect(typeof s.started_at).toBe("string");
  expect(typeof s.ended_at).toBe("string");
  db.close();
});

test("buildSummary throws when no run row (D9 invariant)", () => {
  const { db, ticketId } = makeTestDb();
  db.exec("DELETE FROM run;");
  expect(() => buildSummary(db, ticketId, { outcome: "pr-ready", stage: "merge", status: "done", iterations: 1 } as any)).toThrow();
  db.close();
});
```

(Ensure `getByDispatchId` is imported in the test file.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test test/telemetry/emitter.test.ts`
Expected: FAIL — old `buildSummary` returns non-null `cost_usd: 0`, no `usage_coverage`, no `run_id`.

- [ ] **Step 3: Rewrite the emitter internals**

In `src/telemetry/emitter.ts`:

Add imports:

```ts
import { getRun } from "../db/repos/run.ts";
```

Add a run-context type + reader near the top:

```ts
type RunCtx = { runId: string; provider: string; startedAt: string };

/** Read the single run row; a missing row is an invariant violation (D9) — the runner always
 *  inserts it at start and resume backfills it, so null here means a broken caller, not a "0". */
function runCtx(db: Database): RunCtx {
  const r = getRun(db);
  if (!r) throw new Error("telemetry: no run row — run identity is required (see ENG-349 design D9)");
  return { runId: r.run_id, provider: r.provider, startedAt: r.started_at };
}

/** Sum of reported (non-null) values; null iff none reported. `reported` is the coverage count. */
function aggregate(ns: Array<number | null>): { value: number | null; reported: number } {
  const present = ns.filter((n): n is number => n !== null);
  return { value: present.length === 0 ? null : present.reduce((a, n) => a + n, 0), reported: present.length };
}
```

Change `toEvent`, `toDispatch`, `toSignal` to take `ctx: RunCtx` and stamp the fields:

```ts
function toEvent(r: EventLogRow, ctx: RunCtx): TelemetryEvent {
  return {
    schema_version: SCHEMA_VERSION,
    type: "event",
    run_id: ctx.runId,
    ticket_id: r.ticket_id,
    dispatch_id: r.dispatch_id,
    seq: r.seq,
    kind: r.kind,
    actor: r.actor,
    from_stage: r.from_stage,
    to_stage: r.to_stage,
    loop: r.loop,
    route_to: r.route_to,
    signature: r.signature,
    reason: r.reason,
    payload_json: r.payload_json,
    created_at: r.created_at,
  };
}

function toDispatch(r: DispatchRow, ctx: RunCtx): TelemetryEvent {
  return {
    schema_version: SCHEMA_VERSION,
    type: "dispatch",
    run_id: ctx.runId,
    dispatch_id: r.dispatch_id,
    ticket_id: r.ticket_id,
    work_unit_id: r.work_unit_id,
    seq: r.seq,
    stage: r.stage,
    kind: r.kind,
    model: r.model,
    provider: ctx.provider,
    trigger: r.trigger,
    effort: r.effort,
    exit_code: r.exit_code,
    predecessor_dispatch_id: r.predecessor_dispatch_id,
    outcome: r.outcome,
    branch_head_sha: r.branch_head_sha,
    started_at: r.started_at,
    ended_at: r.ended_at,
    duration_ms: r.duration_ms,
    tokens_in: r.tokens_in,
    tokens_out: r.tokens_out,
    cache_read: r.cache_read,
    cache_create: r.cache_create,
    cost_usd: r.cost_usd,
  };
}

function toSignal(r: GroundTruthSignalRow, ctx: RunCtx): TelemetryEvent {
  return {
    schema_version: SCHEMA_VERSION,
    type: "signal",
    run_id: ctx.runId,
    id: r.id,
    ticket_id: r.ticket_id,
    work_unit_id: r.work_unit_id,
    signal_type: r.signal_type,
    result: r.result,
    command: r.command,
    branch_head_sha: r.branch_head_sha,
    measured_at: r.measured_at,
  };
}
```

Rewrite `buildSummary` (replace the `sum` helper + the aggregate lines):

```ts
export function buildSummary(db: Database, ticketId: number, result: RunResult): TelemetryEvent {
  const ctx = runCtx(db);
  const ticket = getTicket(db, ticketId);
  const events = listEvents(db, ticketId);
  const dispatches = listDispatches(db, ticketId);
  const cost = aggregate(dispatches.map((d) => d.cost_usd));
  const tin = aggregate(dispatches.map((d) => d.tokens_in));
  const tout = aggregate(dispatches.map((d) => d.tokens_out));
  const cr = aggregate(dispatches.map((d) => d.cache_read));
  const cc = aggregate(dispatches.map((d) => d.cache_create));
  const dispatch_outcomes: Record<string, number> = {};
  for (const d of dispatches) {
    if (d.outcome) dispatch_outcomes[d.outcome] = (dispatch_outcomes[d.outcome] ?? 0) + 1;
  }
  const escalations = events.filter((e) => e.kind === "escalated");
  return {
    schema_version: SCHEMA_VERSION,
    type: "summary",
    run_id: ctx.runId,
    ticket_id: ticketId,
    ident: ticket?.ident ?? "",
    provider: ctx.provider,
    started_at: ctx.startedAt,
    ended_at: nowUtc(),
    outcome: result.outcome,
    stage: result.stage,
    status: result.status,
    ticks: result.iterations,
    cost_usd: cost.value,
    tokens_in: tin.value,
    tokens_out: tout.value,
    cache_read: cr.value,
    cache_create: cc.value,
    usage_coverage: {
      dispatch_count: dispatches.length,
      cost_usd: cost.reported,
      tokens_in: tin.reported,
      tokens_out: tout.reported,
      cache_read: cr.reported,
      cache_create: cc.reported,
    },
    dispatch_count: dispatches.length,
    dispatch_outcomes,
    cycle_count: events.filter((e) => e.kind === "loopback").length,
    escalation_count: escalations.length,
    escalation_reasons: escalations.map((e) => e.reason).filter((r): r is string => r !== null),
  };
}
```

In `createTelemetryEmitter`, compute `ctx` lazily once and pass it to the projections. Change `flushNew` and `emitCiHandoff`:

```ts
  let ctx: RunCtx | null = null;
  const ensureCtx = (db: Database): RunCtx => (ctx ??= runCtx(db));
  return {
    flushNew(db, ticketId) {
      const c = ensureCtx(db);
      for (const r of listEventsSince(db, ticketId, lastEventSeq)) {
        sink(toEvent(r, c));
        lastEventSeq = r.seq;
      }
      for (const d of listDispatchesSince(db, ticketId, lastDispatchId)) {
        lastDispatchId = d.id;
        if (d.ended_at !== null) sink(toDispatch(d, c));
      }
      for (const s of listSignalsSince(db, ticketId, lastSignalId)) {
        sink(toSignal(s, c));
        lastSignalId = s.id;
      }
    },
    emitSummary(db, ticketId, result) {
      sink(buildSummary(db, ticketId, result));
    },
    emitCiHandoff(db, ticketId, h) {
      const c = ensureCtx(db);
      const ticket = getTicket(db, ticketId);
      sink({
        schema_version: SCHEMA_VERSION,
        type: "ci_handoff",
        run_id: c.runId,
        ticket_id: ticketId,
        ident: ticket?.ident ?? "",
        pr_ref: h.prRef,
        pr_url: h.prUrl,
        branch_head_sha: h.sha,
        checks_system: h.checksSystem,
        read: h.read,
        measured_at: nowUtc(),
      });
    },
  };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test test/telemetry/emitter.test.ts`
Expected: PASS (existing + new). Fix any existing assertions that read `summary.cost_usd`/`cache_read` as non-null (they now may be null — where the old test seeded costs, keep them; where it didn't, expect null).

- [ ] **Step 5: Full suite + lint, then commit (Task 5 + 6 together)**

Run: `bun test && bun run lint`
Expected: green.

```bash
git add src/telemetry/events.ts src/telemetry/emitter.ts test/telemetry/events-schema.test.ts test/telemetry/emitter.test.ts
git commit -m "feat(telemetry): SCHEMA_VERSION 2 — cost truth, run identity, provider, timestamps (ENG-339, ENG-349)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_015wsu2fhwp4o3wmJ6K5jj71"
```

---

## Task 7: Non-fatal emit-path validation (`stdoutSink`)

**Files:**
- Modify: `src/telemetry/emit.ts`
- Test: `test/telemetry/emit-validation.test.ts` (create)

**Interfaces:**
- Produces: `stdoutSink` runs `TelemetryEventSchema.safeParse`; on failure writes a `stderr` diagnostic and still emits the row. Never throws.

- [ ] **Step 1: Write the failing test**

Create `test/telemetry/emit-validation.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { stdoutSink } from "../../src/telemetry/emit.ts";

describe("stdoutSink validation (non-fatal)", () => {
  test("does not throw on a malformed event", () => {
    // A structurally-invalid event must not throw on the live wire (best-effort telemetry, §5.3).
    expect(() => stdoutSink({ type: "summary" } as any)).not.toThrow();
  });

  test("emits a valid event without complaint", () => {
    const valid = {
      schema_version: 2, type: "ci_handoff", run_id: "r1", ticket_id: 1, ident: "ENG-1",
      pr_ref: null, pr_url: null, branch_head_sha: null, checks_system: "github",
      read: "not-reported", measured_at: "t0",
    };
    expect(() => stdoutSink(valid as any)).not.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails/behaves**

Run: `bun test test/telemetry/emit-validation.test.ts`
Expected: the first test currently PASSES trivially (no validation yet) — after Step 3 it must still pass AND a stderr diagnostic is written. To make the intent explicit, the implementation adds the diagnostic; the test guards against a future throw.

- [ ] **Step 3: Add non-fatal validation to `stdoutSink`**

Replace `src/telemetry/emit.ts` `stdoutSink`:

```ts
import { type TelemetryEvent, TelemetryEventSchema } from "./events.ts";

/** The OSS↔plane wire form: one JSON object per line on stdout. Validation is non-fatal —
 *  telemetry is best-effort/lossy (§5.3), so a schema-drift bug must never throw here and flip
 *  an otherwise-successful run into a crash. On a validation failure we still emit the row and
 *  write a diagnostic to stderr (human channel; stdout stays pure NDJSON). */
export const stdoutSink: TelemetrySink = (event) => {
  const check = TelemetryEventSchema.safeParse(event);
  if (!check.success) {
    process.stderr.write(
      `telemetry: emitted event failed schema validation: ${check.error.message}\n`,
    );
  }
  process.stdout.write(`${JSON.stringify(event)}\n`);
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/telemetry/emit-validation.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Full suite + lint, then commit**

Run: `bun test && bun run lint`
Expected: green.

```bash
git add src/telemetry/emit.ts test/telemetry/emit-validation.test.ts
git commit -m "feat(telemetry): non-fatal schema validation on the emit path (ENG-349)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_015wsu2fhwp4o3wmJ6K5jj71"
```

---

## Task 8: The wire spec doc + §5 reference

**Files:**
- Create: `docs/architecture/telemetry-export.md`
- Modify: `docs/architecture/build-operations.md` (§5.3 references the new doc)

**Interfaces:** none (docs).

- [ ] **Step 1: Write `docs/architecture/telemetry-export.md`**

Create the field-by-field wire spec. It MUST document: `SCHEMA_VERSION = 2`; every event type (`event`, `dispatch`, `signal`, `summary`, `ci_handoff`) with each field, type, nullability, and source; the **cost contract** (unknown = `null`; floor-sum for mixed; `usage_coverage` per-field counts; `provider` explains systematic gaps); **`run_id` semantics** (opaque UUID, stable per run, same across `--resume`, `resumed`/`attempt` mark a resumed run); **`ticket_id` is run-local** (an ephemeral rowid, NOT a cross-run join key — use `run_id`); `event.dispatch_id` is **reserved (currently null)**, to be populated by a follow-up. Use the zod schema in `src/telemetry/events.ts` as the field source of truth and keep this doc current with it.

Include a short header noting this is a **versioned public API of the open-core seam** (kept in sync with the code per CLAUDE.md docs conventions).

- [ ] **Step 2: Reference it from build-operations §5.3**

In `docs/architecture/build-operations.md` §5 item 3 (Telemetry / state), add a line pointing to `telemetry-export.md` as the field-by-field spec, and note the `SCHEMA_VERSION` is now 2.

- [ ] **Step 3: Commit**

```bash
git add docs/architecture/telemetry-export.md docs/architecture/build-operations.md
git commit -m "docs(telemetry): field-by-field wire spec for the v2 export (ENG-349)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_015wsu2fhwp4o3wmJ6K5jj71"
```

---

## Task 9: Integration verification — two runs distinct, resume same, STYRE-1 acceptance

**Files:**
- Test: `test/telemetry/run-identity.test.ts` (create)

**Interfaces:** consumes everything above.

- [ ] **Step 1: Write the identity integration test**

Create `test/telemetry/run-identity.test.ts` — assert two independently-seeded run DBs produce distinct `run_id`s, and that `markResumed` keeps the same id while flipping `resumed`:

```ts
import { describe, expect, test } from "bun:test";
import { buildSummary } from "../../src/telemetry/emitter.ts";
import { getRun, markResumed } from "../../src/db/repos/run.ts";
import { insertRun } from "../../src/db/repos/run.ts";
import { makeTestDb } from "../helpers/db.ts";

const RESULT = { outcome: "pr-ready", stage: "merge", status: "done", iterations: 1 } as any;

describe("run identity on the wire", () => {
  test("two runs of the same ticket emit distinct run_id", () => {
    // makeTestDb seeds a FIXED run_id ("test-run-0001"); override b before building its summary
    // so the assertion reflects real distinct runs (each real run mints a fresh UUID).
    const a = makeTestDb();
    const b = makeTestDb();
    b.db.exec("DELETE FROM run;");
    insertRun(b.db, { runId: "test-run-0002", startedAt: "t", provider: "claude" });
    const sa: any = buildSummary(a.db, a.ticketId, RESULT);
    const sb: any = buildSummary(b.db, b.ticketId, RESULT);
    expect(sa.run_id).not.toBe(sb.run_id);
    a.db.close();
    b.db.close();
  });

  test("resume keeps the same run_id and marks resumed", () => {
    const { db, ticketId } = makeTestDb();
    const before = getRun(db)!.run_id;
    markResumed(db);
    const s: any = buildSummary(db, ticketId, RESULT);
    expect(s.run_id).toBe(before);
    expect(getRun(db)!.resumed).toBe(1);
    expect(getRun(db)!.attempt).toBe(2);
    db.close();
  });
});
```

- [ ] **Step 2: Run + verify**

Run: `bun test test/telemetry/run-identity.test.ts`
Expected: PASS.

- [ ] **Step 3: Full acceptance sweep**

Run: `bun test && bun run lint`
Expected: entire suite green.

- [ ] **Step 4: Manual STYRE-1 acceptance check (ENG-339 AC)**

If a codex-provider fixture/bench run is available (`styre-bench-scratch`), re-emit and confirm the summary now shows `"cost_usd": null` (not `0`) and `usage_coverage.cost_usd: 0`. If no fixture is reachable in this environment, record that the equivalent is covered by the "no dispatch reports cost => null" unit test (Task 6) and note it in the PR description.

- [ ] **Step 5: Commit**

```bash
git add test/telemetry/run-identity.test.ts
git commit -m "test(telemetry): run identity — distinct runs, resume continuity (ENG-349)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_015wsu2fhwp4o3wmJ6K5jj71"
```

---

## Follow-up (file as a separate ticket, do NOT do here)

- **Populate `event_log.dispatch_id`.** It is a live-but-unwritten column; the field now ships on the wire as `null`. Populating it means threading the causing dispatch id through the loopback/escalated append sites (~10 sites in `checks-verdict`, `checks-gate-verdict`, `arbiter-verdict`, `review-verdict`, `failure-policy`, `projector`). Control-loop surface — out of scope for the telemetry-wire work. Because the field already exists in v2, populating it later is a **non-breaking** change (no schema bump).

---

## Spec-coverage self-check

- ENG-339 unknown-cost → `null`: Task 5 (schema) + Task 6 (`aggregate`). ✅
- ENG-339 mixed contract (floor + coverage): Task 6 test. ✅
- ENG-339 `duration_ms`: Task 1. ✅
- ENG-339 `SCHEMA_VERSION` decision recorded: bump in Task 5; rationale in spec + Task 8 wire doc. ✅
- ENG-339 tokens/cache same treatment: Task 6 `aggregate` applied to all five. ✅
- ENG-339 audit findings recorded: spec §7 + follow-up section. ✅
- ENG-349 two runs distinguishable: Task 3 (mint) + Task 9 (test). ✅
- ENG-349 resume same id/marked: Task 3 (`markResumed`) + Task 9. ✅
- ENG-349 summary timestamp: Task 5/6 (`started_at`+`ended_at`). ✅
- ENG-349 provider on aggregated row + per-dispatch: Task 5/6. ✅
- ENG-349 `ticket_id` run-local documented: Task 8. ✅
- ENG-349 `event.dispatch_id` present: Task 4/5/6 (nullable now; population deferred). ✅
- ENG-349 wire spec in docs + joint version decision: Task 8. ✅
- Both: existing suite green: every task's Step ends on `bun test && bun run lint`. ✅

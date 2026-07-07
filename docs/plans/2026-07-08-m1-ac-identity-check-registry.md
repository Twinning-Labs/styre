# M1 — AC identity + check-registry schema (change-scoped verify) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

Plans the FIRST milestone of `docs/brainstorms/2026-07-07-change-scoped-verify-ac-checks-design.md` (v2). Read that design first; this plan implements only the data foundation it names in §3 (feasibility P1) — acceptance criteria are entirely unmodeled today.

---

## Milestone decomposition (the whole design, dependency-ordered)

Six independently-testable slices. Order is by real code dependencies (grounded in the current `src/`):

- **M1 — AC identity + check-registry schema (THIS PLAN).** Net-new schema: `acceptance_criterion` (AC identity) + `ac_check` (the authored-check registry). A deterministic AC parser (`parseAcChecklist`) + a `deriveAndPersistAcs` helper + the two repos. **No agent, no provisioning, no test execution** — pure data layer. Everything downstream reads these rows, so it goes first. Independently testable end-to-end via repo + parser unit tests.
- **M2 — the plan-blind `checks:dispatch` step (+ provisioning-at-`checks`, + coarse RED-first).** A new dispatch handler (new prompt template + `prompt-vars` entry + tool-allowlist entry) that reads the M1 AC rows (NOT the plan), authors native tests into the worktree (runner-committed, CL-COMMIT), then runs each authored check **in-suite** on clean `HEAD` and records a **coarse** red/green/error + raw output into `ac_check.red_first_result` + a `ground_truth_signal` verdict row. Wires the new step into the resolver's `design` sub-step chain (`design:* → provision → checks:dispatch → advance to implement`). **Provisioning-at-`checks` folds into M2** (see re-slice note below). Depends on M1 (needs the registry to write into) and on `provision` being reachable at the `checks` step.
- **M3 — graded RED taxonomy.** Classify M2's coarse red into `assertion` / `absence` / `environmental` (`ac_check.red_class`), with the bounded re-author loop for green-on-`HEAD`. Depends on M2 (needs the coarse red + raw output to classify).
- **M4 — verify-gate rework to advisory-demote.** Demote the current whole-suite `verify:check` / `verify:integration` hard gate (`handlers.ts:555-873`) to an advisory sweep; gate on the AC-checks reaching an acceptable green instead. This is a **rework** of existing gating (design §2.4), entangled with `realImpacted` / behavioral-A1 — the largest blast radius; sequence it after the check machinery (M2/M3) exists to gate on.
- **M5 — the 3-way arbiter + `checksFeedback` sibling.** On *persistent* AC-check red after implement, a distinct dispatch returns code-wrong / check-wrong / environmental; check-wrong re-derives via a new `designFeedback` sibling keyed to the arbiter dispatch. Depends on M4 (the gate must be able to stay red to arbitrate).
- **M6 — dispositions + projector surfacing.** `assessed-satisfied` / `not-expressible` disposition columns on `acceptance_criterion`, the green-on-`HEAD` adjudication routing, and surfacing dispositions + advisory-sweep failures at the MERGE gate through the existing projector. Depends on M3 (green-on-`HEAD`) and M5 (arbiter outcomes).

**Re-slice note (asked-for in the brief).** The operator's rough M1 bundled the `checks:dispatch` step + coarse RED-first *into* M1. Two real code dependencies pull that out into M2:

1. **RED-first cannot be recorded without a place to record it.** The registry (`ac_check`) + the AC rows (`acceptance_criterion`) are pure net-new schema (design §3 P1). Building the parser + schema + repos is a complete, independently-testable slice with no agent surface — the smallest thing that produces working software, and the thing everything else imports.
2. **RED-first cannot run without provisioning at the `checks` step.** `provision` is gated *inside* implement today (`resolver.ts:113,133`); running any authored native test on clean `HEAD` needs the env installed first (design §3 P3). That is a resolver re-sequencing plus an agent dispatch plus in-suite execution — a milestone's worth of work on its own, and meaningless until the registry exists. So **provisioning-at-`checks` folds into M2** (it is not a separate earlier milestone: the `provision` step + handler already exist and are generic — M2 only re-sequences them into the `design` chain before `checks:dispatch`), and the `checks:dispatch` step + coarse RED-first is M2, not M1.

Net effect: M1 is the deterministic data foundation (this plan); M2 is the first slice that dispatches an agent and touches the loop.

---

**Goal:** Introduce acceptance-criterion identity and the authored-check registry as net-new SQLite schema, plus a deterministic AC parser and the repos to read/write them — so a ticket's free-text acceptance criteria become addressable rows the M2 `checks:dispatch` step can consume. No behavior change to the running loop yet (nothing calls `deriveAndPersistAcs` in-loop until M2).

**Architecture:** Two new tables (`acceptance_criterion`, `ac_check`) appended to the single SQLite SoT (edit BOTH `src/db/schema.sql` — authoritative/loaded — and `docs/architecture/schema.sql` — the doc; bump schema version 3→4). A pure parser `src/dispatch/ac-checklist.ts` (`parseAcChecklist`) deterministically reads a ticket description into ACs, mirroring the existing deterministic-reader pattern of `plan-frontmatter.ts`. Two SQL-only repos (`src/db/repos/acceptance-criterion.ts`, `src/db/repos/ac-check.ts`). A thin `src/dispatch/derive-acs.ts` (`deriveAndPersistAcs`) composes parser + repo (kept out of the repo layer so `db/repos/*` never imports `dispatch/*` — layering stays one-way `dispatch → repo`).

**Tech Stack:** TypeScript, Bun (`bun test`, `bun run typecheck`, `bun run lint`), embedded SQLite (`bun:sqlite`). No new dependencies.

## Global Constraints

- **Single transactional SoT; only the runner writes it (B2).** These are runner-side repos/helpers; no agent gets a write path to them. AC derivation is deterministic (runner-computed), never agent self-report.
- **Edit BOTH `schema.sql` copies on any schema change.** `src/db/schema.sql` is loaded; `docs/architecture/schema.sql` is the doc. They must stay byte-identical (they are today).
- **Ephemeral per-run DB → no incremental migration files.** `migrate()` applies `schema.sql` fresh and reads the version marker (`src/db/migrate.ts`). A schema change is: add tables + bump the `schema_meta` INSERT version. There is no ALTER/upgrade path to write.
- **Deterministic AC identity (the plan-time decision — see below).** `parseAcChecklist` uses only string logic; no LLM. Synthesis of finer ACs is explicitly deferred (M2+ check-author's job).
- **YAGNI on the loop.** M1 does NOT wire `deriveAndPersistAcs` into the resolver — nothing reads ACs until M2, so an in-loop derive step now would be dead code. M1 ships the helper + tests; M2 calls it.
- **Capability isolation is untouched.** No new step, no new allowlist entry, no agent dispatch in M1 (so `allowlistFor` is not involved — it only throws for agent handlers).
- Commit after each task. Run `bun test`, `bun run typecheck`, `bun run lint` green before committing.

### Plan-time decision: how AC identity is obtained in M1

The design (§7) left the AC model to plan-time. **Decision: a deterministic GFM task-list parser with a whole-description fallback.**

- **Preferred — deterministic checklist parse.** Styre's own ticket contract carries an `- [ ]` acceptance-criteria checklist (per `styre-linear-ticket-format` memory: "Acceptance-criteria checklist"), and tickets are ingested as free-text `ticket.description` with **no AC parsing today** (`schema.sql:88`; `insertTicket` in `src/db/repos/ticket.ts` stores the body verbatim; `src/integrations/adapters/linear.ts:88` maps `issue.description` straight through). A GFM task-list item (`- [ ]` / `- [x]` / `* [ ]`) is deterministically parseable — mirroring the no-YAML-dep deterministic reader in `plan-frontmatter.ts`.
- **Fallback — one AC = the whole description.** Bench issues (astropy/darkreader) have NO checklist. When the description carries zero task-list items, the whole trimmed description is a single AC tagged `source = 'whole-description'`. This is honest: it does not fabricate structure. **Synthesis** (splitting a prose description into finer concerns) is a later concern — the M2 plan-blind check-author reads the AC text and decides how many checks a coarse AC needs (design §2.2 "cross-cutting ACs may map to several checks"). M1 does not synthesize.
- **Empty/whitespace description ⇒ zero ACs** (not one empty AC). M2 handles "no ACs" as its own case.

This is the approach the code supports (free-text descriptions, a proven deterministic-reader precedent, no ingestion changes required).

---

## File Structure

- **Modify** `src/db/schema.sql` — add `acceptance_criterion` + `ac_check` tables (§F2); bump `schema_meta` version 3→4.
- **Modify** `docs/architecture/schema.sql` — identical edit (keep the two copies byte-identical).
- **Modify** `test/migrate.test.ts` — bump the three `version` assertions 3→4; add the two new tables to `CORE_TABLES`.
- **Create** `src/dispatch/ac-checklist.ts` — pure `parseAcChecklist` + `ParsedAc` / `AcSource` types.
- **Create** `test/dispatch/ac-checklist.test.ts` — parser unit tests.
- **Create** `src/db/repos/acceptance-criterion.ts` — `insertAc`, `listByTicket`, `AcceptanceCriterionRow`.
- **Create** `test/db/repos/acceptance-criterion.test.ts` — repo round-trip tests.
- **Create** `src/db/repos/ac-check.ts` — `insertAcCheck`, `listByTicket`, `listByAc`, `AcCheckRow`.
- **Create** `test/db/repos/ac-check.test.ts` — repo round-trip tests.
- **Create** `src/dispatch/derive-acs.ts` — `deriveAndPersistAcs` (parser + repo composition).
- **Create** `test/dispatch/derive-acs.test.ts` — derive-and-persist tests (checklist, fallback, empty, idempotent).

---

## Task 1: Net-new schema — `acceptance_criterion` + `ac_check`

**Files:**
- Modify: `src/db/schema.sql`, `docs/architecture/schema.sql`
- Test: `test/migrate.test.ts`

**Interfaces:** none (SQL DDL). Downstream repos (Tasks 3–4) bind to these columns.

- [ ] **Step 1: Write the failing test** — bump the version assertions and add the new tables to the migrate smoke test.

Apply these edits to `test/migrate.test.ts`:

Add the two tables to `CORE_TABLES` (after `"review_finding",`):

```ts
  "review_finding",
  "acceptance_criterion",
  "ac_check",
  "linear_id_cache",
```

Change both `.toBe(3)` version assertions (the `bootstraps` and `idempotent` tests) from `3` to `4`:

```ts
  test("bootstraps a fresh DB at schema v4", () => {
    const result = migrate(tmpDbPath());
    expect(result.created).toBe(true);
    expect(result.version).toBe(4);
  });
```

```ts
  test("is idempotent — a second run is a no-op, version unchanged", () => {
    const path = tmpDbPath();
    migrate(path);
    const second = migrate(path);
    expect(second.created).toBe(false);
    expect(second.version).toBe(4);
  });
```

- [ ] **Step 2: Run it — fails.**

```
bun test test/migrate.test.ts
```

Expected: failures — `expect(received).toBe(expected)` (version 3 ≠ 4) and `expect(names).toContain("acceptance_criterion")` (table absent).

- [ ] **Step 3: Minimal implementation** — add the tables and bump the version, IDENTICALLY in both schema files.

In `src/db/schema.sql`, change the version marker INSERT (near line 53):

```sql
INSERT INTO schema_meta (version, applied_at, note)
VALUES (4, strftime('%Y-%m-%dT%H:%M:%SZ','now'),
        'v4: acceptance_criterion + ac_check (change-scoped verify — AC identity + authored-check registry)');
```

Then, immediately AFTER the `review_finding` table + its index (after `CREATE INDEX idx_finding_open ...;`, end of §F), insert a new section:

```sql
-- ============================================================================
-- §F2  ACCEPTANCE CRITERIA + AUTHORED-CHECK REGISTRY  (change-scoped verify)
-- ----------------------------------------------------------------------------
-- The AC's observable behavior becomes a ground-truth check (design
-- docs/brainstorms/2026-07-07-change-scoped-verify-ac-checks-design.md). ACs are
-- unmodeled elsewhere (they lived only in ticket.description). Per-check VERDICT
-- rows are NOT here — they reuse ground_truth_signal (open-vocab signal_type).
-- ============================================================================

-- acceptance_criterion — one concern per row, derived deterministically from the
-- ticket description (parseAcChecklist): a GFM task-list item, else the whole
-- description as a single AC. `source` records which. (M1 writes id/seq/text/source;
-- disposition columns for assessed-satisfied / not-expressible are added at M6.)
CREATE TABLE acceptance_criterion (
    id          INTEGER PRIMARY KEY,
    ticket_id   INTEGER NOT NULL REFERENCES ticket(id) ON DELETE CASCADE,
    seq         INTEGER NOT NULL,                    -- 1-based order within the ticket
    text        TEXT    NOT NULL,                    -- the AC's observable-behavior text
    source      TEXT    NOT NULL CHECK (source IN ('checklist','whole-description')),
    created_at  TEXT    NOT NULL,
    updated_at  TEXT    NOT NULL,
    UNIQUE (ticket_id, seq)
);
CREATE INDEX idx_ac_ticket ON acceptance_criterion (ticket_id, seq);

-- ac_check — the authored-check REGISTRY: one row per native test the plan-blind
-- checks:dispatch step (M2) writes for an AC. `selector` is the in-suite selection
-- (e.g. a pytest node-id / -k expression) run within the suite's setup context.
-- `red_first_result` is the COARSE RED-first outcome on clean HEAD (M2 fills);
-- `red_class` is the graded taxonomy assertion/absence/environmental (M3 fills).
-- Both are NULL until their milestone populates them. Per-run verdicts at each sha
-- go to ground_truth_signal, not here.
CREATE TABLE ac_check (
    id               INTEGER PRIMARY KEY,
    ticket_id        INTEGER NOT NULL REFERENCES ticket(id) ON DELETE CASCADE,
    ac_id            INTEGER NOT NULL REFERENCES acceptance_criterion(id) ON DELETE CASCADE,
    selector         TEXT    NOT NULL,               -- in-suite selection (node-id / -k / …)
    test_path        TEXT,                           -- authored test file, repo-relative
    red_first_result TEXT CHECK (red_first_result IS NULL OR red_first_result IN ('red','green','error')),  -- M2 coarse
    red_class        TEXT CHECK (red_class IS NULL OR red_class IN ('assertion','absence','environmental')), -- M3 graded
    created_at       TEXT    NOT NULL,
    updated_at       TEXT    NOT NULL
);
CREATE INDEX idx_ac_check_ticket ON ac_check (ticket_id, ac_id);
```

Copy the EXACT same version-INSERT change and the EXACT same §F2 block into `docs/architecture/schema.sql` at the same anchor.

- [ ] **Step 4: Run it — passes.**

```
bun test test/migrate.test.ts
```

Expected: all migrate tests pass (`N pass 0 fail`).

- [ ] **Step 5: Confirm the two copies are byte-identical.**

```
diff -q src/db/schema.sql docs/architecture/schema.sql && echo IDENTICAL
```

Expected: `IDENTICAL`.

- [ ] **Step 6: Commit.**

```
bun run typecheck && bun run lint && bun test test/migrate.test.ts
git add src/db/schema.sql docs/architecture/schema.sql test/migrate.test.ts
git commit -m "feat(schema): acceptance_criterion + ac_check tables (v4) for change-scoped verify"
```

---

## Task 2: Pure AC parser — `parseAcChecklist`

**Files:**
- Create: `src/dispatch/ac-checklist.ts`
- Test: `test/dispatch/ac-checklist.test.ts`

**Interfaces — Produces:**
- `type AcSource = "checklist" | "whole-description"`
- `interface ParsedAc { text: string; source: AcSource }`
- `parseAcChecklist(description: string | null): ParsedAc[]`

- [ ] **Step 1: Write the failing test.**

```ts
// test/dispatch/ac-checklist.test.ts
import { describe, expect, test } from "bun:test";
import { parseAcChecklist } from "../../src/dispatch/ac-checklist.ts";

describe("parseAcChecklist", () => {
  test("each GFM task-list item is one checklist AC (text trimmed)", () => {
    const desc = [
      "## Acceptance criteria",
      "",
      "- [ ] The endpoint returns 200 for a valid request",
      "- [x] Invalid input yields a 400",
      "* [ ] Auth is required on all routes",
      "+ [ ] Errors are logged",
    ].join("\n");
    expect(parseAcChecklist(desc)).toEqual([
      { text: "The endpoint returns 200 for a valid request", source: "checklist" },
      { text: "Invalid input yields a 400", source: "checklist" },
      { text: "Auth is required on all routes", source: "checklist" },
      { text: "Errors are logged", source: "checklist" },
    ]);
  });

  test("indented task-list items are still captured", () => {
    const desc = "  - [ ] nested item";
    expect(parseAcChecklist(desc)).toEqual([{ text: "nested item", source: "checklist" }]);
  });

  test("no task-list items ⇒ the whole (trimmed) description is one whole-description AC", () => {
    const desc = "\nFix the collection error so pytest can import the module.\n";
    expect(parseAcChecklist(desc)).toEqual([
      { text: "Fix the collection error so pytest can import the module.", source: "whole-description" },
    ]);
  });

  test("a bare '- [ ]' with no text is not a task item ⇒ falls back to whole-description", () => {
    const desc = "- [ ]";
    expect(parseAcChecklist(desc)).toEqual([{ text: "- [ ]", source: "whole-description" }]);
  });

  test("empty / whitespace-only / null description ⇒ no ACs", () => {
    expect(parseAcChecklist("")).toEqual([]);
    expect(parseAcChecklist("   \n  \t")).toEqual([]);
    expect(parseAcChecklist(null)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it — fails.**

```
bun test test/dispatch/ac-checklist.test.ts
```

Expected: fails to resolve the module / `parseAcChecklist is not a function` (file not created yet).

- [ ] **Step 3: Minimal implementation.**

```ts
// src/dispatch/ac-checklist.ts

/** Where an acceptance criterion came from: an explicit GFM task-list item, or the
 *  whole ticket description used as a single coarse AC when no checklist is present. */
export type AcSource = "checklist" | "whole-description";

export interface ParsedAc {
  text: string;
  source: AcSource;
}

/** A GFM task-list item: optional indent, a `-`, `*`, or `+` bullet, a `[ ]`/`[x]`/`[X]`
 *  checkbox, then at least one non-space char of text. The text is captured (group 1). */
const TASK_ITEM_RE = /^\s*[-*+]\s+\[[ xX]\]\s+(\S.*?)\s*$/;

/** Deterministically parse a ticket description into acceptance criteria (no LLM).
 *  Each GFM task-list item is one AC (`source: "checklist"`). If the description has
 *  NO task-list items, the whole trimmed description is a single AC
 *  (`source: "whole-description"`) — synthesis into finer ACs is deferred to the M2
 *  check-author. An empty/whitespace-only/null description yields no ACs. */
export function parseAcChecklist(description: string | null): ParsedAc[] {
  if (description === null || description.trim() === "") return [];
  const items: ParsedAc[] = [];
  for (const line of description.split(/\r?\n/)) {
    const m = line.match(TASK_ITEM_RE);
    if (m) items.push({ text: m[1].trim(), source: "checklist" });
  }
  if (items.length > 0) return items;
  return [{ text: description.trim(), source: "whole-description" }];
}
```

- [ ] **Step 4: Run it — passes.**

```
bun test test/dispatch/ac-checklist.test.ts
```

Expected: all parser tests pass (`5 pass 0 fail` — or the per-`test` count bun reports).

- [ ] **Step 5: Commit.**

```
bun run typecheck && bun run lint && bun test test/dispatch/ac-checklist.test.ts
git add src/dispatch/ac-checklist.ts test/dispatch/ac-checklist.test.ts
git commit -m "feat(checks): deterministic AC-checklist parser with whole-description fallback"
```

---

## Task 3: `acceptance_criterion` repo

**Files:**
- Create: `src/db/repos/acceptance-criterion.ts`
- Test: `test/db/repos/acceptance-criterion.test.ts`

**Interfaces — Produces:**
- `interface AcceptanceCriterionRow { id; ticket_id; seq; text; source; created_at; updated_at }`
- `insertAc(db, p: { ticketId; seq; text; source }): AcceptanceCriterionRow`
- `listByTicket(db, ticketId): AcceptanceCriterionRow[]`

- [ ] **Step 1: Write the failing test.**

```ts
// test/db/repos/acceptance-criterion.test.ts
import { expect, test } from "bun:test";
import * as acs from "../../../src/db/repos/acceptance-criterion.ts";
import { makeTestDb } from "../../helpers/db.ts";

test("insertAc round-trips a row; listByTicket returns it in seq order", () => {
  const { db, ticketId } = makeTestDb();
  acs.insertAc(db, { ticketId, seq: 2, text: "second", source: "checklist" });
  acs.insertAc(db, { ticketId, seq: 1, text: "first", source: "checklist" });
  const list = acs.listByTicket(db, ticketId);
  db.close();
  expect(list.map((a) => a.seq)).toEqual([1, 2]);
  expect(list[0]?.text).toBe("first");
  expect(list[0]?.source).toBe("checklist");
  expect(list[0]?.created_at).toBeTruthy();
});

test("listByTicket is empty for a ticket with no ACs", () => {
  const { db, ticketId } = makeTestDb();
  const list = acs.listByTicket(db, ticketId);
  db.close();
  expect(list).toEqual([]);
});

test("the (ticket_id, seq) UNIQUE constraint rejects a duplicate seq", () => {
  const { db, ticketId } = makeTestDb();
  acs.insertAc(db, { ticketId, seq: 1, text: "a", source: "checklist" });
  expect(() => acs.insertAc(db, { ticketId, seq: 1, text: "b", source: "checklist" })).toThrow();
  db.close();
});
```

- [ ] **Step 2: Run it — fails.**

```
bun test test/db/repos/acceptance-criterion.test.ts
```

Expected: module-not-found for `acceptance-criterion.ts`.

- [ ] **Step 3: Minimal implementation.**

```ts
// src/db/repos/acceptance-criterion.ts
import type { Database } from "bun:sqlite";
import { nowUtc } from "../../util/time.ts";

export interface AcceptanceCriterionRow {
  id: number;
  ticket_id: number;
  seq: number;
  text: string;
  source: string;
  created_at: string;
  updated_at: string;
}

const COLS = "id, ticket_id, seq, text, source, created_at, updated_at";

export function insertAc(
  db: Database,
  p: { ticketId: number; seq: number; text: string; source: "checklist" | "whole-description" },
): AcceptanceCriterionRow {
  const now = nowUtc();
  const res = db
    .query(
      `INSERT INTO acceptance_criterion (ticket_id, seq, text, source, created_at, updated_at)
       VALUES ($t, $seq, $text, $source, $now, $now)`,
    )
    .run({ $t: p.ticketId, $seq: p.seq, $text: p.text, $source: p.source, $now: now });
  const created = db
    .query<AcceptanceCriterionRow, [number]>(
      `SELECT ${COLS} FROM acceptance_criterion WHERE id = ?`,
    )
    .get(Number(res.lastInsertRowid));
  if (!created) {
    throw new Error("insertAc: row missing after insert");
  }
  return created;
}

export function listByTicket(db: Database, ticketId: number): AcceptanceCriterionRow[] {
  return db
    .query<AcceptanceCriterionRow, [number]>(
      `SELECT ${COLS} FROM acceptance_criterion WHERE ticket_id = ? ORDER BY seq`,
    )
    .all(ticketId);
}
```

- [ ] **Step 4: Run it — passes.**

```
bun test test/db/repos/acceptance-criterion.test.ts
```

Expected: all three tests pass.

- [ ] **Step 5: Commit.**

```
bun run typecheck && bun run lint && bun test test/db/repos/acceptance-criterion.test.ts
git add src/db/repos/acceptance-criterion.ts test/db/repos/acceptance-criterion.test.ts
git commit -m "feat(db): acceptance_criterion repo (insert + listByTicket)"
```

---

## Task 4: `ac_check` registry repo

**Files:**
- Create: `src/db/repos/ac-check.ts`
- Test: `test/db/repos/ac-check.test.ts`

**Interfaces — Produces:**
- `interface AcCheckRow { id; ticket_id; ac_id; selector; test_path; red_first_result; red_class; created_at; updated_at }`
- `insertAcCheck(db, p: { ticketId; acId; selector; testPath? }): AcCheckRow`
- `listByTicket(db, ticketId): AcCheckRow[]`
- `listByAc(db, acId): AcCheckRow[]`

M1 only inserts the registry identity (`selector` + `test_path`); `red_first_result` / `red_class` stay NULL (M2/M3 update them). This task keeps the repo minimal — insert + two list readers — no update writer yet (YAGNI; M2 adds the RED-first updater).

- [ ] **Step 1: Write the failing test.**

```ts
// test/db/repos/ac-check.test.ts
import { expect, test } from "bun:test";
import * as acChecks from "../../../src/db/repos/ac-check.ts";
import * as acs from "../../../src/db/repos/acceptance-criterion.ts";
import { makeTestDb } from "../../helpers/db.ts";

function seedAc(db: Parameters<typeof acs.insertAc>[0], ticketId: number): number {
  return acs.insertAc(db, { ticketId, seq: 1, text: "ac", source: "checklist" }).id;
}

test("insertAcCheck round-trips; RED-first columns default to NULL", () => {
  const { db, ticketId } = makeTestDb();
  const acId = seedAc(db, ticketId);
  const row = acChecks.insertAcCheck(db, {
    ticketId,
    acId,
    selector: "tests/test_api.py::test_returns_200",
    testPath: "tests/test_api.py",
  });
  db.close();
  expect(row.ac_id).toBe(acId);
  expect(row.selector).toBe("tests/test_api.py::test_returns_200");
  expect(row.test_path).toBe("tests/test_api.py");
  expect(row.red_first_result).toBeNull();
  expect(row.red_class).toBeNull();
});

test("test_path is optional (NULL when omitted)", () => {
  const { db, ticketId } = makeTestDb();
  const acId = seedAc(db, ticketId);
  const row = acChecks.insertAcCheck(db, { ticketId, acId, selector: "-k returns_200" });
  db.close();
  expect(row.test_path).toBeNull();
});

test("listByTicket and listByAc return inserted rows", () => {
  const { db, ticketId } = makeTestDb();
  const acId = seedAc(db, ticketId);
  acChecks.insertAcCheck(db, { ticketId, acId, selector: "s1" });
  acChecks.insertAcCheck(db, { ticketId, acId, selector: "s2" });
  const byTicket = acChecks.listByTicket(db, ticketId);
  const byAc = acChecks.listByAc(db, acId);
  db.close();
  expect(byTicket.map((r) => r.selector).sort()).toEqual(["s1", "s2"]);
  expect(byAc.length).toBe(2);
});
```

- [ ] **Step 2: Run it — fails.**

```
bun test test/db/repos/ac-check.test.ts
```

Expected: module-not-found for `ac-check.ts`.

- [ ] **Step 3: Minimal implementation.**

```ts
// src/db/repos/ac-check.ts
import type { Database } from "bun:sqlite";
import { nowUtc } from "../../util/time.ts";

export interface AcCheckRow {
  id: number;
  ticket_id: number;
  ac_id: number;
  selector: string;
  test_path: string | null;
  red_first_result: string | null;
  red_class: string | null;
  created_at: string;
  updated_at: string;
}

const COLS =
  "id, ticket_id, ac_id, selector, test_path, red_first_result, red_class, created_at, updated_at";

export function insertAcCheck(
  db: Database,
  p: { ticketId: number; acId: number; selector: string; testPath?: string | null },
): AcCheckRow {
  const now = nowUtc();
  const res = db
    .query(
      `INSERT INTO ac_check (ticket_id, ac_id, selector, test_path, created_at, updated_at)
       VALUES ($t, $ac, $sel, $path, $now, $now)`,
    )
    .run({
      $t: p.ticketId,
      $ac: p.acId,
      $sel: p.selector,
      $path: p.testPath ?? null,
      $now: now,
    });
  const created = db
    .query<AcCheckRow, [number]>(`SELECT ${COLS} FROM ac_check WHERE id = ?`)
    .get(Number(res.lastInsertRowid));
  if (!created) {
    throw new Error("insertAcCheck: row missing after insert");
  }
  return created;
}

export function listByTicket(db: Database, ticketId: number): AcCheckRow[] {
  return db
    .query<AcCheckRow, [number]>(
      `SELECT ${COLS} FROM ac_check WHERE ticket_id = ? ORDER BY id`,
    )
    .all(ticketId);
}

export function listByAc(db: Database, acId: number): AcCheckRow[] {
  return db
    .query<AcCheckRow, [number]>(`SELECT ${COLS} FROM ac_check WHERE ac_id = ? ORDER BY id`)
    .all(acId);
}
```

- [ ] **Step 4: Run it — passes.**

```
bun test test/db/repos/ac-check.test.ts
```

Expected: all three tests pass.

- [ ] **Step 5: Commit.**

```
bun run typecheck && bun run lint && bun test test/db/repos/ac-check.test.ts
git add src/db/repos/ac-check.ts test/db/repos/ac-check.test.ts
git commit -m "feat(db): ac_check authored-check registry repo (insert + listByTicket/listByAc)"
```

---

## Task 5: `deriveAndPersistAcs` — parser + repo composition

**Files:**
- Create: `src/dispatch/derive-acs.ts`
- Test: `test/dispatch/derive-acs.test.ts`

**Interfaces — Produces:**
- `deriveAndPersistAcs(db, ticketId: number): number` — parses the ticket's description, inserts one `acceptance_criterion` per parsed AC (seq `1..N`), returns the count. Idempotent: a no-op returning the existing count if ACs already exist for the ticket (single-writer, re-derivation guard). Kept in `dispatch/` (not `db/repos/`) so the repo layer never imports the parser — layering stays one-way.

This is the seam M2 calls (from the new `checks:dispatch` handler / a deterministic pre-step). M1 ships and tests it but does NOT wire it into the resolver (nothing reads ACs until M2 — wiring it now would be dead code).

- [ ] **Step 1: Write the failing test.**

```ts
// test/dispatch/derive-acs.test.ts
import { expect, test } from "bun:test";
import * as acs from "../../src/db/repos/acceptance-criterion.ts";
import { insertTicket } from "../../src/db/repos/ticket.ts";
import { deriveAndPersistAcs } from "../../src/dispatch/derive-acs.ts";
import { makeTestDb } from "../helpers/db.ts";

function ticketWith(db: Parameters<typeof insertTicket>[0], projectId: number, description: string | null) {
  return insertTicket(db, { projectId, ident: "ENG-42", description });
}

test("checklist description ⇒ one AC per task-list item, seq 1..N, source checklist", () => {
  const { db, projectId } = makeTestDb();
  const id = ticketWith(db, projectId, "- [ ] returns 200\n- [ ] rejects bad input");
  const n = deriveAndPersistAcs(db, id);
  const rows = acs.listByTicket(db, id);
  db.close();
  expect(n).toBe(2);
  expect(rows.map((r) => [r.seq, r.text, r.source])).toEqual([
    [1, "returns 200", "checklist"],
    [2, "rejects bad input", "checklist"],
  ]);
});

test("no checklist ⇒ a single whole-description AC", () => {
  const { db, projectId } = makeTestDb();
  const id = ticketWith(db, projectId, "Fix the import so collection succeeds.");
  const n = deriveAndPersistAcs(db, id);
  const rows = acs.listByTicket(db, id);
  db.close();
  expect(n).toBe(1);
  expect(rows[0]?.source).toBe("whole-description");
  expect(rows[0]?.text).toBe("Fix the import so collection succeeds.");
});

test("empty description ⇒ zero ACs", () => {
  const { db, projectId } = makeTestDb();
  const id = ticketWith(db, projectId, "");
  const n = deriveAndPersistAcs(db, id);
  db.close();
  expect(n).toBe(0);
});

test("idempotent — a second call does not duplicate rows", () => {
  const { db, projectId } = makeTestDb();
  const id = ticketWith(db, projectId, "- [ ] a\n- [ ] b");
  expect(deriveAndPersistAcs(db, id)).toBe(2);
  expect(deriveAndPersistAcs(db, id)).toBe(2);
  const rows = acs.listByTicket(db, id);
  db.close();
  expect(rows.length).toBe(2);
});

test("throws for a missing ticket", () => {
  const { db } = makeTestDb();
  expect(() => deriveAndPersistAcs(db, 99999)).toThrow(/not found/);
  db.close();
});
```

- [ ] **Step 2: Run it — fails.**

```
bun test test/dispatch/derive-acs.test.ts
```

Expected: module-not-found for `derive-acs.ts`.

- [ ] **Step 3: Minimal implementation.**

```ts
// src/dispatch/derive-acs.ts
import type { Database } from "bun:sqlite";
import { insertAc, listByTicket } from "../db/repos/acceptance-criterion.ts";
import { getTicket } from "../db/repos/ticket.ts";
import { parseAcChecklist } from "./ac-checklist.ts";

/** Deterministically derive the ticket's acceptance criteria from its description and
 *  persist them (seq 1..N). Idempotent: if the ticket already has ACs, returns the
 *  existing count without inserting (single-writer re-derivation guard). Returns the
 *  number of ACs now present for the ticket. Lives in dispatch/ (not db/repos/) so the
 *  repo layer never imports the parser — dependency direction stays dispatch → repo. */
export function deriveAndPersistAcs(db: Database, ticketId: number): number {
  const existing = listByTicket(db, ticketId);
  if (existing.length > 0) return existing.length;
  const ticket = getTicket(db, ticketId);
  if (!ticket) {
    throw new Error(`deriveAndPersistAcs: ticket ${ticketId} not found`);
  }
  const parsed = parseAcChecklist(ticket.description);
  parsed.forEach((ac, i) =>
    insertAc(db, { ticketId, seq: i + 1, text: ac.text, source: ac.source }),
  );
  return parsed.length;
}
```

- [ ] **Step 4: Run it — passes.**

```
bun test test/dispatch/derive-acs.test.ts
```

Expected: all five tests pass.

- [ ] **Step 5: Full suite + gates green, then commit.**

```
bun test && bun run typecheck && bun run lint
git add src/dispatch/derive-acs.ts test/dispatch/derive-acs.test.ts
git commit -m "feat(checks): deriveAndPersistAcs — persist deterministic ACs from the ticket description"
```

Expected: the whole suite is green (M1 added tables + code but changed no existing loop behavior; only `test/migrate.test.ts` was edited, in Task 1).

---

## Done-when (M1 acceptance)

- `bun test`, `bun run typecheck`, `bun run lint` all green.
- `acceptance_criterion` + `ac_check` exist in a freshly migrated DB at schema v4; both `schema.sql` copies are byte-identical.
- `parseAcChecklist` deterministically maps a description to ACs (checklist → items; no checklist → whole-description; empty → none).
- `deriveAndPersistAcs` persists ACs idempotently from `ticket.description`.
- No change to the running loop (nothing calls `deriveAndPersistAcs` in-resolver yet — that is M2's `checks:dispatch` wiring).

## Notes for M2 (carried forward, not built here)

- **Where `deriveAndPersistAcs` gets called:** M2 introduces the `checks:dispatch` step in the resolver's `design` sub-step chain (`resolver.ts` `case "design"`), preceded by a `provision` gate (design §3 P3). Derive ACs at/just-before that step so the plan-blind author reads them.
- **`allowlistFor` will THROW** on the new `checks:dispatch` handler unless M2 adds a `tool-allowlists.ts` entry — the checks step gets `Read/Grep/Glob/Write/Edit/Bash` (Bash scoped to the profile's test runners), NO `gh`/Linear/branch tools (capability isolation).
- **Verdict rows** for each authored check reuse `ground_truth_signal` (open-vocab `signal_type`, e.g. `ac-check`), keyed by `branch_head_sha` — not `ac_check` (which is the static registry). M2 adds a `red_first_result` updater on `ac_check` for the coarse outcome.

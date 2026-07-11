# M-jira-1: Neutralize Vendor Fields — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rename every baked-in Linear-specific identifier (`linearIssueUuid` / `linear_*` columns + table) to vendor-neutral names, so the JIRA adapter (M-jira-2) builds on neutral ground.

**Architecture:** Two tasks, split by responsibility. Task 1 renames the TypeScript interface field and every TS caller/test (no schema change). Task 2 renames the five SQLite identifiers in both `schema.sql` copies, updates the one SQL string that binds them, bumps the schema version, and fixes the migration test. Each task ends with `tsc --noEmit` and `bun test` fully green.

**Tech Stack:** TypeScript, Bun (`bun test`, `bun:sqlite`), embedded SQLite. `schema.sql` is imported as text (`import schemaSql from "./schema.sql" with { type: "text" }`).

## Global Constraints

- **Never commit to `main`.** Work happens on branch `feat/jira-issue-tracker` (already checked out).
- **Branch prefix:** `feat/`. **No auto-merge** — the operator merges PRs personally.
- **Dual-schema rule:** every schema change edits BOTH `src/db/schema.sql` (the loaded copy) AND `docs/architecture/schema.sql` (the doc mirror), identically.
- **Pure refactor:** no behavior change. `linear_issue_uuid` is write-only (never SELECTed), and `linear_team_key` / `linear_state` / `linear_id_cache` / `projected_linear_state` are vestigial (unread by any code). This milestone must not change what the code does — only names.
- **Verification commands** (run from the worktree root): typecheck `bun run typecheck` (= `tsc --noEmit`), tests `bun test`, lint `bun run lint` (= `biome check .`).
- **Neutral name map** (used verbatim in both tasks):
  | Current | Neutral |
  |---|---|
  | `linearIssueUuid` (TS field/param) | `externalId` |
  | `linear_issue_uuid` (column) | `external_id` |
  | `linear_team_key` (column) | `external_project_key` |
  | `linear_state` (column) | `external_state` |
  | `linear_id_cache` (table) | `external_id_cache` |
  | `projected_linear_state` (column) | `projected_external_state` |

---

## File Structure

**Task 1 (TypeScript field rename — no schema):**
- Modify: `src/integrations/ticket-source.ts` — the `IngestedTicket` interface field.
- Modify: `src/integrations/adapters/linear.ts` — the value it returns from `fetchTicket`.
- Modify: `src/integrations/adapters/fake-issue-tracker.ts` — the fake's default ticket.
- Modify: `src/daemon/run-ticket.ts` — the field passed to `insertTicket`.
- Modify: `src/db/repos/ticket.ts` — the `insertTicket` param name + named bind placeholder (NOT the column yet).
- Modify (tests): `test/integrations/fetch-ticket.test.ts`, `test/db/ticket-description.test.ts`, `test/cli/park.test.ts`, `test/cli/park-inplace.test.ts`, `test/cli/run-e2e.test.ts`, `test/helpers/run-harness.ts`.

**Task 2 (SQLite identifier rename — schema + one SQL string + migration test):**
- Modify: `src/db/schema.sql` — five identifiers + `schema_meta` version bump.
- Modify: `docs/architecture/schema.sql` — the identical five identifiers + version bump (doc mirror).
- Modify: `src/db/repos/ticket.ts` — the `linear_issue_uuid` column name inside the INSERT SQL string.
- Modify: `test/migrate.test.ts` — `CORE_TABLES` entry + the two `version` assertions.

---

## Task 1: Rename the TypeScript external-id field

**Files:**
- Modify: `src/integrations/ticket-source.ts:11`
- Modify: `src/integrations/adapters/linear.ts:90`
- Modify: `src/integrations/adapters/fake-issue-tracker.ts:14`
- Modify: `src/daemon/run-ticket.ts:108`
- Modify: `src/db/repos/ticket.ts:35,44,54` (TS param + `$linearIssueUuid` placeholder only)
- Modify: `test/integrations/fetch-ticket.test.ts:11`, `test/db/ticket-description.test.ts:16`, `test/cli/park.test.ts:142`, `test/cli/park-inplace.test.ts:126,239,328,430`, `test/cli/run-e2e.test.ts:30,77`, `test/helpers/run-harness.ts:99,234`

**Interfaces:**
- Produces: `IngestedTicket.externalId: string | null` (was `linearIssueUuid`). `insertTicket(db, { …, externalId?: string | null })` (param `linearIssueUuid` → `externalId`). These names are consumed by M-jira-2's `jiraIssueTracker.fetchTicket`.

- [ ] **Step 1: Rename the interface field (the definition first, so `tsc` lists every break)**

In `src/integrations/ticket-source.ts`, change line 11:

```ts
// before
  linearIssueUuid: string | null;
// after
  externalId: string | null;
```

- [ ] **Step 2: Run typecheck to enumerate every reference that must change**

Run: `bun run typecheck`
Expected: FAIL — `tsc` reports errors at `linear.ts:90`, `fake-issue-tracker.ts:14`, `run-ticket.ts:108`, `ticket.ts` (param usage), and the test files. Use this list as the checklist for Step 3.

- [ ] **Step 3: Update every non-test reference**

`src/integrations/adapters/linear.ts:90`:
```ts
// before
        linearIssueUuid: issue.id,
// after
        externalId: issue.id,
```

`src/integrations/adapters/fake-issue-tracker.ts:14`:
```ts
// before
    linearIssueUuid: "fake-uuid",
// after
    externalId: "fake-uuid",
```

`src/daemon/run-ticket.ts:108`:
```ts
// before
    linearIssueUuid: ingested.linearIssueUuid,
// after
    externalId: ingested.externalId,
```

`src/db/repos/ticket.ts` — rename the param (line 35), the named placeholder in the VALUES clause (line 44), and the bind (line 54). **Leave the `linear_issue_uuid` column name in the INSERT (line 42) unchanged — that is Task 2.**
```ts
// line 35 — before / after
    linearIssueUuid?: string | null;
    externalId?: string | null;
```
```ts
// line 44 (VALUES clause) — before / after
          $stage, $status, $track, $needsDocs, $now, $now)`,   // ← the $linearIssueUuid token in this VALUES list
       VALUES ($pid, $ident, $title, $description, $typeLabel, $branchPrefix, $externalId,
```
Concretely, the VALUES line becomes:
```sql
       VALUES ($pid, $ident, $title, $description, $typeLabel, $branchPrefix, $externalId,
          $stage, $status, $track, $needs_docs? ...
```
(only `$linearIssueUuid` → `$externalId` changes on that line).
```ts
// line 54 — before / after
      $linearIssueUuid: t.linearIssueUuid ?? null,
      $externalId: t.externalId ?? null,
```

- [ ] **Step 4: Update every test reference**

Replace `linearIssueUuid:` with `externalId:` at each of these (the value is a canned-ticket string literal in every case — keep the value, change only the key):

- `test/integrations/fetch-ticket.test.ts:11` → `externalId: "u",`
- `test/db/ticket-description.test.ts:16` → `externalId: "uuid-123",`
- `test/cli/park.test.ts:142` → `externalId: "uuid-wire",`
- `test/cli/park-inplace.test.ts:126` → `externalId: "uuid-inplace",`
- `test/cli/park-inplace.test.ts:239` → `externalId: "uuid-inplace-identity",`
- `test/cli/park-inplace.test.ts:328` → `externalId: "uuid-inplace-marker",`
- `test/cli/park-inplace.test.ts:430` → `externalId: "uuid-inplace-override",`
- `test/cli/run-e2e.test.ts:30` → `externalId: "uuid-42",`
- `test/cli/run-e2e.test.ts:77` → `externalId: "u",`
- `test/helpers/run-harness.ts:99` → `externalId: "uuid-harness",`
- `test/helpers/run-harness.ts:234` → `externalId: "uuid-harness",`

- [ ] **Step 5: Verify no `linearIssueUuid` remains and typecheck passes**

Run: `grep -rn "linearIssueUuid" src/ test/`
Expected: no output (empty).

Run: `bun run typecheck`
Expected: PASS (exit 0, no errors).

- [ ] **Step 6: Run the full test suite**

Run: `bun test`
Expected: PASS — all tests green. (No behavior changed; the SQL column is still `linear_issue_uuid`, and `$externalId` binds into it positionally.)

- [ ] **Step 7: Commit**

```bash
git add src/integrations/ticket-source.ts src/integrations/adapters/linear.ts \
  src/integrations/adapters/fake-issue-tracker.ts src/daemon/run-ticket.ts \
  src/db/repos/ticket.ts test/
git commit -m "refactor(ticket): rename IngestedTicket.linearIssueUuid -> externalId

Vendor-neutral field name ahead of the JIRA adapter (M-jira-1). Pure
TS rename; the DB column is renamed in the next commit.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01LnpZSryugjuH1W1rQgUFcp"
```

---

## Task 2: Rename the SQLite identifiers (schema + version bump + migration test)

**Files:**
- Modify: `src/db/schema.sql:67,86,116,446,464` + version at line 54
- Modify: `docs/architecture/schema.sql` (same five identifiers + version — the doc mirror)
- Modify: `src/db/repos/ticket.ts:42` (the `linear_issue_uuid` column in the INSERT SQL string)
- Modify: `test/migrate.test.ts:26,35,57`

**Interfaces:**
- Produces: SQLite columns `ticket.external_id`, `project.external_project_key`, `ticket.external_state`, `projection_state.projected_external_state`, and table `external_id_cache`. `schema_meta` version is now `7`.

- [ ] **Step 1: Rename the five identifiers in `src/db/schema.sql`**

Line 67 (`project` table):
```sql
-- before
    linear_team_key     TEXT,                           -- e.g. 'ENG' (projector scope)
-- after
    external_project_key TEXT,                          -- e.g. 'ENG' / JIRA project key (projector scope)
```
Line 86 (`ticket` table):
```sql
-- before
    linear_issue_uuid     TEXT,                              -- resolved lazily; for projection
-- after
    external_id           TEXT,                              -- tracker issue id; for projection
```
Line 116 (`ticket` table):
```sql
-- before
    linear_state          TEXT,                              -- 'Todo'/'In Progress'/...
-- after
    external_state        TEXT,                              -- 'Todo'/'In Progress'/...
```
Line 445-446 (table + its comment):
```sql
-- before
-- linear_id_cache — the linear-ids.json cache, in the SoT for the projector.
CREATE TABLE linear_id_cache (
-- after
-- external_id_cache — the tracker id-resolution cache, in the SoT for the projector.
CREATE TABLE external_id_cache (
```
Line 464 (`projection_state` table):
```sql
-- before
    projected_linear_state TEXT,                        -- 'In Progress'/...
-- after
    projected_external_state TEXT,                      -- 'In Progress'/...
```

- [ ] **Step 2: Bump the schema version in `src/db/schema.sql`**

Lines 53-55:
```sql
-- before
INSERT INTO schema_meta (version, applied_at, note)
VALUES (6, strftime('%Y-%m-%dT%H:%M:%SZ','now'),
        'v6: ac_check.superseded_at + AUTOINCREMENT id — M4 re-author SUPERSEDES (never deletes); control state is read from the table, not the append-only signal log');
-- after
INSERT INTO schema_meta (version, applied_at, note)
VALUES (7, strftime('%Y-%m-%dT%H:%M:%SZ','now'),
        'v7: neutralize vendor-named identifiers (linear_* -> external_*, linear_id_cache -> external_id_cache) ahead of the JIRA adapter');
```

- [ ] **Step 3: Mirror all of the above into `docs/architecture/schema.sql`**

Apply the identical five identifier renames and the identical version-7 bump to `docs/architecture/schema.sql`. Verify parity:

Run: `diff <(grep -n "external_id\|external_project_key\|external_state\|external_id_cache\|projected_external_state\|version, applied_at" src/db/schema.sql) <(grep -n "external_id\|external_project_key\|external_state\|external_id_cache\|projected_external_state\|version, applied_at" docs/architecture/schema.sql)`
Expected: only line-number differences (if any), never a content difference in the matched identifier lines.

- [ ] **Step 4: Update the INSERT column name in `src/db/repos/ticket.ts:42`**

```ts
// before
         (project_id, ident, title, description, type_label, branch_prefix, linear_issue_uuid,
// after
         (project_id, ident, title, description, type_label, branch_prefix, external_id,
```
(The `$externalId` placeholder from Task 1 already matches; no other change here.)

- [ ] **Step 5: Update `test/migrate.test.ts`**

Line 26 (`CORE_TABLES`):
```ts
// before
  "linear_id_cache",
// after
  "external_id_cache",
```
Lines 35 and 57 (version assertions):
```ts
// before (both)
    expect(result.version).toBe(6);
    expect(second.version).toBe(6);
// after
    expect(result.version).toBe(7);
    expect(second.version).toBe(7);
```

- [ ] **Step 6: Verify no `linear_` identifier remains in code/schema/tests**

Run: `grep -rn "linear_issue_uuid\|linear_team_key\|linear_state\|linear_id_cache\|projected_linear_state" src/ test/ docs/architecture/schema.sql`
Expected: no output (empty). (Prose mentions of "Linear" in comments are fine and out of scope; this grep targets only the renamed identifiers.)

- [ ] **Step 7: Typecheck, test, lint**

Run: `bun run typecheck`
Expected: PASS.

Run: `bun test`
Expected: PASS — `migrate.test.ts` now asserts version 7 and finds `external_id_cache`; the schema loads clean (`import schemaSql from "./schema.sql"`); insert path binds `$externalId` into the `external_id` column.

Run: `bun run lint`
Expected: PASS (no new issues).

- [ ] **Step 8: Commit**

```bash
git add src/db/schema.sql docs/architecture/schema.sql src/db/repos/ticket.ts test/migrate.test.ts
git commit -m "refactor(db): neutralize linear_* identifiers -> external_* (schema v7)

Rename linear_issue_uuid->external_id, linear_team_key->external_project_key,
linear_state->external_state, linear_id_cache->external_id_cache,
projected_linear_state->projected_external_state in both schema.sql copies;
bump schema_meta to v7. All vestigial except external_id (write-only), so no
behavior change. Completes M-jira-1.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01LnpZSryugjuH1W1rQgUFcp"
```

---

## Self-Review

**Spec coverage** (against the spec's §Neutralizing + §Migration reality):
- All five identifiers from the spec's rename table → Task 2 Steps 1, 3 (both copies). ✓
- Interface field + `linear.ts:90` + run-ticket + fake + the ~7 test files → Task 1 Steps 1, 3, 4. ✓
- Both `schema.sql` copies (dual-schema rule) → Task 2 Steps 1-3. ✓
- `schema_meta` version bump + `migrate.test.ts` assertion → Task 2 Steps 2, 5. ✓
- "schema loads clean, no row-preservation claim" → Task 2 Step 7 (bun test loads the schema). ✓
- Out of scope (correctly not in this plan): the adapter, ADF, setState, config, setup, denylist — all M-jira-2.

**Placeholder scan:** no TBD/TODO/"handle appropriately"; every code step shows exact before/after; every command has an expected result. ✓

**Type consistency:** `externalId` (TS field + `insertTicket` param + `$externalId` placeholder) is used identically in Task 1 and referenced by Task 2 Step 4; `external_id` (column) is consistent between schema (Task 2 Step 1) and the INSERT string (Task 2 Step 4). ✓

**Note on ordering:** Task 1 leaves a deliberate transient cosmetic mismatch (TS `$externalId` binding into SQL column `linear_issue_uuid`) that is fully green and is resolved by Task 2 Step 4. This is intentional so each task compiles and tests independently.

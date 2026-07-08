# M3 `checks:classify` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the `checks:classify` step that grades each authored check's RED-first outcome into `ac_check.red_class` (assertion/absence/environmental), adjudicates green-on-HEAD checks (vacuous/already-satisfied/not-expressible), and drives the bounded, AC-scoped re-author loopback.

**Architecture:** A new `design`-stage resolver step (`design → provision → checks:dispatch → checks:classify → advance`). A pure *deterministic prior* settles the trivially-clear cases from the M2b-persisted `{exitCode, framework, rawOutput}`; everything ambiguous goes to a single capability-isolated *adjudicator* dispatch (Read/Grep/Glob, **no Bash**, judges from the recorded trace, never re-runs). Outcomes persist per-check on `ac_check` (`red_class` write-once; a new `disposition` column) plus an evidence signal. A *vacuous* finding triggers a net-new verdict path (`applyChecksVerdict`) that mirrors `review-verdict`'s shape: it re-authors **only the flagged ACs** (`deleteByAc` + scoped `checks:dispatch` re-dispatch), keyed on an `(ac_ids,"vacuous")` signature so escalate-on-repeat is sound.

**Tech Stack:** TypeScript, Bun, `bun:sqlite`, zod (structured sidecar), `bun test`.

## Global Constraints

- **Single transactional SoT; only the runner writes it.** Handlers return results / persist via repos; every multi-row write is one `db.transaction(...)()`.
- **`red_class` is write-once** — a clean-HEAD historical fact. `checks:classify` classifies **only** rows with `red_class IS NULL AND disposition IS NULL`; already-classified rows are immutable. Recompute-all-in-one-txn applies only to a *single* classify invocation's crash-resume, never across re-author rounds.
- **The prior NEVER outputs `assertion`.** An assertion-failed check is by definition ambiguous (may be a proxy-absence) and always reaches the adjudicator. The prior settles only: coarse `error` ⇒ `environmental`; a clean own-symbol import/name error ⇒ `absence`.
- **Read the RED-first signal by LIVE `ac_check.id`** (join `detail_json.acCheckId → ac_check.id`), never "the latest signal for the AC" — `ground_truth_signal` is append-only and a re-author leaves stale traces behind.
- **Adjudicator is capability-isolated:** tier `standard`, allowlist `[...READ_ONLY]` (Read/Grep/Glob) — **no Bash, no Write**. It interprets the trace; it does not re-derive ground truth.
- **Structured agent output through a validated zod sidecar.** Absent/malformed per-check result = transport failure → **per-check fault-isolated re-dispatch** (never re-run the whole batch and re-label good judgments), bounded; still-missing after the bound → throw (→ failure-policy re-dispatches the step).
- **Dispositions are per-check** (on `ac_check`). AC-level `assessed-satisfied` is a **rollup** (all of an AC's checks satisfied) computed by M6 at projection time — **no column added to `acceptance_criterion`**.
- **Scoped re-author needs NO stage flip** — `checks:dispatch` and `checks:classify` are both in the `design` stage; after the reset, `case "design"` re-serves both.
- **Non-gating (M4 is the gate).** Nothing blocks a merge on this. Edit **BOTH** `schema.sql` copies (`src/db/schema.sql` authoritative + `docs/architecture/schema.sql` doc) on any schema change.
- **Task 0 (exit-code persistence) is already DONE + merged** — `checks:dispatch` already writes `{rawOutput, exitCode, framework, command, acCheckId}` into the RED-first signal's `detail_json`. Do NOT re-add it.

---

## File Structure

**New files**
- `src/dispatch/classify-prior.ts` — the pure deterministic prior (coarse + rawOutput → a settle/adjudicate verdict).
- `src/dispatch/adjudicate-schema.ts` — the `checks:classify` zod sidecar contract.
- `src/daemon/checks-verdict.ts` — `applyChecksVerdict` + `checksLoopback` + `isRepeatedChecksLoopback` + `latestChecksReauthorAcs` (the net-new verdict/loopback path).
- `src/dispatch/checks-feedback.ts` — `checksFeedback` (the carry rendered into a re-authored `checks:dispatch` prompt, paralleling `designFeedback`).
- `prompts/checks-classify.md` — the adjudicator prompt template.
- Test files: `test/dispatch/classify-prior.test.ts`, `test/dispatch/adjudicate-schema.test.ts`, `test/db/repos/ac-check-classify.test.ts`, `test/db/repos/signal-for-ac-check.test.ts`, `test/dispatch/checks-classify-handler.test.ts`, `test/daemon/checks-verdict.test.ts`, `test/dispatch/checks-reauthor-e2e.test.ts`.

**Modified files**
- `src/db/schema.sql` + `docs/architecture/schema.sql` — add `ac_check.disposition`; bump `schema_meta` to 5; comment migration.
- `src/db/repos/ac-check.ts` — `disposition` in `AcCheckRow`/`COLS`; `deleteByAc`, `classifyAcCheck`, `listUnresolvedByTicket`.
- `src/db/repos/ground-truth-signal.ts` — `signalForAcCheck` (by-live-id read).
- `src/agent/tiers.ts` — `"checks:classify": "standard"`.
- `src/dispatch/tool-allowlists.ts` — `"checks:classify": [...READ_ONLY]`.
- `src/dispatch/prompt-vars.ts` — `CHECKS_CLASSIFY_TEMPLATE`, `adjudicateVars`; add `checks_feedback` to `checksVars`.
- `prompts/checks.md` — a `{{checks_feedback}}` slot.
- `src/dispatch/handlers.ts` — register `checks:classify`; the scoped-re-author branch in `checks:dispatch`.
- `src/daemon/advance.ts` — `checks:classify` in `VERDICT_BEARING_STEPS`; branch `onSucceed` to `applyChecksVerdict`.
- `src/daemon/resolver.ts` — the `checks:classify` gate between `checks:dispatch` and the design→implement advance.
- `test/migrate.test.ts`, `test/daemon/resolver.test.ts`, `test/daemon/advance.test.ts`, `test/dispatch/design-size-e2e.test.ts`, `test/dispatch/design-review-e2e.test.ts`, `test/helpers/skeleton-registry.ts`, `test/agent/tiers.test.ts`, `test/dispatch/tool-allowlists.test.ts` — insertion-point + version updates.

---

## Task 1: Schema — `ac_check.disposition` + version bump + comment migration

**Files:**
- Modify: `src/db/schema.sql` (ac_check table ~line 421; schema_meta ~line 53; comments ~line 400, ~414)
- Modify: `docs/architecture/schema.sql` (same edits, matched by text)
- Test: `test/migrate.test.ts` (version assertions)

**Interfaces:**
- Produces: an `ac_check.disposition` column, `TEXT`, `CHECK (disposition IS NULL OR disposition IN ('satisfied','not-expressible'))`, nullable. `schema_meta` version `5`.

- [ ] **Step 1: Update the version assertions in the migrate test (they will fail first)**

In `test/migrate.test.ts`, change both `expect(...).toBe(4)` (the `version` assertions at ~line 35 and ~line 57) to `toBe(5)`.

- [ ] **Step 2: Run the migrate test to verify it fails**

Run: `bun test test/migrate.test.ts`
Expected: FAIL — `expect(received).toBe(expected)` … Received: `4`.

- [ ] **Step 3: Add the `disposition` column (both schema copies)**

In `src/db/schema.sql`, inside `CREATE TABLE ac_check (...)`, add the `disposition` line immediately after the `red_class` line:

```sql
    red_class        TEXT CHECK (red_class IS NULL OR red_class IN ('assertion','absence','environmental')), -- M3 graded
    disposition      TEXT CHECK (disposition IS NULL OR disposition IN ('satisfied','not-expressible')),      -- M3 green-on-HEAD per-check
    created_at       TEXT    NOT NULL,
```

Apply the identical edit to `docs/architecture/schema.sql`.

- [ ] **Step 4: Bump the schema version (both copies)**

In `src/db/schema.sql`, replace the `schema_meta` INSERT:

```sql
INSERT INTO schema_meta (version, applied_at, note)
VALUES (5, strftime('%Y-%m-%dT%H:%M:%SZ','now'),
        'v5: ac_check.disposition (M3 green-on-HEAD per-check) + M3 owns red_class/disposition storage, M6 projects');
```

Apply the identical edit to `docs/architecture/schema.sql`.

- [ ] **Step 5: Migrate the comments (both copies)**

In `src/db/schema.sql`, update the `acceptance_criterion` header comment (the line ending `disposition columns for assessed-satisfied / not-expressible are added at M6.)`) to:

```sql
-- description as a single AC. `source` records which. (M1 writes id/seq/text/source;
-- the per-check disposition lives on ac_check (M3 writes it); the AC-level
-- assessed-satisfied is a rollup M6 projects, so no disposition column lives here.)
```

Update the `ac_check` header comment block so the `red_class`/disposition sentence reads:

```sql
-- `red_class` is the graded taxonomy assertion/absence/environmental (M3 fills, write-once);
-- `disposition` is the green-on-HEAD per-check outcome satisfied/not-expressible (M3 fills).
-- Both are NULL until M3 populates them; M6 projects the AC-level rollup. Per-run verdicts at
-- each sha go to ground_truth_signal, not here.
```

Apply the identical edits to `docs/architecture/schema.sql`.

- [ ] **Step 6: Run the migrate test to verify it passes**

Run: `bun test test/migrate.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/db/schema.sql docs/architecture/schema.sql test/migrate.test.ts
git commit -m "feat(schema): ac_check.disposition + M3 storage-owns comment migration (v5)"
```

---

## Task 2: DB repo additions — `ac-check` classify writers + `signalForAcCheck`

**Files:**
- Modify: `src/db/repos/ac-check.ts`
- Modify: `src/db/repos/ground-truth-signal.ts`
- Test: `test/db/repos/ac-check-classify.test.ts` (create)
- Test: `test/db/repos/signal-for-ac-check.test.ts` (create)

**Interfaces:**
- Produces (`ac-check.ts`):
  - `AcCheckRow` gains `disposition: string | null`.
  - `deleteByAc(db, acId: number): number`
  - `listUnresolvedByTicket(db, ticketId: number): AcCheckRow[]` — rows where `red_class IS NULL AND disposition IS NULL`, `ORDER BY id`.
  - `classifyAcCheck(db, p: { acCheckId: number; redClass?: "assertion"|"absence"|"environmental"; disposition?: "satisfied"|"not-expressible" }): void` — sets the given column(s) + `updated_at`.
- Produces (`ground-truth-signal.ts`):
  - `interface RedFirstDetail { rawOutput: string; exitCode: number | null; framework: string | null; command: string | null; acCheckId: number }`
  - `signalForAcCheck(db, acCheckId: number): { row: GroundTruthSignalRow; detail: RedFirstDetail } | null` — the latest `ac-check-red-first` signal whose `detail_json.acCheckId === acCheckId`.

- [ ] **Step 1: Write the failing repo tests**

Create `test/db/repos/ac-check-classify.test.ts`:

```ts
import { expect, test } from "bun:test";
import {
  classifyAcCheck,
  deleteByAc,
  insertAcCheck,
  listByTicket,
  listUnresolvedByTicket,
} from "../../../src/db/repos/ac-check.ts";
import { insertAc } from "../../../src/db/repos/acceptance-criterion.ts";
import { makeTestDb } from "../../helpers/db.ts";

function seedAc(db: Parameters<typeof insertAc>[0], ticketId: number, seq: number) {
  return insertAc(db, { ticketId, seq, text: `ac ${seq}`, source: "checklist" }).id;
}

test("classifyAcCheck sets red_class and disposition per check; listUnresolvedByTicket excludes classified", () => {
  const { db, ticketId } = makeTestDb();
  const ac1 = seedAc(db, ticketId, 1);
  const ac2 = seedAc(db, ticketId, 2);
  const c1 = insertAcCheck(db, { ticketId, acId: ac1, selector: "s1", redFirstResult: "red" });
  const c2 = insertAcCheck(db, { ticketId, acId: ac2, selector: "s2", redFirstResult: "green" });

  // Both start unresolved.
  expect(listUnresolvedByTicket(db, ticketId).map((r) => r.id).sort()).toEqual(
    [c1.id, c2.id].sort(),
  );

  classifyAcCheck(db, { acCheckId: c1.id, redClass: "assertion" });
  classifyAcCheck(db, { acCheckId: c2.id, disposition: "satisfied" });

  const rows = listByTicket(db, ticketId);
  expect(rows.find((r) => r.id === c1.id)?.red_class).toBe("assertion");
  expect(rows.find((r) => r.id === c2.id)?.disposition).toBe("satisfied");
  // Nothing unresolved now.
  expect(listUnresolvedByTicket(db, ticketId).length).toBe(0);
  db.close();
});

test("deleteByAc removes only that AC's checks", () => {
  const { db, ticketId } = makeTestDb();
  const ac1 = seedAc(db, ticketId, 1);
  const ac2 = seedAc(db, ticketId, 2);
  insertAcCheck(db, { ticketId, acId: ac1, selector: "a" });
  insertAcCheck(db, { ticketId, acId: ac1, selector: "b" });
  insertAcCheck(db, { ticketId, acId: ac2, selector: "c" });

  expect(deleteByAc(db, ac1)).toBe(2);
  const remaining = listByTicket(db, ticketId);
  expect(remaining.length).toBe(1);
  expect(remaining[0]?.ac_id).toBe(ac2);
  db.close();
});
```

Create `test/db/repos/signal-for-ac-check.test.ts`:

```ts
import { expect, test } from "bun:test";
import { insertSignal, signalForAcCheck } from "../../../src/db/repos/ground-truth-signal.ts";
import { makeTestDb } from "../../helpers/db.ts";

test("signalForAcCheck reads the RED-first signal by live ac_check id, not the latest for the AC", () => {
  const { db, ticketId } = makeTestDb();
  // A stale prior-round signal for a now-dead ac_check id 11, then the live row's signal id 22.
  insertSignal(db, {
    ticketId,
    signalType: "ac-check-red-first",
    result: "fail",
    detail: { rawOutput: "stale", exitCode: 1, framework: "pytest", command: "old", acCheckId: 11 },
  });
  insertSignal(db, {
    ticketId,
    signalType: "ac-check-red-first",
    result: "fail",
    detail: { rawOutput: "live", exitCode: 2, framework: "pytest", command: "new", acCheckId: 22 },
  });

  const hit = signalForAcCheck(db, 22);
  expect(hit?.detail.rawOutput).toBe("live");
  expect(hit?.detail.exitCode).toBe(2);
  expect(signalForAcCheck(db, 99)).toBeNull();
  db.close();
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test test/db/repos/ac-check-classify.test.ts test/db/repos/signal-for-ac-check.test.ts`
Expected: FAIL — `classifyAcCheck`/`deleteByAc`/`listUnresolvedByTicket`/`signalForAcCheck` are not exported.

- [ ] **Step 3: Extend `ac-check.ts`**

In `src/db/repos/ac-check.ts`, add `disposition` to the row interface and `COLS`:

```ts
export interface AcCheckRow {
  id: number;
  ticket_id: number;
  ac_id: number;
  selector: string;
  test_path: string | null;
  red_first_result: string | null;
  red_class: string | null;
  disposition: string | null;
  created_at: string;
  updated_at: string;
}

const COLS =
  "id, ticket_id, ac_id, selector, test_path, red_first_result, red_class, disposition, created_at, updated_at";
```

Append these functions (after `deleteByTicket`):

```ts
/** Delete every ac_check row for ONE acceptance criterion (the scoped re-author, §2): a `vacuous`
 *  loopback re-authors only the flagged ACs, so their rows are deleted then re-inserted while every
 *  other AC's classified rows stay frozen. Returns the count removed. */
export function deleteByAc(db: Database, acId: number): number {
  const res = db.query("DELETE FROM ac_check WHERE ac_id = ?").run(acId);
  return Number(res.changes);
}

/** The ticket's checks that are still unresolved: neither graded (`red_class`) nor dispositioned.
 *  `checks:classify` classifies ONLY these — already-classified rows are immutable (write-once, §7). */
export function listUnresolvedByTicket(db: Database, ticketId: number): AcCheckRow[] {
  return db
    .query<AcCheckRow, [number]>(
      `SELECT ${COLS} FROM ac_check
       WHERE ticket_id = ? AND red_class IS NULL AND disposition IS NULL ORDER BY id`,
    )
    .all(ticketId);
}

/** Record a check's classification (M3). A red check gets a `redClass`; a green-on-HEAD check gets a
 *  `disposition`. Exactly one is expected per call; both columns are otherwise write-once (the caller
 *  only ever classifies unresolved rows). */
export function classifyAcCheck(
  db: Database,
  p: {
    acCheckId: number;
    redClass?: "assertion" | "absence" | "environmental";
    disposition?: "satisfied" | "not-expressible";
  },
): void {
  db.query(
    `UPDATE ac_check SET red_class = COALESCE($rc, red_class),
       disposition = COALESCE($disp, disposition), updated_at = $now WHERE id = $id`,
  ).run({
    $id: p.acCheckId,
    $rc: p.redClass ?? null,
    $disp: p.disposition ?? null,
    $now: nowUtc(),
  });
}
```

- [ ] **Step 4: Add `signalForAcCheck` to `ground-truth-signal.ts`**

Append to `src/db/repos/ground-truth-signal.ts`:

```ts
/** The parsed shape M2b's `checks:dispatch` persists in an `ac-check-red-first` signal's detail. */
export interface RedFirstDetail {
  rawOutput: string;
  exitCode: number | null;
  framework: string | null;
  command: string | null;
  acCheckId: number;
}

/** Read the RED-first signal for a check by its LIVE `ac_check.id` (§3 read contract). `ground_truth_signal`
 *  is append-only, so a scoped re-author leaves the previous round's signal behind with a dangling
 *  acCheckId — classifying must key on the live id, never "the latest signal for the AC". Returns the
 *  newest matching signal + its parsed detail, or null. */
export function signalForAcCheck(
  db: Database,
  acCheckId: number,
): { row: GroundTruthSignalRow; detail: RedFirstDetail } | null {
  const row = db
    .query<GroundTruthSignalRow, [number]>(
      `SELECT ${COLS} FROM ground_truth_signal
       WHERE signal_type = 'ac-check-red-first'
         AND json_extract(detail_json, '$.acCheckId') = ?
       ORDER BY id DESC LIMIT 1`,
    )
    .get(acCheckId);
  if (!row) return null;
  return { row, detail: JSON.parse(row.detail_json ?? "{}") as RedFirstDetail };
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `bun test test/db/repos/ac-check-classify.test.ts test/db/repos/signal-for-ac-check.test.ts`
Expected: PASS.

- [ ] **Step 6: Run the full repo suite for regressions**

Run: `bun test test/db/`
Expected: PASS (existing `ac-check` / signal tests unaffected — `disposition` is additive and nullable).

- [ ] **Step 7: Commit**

```bash
git add src/db/repos/ac-check.ts src/db/repos/ground-truth-signal.ts test/db/repos/ac-check-classify.test.ts test/db/repos/signal-for-ac-check.test.ts
git commit -m "feat(db): ac_check classify writers (deleteByAc/classifyAcCheck/listUnresolved) + signalForAcCheck by-live-id"
```

---

## Task 3: The deterministic prior (pure)

**Files:**
- Create: `src/dispatch/classify-prior.ts`
- Test: `test/dispatch/classify-prior.test.ts`

**Interfaces:**
- Consumes: `CoarseResult` (`"green"|"red"|"error"`) from `check-selector.ts`.
- Produces:
  ```ts
  export type PriorVerdict =
    | { kind: "settled-red"; redClass: "absence" | "environmental" }
    | { kind: "adjudicate-red" }
    | { kind: "adjudicate-green" };
  export function classifyPrior(p: { coarse: "green" | "red" | "error"; rawOutput: string }): PriorVerdict;
  ```

**Rule (from §3, deliberately narrow — a miss degrades to "adjudicator decides", never a silent mislabel):**
- `coarse === "error"` (M2's couldn't-attempt) ⇒ `{ settled-red, environmental }`.
- `coarse === "green"` ⇒ `{ adjudicate-green }` (green-on-HEAD, §4).
- `coarse === "red"`:
  - trace shows a clean **own-symbol** import/name error — `cannot import name 'X' from 'Y'` or `NameError: name 'X' is not defined` ⇒ `{ settled-red, absence }`.
  - **NOT** a bare `ModuleNotFoundError: No module named 'Z'` — a whole missing top-level module is ambiguous (third-party env gap vs absent new module) ⇒ `{ adjudicate-red }` (the adjudicator calls absence vs environmental).
  - anything else (assertion failure, etc.) ⇒ `{ adjudicate-red }`.

- [ ] **Step 1: Write the failing test**

Create `test/dispatch/classify-prior.test.ts`:

```ts
import { expect, test } from "bun:test";
import { classifyPrior } from "../../src/dispatch/classify-prior.ts";

test("coarse error → environmental (settled)", () => {
  expect(classifyPrior({ coarse: "error", rawOutput: "" })).toEqual({
    kind: "settled-red",
    redClass: "environmental",
  });
});

test("coarse green → adjudicate-green", () => {
  expect(classifyPrior({ coarse: "green", rawOutput: "1 passed" })).toEqual({
    kind: "adjudicate-green",
  });
});

test("red with own-symbol ImportError → absence (settled)", () => {
  const out = "ImportError: cannot import name 'save_pref' from 'app.prefs'";
  expect(classifyPrior({ coarse: "red", rawOutput: out })).toEqual({
    kind: "settled-red",
    redClass: "absence",
  });
});

test("red with NameError → absence (settled)", () => {
  const out = "E   NameError: name 'save_pref' is not defined";
  expect(classifyPrior({ coarse: "red", rawOutput: out })).toEqual({
    kind: "settled-red",
    redClass: "absence",
  });
});

test("red with a bare ModuleNotFoundError → adjudicate (env vs absence ambiguous)", () => {
  const out = "ModuleNotFoundError: No module named 'redis'";
  expect(classifyPrior({ coarse: "red", rawOutput: out })).toEqual({ kind: "adjudicate-red" });
});

test("red assertion failure → adjudicate (may be a proxy-absence)", () => {
  const out = "E   assert 404 == 201";
  expect(classifyPrior({ coarse: "red", rawOutput: out })).toEqual({ kind: "adjudicate-red" });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test test/dispatch/classify-prior.test.ts`
Expected: FAIL — Cannot find module `classify-prior.ts`.

- [ ] **Step 3: Implement the prior**

Create `src/dispatch/classify-prior.ts`:

```ts
import type { CoarseResult } from "./check-selector.ts";

/** The deterministic prior's verdict (§3). It NEVER outputs `assertion` — an assertion-failed check
 *  is by definition ambiguous (may be a proxy-absence) and always reaches the adjudicator. */
export type PriorVerdict =
  | { kind: "settled-red"; redClass: "absence" | "environmental" }
  | { kind: "adjudicate-red" }
  | { kind: "adjudicate-green" };

// A clean own-symbol import/name error = the code-under-test lacks a symbol the test names = absence
// of the target behavior. A bare `No module named` is deliberately EXCLUDED — a whole missing module
// is ambiguous (third-party env gap vs absent new module), so it goes to the adjudicator.
// Intentionally Python-only signatures. The prior only self-resolves the unambiguous cases; a
// Go/JS own-symbol error simply doesn't match and degrades to the adjudicator (§9 — a prior miss
// never mislabels, it just defers). A bare `ModuleNotFoundError: No module named 'Z'` is NOT here
// (whole-module-missing is absence-vs-environmental ambiguous → adjudicator decides).
const OWN_SYMBOL_ABSENCE = /cannot import name |NameError: name /i;

/** Settle only the unambiguous cases (§3); everything else is the adjudicator's judgment. A miss on
 *  the own-symbol shortcut degrades to `adjudicate-red`, never a silent mislabel (the prior is never
 *  an override). */
export function classifyPrior(p: { coarse: CoarseResult; rawOutput: string }): PriorVerdict {
  if (p.coarse === "error") return { kind: "settled-red", redClass: "environmental" };
  if (p.coarse === "green") return { kind: "adjudicate-green" };
  // coarse === "red"
  if (OWN_SYMBOL_ABSENCE.test(p.rawOutput)) return { kind: "settled-red", redClass: "absence" };
  return { kind: "adjudicate-red" };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test test/dispatch/classify-prior.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/dispatch/classify-prior.ts test/dispatch/classify-prior.test.ts
git commit -m "feat(checks): deterministic classify prior (own-symbol absence / env; never assertion)"
```

---

## Task 4: The adjudicator contract — zod schema + prompt + tier + allowlist + vars

**Files:**
- Create: `src/dispatch/adjudicate-schema.ts`
- Create: `prompts/checks-classify.md`
- Modify: `src/agent/tiers.ts`
- Modify: `src/dispatch/tool-allowlists.ts`
- Modify: `src/dispatch/prompt-vars.ts`
- Test: `test/dispatch/adjudicate-schema.test.ts`
- Test (edit): `test/agent/tiers.test.ts`, `test/dispatch/tool-allowlists.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export const AdjudicationSchema: z.ZodType<{ ac_check_id: number; class: AdjClass; reason: string }>;
  export const ChecksClassifyOutputSchema: z.ZodType<{ classifications: Array<{ ac_check_id: number; class: AdjClass; reason: string }> }>;
  export type AdjClass = "assertion" | "absence" | "environmental" | "vacuous" | "already-satisfied" | "not-expressible";
  ```
  - `CHECKS_CLASSIFY_TEMPLATE: string`
  - `adjudicateVars(ticket, profile, items: AdjudicateItem[]): Record<string,string>` where
    `interface AdjudicateItem { acCheckId: number; acText: string; testPath: string | null; testName: string; coarse: string; rawOutput: string }`.
  - `resolveTier("checks:classify") === "standard"`; `allowlistFor("checks:classify") === ["Read","Grep","Glob"]`.

- [ ] **Step 1: Write the failing schema test**

Create `test/dispatch/adjudicate-schema.test.ts`:

```ts
import { expect, test } from "bun:test";
import { ChecksClassifyOutputSchema } from "../../src/dispatch/adjudicate-schema.ts";

test("accepts a well-formed per-check classification batch", () => {
  const parsed = ChecksClassifyOutputSchema.safeParse({
    classifications: [
      { ac_check_id: 1, class: "assertion", reason: "the failing assert ran against real new behavior" },
      { ac_check_id: 2, class: "vacuous", reason: "asserts True == True, does not exercise the AC" },
    ],
  });
  expect(parsed.success).toBe(true);
});

test("rejects an unknown class label", () => {
  const parsed = ChecksClassifyOutputSchema.safeParse({
    classifications: [{ ac_check_id: 1, class: "flaky", reason: "x" }],
  });
  expect(parsed.success).toBe(false);
});

test("rejects an empty reason", () => {
  const parsed = ChecksClassifyOutputSchema.safeParse({
    classifications: [{ ac_check_id: 1, class: "absence", reason: "" }],
  });
  expect(parsed.success).toBe(false);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test test/dispatch/adjudicate-schema.test.ts`
Expected: FAIL — Cannot find module `adjudicate-schema.ts`.

- [ ] **Step 3: Implement the schema**

Create `src/dispatch/adjudicate-schema.ts`:

```ts
import { z } from "zod";

/** The six labels the M3 adjudicator may return (§5): three red classes for coarse-red checks, three
 *  green-on-HEAD dispositions for coarse-green checks. */
export const AdjClassEnum = z.enum([
  "assertion",
  "absence",
  "environmental",
  "vacuous",
  "already-satisfied",
  "not-expressible",
]);
export type AdjClass = z.infer<typeof AdjClassEnum>;

/** One per-check adjudication. `ac_check_id` echoes the live ac_check.id the runner supplied; `reason`
 *  is the recorded evidence (§6). */
export const AdjudicationSchema = z.object({
  ac_check_id: z.number().int().positive(),
  class: AdjClassEnum,
  reason: z.string().min(1),
});
export type Adjudication = z.infer<typeof AdjudicationSchema>;

/** The `checks:classify` structured-output contract. An absent/malformed sidecar is a transport
 *  failure; a missing per-check element triggers a fault-isolated re-dispatch of only that check (§5),
 *  enforced by the handler — not by this schema (an empty array is well-formed). */
export const ChecksClassifyOutputSchema = z.object({
  classifications: z.array(AdjudicationSchema),
});
export type ChecksClassifyOutput = z.infer<typeof ChecksClassifyOutputSchema>;
```

- [ ] **Step 4: Add the prompt template**

Create `prompts/checks-classify.md`:

```markdown
You are an independent adjudicator for {{ident}}{{title}}. You are judging authored tests that were
run RED-first on a clean HEAD (before any implementation). You have READ-ONLY access (Read/Grep/Glob).
You do NOT run anything — the tests already ran; you interpret their recorded output plus the repo.

For EACH check below, return exactly one classification:

RED checks (the test failed or errored on clean HEAD):
- `assertion` — the failed assertion ran against GENUINELY-EXECUTED new behavior (ground truth). Earn
  this ONLY when the target surface exists and the assertion is a real behavioral expectation. If the
  failure is a 404 / None-from-missing / sentinel standing in for absent behavior, it is NOT assertion.
- `absence` — the test fails because the target surface does not exist yet (a missing route/function/
  symbol; an assertion mediated by a proxy for absence). Named bias, not ground truth.
- `environmental` — the test could not meaningfully run for an environment/setup reason (a genuinely
  missing third-party dependency, a broken fixture, a service that is not up). Advisory. Treat a
  suspiciously-empty "green" or an exception-swallowing pass with skepticism.

GREEN checks (the test passed on clean HEAD — suspicious, since nothing is implemented):
- `vacuous` — the test trivially passes / does not actually exercise the acceptance criterion.
- `already-satisfied` — the AC is genuinely already met by existing code.
- `not-expressible` — a qualitative AC with no natural red state. NEVER fold this into satisfied.

Checks to classify:
{{checks_to_classify}}

Return a fenced `styre-sidecar` block, and nothing else, of this exact shape:

```styre-sidecar
{"classifications":[{"ac_check_id":123,"class":"absence","reason":"POST /preferences route is absent on HEAD; the 404→assert 201 failure is a proxy for the missing surface"}]}
```
```

- [ ] **Step 5: Register the tier + allowlist**

In `src/agent/tiers.ts`, add ONE new line to `TIERS` (the `"checks:dispatch"` entry already exists from M2b — do NOT re-add it; adding it again is a duplicate object key → TS1117):

```ts
  "checks:classify": "standard",
```

In `src/dispatch/tool-allowlists.ts`, add ONE new line to `ALLOWLISTS` (again, `"checks:dispatch"` already exists — add only this):

```ts
  "checks:classify": [...READ_ONLY],
```

- [ ] **Step 6: Add the template export + vars**

In `src/dispatch/prompt-vars.ts`, add the import at the top (alongside the other `prompts/*.md` imports):

```ts
import checksClassifyTemplate from "../../prompts/checks-classify.md" with { type: "text" };
```

Add the export (next to `CHECKS_TEMPLATE`):

```ts
export const CHECKS_CLASSIFY_TEMPLATE = checksClassifyTemplate;
```

Add the item type + vars function (after `checksVars`):

```ts
/** One check the adjudicator must classify: its AC text, the authored test, the coarse RED-first
 *  bucket, and the recorded trace it judges from (never re-run). */
export interface AdjudicateItem {
  acCheckId: number;
  acText: string;
  testPath: string | null;
  testName: string;
  coarse: string;
  rawOutput: string;
}

/** Prompt vars for the `checks:classify` adjudicator (§5). Renders each check as a labeled block with
 *  its recorded trace; the agent echoes `ac_check_id` back in its sidecar. Read-only, plan-blind. */
export function adjudicateVars(
  ticket: { ident: string; title: string | null },
  profile: Profile,
  items: AdjudicateItem[],
): Record<string, string> {
  const blocks = items
    .map(
      (it) =>
        `### ac_check_id=${it.acCheckId} (coarse: ${it.coarse})\n` +
        `Acceptance criterion: ${it.acText}\n` +
        `Test: ${it.testPath ?? "(no path)"} :: ${it.testName}\n` +
        `Recorded RED-first output:\n\`\`\`\n${it.rawOutput || "(empty)"}\n\`\`\``,
    )
    .join("\n\n");
  return {
    ident: ticket.ident,
    title: ticket.title ? ` — ${ticket.title}` : "",
    slug: profile.slug,
    checks_to_classify: blocks,
    ...profile.promptVars,
  };
}
```

- [ ] **Step 7: Extend the tier + allowlist tests**

In `test/agent/tiers.test.ts`, add an assertion that `resolveTier("checks:classify")` is `"standard"` (mirror the existing `checks:dispatch` assertion).

In `test/dispatch/tool-allowlists.test.ts`, add an assertion that `allowlistFor("checks:classify")` equals `["Read", "Grep", "Glob"]` and contains no `"Bash"`/`"Write"` (mirror the existing read-only step assertions).

- [ ] **Step 8: Run the affected tests**

Run: `bun test test/dispatch/adjudicate-schema.test.ts test/agent/tiers.test.ts test/dispatch/tool-allowlists.test.ts test/dispatch/prompt-vars.test.ts`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src/dispatch/adjudicate-schema.ts prompts/checks-classify.md src/agent/tiers.ts src/dispatch/tool-allowlists.ts src/dispatch/prompt-vars.ts test/dispatch/adjudicate-schema.test.ts test/agent/tiers.test.ts test/dispatch/tool-allowlists.test.ts
git commit -m "feat(checks): checks:classify adjudicator contract (zod + prompt + tier/allowlist + vars)"
```

---

## Task 5: The `checks:classify` handler (prior → adjudicator → persist)

**Files:**
- Modify: `src/dispatch/handlers.ts` (register `checks:classify`; new imports)
- Test: `test/dispatch/checks-classify-handler.test.ts`

**Interfaces:**
- Consumes: `classifyPrior` (Task 3); `signalForAcCheck`/`RedFirstDetail` (Task 2); `listUnresolvedByTicket`/`classifyAcCheck` (Task 2); `ChecksClassifyOutputSchema`/`AdjClass` (Task 4); `CHECKS_CLASSIFY_TEMPLATE`/`adjudicateVars`/`AdjudicateItem` (Task 4); `runAgentDispatch`, `extractSidecar`.
- Produces: a registered `checks:classify` handler returning `{ classified: number; adjudicated: number; vacuous: number }`. It writes, per unresolved check: `red_class` OR `disposition` on `ac_check`, and one `ac-check-classification` `ground_truth_signal` (`detail = { acCheckId, acId, class, reason }`) — a `vacuous` check gets the signal but NO column set (it will trigger a re-author). All persistence in one `db.transaction`.

**Class → storage map (validated against the check's coarse bucket):**
- coarse `red` (or `error`) → class must be `assertion`|`absence`|`environmental` → `classifyAcCheck({ redClass })`; signal `result: "fail"`.
- coarse `green` → class must be `already-satisfied`|`not-expressible`|`vacuous`.
  - `already-satisfied` → `classifyAcCheck({ disposition: "satisfied" })`; signal `result: "pass"`.
  - `not-expressible` → `classifyAcCheck({ disposition: "not-expressible" })`; signal `result: "pass"`.
  - `vacuous` → no column; signal `result: "fail"` (read by `applyChecksVerdict`, Task 6).
- A class outside the coarse bucket's allowed set = a contract violation → throw (transport failure → the whole step re-dispatches).

- [ ] **Step 1: Write the failing handler test**

Create `test/dispatch/checks-classify-handler.test.ts`:

```ts
import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeAgentRunner } from "../../src/agent/fake-runner.ts";
import { DEFAULT_AGENT_CONFIG } from "../../src/config/agent-config.ts";
import { insertAc } from "../../src/db/repos/acceptance-criterion.ts";
import { insertAcCheck, listByTicket as listAcChecks } from "../../src/db/repos/ac-check.ts";
import {
  insertSignal,
  listByTicket as listSignals,
} from "../../src/db/repos/ground-truth-signal.ts";
import { buildDispatchRegistry } from "../../src/dispatch/handlers.ts";
import { parseProfile } from "../../src/dispatch/profile.ts";
import { runStep } from "../../src/engine/step-journal.ts";
import { makeTestDb } from "../helpers/db.ts";

function gitRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "styre-cc-"));
  const run = (a: string[]) => Bun.spawnSync(["git", ...a], { cwd: root });
  run(["init", "-b", "main"]);
  run(["config", "user.email", "t@s.dev"]);
  run(["config", "user.name", "T"]);
  Bun.write(join(root, "README.md"), "x");
  run(["add", "-A"]);
  run(["commit", "-m", "init"]);
  return root;
}

/** Seed one AC + one ac_check with a given coarse result and its RED-first signal, returning the
 *  ac_check id. */
function seedCheck(
  db: ReturnType<typeof makeTestDb>["db"],
  ticketId: number,
  seq: number,
  coarse: "red" | "green" | "error",
  rawOutput: string,
) {
  const ac = insertAc(db, { ticketId, seq, text: `ac ${seq}`, source: "checklist" }).id;
  const row = insertAcCheck(db, {
    ticketId,
    acId: ac,
    selector: `s${seq}`,
    testPath: `t${seq}.py`,
    redFirstResult: coarse,
  });
  insertSignal(db, {
    ticketId,
    signalType: "ac-check-red-first",
    result: coarse === "green" ? "pass" : coarse === "red" ? "fail" : "error",
    detail: { rawOutput, exitCode: coarse === "green" ? 0 : 1, framework: "pytest", command: "c", acCheckId: row.id },
  });
  return { acId: ac, acCheckId: row.id };
}

function registryWith(repo: string, runner: FakeAgentRunner) {
  return buildDispatchRegistry({
    runner,
    agentConfig: DEFAULT_AGENT_CONFIG,
    profile: parseProfile({
      slug: "demo",
      targetRepo: repo,
      components: [{ name: "api", kind: "python", paths: ["**"], commands: { test: "pytest -q" } }],
    }),
    worktreeRoot: mkdtempSync(join(tmpdir(), "styre-ccwt-")),
  });
}

test("prior settles absence/environmental; adjudicator classes an assertion-red and a green disposition", async () => {
  const { db, ticketId, projectId } = makeTestDb();
  const repo = gitRepo();
  db.query("UPDATE project SET target_repo = ? WHERE id = ?").run(repo, projectId);

  // c1: red own-symbol import error → prior settles absence (no adjudication).
  const c1 = seedCheck(db, ticketId, 1, "red", "ImportError: cannot import name 'save_pref' from 'app.prefs'");
  // c2: red assertion → adjudicate → assertion.
  const c2 = seedCheck(db, ticketId, 2, "red", "E   assert 404 == 201");
  // c3: coarse error → prior settles environmental.
  const c3 = seedCheck(db, ticketId, 3, "error", "could not attempt");
  // c4: green → adjudicate → already-satisfied.
  const c4 = seedCheck(db, ticketId, 4, "green", "1 passed");

  const runner = new FakeAgentRunner(() => ({
    completed: true,
    exitCode: 0,
    stdout:
      "```styre-sidecar\n" +
      JSON.stringify({
        classifications: [
          { ac_check_id: c2.acCheckId, class: "assertion", reason: "real behavioral assert" },
          { ac_check_id: c4.acCheckId, class: "already-satisfied", reason: "met by existing code" },
        ],
      }) +
      "\n```",
    stderr: "",
    timedOut: false,
    costUsd: null,
    tokensIn: null,
    tokensOut: null,
  }));

  const registry = registryWith(repo, runner);
  await runStep(db, {
    ticketId,
    stepKey: "checks:classify",
    stepType: "dispatch",
    effectful: true,
    execute: (step) =>
      registry.resolve("checks:classify")!({
        db,
        ticket: { id: ticketId, ident: "ENG-1", title: null, project_id: projectId, stage: "design" } as never,
        step,
        workUnitId: null,
        config: undefined as never,
      }),
  });

  const rows = listAcChecks(db, ticketId);
  const byId = new Map(rows.map((r) => [r.id, r]));
  expect(byId.get(c1.acCheckId)?.red_class).toBe("absence");
  expect(byId.get(c2.acCheckId)?.red_class).toBe("assertion");
  expect(byId.get(c3.acCheckId)?.red_class).toBe("environmental");
  expect(byId.get(c4.acCheckId)?.disposition).toBe("satisfied");
  // one classification-evidence signal per check
  const cls = listSignals(db, ticketId).filter((s) => s.signal_type === "ac-check-classification");
  expect(cls.length).toBe(4);
  db.close();
});

test("a vacuous green sets NO column but records a vacuous classification signal", async () => {
  const { db, ticketId, projectId } = makeTestDb();
  const repo = gitRepo();
  db.query("UPDATE project SET target_repo = ? WHERE id = ?").run(repo, projectId);
  const c1 = seedCheck(db, ticketId, 1, "green", "1 passed");

  const runner = new FakeAgentRunner(() => ({
    completed: true,
    exitCode: 0,
    stdout:
      "```styre-sidecar\n" +
      JSON.stringify({ classifications: [{ ac_check_id: c1.acCheckId, class: "vacuous", reason: "asserts True" }] }) +
      "\n```",
    stderr: "",
    timedOut: false,
    costUsd: null,
    tokensIn: null,
    tokensOut: null,
  }));
  const registry = registryWith(repo, runner);
  await runStep(db, {
    ticketId,
    stepKey: "checks:classify",
    stepType: "dispatch",
    effectful: true,
    execute: (step) =>
      registry.resolve("checks:classify")!({
        db,
        ticket: { id: ticketId, ident: "ENG-1", title: null, project_id: projectId, stage: "design" } as never,
        step,
        workUnitId: null,
        config: undefined as never,
      }),
  });
  const row = listAcChecks(db, ticketId)[0];
  expect(row?.red_class).toBeNull();
  expect(row?.disposition).toBeNull();
  const vac = listSignals(db, ticketId).filter(
    (s) => s.signal_type === "ac-check-classification" && JSON.parse(s.detail_json ?? "{}").class === "vacuous",
  );
  expect(vac.length).toBe(1);
  db.close();
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test test/dispatch/checks-classify-handler.test.ts`
Expected: FAIL — `registry.resolve("checks:classify")` is `undefined` (handler not registered).

- [ ] **Step 3: Add imports to `handlers.ts`**

In `src/dispatch/handlers.ts`, extend the existing imports:

```ts
import {
  classifyAcCheck,
  deleteByAc,
  deleteByTicket,
  insertAcCheck,
  listUnresolvedByTicket,
} from "../db/repos/ac-check.ts";
```

```ts
import {
  insertSignal,
  listByUnit,
  listByTicket as listSignalsByTicket,
  signalForAcCheck,
} from "../db/repos/ground-truth-signal.ts";
```

Add new imports:

```ts
import { classifyPrior } from "./classify-prior.ts";
import { type AdjClass, ChecksClassifyOutputSchema } from "./adjudicate-schema.ts";
import { CHECKS_CLASSIFY_TEMPLATE, type AdjudicateItem, adjudicateVars } from "./prompt-vars.ts";
```

(`CoarseResult` is already imported from `./check-selector.ts`.)

- [ ] **Step 4: Register the handler**

In `buildDispatchRegistry`, immediately after the `checks:dispatch` registration, add:

```ts
  registry.register("checks:classify", async (ctx: HandlerContext) => {
    // Classify ONLY unresolved rows (§7 write-once): a re-author round re-classifies only the freshly
    // re-authored NULL rows; every previously-classified row is frozen.
    const unresolved = listUnresolvedByTicket(ctx.db, ctx.ticket.id);
    if (unresolved.length === 0) return { classified: 0, adjudicated: 0, vacuous: 0 };

    const acs = listAcs(ctx.db, ctx.ticket.id);
    const acTextById = new Map(acs.map((a) => [a.id, a.text]));

    // 1) Read each check's RED-first trace by LIVE id (§3), run the prior.
    type Pending = { row: (typeof unresolved)[number]; coarse: CoarseResult; item: AdjudicateItem };
    const settled: Array<{ acCheckId: number; acId: number; redClass: "absence" | "environmental" }> = [];
    const pending: Pending[] = [];
    for (const row of unresolved) {
      const sig = signalForAcCheck(ctx.db, row.id);
      const coarse = (row.red_first_result ?? "error") as CoarseResult;
      const rawOutput = sig?.detail.rawOutput ?? "";
      const prior = classifyPrior({ coarse, rawOutput });
      if (prior.kind === "settled-red") {
        settled.push({ acCheckId: row.id, acId: row.ac_id, redClass: prior.redClass });
        continue;
      }
      pending.push({
        row,
        coarse,
        item: {
          acCheckId: row.id,
          acText: acTextById.get(row.ac_id) ?? "",
          testPath: row.test_path,
          testName: row.selector,
          coarse,
          rawOutput,
        },
      });
    }

    // 2) Adjudicate the ambiguous checks (agent-skip when the prior settled everything, §5). A
    //    missing per-check result re-dispatches ONLY the affected checks (fault isolation), bounded.
    const results = new Map<number, AdjClass>();
    const reasons = new Map<number, string>();
    let toAsk = pending;
    for (let round = 0; round < 2 && toAsk.length > 0; round++) {
      const { output } = await runAgentDispatch(
        ctx,
        depsFor(ctx, deps, deps.timeoutMs ?? DEFAULT_TIMEOUT_MS),
        {
          handlerKey: "checks:classify",
          template: CHECKS_CLASSIFY_TEMPLATE,
          vars: adjudicateVars(ctx.ticket, deps.profile, toAsk.map((p) => p.item)),
          postcondition: () => {}, // read-only: nothing commits
        },
      );
      const parsed = extractSidecar(output, ChecksClassifyOutputSchema);
      if (parsed.ok) {
        const asked = new Set(toAsk.map((p) => p.row.id));
        for (const c of parsed.value.classifications) {
          if (!asked.has(c.ac_check_id)) continue; // ignore ids we did not ask about
          results.set(c.ac_check_id, c.class);
          reasons.set(c.ac_check_id, c.reason);
        }
      }
      toAsk = toAsk.filter((p) => !results.has(p.row.id));
    }
    if (toAsk.length > 0) {
      // Absent after the fault-isolated bound = transport failure → failure-policy re-dispatches.
      throw new Error(
        `checks:classify: adjudicator omitted ${toAsk.length} check(s): ${toAsk.map((p) => p.row.id).join(", ")}`,
      );
    }

    // 3) Validate class↔coarse bucket, map to storage, persist ALL in one txn (crash-resume: an
    //    interrupted classify rolls back whole; §7 recompute-all-in-txn).
    const RED_CLASSES = new Set<AdjClass>(["assertion", "absence", "environmental"]);
    const GREEN_CLASSES = new Set<AdjClass>(["vacuous", "already-satisfied", "not-expressible"]);
    let vacuous = 0;
    ctx.db.transaction(() => {
      for (const s of settled) {
        classifyAcCheck(ctx.db, { acCheckId: s.acCheckId, redClass: s.redClass });
        insertSignal(ctx.db, {
          ticketId: ctx.ticket.id,
          signalType: "ac-check-classification",
          result: "fail",
          detail: { acCheckId: s.acCheckId, acId: s.acId, class: s.redClass, reason: "deterministic prior" },
        });
      }
      for (const p of pending) {
        const cls = results.get(p.row.id) as AdjClass;
        const reason = reasons.get(p.row.id) ?? "";
        const isGreen = p.coarse === "green";
        if (isGreen ? !GREEN_CLASSES.has(cls) : !RED_CLASSES.has(cls)) {
          throw new Error(`checks:classify: class '${cls}' invalid for coarse '${p.coarse}' (check ${p.row.id})`);
        }
        if (cls === "vacuous") {
          vacuous += 1; // no column set — triggers a re-author (§7); recorded as a signal for the verdict
        } else if (cls === "already-satisfied") {
          classifyAcCheck(ctx.db, { acCheckId: p.row.id, disposition: "satisfied" });
        } else if (cls === "not-expressible") {
          classifyAcCheck(ctx.db, { acCheckId: p.row.id, disposition: "not-expressible" });
        } else {
          classifyAcCheck(ctx.db, { acCheckId: p.row.id, redClass: cls as "assertion" | "absence" | "environmental" });
        }
        insertSignal(ctx.db, {
          ticketId: ctx.ticket.id,
          signalType: "ac-check-classification",
          result: cls === "already-satisfied" || cls === "not-expressible" ? "pass" : "fail",
          detail: { acCheckId: p.row.id, acId: p.row.ac_id, class: cls, reason },
        });
      }
    })();

    return { classified: settled.length + pending.length, adjudicated: pending.length, vacuous };
  });
```

- [ ] **Step 5: Run the handler tests to verify they pass**

Run: `bun test test/dispatch/checks-classify-handler.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 6: Commit**

```bash
git add src/dispatch/handlers.ts test/dispatch/checks-classify-handler.test.ts
git commit -m "feat(checks): checks:classify handler — prior→adjudicator→persist red_class/disposition + evidence"
```

---

## Task 6: The verdict path — `applyChecksVerdict` + advance wiring + `checksFeedback`

**Files:**
- Create: `src/daemon/checks-verdict.ts`
- Create: `src/dispatch/checks-feedback.ts`
- Modify: `src/daemon/advance.ts`
- Test: `test/daemon/checks-verdict.test.ts`

**Interfaces:**
- Consumes: `listByTicket` (ac-check + ground-truth-signal), `deleteByAc`, `appendEvent`/`listByTicket` (event-log), `getByKey`/`resetToPending` (workflow-step), `setTicketStatus`, `insertPending as insertSignal` (signal).
- Produces (`checks-verdict.ts`):
  ```ts
  export function applyChecksVerdict(db, ticketId, opts: { stepKey: string }): { decision: "clean" | "loopback" | "escalated" };
  export function latestChecksReauthorAcs(db, ticketId): number[] | null; // the flagged AC ids of the latest loop==="checks" event, else null
  ```
- Produces (`checks-feedback.ts`): `export function checksFeedback(db, ticketId): string;`

**Semantics (mirror `review-verdict`):**
- Read live `ac_check` ids; read `ac-check-classification` signals whose `detail.acCheckId` is a LIVE id and `detail.class === "vacuous"` → collect distinct `detail.acId`. (Dead-id signals from prior rounds are skipped — the by-live-id contract, §3/§7.)
- No vacuous AC → `{ decision: "clean" }` (resolver advances design→implement).
- Signature `checks:${sortedAcIds.join(",")}` (keyed on **(ac_ids,"vacuous")**, §7). If the previous `loop==="checks"` loopback carried the same signature → `escalate` (`{ decision: "escalated" }`).
- Else `checksLoopback`: in one txn — `deleteByAc` each flagged AC; `resetToPending` the `checks:dispatch` + `checks:classify` steps; `appendEvent { kind:"loopback", loop:"checks", routeTo:"checks:classify", signature, payload:{ acIds, findings:[{acId,reason}] } }`. **No stage flip.** → `{ decision: "loopback" }`.

- [ ] **Step 1: Write the failing verdict test**

Create `test/daemon/checks-verdict.test.ts`:

```ts
import { expect, test } from "bun:test";
import { applyChecksVerdict } from "../../src/daemon/checks-verdict.ts";
import { insertAc } from "../../src/db/repos/acceptance-criterion.ts";
import { insertAcCheck, listByTicket as listAcChecks } from "../../src/db/repos/ac-check.ts";
import { appendEvent } from "../../src/db/repos/event-log.ts";
import { insertSignal } from "../../src/db/repos/ground-truth-signal.ts";
import { getTicket } from "../../src/db/repos/ticket.ts";
import { insertPending, getByKey } from "../../src/db/repos/workflow-step.ts";
import { makeTestDb } from "../helpers/db.ts";

function seedVacuous(db: ReturnType<typeof makeTestDb>["db"], ticketId: number, seq: number) {
  const acId = insertAc(db, { ticketId, seq, text: `ac ${seq}`, source: "checklist" }).id;
  const row = insertAcCheck(db, { ticketId, acId, selector: `s${seq}`, redFirstResult: "green" });
  insertSignal(db, {
    ticketId,
    signalType: "ac-check-classification",
    result: "fail",
    detail: { acCheckId: row.id, acId, class: "vacuous", reason: "trivial" },
  });
  return { acId, acCheckId: row.id };
}

test("no vacuous checks → clean", () => {
  const { db, ticketId } = makeTestDb();
  const acId = insertAc(db, { ticketId, seq: 1, text: "ac", source: "checklist" }).id;
  insertAcCheck(db, { ticketId, acId, selector: "s", redFirstResult: "red" });
  expect(applyChecksVerdict(db, ticketId, { stepKey: "checks:classify" })).toEqual({ decision: "clean" });
  db.close();
});

test("a vacuous check loops back: flagged AC's checks deleted, checks:dispatch+classify reset, event appended, stage stays design", () => {
  const { db, ticketId } = makeTestDb();
  insertPending(db, { ticketId, stepKey: "checks:dispatch", stepType: "dispatch" });
  insertPending(db, { ticketId, stepKey: "checks:classify", stepType: "dispatch" });
  db.query("UPDATE workflow_step SET status = 'succeeded'").run();
  const { acId } = seedVacuous(db, ticketId, 1);

  const res = applyChecksVerdict(db, ticketId, { stepKey: "checks:classify" });
  expect(res.decision).toBe("loopback");
  expect(listAcChecks(db, ticketId).length).toBe(0); // flagged AC's checks deleted
  expect(getByKey(db, ticketId, "checks:dispatch")?.status).toBe("pending");
  expect(getByKey(db, ticketId, "checks:classify")?.status).toBe("pending");
  expect(getTicket(db, ticketId)?.stage).toBe("design"); // no flip
  db.close();
});

test("repeated identical (ac_ids,vacuous) signature → escalate", () => {
  const { db, ticketId } = makeTestDb();
  const { acId } = seedVacuous(db, ticketId, 1);
  // Prior checks-loopback with the same signature.
  appendEvent(db, {
    ticketId,
    kind: "loopback",
    loop: "checks",
    routeTo: "checks:classify",
    signature: `checks:${acId}`,
  });
  const res = applyChecksVerdict(db, ticketId, { stepKey: "checks:classify" });
  expect(res.decision).toBe("escalated");
  expect(getTicket(db, ticketId)?.status).toBe("waiting");
  db.close();
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test test/daemon/checks-verdict.test.ts`
Expected: FAIL — Cannot find module `checks-verdict.ts`.

- [ ] **Step 3: Implement `checks-verdict.ts`**

Create `src/daemon/checks-verdict.ts`:

```ts
import type { Database } from "bun:sqlite";
import { deleteByAc, listByTicket as listAcChecks } from "../db/repos/ac-check.ts";
import { appendEvent, listByTicket as listEvents } from "../db/repos/event-log.ts";
import { listByTicket as listSignals } from "../db/repos/ground-truth-signal.ts";
import { insertPending as insertSignal } from "../db/repos/signal.ts";
import { setTicketStatus } from "../db/repos/ticket.ts";
import { getByKey, resetToPending } from "../db/repos/workflow-step.ts";

export interface ChecksVerdictResult {
  decision: "clean" | "loopback" | "escalated";
}

interface VacuousFinding {
  acId: number;
  reason: string;
}

/** The vacuous findings of the CURRENT round: classification signals of class `vacuous` whose
 *  acCheckId is a LIVE ac_check row (§3/§7 by-live-id — a re-author deletes the prior round's rows,
 *  so its stale vacuous signals point to dead ids and drop out). Distinct by AC. */
function currentVacuousFindings(db: Database, ticketId: number): VacuousFinding[] {
  const liveIds = new Set(listAcChecks(db, ticketId).map((r) => r.id));
  const byAc = new Map<number, string>();
  for (const s of listSignals(db, ticketId)) {
    if (s.signal_type !== "ac-check-classification") continue;
    const d = JSON.parse(s.detail_json ?? "{}") as { acCheckId?: number; acId?: number; class?: string; reason?: string };
    if (d.class !== "vacuous" || d.acCheckId === undefined || !liveIds.has(d.acCheckId)) continue;
    if (d.acId !== undefined) byAc.set(d.acId, d.reason ?? "");
  }
  return [...byAc.entries()].map(([acId, reason]) => ({ acId, reason }));
}

/** Signature keyed on (ac_ids, "vacuous") (§7): scoping makes a stuck AC produce a repeated,
 *  AC-keyed finding across re-authors even though the check text differs. */
function vacuousSignature(findings: VacuousFinding[]): string {
  return `checks:${findings.map((f) => f.acId).sort((a, b) => a - b).join(",")}`;
}

/** True when the previous checks-origin loopback carried the same signature (no progress). */
function isRepeatedChecksLoopback(db: Database, ticketId: number, signature: string): boolean {
  const prior = listEvents(db, ticketId).filter((e) => e.kind === "loopback" && e.loop === "checks");
  return prior[prior.length - 1]?.signature === signature;
}

/** The flagged AC ids of the latest checks re-author event (or null). `checks:dispatch` reads this to
 *  scope its re-author to only those ACs (§2b). */
export function latestChecksReauthorAcs(db: Database, ticketId: number): number[] | null {
  const events = listEvents(db, ticketId).filter((e) => e.kind === "loopback" && e.loop === "checks");
  const latest = events[events.length - 1];
  if (!latest?.payload_json) return null;
  const acIds = (JSON.parse(latest.payload_json) as { acIds?: number[] }).acIds;
  return acIds && acIds.length > 0 ? acIds : null;
}

function escalate(db: Database, ticketId: number, reason: string, signature: string): void {
  db.transaction(() => {
    setTicketStatus(db, ticketId, "waiting");
    insertSignal(db, { ticketId, signalType: "human_resume", reason });
    appendEvent(db, { ticketId, kind: "escalated", reason, signature });
  })();
}

function checksLoopback(db: Database, ticketId: number, findings: VacuousFinding[], signature: string): void {
  db.transaction(() => {
    for (const f of findings) deleteByAc(db, f.acId); // scoped: only the flagged ACs' checks
    for (const key of ["checks:dispatch", "checks:classify"]) {
      const step = getByKey(db, ticketId, key);
      if (step) resetToPending(db, step.id);
    }
    // No stage flip — checks:dispatch + checks:classify are both in the design stage.
    appendEvent(db, {
      ticketId,
      kind: "loopback",
      loop: "checks",
      routeTo: "checks:classify",
      signature,
      payload: { acIds: findings.map((f) => f.acId), findings },
    });
  })();
}

/** M3 verdict (§2/§7): a `vacuous` green-on-HEAD check triggers an AC-scoped re-author loopback;
 *  a repeated (ac_ids,"vacuous") signature escalates. Ground-truth over self-report — reads the
 *  persisted classification signals, never an agent verdict. Mirrors `applyReviewVerdict`. */
export function applyChecksVerdict(
  db: Database,
  ticketId: number,
  _opts: { stepKey: string },
): ChecksVerdictResult {
  const findings = currentVacuousFindings(db, ticketId);
  if (findings.length === 0) return { decision: "clean" };
  const signature = vacuousSignature(findings);
  if (isRepeatedChecksLoopback(db, ticketId, signature)) {
    escalate(db, ticketId, "no progress: identical vacuous-check AC(s) after re-author", signature);
    return { decision: "escalated" };
  }
  checksLoopback(db, ticketId, findings, signature);
  return { decision: "loopback" };
}
```

- [ ] **Step 4: Wire the verdict into `advance.ts`**

In `src/daemon/advance.ts`, add the import:

```ts
import { applyChecksVerdict } from "./checks-verdict.ts";
```

Change the verdict-bearing set:

```ts
const VERDICT_BEARING_STEPS = new Set(["review", "design:review", "checks:classify"]);
```

Change the `onSucceed` branch so `checks:classify` routes to `applyChecksVerdict` (both return `{ decision }`, so the existing `verdictBox`/outcome handling is unchanged):

```ts
        onSucceed: VERDICT_BEARING_STEPS.has(d.stepKey)
          ? () => {
              const cfg = opts?.config ?? DEFAULT_RUNTIME_CONFIG;
              verdictBox.value =
                d.stepKey === "checks:classify"
                  ? applyChecksVerdict(db, ticketId, { stepKey: d.stepKey })
                  : applyReviewVerdict(db, ticketId, cfg, { stepKey: d.stepKey });
            }
          : undefined,
```

(`verdictBox` is typed `{ value: ReviewVerdictResult | null }`. `ChecksVerdictResult` is structurally identical (`{ decision: "clean" | "loopback" | "escalated" }`), so it assigns cleanly; if TS complains, widen the box type to `{ value: { decision: "clean" | "loopback" | "escalated" } | null }`.)

- [ ] **Step 5: Implement `checks-feedback.ts`**

Create `src/dispatch/checks-feedback.ts`:

```ts
import type { Database } from "bun:sqlite";
import { listByTicket as listEvents } from "../db/repos/event-log.ts";

interface VacuousFinding {
  acId: number;
  reason: string;
}

/** Corrective feedback for a scoped re-author `checks:dispatch` (paralleling `designFeedback`): the
 *  vacuous findings that forced the latest checks loopback, so the re-author knows WHY each flagged
 *  AC's prior check was vacuous. Empty when there is no prior checks loopback (fresh dispatch). */
export function checksFeedback(db: Database, ticketId: number): string {
  const events = listEvents(db, ticketId).filter((e) => e.kind === "loopback" && e.loop === "checks");
  const latest = events[events.length - 1];
  if (!latest?.payload_json) return "";
  const findings = (JSON.parse(latest.payload_json) as { findings?: VacuousFinding[] }).findings;
  if (!findings || findings.length === 0) return "";
  const lines = findings.map((f) => `- AC ${f.acId}: prior check was vacuous — ${f.reason}`);
  return `## Prior check feedback (re-author to actually exercise the AC)\n\nA prior authored check trivially passed on clean HEAD without testing the criterion. Write a check that would genuinely FAIL until the behavior is implemented:\n${lines.join("\n")}`;
}
```

- [ ] **Step 6: Run the verdict test to verify it passes**

Run: `bun test test/daemon/checks-verdict.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 7: Run the daemon suite for regressions**

Run: `bun test test/daemon/advance.test.ts test/daemon/review-verdict.test.ts`
Expected: PASS (the `onSucceed` change is behavior-preserving for `review`/`design:review`).

- [ ] **Step 8: Commit**

```bash
git add src/daemon/checks-verdict.ts src/dispatch/checks-feedback.ts src/daemon/advance.ts test/daemon/checks-verdict.test.ts
git commit -m "feat(daemon): applyChecksVerdict — AC-scoped vacuous re-author loopback + escalate-on-repeat"
```

---

## Task 7: The M2b scoped-re-author branch in `checks:dispatch`

**Files:**
- Modify: `src/dispatch/handlers.ts` (the `checks:dispatch` handler)
- Modify: `src/dispatch/prompt-vars.ts` (`checksVars` gains `checks_feedback`)
- Modify: `prompts/checks.md` (a `{{checks_feedback}}` slot)
- Test: covered by Task 9's `checks-reauthor-e2e.test.ts`; a focused unit assertion is added here.

**Interfaces:**
- Consumes: `latestChecksReauthorAcs` (Task 6), `deleteByAc` (Task 2), `checksFeedback` (Task 6).
- Behavior: when a `loop==="checks"` re-author event exists, `checks:dispatch` re-authors ONLY the flagged ACs — the agent sees only those ACs, coverage is required only for those, and persistence does `deleteByAc(flagged)` + insert-flagged (leaving every other AC's rows intact). A fresh/crash-resume dispatch (no checks event) keeps the whole-ticket `deleteByTicket` + insert-all.

- [ ] **Step 1: Add the `checks_feedback` prompt slot**

In `prompts/checks.md`, add near the top of the body (before the acceptance-criteria list) a line:

```markdown
{{checks_feedback}}
```

In `src/dispatch/prompt-vars.ts`, add `checksFeedback` to `checksVars`. First add the import:

```ts
import { checksFeedback } from "./checks-feedback.ts";
```

Then thread a `db` param through — **but** `checksVars` currently takes `(ticket, profile, acs)`. To avoid a DB dependency in `prompt-vars.ts`, instead accept the pre-rendered feedback string:

```ts
export function checksVars(
  ticket: { ident: string; title: string | null },
  profile: Profile,
  acs: { id: number; text: string }[],
  feedback = "",
): Record<string, string> {
  return {
    ident: ticket.ident,
    title: ticket.title ?? "",
    slug: profile.slug,
    detected_stacks: detectedStacksVar(profile),
    acceptance_criteria: acs.map((a) => `- ac_id=${a.id}: ${a.text}`).join("\n"),
    checks_feedback: feedback,
    ...profile.promptVars,
  };
}
```

(Remove the now-unused `checksFeedback` import if you added it here — it is called from the handler, not `prompt-vars.ts`. Keep `prompt-vars.ts` DB-free.)

- [ ] **Step 2: Rework the `checks:dispatch` handler's scope**

In `src/dispatch/handlers.ts`, add the imports:

```ts
import { checksFeedback } from "./checks-feedback.ts";
import { latestChecksReauthorAcs } from "../daemon/checks-verdict.ts";
```

At the top of the `checks:dispatch` handler, after `deriveAndPersistAcs` and the `acs`/`acIds` setup, compute the scope:

```ts
    deriveAndPersistAcs(ctx.db, ctx.ticket.id);
    const allAcs = listAcs(ctx.db, ctx.ticket.id);
    if (allAcs.length === 0) return { authored: 0, acs: 0 };
    // Scoped re-author (§2b): a loop==="checks" event re-authors ONLY its flagged ACs; a fresh/
    // crash-resume dispatch re-authors the whole ticket. `scoped` drives the agent's AC list, the
    // coverage postcondition, and the delete strategy — all three must agree.
    const flaggedAcs = latestChecksReauthorAcs(ctx.db, ctx.ticket.id);
    const scoped = flaggedAcs !== null;
    const acs = scoped ? allAcs.filter((a) => flaggedAcs.includes(a.id)) : allAcs;
    const acIds = new Set(acs.map((a) => a.id));
```

Pass the feedback into `checksVars`:

```ts
        vars: checksVars(ctx.ticket, deps.profile, acs, checksFeedback(ctx.db, ctx.ticket.id)),
```

The per-check loop and the `covered`/postcondition already iterate `parsed.value.checksAuthored` filtered by `acIds` (now the scoped set) — no change needed there, because `acIds` is the scoped set and the postcondition iterates `acs` (also scoped).

Replace the persist transaction's delete strategy:

```ts
    ctx.db.transaction(() => {
      if (scoped) {
        for (const acId of acIds) deleteByAc(ctx.db, acId); // leave every non-flagged AC's rows frozen
      } else {
        deleteByTicket(ctx.db, ctx.ticket.id);
      }
      for (const r of records) {
        const row = insertAcCheck(ctx.db, {
          ticketId: ctx.ticket.id,
          acId: r.acId,
          selector: r.selector,
          testPath: r.testPath,
          redFirstResult: r.coarse,
        });
        insertSignal(ctx.db, {
          ticketId: ctx.ticket.id,
          signalType: "ac-check-red-first",
          result: signalResultForCoarse(r.coarse),
          branchHeadSha: sha,
          detail: {
            rawOutput: r.rawOutput,
            exitCode: r.exitCode,
            framework: r.framework,
            command: r.command,
            acCheckId: row.id,
          },
        });
      }
    })();
```

- [ ] **Step 3: Run the existing checks-handler tests (fresh-dispatch path unchanged)**

Run: `bun test test/dispatch/checks-handler.test.ts`
Expected: PASS — no checks-loopback event exists in those tests, so `scoped=false` and the whole-ticket path is exactly as before.

- [ ] **Step 4: Add a focused scoped-re-author assertion**

Append to `test/dispatch/checks-handler.test.ts` a test that: seeds 2 ACs, inserts 2 ac_checks (one per AC) with classified `red_class` on AC-2's check, appends a `loop:"checks"` event with `payload:{acIds:[<ac1>]}`, resets `checks:dispatch` to pending, then drives the handler with a FakeAgentRunner authoring one new file for AC-1 only, and asserts AC-2's original ac_check row is untouched while AC-1's row was replaced. (Reuse the `gitRepo` + registry pattern already in the file. The runner's sidecar returns a single `checksAuthored` entry for `ac_id` = AC-1.)

- [ ] **Step 5: Run it**

Run: `bun test test/dispatch/checks-handler.test.ts`
Expected: PASS (the new scoped test + the two existing tests).

- [ ] **Step 6: Commit**

```bash
git add src/dispatch/handlers.ts src/dispatch/prompt-vars.ts prompts/checks.md test/dispatch/checks-handler.test.ts
git commit -m "feat(checks): scoped re-author branch in checks:dispatch (deleteByAc flagged only) + checks_feedback"
```

---

## Task 8: The resolver insert + affected-test updates

**Files:**
- Modify: `src/daemon/resolver.ts` (the `design` case)
- Modify: `test/daemon/resolver.test.ts`, `test/daemon/advance.test.ts`, `test/dispatch/design-size-e2e.test.ts`, `test/dispatch/design-review-e2e.test.ts`, `test/helpers/skeleton-registry.ts`

**Interfaces:**
- Produces: the resolver returns `step("checks:classify", "dispatch", "checks:classify", null)` after `checks:dispatch` is done and before the design→implement advance.

- [ ] **Step 1: Update the resolver-test expectations (they will fail first)**

In `test/daemon/resolver.test.ts`, the two flows at ~lines 60-62 and ~74-76 currently expect `advance` immediately after `checks:dispatch`. Insert a `checks:classify` step between them. For the fast-track flow:

```ts
  expect(nextStepKey(db, ticketId)).toMatchObject({ stepKey: "checks:dispatch" });
  await succeed(db, ticketId, "checks:dispatch");
  expect(nextStepKey(db, ticketId)).toMatchObject({ stepKey: "checks:classify" });
  await succeed(db, ticketId, "checks:classify");
  expect(nextStepKey(db, ticketId)).toEqual({ kind: "advance", from: "design", to: "implement" });
```

Apply the identical insertion to the full-track flow (~line 74-76).

- [ ] **Step 2: Run the resolver test to verify it fails**

Run: `bun test test/daemon/resolver.test.ts`
Expected: FAIL — after `checks:dispatch`, `nextStepKey` returns `advance`, not `checks:classify`.

- [ ] **Step 3: Add the resolver gate**

In `src/daemon/resolver.ts`, in `case "design":`, insert the `checks:classify` gate between the `checks:dispatch` gate and the advance:

```ts
      if (!done(db, ticketId, "checks:dispatch")) {
        return step("checks:dispatch", "dispatch", "checks:dispatch", null);
      }
      if (!done(db, ticketId, "checks:classify")) {
        return step("checks:classify", "dispatch", "checks:classify", null);
      }
      return { kind: "advance", from: "design", to: "implement" };
```

- [ ] **Step 4: Run the resolver test to verify it passes**

Run: `bun test test/daemon/resolver.test.ts`
Expected: PASS.

- [ ] **Step 5: Add the skeleton-registry mock**

In `test/helpers/skeleton-registry.ts`, after the `checks:dispatch` mock, add:

```ts
  r.register("checks:classify", () => ({ classified: 0 }));
```

- [ ] **Step 6: Update the fast-track advance e2e**

In `test/daemon/advance.test.ts`, the fast-track e2e (~lines 95-114) registers `checks:dispatch` and drives `provision`→`checks:dispatch`→advance. Add a `checks:classify` registration and one more `advanceOneStep` call before the design→implement collapse:

```ts
  registry.register("checks:dispatch", () => ({}));
  registry.register("checks:classify", () => ({}));
```

and, after the `checks:dispatch` run comment:

```ts
  await advanceOneStep(db, ticketId, registry); // provision
  await advanceOneStep(db, ticketId, registry); // checks:dispatch
  await advanceOneStep(db, ticketId, registry); // checks:classify
  // next advance: collapse design→implement, then run implement:wu1:dispatch
  const outcome = await advanceOneStep(db, ticketId, registry);
```

(The `checks:classify` mock returns `{}` and is not verdict-bearing here because no vacuous signal exists → `applyChecksVerdict` returns `clean`, so the outcome is unchanged.)

- [ ] **Step 7: Update the design e2e loops**

`test/dispatch/design-size-e2e.test.ts` and `test/dispatch/design-review-e2e.test.ts` drive `design→implement` with the REAL registry and null/empty descriptions (0 ACs). The real `checks:classify` handler no-ops on 0 unresolved rows, so these should pass unchanged — but their bounded `for` loops must allow one extra tick. Verify each loop bound (`for (let i = 0; i < 10; i++)`) already exceeds the new step count (it does — the added step is one more design-stage tick, well within 10). No code change expected; if any loop bound was tight (`< N` where N is the exact prior tick count), raise it by 1.

- [ ] **Step 8: Run the affected suites**

Run: `bun test test/daemon/resolver.test.ts test/daemon/advance.test.ts test/dispatch/design-size-e2e.test.ts test/dispatch/design-review-e2e.test.ts`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src/daemon/resolver.ts test/daemon/resolver.test.ts test/daemon/advance.test.ts test/dispatch/design-size-e2e.test.ts test/dispatch/design-review-e2e.test.ts test/helpers/skeleton-registry.ts
git commit -m "feat(daemon): insert checks:classify in the design chain + update affected tests"
```

---

## Task 9: Capstone integration e2e — re-author loopback → escalate

**Files:**
- Test: `test/dispatch/checks-reauthor-e2e.test.ts` (create)

**Interfaces:**
- Consumes the whole assembled loop (real `buildDispatchRegistry` + `advanceOneStep`). No new production code — this task exists to prove the integrated behavior and is a reviewer gate.

- [ ] **Step 1: Write the integration test**

Create `test/dispatch/checks-reauthor-e2e.test.ts`. Drive a ticket with one checklist AC through: `checks:dispatch` authors a check that GREENS on HEAD (the injected `runCheckCommand` returns exit 0) → `checks:classify` adjudicator returns `vacuous` → `applyChecksVerdict` loops back (deletes the AC's check, resets `checks:dispatch`+`checks:classify`) → the second round re-authors + re-classifies `vacuous` again → the `(acId,"vacuous")` signature repeats → escalate.

```ts
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeAgentRunner } from "../../src/agent/fake-runner.ts";
import { DEFAULT_AGENT_CONFIG } from "../../src/config/agent-config.ts";
import { advanceOneStep } from "../../src/daemon/advance.ts";
import { listByTicket as listEvents } from "../../src/db/repos/event-log.ts";
import { setTicketTrack } from "../../src/db/repos/ticket.ts";
import { getTicket } from "../../src/db/repos/ticket.ts";
import { insertWorkUnit } from "../../src/db/repos/work-unit.ts";
import { buildDispatchRegistry } from "../../src/dispatch/handlers.ts";
import { parseProfile } from "../../src/dispatch/profile.ts";
import { runStep } from "../../src/engine/step-journal.ts";
import { makeTestDb } from "../helpers/db.ts";

function gitRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "styre-re-"));
  const run = (a: string[]) => Bun.spawnSync(["git", ...a], { cwd: root });
  run(["init", "-b", "main"]);
  run(["config", "user.email", "t@s.dev"]);
  run(["config", "user.name", "T"]);
  writeFileSync(join(root, "README.md"), "x");
  run(["add", "-A"]);
  run(["commit", "-m", "init"]);
  return root;
}

test("green-on-HEAD check → vacuous → scoped re-author → repeated vacuous → escalate", async () => {
  const { db, ticketId, projectId } = makeTestDb();
  const repo = gitRepo();
  db.query("UPDATE project SET target_repo = ? WHERE id = ?").run(repo, projectId);
  db.query("UPDATE ticket SET description = ? WHERE id = ?").run("- [ ] persists a pref\n", ticketId);

  // Seed design done + one unit + fast track so the resolver serves provision→checks:dispatch→classify.
  await runStep(db, { ticketId, stepKey: "design:dispatch", stepType: "dispatch", execute: () => ({ ok: true }) });
  insertWorkUnit(db, { ticketId, seq: 1, kind: "python", verifyCheckTypes: ["test"] });
  setTicketTrack(db, ticketId, "fast");

  let file = 0;
  const runner = new FakeAgentRunner((input) => {
    // checks:dispatch authors a new test file; checks:classify returns a sidecar with no file write.
    const wantsSidecar = input.prompt.includes("adjudicat") || input.prompt.includes("Checks to classify");
    if (!wantsSidecar) {
      file += 1;
      const dir = join(input.cwd, "checks");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, `ac${file}.py`), "def test_ac():\n    assert True\n");
      return {
        completed: true,
        exitCode: 0,
        stdout: `\`\`\`styre-sidecar\n{"checksAuthored":[{"ac_id":1,"test_file":"checks/ac${file}.py","test_name":"test_ac"}]}\n\`\`\``,
        stderr: "",
        timedOut: false,
        costUsd: null,
        tokensIn: null,
        tokensOut: null,
      };
    }
    // Adjudicator: classify the (single) green check vacuous. Extract the ac_check_id from the prompt.
    const m = input.prompt.match(/ac_check_id=(\d+)/);
    const id = m ? Number(m[1]) : 0;
    return {
      completed: true,
      exitCode: 0,
      stdout: `\`\`\`styre-sidecar\n{"classifications":[{"ac_check_id":${id},"class":"vacuous","reason":"asserts True"}]}\n\`\`\``,
      stderr: "",
      timedOut: false,
      costUsd: null,
      tokensIn: null,
      tokensOut: null,
    };
  });

  const registry = buildDispatchRegistry({
    runner,
    agentConfig: DEFAULT_AGENT_CONFIG,
    profile: parseProfile({
      slug: "demo",
      targetRepo: repo,
      components: [{ name: "api", kind: "python", paths: ["**"], commands: { test: "pytest -q" } }],
    }),
    worktreeRoot: mkdtempSync(join(tmpdir(), "styre-rewt-")),
    // The authored check GREENS on clean HEAD (exit 0) → green-on-HEAD adjudication.
    runCheckCommand: async () => ({ exitCode: 0, stdout: "1 passed", stderr: "", timedOut: false }),
  });

  // Drive the loop until the ticket escalates (status=waiting) or a bound is hit.
  let escalated = false;
  for (let i = 0; i < 20; i++) {
    const t = getTicket(db, ticketId);
    if (t?.status === "waiting") {
      escalated = true;
      break;
    }
    try {
      await advanceOneStep(db, ticketId, registry);
    } catch {
      // implement:dispatch etc. may throw once the loop would leave design — not expected before escalate.
    }
  }

  // Binding facts:
  // 1. The ticket escalated (repeated (ac_id,"vacuous") signature).
  expect(escalated).toBe(true);
  // 2. At least two checks-loopback events were appended (the scoped re-authors) before escalate.
  const checksLoopbacks = listEvents(db, ticketId).filter((e) => e.kind === "loopback" && e.loop === "checks");
  expect(checksLoopbacks.length).toBeGreaterThanOrEqual(1);
  const escalations = listEvents(db, ticketId).filter((e) => e.kind === "escalated");
  expect(escalations.length).toBeGreaterThanOrEqual(1);
  db.close();
});
```

- [ ] **Step 2: Run the integration test**

Run: `bun test test/dispatch/checks-reauthor-e2e.test.ts`
Expected: PASS. (If the escalate does not trip within the bound, confirm `applyChecksVerdict`'s signature stays stable across rounds — it is keyed on `acId`, which is constant, so round-2's identical signature must match round-1's `loop:"checks"` event.)

- [ ] **Step 3: Run the FULL suite**

Run: `bun test`
Expected: PASS. Investigate any red — the likely suspects are e2e loops whose tick bounds need `+1`, or a `handlers.test.ts` fresh-dispatch path (must stay `scoped=false`).

- [ ] **Step 4: Typecheck + lint**

Run: `bun run typecheck` (or the repo's configured check) and the repo's linter.
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add test/dispatch/checks-reauthor-e2e.test.ts
git commit -m "test(checks): capstone e2e — vacuous green → scoped re-author loopback → escalate"
```

---

## Self-Review Notes (resolved during authoring)

- **Coarse source for the prior:** the handler reads `coarse` from `ac_check.red_first_result` (persisted by M2b) and `rawOutput`/`exitCode` from the by-live-id RED-first signal. `exitCode` is available but the prior keys on `coarse` + the own-symbol regex; `exitCode` remains in the signal for M4/M5 and observability (it is not re-derived).
- **`vacuous` is not a stored column value** — it is recorded only as an `ac-check-classification` signal (`class:"vacuous"`) and consumed by `applyChecksVerdict`, whose `deleteByAc` then removes the row. This satisfies §7's "resolved = classified OR triggered a re-author" without a third disposition enum value.
- **Round-scoping of vacuous signals** is done by the by-live-id filter in `currentVacuousFindings` (stale prior-round signals point to deleted ac_check ids and drop out), consistent with §3's read contract — no per-round marker needed.
- **Fault isolation** is a bounded (2-round) in-memory re-dispatch of only the still-missing checks, with the single terminal persist txn preserving crash-resume atomicity.

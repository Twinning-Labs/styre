# ENG-477: design-stage steps rerun when their recorded inputs change, with a real database upgrade path

**Date:** 2026-10-09
**Status:** rev 1, for independent review
**Ticket:** ENG-477 (deliverable 2 of the grounded-requirements split, parent ENG-483)
**Umbrella design:** `docs/brainstorms/2026-09-24-grounded-requirements-design.md` §9, §14, §15 (branch
`feat/grounded-requirements`), with the rev 2 review findings C3, M3 and M4
**Related:** ENG-475 (the same rubric for every other stage), ENG-478 (the next deliverable), ENG-454,
styre#150

---

## 1. Problem

Three facts about today's code make the design stage fragile, and the next deliverables add steps
to it.

1. **What reruns after a loopback is a hand-kept list.** `redesignLoopback`
   (`src/daemon/review-verdict.ts:162-220`) deletes the work units and resets `design:dispatch`,
   `design:extract`, `design:review` and `review`. The list has been wrong before (styre#150,
   ENG-454), and it is wrong today: a redesign never resets `design:size`, `ticket.track`,
   `ticket.needs_docs`, `checks:dispatch` or `checks:classify`. So the track chosen for the old
   plan, and the acceptance tests written against the old work units, outlive the plan they were
   made for.
2. **"Done" is not "done with these inputs".**
   - `done()` (`src/daemon/resolver.ts:27-29`) is only `status === "succeeded"`.
   - `design:extract` is gated on rows (`work_unit` count, `resolver.ts:111`) and `design:size` on
     a column (`ticket.track === null`, `:114`), not on the journal. If the rows and the journal
     disagree, `runStep` replays the step and `advance.ts:227-238` escalates with
     `step-replay-no-progress:<key>`.
   - Treating a finished step as "not done" would livelock, because the journal replays any
     succeeded step (`src/engine/step-journal.ts:102-108`).
3. **Styre never upgrades an existing database.**
   - `migrate()` returns early when `schema_meta` exists (`src/db/migrate.ts:30-33`).
   - Resume calls it (`src/cli/park.ts:260`), and the only bridge is `ensureRunTable`
     (`src/db/repos/run.ts:17-28`, `CREATE TABLE IF NOT EXISTS`).
   - Schema versions 3 to 8 were bumped by editing the seed alone. So any schema change breaks
     every run paused under the old version, which breaks the promise that every pause is
     resumable.
   - The docs already claim otherwise: `control-loop.md` (start-up order, §10) and
     `build-operations.md:54,58` say `migrate()` applies migrations.

The resolver can only fingerprint what is in the run's database, and three kinds of input are not:
- the profile, read from `<config>/<slug>/profile.json` on every start and resume;
- the runtime config, read the same way;
- the starting commit, which is held only in memory (`door.ts:352`) and inside `interrupted` notes.

## 2. Decisions

The umbrella decisions D7 ("done means done with these inputs", design stage first) and D9 (old
paused runs are upgraded and continue under the new rules) stand. This design adds:

| # | Decision |
|---|---|
| E1 | An edit made while a run is paused, to the profile or to a content-shaping config key, reruns the design-stage steps that read it, and everything downstream, on resume. Untouched steps stay done. |
| E2 | The ticket text is fixed for the life of a run. Resume never reads the tracker. To pick up an edited ticket, start over with `--fresh`. |
| E3 | Only config keys a step's handler reads to decide its output count as inputs. Today that is `complexityGrading` for `design:size`. Model choices and `onPlanDefect` do not count. |
| E4 | The scope is the whole design stage: `provision`, `design:dispatch`, `design:extract`, `design:size`, `design:review`, `checks:dispatch` and `checks:classify`. |
| E5 | Approach A: each step records a fingerprint of its inputs, and a digest of its output where that output is not in the database. Dependants are judged afresh after an upstream rerun ("early cutoff", as in Bazel and Salsa). |

## 3. The declared table (`src/daemon/design-graph.ts`)

One table, in resolver order. For each step it lists what Styre hands the step, what the step
produces, and how each output is cleared.

| Step | Snapshot inputs | Upstream outputs it reads | Feedback (not fingerprinted) | Produces |
|---|---|---|---|---|
| `provision` | profile: components (test environment, prepare) | — | — | environment signals: `toolchain`, `component-role`, `provision`, `test-environment` |
| `design:dispatch` | ticket text; profile: slug, prompt variables, runtime variables, detected stacks | — | design loopback findings (`event_log` loop `design`) | the plan: the contents of the ticket's plan file or files under `docs/plans/` |
| `design:extract` | ticket ident and title; profile: slug, prompt and runtime variables, detected stacks, components | plan | — | work units; `ticket.needs_docs` |
| `design:size` | config `complexityGrading` | work units | — | `ticket.track` |
| `design:review` | ticket text; profile fields its prompt reads | work units | — | plan findings |
| `checks:dispatch` | ticket text, which gives the checklist; profile: components | work units; provision's environment signals | checks loopback ACs and findings (loop `checks`) | acceptance checks (`ac_check` rows) and their test files on the branch |
| `checks:classify` | — | acceptance checks | — | the checks' classifications |

- **Exact fields come from the code.** The plan pins every profile field by reading each handler
  and its prompt variables function (`prompt-vars.ts`: `designVars`, `extractVars`,
  `designReviewVars`, and the checks prompts). A test fails if a handler reads a field the table
  does not name.
- **Agents also read files with their own tools.** That cannot be declared. The table claims only
  what Styre hands over, plus the plan, whose content Styre can hash.
- **The starting commit** is recorded once at run start and never changes, including under
  `--accept-head` (umbrella §4.1). It is not a fingerprinted input of any step in this ticket. It
  is used to clear test files (§6.2), and it is the input ENG-478 needs.

### 3.1 Startup check

Before the first resolver pass of any run, Styre validates the table and refuses to start, exit
`70` with a message naming the rule and the steps, if:
1. a step reads something that is neither a snapshot input nor produced by an earlier step;
2. two steps produce the same thing;
3. a later step produces a non-feedback input of an earlier step, which would be a cycle;
4. the resolver's design stage has a step that is not in the table, or the table has a step the
   resolver never chooses.

## 4. The snapshot (`ticket_input`)

A new table holds the inputs that are not already rows in the database.

| Column | Meaning |
|---|---|
| `ticket_id` | the ticket |
| `name` | the input's declared name, for example `profile.components` or `config.complexityGrading` |
| `value_json` | the canonical value (§5.1) |
| `digest` | SHA-256 of `value_json` |
| `captured_at` | UTC |

The primary key is `(ticket_id, name)`.

- **At run start** Styre writes every declared snapshot input: the ticket text, the starting
  commit, each named profile field and `complexityGrading`.
- **On each resume**, before the first resolver pass, Styre rewrites the profile and config rows
  from what is on disk now. The ticket text and the starting commit are never rewritten (E2).
- **Changes are recorded.** If any digest changed, one `note` event with reason `inputs-changed`
  lists the names, so the run's history says what the operator edited.

## 5. Fingerprints and digests

### 5.1 Canonical encoding

- JSON with object keys sorted, and strings normalised to Unicode NFC.
- No database ids and no timestamps.
- Lists in their meaningful order: work units by `seq`, checks by `ac_id` then `selector`.
- Each fingerprint carries a scheme version, starting at 1. A step recorded under another scheme
  is treated as unfingerprinted and adopted (§7.4), never compared byte for byte.

### 5.2 What a step records

When a design-stage step succeeds, in the same transaction as `markSucceeded` and its
`onSucceed`, `workflow_step` gets five new nullable columns:
- `input_manifest`: a JSON map from each declared input name to its digest at that moment;
- `input_fingerprint`: SHA-256 of the canonical manifest;
- `output_digest`: used only where the output lives outside the database (the plan);
- `fingerprint_scheme`;
- `generation`: an integer, 0 for a new step, incremented by each invalidate (§6).

A per-input digest is what lets an invalidate say which input changed.

### 5.3 Where each digest comes from

- **Snapshot inputs:** the `digest` column of `ticket_input`.
- **Outputs in the database** are computed from the current rows on every check. Only the fields
  the producing step wrote count. Columns later stages change, such as a unit's `status`,
  `base_sha` and attempt counters, are excluded. The database is the truth, so a digest is right
  even if other code changed those rows.
  - Work units: `seq`, `kind`, `title`, `description`, `behavioral`, `test_plan`,
    `files_to_touch`, `verify_check_types`, `depends_on`, plus `ticket.needs_docs`.
  - Track: `ticket.track`.
  - Environment signals: the latest signal of each of the four types, by content.
  - Acceptance checks: the active rows' `ac_id`, `selector`, `test_path` and `red_first_result`.
- **The plan.** When `design:dispatch` succeeds, the runner reads the ticket's plan file or files
  at the branch head, the same files `hasTicketPlan` finds, and records their digest as that
  step's `output_digest`. The resolver never reads the worktree.

### 5.4 The check, and early cutoff

- Before choosing the next design-stage step, the resolver walks the table in order.
- For each succeeded step, it recomputes the manifest from the current inputs and compares it with
  the recorded one. The first mismatch returns
  `{ kind: "invalidate", stepKeys: [step], reason: { cause: "inputs", changed: [names] } }`.
- Only the mismatched step is invalidated. Its dependants are judged afresh after it reruns:
  - if the rerun produces the same output, their manifests still match and they stay done;
  - if the output differs, the next pass invalidates them.
- The resolver always stops at the first step that is not done, so no step ever runs on its
  upstream's old output.
- `design:extract` and `design:size` move from rows and column gating to the same rule. A
  succeeded step with matching inputs is done, whatever its rows say; if its rows were removed by
  other code, its output digest changes and its dependants rerun.

## 6. Applying an invalidate

`advance.ts` applies the descriptor in one transaction:
1. **History.** Copy the step's row into a new table, `workflow_step_history`, before anything is
   reset. The copy keeps status, attempt, result, error, manifest, fingerprint, output digest,
   generation and timestamps, plus the reason and the event id.
2. **Reset.**
   - Status goes back to `pending`, attempt to 0, and result, error, manifest, fingerprint and
     output digest to NULL.
   - `generation` is incremented. Idempotency keys include the generation, so a rerun's effects
     can never collide with the previous generation's.
3. **Clear the step's outputs** by the table's clearing rule (§6.1).
4. **Record one event** of a new kind, `invalidated`, with the step keys, the reason and the
   changed input names.
   - It is not a `loopback`, so `v_rejection_counts` and `REVIEW_REPAIR_LIMIT` do not count it.
   - Adding the kind changes `event_log`'s CHECK, which needs a table rebuild (§7.2).

A rerun caused by an invalidate is a fresh round: the attempt limit keeps its meaning.

### 6.1 Clearing rules

| Output | Cleared by |
|---|---|
| Work units | Deleted, as `redesignLoopback` does today: code findings are detached first, and cascades remove per-unit steps and signals. |
| `ticket.needs_docs` | Set to 0. |
| `ticket.track` | Set to NULL. This needs a setter, since none exists today. |
| Plan findings | Kept as history. A new `review_finding.superseded_at` column marks them, so they no longer count as the latest plan review. |
| Acceptance checks | Superseded by the existing `superseded_at`, never deleted. |
| Classifications | They live on the superseded check rows. |
| Environment signals | Append only: the newest of each type wins. |
| The plan file | Not cleared. The rerun revises it in place, as a redesign does today, with the feedback. |

### 6.2 Test files on the branch

A superseded generation's test files must not outlive the plan they were written for.
- **Restore.** Every `test_path` of a superseded check is put back to its content at the starting
  commit, or removed if it did not exist there, in one runner commit. A project test that a check
  had edited is therefore restored, never deleted.
- **When.** This cannot happen inside the database transaction. `checks:dispatch` does it at the
  start of its own run, for every superseded path not already at its starting-commit state. It is
  idempotent, so a crash between the transaction and the commit means the next attempt finishes
  the job.

### 6.3 Loopbacks

- **`redesignLoopback` loses its design-stage resets.** It keeps its event, which carries the
  feedback, and its later-stage resets (`review`, verify and merge) until ENG-475. In place of
  deleting units and resetting `design:dispatch`, `design:extract` and `design:review`, it applies
  `invalidate([design:dispatch])` with reason `{ cause: "feedback" }`, through the same function.
  - Feedback is not in any fingerprint, so the loopback must name `design:dispatch`; everything
    downstream then follows from fingerprints.
  - A redesign that changes the plan now also reruns `design:size`, the track and the checks.
    Before this change it never did.
- **The checks loop keeps its scoped reauthor.** `applyChecksVerdict` supersedes only the flagged
  ACs and resets `checks:dispatch` and `checks:classify`. That is feedback and stays as it is. The
  rerun records a fresh manifest when it succeeds.

### 6.4 Livelock and the guard

A recorded manifest stops matching only when:
- something upstream reruns, and the table has no cycles (§3.1 rule 3);
- a resume picks up an edited profile or config field, once per resume;
- a feedback loopback names the step, bounded by the existing review budget.

After a rerun the manifest equals the current inputs, so an unchanged step cannot be invalidated
again. Findings are never fingerprinted, so "findings to no findings" cannot loop.

**Guard, fail fast.** If the same step is invalidated more than twice with no `loopback` or
`resumed` event between, the resolver escalates with signature `invalidate-loop:<step>` instead of
spinning. This catches a defect such as an unstable digest.

## 7. Database upgrades

### 7.1 Migrations

- Migrations are numbered TypeScript files in `src/db/migrations/`, one per version step. Each
  exports a version, a note, and `up(db)`. TypeScript, because some steps rebuild tables or
  backfill.
- `schema.sql` stays the complete current schema and creates fresh databases. Migrations only
  carry an existing database forward.

`migrate()`:

| On disk | What happens |
|---|---|
| no `schema_meta` | create from `schema.sql`, as today |
| current version | nothing |
| newer than the binary | refuse loudly, naming both versions; an old binary never writes to a newer database |
| older than the oldest supported | refuse, saying to start that run over with `--fresh` |
| older, supported | run each pending migration in order |

How each migration runs:
- Before the first migration, Styre copies the database file to `<name>.v<old>.bak` next to it
  and prints the path. It checkpoints WAL first, so the copy is complete.
- Each migration runs in its own `BEGIN IMMEDIATE` transaction and inserts its `schema_meta` row.
  A failure rolls back that step, leaves the database at its previous version, and exits loudly.

### 7.2 Table rebuilds

These follow SQLite's documented procedure ("Making Other Kinds Of Table Schema Changes",
sqlite.org/lang_altertable.html):
1. Turn `PRAGMA foreign_keys` off, outside the transaction.
2. Begin. Create the new table, copy the rows, drop the old table, rename the new one, and
   recreate its indexes and any views that use it (`v_rejection_counts` uses `event_log`).
3. Run `PRAGMA foreign_key_check`. Any row fails the migration.
4. Commit, then turn `foreign_keys` back on.

### 7.3 Proof

After migrating, Styre builds a fresh in-memory database from `schema.sql` and compares both
schemas from `sqlite_master`, with whitespace normalised. Any difference fails loudly, at runtime
and in tests. A migration and `schema.sql` can never drift apart.

### 7.4 Versions

- **v7 → v8:** creates the `run` table. `ensureRunTable` becomes a real migration and the bridge is
  removed. v7 becomes the oldest supported version.
- **v8 → v9 (this ticket):**
  - the five new `workflow_step` columns;
  - `ticket_input` and `workflow_step_history`;
  - `review_finding.superseded_at`;
  - the `event_log` rebuild for `invalidated`.

### 7.5 Old paused runs (D9)

- After migration, a v8 run's finished design steps have no manifest.
- On resume, right after the snapshot is written (§4) and before the first resolver pass, an
  **adopt** pass records, for each succeeded design-stage step with no manifest or another scheme:
  - its manifest, from the current inputs;
  - for `design:dispatch`, the plan's digest at the branch head.
- One `note` event, reason `adopted`, lists them.
- Those steps then count as done with today's inputs, and the run continues under the new rules
  without rerunning them. A fresh run never needs the pass.

### 7.6 Who migrates

- `run`, fresh and resume, and `styre migrate` upgrade.
- `styre ls` and `styre clean` read a checkpoint without migrating it. They read only columns that
  exist in v7 and later, so listing never writes to a paused run.

## 8. Testing

Every test that involves design steps drives the real handlers through `advanceOneStep` with
`FakeAgentRunner`, and counts dispatches per step. Nothing is set up by writing step rows
directly.

1. **Each input reruns exactly its dependants.** For every snapshot input (each named profile
   field, and `complexityGrading`): pause, edit, resume. Exactly the dependants rerun, and every
   other step keeps its dispatch count.
2. **Early cutoff.** A redesign that produces a different plan reruns extract, size, review and
   checks. One that produces the same plan reruns only `design:dispatch`.
3. **No livelock.** Plan review goes from findings to none, and the run finishes in a fixed number
   of ticks.
4. **Crash after each design step.** A child process is SIGKILLed right after each step's success
   commits, and right after an invalidate transaction. Resume must leave no duplicate outputs,
   manifests that match the inputs, and no step run twice for the same inputs.
5. **Every output kind is cleared**:
   - units, `needs_docs` and track;
   - plan findings;
   - superseded checks and their classifications;
   - test files: one the checks created is removed, and an existing project test a check had
     edited goes back to its starting-commit content.
6. **The startup check** refuses each of its four kinds of inconsistent table, and a test pins the
   table to the handlers.
7. **Migrations.**
   - v7 → v9 and v8 → v9, each from a real historical database: `schema.sql` at the commit that
     shipped that version, stored as a fixture and seeded with a realistic paused run. The
     migrated schema must equal a fresh v9.
   - Refusing a newer database, and one older than the oldest supported.
   - The backup file is written.
   - A failing `foreign_key_check` aborts.
   - A failing migration leaves the previous version.
8. **D9.** A v8 paused run resumes on the new binary. The adopt pass records manifests, no
   finished design step reruns, and the run completes.
9. **The guard.** A digest made deliberately unstable escalates with `invalidate-loop:<step>`.
10. **Canonical encoding.** Key order, NFC, and ids and timestamps excluded.

Each key test is shown to fail when the code it guards is broken on purpose.

## 9. Docs, in the same PR

- **`minimal-loop.md`:** §1 design gating by fingerprints; §2 the redesign row.
- **`control-loop.md`:**
  - §2.3: the `invalidate` descriptor.
  - §4: the S1 guards. "`ticket.track IS NULL`" and "rows exist" give way to "done with these
    inputs".
  - §6.2: replay, with invalidate beside it.
  - §8.3: the atlas rows.
  - The start-up order and §10: `migrate()` now really upgrades.
- **`build-operations.md`:** `migrate()`.
- **`runtime-parameters.md`:**
  - the migration messages: newer database, too old, backup path;
  - the `inputs-changed` and `adopted` notes;
  - the `invalidate-loop` escalation;
  - the startup check refusal.
- **`conventions.md`:** the `.bak` file next to a run's database.
- **`telemetry-export.md`:** the `invalidated` event kind. Adding a kind is an additive change to
  the open-core contract, and the doc says so.
- **Both `schema.sql` copies, byte-identical.** `CLAUDE.md`'s table count goes to 19.
- **`brainstorm.md` §11:** a changelog entry.

## 10. Acceptance criteria → design

| ENG-477 criterion | Where |
|---|---|
| Changing a design input invalidates exactly its dependants, shown per input through real steps | §5.4, §8.1, §8.2 |
| No livelock: plan review from findings to none finishes in bounded ticks | §6.4, §8.3 |
| Crash after each design step | §8.4 |
| Every output kind cleared on invalidate | §6.1, §6.2, §8.5 |
| A run paused under v8 resumes after an automatic migration and continues without rerunning finished design steps, on a real v8 database | §7.4, §7.5, §8.7, §8.8 |
| The startup check refuses an inconsistent table | §3.1, §8.6 |
| Docs, both `schema.sql` copies, independent review before the PR | §9 |

## 11. Out of scope

- Other stages: implement, verify, review and merge keep their reset lists (ENG-475).
- New design steps: `design:explore`, `design:read` (ENG-478 and later).
- Moving the checklist derivation to run start (umbrella §4.1; ENG-478).
- Re-fetching the ticket from the tracker on resume (E2).

## 12. Risks

- **A digest that is not stable** (key order, a timestamp that slips in) would invalidate on every
  pass. Mitigated by the canonical encoding tests and the `invalidate-loop` guard.
- **Plan files are outside the database.** If an agent in a later stage edits the plan, the
  recorded digest is stale, but that only matters when the ticket is back in design, which a
  redesign handles by naming `design:dispatch`.
- **Restoring test files to the starting commit** could undo an implement-stage edit to the same
  file after a redesign. Implement agents do not own acceptance test files (declare or discard
  rules), so a legitimate edit there is not expected. The restore commit lists every path it
  touches.
- **The first table rebuild in production** is `event_log`, the most written table. The backup,
  the per-migration transaction and the schema comparison bound the damage.

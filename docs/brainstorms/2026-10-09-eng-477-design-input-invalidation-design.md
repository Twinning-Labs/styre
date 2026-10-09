# ENG-477: design-stage steps rerun when their recorded inputs change, with a real database upgrade path

**Date:** 2026-10-09
**Status:** rev 3, for independent review
**Ticket:** ENG-477 (deliverable 2 of the grounded-requirements split, parent ENG-483)
**Umbrella design:** `docs/brainstorms/2026-09-24-grounded-requirements-design.md` §9, §14, §15 (branch
`feat/grounded-requirements`), with the rev 2 review findings C3, M3 and M4
**Related:** ENG-475 (the same rubric for every other stage), ENG-478 (the next deliverable), ENG-488
(`git worktree add -B` resets the branch on resume), ENG-454, styre#150

### Revision history

- **rev 1** (561a699): a declared table, input fingerprints with output digests and early cutoff, an
  `invalidate` descriptor, versioned migrations, an adopt pass for v8 runs.
- **rev 2**: an independent review found 4 critical and 13 major problems (§14). The main changes:
  - the table corrected from the handlers: the plan feeds `design:review` and the graded
    `design:size`; `checks:classify` has inputs; `checks:dispatch` depends only on which
    components own behavioural units;
  - environment observations are out of the fingerprint model, because they change on every resume;
  - the profile is snapshotted exactly as the handlers receive it, and fresh runs and resumes narrow
    it the same way;
  - the design routing is generated from the table, and the walk stops at the first step that is
    not done;
  - feedback is scoped to the generation it was sent to;
  - design handlers write their database outputs inside the success transaction;
  - an edit made while paused after design takes effect the next time the run is in design (E6);
  - a redesign from code review still re-implements, as today (§6.4);
  - acceptance checks are never deleted;
  - the schema proof compares structure, not text; the backup uses `VACUUM INTO`; one fixture per
    real released shape;
  - invalidations are a `note` event, so `event_log` is not rebuilt.
- **rev 3**: a second review found 2 critical and 6 major problems (§13). Two operator decisions
  (E7, E8) replace rev 2's test file restore and its `ctx.inputs` refactor:
  - no files are restored on the branch; a re-authored check may modify its canonical file, judged
    against the commit its step generation started from (§6.3);
  - handler reads are pinned by tests, a recording proxy and named accessors (§3);
  - reconcile units are deleted with the extract units, and `origin` is backfilled;
  - a step reset by feedback keeps its manifest, so an edit made meanwhile is still caught;
  - every loopback names the step that consumes its feedback and that step's generation;
  - the toolchain narrowing on resume never exits 69;
  - a crash rerun of `checks:dispatch` is judged against its generation's starting commit;
  - proof rules for column order and `AUTOINCREMENT`; a timestamped backup.

---

## 1. Problem

Three facts about today's code make the design stage fragile, and the next deliverables add steps to
it.

1. **What reruns after a loopback is a hand-kept list.** `redesignLoopback`
   (`src/daemon/review-verdict.ts:162-220`) deletes the work units and resets `design:dispatch`,
   `design:extract`, `design:review` and `review`. The list has been wrong before (styre#150,
   ENG-454), and it is incomplete today: a redesign never resets `design:size`, `ticket.track` or
   `ticket.needs_docs`, so a track chosen for the old plan outlives it.
2. **"Done" is not "done with these inputs".**
   - `done()` (`src/daemon/resolver.ts:27-29`) is only `status === "succeeded"`.
   - `design:extract` is gated on rows (`resolver.ts:111`) and `design:size` on a column
     (`ticket.track === null`, `:114`). If rows and journal disagree, `runStep` replays the step and
     `advance.ts:227-238` escalates with `step-replay-no-progress:<key>`.
   - Treating a finished step as "not done" would livelock, because the journal replays any
     succeeded step (`src/engine/step-journal.ts:102-108`).
3. **Styre never upgrades an existing database.**
   - `migrate()` returns early when `schema_meta` exists (`src/db/migrate.ts:30-33`).
   - Resume calls it (`src/cli/park.ts:260`). The only bridge is `ensureRunTable`
     (`src/db/repos/run.ts:17-28`, `CREATE TABLE IF NOT EXISTS`), which never bumps the version.
   - Versions 2 to 8 were each bumped by editing the seed alone (9981b75/e45e406, ba061d5, bf2a91e,
     de97c54, 7c544ef/7b86940, 5450ae0/df03fad, b3be1be). So any schema change breaks every run
     paused under the old version, against the promise that every pause is resumable.
   - The docs already claim otherwise: `control-loop.md` (start-up order, §10) and
     `build-operations.md:54,58` say `migrate()` applies migrations.

The resolver can only fingerprint what is in the run's database. The profile and the runtime config
are read from disk on every start and resume, and nothing records the commit a run started from:
`door.ts:347-361` holds only the head at the start of each step.

## 2. Decisions

The umbrella decisions D7 ("done means done with these inputs", design stage first) and D9 (old
paused runs are upgraded and continue under the new rules) stand.

| # | Decision |
|---|---|
| E1 | An edit made while a run is paused, to the profile or to a content-shaping config key, reruns the design-stage steps that read it and everything downstream. Untouched steps stay done. |
| E2 | The ticket text is fixed for the life of a run. Resume never reads the tracker. To pick up an edited ticket, start over with `--fresh`. |
| E3 | Only config keys a step's handler reads to decide its output count. Today that is `complexityGrading`. Model choices and `onPlanDefect` do not count. |
| E4 | The scope is the whole design stage: `provision`, `design:dispatch`, `design:extract`, `design:size`, `design:review`, `checks:dispatch`, `checks:classify`. |
| E5 | Approach A: each step records a fingerprint of its inputs, and a digest of its output where that output is not in the database. Dependants are judged afresh after an upstream rerun (early cutoff, as in Bazel and Salsa). |
| E6 | An edit made while a run is paused after design (implement, verify, review, merge) is recorded on resume and takes effect the next time the run is in design. The run carries on from where it paused. (2026-10-09) |
| E7 | No test files are restored on the branch when checks rerun. Check identity changes so a re-authored check may modify its canonical file (`<ident>_ac<N>_test.*`), not only add it. Stale helper files from an earlier generation can remain; the PR lists that as a limit. (2026-10-09) |
| E8 | The declared table is enforced by tests, not by restructuring handlers: a recording proxy over the profile, config and ticket, named accessor functions for upstream rows, and a source guard limiting which step may call which accessor. (2026-10-09) |

## 3. The declared table (`src/daemon/design-graph.ts`)

One table, in order. For each step it lists when the step applies, what Styre hands it, what it
produces and how each output is cleared. **The design-stage routing in the resolver is generated from
this table**, so a step the resolver chooses is by construction a step the table declares.

| Step | Applies when | Snapshot inputs | Upstream outputs it reads | Feedback (not fingerprinted) | Produces |
|---|---|---|---|---|---|
| `provision` | always | profile components (as narrowed, §4.1); the unusable and non-primary component lists | — | — | nothing the table tracks (§3.2) |
| `design:dispatch` | always | ticket title and description; profile slug, prompt variables, runtime variables, detected stacks, and components (read by `environmentGate`) | — | design loopback findings | the plan |
| `design:extract` | always | ticket ident and title; profile slug, prompt and runtime variables, detected stacks, components | plan | — | work units (origin `extract`); `ticket.needs_docs` |
| `design:size` | always | config `complexityGrading`; when grading is on: ticket title, profile slug and prompt variables | work units; when grading is on: plan | — | `ticket.track` |
| `design:review` | `ticket.track = 'full'` (ENG-478's D11 widens this) | ticket title and description; profile fields its prompt reads | plan; work units | — | plan findings (rows of this step's latest dispatch), read directly by the gate |
| gate | when `design:review` applies | — | plan findings | — | escalates `review:unresolved-plan` if blocking findings remain (today's resolver rule, `resolver.ts:120-127`) |
| `checks:dispatch` | always | ticket ident, title and description (the checklist); profile slug, prompt variables and components | the check owners: the sorted set of components owning behavioural units' files, and whether any behavioural unit exists (`handlers.ts:731-744`) | checks loopback ACs and findings | acceptance criteria (first run only, §3.2); acceptance checks; capability and red-first signals; test files on the branch |
| `checks:classify` | always | ticket title and description; profile slug and prompt variables; acceptance criterion text | acceptance checks; their red-first signals | — | the active checks' classifications |

- **Exact fields come from the code.** The plan pins every field by reading each handler and its
  prompt variables function in `prompt-vars.ts`.
- **Enforced by tests (E8).**
  - In tests, the profile, config and ticket handed to each handler are wrapped in a recording proxy;
    a test runs every design step and fails if it reads a field the table does not declare for it.
  - Upstream rows are read through named accessor functions (`readWorkUnitsForDesign`,
    `readActiveChecks`, and so on); a source guard limits which step's handler may call which.
  - Agents still read files with their own tools; that cannot be declared. The table claims only what
    Styre hands over, plus the plan, whose content Styre hashes.

### 3.1 Rules, checked by a unit test and asserted when the table is first used

1. Every input is a snapshot input or an output of an earlier step.
2. Each output has exactly one producing step. Signals that several steps write are modelled as
   "this step's own rows" (by dispatch id), never as a shared output.
3. No later step produces a non-feedback input of an earlier step.
4. The routing covers exactly the table's steps, in table order (true by construction, since the
   routing is generated from it).

A failed assertion exits 70 with the rule and the steps named.

### 3.2 What the table deliberately leaves out

- **Environment observations.** `provision`, `design:dispatch` and `checks:dispatch` write
  `test-environment` signals through `environmentGate` (`handlers.ts:499-524`). Those contain the
  worktree's absolute path (new on every worktree-mode resume), the head sha, and raw probe output. So
  they change on every resume, and fingerprinting them would rerun design work nobody touched.
  `environmentGate` stays a precondition that is evaluated every time, as today, and
  `checks:dispatch` keeps probing capability live (`handlers.ts:704-718`). Neither is a fingerprinted
  input.
- **`suite-requirements` signals** from `registry.synchronize` (`handlers.ts:465-497`). No design step
  reads them.
- **Acceptance criteria rows.** `deriveAndPersistAcs` writes them once from the ticket description,
  which is fixed for the run (E2), so they never change within a run and are never cleared. ENG-478
  moves the derivation to run start (umbrella §4.1).
- **Reconcile units.** The integration failure path adds a unit during implement
  (`failure-policy.ts:205-216`). A new `work_unit.origin` column (`extract` or `reconcile`) keeps it
  out of extract's output digest. The v8 → v9 migration backfills it from `kind = 'reconcile'`.

## 4. The snapshot (`ticket_input`)

A new table holds the inputs that are not already rows.

| Column | Meaning |
|---|---|
| `ticket_id`, `name` | primary key; `name` is the declared input, for example `profile.components` |
| `value_json` | the canonical value (§5.1) |
| `digest` | SHA-256 of `value_json` |
| `captured_at` | UTC |

- **At run start**, after the toolchain and role narrowing (§4.1), Styre writes every declared
  snapshot input, the starting commit (§4.2), and the ticket text.
- **On a reused `--db`** (run.ts:369, :428-440), rows that already exist for the ticket text and the
  starting commit are never rewritten; the profile and config rows are rewritten as on a resume, with
  the same `inputs-changed` note.
- **On each resume**, after `recover()` and the provision reset and before the first resolver pass,
  Styre rewrites the profile and config rows from what the handlers will receive now. The ticket text
  and the starting commit are never rewritten (E2).
- **Changes are recorded** in one `note` event, reason `inputs-changed`, listing the names. If the
  ticket is past design, the note says the change takes effect the next time the run is in design
  (E6).

### 4.1 One profile for fresh runs and resumes

A fresh run applies `applyToolchainGate` and drops components whose toolchain is missing
(`run.ts:338-339`); the resume path returns before that line (`run.ts:298-312`). The handlers
therefore see a different profile on resume than on the fresh run: a defect today, and a false
"inputs changed" on every resume once the profile is fingerprinted.

- Resume applies the same narrowing, after the `--inspect` return, but never its refusal: a missing
  toolchain only drops the component, it never exits 69. `runtime-parameters.md:450` ("never on
  `--resume` or `--inspect`") stays true.
- The snapshot records the profile exactly as the handlers receive it.
- Resuming on another host with different toolchains narrows differently. That is a real input
  change, so the affected steps rerun (E1), and the note names the components.

### 4.2 The starting commit

- **In-place mode:** `HEAD` of the checkout at run start.
- **Worktree mode:** the commit the ticket branch is created from. It is read right after the branch
  is first created, and recorded once.
- It is never rewritten: not on resume, not after `--accept-head` (umbrella §4.1).
- It is not a fingerprinted input of any step in this ticket. It is the input ENG-478 needs. The umbrella's design-rules version is not needed: under the revised
  D9, an old run is adopted (§7.6) rather than finished under old rules.
- ENG-488 (`worktree add -B` resetting the branch on resume) is a separate defect. This design
  depends on the ticket branch surviving a resume; the PR names ENG-488 as a known limit for worktree
  mode until it lands.

## 5. Fingerprints and digests

### 5.1 Canonical encoding

- JSON with object keys sorted; strings normalised to Unicode NFC.
- No database ids and no timestamps.
- Lists in their meaningful order: work units by `seq`, checks by `ac_id` then `selector`, sets
  sorted.
- A scheme version, starting at 1. A step recorded under another scheme is treated as unfingerprinted
  and adopted (§7.6), never compared byte for byte.

### 5.2 What a step records

When a design-stage step succeeds, in the same transaction as `markSucceeded` and its `onSucceed`,
`workflow_step` gets these new nullable columns:
- `input_manifest`: a JSON map from each declared input name to its digest at that moment;
- `input_fingerprint`: SHA-256 of the canonical manifest;
- `output_digest`: only where the output lives outside the database (the plan);
- `fingerprint_scheme`;
- `generation`: an integer, 0 for a new step, incremented by each invalidate (§6).

Anything slow (a `git` call) is computed before the transaction and passed in.

### 5.3 Where each digest comes from

- **Snapshot inputs:** `ticket_input.digest`.
- **Outputs in the database** are computed from the current rows on every check. Only the fields the
  producing step wrote count; columns later stages change are excluded.
  - Work units with origin `extract`: `seq`, `kind`, `title`, `description`, `behavioral`,
    `test_plan`, `files_to_touch`, `verify_check_types`, `depends_on`; plus `ticket.needs_docs`.
  - Check owners: derived from the same rows (§3).
  - Track: `ticket.track`.
  - Acceptance checks: the active rows' `ac_id`, `selector`, `test_path`, `red_first_result`, and
    from each check's red-first signal only its check id, outcome and exit class (never its
    environment observation).
- **The plan.** When `design:dispatch` succeeds, the runner lists `docs/plans/*.md` at the branch head
  through git, keeps the files whose frontmatter `linear:` equals the ticket ident
  (`plan-frontmatter.ts:8-28`), and hashes path and content, sorted by path. A renamed or extra plan
  file changes the digest, which is conservative. The resolver never reads the worktree.

### 5.4 The walk

Before choosing the next design-stage step, the resolver walks the table in order:
1. Skip a step whose "applies when" is false.
2. A step that is not succeeded is the next step to run, and the walk stops there. One exception: a
   step reset by feedback (§6.5) still holds its last manifest. The walk compares it first, and on a
   mismatch invalidates the step with cause `inputs`, so an edit made while it waited is not absorbed
   by a scoped rerun.
3. A succeeded step's manifest is recomputed and compared with the recorded one.
   - A match: the step is done; continue.
   - A mismatch: return `{ kind: "invalidate", stepKeys: [step], reason: { cause: "inputs",
     changed: [names] } }`.
4. A gate row that fires returns its escalation, as today.
5. Past the last step: advance to implement.

Because the walk stops at the first step that is not done, an input whose producer is not succeeded is
never compared. Only the mismatched step is invalidated. Its dependants are judged afresh after it
reruns: if it produces the same output, they stay done; if not, the next pass invalidates them.

- The walk runs only while the ticket is in design. A resume past design records the change (E6),
  and a later return to design (a redesign) picks it up.
- `design:extract` and `design:size` move from row and column gating to this rule.

## 6. Applying an invalidate

`advance.ts` applies it in one transaction:
1. **Event.** Append one `note` event, reason `invalidated`, with the step keys, the cause and the
   changed input names. A `note` is not a `loopback`, so `v_rejection_counts` and
   `REVIEW_REPAIR_LIMIT` do not count it.
2. **History.** Copy the step's row into a new table, `workflow_step_history`, with the event id: its
   status, attempt, result, error, manifest, fingerprint, output digest, generation and timestamps.
3. **Reset.** Status back to `pending`, attempt to 0, result, error, manifest, fingerprint and output
   digest to NULL, `generation` incremented.
4. **Clear the step's outputs** (§6.1).

A rerun caused by an invalidate is a fresh round, so the attempt limit keeps its meaning. No design step
has an idempotency key today (`advance.ts:195-226`); dispatch ids are monotonic, so a rerun's effects
cannot collide with the previous generation's.

`resetProvision` (`provision.ts:263-284`), used on resume, goes through the same function with cause
`worktree-recreated`, so it too leaves history and bumps the generation. `resetProvisionIfManifestTouched`
runs inside `implement:dispatch` (`handlers.ts:1333`); it calls the same function from there, so
`advance.ts` is not its only caller.

### 6.1 Clearing rules

| Step invalidated | Cleared |
|---|---|
| `provision` | nothing in the database; it reruns |
| `design:dispatch` | nothing; the rerun revises the plan file in place, as a redesign does today |
| `design:extract` | all work units are deleted, reconcile units included, as `redesignLoopback` does today (a reconcile unit left behind would collide on `UNIQUE (ticket_id, seq)` or depend on units that no longer exist); code findings **and plan findings** are detached first (today only code findings are, `review-verdict.ts:184-186`, so unit-tied plan findings are cascade-deleted); `ticket.needs_docs` set to 0 |
| `design:size` | `ticket.track` set to NULL (a new setter) |
| `design:review` | nothing; `requiredPlanFindings` already reads only the latest `design:review` dispatch (`review-round.ts:35-40`) |
| `checks:dispatch` | active acceptance checks superseded (`superseded_at`); never deleted |
| `checks:classify` | `red_class` and `disposition` set to NULL on the active checks, so the rerun reclassifies them (classification is write-once today, `ac-check.ts:103-108`) |

**Checks are never deleted.** The whole-ticket persist path in `checks:dispatch` runs
`DELETE FROM ac_check WHERE ticket_id = ?` today (`handlers.ts` ~1012-1014, `ac-check.ts:86-87`). That
erases superseded history and resets the per-AC re-author counter (`ac-check.ts:163-166`). It changes
to superseding the active rows, as the scoped path already does.

### 6.2 Handlers that are safe to rerun

Journal gating means a crashed step reruns from the start, so every design handler's database outputs
must be written atomically. Each handler returns its rows in its result, and writes them in `onSucceed`,
inside the success transaction. Today extract inserts units one by one before `markSucceeded`
(`handlers.ts:570-585`), so a crash between the two leaves partial units, and the rerun hits
`UNIQUE (ticket_id, seq)`.

- In `onSucceed`, a step's own rows are written before any verdict reads them: `design:review`'s
  findings before `applyReviewVerdict`, `checks:classify`'s classifications before
  `applyChecksVerdict`.
- `checks:dispatch` gains an `onSucceed` for its `ac_check` persist. Its git commit and its
  append-only capability signals stay in `execute`.

### 6.3 Files on the branch (E7)

No files are restored. Instead, check identity changes.

- **Today** identity accepts only files the check commit *added* (`addedFilesAt`, `--diff-filter=A`,
  `worktree.ts:301-305`; `check-path.ts:52-62`). A re-author writes to the same canonical path
  (`<ident>_ac<N>_test.*`), which is a modification, so it is rejected. That appears to break today's
  checks loop re-author too. The plan starts with a failing test that confirms or refutes it.
- **New rule.** A check's test file is accepted when it is the canonical path for its AC, its content
  contains the declared test name, and it differs between the step generation's starting commit and
  the dispatch's commit (added or modified).
- **The generation's starting commit** is recorded on `workflow_step` (`generation_start_head`) the first
  time a generation starts running, and never moves within the generation. A crash rerun therefore
  still sees the crashed attempt's files as changed, and the agent need not rewrite identical content.
  Today the rerun's `preHead` is the crashed commit (`handlers.ts:700`), so every AC would be uncovered.
- **The superseded generation's test file** at the canonical path is overwritten by the re-author.
- **Limit:** a helper file or a tracked-file edit (for example `conftest.py`) made by an earlier
  generation remains on the branch. The PR and `SECURITY.md` say so.

### 6.4 Loopbacks

- **A plan-review redesign** (`design:review` blocking) keeps its event, which carries the feedback,
  and applies `invalidate([design:dispatch])` with cause `feedback`. The plan is an input of
  `design:review`, so a revised plan is always reviewed again.
- **A code-review redesign** (`onPlanDefect = redesign`), and `review-resume`'s retry-plan when HEAD
  moved (it calls `redesignLoopback` directly), apply `invalidate([design:dispatch, design:extract])`.
  Retry-plan without a moved HEAD calls `applyReviewVerdict('design:review')`, the plan-review path,
  and invalidates `design:dispatch` only (`review-resume.ts:139-149`). `redesignLoopback` takes the set
  as a parameter. The units are always re-created and re-implemented,
  with the code findings detached to the first unit, exactly as today. Without that, an unchanged plan
  would leave the units `verified` and the code findings would never reach an implementer.
- **Both** keep their later-stage resets (`review`, verify, merge) until ENG-475. Everything else in
  design follows from fingerprints: a redesign that changes the units now also reruns `design:size`,
  the track, and the checks whose owners changed.
- **The checks loop** (`applyChecksVerdict`) keeps its scoped reauthor. That is feedback, and it stays
  as it is.

### 6.5 Feedback belongs to a generation

Feedback lookups today take the latest loopback of the whole run and never expire:
`latestChecksReauthorAcs` (`checks-verdict.ts:60-68`), `checksFeedback` (`checks-feedback.ts:12-21`)
and `designFeedback` (`design-feedback.ts:18-30`). After an invalidate caused by inputs,
`checks:dispatch` would rerun scoped to ACs flagged in some earlier round and leave every other AC with
no active check.

- **Each loopback event records its consumer**: the step key that reads its feedback, and that step's
  generation. `routeTo` is not that step (it is `checks:classify` for the checks loop and `review` for
  a redesign), so the consumer is recorded separately.
  - A redesign applies its invalidate first, then appends its event with
    `{ consumer: "design:dispatch", generation: <after the bump> }`.
  - The checks loop resets without an invalidate, so its event records
    `{ consumer: "checks:dispatch", generation: <current> }`.
  - Loopbacks whose consumers are outside the design stage (the arbiter's re-author, the implement
    loops) record their consumer too, but their lookups are unchanged until ENG-475.
- **Each design-stage lookup** returns only events for its step key and current generation.
- **A step reset by feedback keeps its manifest** (§5.4), so an input edit made meanwhile is caught by
  the walk instead of being absorbed by a scoped rerun.
- An invalidate caused by inputs starts a new generation with no feedback; one caused by feedback
  carries its own loopback.

### 6.6 Livelock and the guard

A recorded manifest stops matching only when:
- something upstream reruns (the table has no cycles, §3.1 rule 3);
- a resume picks up an edited profile or config field, once per resume;
- a feedback loopback names the step, bounded by the existing review budget.

After a rerun the manifest equals the current inputs, so an unchanged step cannot be invalidated again.
Findings are never fingerprinted, so "findings to no findings" cannot loop.

**Guard, fail fast.** If the same step is invalidated with cause `inputs` more than three times since
the last `resumed` event, the resolver escalates with signature `invalidate-loop:<step>`. This catches
a defect such as an unstable digest.

## 7. Database upgrades

### 7.1 Migrations

- Numbered TypeScript files in `src/db/migrations/`, each with a version, a note and `up(db)`.
- `schema.sql` stays the complete current schema and creates fresh databases.

| On disk | What happens |
|---|---|
| no `schema_meta` | create from `schema.sql`, as today |
| current version | nothing |
| newer than the binary | refuse loudly, naming both versions |
| a shape this binary does not know (§7.4) | refuse, saying to start that run over with `--fresh` |
| older, known | run each pending migration in order |

How migrations run:
- **Backup.** Before the first migration, `VACUUM INTO '<name>.v<old>.<utc-timestamp>.bak'`, then print
  the path. A file copy is not used: with a reader holding a snapshot, a WAL checkpoint returns busy and
  the copy misses rows (probe, review M9). The timestamp keeps a retried upgrade from failing on an
  earlier backup (`VACUUM INTO` refuses an existing file). If the backup fails, the upgrade does not
  start.
- **Foreign keys** are turned off before the first `BEGIN` (inside a transaction the pragma is a silent
  no-op) and turned back on after the last commit.
- **Each migration** runs in `db.transaction.immediate`, inserts its `schema_meta` row, and ends with
  `PRAGMA foreign_key_check`; any row fails it. A failure rolls back that step, leaves the previous
  version, and exits loudly.

### 7.2 Table rebuilds

These follow SQLite's documented procedure ("Making Other Kinds Of Table Schema Changes",
sqlite.org/lang_altertable.html): create the new table, copy the rows, drop the old table, rename, and
recreate its indexes, triggers and any views that use it. The first real rebuild is in v7 → v8
(§7.4). A shared helper does it, with a test-only migration that exercises it on a table with incoming
foreign keys.

### 7.3 Proof

After migrating, Styre builds a fresh in-memory database from `schema.sql` and compares structure:
- `pragma table_xinfo` for every table;
- `index_list` and `index_xinfo`, and the `WHERE` text of partial indexes;
- `foreign_key_list`;
- view and trigger SQL with comments and whitespace removed.

Two rules keep the proof sound:
- **New columns go last** in `schema.sql`, in migration order, because `ALTER TABLE ADD COLUMN`
  appends; a column placed mid-table fails the proof (probe 4). The schema change checklist says so.
- **`AUTOINCREMENT`** is invisible to the pragmas (probe 6), and `ac_check` relies on it for supersede
  semantics. The proof also compares, per table, whether its comment-stripped SQL carries the token.

Text is never compared directly. `sqlite_master` keeps comments, comment-only edits landed inside v8
without a version change, `ALTER TABLE ADD COLUMN` produces different text from a fresh `CREATE`, and a
rebuild's rename quotes the table name (probes, review §14 C3). Pragmas do not expose CHECK
constraints, so tests probe each CHECK behaviourally on the migrated and the fresh database: the same
forbidden value must be rejected by both. At runtime the proof covers columns, indexes, foreign keys,
views, triggers and `AUTOINCREMENT`; CHECK constraints are covered in tests only, which is enough
because migrations are static code. Any difference fails loudly.

### 7.4 Known shapes and versions

| Shape | Seen in | Migration |
|---|---|---|
| v7 with the four `signal` budget columns | v0.8.0 to v0.9.0 | v7 → v8 rebuilds `signal` without them (`workflow_step.await_signal_id` references it), then creates `run` |
| v7 | v0.10.0 | v7 → v8 creates `run` |
| v7 bridged by `ensureRunTable`, on either v7 shape | resumed on v0.11+ | v7 → v8 handles each condition independently: rebuild `signal` if the budget columns are present; create `run` if absent |
| v8, three comment variants | b3be1be/v0.11 to v0.13.2; 6414689; 2b05680 | none; the structure is the same |

- **v8 → v9 (this ticket):** the new `workflow_step` columns (including `generation_start_head`);
  `work_unit.origin`, backfilled from `kind = 'reconcile'`; `ticket_input`; `workflow_step_history`. All
  are added columns or new tables; `event_log` is not rebuilt.
- Shapes are detected structurally against this list, never by version number alone.
- **v6 and older are refused.** v6 → v7 renamed columns (`linear_*` to `external_*`), so v6 checkpoints
  already cannot resume today. D9's "runs paused by an older Styre are upgraded" means v7 and later.
- `ensureRunTable` is removed; its job is the v7 → v8 migration.

### 7.5 Fixtures

One fixture per shape in §7.4: v0.9.0, v0.9.0 plus the bridge, v0.10.0, v0.10.0 plus the bridge,
v0.13.2, and main before this change. Each is produced by that release's own binary or `schema.sql`, seeded through that era's real
handlers where they can run, or from a recorded database of a real paused run. Hand-written rows miss
shapes like the bridge.

### 7.6 Old paused runs (D9)

- After migration, a v7 or v8 run's finished design steps have no manifest.
- On resume, after `recover()`, the provision reset and the snapshot (§4), and before the first resolver
  pass, an **adopt** pass records for each succeeded design-stage step with no manifest, or one under
  another scheme:
  - its manifest, from the current inputs;
  - for `design:dispatch`, the plan's digest at the branch head.
- One `note` event, reason `adopted`, lists them, and says plainly that an edit made between the pause
  and the upgrade cannot be detected.
- The steps then count as done with today's inputs, and the run continues under the new rules without
  rerunning them.
- A step that was not succeeded reruns as usual. An old run can have `ticket.track` set while
  `design:size` is pending (a crash between the two writes); it reruns, which spends one agent call if
  grading is on.
- A fresh run never needs the pass. A reused `--db` gets it if manifests are missing.

### 7.7 Who migrates, and who only reads

- `run` (fresh and resume) and `styre migrate` upgrade.
- `styre ls`, `styre clean`, and `--fresh`'s discard read a checkpoint without migrating it. They call
  `undoBeforeDiscard` (clean.ts:38-46, run.ts:378), which reads through the shared repository column
  lists. Once those lists grow, the read would throw on an old database, and ENG-485's in-place undo
  would be silently skipped (`interruption.ts:249-253`). These paths get their own narrow queries,
  which select only columns present since v7, and a test runs `ls`, `clean` and `--fresh` against every
  fixture.

## 8. Testing

Every test that involves design steps drives the real handlers through `advanceOneStep` with
`FakeAgentRunner`, and counts dispatches per step. Nothing is set up by writing step rows directly.

1. **Each input reruns exactly its dependants.** For every snapshot input: pause in design, edit,
   resume. Exactly the dependants rerun, and every other step keeps its dispatch count.
2. **E6.** Pause in implement, edit, resume: nothing in design reruns, the note says so, and a later
   redesign picks up the edit.
3. **No false changes.** A resume with nothing edited reruns nothing, in both in-place and worktree
   mode, including a profile with a component whose toolchain is missing.
4. **Early cutoff.**
   - A plan-review redesign that changes the plan reruns `design:review`.
   - A redesign that changes the units reruns size, review, and checks whose owners changed.
   - A redesign whose plan text changes but whose units and owners do not reruns extract and review,
     not checks.
   - A code-review redesign re-creates and re-implements the units even when the plan is identical.
5. **No livelock.** Plan review goes from findings to none; the run finishes in a fixed number of ticks.
6. **Feedback.** A checks loopback, then a profile edit, then resume: every AC gets an active check, and
   no stale feedback reaches the agent.
7. **Crashes.** A child process is SIGKILLed at each design step:
   - between the handler's work and the success commit;
   - right after the success commit;
   - right after an invalidate transaction.

   Resume must leave no duplicate or partial outputs, manifests that match the inputs, and no step run
   twice for the same inputs.
8. **Every output kind is cleared**, and history survives:
   - units (reconcile units included), `needs_docs`, track;
   - unit-tied plan findings are kept (detached);
   - superseded checks are kept, not deleted, and the re-author counter survives;
   - classifications are reset.
9. **Check identity (E7).**
   - A failing test first shows whether today's checks loop rejects a scoped re-author of an existing
     canonical file.
   - A re-author that modifies its canonical file is accepted; one that leaves it identical to the
     generation's starting commit is not.
   - A crash rerun of `checks:dispatch` accepts the crashed attempt's files without rewriting them.
   - A step reset by the checks loop, followed by a profile edit and a resume, is invalidated with cause
     `inputs`, and every AC is re-authored.
10. **The rules** of §3.1 each refuse their kind of bad table; the recording proxy test catches a
    handler reading an undeclared field; the source guard catches an accessor called from the wrong step.
11. **Migrations.** Every fixture in §7.5 to v9, with the structural proof and the CHECK probes; a newer
    database, an unknown shape and v6 refused; the backup written while another reader holds a snapshot;
    a failing `foreign_key_check` aborts; a failing migration leaves the previous version.
12. **D9.** A v8 paused run in worktree mode resumes on the new binary; the adopt pass records manifests;
    no finished design step reruns; the run completes.
13. **The guard.** A digest made deliberately unstable escalates with `invalidate-loop:<step>`.
14. **Canonical encoding.** Key order, NFC, ids and timestamps excluded.

Each key test is shown to fail when the code it guards is broken on purpose.

## 9. Docs, in the same PR

- **`minimal-loop.md`:** §1 design routing from the table; §2 the redesign rows.
- **`control-loop.md`:**
  - §2.3 the `invalidate` descriptor;
  - §4 the S1 guards ("done with these inputs");
  - §6.2 replay, with invalidate beside it;
  - §8.3 the atlas rows;
  - the start-up order and §10, where `migrate()` now really upgrades.
- **`build-operations.md`:** `migrate()`.
- **`runtime-parameters.md`:**
  - the migration messages: newer database, unknown shape, backup path;
  - the `inputs-changed`, `invalidated` and `adopted` notes;
  - the `invalidate-loop` escalation;
  - the table assertion's refusal.
- **`conventions.md`:** the `.bak` file next to a run's database.
- **`telemetry-export.md`:** the new `note` reasons.
- **`SECURITY.md`** and the PR: ENG-488 as the known limit for worktree mode (§4.2).
- **Both `schema.sql` copies, byte-identical.** `CLAUDE.md`'s table count goes to 19.
- **`brainstorm.md` §11:** a changelog entry.

## 10. Acceptance criteria → design

| ENG-477 criterion | Where |
|---|---|
| Changing a design input invalidates exactly its dependants, shown per input through real steps | §5.4, §8.1, §8.3, §8.4 |
| No livelock | §6.6, §8.5 |
| Crash after each design step | §6.2, §8.7 |
| Every output kind cleared on invalidate | §6.1, §6.3, §8.8, §8.9 |
| A v8 paused run resumes after an automatic migration and continues without rerunning finished design steps, on a real v8 database | §7.4 to §7.6, §8.11, §8.12 |
| The startup check refuses an inconsistent table | §3.1, §8.10 |
| Docs, both `schema.sql` copies, independent review before the PR | §9 |

## 11. Out of scope

- Other stages keep their reset lists (ENG-475).
- New design steps (ENG-478 and later).
- Moving the checklist derivation to run start (ENG-478).
- Re-fetching the ticket on resume (E2).
- Fixing `git worktree add -B` (ENG-488).

## 12. Risks

- **An unstable digest** would invalidate on every pass. Mitigated by the canonical encoding tests, the
  "no false changes" tests (§8.3) and the `invalidate-loop` guard.
- **The plan is outside the database.** If a later stage edits it, the recorded digest is stale. That
  only matters when the ticket is back in design, and a redesign names `design:dispatch` explicitly.
- **Stale helpers.** Under E7 an earlier generation's helper files and tracked-file edits stay on the
  branch after a checks rerun. They are listed as a limit; a later ticket can add a cleanup if they cause
  trouble in practice.
- **The `signal` rebuild for v0.8–v0.9 checkpoints** is the first real rebuild. The backup, the
  per-migration transaction, the foreign key check and the structural proof bound the damage.

## 13. Review record

- **rev 1 → rev 2**, independent review (2026-10-09), verdict revise: 4 critical, 13 major, 12 minor.
  Each finding and where rev 2 answers it:

| Finding | Answer |
|---|---|
| C1 plan-review redesign drops unit-tied findings and skips re-review | plan as an input of `design:review` and graded `design:size` (§3); plan findings detached before units are deleted (§6.1) |
| C2 checks rerun scoped to stale ACs | feedback belongs to a generation (§6.5) |
| C3 textual schema proof fails on real databases | structural proof plus CHECK probes (§7.3) |
| C4 ordinary resumes rerun design | one profile narrowing (§4.1); environment observations out of the model (§3.2) |
| M1 edits paused after design | E6 (§2, §5.4) |
| M2 walk semantics, fast track | stop at the first step not done; "applies when" column; routing generated from the table (§3, §5.4) |
| M3 checks hard-deleted | supersede only (§6.1) |
| M4 restore set and checks-loop change | full diff of the generation, invalidate-superseded only, through `commitWorktree` (§6.3) |
| M5 handlers not safe to rerun | outputs written in `onSucceed` (§6.2) |
| M6 reconcile units in the digest | `work_unit.origin` (§3.2) |
| M7 checks over-fingerprint units | check owners only (§3) |
| M8 table does not match handlers | corrected table, signals owned by step, classify clearing, `ctx.inputs` (§3, §6.1) |
| M9 backup incomplete | `VACUUM INTO` (§7.1) |
| M10 several shapes per version | known shapes and fixtures (§7.4, §7.5) |
| M11 non-migrating readers | narrow queries and a test per fixture (§7.7) |
| M12 code-review redesign with an identical plan | invalidate dispatch and extract (§6.4) |
| M13 starting commit | defined per mode; ENG-488 named (§4.2) |
| Minor 1 `event_log` rebuild | `note` reason instead (§6) |
| Minor 2 history event id | event appended first (§6) |
| Minor 3 runtime startup check | unit test plus an assertion on first use (§3.1) |
| Minor 4 adopt honesty and order | §7.6 |
| Minor 5 stale design feedback | §6.5 |
| Minor 6 `resetProvision` bypasses invalidate | §6 |
| Minor 7 `review_finding.superseded_at` | dropped; latest dispatch already scopes it (§6.1) |
| Minor 8 reused `--db` | §4, §7.6 |
| Minor 9 guard reset by any loopback | counts `inputs` invalidations since the last `resumed` (§6.6) |
| Minor 10 plan digest definition | §5.3 |
| Minor 11 rename quoting | structural proof (§7.3) |
| Minor 12 fixture realism | §7.5 |

- **rev 2 → rev 3**, independent review (2026-10-09), verdict revise: 2 critical, 6 major, 10 minor.

| Finding | Answer |
|---|---|
| C1 reconcile units collide on `seq` | all units deleted on an extract invalidate; `origin` backfilled (§3.2, §6.1) |
| C2 the restore can revert the plan | restore removed (E7, §6.3) |
| M1 a feedback reset absorbs a profile edit | a step reset by feedback keeps its manifest and the walk compares it (§5.4, §6.5) |
| M2 the feedback generation is undefined | loopbacks record their consumer and its generation, after the bump (§6.5) |
| M3 table gaps; enforcement mechanism | table corrected; tests, proxy, accessors, source guard (E8, §3) |
| M4 resume narrowing can exit 69 | narrowing without the refusal, after `--inspect` (§4.1) |
| M5 a crash rerun of checks fails identity | identity judged against the generation's starting commit (§6.3) |
| M6 the restore misses files and reverts implement work | restore removed (E7) |
| Minor 1 gate applicability | "when `design:review` applies" (§3) |
| Minor 2 retry-plan paths | per caller, `redesignLoopback` parameter (§6.4) |
| Minor 3 write order in `onSucceed` | §6.2 |
| Minor 4 proof gaps | column order and `AUTOINCREMENT` rules; CHECKs in tests (§7.3) |
| Minor 5 `VACUUM INTO` refuses an existing file | timestamped backup (§7.1) |
| Minor 6 fixtures | both v7 shapes with and without the bridge; structural detection (§7.4, §7.5) |
| Minor 7 unused plan findings digest | dropped (§5.3) |
| Minor 8 `resetProvisionIfManifestTouched` | stated (§6) |
| Minor 9 reused `--db` | rewritten as on resume (§4) |
| Minor 10 red-first signal fields | explicit fields (§5.3) |

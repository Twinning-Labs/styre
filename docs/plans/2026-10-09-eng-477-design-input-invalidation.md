# ENG-477 Design Stage Input Invalidation and Database Upgrades Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every design stage step "done" only when its recorded inputs still match, rerun exactly the steps whose inputs changed (with early cutoff), and give Styre a real, proven upgrade path for checkpoints written by v7 and v8 databases.

**Architecture:** One declared table (`src/daemon/design-graph.ts`) names each design step's inputs and outputs; the resolver's design routing is generated from it and walks it in order, comparing a manifest of input digests recorded at each step's success against digests recomputed from the run's SQLite (snapshot rows in `ticket_input`, output rows, and the plan digest recorded on `design:dispatch`). A mismatch returns an `invalidate` descriptor that `advance.ts` applies in one transaction (note event, history row, reset, output clearing); loopbacks use the same function with cause `feedback`. `migrate()` becomes a versioned runner with a `VACUUM INTO` backup, structural shape detection, one transaction per migration, and a structural proof against `schema.sql`; v7 → v8 replaces `ensureRunTable`, v8 → v9 adds the new columns and tables, and an adopt pass records manifests for runs paused by an older Styre.

**Tech Stack:** TypeScript on Bun, bun:sqlite, bun:test

**Spec:** docs/brainstorms/2026-10-09-eng-477-design-input-invalidation-design.md

---

## Global Constraints

- Both schema copies stay byte-identical: `src/db/schema.sql` and `docs/architecture/schema.sql` (`cmp` them in every task that edits either).
- New columns go last in their `CREATE TABLE`, after the last existing column and before any table constraint (`UNIQUE (...)`), in migration order, because `ALTER TABLE ADD COLUMN` appends.
- No coined hyphenated compound words in prose, messages or docs; write the words out ("starting commit", not a hyphenated coinage). Existing names (`step_key`, `--accept-head`) stay as they are. Machine identifiers (event reasons such as `inputs-changed`, cause values such as `manifest-touched`, crash point names such as `before-commit`, shape ids such as `v7-signal-budget`) follow the codebase's existing kebab case convention for such names (`leftover-check`, `step-replay-no-progress`); operator ruling (2026-10-09): docs always show them in backticks with a plain English explanation beside each, and prose never uses them as words.
- Commit messages are Conventional Commits (`type(eng-477): subject`), and end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Never commit to `main`. Work stays on `feat/eng-477-design-input-invalidation`. Never push in this plan.
- Fail fast and loud: an invariant violation throws with the step, rule or file named; nothing is skipped silently.
- Exit codes: `70` (`EX_SOFTWARE`) for a design table that breaks a rule of spec §3.1 and for a migration that fails; `75` (`EX_TEMPFAIL`) for the resume pause when a required suite's tools are missing (`needs_you`); `65` for a refused checkpoint (newer, unknown shape, older than v7). `--resume` never exits `69`.
- Backups use `VACUUM INTO '<db file>.v<old version>.<UTC timestamp with milliseconds>.bak'`, written next to the database before the first migration; a failed backup stops the upgrade. Never a file copy.
- Canonical encoding (spec §5.1): JSON with object keys sorted, every string (keys included) normalised to Unicode NFC, `undefined` object members dropped, no database ids and no timestamps in any digest, lists in their meaningful order (work units by `seq`, sets sorted), scheme version `FINGERPRINT_SCHEME = 1`.
- No faked state in tests: new tests reach states only through real steps (`advanceOneStep` with `FakeAgentRunner`, `runImpl`, `resumeRun`) and public functions. No new test writes `workflow_step` rows directly. The stated exceptions, each because no real step can produce the state:
  - Task 12: fixture relocation (pointing a restored recording at its new temporary repository).
  - Task 2: the structural probes. The CHECK probes (`SEED_ROWS_V8`/`V9`, `probeChecks`) insert valid rows inside a savepoint and roll them back; the foreign key test inserts an orphan `workflow_step` row with foreign keys off, because a real step can never write one.
  - Task 13, `a succeeded design step with no manifest is refused loudly`: it calls the journal's public `runStep` for `provision` without the advance path. A succeeded design step without a manifest comes only from an older Styre, which an in process test cannot drive; Task 12's D9 test covers the real path through a recorded v8 run.
  - Task 13, `a manifest recorded under an older scheme counts as changed`, and Task 12, `a manifest from an older scheme is never adopted again`: they restamp a real step's manifest with the previous scheme number through the repository's `recordManifest`. A manifest under an older scheme comes only from an older release of this binary, which an in process test cannot run.
  - Task 14 Step 6, `review-verdict.test.ts` `redesign loopback gives the design steps their attempt budget back (STYRE-7)`: an existing unit test of `applyReviewVerdict` whose whole file builds its state with repository calls; the rewrite changes which step it seeds (`design:dispatch` with two attempts), and a scripted agent cannot make a real `design:dispatch` fail twice and then succeed.
  - Task 14 Step 6, `review-resume.test.ts`: an existing unit test file of `planReviewResume` that builds all its state with repository calls; its plan review cases add the `escalated` event the interpreter writes when the run stops at the plan review gate (`stopAtPlanGate`), and the new case appends the events that decide the retry-plan condition. The real path is covered end to end by Task 14's budget pause test and Task 14's recorded v8 plan gate resumes.
  - Task 16, `invalidate-loop.test.ts`: it appends a `resumed` event and a `reused-database` note to mark a restart without a second process; the note's real writer is covered by that file's reused `--db` test.
- Operator test safety rules, in every step that runs tests:
  - put a time limit on every `bun test` as `perl -e 'alarm 600; exec @ARGV' bun test <file>`, and on every other command that can hang: `perl -e 'alarm 300; exec @ARGV' bun run lint`, `perl -e 'alarm 300; exec @ARGV' bun run typecheck`, `perl -e 'alarm 300; exec @ARGV' bunx biome check --write <files>`, `perl -e 'alarm 120; exec @ARGV' git fetch --tags`. Where a step says "lint and typecheck pass", it means those two commands;
  - never `pkill` or `killall`; a test stops only the child it started, by its own pid;
  - every child process a test or script starts has a hard time limit: `Bun.spawnSync` always gets a `timeout` (git calls `30_000`, the fixture seeders `60_000`, the v8 drivers `300_000`); a `Bun.spawn` child is claimed with `ownChild` from `test/helpers/own-processes.ts` right after it starts (so the preload's end of run check sees it), is killed through its own handle, and bounds itself (no endless sleep loop); every test that starts a child process (git through the helpers included) passes an explicit bun test timeout as the third argument of `test(...)`;
  - never edit anything under `src/util/process/` that changes who may be signalled (Task 3 only narrows the reads in `interruption.ts`);
  - never write to the real `~/.local/state`: every test and script sets `XDG_STATE_HOME` (the test preload already does; scripts and child processes get it explicitly);
  - no real `claude`: agents are `FakeAgentRunner`; the agent CLI preflight is injected as `() => ({ ok: true, version: null })`.
- Temporary folders (PR #154, on `main` and under this branch): `test/preload.ts` fails any `bun test` run that leaves something in its temp root. Every new test and helper makes its folders with `makeTempDir(prefix)` (or registers a path it creates itself with `trackTempPath(path)`) from `test/helpers/temp.ts`, never with a bare `mkdtempSync`; the helpers remove them when the test (or, for a folder made outside a test, the run) ends. A call that runs `styre run` or a resume (which keep the run's `styre-wt-*` worktree root, also in place) is wrapped in `trackTempEntriesMadeBy("styre-wt-", () => ...)`. Scripts that run outside `bun test` (`scripts/db-fixtures/`) put every temporary folder, their children's included (`TMPDIR`), under one work folder they remove at the end.
- Fixtures and reads (operator ruling, 2026-10-09): a test never opens a committed fixture in place; it works on a private copy (`copyFixture`, `copyRecordedRun`). Every read of a database that must not change it, in production (`--inspect`, the narrow readers of `ls`, `clean` and `--fresh`, and `priorRunIdAt`, the pause's read of the copy it overwrites) and in tests (`fixtureVersion`, the fixture tests, the harness's `read`, and every existing test that reads a run database), goes through the one helper `readCopyOf` (`src/db/read-copy.ts`, Task 1): it copies the file and its `-wal`/`-shm` files into a private temporary folder, opens the copy, and removes the folder in a `finally`. The original is never opened, in any journal mode (a read only open of a WAL database without its side files fails on macOS, and with them it can write beside it). The committed fixtures are in rollback journal (DELETE) mode, checked by a test that reads their file headers. The `.db` fixtures are tracked through a `.gitignore` negation (Task 1), proved with `git ls-files`.
- Lint: `bun run lint` is `biome check .` (formatter on, `lineWidth` 100, organized imports, the recommended rules). The whole file blocks in this plan are formatted with the repository's `biome.json`; the fragments that edit existing files are not, so before each commit run `perl -e 'alarm 300; exec @ARGV' bunx biome check --write <the files the task touched>` and then `bun run lint`.
- New stderr messages start with `run: `, `resume: ` or `migrate: ` (and `clean`'s own new lines with `styre clean: `, as all of `clean`'s messages already do), never `styre: ` (the `styre: ` messages are pinned by `test/lifecycle/messages-doc.test.ts`). One exemption: `styre migrate`'s closing summary line keeps its existing `<verb>: <path> (schema v<N>)` shape (`bootstrapped: ...`, `already current: ...`), and Task 2's new `upgraded from v<old>: <db> (schema v<new>)` is another verb of that same line.
- Checks steps (`checks:dispatch`, `checks:classify`) are outside the table and keep today's rules (E9). No code in this plan changes their gating, feedback or identity rules.

## Review Focus

1. **A profile with a component whose toolchain is missing, on resume.** A fresh run narrows it away; an unchanged resume on the same host must narrow identically and record no `inputs-changed` note. Test: Task 8, "no false change when a component's toolchain was already missing at the fresh run".
2. **An unchanged resume in worktree mode.** The worktree is recreated (new absolute path), `provision` is reset with cause `worktree-recreated`, and nothing else may rerun. Test: Task 13, "an unchanged resume in worktree mode reruns only provision, for the recreated worktree".
3. **A v7 checkpoint bridged by `ensureRunTable` on the v0.9.0 shape** (budget columns on `signal` plus a `run` table, still version 7). It must rebuild `signal`, keep `workflow_step.await_signal_id` valid, and not try to create `run` again. Test: Task 2, "v7 bridged on the v0.9.0 shape migrates: signal rebuilt, run kept, foreign keys intact".
4. **A crash in the middle of `design:extract`**, after the agent returned but before the success commit. The rerun must not hit `UNIQUE (ticket_id, seq)` and must leave exactly one set of units. Tests: Task 11 (in process, a commit that throws once) and Task 17 (a child process SIGKILLed at that point).
5. **A plan file renamed by the agent between design rounds.** The plan digest is over path and content, so a rename changes it and reruns the plan's readers; an unrelated `docs/plans/*.md` without this ticket's `linear:` frontmatter must not. Test: Task 9, "a renamed plan changes the digest; another ticket's plan and a nested file do not".
6. **A v8 run whose upstream design step is not succeeded when it is upgraded** (operator ruling C1, 2026-10-09): escalated at the plan review gate (resumed with HEAD moved, and with HEAD unchanged), or paused during a redesign with `complexityGrading` on. The adopt pass must stop at the first applicable step that is not succeeded, record the succeeded steps after it with an empty manifest ("will rerun"), never throw, and each run must finish. Tests: Task 12 (the pass, in process, on copies of the recordings) and Task 14 (the plan gate and redesign recordings resumed end to end), with the three recorded v8 runs from Task 1.
7. **A resume after a plan review redesign that did not stop at the plan review gate** (operator rulings, 2026-10-09): `retry-plan` must not fire, or the run never leaves the redesign; and a run that did stop at the gate must still be seen as stopped when another kind of escalation (the projector, the resume's toolchain pause) follows the stop, while an escalation of another kind that merely carries the `design:review` dispatch id (the invalidate loop guard) must not count. Tests: Task 14, "a budget pause in the regenerated design:dispatch after a plan review redesign resumes and dispatches it", "a gate stop resumed on a host missing a required suite's tools ...", and the `review-resume.test.ts` cases.
8. **A structural proof that fails.** It runs inside the last migration's transaction, so the database stays at its old version with the backup in place (no later run can accept it silently). Test: Task 2, "a failed structural proof rolls back the last migration and keeps the backup".
9. **A release that changes what a digest depends on** (operator ruling, 2026-10-09). A manifest under an older `FINGERPRINT_SCHEME` must count as changed in design, never be adopted again, and the pin test must fail until the scheme is bumped. Tests: Task 9 `fingerprint-pin.test.ts`, Task 13 "a manifest recorded under an older scheme counts as changed", Task 12 "a manifest from an older scheme is never adopted again".
10. **`--resume --inspect` on any checkpoint** (operator rulings, 2026-10-09 and 2026-10-10): read only whatever the version: no migration, no backup, no run row (`insertRun`, `markResumed`), no open of the original; a report either way, also where resume would refuse. Test: Task 3, `--resume --inspect reports it and writes nothing` for every fixture (the bytes are compared).
11. **Reads that must not change a database** (operator ruling, 2026-10-09). `--inspect`, the narrow readers of `ls`, `clean` and `--fresh`, `priorRunIdAt`, and every test's read of a run database go through `readCopyOf` (a source guard, Task 4, refuses read only opens elsewhere): a WAL checkpoint with no `-wal`/`-shm` beside it is read, a live `-wal` is included, and the original's bytes and folder are unchanged. Tests: Task 1 `test/db/read-copy.test.ts`, Task 3 `a WAL checkpoint without -wal or -shm beside it is read through a private copy and left as it was`.
12. **`clean` on a checkpoint it cannot use, and the names it builds paths from** (operator rulings, 2026-10-10: ENG-477 adds no new way to delete anything, and the clean and ls additions are cut back to what it needs). `styre clean <ident>` (and `--purge`) on an unreadable or incompatible checkpoint must exit 65 and leave every file, worktree and branch as it was, naming the reason, the checkpoint folder and the worktrees that look like the run's as plain text, with no shell command; a folder without `run.db` stays exit 64; `clean --all` skips both kinds, and `ls` and `clean --all` reach exactly today's folders (a nested slug's finished checkpoint is not reaped; symbolic links are followed as today). An ident that is not one folder name, or a slug with a part that is not one (`team/..`, `/abs`, `a//b`, `a/./b`), exits 64 (78 when the slug comes from a profile file) before any path is built from it, in `clean` (including `--all`), `styre run` fresh and `--resume`, and `styre setup`; a nested slug such as `team/app` works through a fresh run, its pause, `--resume` and `clean <ident>`. Tests: Task 3 `test/cli/checkpoint-readers-fixtures.test.ts`, with the deliberate breaks of Task 3 Step 6.
13. **The operator rulings of 2026-10-10 beyond clean and ls.** A reused `--db` prepares every active ticket in it (snapshot, adopt pass, notes), and `wiring.test.ts`'s reused database test stays green (Tasks 7, 12, 16); a resume, and a fresh run on a reused `--db`, refuse a run fingerprinted under a newer scheme with 65 before they write anything, and `--inspect` says so (Task 13); `design:dispatch` escalates an uncommitted plan at once, with no retry (Task 9). Tests: `snapshot-e2e.test.ts`'s two reused database cases, `walk-resume-e2e.test.ts`'s two newer scheme cases, `manifest-recording.test.ts`'s uncommitted plan case.

## File Structure

Created:

| File | Responsibility |
|---|---|
| `scripts/db-fixtures/generate.ts` | Regenerates every historical database fixture from git history (worktrees at each release). |
| `scripts/db-fixtures/seed-era.ts` | Creates one database with a given release's own `migrate()` and repositories, and seeds it. |
| `scripts/db-fixtures/drive-v8-run.ts` | Drives a real worktree mode run with the 2b05680 code to one of three stops (a budget pause in implement; an escalation at the plan review gate; a budget pause in the regenerated `design:dispatch` of a redesign with grading on) and records it. |
| `test/fixtures/db/*.db`, `test/fixtures/db/v8-*/*` | The committed fixtures (one per known shape, plus v6 for refusal, plus the three recorded v8 runs). |
| `test/helpers/db-fixtures.ts` | Names the fixtures and copies them, and the recorded runs, into temporary folders for a test. |
| `src/db/read-copy.ts` | `readCopyOf`: reads a database through a private copy, never opening the original. |
| `test/helpers/check-probes.ts` | Seed rows and one forbidden update per CHECK constraint, for the behavioural CHECK proof. |
| `src/db/migrations/types.ts` | The `Migration` interface. |
| `src/db/migrations/rebuild.ts` | SQLite's documented table rebuild procedure as one helper. |
| `src/db/migrations/0008-run-table.ts` | v7 → v8: rebuild `signal` without the budget columns when present; create `run` when absent. |
| `src/db/migrations/0009-design-inputs.ts` | v8 → v9: new `workflow_step` columns, `work_unit.origin` with backfill, `ticket_input`, `workflow_step_history`. |
| `src/db/migrations/index.ts` | The ordered migration list and `CURRENT_VERSION`. |
| `src/db/migrations/shapes/v7-signal-budget.sql`, `v7.sql`, `v8.sql` | Reference DDL of each released shape (verbatim `git show`). |
| `src/db/schema-shape.ts` | Structural description of a database and the difference between two descriptions. |
| `src/db/known-shapes.ts` | Detects which known released shape a database has. |
| `src/db/repos/checkpoint-read.ts` | Narrow, v7-safe reads for `ls`, `clean` and `--fresh`. |
| `src/db/repos/ticket-input.ts` | The `ticket_input` repository. |
| `src/db/repos/step-history.ts` | The `workflow_step_history` repository. |
| `src/daemon/canonical.ts` | Canonical JSON, SHA-256, `FINGERPRINT_SCHEME`. |
| `src/daemon/design-graph.ts` | The declared design table, its four rules, and lookups over it. |
| `src/daemon/design-inputs.ts` | Snapshot values, `captureSnapshot`, the starting commit, snapshot reads. |
| `src/daemon/design-digests.ts` | Output digests (units, track, plan), current manifests, manifest recording. |
| `src/daemon/invalidate.ts` | `invalidateSteps`: note event, history, reset, output clearing, in one transaction. |
| `src/daemon/design-outputs.ts` | The success commits of the design handlers and the clearing rules. |
| `src/daemon/adopt.ts` | The adopt pass for steps that succeeded under an older Styre. |
| `src/daemon/design-walk.ts` | The walk over the table that the resolver's design case delegates to. |
| `src/daemon/current-step.ts` | The module slot holding the step key in flight. |
| `src/daemon/design-reads.ts` | Named accessors for upstream rows, checked against the current step. |
| `src/cli/checkpoint-name.ts` | The one check of an ident or slug (a slug may nest with `/`), and `checkpointPath`, which keeps a checkpoint path inside its root (Task 3). |
| `test/helpers/design-script.ts` | The scripted `FakeAgentRunner` for design runs (plan, units, grade, findings, park). |
| `test/helpers/design-steps.ts` | In process ticket with real handlers, driven step by step through `advanceOneStep`. |
| `test/helpers/design-harness.ts` | Whole `styre run` / `--resume` through `runImpl`, with editable profile, config and host tools. |
| `test/fixtures/design/crash-resume.ts` | Child process driver that resumes a run and blocks at a named crash point, bounded in time. |
| Tests listed per task. | |

Modified:

| File | Change |
|---|---|
| `.gitignore` | A negation so the committed `.db` fixtures are tracked. |
| `src/db/migrate.ts` | Versioned runner, backup, shape detection, proof inside the last migration's transaction, refusals. |
| `src/db/schema.sql`, `docs/architecture/schema.sql` | v9. |
| `src/db/repos/run.ts` | `ensureRunTable` removed. |
| `src/db/repos/workflow-step.ts` | New columns in the row, `recordManifest`, `resetForInvalidate`. |
| `src/db/repos/work-unit.ts` | `origin`. |
| `src/db/repos/ticket.ts` | `clearTicketTrack`. |
| `src/daemon/failure-policy.ts` | Reconcile units inserted with `origin: "reconcile"`. |
| `src/daemon/resolver.ts` | Design case delegates to the walk; `invalidate` descriptor. |
| `src/daemon/advance.ts` | Snapshot precondition, success commit composition, manifest recording, invalidate, current step slot. |
| `src/daemon/step-registry.ts` | Optional per handler success commit. |
| `src/engine/step-journal.ts` | `onSucceed` receives the result. |
| `src/daemon/review-verdict.ts`, `src/daemon/review-resume.ts` | `redesignLoopback` takes the set to invalidate; consumer and generation on the event; retry-plan only when the run stopped at the plan review gate. |
| `src/daemon/run-ticket.ts` | `runTicket` captures the snapshot, notes a reused database, and runs the adopt pass. |
| `src/dispatch/handlers.ts` | Design handlers return their rows and commit them in `onSucceed`; plan digest; starting commit; accessors. |
| `src/dispatch/design-feedback.ts` | Feedback scoped to `design:dispatch`'s current generation. |
| `src/dispatch/run-dispatch.ts`, `src/cli/park.ts` | Carryover tied to the parked step's generation; resume order; narrowing and pause. |
| `src/dispatch/provision.ts` | `resetProvision` through `invalidateSteps`. |
| `src/dispatch/plan-frontmatter.ts`, `src/dispatch/worktree.ts` | Frontmatter from text; plan files at a ref through git. |
| `src/cli/run.ts`, `src/cli/preflight.ts`, `src/cli/migrate.ts`, `src/cli/checkpoints.ts`, `src/cli/clean.ts`, `src/cli/ls.ts`, `src/util/process/interruption.ts` | Wiring, shared toolchain decision, migration messages, narrow readers; every read of a checkpoint that must not change it goes through `readCopyOf` (Task 3); `ls` lists the checkpoints it cannot use; `clean` refuses them, naming the folder and the worktrees that look like the run's. |
| `src/cli/load-profile.ts`, `src/cli/setup.ts`, `src/cli/errors.ts` | The slug and ident check before a path is built (`run` and `setup`); exit 65 comments (Task 3). |
| `test/helpers/db.ts`, `test/helpers/skeleton-registry.ts`, `test/helpers/run-harness.ts` and the existing tests named per task (among them `test/migrate-cli.test.ts` and `test/cli/toolchain-gate-invariant.test.ts`) | Snapshot capture, plan digests in mocks, real steps instead of seeded rows, the new schema version and toolchain notice; `runFreshTicket` takes an optional slug (Task 3). |
| `CLAUDE.md`, `README.md` (its exit code table), `docs/architecture/{minimal-loop,control-loop,build-operations,runtime-parameters,conventions,telemetry-export}.md`, `SECURITY.md`, `docs/architecture/brainstorm.md` | Spec §9. |

### Task order, and where it differs from the suggested order

0. The branch is rebased onto `origin/main` at 625e154 (done 2026-10-10). That base includes PR #154 (`test/helpers/temp.ts`, the temp folder guard in `test/preload.ts`, the rewritten `test/helpers/db.ts`) and PR #156 (each project command a Styre process starts gets one `styre-cmd-*` temp folder under `tmpdir()`, removed at exit or by a later sweep; `test/preload.ts` checks it). Every task below, and every line number in it, is written against that base.
1. Fixtures (moved first): the migration tests in Task 2 consume them, and the three recorded v8 runs must be produced by v8 code (`2b05680`), which the generator reaches through a git worktree, so the order is free; generating them first keeps Task 2's tests real from their first run.
2. `migrate()` and v7 → v8. 3. Readers that do not migrate (moved before v9): they must be in place before `WorkflowStepRow` grows, or `ls`/`clean` break on old checkpoints in between. 4. v8 → v9.
5. Canonical encoding. 6. The table. 7. Snapshot and starting commit (and the test harnesses). 8. Resume narrowing.
9. Manifests on success. 10. `invalidateSteps` (moved before the walk): the walk returns `invalidate`, so the interpreter must exist first. 11. Handlers safe to rerun (before the walk, so an invalidated extract can rerun atomically). 12. The adopt pass (moved before the walk): the walk refuses a succeeded step without a manifest, so every path that can bring one (resume, reused `--db`) must adopt first.
13. The walk. 14. Loopbacks, feedback, carryover. 15. Accessors, current step slot, recording proxy, source guard. 16. The invalidate loop guard. 17. End to end tests of spec §8. 18. Docs.

---

### Task 1: Historical database fixtures

**Files:**
- Create: `scripts/db-fixtures/generate.ts`, `scripts/db-fixtures/seed-era.ts`, `scripts/db-fixtures/drive-v8-run.ts`
- Create (generated, committed): `test/fixtures/db/v6-v0.7.0.db`, `v7-v0.9.0.db`, `v7-v0.9.0-bridged.db`, `v7-v0.10.0.db`, `v7-v0.10.0-bridged.db`, `v8-v0.13.2.db`, `v8-main-2b05680.db`; the recorded runs `test/fixtures/db/v8-paused-worktree/{run.db,transcript.json,repo.bundle,meta.json}`, `test/fixtures/db/v8-plan-gate-worktree/{run.db,repo.bundle,meta.json}` (a needs_you pause writes no transcript), `test/fixtures/db/v8-redesign-graded-worktree/{run.db,transcript.json,repo.bundle,meta.json}`
- Modify: `.gitignore` (after the `# SQLite (local databases)` block, lines 149-152: a negation for the fixtures), `biome.json` (line 3: `test/fixtures/db/**` joins `files.ignore`)
- Create: `src/db/read-copy.ts` (`readCopyOf`: the one helper every read that must not change a database goes through) and `test/db/read-copy.test.ts`
- Create: `test/helpers/db-fixtures.ts`
- Test: `test/db/fixtures.test.ts`

The refs, found with `git tag` and `git log -p -- src/db/schema.sql` and `git show <ref>:src/db/schema.sql`:

| Fixture | Ref | Shape |
|---|---|---|
| `v6-v0.7.0` | `v0.7.0` | version 6 (the last v6 release; `5450ae0` moved to v7) |
| `v7-v0.9.0` | `v0.9.0` | version 7, `signal` has `attempts, max_attempts, first_attempt_at, last_attempt_at` (same schema as v0.8.0) |
| `v7-v0.9.0-bridged` | `v0.9.0` + the `ensureRunTable` DDL from `b3be1be:src/db/repos/run.ts` | version 7, budget columns, plus `run` |
| `v7-v0.10.0` | `v0.10.0` | version 7, budget columns dropped by `df03fad` without a version bump |
| `v7-v0.10.0-bridged` | `v0.10.0` + the bridge DDL | version 7 plus `run` |
| `v8-v0.13.2` | `v0.13.2` | version 8 (`b3be1be` text, v0.11.0 to v0.13.2) |
| `v8-main-2b05680` | `2b05680` | version 8, main before this change (comment variants `6414689` and `2b05680` have the same structure; `6414689` is in v0.14.0, released after the first revision of this plan; the fixture keeps `2b05680`) |
| `v8-paused-worktree` | `2b05680` code, driven | a real worktree mode run paused (budget) at `implement:wu1:dispatch` |
| `v8-plan-gate-worktree` | `2b05680` code, driven | a real worktree mode run that got the same blocking plan finding twice: one redesign, then the escalation at the plan review gate (`needs_you`, stage `design`, every design step succeeded) |
| `v8-redesign-graded-worktree` | `2b05680` code, driven | a real worktree mode run with `complexityGrading` on whose first plan review blocked; the redesign's regenerated `design:dispatch` paused (budget). `design:size` is succeeded (v8's redesign never reset it) while `design:dispatch` is running and `design:extract` and `design:review` are pending |

The v7 and v6 fixtures are written through each release's own `migrate()` and repositories with chosen rows, not by driving that release's handlers: the migration and reader tests need rows that no single real run of those releases leaves together (a reconcile unit, a step waiting on a signal, an interrupted running step with its note). Every column and constraint is still the release's own. The recorded v8 runs cover the real handler path for the version that resumes on this binary. Hand off note 11 records this for the operator (spec §7.5 says "seeded through that era's real handlers where they can run").

**Interfaces:**
- Consumes: `makeTempDir` (`test/helpers/temp.ts`, PR #154).
- Produces: `readCopyOf<T>(path: string, fn: (db: Database) => T, opts?: ReadCopyOptions): T`, `READ_COPY_ATTEMPTS = 3` and `interface ReadCopyOptions { copyFile?: (from: string, to: string) => void }` (tests only) in `src/db/read-copy.ts`; `FIXTURES: readonly FixtureName[]` where `type FixtureName = "v6-v0.7.0" | "v7-v0.9.0" | "v7-v0.9.0-bridged" | "v7-v0.10.0" | "v7-v0.10.0-bridged" | "v8-v0.13.2" | "v8-main-2b05680"`; `MIGRATABLE_FIXTURES: readonly FixtureName[]` (all but v6); `copyFixture(name: FixtureName): string` (path of a fresh temporary copy); `fixtureVersion(path: string): number`; `RECORDED_RUNS: readonly RecordedRun[]` where `type RecordedRun = "v8-paused-worktree" | "v8-plan-gate-worktree" | "v8-redesign-graded-worktree"`; `copyRecordedRun(name: RecordedRun): string` (a temporary folder holding a copy of every file of that recording); `interface RecordedMeta { slug: string; ident: string; branch: string; scenario: string; targetRepoAtRecording: string; worktreeRootAtRecording: string }`.

- [ ] **Step 0: The private copy reader (operator ruling, 2026-10-09)**

Every read of a database that must not change it (`--inspect`, the narrow readers of `ls`, `clean` and `--fresh`, `fixtureVersion` and the fixture tests, the harness's reads of a checkpoint) goes through one helper: it copies the file, and its `-wal` and `-shm` files when present, into a private temporary folder, opens the copy, and removes the folder in a `finally`. The original is never opened, in any journal mode. This also matters for reading at all: a read only open of a WAL database whose `-wal`/`-shm` files are absent fails on macOS (SQLite 3.54) with `unable to open database file`.

```ts
// test/db/read-copy.test.ts
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { copyFileSync, existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readCopyOf } from "../../src/db/read-copy.ts";
import { makeTempDir } from "../helpers/temp.ts";

/** The private copies readCopyOf makes in the temp root (the tests' own folders use another prefix). */
const copies = () => readdirSync(tmpdir()).filter((n) => n.startsWith("styre-readcopy-"));
/** Every file in `dir` with its bytes, to prove a read changed nothing beside the database. */
const filesOf = (dir: string) =>
  readdirSync(dir)
    .sort()
    .map((f) => [f, readFileSync(join(dir, f)).toString("base64")]);

function walDb(dir: string): string {
  const path = join(dir, "run.db");
  const db = new Database(path);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("CREATE TABLE t (v TEXT); INSERT INTO t VALUES ('main');");
  db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
  db.close();
  return path;
}

test("a WAL database with no -wal or -shm beside it is read, and nothing beside it changes", () => {
  const dir = makeTempDir("styre-rc-test-");
  const path = walDb(dir);
  for (const ext of ["-wal", "-shm"]) rmSync(`${path}${ext}`, { force: true });
  const before = filesOf(dir);
  const rows = readCopyOf(path, (db) => db.query<{ v: string }, []>("SELECT v FROM t").all());
  expect(rows).toEqual([{ v: "main" }]);
  expect(filesOf(dir)).toEqual(before);
});

test("a database with a live -wal file is read including the pages not yet in the main file", () => {
  const dir = makeTempDir("styre-rc-test-");
  const path = walDb(dir);
  const writer = new Database(path);
  try {
    writer.exec("PRAGMA wal_autocheckpoint = 0;");
    writer.exec("INSERT INTO t VALUES ('only in the wal')");
    expect(existsSync(`${path}-wal`)).toBe(true);
    const before = filesOf(dir);
    const rows = readCopyOf(path, (db) =>
      db.query<{ v: string }, []>("SELECT v FROM t ORDER BY rowid").all(),
    );
    expect(rows).toEqual([{ v: "main" }, { v: "only in the wal" }]);
    expect(filesOf(dir)).toEqual(before);
  } finally {
    writer.close();
  }
});

test("a missing path throws and creates nothing", () => {
  const dir = makeTempDir("styre-rc-test-");
  const before = copies().length;
  expect(() => readCopyOf(join(dir, "absent.db"), () => 1)).toThrow("does not exist");
  expect(readdirSync(dir)).toEqual([]);
  expect(copies().length).toBe(before);
});

test("the private copy is removed afterwards, also when the reader throws", () => {
  const dir = makeTempDir("styre-rc-test-");
  const path = walDb(dir);
  const before = copies().length;
  expect(readCopyOf(path, () => copies().length)).toBe(before + 1); // it exists while reading
  expect(copies().length).toBe(before);
  expect(() =>
    readCopyOf(path, () => {
      throw new Error("the reader failed");
    }),
  ).toThrow("the reader failed");
  expect(copies().length).toBe(before);
});

test("a write between copying the main file and its -wal is seen: the copy is taken again, cleanly", () => {
  const dir = makeTempDir("styre-rc-test-");
  const path = walDb(dir);
  const writer = new Database(path);
  try {
    writer.exec("PRAGMA wal_autocheckpoint = 0;");
    let mainCopies = 0;
    const rows = readCopyOf(
      path,
      (db) => db.query<{ v: string }, []>("SELECT v FROM t ORDER BY rowid").all(),
      {
        copyFile: (from, to) => {
          copyFileSync(from, to);
          if (from !== path) return;
          mainCopies += 1;
          // a writer commits between this copy of the main file and the copy of its -wal
          if (mainCopies === 1) writer.exec("INSERT INTO t VALUES ('written mid copy')");
        },
      },
    );
    expect(mainCopies).toBe(2);
    expect(rows).toEqual([{ v: "main" }, { v: "written mid copy" }]);
  } finally {
    writer.close();
  }
});

test("a source that changes during every attempt is refused with a clear error", () => {
  const dir = makeTempDir("styre-rc-test-");
  const path = walDb(dir);
  const writer = new Database(path);
  const before = copies().length;
  try {
    writer.exec("PRAGMA wal_autocheckpoint = 0;");
    let n = 0;
    expect(() =>
      readCopyOf(path, () => 1, {
        copyFile: (from, to) => {
          copyFileSync(from, to);
          if (from === path) writer.exec(`INSERT INTO t VALUES ('write ${n++}')`);
        },
      }),
    ).toThrow(`could not get a stable copy of ${path} after 3 attempts`);
    expect(n).toBe(3);
    expect(copies().length).toBe(before);
  } finally {
    writer.close();
  }
});
```

```ts
// src/db/read-copy.ts
import { Database } from "bun:sqlite";
import {
  closeSync,
  copyFileSync,
  existsSync,
  mkdtempSync,
  openSync,
  readSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

/** How many times readCopyOf copies a database that would not hold still before it gives up. */
export const READ_COPY_ATTEMPTS = 3;

export interface ReadCopyOptions {
  /** Tests only: the file copy, so a test can write between copying the main file and its -wal. */
  copyFile?: (from: string, to: string) => void;
}

/** The WAL header's checkpoint sequence and two salts (bytes 12 to 23): they change whenever a
 *  checkpoint restarts the WAL, which a size and a time alone can miss. */
function walHeaderOf(file: string): string | null {
  const fd = openSync(file, "r");
  try {
    const buf = Buffer.alloc(12);
    return readSync(fd, buf, 0, 12, 12) === 12 ? buf.toString("hex") : null;
  } finally {
    closeSync(fd);
  }
}

/** Size, modification time and (for -wal) the WAL header of the database and its -wal. The -shm is
 *  copied but not compared: the copy's first connection rebuilds that index from the -wal, and a
 *  reader of the original updates its read marks there, which would force retries for nothing. */
function sourceState(path: string): string {
  return JSON.stringify(
    [path, `${path}-wal`].map((file) => {
      try {
        if (!existsSync(file)) return [file, "absent"];
        const st = statSync(file);
        return [file, st.size, st.mtimeMs, file.endsWith("-wal") ? walHeaderOf(file) : null];
      } catch (err) {
        return [file, `unreadable: ${String(err)}`];
      }
    }),
  );
}

/** Read a database without opening it (operator ruling, 2026-10-09; spec §7.7). The file, and its
 *  `-wal` and `-shm` files when present, are copied into a private temporary folder; `fn` reads the
 *  copy, opened read write there (SQLite needs that to read a WAL copy without its `-shm`); the
 *  folder is removed in a finally, whatever happens. The original is never opened, in any journal
 *  mode, so nothing beside it is created or changed. A missing path throws and creates nothing.
 *
 *  Against a live writer: the size, modification time and WAL header of each source file are taken
 *  before and after the copy, and a copy during which any of them moved is taken again, up to
 *  READ_COPY_ATTEMPTS times; then it throws `could not get a stable copy of <path> after 3
 *  attempts`. The limits: a write that changes none of those (the same size, a modification time
 *  within the file system's resolution, no WAL restart) is not seen, so under a writer that never
 *  pauses a copy is very likely, not certain, to be consistent; and a database in rollback journal
 *  (DELETE) mode is copied without its `-journal`, so a write in progress there is not seen either
 *  (no Styre writer uses that mode; the committed fixtures, which do, have no writer). The callers
 *  read under the run lock or after its check, except `styre ls`, which only displays what it read.
 *
 *  A caller must not copy a database its own process holds open: copying opens and closes the
 *  original, and on POSIX closing any handle to a file drops every lock the process holds on it,
 *  including those its own open connection relies on (SQLite's documented hazard). No production
 *  caller does it (`priorRunIdAt` runs after `dumpPark` closed the run's connection). The tests
 *  that do (`signals.test.ts`, `e2e-interrupt.test.ts`, reading a run database their own writer
 *  still has open) are a stated case: one process, no other user of the file, and the copy is
 *  only read. */
export function readCopyOf<T>(
  path: string,
  fn: (db: Database) => T,
  opts: ReadCopyOptions = {},
): T {
  if (!existsSync(path)) throw new Error(`readCopyOf: ${path} does not exist`);
  const copyFile = opts.copyFile ?? copyFileSync;
  const dir = mkdtempSync(join(tmpdir(), "styre-readcopy-"));
  try {
    const copy = join(dir, basename(path));
    let stable = false;
    let lastError = "";
    for (let attempt = 1; attempt <= READ_COPY_ATTEMPTS && !stable; attempt++) {
      for (const ext of ["", "-wal", "-shm"]) rmSync(`${copy}${ext}`, { force: true });
      const before = sourceState(path);
      try {
        copyFile(path, copy);
        for (const ext of ["-wal", "-shm"]) {
          if (existsSync(`${path}${ext}`)) copyFile(`${path}${ext}`, `${copy}${ext}`);
        }
        stable = sourceState(path) === before;
        if (!stable) lastError = "the files changed while they were copied";
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
      }
    }
    if (!stable) {
      throw new Error(
        `could not get a stable copy of ${path} after ${READ_COPY_ATTEMPTS} attempts (${lastError})`,
      );
    }
    const db = new Database(copy);
    try {
      return fn(db);
    } finally {
      db.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
```

Run: `perl -e 'alarm 600; exec @ARGV' bun test test/db/read-copy.test.ts` before writing `src/db/read-copy.ts` (FAIL: `Cannot find module '../../src/db/read-copy.ts'`), then after (PASS, 6 tests). Break it: open `path` itself instead of the copy (`new Database(path, { readonly: true })`): the first test fails with `unable to open database file` on macOS (or on the changed directory listing where SQLite creates the `-shm`). Restore. Break it again: make `stable` always `true` after the first copy: the two new tests fail (one copy of the main file; no error). Restore.

- [ ] **Step 1: Write the fixture sanity test (it fails: no fixtures yet)**

```ts
// test/db/fixtures.test.ts
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { readCopyOf } from "../../src/db/read-copy.ts";
import {
  FIXTURES,
  RECORDED_RUNS,
  type RecordedMeta,
  type RecordedRun,
  copyFixture,
  copyRecordedRun,
  fixtureVersion,
} from "../helpers/db-fixtures.ts";

const EXPECTED: Record<string, { version: number; budget: boolean; run: boolean }> = {
  "v6-v0.7.0": { version: 6, budget: true, run: false },
  "v7-v0.9.0": { version: 7, budget: true, run: false },
  "v7-v0.9.0-bridged": { version: 7, budget: true, run: true },
  "v7-v0.10.0": { version: 7, budget: false, run: false },
  "v7-v0.10.0-bridged": { version: 7, budget: false, run: true },
  "v8-v0.13.2": { version: 8, budget: false, run: true },
  "v8-main-2b05680": { version: 8, budget: false, run: true },
};

interface RecordedExpect {
  files: string[];
  scenario: string;
  ticket: { stage: string; status: string };
  steps: Record<string, string>;
  lastEventKind: string;
}
const ALL_FILES = ["run.db", "transcript.json", "repo.bundle", "meta.json"];
const RECORDED: Record<RecordedRun, RecordedExpect> = {
  "v8-paused-worktree": {
    files: ALL_FILES,
    scenario: "implement-budget",
    ticket: { stage: "implement", status: "waiting" },
    steps: {
      provision: "succeeded",
      "design:dispatch": "succeeded",
      "design:extract": "succeeded",
      "design:size": "succeeded",
      "design:review": "succeeded",
    },
    lastEventKind: "parked",
  },
  "v8-plan-gate-worktree": {
    files: ["run.db", "repo.bundle", "meta.json"],
    scenario: "plan-gate",
    ticket: { stage: "design", status: "waiting" },
    steps: {
      provision: "succeeded",
      "design:dispatch": "succeeded",
      "design:extract": "succeeded",
      "design:size": "succeeded",
      "design:review": "succeeded",
    },
    lastEventKind: "escalated",
  },
  "v8-redesign-graded-worktree": {
    files: ALL_FILES,
    scenario: "redesign-budget-graded",
    ticket: { stage: "design", status: "waiting" },
    steps: {
      provision: "succeeded",
      "design:dispatch": "running",
      "design:extract": "pending",
      "design:size": "succeeded",
      "design:review": "pending",
    },
    lastEventKind: "parked",
  },
};

describe("historical database fixtures", () => {
  for (const name of FIXTURES) {
    test(`${name} has the shape its release wrote`, () => {
      const path = copyFixture(name);
      const want = EXPECTED[name];
      expect(fixtureVersion(path)).toBe(want.version);
      readCopyOf(path, (db) => {
        const signalCols = db
          .query<{ name: string }, []>("PRAGMA table_info('signal')")
          .all()
          .map((c) => c.name);
        expect(signalCols.includes("attempts")).toBe(want.budget);
        const hasRun =
          db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='run'").get() !== null;
        expect(hasRun).toBe(want.run);
        if (want.version >= 7) {
          // Seeded through that release's own repositories (seed-era.ts).
          const running = db
            .query<{ step_key: string }, []>(
              "SELECT step_key FROM workflow_step WHERE status = 'running'",
            )
            .all();
          expect(running.map((r) => r.step_key)).toEqual(["implement:wu1:dispatch"]);
          const reconcile = db.query("SELECT 1 FROM work_unit WHERE kind = 'reconcile'").get();
          expect(reconcile).not.toBeNull();
          const awaiting = db
            .query("SELECT 1 FROM workflow_step WHERE await_signal_id IS NOT NULL")
            .get();
          expect(awaiting).not.toBeNull();
        }
      });
    });
  }

  for (const name of RECORDED_RUNS) {
    test(`the recorded v8 run ${name} is the stop its scenario drove, in worktree mode`, () => {
      const want = RECORDED[name];
      const dir = copyRecordedRun(name); // never the committed files in place
      for (const f of want.files) expect(existsSync(join(dir, f))).toBe(true);
      const meta = JSON.parse(readFileSync(join(dir, "meta.json"), "utf8")) as RecordedMeta;
      expect(meta.ident).toBe("ENG-1");
      expect(meta.scenario).toBe(want.scenario);
      const dbPath = join(dir, "run.db");
      expect(fixtureVersion(dbPath)).toBe(8);
      readCopyOf(dbPath, (db) => {
        const t = db
          .query<{ stage: string; status: string }, []>("SELECT stage, status FROM ticket")
          .get();
        expect(t).toEqual(want.ticket);
        const steps = Object.fromEntries(
          db
            .query<{ step_key: string; status: string }, []>(
              "SELECT step_key, status FROM workflow_step WHERE step_key IN ('provision', 'design:dispatch', 'design:extract', 'design:size', 'design:review')",
            )
            .all()
            .map((r) => [r.step_key, r.status]),
        );
        expect(steps).toEqual(want.steps);
        const last = db
          .query<{ kind: string }, []>("SELECT kind FROM event_log ORDER BY seq DESC LIMIT 1")
          .get();
        expect(last?.kind).toBe(want.lastEventKind);
        const latest = db
          .query<{ worktree_path: string }, []>(
            "SELECT worktree_path FROM dispatch WHERE worktree_path IS NOT NULL ORDER BY id DESC LIMIT 1",
          )
          .get();
        expect(latest?.worktree_path).not.toBe(meta.targetRepoAtRecording); // worktree mode
      });
    });
  }
});

test("every committed fixture is in rollback journal (DELETE) mode, never WAL", () => {
  // Read from the file header, never opened as a database: bytes 18 and 19 are the file format
  // write and read versions, 1 for a rollback journal and 2 for WAL (sqlite.org/fileformat2.html).
  const committed = join(import.meta.dir, "..", "fixtures", "db");
  const files = [...FIXTURES.map((f) => `${f}.db`), ...RECORDED_RUNS.map((r) => join(r, "run.db"))];
  for (const f of files) {
    const header = readFileSync(join(committed, f)).subarray(18, 20);
    expect([f, header[0], header[1]]).toEqual([f, 1, 1]);
  }
});
```

- [ ] **Step 2: Run it and see it fail**

Run: `perl -e 'alarm 600; exec @ARGV' bun test test/db/fixtures.test.ts`
Expected: FAIL with `Cannot find module '../helpers/db-fixtures.ts'`.

- [ ] **Step 3: Write the fixture helper**

```ts
// test/helpers/db-fixtures.ts
import { copyFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { readCopyOf } from "../../src/db/read-copy.ts";
import { makeTempDir } from "./temp.ts";

/** One committed database per known released shape (spec §7.4, §7.5), plus v6 for the refusal.
 *  Produced by scripts/db-fixtures/generate.ts from each release's own code; never hand-written. */
export const FIXTURES = [
  "v6-v0.7.0",
  "v7-v0.9.0",
  "v7-v0.9.0-bridged",
  "v7-v0.10.0",
  "v7-v0.10.0-bridged",
  "v8-v0.13.2",
  "v8-main-2b05680",
] as const;
export type FixtureName = (typeof FIXTURES)[number];
export const MIGRATABLE_FIXTURES: readonly FixtureName[] = FIXTURES.filter(
  (f) => f !== "v6-v0.7.0",
);

/** The recorded v8 runs (scripts/db-fixtures/drive-v8-run.ts), one folder each. */
export const RECORDED_RUNS = [
  "v8-paused-worktree",
  "v8-plan-gate-worktree",
  "v8-redesign-graded-worktree",
] as const;
export type RecordedRun = (typeof RECORDED_RUNS)[number];

/** meta.json of a recorded run. */
export interface RecordedMeta {
  slug: string;
  ident: string;
  branch: string;
  scenario: string;
  targetRepoAtRecording: string;
  worktreeRootAtRecording: string;
}

const DIR = join(import.meta.dir, "..", "fixtures", "db");

/** A private copy, so no test ever opens a committed fixture: even a read only open of a WAL
 *  database writes `-shm` and `-wal` files beside it. The folder is removed for the caller. */
export function copyFixture(name: FixtureName): string {
  const dest = join(makeTempDir(`styre-fixture-${name}-`), "run.db");
  copyFileSync(join(DIR, `${name}.db`), dest);
  return dest;
}

/** A private copy of every file of a recorded run, in a folder removed for the caller. */
export function copyRecordedRun(name: RecordedRun): string {
  const dest = makeTempDir(`styre-recorded-${name}-`);
  for (const f of readdirSync(join(DIR, name))) copyFileSync(join(DIR, name, f), join(dest, f));
  return dest;
}

export function fixtureVersion(path: string): number {
  return readCopyOf(path, (db) => {
    const row = db.query<{ v: number }, []>("SELECT MAX(version) AS v FROM schema_meta").get();
    if (row === null) throw new Error(`${path}: schema_meta is empty`);
    return row.v;
  });
}
```

- [ ] **Step 4: Write the seeder (runs one release's own code)**

```ts
// scripts/db-fixtures/seed-era.ts
// Usage: bun scripts/db-fixtures/seed-era.ts <eraRoot> <out.db> <bridge|plain>
// Creates <out.db> with the release checked out at <eraRoot>: that release's own migrate() and
// schema.sql, and rows written through that release's own repositories (spec §7.5). The rows cover
// what the migrations and the readers that do not migrate must handle: succeeded design steps, a
// reconcile unit, a step waiting on a signal (the incoming foreign key the v7 -> v8 `signal`
// rebuild must keep), and an interrupted in-place step with its interruption note (what `--fresh`
// and `clean` read).
import type { Database } from "bun:sqlite";
import { join } from "node:path";

const [eraRoot, out, mode] = process.argv.slice(2);
if (!eraRoot || !out || (mode !== "bridge" && mode !== "plain")) {
  throw new Error("usage: seed-era.ts <eraRoot> <out.db> <bridge|plain>");
}
// Bounded on its own, so nothing outlives a generator that was stopped (its limit is 60 s).
setTimeout(() => {
  process.stderr.write("seed-era: time limit reached\n");
  process.exit(3);
}, 50_000).unref();
const era = (p: string) => import(join(eraRoot, p));

// Verbatim from b3be1be:src/db/repos/run.ts (ensureRunTable), the resume bridge v0.11+ applied to
// v7 checkpoints without bumping their version.
const BRIDGE_DDL = `CREATE TABLE IF NOT EXISTS run (
       id          INTEGER PRIMARY KEY,
       run_id      TEXT    NOT NULL,
       started_at  TEXT    NOT NULL,
       provider    TEXT    NOT NULL,
       resumed     INTEGER NOT NULL DEFAULT 0 CHECK (resumed IN (0,1)),
       attempt     INTEGER NOT NULL DEFAULT 1
     )`;

const { migrate } = await era("src/db/migrate.ts");
const { openDb } = await era("src/db/client.ts");
const projects = await era("src/db/repos/project.ts");
const tickets = await era("src/db/repos/ticket.ts");

migrate(out);
const db: Database = openDb(out);
const version = db.query<{ v: number }, []>("SELECT MAX(version) AS v FROM schema_meta").get()?.v;
if (version === undefined) throw new Error(`${out}: no schema_meta row`);

const projectId = projects.insertProject(db, {
  slug: "fixture",
  targetRepo: "/nonexistent/styre-fixture-repo",
  defaultBranch: "main",
});
const ticketId = tickets.insertTicket(db, {
  projectId,
  ident: "ENG-1",
  title: "Fixture ticket",
  description: "Fixture body",
  typeLabel: "Feature",
  branchPrefix: "feat",
});

if (version >= 7) {
  const steps = await era("src/db/repos/workflow-step.ts");
  const units = await era("src/db/repos/work-unit.ts");
  const signals = await era("src/db/repos/signal.ts");
  const dispatches = await era("src/db/repos/dispatch.ts");
  const events = await era("src/db/repos/event-log.ts");
  for (const [stepKey, stepType] of [
    ["provision", "provision"],
    ["design:dispatch", "dispatch"],
    ["design:extract", "dispatch"],
    ["design:size", "dispatch"],
  ]) {
    const s = steps.insertPending(db, { ticketId, stepKey, stepType });
    steps.markSucceeded(db, s.id, { fixture: stepKey });
  }
  const u1 = units.insertWorkUnit(db, {
    ticketId,
    seq: 1,
    kind: "backend",
    title: "Unit one",
    description: "Do the thing",
    behavioral: 0,
    testPlan: null,
    filesToTouch: ["src/a.ts"],
    verifyCheckTypes: [],
    dependsOn: [],
  });
  units.insertWorkUnit(db, {
    ticketId,
    seq: 2,
    kind: "reconcile",
    behavioral: 0,
    verifyCheckTypes: [],
    dependsOn: [1],
  });
  tickets.setTicketTrack(db, ticketId, "fast");
  tickets.setTicketStage(db, ticketId, "implement");
  const signal = signals.insertPending(db, {
    ticketId,
    signalType: "human_resume",
    reason: "fixture pause",
  });
  db.query(
    "UPDATE workflow_step SET await_signal_id = ? WHERE ticket_id = ? AND step_key = 'design:size'",
  ).run(signal.id, ticketId);
  const running = steps.insertPending(db, {
    ticketId,
    workUnitId: u1.id,
    stepKey: "implement:wu1:dispatch",
    stepType: "dispatch",
  });
  steps.markRunning(db, running.id, {});
  const startedAt = steps.getById(db, running.id).started_at;
  dispatches.insertDispatch(db, {
    ticketId,
    dispatchId: "ENG-1-d0001",
    seq: 1,
    workUnitId: u1.id,
    stepId: running.id,
    stage: "implement",
    model: "fixture-model",
    startedAt,
    worktreePath: "/nonexistent/styre-fixture-repo",
  });
  events.appendEvent(db, {
    ticketId,
    kind: "note",
    reason: "interrupted",
    payload: {
      event: "interrupted",
      stepId: running.id,
      attempt: 1,
      startedAt,
      signal: "SIGTERM",
      worktree: "/nonexistent/styre-fixture-repo",
      untrackedBefore: [],
      dispatchRowId: null,
      headAtStart: null,
      headAtStop: null,
    },
  });
}
if (mode === "bridge") db.exec(BRIDGE_DDL);
db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
db.close();
```

The repository names used here (`insertProject`, `insertTicket`, `setTicketTrack`, `setTicketStage`, `insertPending`, `markSucceeded`, `markRunning`, `getById`, `insertWorkUnit`, signal `insertPending`, `insertDispatch`, `appendEvent`) exist with these parameter shapes at `v0.9.0` and every later ref (checked with `git show v0.9.0:src/db/repos/<file>.ts`); `v0.7.0` is seeded only with `migrate`, `insertProject` and `insertTicket`.

- [ ] **Step 5: Write the v8 run driver (runs the 2b05680 code)**

```ts
// scripts/db-fixtures/drive-v8-run.ts
// Usage: XDG_STATE_HOME=<tmp> XDG_CONFIG_HOME=<tmp> TMPDIR=<tmp> \
//   bun scripts/db-fixtures/drive-v8-run.ts <eraRoot> <outDir> <scenario>
// Drives a real worktree mode `styre run` with the 2b05680 code (the last v8 writer) and a scripted
// fake agent to one stop, and records it (spec §7.5: a recorded database of a real paused run).
// Two units that are not behavioural, so the track is full and design:review runs; no runnable
// check framework, so checks:dispatch authors nothing.
//   implement-budget        every design step succeeds; the implement dispatch hits a session limit
//   plan-gate               every plan review returns the same blocking finding: one redesign, then
//                           the escalation at the plan review gate (needs_you)
//   redesign-budget-graded  complexityGrading on; the first plan review blocks, and the redesign's
//                           regenerated design:dispatch hits a session limit
// Writes to <outDir>: run.db, transcript.json (budget pauses only), repo.bundle, meta.json.
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCENARIOS = ["implement-budget", "plan-gate", "redesign-budget-graded"] as const;
type Scenario = (typeof SCENARIOS)[number];
const [eraRoot, outDir, scenarioArg] = process.argv.slice(2);
if (!eraRoot || !outDir || !SCENARIOS.includes(scenarioArg as Scenario)) {
  throw new Error(`usage: drive-v8-run.ts <eraRoot> <outDir> <${SCENARIOS.join("|")}>`);
}
const scenario = scenarioArg as Scenario;
if (!process.env.XDG_STATE_HOME) throw new Error("set XDG_STATE_HOME to a temporary folder");
// Bounded on its own, so nothing outlives a generator that was stopped (its limit is 300 s).
setTimeout(() => {
  process.stderr.write("drive-v8-run: time limit reached\n");
  process.exit(3);
}, 280_000).unref();
const era = (p: string) => import(join(eraRoot, p));

const { FakeAgentRunner } = await era("src/agent/fake-runner.ts");
const { DEFAULT_AGENT_CONFIG } = await era("src/config/agent-config.ts");
const { DEFAULT_RUNTIME_CONFIG } = await era("src/config/runtime-config.ts");
const { runTicket } = await era("src/daemon/run-ticket.ts");
const { openDb } = await era("src/db/client.ts");
const { migrate } = await era("src/db/migrate.ts");
const { insertRun } = await era("src/db/repos/run.ts");
const { buildDispatchRegistry } = await era("src/dispatch/handlers.ts");
const { parseProfile } = await era("src/dispatch/profile.ts");
const { finishRunResult, parkDir } = await era("src/cli/park.ts");
const { fakeIssueTracker } = await era("src/integrations/adapters/fake-issue-tracker.ts");
const { fakeForge } = await era("src/integrations/adapters/fake-forge.ts");

function git(args: string[], cwd: string): string {
  const r = Bun.spawnSync(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    timeout: 30_000,
  });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
  return r.stdout.toString().trim();
}

// tmpdir() is the generator's work folder (TMPDIR), which it removes.
const repo = mkdtempSync(join(tmpdir(), "styre-v8-recording-repo-"));
git(["init", "-b", "main"], repo);
git(["config", "user.email", "t@s.dev"], repo);
git(["config", "user.name", "T"], repo);
writeFileSync(join(repo, "README.md"), "fixture\n");
git(["add", "-A"], repo);
git(["commit", "-m", "init"], repo);

const ABSENT_RC = {
  topology: { type: "cli" },
  data: { presence: "absent" },
  caching: { presence: "absent" },
  observability: { presence: "absent" },
  configSecrets: { presence: "absent" },
  documentation: { presence: "absent" },
  releasePackaging: { mechanism: "none" },
};
const profile = parseProfile({
  slug: "fixture",
  targetRepo: repo,
  defaultBranch: "main",
  checksSystem: "none",
  components: [
    {
      name: "app",
      kind: "ruby",
      paths: ["**"],
      commands: { build: "true", test: "true", check: "true" },
    },
  ],
  promptVars: { stack: "ruby" },
  runtimeContext: ABSENT_RC,
});
const sidecar = (v: unknown) => `Done.\n\n\`\`\`styre-sidecar\n${JSON.stringify(v)}\n\`\`\`\n`;
const ok = (stdout: string) => ({
  completed: true,
  exitCode: 0,
  stdout,
  stderr: "",
  timedOut: false,
  costUsd: null,
  tokensIn: null,
  tokensOut: null,
});
const sessionLimit = () => ({
  completed: false,
  exitCode: 1,
  stdout: "partial output written before the session limit",
  stderr: "You have reached your session limit · resets tomorrow",
  timedOut: false,
  costUsd: null,
  tokensIn: null,
  tokensOut: null,
  cause: "session-limit",
  resetAt: "tomorrow",
});
// The same fields as test/helpers/design-script.ts unitsOf(2, { behavioral: false }), so a resumed
// run that extracts again gets the same units digest.
const units = [1, 2].map((seq) => ({
  seq,
  kind: "backend",
  title: `Unit ${seq}`,
  description: `Change ${seq}`,
  behavioral: false,
  test_plan: null,
  files_to_touch: [`lib/u${seq}.rb`],
  verify_check_types: [],
  depends_on: [],
}));
const blocking = {
  severity: "critical",
  category: "feasibility",
  location: "plan:Unit 1",
  rationale: "RECORDED-BLOCKING-FINDING",
  factors: null,
  deferral_candidate: false,
  work_unit_seq: null,
};
const calls = { dispatch: 0, review: 0 };
const runner = new FakeAgentRunner((input: { prompt: string; cwd: string }) => {
  if (input.prompt.includes("You are designing ticket")) {
    calls.dispatch += 1;
    if (scenario === "redesign-budget-graded" && calls.dispatch === 2) return sessionLimit();
    mkdirSync(join(input.cwd, "docs", "plans"), { recursive: true });
    writeFileSync(
      join(input.cwd, "docs", "plans", "eng-1-plan.md"),
      `---\nlinear: ENG-1\n---\n\nRecorded plan, version ${calls.dispatch}\n`,
    );
    return ok("Plan written.");
  }
  if (input.prompt.includes("You are extracting the work breakdown")) {
    return ok(sidecar({ units, cdotImpact: {} }));
  }
  if (input.prompt.includes("You are grading the COMPLEXITY")) {
    return ok(sidecar({ dimensions: { coupling: 0, blast_radius: 0, difficulty: 0 }, overall: 6 }));
  }
  if (input.prompt.includes("You are the independent plan reviewer")) {
    calls.review += 1;
    const block =
      scenario === "plan-gate" || (scenario === "redesign-budget-graded" && calls.review === 1);
    return ok(sidecar({ findings: block ? [blocking] : [] }));
  }
  if (input.prompt.includes("You are implementing work-unit")) return sessionLimit();
  throw new Error(`drive-v8-run: unexpected prompt: ${input.prompt.slice(0, 80)}`);
});

const dbPath = join(parkDir("fixture", "ENG-1"), "run.db");
mkdirSync(parkDir("fixture", "ENG-1"), { recursive: true });
migrate(dbPath);
const db = openDb(dbPath);
insertRun(db, {
  runId: `v8-recording-${scenario}`,
  startedAt: new Date().toISOString(),
  provider: "claude",
});
const worktreeRoot = mkdtempSync(join(tmpdir(), "styre-v8-recording-wt-"));
const registry = buildDispatchRegistry({
  runner,
  agentConfig: DEFAULT_AGENT_CONFIG,
  profile,
  worktreeRoot,
  inPlace: false,
});
const ingested = {
  ident: "ENG-1",
  title: "Recorded ticket",
  description: "Recorded body",
  typeLabel: "Feature",
  externalId: "uuid-v8-recording",
  url: null,
};
const runtimeConfig =
  scenario === "redesign-budget-graded"
    ? { ...DEFAULT_RUNTIME_CONFIG, complexityGrading: true }
    : DEFAULT_RUNTIME_CONFIG;
const out = await runTicket({
  db,
  profile,
  runtimeConfig,
  ports: { issueTracker: fakeIssueTracker({ ticket: ingested }), forge: fakeForge() },
  registry,
  ticketRef: "ENG-1",
  ingested,
});
const reason = scenario === "plan-gate" ? "needs_you" : "budget";
if (out.outcome !== "paused" || out.reason !== reason) {
  throw new Error(`drive-v8-run: expected a ${reason} pause, got ${out.outcome}/${out.reason}`);
}
// A budget pause goes through dumpPark (it checkpoints the WAL and writes transcript.json). A
// needs_you pause only closes the database, so fold the WAL in first.
if (reason === "needs_you") db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
finishRunResult(db, dbPath, "fixture", "ENG-1", out);
copyFileSync(dbPath, join(outDir, "run.db"));
const transcript = join(parkDir("fixture", "ENG-1"), "transcript.json");
if (existsSync(transcript)) copyFileSync(transcript, join(outDir, "transcript.json"));
git(["worktree", "prune"], repo);
git(["bundle", "create", join(outDir, "repo.bundle"), "--all"], repo);
const meta = {
  slug: "fixture",
  ident: "ENG-1",
  branch: "feat/ENG-1",
  scenario,
  targetRepoAtRecording: repo,
  worktreeRootAtRecording: worktreeRoot,
};
writeFileSync(join(outDir, "meta.json"), `${JSON.stringify(meta, null, 2)}\n`);
// finishRunResult set the exit code of a paused `styre run` (75). This script succeeded.
process.exitCode = 0;
```

- [ ] **Step 6: Write the generator**

```ts
// scripts/db-fixtures/generate.ts
// Usage (from the repository root, with full history and tags): bun scripts/db-fixtures/generate.ts
// Rewrites test/fixtures/db/. Each fixture is produced by its own release's code, checked out in a
// temporary git worktree (spec §7.5). The v8 runs are driven by 2b05680, with this checkout's
// node_modules linked in (bun.lock is the same at 2b05680 and at this branch's base, 625e154;
// package.json differs only in its version). It must exist: the script refuses to start without it. Nothing is written under the real ~/.local/state, and nothing is left in the
// system temp folder: every child gets XDG folders and a TMPDIR inside one work folder, removed at
// the end. Each child has a time limit here and bounds itself too. If this script is killed, run
// `git worktree prune` and remove the work folder it printed.
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "../..");
const OUT = join(ROOT, "test/fixtures/db");
// The v8 driver runs 2b05680's own code, which imports npm packages (zod). Without this
// checkout's node_modules the link below would dangle, and Bun would resolve those imports from
// wherever it finds them, or not at all. Fail loudly before anything is made.
const MODULES = join(ROOT, "node_modules");
if (!existsSync(MODULES)) {
  throw new Error(
    `db-fixtures: ${MODULES} is missing; run \`bun install --frozen-lockfile\` in ${ROOT} first`,
  );
}
const ERAS = [
  { name: "v6-v0.7.0", ref: "v0.7.0", bridge: false },
  { name: "v7-v0.9.0", ref: "v0.9.0", bridge: false },
  { name: "v7-v0.9.0-bridged", ref: "v0.9.0", bridge: true },
  { name: "v7-v0.10.0", ref: "v0.10.0", bridge: false },
  { name: "v7-v0.10.0-bridged", ref: "v0.10.0", bridge: true },
  { name: "v8-v0.13.2", ref: "v0.13.2", bridge: false },
  { name: "v8-main-2b05680", ref: "2b05680", bridge: false },
] as const;
const RECORDINGS = [
  { dir: "v8-paused-worktree", scenario: "implement-budget" },
  { dir: "v8-plan-gate-worktree", scenario: "plan-gate" },
  { dir: "v8-redesign-graded-worktree", scenario: "redesign-budget-graded" },
] as const;

function run(argv: string[], cwd: string, env: Record<string, string>, timeoutMs: number): void {
  const r = Bun.spawnSync(argv, {
    cwd,
    stdout: "inherit",
    stderr: "inherit",
    env: { ...process.env, ...env },
    timeout: timeoutMs,
  });
  if (r.exitCode !== 0) {
    throw new Error(`${argv.join(" ")} exited ${r.exitCode} ${r.signalCode ?? ""}`.trim());
  }
}

/** Commit fixtures in rollback journal (DELETE) mode, never WAL (operator ruling, 2026-10-09):
 *  fold the WAL in, switch the mode (written into the file header), then remove any -wal and -shm,
 *  which must never be committed. A WAL file copied without its side files cannot even be opened
 *  read only on macOS. */
function toDeleteMode(path: string): void {
  const db = new Database(path);
  try {
    db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
    db.exec("PRAGMA journal_mode = DELETE;");
  } finally {
    db.close();
  }
  for (const ext of ["-wal", "-shm"]) rmSync(`${path}${ext}`, { force: true });
}

const work = mkdtempSync(join(tmpdir(), "styre-db-fixtures-"));
process.stderr.write(`db-fixtures: working in ${work}\n`);
const childTmp = join(work, "tmp");
mkdirSync(childTmp);
const envFor = (name: string) => ({
  XDG_STATE_HOME: join(work, `state-${name}`),
  XDG_CONFIG_HOME: join(work, `config-${name}`),
  TMPDIR: childTmp,
  STYRE_TELEMETRY: "0",
});
const GIT_MS = 30_000;
try {
  mkdirSync(OUT, { recursive: true });
  for (const e of ERAS) {
    const era = join(work, e.name);
    run(["git", "worktree", "add", "--detach", era, e.ref], ROOT, {}, GIT_MS);
    try {
      const out = join(OUT, `${e.name}.db`);
      rmSync(out, { force: true });
      const seeder = join(ROOT, "scripts/db-fixtures/seed-era.ts");
      const mode = e.bridge ? "bridge" : "plain";
      run([process.execPath, seeder, era, out, mode], era, envFor(e.name), 60_000);
      toDeleteMode(out);
    } finally {
      run(["git", "worktree", "remove", "--force", era], ROOT, {}, GIT_MS);
    }
  }
  const era = join(work, "v8-driver");
  run(["git", "worktree", "add", "--detach", era, "2b05680"], ROOT, {}, GIT_MS);
  try {
    symlinkSync(MODULES, join(era, "node_modules"));
    for (const r of RECORDINGS) {
      const outDir = join(OUT, r.dir);
      rmSync(outDir, { recursive: true, force: true });
      mkdirSync(outDir, { recursive: true });
      const driver = join(ROOT, "scripts/db-fixtures/drive-v8-run.ts");
      run([process.execPath, driver, era, outDir, r.scenario], era, envFor(r.dir), 300_000);
      toDeleteMode(join(outDir, "run.db"));
    }
  } finally {
    run(["git", "worktree", "remove", "--force", era], ROOT, {}, GIT_MS);
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}
```

- [ ] **Step 7: Generate the fixtures**

Run from the root of this branch's own checkout (the worktree `.claude/worktrees/eng-477`; never the main checkout, which is on `main` and in use), after installing its dependencies there, since the generator links that `node_modules` into the 2b05680 worktree and refuses to start without it: `perl -e 'alarm 300; exec @ARGV' bun install --frozen-lockfile && perl -e 'alarm 120; exec @ARGV' git fetch --tags && perl -e 'alarm 600; exec @ARGV' bun scripts/db-fixtures/generate.ts && ls -la test/fixtures/db test/fixtures/db/v8-*`
Expected: the generator exits 0; seven `.db` files; `v8-paused-worktree/` and `v8-redesign-graded-worktree/` with four files each, `v8-plan-gate-worktree/` with three (no `transcript.json`); no `-wal` or `-shm` file anywhere under `test/fixtures/db`; `git worktree list` shows no leftover worktree. If the generator fails or its alarm stops it, run `git worktree prune`, remove the work folder it printed, fix the cause and rerun.

- [ ] **Step 8: Run the test and see it pass**

`biome.json` line 3 becomes `"files": { "ignore": ["dist/**", "**/*.sql", "test/fixtures/db/**"] },`: the fixtures are recorded as each release wrote them, and 2b05680's `dumpPark` writes `transcript.json` on one line with no final newline, which `biome check .` (`bun run lint`) would otherwise report as unformatted.

Run: `perl -e 'alarm 600; exec @ARGV' bun test test/db/fixtures.test.ts && perl -e 'alarm 300; exec @ARGV' bun run lint`
Expected: PASS (11 tests), and lint reports nothing. `git status --short test/fixtures/db` shows only the new files, no `-shm` or `-wal` (every read went through `readCopyOf`, and the generator left each fixture in DELETE mode).

- [ ] **Step 9: Break it on purpose, see it fail, restore**

1. Change `EXPECTED["v7-v0.9.0-bridged"].run` to `false`, rerun the command in Step 8, expect `v7-v0.9.0-bridged has the shape its release wrote` to fail on `expect(hasRun).toBe(want.run)`; restore `true`.
2. Change `RECORDED["v8-redesign-graded-worktree"].steps["design:size"]` to `"pending"`: its test fails on the step statuses. Restore.
3. In `generate.ts`, drop the `PRAGMA journal_mode = DELETE;` line and regenerate: `every committed fixture is in rollback journal (DELETE) mode` fails on the first fixture (`2, 2`). Restore and regenerate.

- [ ] **Step 10: Track the fixtures, prove it, commit**

`*.db` is ignored (`.gitignore:150`), and `git add` with a directory pathspec silently skips ignored files, so without a negation the commit would hold only `repo.bundle`, `meta.json` and `transcript.json`: every fixture test would pass in this tree and fail on a fresh clone. Append to `.gitignore`, right after the `*.db-shm` line of the `# SQLite (local databases)` block:

```
# ...except the committed historical database fixtures (ENG-477, scripts/db-fixtures/generate.ts).
# Their -wal and -shm files stay ignored.
!test/fixtures/db/**/*.db
```

```bash
git add .gitignore biome.json scripts/db-fixtures test/fixtures/db src/db/read-copy.ts test/db/read-copy.test.ts test/helpers/db-fixtures.ts test/db/fixtures.test.ts
git ls-files test/fixtures/db | grep -c '\.db$'
git ls-files test/fixtures/db | grep -c '\.db-\(wal\|shm\)$'
```
Expected: `10` (seven shape fixtures and the three recorded `run.db`), then `0`.

```bash
git commit -m "test(eng-477): historical database fixtures from each release's own code" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: `migrate()` with versioned migrations, backup, shape detection, structural proof, and v7 → v8

**Files:**
- Create: `src/db/migrations/types.ts`, `src/db/migrations/rebuild.ts`, `src/db/migrations/0008-run-table.ts`, `src/db/migrations/index.ts`
- Create: `src/db/migrations/shapes/v7-signal-budget.sql`, `src/db/migrations/shapes/v7.sql`, `src/db/migrations/shapes/v8.sql`
- Create: `src/db/schema-shape.ts`, `src/db/known-shapes.ts`
- Create: `test/helpers/check-probes.ts`
- Modify: `src/db/migrate.ts:1-43` (whole file), `src/cli/migrate.ts:11-16`, `src/cli/park.ts:38,89,102-119,143,259-262,480` (the migration; `priorRunIdAt` through `readCopyOf` and `dumpPark`'s new `prefix`; Task 3 keeps `--inspect` from upgrading), `src/cli/run.ts:428`, `src/db/repos/run.ts:14-28` (delete `ensureRunTable`), `src/db/schema.sql:486-491` and `docs/architecture/schema.sql` (the same comment lines: drop the sentence about `ensureRunTable`)
- Modify tests: `test/db/run.test.ts:27-40` (delete the bridge test; line 41 is the `describe`'s closing `});` and stays), `test/cli/dump-park-warning.test.ts:6,9-16` (rewritten by PR #154: it already uses `makeTempDir`)
- Test: `test/db/migrate-upgrade.test.ts`, `test/db/schema-shape.test.ts`

**Interfaces:**
- Consumes: `FIXTURES`, `MIGRATABLE_FIXTURES`, `copyFixture`, `fixtureVersion` (Task 1).
- Produces:
  - `interface Migration { version: number; note: string; up(db: Database): void }`
  - `rebuildTable(db: Database, spec: { table: string; createSql: string; columns: readonly string[]; indexes: readonly string[] }): void`
  - `MIGRATIONS: readonly Migration[]`, `CURRENT_VERSION: number`, `OLDEST_MIGRATABLE_VERSION = 7`
  - `RUN_TABLE_V8_DDL: string`, `SIGNAL_V8_DDL: string`, `SIGNAL_V8_COLUMNS: readonly string[]`, `SIGNAL_V8_INDEXES: readonly string[]`, `migration0008: Migration`
  - `stripSqlComments(sql: string): string`, `normalizeSql(sql: string): string`, `describeSchema(db: Database): SchemaShape`, `diffShapes(expected: SchemaShape, actual: SchemaShape): string[]`
  - `type KnownShape = "v7-signal-budget" | "v7-signal-budget+run" | "v7" | "v7+run" | "v8"`, `detectShape(db: Database, version: number): KnownShape | null`
  - `migrate(path: string, opts?: MigrateOptions): MigrateResult` with `MigrateOptions = { log?: (line: string) => void; now?: () => Date; migrations?: readonly Migration[] }` and `MigrateResult = { version: number; created: boolean; migratedFrom: number | null; backupPath: string | null }`. The structural proof runs inside the transaction of the migration that reaches `CURRENT_VERSION`, before it commits (M1): a failed proof rolls that migration back, so the database keeps its previous version and the backup stays; no later run can find a current version that was never proven. `readVersion` treats only `no such table: schema_meta` as "not created yet"; any other error surfaces.
  - `proveSchema(db: Database): string[]`, `backupPathFor(path: string, version: number, at: Date): string`
  - `type DatabaseState = { kind: "empty" } | { kind: "current"; version } | { kind: "upgrade"; version } | { kind: "refuse"; version: number | null; error: StyreError }`, `classifyDatabase(db: Database, path: string): DatabaseState` (writes nothing; `migrate()` acts on it), `readDatabaseState(path: string): DatabaseState` (a read only connection; `--inspect` uses it, Task 3)
  - test helper: `SEED_ROWS_V8: string[]`, `CHECK_PROBES_V8: CheckProbe[]`, `probeChecks(db: Database, seeds: readonly string[], probes: readonly CheckProbe[]): string[]` (returns the probes that were NOT rejected) where `CheckProbe = { table: string; set: string; where: string }`

- [ ] **Step 1: Copy the reference shapes (verbatim, from git)**

Run:
```bash
mkdir -p src/db/migrations/shapes
git show v0.9.0:src/db/schema.sql > src/db/migrations/shapes/v7-signal-budget.sql
git show v0.10.0:src/db/schema.sql > src/db/migrations/shapes/v7.sql
git show 2b05680:src/db/schema.sql > src/db/migrations/shapes/v8.sql
cmp src/db/migrations/shapes/v8.sql src/db/schema.sql && echo "v8 reference equals today's schema"
```
Expected: the last line prints `v8 reference equals today's schema`.

- [ ] **Step 2: Write the failing tests**

```ts
// test/helpers/check-probes.ts
import type { Database } from "bun:sqlite";

/** One forbidden UPDATE per CHECK constraint. Pragmas do not expose CHECKs (spec §7.3), so the
 *  migrated and the fresh database must both reject each of these. `where` picks the seeded row. */
export interface CheckProbe {
  table: string;
  set: string;
  where: string;
}

/** Valid rows, in foreign key order, that exist on every shape from v7 on. Ids 900 avoid fixture rows. */
export const SEED_ROWS_V8: string[] = [
  "INSERT INTO project (id, slug, target_repo, created_at, updated_at) VALUES (900, 'probe', '/x', 't', 't')",
  "INSERT INTO ticket (id, project_id, ident, stage, created_at, updated_at) VALUES (900, 900, 'P-1', 'design', 't', 't')",
  "INSERT INTO work_unit (id, ticket_id, seq, kind, created_at, updated_at) VALUES (900, 900, 1, 'backend', 't', 't')",
  "INSERT INTO signal (id, ticket_id, signal_type, requested_at) VALUES (900, 900, 'x', 't')",
  "INSERT INTO workflow_step (id, ticket_id, seq, step_key, step_type, created_at, updated_at) VALUES (900, 900, 1, 'probe', 'dispatch', 't', 't')",
  "INSERT INTO dispatch (id, ticket_id, dispatch_id, seq, created_at) VALUES (900, 900, 'P-1-d0001', 1, 't')",
  "INSERT INTO event_log (id, ticket_id, seq, kind, created_at) VALUES (900, 900, 1, 'note', 't')",
  "INSERT INTO ground_truth_signal (id, ticket_id, signal_type, result, measured_at) VALUES (900, 900, 'x', 'pass', 't')",
  "INSERT INTO review_finding (id, ticket_id, review_kind, severity, created_at) VALUES (900, 900, 'plan', 'minor', 't')",
  "INSERT INTO acceptance_criterion (id, ticket_id, seq, text, source, created_at, updated_at) VALUES (900, 900, 1, 'x', 'checklist', 't', 't')",
  "INSERT INTO ac_check (id, ticket_id, ac_id, selector, created_at, updated_at) VALUES (900, 900, 900, 's', 't', 't')",
  "INSERT INTO external_id_cache (id, project_id, entity_type, name, uuid, refreshed_at) VALUES (900, 900, 'team', 'n', 'u', 't')",
  "INSERT INTO projection_state (id, ticket_id, target) VALUES (900, 900, 'forge')",
  "INSERT INTO projection_outbox (id, ticket_id, target, op, idempotency_key, created_at) VALUES (900, 900, 'forge', 'push', 'probe-1', 't')",
  "INSERT INTO run (id, run_id, started_at, provider) VALUES (900, 'r', 't', 'claude')",
];

const p = (table: string, set: string): CheckProbe => ({ table, set, where: "id = 900" });

/** Every CHECK in the v8 schema.sql (47; the three in the commented memory_record stub excluded). */
export const CHECK_PROBES_V8: CheckProbe[] = [
  p("project", "config_json = 'not json'"),
  p("project", "checks_system = 'svn'"),
  p("project", "checks_config_json = 'not json'"),
  p("project", "paused = 2"),
  p("ticket", "type_label = 'Chore'"),
  p("ticket", "branch_prefix = 'chore'"),
  p("ticket", "stage = 'building'"),
  p("ticket", "status = 'halted'"),
  p("ticket", "track = 'slow'"),
  p("ticket", "needs_docs = 2"),
  p("work_unit", "files_to_touch = 'x'"),
  p("work_unit", "behavioral = 2"),
  p("work_unit", "verify_check_types = 'x'"),
  p("work_unit", "depends_on = 'x'"),
  p("work_unit", "status = 'done'"),
  p("workflow_step", "status = 'done'"),
  p("workflow_step", "input_json = 'x'"),
  p("workflow_step", "result_json = 'x'"),
  p("workflow_step", "error_json = 'x'"),
  p("signal", "status = 'lost'"),
  p("signal", "payload_json = 'x'"),
  p("dispatch", "partial = 2"),
  p("dispatch", "envelope_json = 'x'"),
  p("event_log", "kind = 'other'"),
  p("event_log", "actor = 'daemon'"),
  p("event_log", "payload_json = 'x'"),
  p("ground_truth_signal", "result = 'maybe'"),
  p("ground_truth_signal", "is_authoritative = 2"),
  p("ground_truth_signal", "detail_json = 'x'"),
  p("review_finding", "review_kind = 'docs'"),
  p("review_finding", "severity = 'blocker'"),
  p("review_finding", "factors_json = 'x'"),
  p("review_finding", "deferral_candidate = 2"),
  p("review_finding", "blocks_ship = 2"),
  p("review_finding", "status = 'closed'"),
  p("review_finding", "severity = 'critical', blocks_ship = 0"),
  p("acceptance_criterion", "source = 'ticket'"),
  p("ac_check", "red_first_result = 'blue'"),
  p("ac_check", "red_class = 'x'"),
  p("ac_check", "disposition = 'x'"),
  p("external_id_cache", "entity_type = 'user'"),
  p("projection_state", "target = 'slack'"),
  p("projection_state", "projected_status_labels_json = 'x'"),
  p("projection_outbox", "target = 'slack'"),
  p("projection_outbox", "payload_json = 'x'"),
  p("projection_outbox", "status = 'lost'"),
  p("run", "resumed = 2"),
];

/** Seed inside a savepoint, try each forbidden update, roll everything back. Returns the probes the
 *  database ACCEPTED (an empty list means every CHECK held). */
export function probeChecks(
  db: Database,
  seeds: readonly string[],
  probes: readonly CheckProbe[],
): string[] {
  const accepted: string[] = [];
  db.exec("SAVEPOINT probe_checks");
  try {
    for (const s of seeds) db.exec(s);
    for (const probe of probes) {
      db.exec("SAVEPOINT one_probe");
      try {
        db.exec(`UPDATE ${probe.table} SET ${probe.set} WHERE ${probe.where}`);
        accepted.push(`${probe.table}: ${probe.set}`);
      } catch (err) {
        if (!/CHECK constraint failed/.test(String(err))) throw err;
      } finally {
        db.exec("ROLLBACK TO one_probe");
        db.exec("RELEASE one_probe");
      }
    }
  } finally {
    db.exec("ROLLBACK TO probe_checks");
    db.exec("RELEASE probe_checks");
  }
  return accepted;
}
```

```ts
// test/db/schema-shape.test.ts
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describeSchema, diffShapes, stripSqlComments } from "../../src/db/schema-shape.ts";
import { CHECK_PROBES_V8, SEED_ROWS_V8, probeChecks } from "../helpers/check-probes.ts";

const SCHEMA = readFileSync(join(import.meta.dir, "../../src/db/schema.sql"), "utf8");
const fresh = () => {
  const db = new Database(":memory:");
  db.exec(SCHEMA);
  return db;
};

test("comments and whitespace do not change the shape", () => {
  const a = fresh();
  const b = new Database(":memory:");
  b.exec(stripSqlComments(SCHEMA).replace(/\s+/g, " "));
  expect(diffShapes(describeSchema(a), describeSchema(b))).toEqual([]);
});

test("a column added mid-table is a difference (column order is structure)", () => {
  const a = new Database(":memory:");
  a.exec("CREATE TABLE t (a INTEGER, b TEXT, c TEXT)");
  const b = new Database(":memory:");
  b.exec("CREATE TABLE t (a INTEGER, c TEXT)");
  b.exec("ALTER TABLE t ADD COLUMN b TEXT");
  expect(diffShapes(describeSchema(a), describeSchema(b)).join("\n")).toContain("columns differ");
});

test("AUTOINCREMENT is compared even though the pragmas cannot see it", () => {
  const a = new Database(":memory:");
  a.exec("CREATE TABLE t (id INTEGER PRIMARY KEY AUTOINCREMENT, x TEXT)");
  const b = new Database(":memory:");
  b.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, x TEXT)");
  expect(diffShapes(describeSchema(a), describeSchema(b)).join("\n")).toContain("AUTOINCREMENT");
});

test("a partial index's WHERE text is compared", () => {
  const a = new Database(":memory:");
  a.exec("CREATE TABLE t (k TEXT); CREATE INDEX i ON t (k) WHERE k IS NOT NULL");
  const b = new Database(":memory:");
  b.exec("CREATE TABLE t (k TEXT); CREATE INDEX i ON t (k) WHERE k <> ''");
  expect(diffShapes(describeSchema(a), describeSchema(b)).join("\n")).toContain("indexes differ");
});

test("every CHECK in schema.sql has a probe, and the fresh schema rejects each", () => {
  const checks = (stripSqlComments(SCHEMA).match(/\bCHECK\s*\(/g) ?? []).length;
  expect(CHECK_PROBES_V8.length).toBe(checks);
  expect(probeChecks(fresh(), SEED_ROWS_V8, CHECK_PROBES_V8)).toEqual([]);
});
```

```ts
// test/db/migrate-upgrade.test.ts
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { EXIT, StyreError } from "../../src/cli/errors.ts";
import { openDb } from "../../src/db/client.ts";
import { migrate } from "../../src/db/migrate.ts";
import {
  SIGNAL_V8_COLUMNS,
  SIGNAL_V8_DDL,
  SIGNAL_V8_INDEXES,
  migration0008,
} from "../../src/db/migrations/0008-run-table.ts";
import { CURRENT_VERSION, MIGRATIONS } from "../../src/db/migrations/index.ts";
import { rebuildTable } from "../../src/db/migrations/rebuild.ts";
import { readCopyOf } from "../../src/db/read-copy.ts";
import { describeSchema, diffShapes } from "../../src/db/schema-shape.ts";
import { CHECK_PROBES_V8, SEED_ROWS_V8, probeChecks } from "../helpers/check-probes.ts";
import { MIGRATABLE_FIXTURES, copyFixture, fixtureVersion } from "../helpers/db-fixtures.ts";
import { makeTestDb } from "../helpers/db.ts";

function count(path: string, sql: string): number {
  return readCopyOf(path, (db) => {
    return (db.query<{ n: number }, []>(sql).get() as { n: number }).n;
  });
}
function refusalOf(fn: () => unknown): StyreError {
  try {
    fn();
  } catch (err) {
    if (err instanceof StyreError) return err;
    throw err;
  }
  throw new Error("expected a refusal");
}

describe("migrate upgrades every known released shape", () => {
  for (const name of MIGRATABLE_FIXTURES) {
    test(`${name} reaches the current version with the structural proof and the CHECK probes`, () => {
      const path = copyFixture(name);
      const before = fixtureVersion(path);
      const steps = count(path, "SELECT COUNT(*) AS n FROM workflow_step");
      const units = count(path, "SELECT COUNT(*) AS n FROM work_unit");
      const logs: string[] = [];
      const r = migrate(path, { log: (l) => logs.push(l) });
      expect(r.version).toBe(CURRENT_VERSION);
      expect(r.migratedFrom).toBe(before === CURRENT_VERSION ? null : before);
      expect(fixtureVersion(path)).toBe(CURRENT_VERSION);
      // rows survive
      expect(count(path, "SELECT COUNT(*) AS n FROM workflow_step")).toBe(steps);
      expect(count(path, "SELECT COUNT(*) AS n FROM work_unit")).toBe(units);
      // the step waiting on a signal still points at a signal that exists
      expect(
        count(
          path,
          "SELECT COUNT(*) AS n FROM workflow_step w JOIN signal s ON s.id = w.await_signal_id",
        ),
      ).toBe(1);
      // structure equals a fresh database, and both reject the same forbidden values
      const db = openDb(path);
      const fresh = new Database(":memory:");
      try {
        fresh.exec(readFileSync(join(import.meta.dir, "../../src/db/schema.sql"), "utf8"));
        expect(diffShapes(describeSchema(fresh), describeSchema(db))).toEqual([]);
        expect(probeChecks(db, SEED_ROWS_V8, CHECK_PROBES_V8)).toEqual([]);
        expect(probeChecks(fresh, SEED_ROWS_V8, CHECK_PROBES_V8)).toEqual([]);
        expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
      } finally {
        db.close();
        fresh.close();
      }
      if (before !== CURRENT_VERSION) {
        expect(r.backupPath).not.toBeNull();
        expect(existsSync(r.backupPath as string)).toBe(true);
        expect(fixtureVersion(r.backupPath as string)).toBe(before);
        expect(logs.join("\n")).toContain(r.backupPath as string);
      }
    });
  }

  test("v7 bridged on the v0.9.0 shape migrates: signal rebuilt, run kept, foreign keys intact", () => {
    const path = copyFixture("v7-v0.9.0-bridged");
    const signals = count(path, "SELECT COUNT(*) AS n FROM signal");
    migrate(path);
    readCopyOf(path, (db) => {
      const cols = db
        .query<{ name: string }, []>("PRAGMA table_info('signal')")
        .all()
        .map((c) => c.name);
      expect(cols).not.toContain("attempts");
      expect(cols).not.toContain("max_attempts");
      expect(db.query("SELECT COUNT(*) AS n FROM signal").get()).toEqual({ n: signals });
      expect(db.query("SELECT COUNT(*) AS n FROM run").get()).toEqual({ n: 0 });
      expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
      // the view that reads signal was dropped and recreated around the rebuild
      expect(db.query("SELECT COUNT(*) AS n FROM v_ready_tickets").get()).toEqual({ n: 0 });
    });
  });
});

describe("migrate refuses what it cannot upgrade", () => {
  test("a database newer than this binary is refused, naming both versions", () => {
    const { db } = makeTestDb();
    const path = db.filename;
    db.query(
      "INSERT INTO schema_meta (version, applied_at, note) VALUES (99, 't', 'future')",
    ).run();
    db.close();
    const e = refusalOf(() => migrate(path));
    expect(e.code).toBe(EXIT.RESUME_REFUSED);
    expect(e.headline).toContain("v99");
    expect(e.headline).toContain(`v${CURRENT_VERSION}`);
  });

  test("a shape this binary does not know is refused with --fresh as the way out", () => {
    const path = copyFixture("v7-v0.10.0");
    const db = new Database(path);
    db.exec("ALTER TABLE ticket ADD COLUMN surprise TEXT");
    db.close();
    const e = refusalOf(() => migrate(path));
    expect(e.code).toBe(EXIT.RESUME_REFUSED);
    expect(e.recovery).toContain("--fresh");
    expect(fixtureVersion(path)).toBe(7);
  });

  test("v6 is refused", () => {
    const e = refusalOf(() => migrate(copyFixture("v6-v0.7.0")));
    expect(e.code).toBe(EXIT.RESUME_REFUSED);
    expect(e.headline).toContain("v6");
  });
});

describe("how migrations run", () => {
  test("the backup holds every committed row while another reader holds a snapshot", () => {
    const path = copyFixture("v7-v0.10.0");
    const writer = new Database(path);
    writer.exec("PRAGMA journal_mode = WAL;");
    const ticketId = (writer.query("SELECT id FROM ticket LIMIT 1").get() as { id: number }).id;
    const reader = new Database(path, { readonly: true });
    reader.exec("BEGIN");
    reader.query("SELECT COUNT(*) FROM event_log").get(); // the read snapshot is now held
    for (let i = 0; i < 50; i++) {
      writer
        .query(
          "INSERT INTO event_log (ticket_id, seq, kind, created_at) VALUES (?, ?, 'note', 't')",
        )
        .run(ticketId, 1000 + i);
    }
    const events = count(path, "SELECT COUNT(*) AS n FROM event_log");
    const r = migrate(path);
    reader.exec("COMMIT");
    reader.close();
    writer.close();
    expect(count(r.backupPath as string, "SELECT COUNT(*) AS n FROM event_log")).toBe(events);
  });

  test("a retried upgrade does not collide with an earlier backup (timestamped name)", () => {
    const path = copyFixture("v7-v0.10.0");
    const failing = [
      {
        version: 8,
        note: "fails",
        up: () => {
          throw new Error("boom");
        },
      },
    ];
    expect(() =>
      migrate(path, { now: () => new Date("2026-10-09T12:00:00.000Z"), migrations: failing }),
    ).toThrow("boom");
    // the retry backs up again under a new name; VACUUM INTO would refuse an existing file
    expect(() =>
      migrate(path, { now: () => new Date("2026-10-09T12:00:01.000Z"), migrations: failing }),
    ).toThrow("boom");
    const baks = readdirSync(dirname(path)).filter((f) => f.endsWith(".bak"));
    expect(baks.length).toBe(2);
    expect(fixtureVersion(path)).toBe(7);
  });

  test("a failing migration rolls back that step and leaves the previous version", () => {
    const path = copyFixture("v7-v0.10.0");
    const failing = [
      migration0008,
      {
        version: 9,
        note: "fails",
        up: () => {
          throw new Error("boom");
        },
      },
    ];
    expect(() => migrate(path, { migrations: failing })).toThrow("boom");
    expect(fixtureVersion(path)).toBe(8);
  });

  test("a failed structural proof rolls back the last migration and keeps the backup", () => {
    // The last pending migration leaves a stray column: the proof runs inside its transaction, so
    // the database stays at the previous version and the next run tries the upgrade again.
    const path = copyFixture("v7-v0.10.0");
    const last = MIGRATIONS.at(-1);
    if (!last) throw new Error("no migrations");
    const stray = [
      ...MIGRATIONS.slice(0, -1),
      {
        ...last,
        up: (db: Database) => {
          last.up(db);
          db.exec("ALTER TABLE ticket ADD COLUMN stray TEXT");
        },
      },
    ];
    // a fixed backup time, so the second backup below cannot collide with this one's name
    const at = () => new Date("2026-01-01T00:00:00.000Z");
    const r = () => migrate(path, { migrations: stray, now: at });
    expect(r).toThrow("does not match schema");
    expect(fixtureVersion(path)).toBe(CURRENT_VERSION - 1);
    const baks = readdirSync(dirname(path)).filter((f) => f.endsWith(".bak"));
    expect(baks.length).toBe(1);
    expect(fixtureVersion(join(dirname(path), baks[0] ?? ""))).toBe(7);
    // the real list, run again, reaches the current version
    expect(migrate(path).version).toBe(CURRENT_VERSION);
  });

  test("a schema_meta it cannot read is an error, not a refusal to start over", () => {
    const { db } = makeTestDb({ seedTicket: false });
    const path = db.filename;
    db.exec("DROP TABLE schema_meta; CREATE TABLE schema_meta (other TEXT)");
    db.close();
    expect(() => migrate(path)).toThrow("no such column: version");
  });

  test("a failing foreign_key_check aborts the migration and keeps v7", () => {
    const path = copyFixture("v7-v0.9.0");
    const db = new Database(path);
    db.exec("PRAGMA foreign_keys = OFF;");
    db.exec(
      "INSERT INTO workflow_step (ticket_id, seq, step_key, step_type, created_at, updated_at) VALUES (4242, 99, 'orphan', 'dispatch', 't', 't')",
    );
    db.close();
    expect(() => migrate(path)).toThrow("foreign key violation");
    expect(fixtureVersion(path)).toBe(7);
  });

  test("the shared rebuild keeps rows, incoming foreign keys and dependent views", () => {
    const path = copyFixture("v8-main-2b05680");
    const db = new Database(path);
    try {
      const before = db.query("SELECT * FROM signal ORDER BY id").all();
      db.exec("PRAGMA foreign_keys = OFF;");
      db.transaction(() => {
        // The same definition the v7 -> v8 migration rebuilds with, imported rather than repeated.
        rebuildTable(db, {
          table: "signal",
          createSql: SIGNAL_V8_DDL,
          columns: SIGNAL_V8_COLUMNS,
          indexes: SIGNAL_V8_INDEXES,
        });
        expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
      })();
      db.exec("PRAGMA foreign_keys = ON;");
      expect(db.query("SELECT * FROM signal ORDER BY id").all()).toEqual(before);
      expect(db.query("SELECT COUNT(*) AS n FROM v_ready_tickets").get()).toEqual({ n: 0 });
    } finally {
      db.close();
    }
  });

  test("the migration list is contiguous and ends at the version schema.sql seeds", () => {
    const versions = MIGRATIONS.map((m) => m.version);
    expect(versions[0]).toBe(8);
    versions.forEach((v, i) => expect(v).toBe(8 + i));
    expect(versions.at(-1)).toBe(CURRENT_VERSION);
  });
});
```

- [ ] **Step 3: Run them and see them fail**

Run: `perl -e 'alarm 600; exec @ARGV' bun test test/db/schema-shape.test.ts test/db/migrate-upgrade.test.ts`
Expected: FAIL: `schema-shape.test.ts` with `Cannot find module '../../src/db/schema-shape.ts'`, and `migrate-upgrade.test.ts` with `Cannot find module '../../src/db/migrations/0008-run-table.ts'` (its first missing import, before `index.ts`).

- [ ] **Step 4: Write the structural description**

```ts
// src/db/schema-shape.ts
import type { Database } from "bun:sqlite";

/** One table's structure as the pragmas report it (spec §7.3). Text is never compared: comments,
 *  ADD COLUMN text and a rebuild's quoted rename all differ while the structure is the same. */
export interface TableShape {
  columns: string[];
  indexes: string[];
  foreignKeys: string[];
  autoincrement: boolean;
}
export interface SchemaShape {
  tables: Record<string, TableShape>;
  views: Record<string, string>;
  triggers: Record<string, string>;
}

function closingQuote(sql: string, start: number): number {
  const q = sql[start];
  let i = start + 1;
  while (i < sql.length) {
    if (sql[i] === q) {
      if (sql[i + 1] === q) {
        i += 2;
        continue;
      }
      return i;
    }
    i++;
  }
  return sql.length - 1;
}

/** Remove `--` and block comments outside string literals and quoted identifiers. */
export function stripSqlComments(sql: string): string {
  let out = "";
  let i = 0;
  while (i < sql.length) {
    const c = sql[i];
    if (c === "'" || c === '"') {
      const end = closingQuote(sql, i);
      out += sql.slice(i, end + 1);
      i = end + 1;
      continue;
    }
    if (c === "-" && sql[i + 1] === "-") {
      const nl = sql.indexOf("\n", i);
      i = nl === -1 ? sql.length : nl;
      continue;
    }
    if (c === "/" && sql[i + 1] === "*") {
      const close = sql.indexOf("*/", i + 2);
      i = close === -1 ? sql.length : close + 2;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/** Comments removed, whitespace collapsed, no spaces around punctuation. */
export function normalizeSql(sql: string): string {
  return stripSqlComments(sql)
    .replace(/\s+/g, " ")
    .replace(/\s*([(),;=])\s*/g, "$1")
    .trim();
}

type Row = Record<string, unknown>;
const lit = (name: string): string => `'${name.replaceAll("'", "''")}'`;

export function describeSchema(db: Database): SchemaShape {
  const master = db
    .query<{ type: string; name: string; sql: string | null }, []>(
      "SELECT type, name, sql FROM sqlite_master ORDER BY type, name",
    )
    .all();
  const tables: Record<string, TableShape> = {};
  for (const t of master.filter((m) => m.type === "table" && !m.name.startsWith("sqlite_"))) {
    const pragma = (name: string): Row[] =>
      db.query<Row, []>(`PRAGMA ${name}(${lit(t.name)})`).all();
    const columns = pragma("table_xinfo").map(
      (c) =>
        `${c.cid}|${c.name}|${c.type}|notnull=${c.notnull}|default=${c.dflt_value}|pk=${c.pk}|hidden=${c.hidden}`,
    );
    const indexes = pragma("index_list")
      .map((ix) => {
        const cols = db
          .query<Row, []>(`PRAGMA index_xinfo(${lit(String(ix.name))})`)
          .all()
          .filter((c) => c.key === 1)
          .map((c) => `${c.name}:${c.desc}:${c.coll}`)
          .join(",");
        const own = master.find((m) => m.type === "index" && m.name === ix.name)?.sql ?? null;
        const at = own === null ? -1 : own.search(/\bWHERE\b/i);
        const where =
          own !== null && Number(ix.partial) === 1 && at >= 0 ? normalizeSql(own.slice(at)) : "";
        // Automatic indexes are named after the table they were created on, which a rebuild changes.
        const label = ix.origin === "c" ? String(ix.name) : `(${ix.origin})`;
        return `${label}|unique=${ix.unique}|partial=${ix.partial}|cols=${cols}|${where}`;
      })
      .sort();
    const foreignKeys = pragma("foreign_key_list")
      .map(
        (f) =>
          `${f.id}|${f.seq}|${f.table}|${f.from}|${f.to}|${f.on_update}|${f.on_delete}|${f.match}`,
      )
      .sort();
    const autoincrement = /\bAUTOINCREMENT\b/i.test(stripSqlComments(t.sql ?? ""));
    tables[t.name] = { columns, indexes, foreignKeys, autoincrement };
  }
  const named = (type: string): Record<string, string> =>
    Object.fromEntries(
      master.filter((m) => m.type === type).map((m) => [m.name, normalizeSql(m.sql ?? "")]),
    );
  return { tables, views: named("view"), triggers: named("trigger") };
}

export function diffShapes(expected: SchemaShape, actual: SchemaShape): string[] {
  const out: string[] = [];
  const names = [
    ...new Set([...Object.keys(expected.tables), ...Object.keys(actual.tables)]),
  ].sort();
  for (const n of names) {
    const e = expected.tables[n];
    const a = actual.tables[n];
    if (!e) {
      out.push(`table ${n}: present but not expected`);
      continue;
    }
    if (!a) {
      out.push(`table ${n}: missing`);
      continue;
    }
    for (const key of ["columns", "indexes", "foreignKeys"] as const) {
      const ej = JSON.stringify(e[key]);
      const aj = JSON.stringify(a[key]);
      if (ej !== aj) out.push(`table ${n}: ${key} differ\n  expected ${ej}\n  actual   ${aj}`);
    }
    if (e.autoincrement !== a.autoincrement)
      out.push(`table ${n}: AUTOINCREMENT expected ${e.autoincrement}, actual ${a.autoincrement}`);
  }
  for (const kind of ["views", "triggers"] as const) {
    const keys = [
      ...new Set([...Object.keys(expected[kind]), ...Object.keys(actual[kind])]),
    ].sort();
    for (const k of keys) {
      if (expected[kind][k] !== actual[kind][k])
        out.push(
          `${kind} ${k}: expected ${expected[kind][k] ?? "(none)"}, actual ${actual[kind][k] ?? "(none)"}`,
        );
    }
  }
  return out;
}
```

- [ ] **Step 5: Write the migration types, the rebuild helper and v7 → v8**

```ts
// src/db/migrations/types.ts
import type { Database } from "bun:sqlite";

/** One schema step. `migrate()` runs `up` inside its own immediate transaction with foreign keys
 *  off, inserts the `schema_meta` row and runs `PRAGMA foreign_key_check` (spec §7.1). */
export interface Migration {
  /** The version this migration produces. */
  version: number;
  note: string;
  up(db: Database): void;
}
```

```ts
// src/db/migrations/rebuild.ts
import type { Database } from "bun:sqlite";

export interface RebuildSpec {
  table: string;
  /** `CREATE TABLE <table> (...)` with the new definition. */
  createSql: string;
  /** The columns copied from the old table (all must exist in both). */
  columns: readonly string[];
  /** The table's indexes, recreated after the rename. */
  indexes: readonly string[];
}

/** SQLite's documented procedure for a schema change ALTER TABLE cannot make ("Making Other Kinds Of
 *  Table Schema Changes", sqlite.org/lang_altertable.html, spec §7.2): create the new table, copy
 *  the rows, drop the old table, rename, recreate its indexes, and drop and recreate the views and
 *  triggers that name it. Foreign keys must already be off (outside the transaction, where the
 *  pragma is not a no op), and the caller's transaction must be open. */
export function rebuildTable(db: Database, spec: RebuildSpec): void {
  const fk = db.query<{ foreign_keys: number }, []>("PRAGMA foreign_keys").get();
  if (fk?.foreign_keys !== 0)
    throw new Error(`rebuildTable(${spec.table}): foreign keys must be off`);
  if (!db.inTransaction)
    throw new Error(`rebuildTable(${spec.table}): must run inside a transaction`);
  const head = new RegExp(`^\\s*CREATE TABLE ${spec.table}\\b`);
  if (!head.test(spec.createSql))
    throw new Error(`rebuildTable: createSql must start with CREATE TABLE ${spec.table}`);
  const tmp = `${spec.table}__rebuild`;
  const mentions = new RegExp(`\\b${spec.table}\\b`);
  const dependents = db
    .query<{ type: string; name: string; sql: string }, []>(
      "SELECT type, name, sql FROM sqlite_master WHERE type IN ('view','trigger') AND sql IS NOT NULL ORDER BY type DESC, name",
    )
    .all()
    .filter((d) => mentions.test(d.sql));
  for (const d of dependents) db.exec(`DROP ${d.type === "view" ? "VIEW" : "TRIGGER"} ${d.name}`);
  db.exec(spec.createSql.replace(head, `CREATE TABLE ${tmp}`));
  const cols = spec.columns.join(", ");
  db.exec(`INSERT INTO ${tmp} (${cols}) SELECT ${cols} FROM ${spec.table}`);
  db.exec(`DROP TABLE ${spec.table}`);
  db.exec(`ALTER TABLE ${tmp} RENAME TO ${spec.table}`);
  for (const ix of spec.indexes) db.exec(ix);
  for (const d of dependents) db.exec(d.sql);
}
```

```ts
// src/db/migrations/0008-run-table.ts
import type { Database } from "bun:sqlite";
import { rebuildTable } from "./rebuild.ts";
import type { Migration } from "./types.ts";

/** `run` exactly as schema.sql v8 declares it (ENG-349). */
export const RUN_TABLE_V8_DDL = `CREATE TABLE run (
    id          INTEGER PRIMARY KEY,
    run_id      TEXT    NOT NULL,
    started_at  TEXT    NOT NULL,
    provider    TEXT    NOT NULL,
    resumed     INTEGER NOT NULL DEFAULT 0 CHECK (resumed IN (0,1)),
    attempt     INTEGER NOT NULL DEFAULT 1
)`;

/** `signal` exactly as schema.sql v8 declares it, without the v0.8.0 to v0.9.0 wait budget columns.
 *  Exported for the rebuild helper's test. */
export const SIGNAL_V8_DDL = `CREATE TABLE signal (
    id              INTEGER PRIMARY KEY,
    ticket_id       INTEGER NOT NULL REFERENCES ticket(id) ON DELETE CASCADE,
    signal_type     TEXT    NOT NULL,
    status          TEXT    NOT NULL DEFAULT 'pending' CHECK (status IN (
                        'pending','delivered','consumed')),
    reason          TEXT,
    payload_json    TEXT CHECK (payload_json IS NULL OR json_valid(payload_json)),
    idempotency_key TEXT,
    requested_at    TEXT NOT NULL,
    delivered_at    TEXT,
    consumed_at     TEXT
)`;
export const SIGNAL_V8_COLUMNS: readonly string[] = [
  "id",
  "ticket_id",
  "signal_type",
  "status",
  "reason",
  "payload_json",
  "idempotency_key",
  "requested_at",
  "delivered_at",
  "consumed_at",
];
export const SIGNAL_V8_INDEXES: readonly string[] = [
  "CREATE UNIQUE INDEX idx_signal_idempotency ON signal (idempotency_key) WHERE idempotency_key IS NOT NULL",
  "CREATE INDEX idx_signal_pending ON signal (ticket_id, status)",
];

function columns(db: Database, table: string): string[] {
  return db
    .query<{ name: string }, []>(`PRAGMA table_info('${table}')`)
    .all()
    .map((c) => c.name);
}

/** v7 → v8 (spec §7.4). Each condition is handled on its own, because a v7 checkpoint resumed on
 *  v0.11+ was bridged by ensureRunTable without a version bump: rebuild `signal` when the wait
 *  budget columns (v0.8.0 to v0.9.0) are present; create `run` when it is absent. */
export const migration0008: Migration = {
  version: 8,
  note: "v8: add run table for telemetry run identity (ENG-349); drop the signal wait budget columns",
  up(db) {
    if (columns(db, "signal").includes("attempts")) {
      rebuildTable(db, {
        table: "signal",
        createSql: SIGNAL_V8_DDL,
        columns: SIGNAL_V8_COLUMNS,
        indexes: SIGNAL_V8_INDEXES,
      });
    }
    if (columns(db, "run").length === 0) db.exec(RUN_TABLE_V8_DDL);
  },
};
```

```ts
// src/db/migrations/index.ts
import schemaSql from "../schema.sql" with { type: "text" };
import { migration0008 } from "./0008-run-table.ts";
import type { Migration } from "./types.ts";

/** In order; each produces the version after the previous one. */
export const MIGRATIONS: readonly Migration[] = [migration0008];

/** v6 → v7 renamed columns; those checkpoints already could not resume (spec §7.4). */
export const OLDEST_MIGRATABLE_VERSION = 7;

/** The version a fresh database gets from schema.sql. */
export const CURRENT_VERSION: number = (() => {
  const m = schemaSql.match(/INSERT INTO schema_meta[\s\S]*?VALUES \((\d+),/);
  if (!m) throw new Error("schema.sql: no schema_meta seed row");
  return Number(m[1]);
})();

if (MIGRATIONS.at(-1)?.version !== CURRENT_VERSION) {
  throw new Error(
    `migrations end at v${MIGRATIONS.at(-1)?.version} but schema.sql seeds v${CURRENT_VERSION}`,
  );
}
```

- [ ] **Step 6: Write the shape detection**

```ts
// src/db/known-shapes.ts
import { Database } from "bun:sqlite";
import { RUN_TABLE_V8_DDL } from "./migrations/0008-run-table.ts";
import v7SignalBudgetSql from "./migrations/shapes/v7-signal-budget.sql" with { type: "text" };
import v7Sql from "./migrations/shapes/v7.sql" with { type: "text" };
import v8Sql from "./migrations/shapes/v8.sql" with { type: "text" };
import { type SchemaShape, describeSchema, diffShapes } from "./schema-shape.ts";

/** The released shapes this binary upgrades (spec §7.4), each detected by structure, never by the
 *  version number alone. `+run` is a v7 checkpoint bridged by ensureRunTable on v0.11+. */
export type KnownShape = "v7-signal-budget" | "v7-signal-budget+run" | "v7" | "v7+run" | "v8";

interface Known {
  name: KnownShape;
  version: number;
  shape: SchemaShape;
}

function shapeOf(sql: string, extra?: string): SchemaShape {
  const db = new Database(":memory:");
  try {
    db.exec(sql);
    if (extra) db.exec(extra);
    return describeSchema(db);
  } finally {
    db.close();
  }
}

let known: Known[] | null = null;
function knownShapes(): Known[] {
  known ??= [
    { name: "v7-signal-budget", version: 7, shape: shapeOf(v7SignalBudgetSql) },
    {
      name: "v7-signal-budget+run",
      version: 7,
      shape: shapeOf(v7SignalBudgetSql, RUN_TABLE_V8_DDL),
    },
    { name: "v7", version: 7, shape: shapeOf(v7Sql) },
    { name: "v7+run", version: 7, shape: shapeOf(v7Sql, RUN_TABLE_V8_DDL) },
    { name: "v8", version: 8, shape: shapeOf(v8Sql) },
  ];
  return known;
}

export function detectShape(db: Database, version: number): KnownShape | null {
  const actual = describeSchema(db);
  for (const k of knownShapes()) {
    if (k.version === version && diffShapes(k.shape, actual).length === 0) return k.name;
  }
  return null;
}
```

- [ ] **Step 7: Rewrite `migrate()`**

Replace the whole of `src/db/migrate.ts`:

```ts
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { EXIT, StyreError } from "../cli/errors.ts";
import { nowUtc } from "../util/time.ts";
import { openDb } from "./client.ts";
import { detectShape } from "./known-shapes.ts";
import { CURRENT_VERSION, MIGRATIONS, OLDEST_MIGRATABLE_VERSION } from "./migrations/index.ts";
import type { Migration } from "./migrations/types.ts";
import { readCopyOf } from "./read-copy.ts";
import { describeSchema, diffShapes } from "./schema-shape.ts";
import schemaSql from "./schema.sql" with { type: "text" };

export interface MigrateResult {
  version: number;
  created: boolean;
  /** The version the database had before this call upgraded it, or null when nothing ran. */
  migratedFrom: number | null;
  backupPath: string | null;
}

export interface MigrateOptions {
  /** Human lines (the backup path, the upgrade). `run` sends them to stderr. */
  log?: (line: string) => void;
  now?: () => Date;
  /** Tests only: run this list instead of MIGRATIONS. */
  migrations?: readonly Migration[];
}

function readVersion(db: Database): number | null {
  try {
    const row = db
      .query<{ version: number }, []>(
        "SELECT version FROM schema_meta ORDER BY version DESC LIMIT 1",
      )
      .get();
    return row ? row.version : null;
  } catch (err) {
    // Only a database without the table is "not created yet". A busy, damaged or odd one surfaces
    // as it is: refusing it as an unknown shape would tell the operator to discard a valid run.
    if (/no such table: schema_meta/.test(String(err))) return null;
    throw err;
  }
}

function hasTables(db: Database): boolean {
  return db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' LIMIT 1").get() !== null;
}

/** `<db>.v<old>.<UTC timestamp with milliseconds>.bak`, next to the database (spec §7.1). */
export function backupPathFor(path: string, version: number, at: Date): string {
  const stamp = at.toISOString().replace(/[-:]/g, "").replace(".", "");
  return `${path}.v${version}.${stamp}.bak`;
}

function refused(headline: string, recovery: string): StyreError {
  return new StyreError({ code: EXIT.RESUME_REFUSED, headline, recovery });
}

/** Differences between `db` and a fresh database built from schema.sql (spec §7.3). */
export function proveSchema(db: Database): string[] {
  const fresh = new Database(":memory:");
  try {
    fresh.exec(schemaSql);
    return diffShapes(describeSchema(fresh), describeSchema(db));
  } finally {
    fresh.close();
  }
}

/** Runs each pending migration in its own immediate transaction. `prove` runs inside the
 *  transaction of the migration that reaches CURRENT_VERSION, before it commits (spec §7.1,
 *  §7.3): a difference rolls that migration back like any other failure. */
function applyMigrations(
  db: Database,
  from: number,
  migrations: readonly Migration[],
  prove: (db: Database) => void,
): number {
  const pending = migrations.filter((m) => m.version > from);
  pending.forEach((m, i) => {
    if (m.version !== from + 1 + i)
      throw new Error(
        `migrate: migrations are not contiguous: expected v${from + 1 + i}, found v${m.version}`,
      );
  });
  // Inside a transaction the pragma is a silent no op, so it is set before the first BEGIN.
  db.exec("PRAGMA foreign_keys = OFF;");
  try {
    for (const m of pending) {
      db.transaction(() => {
        m.up(db);
        db.query("INSERT INTO schema_meta (version, applied_at, note) VALUES (?, ?, ?)").run(
          m.version,
          nowUtc(),
          m.note,
        );
        const violations = db.query<Record<string, unknown>, []>("PRAGMA foreign_key_check").all();
        if (violations.length > 0)
          throw new Error(
            `migrate: v${m.version} left ${violations.length} foreign key violation(s); first: ${JSON.stringify(violations[0])}`,
          );
        if (m.version === CURRENT_VERSION) prove(db);
      }).immediate();
    }
  } finally {
    db.exec("PRAGMA foreign_keys = ON;");
  }
  return pending.at(-1)?.version ?? from;
}

/** What migrate() would do with a database, decided by reading it only (spec §7.1). */
export type DatabaseState =
  | { kind: "empty" }
  | { kind: "current"; version: number }
  | { kind: "upgrade"; version: number }
  | { kind: "refuse"; version: number | null; error: StyreError };

/** The same refusals reach `styre migrate --db <path>`, whose database may be no run's checkpoint. */
const NOT_A_RUN =
  " For a database given to styre migrate that is no run's checkpoint: remove it, and styre migrate creates a new one.";

/** No schema_meta and no tables: empty. Current: nothing to do. Newer, older than v7, or a shape
 *  this binary does not know: refuse (exit 65). Otherwise an upgrade. Writes nothing. */
export function classifyDatabase(db: Database, path: string): DatabaseState {
  const existing = readVersion(db);
  if (existing === null) {
    if (!hasTables(db)) return { kind: "empty" };
    return {
      kind: "refuse",
      version: null,
      error: refused(
        `migrate: ${path} has tables but no schema_meta, a shape this Styre does not know`,
        `Start that run over: styre run <ticket> --fresh.${NOT_A_RUN}`,
      ),
    };
  }
  if (existing === CURRENT_VERSION) return { kind: "current", version: existing };
  if (existing > CURRENT_VERSION)
    return {
      kind: "refuse",
      version: existing,
      error: refused(
        `migrate: ${path} is schema v${existing}, newer than this Styre's v${CURRENT_VERSION}`,
        `Use the newer Styre that wrote it, or start that run over: styre run <ticket> --fresh.${NOT_A_RUN}`,
      ),
    };
  if (existing < OLDEST_MIGRATABLE_VERSION)
    return {
      kind: "refuse",
      version: existing,
      error: refused(
        `migrate: ${path} is schema v${existing}; Styre upgrades checkpoints from v${OLDEST_MIGRATABLE_VERSION} on`,
        `Start that run over: styre run <ticket> --fresh.${NOT_A_RUN}`,
      ),
    };
  if (detectShape(db, existing) === null)
    return {
      kind: "refuse",
      version: existing,
      error: refused(
        `migrate: ${path} is schema v${existing} but has a shape this Styre does not know`,
        `Start that run over: styre run <ticket> --fresh.${NOT_A_RUN}`,
      ),
    };
  return { kind: "upgrade", version: existing };
}

/** classifyDatabase on a private copy (`readCopyOf`): the database itself is never opened, so
 *  nothing beside it changes and no backup is made. For `--inspect`. */
export function readDatabaseState(path: string): DatabaseState {
  return readCopyOf(path, (db) => {
    return classifyDatabase(db, path);
  });
}

/** Create, or upgrade, the run's database (control-loop §10, spec §7.1). Empty: create from
 *  schema.sql. Current: nothing (a current version was proven before it committed). Refused:
 *  throw the refusal (exit 65). Otherwise back up with VACUUM INTO, run each pending migration in
 *  its own transaction, and prove the result against schema.sql inside the last one's transaction. */
export function migrate(path: string, opts: MigrateOptions = {}): MigrateResult {
  mkdirSync(dirname(path), { recursive: true });
  const db = openDb(path);
  try {
    const state = classifyDatabase(db, path);
    if (state.kind === "refuse") throw state.error;
    if (state.kind === "empty") {
      db.exec(schemaSql);
      const version = readVersion(db);
      if (version === null) throw new Error("migrate: schema_meta empty after bootstrap");
      return { version, created: true, migratedFrom: null, backupPath: null };
    }
    if (state.kind === "current")
      return { version: state.version, created: false, migratedFrom: null, backupPath: null };
    const existing = state.version;
    const backupPath = backupPathFor(path, existing, opts.now?.() ?? new Date());
    // A file copy misses rows a reader's snapshot pins in the WAL; VACUUM INTO does not.
    db.query("VACUUM INTO ?").run(backupPath);
    opts.log?.(`migrate: backed up ${path} (schema v${existing}) to ${backupPath}`);
    const reached = applyMigrations(db, existing, opts.migrations ?? MIGRATIONS, (inTx) => {
      const diff = proveSchema(inTx);
      if (diff.length > 0)
        throw new Error(
          `migrate: ${path} does not match schema v${CURRENT_VERSION} after migrating:\n${diff.join("\n")}`,
        );
    });
    opts.log?.(`migrate: upgraded ${path} from schema v${existing} to v${reached}`);
    return { version: reached, created: false, migratedFrom: existing, backupPath };
  } finally {
    db.close();
  }
}
```

- [ ] **Step 8: Wire the callers and remove the bridge**

`src/cli/migrate.ts`, replace lines 11-16:

```ts
export async function migrateImpl({ args }: { args: MigrateArgs }): Promise<void> {
  const path = args.db && args.db.length > 0 ? args.db : defaultDbPath();
  const result = migrate(path, { log: (line) => process.stderr.write(`${line}\n`) });
  const verb = result.created
    ? "bootstrapped"
    : result.migratedFrom !== null
      ? `upgraded from v${result.migratedFrom}`
      : "already current";
  process.stderr.write(`${verb}: ${path} (schema v${result.version})\n`);
}
```

`src/cli/park.ts`: change the import on line 38 to `import { getRun, insertRun, markResumed } from "../db/repos/run.ts";`, and replace lines 260-262 with:

```ts
    migrate(dbPath, { log: (line) => process.stderr.write(`${line}\n`) });
    const db = openDb(dbPath);
```

Until Task 3, `--inspect` upgrades an older checkpoint like any resume (it reaches this call); Task 3 makes it read only for every version (operator rulings, 2026-10-09 and 2026-10-10).

`src/cli/run.ts:428`: `migrate(dbPath, { log: (line) => process.stderr.write(`${line}\n`) });`

`src/db/repos/run.ts`: delete lines 14-28 (`ensureRunTable` and its comment).

`src/db/schema.sql` and `docs/architecture/schema.sql`, replace the comment block above `CREATE TABLE run` (lines 486-491) with:

```sql
-- ----------------------------------------------------------------------------
-- run — per-invocation identity (ENG-349). Exactly one row per ephemeral run DB.
-- The telemetry export stamps run_id/provider/started_at onto every emitted row so a
-- consumer can correlate rows and tell two runs of the same ticket apart. ticket_id is a
-- run-local rowid and is NOT a cross-run key. A v7 checkpoint gains this table through the
-- v7 -> v8 migration (src/db/migrations/0008-run-table.ts).
-- ----------------------------------------------------------------------------
```

`test/db/run.test.ts`: delete the test `ensureRunTable creates the table when missing (pre-upgrade park bridge)` (lines 27-40; line 41 closes the `describe` and stays) and change its import (line 2) to `import { getRun, markResumed } from "../../src/db/repos/run.ts";` (`insertRun` was used only by the deleted test; `noUnusedLocals` would fail typecheck). `test/cli/dump-park-warning.test.ts` (as PR #154 left it, with `makeTempDir` already imported from `../helpers/temp.ts`): line 6 becomes `import { insertRun } from "../../src/db/repos/run.ts";`, add `import { migrate } from "../../src/db/migrate.ts";`, and `dbWithRun` (lines 9-16) becomes:

```ts
function dbWithRun(runId: string): string {
  const path = join(makeTempDir("dp-"), "run.db");
  migrate(path);
  const db = new Database(path);
  insertRun(db, { runId, startedAt: "2026-07-21T00:00:00.000Z", provider: "claude" });
  db.close();
  return path;
}
```

`priorRunIdAt` reads a checkpoint that must not change, so it reads through `readCopyOf` too (operator ruling, 2026-10-09: the private copy covers every such read, as a class), and it no longer hides an unreadable file. `src/cli/park.ts`: add `import { readCopyOf } from "../db/read-copy.ts";` and replace `priorRunIdAt` and its comment (lines 102-119) with:

```ts
/** The run_id in an existing paused copy's run.db, read through a private copy (operator ruling,
 *  2026-10-09): null when the file is absent or predates the run table (pre-upgrade). Throws when
 *  the file exists but cannot be read, so dumpPark says so instead of skipping its warning. */
export function priorRunIdAt(destPath: string): string | null {
  if (!existsSync(destPath)) return null;
  return readCopyOf(destPath, (db) => {
    const hasRun =
      db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'run'").get() !== null;
    if (!hasRun) return null; // a copy from before the run table: no run identity was ever minted
    return (
      db.query<{ run_id: string }, []>("SELECT run_id FROM run ORDER BY id LIMIT 1").get()
        ?.run_id ?? null
    );
  });
}
```

`dumpPark` gains a last parameter `prefix: "run: " | "resume: "` (its callers: `finishRunResult`, line 89, passes `"run: "`; `resumeRun`'s second dump, line 480, passes `"resume: "`), and its `const prior = priorRunIdAt(destPath);` (line 143) becomes:

```ts
    let prior: string | null = null;
    try {
      prior = priorRunIdAt(destPath);
    } catch (err) {
      // Said, not skipped: the copy about to be overwritten could not be read.
      process.stderr.write(
        `${prefix}could not read the paused run at ${destPath} before overwriting it: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
```

Append to `test/cli/dump-park-warning.test.ts` (add `spyOn` to its `bun:test` import, `rmSync` and `writeFileSync` from `node:fs`, `dumpPark` and `parkDir` beside `priorRunIdAt`, and `openDb` from `../../src/db/client.ts`):

```ts
describe("dumpPark reads the paused copy it overwrites through a private copy", () => {
  const park = {
    cause: "session-limit" as const,
    resetAt: null,
    dispatchId: "ENG-1-d0001",
    transcript: "partial",
  };
  let stderr: string[] = [];
  let spy: ReturnType<typeof spyOn>;
  let prevState: string | undefined;
  beforeEach(() => {
    stderr = [];
    spy = spyOn(process.stderr, "write").mockImplementation((c: unknown) => {
      stderr.push(String(c));
      return true;
    });
    prevState = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = makeTempDir("dp-state-");
  });
  afterEach(() => {
    spy.mockRestore();
    if (prevState === undefined) Reflect.deleteProperty(process.env, "XDG_STATE_HOME");
    else process.env.XDG_STATE_HOME = prevState;
  });

  /** The live run being paused: a database with run `runId`, left open for dumpPark to close. */
  function liveRun(runId: string) {
    const path = join(makeTempDir("dp-live-"), "run.db");
    migrate(path);
    const db = openDb(path);
    insertRun(db, { runId, startedAt: "2026-07-21T00:00:00.000Z", provider: "claude" });
    return { db, path };
  }

  test("a paused copy in WAL mode with no -wal or -shm still produces the overwriting warning", () => {
    const dest = join(parkDir("dp-slug", "ENG-1"), "run.db");
    mkdirSync(parkDir("dp-slug", "ENG-1"), { recursive: true });
    // the earlier pause's copy: WAL mode in its header, its side files gone (a read only open of
    // such a file fails on macOS)
    migrate(dest);
    const earlier = new Database(dest);
    insertRun(earlier, {
      runId: "run-A",
      startedAt: "2026-07-21T00:00:00.000Z",
      provider: "claude",
    });
    earlier.exec("PRAGMA wal_checkpoint(TRUNCATE);");
    earlier.close();
    for (const ext of ["-wal", "-shm"]) rmSync(`${dest}${ext}`, { force: true });
    const { db, path } = liveRun("run-B");
    dumpPark(db, path, "dp-slug", "ENG-1", park, "run: ");
    expect(stderr.join("")).toContain("overwriting paused run run-A with run-B for ENG-1");
  });

  test("a paused copy that cannot be read is said so, with the caller's prefix", () => {
    const dest = join(parkDir("dp-slug", "ENG-1"), "run.db");
    mkdirSync(parkDir("dp-slug", "ENG-1"), { recursive: true });
    writeFileSync(dest, "not a database");
    const { db, path } = liveRun("run-B");
    dumpPark(db, path, "dp-slug", "ENG-1", park, "resume: ");
    expect(stderr.join("")).toContain(`resume: could not read the paused run at ${dest}`);
  });
});
```

(also add `afterEach`, `beforeEach` to the `bun:test` import and `mkdirSync` to `node:fs`; the test file already imports `Database`, `join` and `makeTempDir`.)

Run: `cmp src/db/schema.sql docs/architecture/schema.sql && echo same`
Expected: `same`.

- [ ] **Step 9: Run the tests and see them pass**

Run: `perl -e 'alarm 600; exec @ARGV' bun test test/db/schema-shape.test.ts test/db/migrate-upgrade.test.ts test/migrate.test.ts test/db/run.test.ts test/cli/dump-park-warning.test.ts test/migrate-cli.test.ts`
Expected: PASS.

- [ ] **Step 10: Break it on purpose, see it fail, restore**

1. In `migration0008.up`, comment out the `rebuildTable(...)` call. Run Step 9's command: the `v7-v0.9.0` and `v7-v0.9.0-bridged` cases fail in the proof (`table signal: columns differ`). Restore.
2. In `migrate()`, replace `db.query("VACUUM INTO ?").run(backupPath);` with a file copy (`copyFileSync(path, backupPath)` with the import). Run: the reader snapshot test fails (the backup has fewer `event_log` rows). Restore.
3. In `applyMigrations`, delete the `foreign_key_check` block. Run: `a failing foreign_key_check aborts the migration and keeps v7` fails. Restore.
4. In `describeSchema`, set `autoincrement: false` always. Run: `AUTOINCREMENT is compared` fails. Restore.
5. In `applyMigrations`, move `if (m.version === CURRENT_VERSION) prove(db);` out of the transaction, after `.immediate();`. Run: `a failed structural proof rolls back the last migration and keeps the backup` fails (the version is already the current one). Restore.
6. In `readVersion`, put back a bare `catch { return null; }`. Run: `a schema_meta it cannot read is an error` fails (it gets the refusal instead). Restore.

- [ ] **Step 11: Run the whole suite**

Run: `perl -e 'alarm 600; exec @ARGV' bun test`
Expected: PASS (0 failures). Then `perl -e 'alarm 300; exec @ARGV' bunx biome check --write src/db src/cli/migrate.ts src/cli/park.ts src/cli/run.ts test/db test/helpers/check-probes.ts test/cli/dump-park-warning.test.ts`, `perl -e 'alarm 300; exec @ARGV' bun run lint` and `perl -e 'alarm 300; exec @ARGV' bun run typecheck` pass.

- [ ] **Step 12: Commit**

```bash
git add src/db test/helpers/check-probes.ts test/db src/cli/migrate.ts src/cli/park.ts src/cli/run.ts docs/architecture/schema.sql test/cli/dump-park-warning.test.ts
git commit -m "feat(eng-477): versioned migrations with backup, shape detection and a structural proof" -m "migrate() now upgrades v7 and v8 checkpoints: VACUUM INTO backup, one transaction per migration with foreign_key_check, and a structural comparison against schema.sql. The v7 to v8 migration replaces ensureRunTable." -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Narrow readers for the commands that do not migrate (`ls`, `clean`, `--fresh`, `--resume --inspect`)

**Files:**
- Create: `src/db/repos/checkpoint-read.ts`
- Modify: `src/cli/checkpoints.ts:1,6-7,10,45-61,93,115-126` (`classifyCheckpointDb`; `readCheckpoint`, `incompatibleReason` and the two new kinds; `listCheckpoints` lists the checkpoints it cannot use, over the same folders as today), `src/util/process/interruption.ts:7-8,113,225-274` (the `getProject` and `getTicket` imports; `findInterruption`, `olderCheckpointWarning`, `undoBeforeDiscard`). Reads only: nothing here changes who may be signalled.
- Modify: `src/cli/clean.ts:38-44,62,87-93,151,166-175` (its two direct reads go through `readCopyOf`; the ident and slug are checked before any file is touched; a checkpoint it cannot use, by schema or by damage, is refused with exit 65 and nothing removed, naming the folder and the worktrees that look like its own as plain text, with no command)
- Modify: `src/cli/ls.ts:34-66` (an effort `listCheckpoints` could not read, or cannot use because of its schema, is listed in its own section with the reason)
- Modify tests (their read only opens of run databases go through `readCopyOf`): `test/lifecycle/e2e-interrupt.test.ts:25,170,222,242,562`, `test/lifecycle/interruption.test.ts:907`, `test/lifecycle/terminal.test.ts:10,358`, `test/lifecycle/signals.test.ts:152,306,330,361`, `test/cli/run-pr-base.test.ts:13`, `test/migrate.test.ts:1,41`
- Create: `src/cli/checkpoint-name.ts` (`assertCheckpointName`: the one name check)
- Modify: `src/cli/park.ts:98-100` (`parkDir` checks both names first: every checkpoint path a fresh run, a resume and a pause build goes through it), `src/cli/load-profile.ts:40-56` (the `--slug` flag, a derived slug and the profile's own slug are checked before a path is built from them), `src/cli/errors.ts:11,124-126` (comments only: exit 65 also covers `clean` refusing a checkpoint it cannot use), `src/cli/setup.ts:106-132,453` (setup checks the slug before it writes a profile)
- Modify: `test/helpers/run-harness.ts:664-673,692,759` (`runFreshTicket` takes an optional `slug`)
- Modify: `src/cli/park.ts:259-260,299-305` (`--inspect` reads through `readDatabaseState` and `inspectWithoutUpgrading` before `migrate`, for every version, and writes nothing; today's inspect branch goes; operator rulings, 2026-10-09 and 2026-10-10)
- Test: `test/cli/checkpoint-readers-fixtures.test.ts`

**Interfaces:**
- Consumes: `FIXTURES`, `copyFixture`, `fixtureVersion`, `readCopyOf` (Task 1); `DatabaseState`, `classifyDatabase(db: Database, path: string): DatabaseState`, `readDatabaseState` (Task 2); `listWorktrees` (`src/dispatch/worktree.ts`); `runFreshTicket`, `FreshTicketRun` (`test/helpers/run-harness.ts:664`, as PR #154 and PR #156 left it: it makes its folders with `makeTempDir` and wraps `runImpl` in `trackTempEntriesMadeBy`); `makeTempDir` (`test/helpers/temp.ts`).
- Produces:
  - `interface CheckpointTicket { id: number; project_id: number; ident: string; stage: string; status: string; branch_name: string | null; branch_prefix: string | null }`
  - `readCheckpointTicket(db: Database, ticketId: number): CheckpointTicket | null`
  - `readCheckpointTargetRepo(db: Database, projectId: number): string | null`
  - `listCheckpointPendingSignals(db: Database, ticketId: number): { signal_type: string; reason: string | null }[]`
  - `interface CheckpointRunningStep { id: number; ticket_id: number; step_key: string; attempt: number; pid: number | null; started_at: string | null }`
  - `listCheckpointRunningSteps(db: Database): CheckpointRunningStep[]`
  - `readCheckpointOnlyTicket(db: Database): CheckpointTicket | null` (the run's one ticket), `findCheckpointParkedStepKey(db: Database, ticketId: number): string | null` (the step left running, else failed, as resume picks it)
  - in `src/cli/park.ts`: `inspectWithoutUpgrading(dbPath: string, ident: string, state: DatabaseState): string`; `--resume --inspect` never migrates, writes no backup and no run row, and never opens the original, whatever the version
  - `findInterruption(db, step: Pick<WorkflowStepRow, "id" | "ticket_id" | "attempt" | "started_at">)` and `olderCheckpointWarning(step: Pick<WorkflowStepRow, "pid" | "step_key">)` (widened parameter types; same behaviour).
  - in `src/cli/checkpoints.ts`: `interface CheckpointRead { state: DatabaseState; cls: ReturnType<typeof classifyCheckpointDb> }` (`cls` is `null` when the schema is refused or the checkpoint cannot be classified); `readCheckpoint(dbPath: string, dir: string): CheckpointRead` (one private copy for both answers); `incompatibleReason(state: DatabaseState): string` (throws on a usable schema); the `Checkpoint` kinds `unreadable` and `incompatible`
  - in `src/cli/checkpoint-name.ts`: `checkpointNameProblem(what: "ident" | "slug", value: string): string | null` (an ident is one folder name; a slug may nest with `/`, each part one folder name); `assertCheckpointName(what, value): void` (a usage error, exit 64); `assertProfileSlug(slug: string, file: string): void` (a config error, exit 78); `checkpointPath(root: string, slug: string, ident: string): string` (both names checked, and the resolved path must stay inside `root`); called by `parkDir`, `loadRunProfile`, `cleanImpl`, `setupImpl` and `runSetup`
  - in `test/helpers/run-harness.ts`: `runFreshTicket(opts?: { ...; slug?: string })`
  - in `src/cli/clean.ts`: `styreWorktreeCandidates(targetRepo: string, ident: string): string[]` (worktrees of the target repository named after the ident inside a `styre-wt-` folder, never the repository itself); `clean` on an unusable checkpoint throws a `StyreError` with exit 65 and removes nothing

- [ ] **Step 1: Write the failing test**

```ts
// test/cli/checkpoint-readers-fixtures.test.ts
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { FakeAgentRunner } from "../../src/agent/fake-runner.ts";
import { listCheckpoints } from "../../src/cli/checkpoints.ts";
import { cleanImpl, styreWorktreeCandidates } from "../../src/cli/clean.ts";
import type { StyreError } from "../../src/cli/errors.ts";
import { loadRunProfile } from "../../src/cli/load-profile.ts";
import { lsImpl } from "../../src/cli/ls.ts";
import { renderError } from "../../src/cli/output.ts";
import { parkDir, resumeRun } from "../../src/cli/park.ts";
import { runSetup, setupImpl } from "../../src/cli/setup.ts";
import { DEFAULT_AGENT_CONFIG } from "../../src/config/agent-config.ts";
import { DEFAULT_RUNTIME_CONFIG } from "../../src/config/runtime-config.ts";
import { openDb } from "../../src/db/client.ts";
import { migrate } from "../../src/db/migrate.ts";
import { CURRENT_VERSION } from "../../src/db/migrations/index.ts";
import { listCheckpointRunningSteps } from "../../src/db/repos/checkpoint-read.ts";
import { parseProfile } from "../../src/dispatch/profile.ts";
import { undoBeforeDiscard } from "../../src/util/process/interruption.ts";
import { FIXTURES, copyFixture, fixtureVersion } from "../helpers/db-fixtures.ts";
import { type FreshTicketRun, runFreshTicket } from "../helpers/run-harness.ts";
import { makeTempDir } from "../helpers/temp.ts";

/** These tests run git and whole `styre run` invocations: a time limit of their own. */
const TIMEOUT_MS = 60_000;

let stderr: string[] = [];
let spy: ReturnType<typeof spyOn>;
beforeEach(() => {
  stderr = [];
  spy = spyOn(process.stderr, "write").mockImplementation((c: unknown) => {
    stderr.push(String(c));
    return true;
  });
});
afterEach(() => spy.mockRestore());

function gitRepo(): string {
  const root = makeTempDir("styre-readers-repo-");
  const run = (a: string[]) => Bun.spawnSync(["git", ...a], { cwd: root, timeout: 30_000 });
  run(["init", "-b", "main"]);
  run(["config", "user.email", "t@s.dev"]);
  run(["config", "user.name", "T"]);
  writeFileSync(join(root, "README.md"), "x");
  run(["add", "-A"]);
  run(["commit", "-m", "init"]);
  return root;
}

/** <root>/<slug>/ENG-1/run.db holding a private copy of the fixture. */
function checkpointOf(
  name: (typeof FIXTURES)[number],
  slug: string,
): { root: string; dbPath: string } {
  const root = makeTempDir("styre-readers-state-");
  const dir = join(root, slug, "ENG-1");
  mkdirSync(dir, { recursive: true });
  const dbPath = join(dir, "run.db");
  copyFileSync(copyFixture(name), dbPath);
  return { root, dbPath };
}

describe("checkpoints are read without migrating them (spec §7.7)", () => {
  for (const name of FIXTURES) {
    test(`${name}: the narrow running step read works on the old shape`, () => {
      const path = copyFixture(name);
      const db = openDb(path);
      try {
        expect(listCheckpointRunningSteps(db).map((s) => s.step_key)).toEqual(
          name === "v6-v0.7.0" ? [] : ["implement:wu1:dispatch"],
        );
      } finally {
        db.close();
      }
    });

    test(`${name}: ls lists it and leaves its version alone`, () => {
      const { root, dbPath } = checkpointOf(name, "fixture");
      const before = fixtureVersion(dbPath);
      const found = listCheckpoints(root);
      expect(found.map((c) => c.ident)).toEqual(["ENG-1"]);
      expect(fixtureVersion(dbPath)).toBe(before);
      expect(stderr.join("")).not.toContain("could not read");
    });

    test(`${name}: --fresh's discard reads it (the in-place undo is not skipped)`, () => {
      const { dbPath } = checkpointOf(name, "fixture");
      const before = fixtureVersion(dbPath);
      const lines: string[] = [];
      undoBeforeDiscard(dbPath, (l) => lines.push(l));
      expect(lines.join("\n")).not.toContain("could not read");
      expect(fixtureVersion(dbPath)).toBe(before);
    });

    test(
      `${name}: clean reaps it (v6: refuses it, a schema this Styre cannot use)`,
      async () => {
        const { root, dbPath } = checkpointOf(name, "fixture");
        // `root` is the state root: cleanImpl reads <root>/<slug>/<ident> (src/cli/clean.ts:151).
        const done = await cleanImpl(
          { ident: "ENG-1", slug: "fixture" },
          { root, targetRepo: gitRepo() },
        ).catch((e: unknown) => e);
        if (name === "v6-v0.7.0") {
          expect((done as { code?: number }).code).toBe(65);
          expect(existsSync(dbPath)).toBe(true);
        } else {
          expect(done).toBeUndefined();
          expect(existsSync(dbPath)).toBe(false);
        }
        expect(stderr.join("")).not.toContain("could not read");
      },
      TIMEOUT_MS,
    );

    test(
      `${name}: styre run --fresh discards it and starts over`,
      async () => {
        const state = makeTempDir("styre-readers-fresh-");
        const dir = join(state, "styre", "test-project", "ENG-1");
        mkdirSync(dir, { recursive: true });
        copyFileSync(copyFixture(name), join(dir, "run.db"));
        const run = await runFreshTicket({
          fresh: true,
          reuseStateOf: { stateRoot: state } as FreshTicketRun,
        });
        try {
          expect(fixtureVersion(run.dbPath)).toBeGreaterThanOrEqual(8); // a new checkpoint
          expect(stderr.join("")).not.toContain("could not read");
        } finally {
          run.cleanup();
        }
      },
      TIMEOUT_MS,
    );

    test(
      `${name}: --resume --inspect reports it and writes nothing`,
      async () => {
        // operator rulings, 2026-10-09 and 2026-10-10: no migration, no backup, no run row, also
        // where resume would refuse
        const state = makeTempDir("styre-readers-inspect-");
        const dir = join(state, "styre", "inspect", "ENG-1"); // parkDir("inspect", "ENG-1")
        mkdirSync(dir, { recursive: true });
        const dbPath = join(dir, "run.db");
        copyFileSync(copyFixture(name), dbPath);
        const before = fixtureVersion(dbPath);
        const bytes = readFileSync(dbPath);
        const prev = process.env.XDG_STATE_HOME;
        process.env.XDG_STATE_HOME = state;
        try {
          const profile = parseProfile({ slug: "inspect", targetRepo: gitRepo(), components: [] });
          await resumeRun({ resume: "ENG-1", inspect: true }, profile, DEFAULT_RUNTIME_CONFIG);
        } finally {
          if (prev === undefined) Reflect.deleteProperty(process.env, "XDG_STATE_HOME");
          else process.env.XDG_STATE_HOME = prev;
        }
        const out = stderr.join("");
        const expected =
          before < 7
            ? "resume would refuse this checkpoint"
            : before === CURRENT_VERSION
              ? "would re-dispatch step"
              : `resume will upgrade this checkpoint from v${before} to v${CURRENT_VERSION}, after writing a backup`;
        expect(out).toContain(expected);
        expect(fixtureVersion(dbPath)).toBe(before);
        // read only whatever the version (operator ruling, 2026-10-10): the same bytes, no backup,
        // no -wal or -shm made beside it, so no run row was written and the original never opened
        expect(readFileSync(dbPath).equals(bytes)).toBe(true);
        expect(readdirSync(dir).sort()).toEqual(["run.db"]);
      },
      TIMEOUT_MS,
    );
  }
});

test("a WAL checkpoint without -wal or -shm beside it is read through a private copy and left as it was", () => {
  // operator ruling, 2026-10-09: a read only open of such a file fails on macOS; a private copy reads it
  const { root, dbPath } = checkpointOf("v8-main-2b05680", "fixture");
  // openDb leaves the file in WAL mode. On macOS (observed with Bun 1.4.2) the -wal and -shm stay
  // after close; elsewhere SQLite may remove them. Either way this test removes them itself, and the
  // private copy relies on neither.
  migrate(dbPath);
  const fold = new Database(dbPath);
  fold.exec("PRAGMA wal_checkpoint(TRUNCATE);");
  fold.close();
  for (const ext of ["-wal", "-shm"]) rmSync(`${dbPath}${ext}`, { force: true }); // as when copied alone
  const dir = dirname(dbPath);
  const files = () =>
    readdirSync(dir)
      .sort()
      .map((f) => [f, readFileSync(join(dir, f)).toString("base64")]);
  const before = files();
  expect(listCheckpoints(root).map((c) => c.ident)).toEqual(["ENG-1"]);
  const lines: string[] = [];
  undoBeforeDiscard(dbPath, (l) => lines.push(l));
  expect(lines.join("\n")).not.toContain("could not read");
  expect(files()).toEqual(before);
});

test("ls lists an effort it cannot read as unreadable, with the reason, instead of dropping it", async () => {
  const root = makeTempDir("styre-readers-state-");
  mkdirSync(join(root, "fixture", "ENG-9"), { recursive: true });
  writeFileSync(join(root, "fixture", "ENG-9", "run.db"), "not a database");
  const found = listCheckpoints(root);
  expect(found.map((c) => [c.ident, c.kind, c.resumable])).toEqual([
    ["ENG-9", "unreadable", false],
  ]);
  expect(found[0]?.note).toContain("could not read it");
  const out: string[] = [];
  const stdout = spyOn(process.stdout, "write").mockImplementation((c: unknown) => {
    out.push(String(c));
    return true;
  });
  try {
    await lsImpl({ root, swept: [] });
  } finally {
    stdout.mockRestore();
  }
  expect(out.join("")).toContain("Unreadable checkpoints (remove by hand:");
  expect(out.join("")).toContain("fixture/ENG-9  could not read it:");
});

/** A checkpoint folder `<root>/fixture/<ident>` whose run.db is not a database. The state root's
 *  name holds a single quote: a path is printed as it is, as plain text. */
function unreadableEffort(
  ident: string,
  prefix = "styre-readers-state-o'q-",
): { root: string; dir: string } {
  const root = makeTempDir(prefix);
  const dir = join(root, "fixture", ident);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "run.db"), "not a database");
  return { root, dir };
}

/** The lock of a run that is alive: this test's parent process, which outlives the test. */
const lockByLiveRun = (dir: string) => writeFileSync(join(dir, "run.lock"), String(process.ppid));

test("ls lists a checkpoint whose ticket table is empty as unreadable, and says when it is running", async () => {
  const root = makeTempDir("styre-readers-state-");
  const dir = join(root, "fixture", "ENG-8");
  mkdirSync(dir, { recursive: true });
  migrate(join(dir, "run.db")); // tables, no ticket
  lockByLiveRun(dir);
  const found = listCheckpoints(root);
  expect(found.map((c) => [c.ident, c.kind, c.note, c.live])).toEqual([
    ["ENG-8", "unreadable", "no ticket recorded", true],
  ]);
  const out: string[] = [];
  const stdout = spyOn(process.stdout, "write").mockImplementation((c: unknown) => {
    out.push(String(c));
    return true;
  });
  try {
    await lsImpl({ root, swept: [] });
  } finally {
    stdout.mockRestore();
  }
  expect(out.join("")).toContain("fixture/ENG-8 (running)  no ticket recorded");
  expect(out.join("")).not.toContain("Running:");
});

/** git in `cwd`, with a time limit; the test fails on a git error. */
function gitIn(cwd: string, args: string[]): void {
  const r = Bun.spawnSync(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    timeout: 30_000,
  });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
}

/** A repository with one commit at `path`. */
function repoAt(path: string): string {
  mkdirSync(path, { recursive: true });
  gitIn(path, ["init", "-q", "-b", "main"]);
  gitIn(path, ["config", "user.email", "t@s.dev"]);
  gitIn(path, ["config", "user.name", "T"]);
  writeFileSync(join(path, "README.md"), "x");
  gitIn(path, ["add", "-A"]);
  gitIn(path, ["commit", "-q", "-m", "init"]);
  return path;
}

/** Every file under `root` with its bytes: what a refusal must leave exactly as it was. */
const treeOf = (root: string) =>
  (readdirSync(root, { recursive: true }) as string[]).sort().map((f) => {
    const full = join(root, f);
    return [f, statSync(full).isDirectory() ? "dir" : readFileSync(full).toString("base64")];
  });

test(
  "clean refuses an unreadable effort (exit 65), removes nothing, and lists exactly the worktrees that look like its own",
  async () => {
    const { root, dir } = unreadableEffort("ENG-9");
    // The repository itself has the shape of a candidate (<styre-wt-*>/ENG-9): it is the main
    // entry and never listed. The paths hold a single quote; they are printed as plain text.
    const repo = repoAt(join(makeTempDir("styre-wt-o'q-"), "ENG-9"));
    const add = (path: string, branch: string) => {
      gitIn(repo, ["worktree", "add", "-q", "-b", branch, path]);
      return realpathSync(path); // git reports real paths
    };
    const mine = add(join(makeTempDir("styre-wt-o'q-"), "ENG-9"), "feat/ENG-9");
    const nested = add(join(makeTempDir("styre-wt-"), "sub", "ENG-9"), "nested"); // parent is "sub"
    const elsewhere = add(join(makeTempDir("scratch-"), "ENG-9"), "elsewhere");
    const otherIdent = add(join(makeTempDir("styre-wt-"), "ENG-7"), "feat/ENG-7");
    expect(styreWorktreeCandidates(repo, "ENG-9")).toEqual([mine]);
    const before = treeOf(root);

    const refusal = await cleanImpl(
      { ident: "ENG-9", slug: "fixture" },
      { root, targetRepo: repo },
    ).catch((e: unknown) => e);
    const e = refusal as { code?: number; headline?: string; detail?: string; recovery?: string };
    expect(e.code).toBe(65);
    expect(e.headline).toContain("cannot clean 'ENG-9'");
    const detail = String(e.detail);
    expect(detail).toContain(`checkpoint folder: ${dir}`);
    // the worktrees that look like the run's, as plain paths: exactly `mine`, never the
    // repository itself nor a worktree of another shape
    expect(detail.split("\n").filter((l) => l.startsWith("  "))).toEqual([`  ${mine}`]);
    for (const wt of [nested, elsewhere, otherIdent]) expect(detail).not.toContain(wt);
    expect(e.recovery).toBe(
      "Nothing was removed. To remove the run by hand, see the `styre clean` section of docs/architecture/runtime-parameters.md.",
    );
    // no shell command is printed (operator ruling, 2026-10-10; printed commands are ENG-491)
    const shown = renderError("clean", refusal as StyreError);
    for (const command of ["rm -r", "worktree remove", "--fresh", "--force"]) {
      expect(shown).not.toContain(command);
    }
    // nothing removed: the checkpoint, every worktree and the repository are as they were
    expect(treeOf(root)).toEqual(before);
    for (const wt of [mine, nested, elsewhere, otherIdent]) expect(existsSync(wt)).toBe(true);
    expect(existsSync(join(repo, "README.md"))).toBe(true);
  },
  TIMEOUT_MS,
);

test(
  "clean refuses an unreadable effort with --purge too (65), a live one at the gate (75), and says when no worktree looks like its own",
  async () => {
    const idle = unreadableEffort("ENG-9");
    const repo = gitRepo();
    const purge = await cleanImpl(
      { ident: "ENG-9", slug: "fixture", purge: true },
      { root: idle.root, targetRepo: repo },
    ).catch((e: unknown) => e);
    expect((purge as { code?: number }).code).toBe(65);
    expect(String((purge as { detail?: string }).detail)).toContain(
      `no worktree of ${repo} looks like this run's`,
    );
    expect(existsSync(idle.dir)).toBe(true);

    const live = unreadableEffort("ENG-9");
    lockByLiveRun(live.dir);
    const refusal = await cleanImpl(
      { ident: "ENG-9", slug: "fixture" },
      { root: live.root, targetRepo: repo },
    ).catch((e: unknown) => e);
    expect((refusal as { code?: number }).code).toBe(75);
    expect(existsSync(live.dir)).toBe(true);
  },
  TIMEOUT_MS,
);

test(
  "a checkpoint folder without run.db is not an effort: ls skips it, clean says so (64)",
  async () => {
    const root = makeTempDir("styre-readers-state-");
    const bare = join(root, "fixture", "ENG-6");
    mkdirSync(bare, { recursive: true });
    writeFileSync(join(bare, "transcript.json"), "{}");
    expect(listCheckpoints(root)).toEqual([]);
    const refusal = await cleanImpl(
      { ident: "ENG-6", slug: "fixture" },
      { root, targetRepo: gitRepo() },
    ).catch((e: unknown) => e);
    expect((refusal as { code?: number }).code).toBe(64);
    expect(existsSync(join(bare, "transcript.json"))).toBe(true);
  },
  TIMEOUT_MS,
);

/** A checkpoint whose schema this Styre refuses, built on a private copy of a fixture. */
const INCOMPATIBLE: { reason: string; make: () => string }[] = [
  {
    reason: "written by a newer Styre (schema v99)",
    make: () => {
      const path = copyFixture("v8-main-2b05680");
      const db = new Database(path);
      db.query(
        "INSERT INTO schema_meta (version, applied_at, note) VALUES (99, 't', 'future')",
      ).run();
      db.close();
      return path;
    },
  },
  {
    reason: "unknown database shape",
    make: () => {
      const path = copyFixture("v7-v0.10.0");
      const db = new Database(path);
      db.exec("ALTER TABLE ticket ADD COLUMN surprise TEXT");
      db.close();
      return path;
    },
  },
  { reason: "older than v7 (schema v6)", make: () => copyFixture("v6-v0.7.0") },
];

for (const c of INCOMPATIBLE) {
  test(
    `a checkpoint ${c.reason} is listed as such, never as damaged, and clean refuses it (exit 65)`,
    async () => {
      const root = makeTempDir("styre-readers-state-");
      const dir = join(root, "fixture", "ENG-1");
      mkdirSync(dir, { recursive: true });
      copyFileSync(c.make(), join(dir, "run.db"));
      const found = listCheckpoints(root);
      expect(found.map((x) => [x.ident, x.kind, x.note])).toEqual([
        ["ENG-1", "incompatible", c.reason],
      ]);
      const out: string[] = [];
      const stdout = spyOn(process.stdout, "write").mockImplementation((s: unknown) => {
        out.push(String(s));
        return true;
      });
      try {
        await lsImpl({ root, swept: [] });
      } finally {
        stdout.mockRestore();
      }
      expect(out.join("")).toContain("Checkpoints this Styre cannot use (");
      expect(out.join("")).toContain(`fixture/ENG-1  ${c.reason}`);
      const before = treeOf(root);
      const refusal = await cleanImpl(
        { ident: "ENG-1", slug: "fixture" },
        { root, targetRepo: gitRepo() },
      ).catch((e: unknown) => e);
      expect((refusal as { code?: number }).code).toBe(65);
      expect(String((refusal as { headline?: string }).headline)).toContain(c.reason);
      // the way that keeps the paused work comes first
      expect(String((refusal as { recovery?: string }).recovery)).toStartWith(
        "Nothing was removed. To keep the paused work, use the Styre that wrote it;",
      );
      expect(treeOf(root)).toEqual(before);
    },
    TIMEOUT_MS,
  );
}

test(
  "clean --all skips unreadable and incompatible checkpoints",
  async () => {
    const { root } = unreadableEffort("ENG-9");
    const incompatible = join(root, "fixture", "ENG-1");
    mkdirSync(incompatible, { recursive: true });
    copyFileSync(copyFixture("v6-v0.7.0"), join(incompatible, "run.db"));
    const before = treeOf(root);
    await cleanImpl({ all: true, slug: "fixture" }, { root, targetRepo: gitRepo() });
    expect(treeOf(root)).toEqual(before);
  },
  TIMEOUT_MS,
);

test(
  "ls and clean --all reach the folders they reach today: a nested slug is not reached, symbolic links are followed",
  async () => {
    const root = makeTempDir("styre-readers-state-");
    /** A finished (`done`) checkpoint at `dir`, from a private copy of a fixture. */
    const done = (dir: string) => {
      mkdirSync(dir, { recursive: true });
      const dbPath = join(dir, "run.db");
      copyFileSync(copyFixture("v8-main-2b05680"), dbPath);
      const db = new Database(dbPath);
      try {
        db.exec("UPDATE ticket SET status = 'done'");
      } finally {
        db.close();
      }
    };
    // a finished checkpoint under a nested slug: today neither `ls` nor `clean --all` reaches it
    done(join(root, "team", "app", "ENG-2"));
    // a checkpoint folder and a slug folder behind symbolic links: today `ls` lists both
    const elsewhere = makeTempDir("styre-readers-linked-");
    done(join(elsewhere, "ENG-5"));
    done(join(elsewhere, "slug", "ENG-4"));
    mkdirSync(join(root, "web"), { recursive: true });
    symlinkSync(join(elsewhere, "ENG-5"), join(root, "web", "ENG-5"));
    symlinkSync(join(elsewhere, "slug"), join(root, "linked"));
    const listed = listCheckpoints(root)
      .map((c) => `${c.slug}|${c.ident}|${c.kind}`)
      .sort();
    expect(listed).toEqual(["linked|ENG-4|done", "web|ENG-5|done"]);
    const before = treeOf(root);
    for (const slug of ["team/app", "team"]) {
      await cleanImpl({ all: true, slug }, { root, targetRepo: gitRepo() });
    }
    expect(treeOf(root)).toEqual(before); // nothing under `team` was reaped
  },
  TIMEOUT_MS,
);

/** Idents that are not one folder name, and slugs with a part that is not one folder name
 *  (operator rulings, 2026-10-10: a slug may nest with "/", an ident may not). */
const BAD_IDENTS = [".", "..", "../styre.db", "", "a/b", "a\\b", "a\0b"];
const BAD_SLUGS = [
  ".",
  "..",
  "../styre.db",
  "",
  "a\\b",
  "a\0b",
  "team/..",
  "/abs",
  "a//b",
  "a/./b",
  "team/",
];

test(
  "clean refuses an ident or slug that is not a valid folder name (64), before touching anything",
  async () => {
    // a state root with a paused run, a live run and the global database, as `styre clean` sees it
    const root = makeTempDir("styre-readers-state-");
    copyFileSync(copyFixture("v8-main-2b05680"), join(root, "styre.db"));
    for (const ident of ["ENG-1", "ENG-2"]) {
      mkdirSync(join(root, "fixture", ident), { recursive: true });
      copyFileSync(copyFixture("v8-main-2b05680"), join(root, "fixture", ident, "run.db"));
    }
    lockByLiveRun(join(root, "fixture", "ENG-2"));
    // damaged run.db files where a bad name would lead without the check: ident `..` with slug
    // `fixture` reaches the root; ident `ENG-1` with slug `team/..`, `/abs`, `a//b` or `a/./b`
    // reaches root/ENG-1, root/abs/ENG-1 and root/a/b/ENG-1. Each would give 65, not 64.
    writeFileSync(join(root, "run.db"), "not a database");
    for (const dir of [
      join(root, "ENG-1"),
      join(root, "abs", "ENG-1"),
      join(root, "a", "b", "ENG-1"),
    ]) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "run.db"), "not a database");
    }
    const before = treeOf(root);
    const repo = gitRepo();
    const cases = [
      ...BAD_IDENTS.map((name) => ({ ident: name, slug: "fixture" })),
      ...BAD_IDENTS.map((name) => ({ ident: name, slug: "fixture", purge: true })),
      ...BAD_SLUGS.map((name) => ({ ident: "ENG-1", slug: name })),
      // `--all` builds no checkpoint path, so only cleanImpl's own slug check refuses these
      ...BAD_SLUGS.map((name) => ({ all: true, slug: name })),
    ];
    for (const args of cases) {
      const refusal = await cleanImpl(args, { root, targetRepo: repo }).catch((e: unknown) => e);
      expect([JSON.stringify(args), (refusal as { code?: number }).code]).toEqual([
        JSON.stringify(args),
        64,
      ]);
    }
    expect(treeOf(root)).toEqual(before);
  },
  TIMEOUT_MS,
);

test(
  "--resume refuses an ident or slug that is not one folder name (64), though a run.db waits where it leads",
  async () => {
    const state = makeTempDir("styre-readers-names-");
    const styre = join(state, "styre"); // parkDir(slug, ident) is <state>/styre/<slug>/<ident>
    const cases: [slug: string, ident: string, reached: string][] = [
      ["inspect", ".", join(styre, "inspect")],
      ["inspect", "..", styre],
      ["inspect", "../styre.db", join(styre, "styre.db")],
      ["..", "ENG-1", join(state, "ENG-1")],
    ];
    // without the check each case finds a real paused run there, takes its lock and inspects it
    for (const [, , reached] of cases) {
      mkdirSync(reached, { recursive: true });
      copyFileSync(copyFixture("v8-main-2b05680"), join(reached, "run.db"));
    }
    const before = treeOf(state);
    const repo = gitRepo();
    const prev = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = state;
    try {
      for (const [slug, ident] of cases) {
        const profile = parseProfile({ slug, targetRepo: repo, components: [] });
        const refusal = await resumeRun(
          { resume: ident, inspect: true },
          profile,
          DEFAULT_RUNTIME_CONFIG,
        ).catch((e: unknown) => e);
        const code = (refusal as { code?: number } | undefined)?.code;
        expect([slug, ident, code]).toEqual([slug, ident, 64]);
      }
    } finally {
      if (prev === undefined) Reflect.deleteProperty(process.env, "XDG_STATE_HOME");
      else process.env.XDG_STATE_HOME = prev;
    }
    expect(treeOf(state)).toEqual(before);
  },
  TIMEOUT_MS,
);

test(
  "styre run checks --slug, a derived slug and the ident (64) and the profile's own slug (78) before building a path",
  async () => {
    const config = makeTempDir("styre-readers-config-");
    const profileJson = (slug: string) =>
      JSON.stringify({ slug, targetRepo: gitRepo(), components: [] });
    // the profile `--slug ..` would reach without the check: <config>/styre/../profile.json
    writeFileSync(join(config, "profile.json"), profileJson("fixture"));
    const named = join(makeTempDir("styre-readers-profile-"), "profile.json");
    writeFileSync(named, profileJson(".."));
    const prev = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = config;
    try {
      const cases: [args: { slug?: string; profile?: string }, code: number][] = [
        [{ slug: ".." }, 64],
        [{ slug: "a\\b" }, 64],
        [{ slug: "team/.." }, 64],
        [{ slug: "/abs" }, 64],
        [{ profile: named }, 78], // the slug comes from a profile file: EXIT.CONFIG
      ];
      for (const [args, expected] of cases) {
        let code: number | undefined;
        try {
          loadRunProfile(args);
        } catch (e) {
          code = (e as { code?: number }).code;
        }
        expect([JSON.stringify(args), code]).toEqual([JSON.stringify(args), expected]);
      }
    } finally {
      if (prev === undefined) Reflect.deleteProperty(process.env, "XDG_CONFIG_HOME");
      else process.env.XDG_CONFIG_HOME = prev;
    }
    // `clean --profile` reads the slug from the file too
    const profiled = await cleanImpl(
      { ident: "ENG-1", profile: named },
      { root: makeTempDir("styre-readers-state-"), targetRepo: gitRepo() },
    ).catch((e: unknown) => e);
    expect((profiled as { code?: number }).code).toBe(78);
    // the fresh run builds its checkpoint path from the tracker's ident through parkDir
    for (const ident of BAD_IDENTS) {
      expect(() => parkDir("fixture", ident)).toThrow("not a valid ident");
    }
    for (const slug of BAD_SLUGS) expect(() => parkDir(slug, "ENG-1")).toThrow("not a valid slug");
    expect(parkDir("fixture", "ENG-1").endsWith(join("fixture", "ENG-1"))).toBe(true);
    expect(parkDir("team/app", "ENG-1").endsWith(join("team", "app", "ENG-1"))).toBe(true);
  },
  TIMEOUT_MS,
);

test(
  "styre setup refuses a slug that styre run would refuse (64), before the agent runs or anything is written",
  async () => {
    const config = makeTempDir("styre-readers-setup-config-");
    const repo = repoAt(join(makeTempDir("styre-readers-setup-"), "app"));
    // no remote, so the slug is derived from the folder name, which here holds a backslash
    const odd = repoAt(join(makeTempDir("styre-readers-setup-"), "a\\b"));
    const runner = new FakeAgentRunner(() => {
      throw new Error("the setup agent must not run");
    });
    const deps = { runner, agentConfig: DEFAULT_AGENT_CONFIG, sleep: async () => {} };
    const prev = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = config;
    try {
      const cases: [dir: string, slug: string | undefined][] = [
        ...BAD_SLUGS.map((slug): [string, string] => [repo, slug]),
        [odd, undefined],
      ];
      for (const [dir, slug] of cases) {
        const refusal = await runSetup({ repo: dir, slug, deps }).catch((e: unknown) => e);
        const code = (refusal as { code?: number }).code;
        expect([dir, slug, code]).toEqual([dir, slug, 64]);
      }
    } finally {
      if (prev === undefined) Reflect.deleteProperty(process.env, "XDG_CONFIG_HOME");
      else process.env.XDG_CONFIG_HOME = prev;
    }
    expect(readdirSync(config)).toEqual([]); // no profile and no folder was written
  },
  TIMEOUT_MS,
);

test(
  "a nested slug (team/app) works for a fresh run, its pause, --resume and clean <ident>; ls does not list it, as today",
  async () => {
    const run = await runFreshTicket({ slug: "team/app" });
    try {
      const root = join(run.stateRoot, "styre");
      const ident = basename(run.checkpointDir);
      expect(run.checkpointDir).toBe(join(root, "team", "app", ident));
      expect(existsSync(run.dbPath)).toBe(true); // the pause left its checkpoint there
      // `ls` reads two levels, as today: a nested slug's checkpoint is not listed (ENG-491)
      expect(listCheckpoints(root)).toEqual([]);
      const profile = parseProfile({ slug: "team/app", targetRepo: run.repoDir, components: [] });
      await resumeRun({ resume: ident, inspect: true }, profile, DEFAULT_RUNTIME_CONFIG);
      expect(stderr.join("")).toContain("would re-dispatch step");
      await cleanImpl({ ident, slug: "team/app" }, { root, targetRepo: run.repoDir });
      expect(existsSync(run.checkpointDir)).toBe(false);
    } finally {
      run.cleanup();
    }
  },
  TIMEOUT_MS,
);

test(
  "--resume --inspect on a current checkpoint made by a fresh run changes nothing in its folder (ruling 2026-10-10)",
  async () => {
    // After Task 4 no committed fixture is current, so a real fresh run makes the current case.
    const run = await runFreshTicket();
    try {
      const ident = basename(run.checkpointDir);
      // every file with a digest of its bytes: run.db, -wal, -shm, transcript.json
      const folder = () =>
        treeOf(run.checkpointDir).map(([f, bytes]) => [
          f,
          new Bun.CryptoHasher("sha256").update(bytes).digest("hex"),
        ]);
      const before = folder();
      const profile = parseProfile({
        slug: "test-project",
        targetRepo: run.repoDir,
        components: [],
      });
      await resumeRun({ resume: ident, inspect: true }, profile, DEFAULT_RUNTIME_CONFIG);
      // the same files with the same bytes: no migration, no open of the original (no WAL switch,
      // no -shm rewrite), no run row (markResumed would change resumed and attempt); run.lock was
      // made and removed again, as every resume does
      expect(folder()).toEqual(before);
      expect(stderr.join("")).toContain(`schema v${CURRENT_VERSION}, current`);
    } finally {
      run.cleanup();
    }
  },
  TIMEOUT_MS,
);

test(
  "styre setup checks --slug and a derived slug itself, before any config read or the agent CLI check (64)",
  async () => {
    const config = makeTempDir("styre-readers-setup-config-");
    const repo = repoAt(join(makeTempDir("styre-readers-setup-"), "app"));
    // no remote, so the slug is derived from the folder name, which here holds a backslash
    const odd = repoAt(join(makeTempDir("styre-readers-setup-"), "a\\b"));
    const preflight = () => {
      throw new Error("the agent CLI check must not run");
    };
    const prev = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = config;
    try {
      const cases: [dir: string, slug: string | undefined][] = [
        [repo, "team/.."],
        [repo, "/abs"],
        [repo, "a//b"],
        [odd, undefined],
      ];
      for (const [dir, slug] of cases) {
        const refusal = await setupImpl({ args: { repo: dir, slug } }, { preflight }).catch(
          (e: unknown) => e,
        );
        const code = (refusal as { code?: number }).code;
        expect([dir, slug, code]).toEqual([dir, slug, 64]);
      }
    } finally {
      if (prev === undefined) Reflect.deleteProperty(process.env, "XDG_CONFIG_HOME");
      else process.env.XDG_CONFIG_HOME = prev;
    }
    expect(readdirSync(config)).toEqual([]); // nothing was written under the config folder
  },
  TIMEOUT_MS,
);
```

`test/helpers/run-harness.ts`: `runFreshTicket`'s options gain `/** The profile's slug (default `FRESH_SLUG`); it may nest, as `team/app`. */ slug?: string;`, line 692 becomes `slug: opts?.slug ?? FRESH_SLUG,`, and line 759 `const checkpointDir = parkDir(opts?.slug ?? FRESH_SLUG, FRESH_IDENT);`.

- [ ] **Step 2: Run it and see it fail**

Run: `perl -e 'alarm 600; exec @ARGV' bun test test/cli/checkpoint-readers-fixtures.test.ts`
Expected: FAIL with `Cannot find module '../../src/db/repos/checkpoint-read.ts'`.

- [ ] **Step 3: Write the narrow readers**

```ts
// src/db/repos/checkpoint-read.ts
import type { Database } from "bun:sqlite";

/** Reads for the commands that look at a checkpoint WITHOUT migrating it: `styre ls`, `styre clean`
 *  and `--fresh`'s discard (spec §7.7). Each query names only columns present since schema v7, so it
 *  keeps working on an old checkpoint after the shared repository column lists grow (a growing list
 *  would throw there, and ENG-485's in place undo would be skipped without a word). */

export interface CheckpointTicket {
  id: number;
  project_id: number;
  ident: string;
  stage: string;
  status: string;
  branch_name: string | null;
  branch_prefix: string | null;
}

export function readCheckpointTicket(db: Database, ticketId: number): CheckpointTicket | null {
  return (
    db
      .query<CheckpointTicket, [number]>(
        "SELECT id, project_id, ident, stage, status, branch_name, branch_prefix FROM ticket WHERE id = ?",
      )
      .get(ticketId) ?? null
  );
}

export function readCheckpointTargetRepo(db: Database, projectId: number): string | null {
  return (
    db
      .query<{ target_repo: string }, [number]>("SELECT target_repo FROM project WHERE id = ?")
      .get(projectId)?.target_repo ?? null
  );
}

export function listCheckpointPendingSignals(
  db: Database,
  ticketId: number,
): { signal_type: string; reason: string | null }[] {
  return db
    .query<{ signal_type: string; reason: string | null }, [number]>(
      "SELECT signal_type, reason FROM signal WHERE ticket_id = ? AND status = 'pending' ORDER BY id",
    )
    .all(ticketId);
}

export interface CheckpointRunningStep {
  id: number;
  ticket_id: number;
  step_key: string;
  attempt: number;
  pid: number | null;
  started_at: string | null;
}

export function listCheckpointRunningSteps(db: Database): CheckpointRunningStep[] {
  return db
    .query<CheckpointRunningStep, []>(
      "SELECT id, ticket_id, step_key, attempt, pid, started_at FROM workflow_step WHERE status = 'running' ORDER BY ticket_id, seq",
    )
    .all();
}

/** The run's one ticket (a checkpoint holds one), or null. */
export function readCheckpointOnlyTicket(db: Database): CheckpointTicket | null {
  const row = db.query<{ id: number }, []>("SELECT id FROM ticket ORDER BY id LIMIT 1").get();
  return row ? readCheckpointTicket(db, row.id) : null;
}

/** The step a resume would dispatch again: the one left running, else the one that failed. */
export function findCheckpointParkedStepKey(db: Database, ticketId: number): string | null {
  const pick = (status: string) =>
    db
      .query<{ step_key: string }, [number, string]>(
        "SELECT step_key FROM workflow_step WHERE ticket_id = ? AND status = ? ORDER BY seq LIMIT 1",
      )
      .get(ticketId, status)?.step_key ?? null;
  return pick("running") ?? pick("failed");
}
```

- [ ] **Step 4: Use them**

Every read below goes through `readCopyOf` (Task 1, operator ruling 2026-10-09): the checkpoint itself is never opened, in any journal mode, so a WAL checkpoint without its `-wal`/`-shm` files is still read (a read only open of one fails on macOS with `unable to open database file`), and nothing beside it changes.

`src/cli/checkpoints.ts`: replace the imports on lines 6-7 with `import { listCheckpointPendingSignals, readCheckpointTicket } from "../db/repos/checkpoint-read.ts";` and add `import { readCopyOf } from "../db/read-copy.ts";`, `import { type DatabaseState, classifyDatabase } from "../db/migrate.ts";` and `import { CURRENT_VERSION, OLDEST_MIGRATABLE_VERSION } from "../db/migrations/index.ts";`; `Database` becomes a type only import (`import type { Database } from "bun:sqlite";`). In `classifyCheckpointDb` replace `const t = getTicket(db, ticketId);` with `const t = readCheckpointTicket(db, ticketId);` and `const pending = listPending(db, ticketId);` with `const pending = listCheckpointPendingSignals(db, ticketId);`. `CheckpointKind` (line 10) gains `"unreadable"` and `"incompatible"`; `RESUMABLE` contains neither, and `clean --all` never reaps them (it reaps `pr-ready` and `done` only).

The rule (operator rulings, 2026-10-09 and 2026-10-10): `ls` never silently drops a checkpoint. One it cannot use because of its schema (written by a newer Styre, an unknown shape, older than v7) is listed as `incompatible`, with that reason, never as damaged. One it cannot read (damaged, no ticket recorded) is listed as `unreadable`, with the reason. A folder without `run.db` is skipped, as today. A checkpoint stamped with the current version whose shape differs (from a development build, say) is not checked for shape at the current version (`classifyDatabase`), so it shows as `unreadable` with the readers' error: on purpose, since nothing removes it either way. Add above `listCheckpoints`:

```ts
/** What a checkpoint's database says, read through one private copy: its state (a schema this
 *  Styre can use, or why not) and, when the schema is usable, its classification. */
export interface CheckpointRead {
  state: DatabaseState;
  cls: ReturnType<typeof classifyCheckpointDb>;
}

export function readCheckpoint(dbPath: string, dir: string): CheckpointRead {
  return readCopyOf(dbPath, (db) => {
    const state = classifyDatabase(db, dbPath);
    return { state, cls: state.kind === "refuse" ? null : classifyCheckpointDb(db, dir) };
  });
}

/** Why this Styre cannot use a checkpoint because of its schema (operator ruling, 2026-10-10):
 *  never reported as damage. */
export function incompatibleReason(state: DatabaseState): string {
  if (state.kind !== "refuse") throw new Error("incompatibleReason: the schema is usable");
  if (state.version === null) return "unknown database shape";
  if (state.version > CURRENT_VERSION) return `written by a newer Styre (schema v${state.version})`;
  if (state.version < OLDEST_MIGRATABLE_VERSION)
    return `older than v${OLDEST_MIGRATABLE_VERSION} (schema v${state.version})`;
  return "unknown database shape";
}

/** A checkpoint listed without a classification, never dropped: never resumable, never reaped
 *  by `clean --all`. */
function unusableCheckpoint(
  where: { slug: string; ident: string; dir: string; dbPath: string },
  kind: "unreadable" | "incompatible",
  note: string,
): Checkpoint {
  const lock = runLockStatus(where.dir);
  return {
    ...where,
    ticketId: 0,
    status: "unknown",
    stage: "unknown",
    branch: "",
    kind,
    note,
    ageMs: 0,
    live: lock !== null && !lock.self,
    resumable: false,
  };
}
```

and in `listCheckpoints` replace lines 115-126 (from `let cls` through `if (cls === null) continue;`) with the block below. Nothing else in `listCheckpoints` changes (operator ruling, 2026-10-10: cut back to what ENG-477 needs): it reaches exactly the folders it reaches today, `<root>/<slug>/<ident>` two levels down, following symbolic links as today (`statSync` and `existsSync` follow them), and line 114, `if (!existsSync(dbPath)) continue;`, stays. A checkpoint under a nested slug (`team/app`) is not listed, as today; listing nested slugs is ENG-491. So `clean --all` (`clean.ts:106-107`, the only other caller) reaches the same folders as today, and reaps fewer: a checkpoint it cannot read or whose schema it cannot use is listed now but never `pr-ready` or `done`.

```ts
      const where = { slug, ident, dir, dbPath };
      let read: CheckpointRead | null = null;
      let reason = "no ticket recorded";
      try {
        read = readCheckpoint(dbPath, dir);
      } catch (err) {
        reason = `could not read it: ${err instanceof Error ? err.message : String(err)}`;
      }
      if (read?.state.kind === "refuse") {
        out.push(unusableCheckpoint(where, "incompatible", incompatibleReason(read.state)));
        continue;
      }
      const cls = read?.cls ?? null;
      if (cls === null) {
        out.push(unusableCheckpoint(where, "unreadable", reason));
        continue;
      }
```

`src/cli/ls.ts`: in `lsImpl`, leave both kinds out of the running list (`const running = all.filter((c) => c.live && c.kind !== "unreadable" && c.kind !== "incompatible");`), and right after the leftovers section, before the running section, add the two sections below. A live one (a run holds its lock) says so with `(running)`; the hints carry `--slug`, since `ls` spans every project and `clean` otherwise derives the slug from the current folder:

```ts
const unusable = [
  [
    "unreadable",
    "Unreadable checkpoints (remove by hand: `styre clean <ident> --slug <slug>` names what to remove; or start over with `styre run <ident> --slug <slug> --fresh`):",
  ],
  [
    "incompatible",
    "Checkpoints this Styre cannot use (use the Styre that wrote them; or remove by hand, or start over with `styre run <ident> --slug <slug> --fresh`):",
  ],
] as const;
for (const [kind, title] of unusable) {
  const rows = all.filter((c) => c.kind === kind);
  if (rows.length === 0) continue;
  lines.push("");
  lines.push(title);
  for (const c of rows) {
    const running = c.live ? " (running)" : "";
    lines.push(`  ${c.slug}/${c.ident}${running}  ${c.note ?? ""}`.trimEnd());
  }
}
```

`src/cli/clean.ts`: add `import { readCopyOf } from "../db/read-copy.ts";`; in `reapEffort` (lines 38-44) replace the `db`/`stale`/`try`/`finally` lines with `const stale = readCopyOf(c.dbPath, (db) => getLatestWorktreePath(db, c.ticketId));`. In `cleanImpl` replace lines 166-175 (from `const db = new Database(dbPath, { readonly: true });` through the `if (cls === null) { throw usageError(...) }` block) with the block below, and add the two helpers above `cleanImpl`. Lines 152-164 stay as they are (line 151 builds the path through `checkpointPath`, below): a folder without `run.db` still gives `no styre effort on '<ident>'` (exit `64`), and the live run gate still exits `75`, before anything is read. Imports: remove `import { Database }` (no use left); `realpathSync` beside `existsSync, rmSync`; `basename, dirname` beside `join`; `listWorktrees` beside the other `../dispatch/worktree.ts` names; `type CheckpointRead, incompatibleReason, listCheckpoints, readCheckpoint` from `./checkpoints.ts`; `assertCheckpointName, assertProfileSlug, checkpointPath` from `./checkpoint-name.ts` (`classifyCheckpointDb` has no use left there).

What `styre clean <ident>` does with a checkpoint it cannot use (operator ruling, 2026-10-10, which replaces the earlier ones: ENG-477 adds no new way to delete anything): it refuses, exit `65`, and removes nothing. That is `EXIT.RESUME_REFUSED` (`EX_DATAERR`, `errors.ts:11`): the code the plan already uses for every checkpoint this Styre will not take (Task 2's migration refusals), and the closest existing code for input data that cannot be used; `64` would say the command was misused, which it was not. The refusal names the reason (the schema reason for an `incompatible` checkpoint; the read error or `no ticket recorded` for an `unreadable` one) and the checkpoint folder, and prints each worktree of the target repository that looks like the run's (a folder named after the ident whose parent folder's name starts with `styre-wt-`, what `run.ts:448` and `park.ts:379` make; never the main entry, never the repository's own real path) so the operator can remove them by hand. It prints them as plain descriptive text: the reason in the headline, the checkpoint folder and the worktree paths in the detail, and one sentence pointing at the `styre clean` section of `runtime-parameters.md` (Task 18), which describes the removal by hand. It prints no shell command (operator ruling, 2026-10-10, which cut back the printed command block of an earlier revision; printed commands and nested slug listing are ENG-491). For an incompatible checkpoint the recovery first says that the Styre that wrote it keeps the paused work. `--purge` makes no difference: it refuses the same way. `clean --all` skips both kinds (they are never `pr-ready` or `done`). Safe removal of such checkpoints is ENG-491 (hand off note 19).

```ts
/** Worktrees of `targetRepo` that look like they belonged to a Styre run of `ident`: a folder named
 *  after the ident whose parent folder's name starts with `styre-wt-` (what run.ts and park.ts
 *  make), never the main entry and never the repository's own real path. Only printed, never
 *  removed (operator ruling, 2026-10-10). */
export function styreWorktreeCandidates(targetRepo: string, ident: string): string[] {
  const repo = realpathSync(targetRepo);
  return listWorktrees(targetRepo)
    .slice(1) // git lists the main working tree first
    .map((w) => w.path)
    .filter((p) => basename(p) === ident && basename(dirname(p)).startsWith("styre-wt-"))
    .filter((p) => !existsSync(p) || realpathSync(p) !== repo);
}

/** `styre clean <ident>` on a checkpoint it cannot use (operator rulings, 2026-10-10): refuse
 *  (exit 65) and remove nothing. It describes, as plain text, why, where the checkpoint is, and
 *  which worktrees look like the run's, and points at the docs for removing them by hand. It prints
 *  no shell command (nested slug listing and printed commands are ENG-491). */
function refuseUnusableCheckpoint(
  where: { ident: string; dir: string },
  kind: "unreadable" | "incompatible",
  reason: string,
  targetRepo: string,
): StyreError {
  const lines = [`checkpoint folder: ${where.dir}`];
  try {
    const paths = styreWorktreeCandidates(targetRepo, where.ident);
    if (paths.length === 0) lines.push(`no worktree of ${targetRepo} looks like this run's`);
    else {
      lines.push(`worktrees of ${targetRepo} that look like this run's:`);
      lines.push(...paths.map((p) => `  ${p}`));
    }
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    lines.push(`could not list the worktrees of ${targetRepo}: ${why}`);
  }
  const docs = "the `styre clean` section of docs/architecture/runtime-parameters.md";
  return new StyreError({
    code: EXIT.RESUME_REFUSED,
    headline: `cannot clean '${where.ident}': this Styre cannot use its checkpoint (${reason})`,
    detail: lines.join("\n"),
    recovery:
      kind === "incompatible"
        ? `Nothing was removed. To keep the paused work, use the Styre that wrote it; to remove the run by hand instead, see ${docs}.`
        : `Nothing was removed. To remove the run by hand, see ${docs}.`,
  });
}
```

```ts
  let read: CheckpointRead | null = null;
  let unreadable = "no ticket recorded";
  try {
    read = readCheckpoint(dbPath, dir);
  } catch (err) {
    unreadable = err instanceof Error ? err.message : String(err);
  }
  if (read?.state.kind === "refuse") {
    const reason = incompatibleReason(read.state);
    throw refuseUnusableCheckpoint({ ident, dir }, "incompatible", reason, targetRepo);
  }
  const cls = read?.cls ?? null;
  if (cls === null)
    throw refuseUnusableCheckpoint({ ident, dir }, "unreadable", unreadable, targetRepo);
```

Names are checked before any path is built from them (operator rulings, 2026-10-10), by one file used everywhere a checkpoint path is built. An ident is one folder name. A slug may hold `/`: it then nests, as `conventions.md:108-110` documents, so each part between slashes is checked as one folder name. Create it:

```ts
// src/cli/checkpoint-name.ts
import { join, resolve, sep } from "node:path";
import { configError, usageError } from "./errors.ts";

const RULE = {
  ident:
    'An ident names one checkpoint folder: not empty, not "." or "..", and no "/", "\\" or NUL.',
  slug: 'A slug names a folder and may nest with "/": each part between slashes not empty, not "." or "..", and no "\\" or NUL.',
} as const;

/** Why `value` cannot name a checkpoint folder, or null when it can (operator rulings,
 *  2026-10-10). An ident is one folder name. A slug may hold `/` and then nests (conventions.md),
 *  so each part between slashes is one folder name: `team/app` is fine; `team/..`, `/abs`, `a//b`
 *  and `a/./b` are not. */
export function checkpointNameProblem(what: "ident" | "slug", value: string): string | null {
  if (what === "ident" && value.includes("/")) return 'it holds "/"';
  for (const part of what === "slug" ? value.split("/") : [value]) {
    if (part === "") return "it has an empty part";
    if (part === "." || part === "..") return `it has a part "${part}"`;
    if (/[\\\0]/.test(part)) return 'it holds "\\" or NUL';
  }
  return null;
}

/** A name from the command line, derived from the repository, or from the tracker: a usage error
 *  (exit 64). */
export function assertCheckpointName(what: "ident" | "slug", value: string): void {
  const problem = checkpointNameProblem(what, value);
  if (problem !== null) {
    throw usageError(`not a valid ${what}: ${JSON.stringify(value)} (${problem})`, RULE[what]);
  }
}

/** A slug read from a profile file: a config error (exit 78) that names the file. */
export function assertProfileSlug(slug: string, file: string): void {
  const problem = checkpointNameProblem("slug", slug);
  if (problem !== null) {
    throw configError({
      file,
      field: "slug",
      detail: `${JSON.stringify(slug)}: ${problem}. ${RULE.slug}`,
      recovery: "Run styre setup again with --slug <name>, or correct the slug in that file.",
    });
  }
}

/** `<root>/<slug>/<ident>` once both names pass, and, as a second line of defence, only when the
 *  resolved path stays inside `root`. Failing that second check is a Styre defect (a plain Error,
 *  exit 70): the name check above makes it unreachable. */
export function checkpointPath(root: string, slug: string, ident: string): string {
  assertCheckpointName("slug", slug);
  assertCheckpointName("ident", ident);
  const base = resolve(root);
  if (!resolve(base, slug, ident).startsWith(base + sep)) {
    throw new Error(`the checkpoint path of ${JSON.stringify(`${slug}/${ident}`)} leaves ${base}`);
  }
  return join(root, slug, ident);
}
```

Exit codes (ninth review, minor b): a name given on the command line (`--slug`, the `--resume` ident, `clean`'s ident), derived from the repository, or taken from the tracker is a usage error (`64`); a slug read from a profile file is a config error (`78`, `EXIT.CONFIG`: "bad config/profile value"), naming the file.

Where it is called:
- `parkDir(slug, ident)` (`park.ts:98-100`) becomes `return checkpointPath(stateDir(), slug, ident);`. Every checkpoint path `styre run` builds goes through it: the fresh run (`run.ts:370`, where the tracker's ident first becomes a path, before `--fresh` discards anything at `run.ts:381-407`), the resume (`park.ts:239`, before the lock and the `--inspect` read), the pause (`park.ts:134`) and the pause message (`run.ts:499`).
- `loadRunProfile` (`load-profile.ts:40-56`), which `styre run` calls before anything else that uses a name (`run.ts:229`): `if (args.slug && args.slug.length > 0) assertCheckpointName("slug", args.slug);` as its first statement (the `--slug` flag builds `<config>/<slug>/profile.json`); `assertCheckpointName("slug", derived);` before `loadProfileByConvention(derived)` (a slug derived from the folder name can hold a `\`, legal on macOS and Linux: refused here, before a run is made that `--resume` and `clean` would refuse later); and, after the profile is read, `assertProfileSlug(raw.slug, args.profile ?? profilePathFor(derived))` (the slug `parkDir` receives; `profilePathFor` from `../config/discover.ts`; in the `--profile` branch the file is `args.profile`).
- `cleanImpl`: `if (args.ident !== undefined) assertCheckpointName("ident", args.ident);` as its first statement; right after the slug is resolved (before `loadProfileByConvention(slug)` at line 94, inside the `if` on line 93), `if (args.slug === undefined && args.profile && !opts?.profile) assertProfileSlug(slug, args.profile);` then `assertCheckpointName("slug", slug);`; and line 151 becomes `const dir = opts?.root ? checkpointPath(opts.root, slug, ident) : parkDir(slug, ident);`. `cleanCommand`'s `sweepOrphans`, which runs first, uses neither name.
- `styre setup` (operator ruling, 2026-10-10: setup can never write a slug that run refuses): in `setupBody` (which `setupImpl` runs), `assertCheckpointName("slug", effSlug);` right after `effSlug` is computed (`setup.ts:453`, before `discoverRuntimeConfig` builds `<config>/<slug>/config.json` and before the agent preflight); in `runSetup`, `if (args.slug !== undefined) assertCheckpointName("slug", args.slug);` as its first statement and `assertCheckpointName("slug", scanProfile.slug);` right after `probeProfile` (`setup.ts:129-132`, before the enrichment agent runs and before the profile path is built), for callers that pass no slug.

`styre ls` takes neither name, and its listing reaches the same folders as today (above; nested slug listing is ENG-491). `styre notify --slug` builds only `<config>/<slug>/config.json` to read a config and is not changed by this plan.

`src/cli/errors.ts` (comments only, no behaviour): line 11 becomes `RESUME_REFUSED: 65, // EX_DATAERR: a checkpoint refused (resume: HEAD moved, lock held, schema it cannot use; clean: a checkpoint it cannot use)`, and the comment above `errorKindForExit` (lines 124-126) gains the sentence `65 is reported as "resume_refused" for every refused checkpoint styre run reports (resume refusals and the migration refusals); only styre run emits cli_error, so a refusal by styre clean never reaches it. The value is a product analytics value that dashboards may group on, so it stays.`

`src/util/process/interruption.ts`:
- imports: remove `import { getProject } from "../../db/repos/project.ts";` and `import { getTicket } from "../../db/repos/ticket.ts";`, add `import { listCheckpointRunningSteps, readCheckpointTargetRepo, readCheckpointTicket } from "../../db/repos/checkpoint-read.ts";`;
- line 113: `export function findInterruption(db: Database, step: Pick<WorkflowStepRow, "id" | "ticket_id" | "attempt" | "started_at">): InterruptionPayload | null {`;
- `olderCheckpointWarning(step: Pick<WorkflowStepRow, "pid" | "step_key">)`;
- add `import { readCopyOf } from "../../db/read-copy.ts";`;
- replace `undoBeforeDiscard` and its comment (lines 232-274) with the version below: it reads everything it needs from a private copy, then undoes the edits outside it (the undo works on the checkout, not the database), so an error in the undo is not reported as an unreadable checkpoint:

```ts
interface DiscardStep {
  step: CheckpointRunningStep;
  undo: { payload: InterruptionPayload; inPlace: boolean; repoPath: string; branch: string } | null;
}

/** Section 7.5: `--fresh` and `clean` in in-place mode undo an interrupted step's edits before they
 *  discard the checkpoint; otherwise the next run would count the agent's new files as files that
 *  were already there. The mode is the checkpoint's own: in place when its latest dispatch worked
 *  in the project's repository (as resume derives it). The checkpoint is read through a private
 *  copy and never opened (operator ruling, 2026-10-09); only a failure to read it is reported as
 *  "could not read". The older checkpoint warning (a read of the process table) and the undo (git
 *  on the checkout) run after the copy is gone, and their own errors surface as they are. Call it
 *  after the live lock check. */
export function undoBeforeDiscard(dbPath: string, warn: (line: string) => void): void {
  if (!existsSync(dbPath)) return;
  let found: DiscardStep[];
  try {
    found = readCopyOf(dbPath, (db) =>
      listCheckpointRunningSteps(db).map((step): DiscardStep => {
        const payload = findInterruption(db, step);
        const ticket = payload ? readCheckpointTicket(db, step.ticket_id) : null;
        const repoPath = ticket ? readCheckpointTargetRepo(db, ticket.project_id) : null;
        if (!payload || !ticket || !repoPath) return { step, undo: null };
        const inPlace = getLatestWorktreePath(db, step.ticket_id) === repoPath;
        return { step, undo: { payload, inPlace, repoPath, branch: branchNameFor(ticket) } };
      }),
    );
  } catch (err) {
    warn(`styre: could not read ${dbPath} to undo an interrupted step's edits: ${String(err)}`);
    return;
  }
  for (const f of found) {
    const older = olderCheckpointWarning(f.step);
    if (older) warn(older);
    if (!f.undo) continue;
    const { payload, ...where } = f.undo;
    const line = undoInterruptedEdits(payload, where);
    if (line) warn(line);
  }
}
```

(`Database` stays imported for `recordInterruption`; the `steps` namespace import stays for it too; import `type CheckpointRunningStep` with the readers.)

Check `recover.ts` still compiles: it passes full `WorkflowStepRow` values, which satisfy the narrower `Pick` types.

`src/cli/park.ts` (operator rulings, 2026-10-09 and 2026-10-10: `--inspect` is read only whatever the version, never migrates, writes no backup and no run row, and works on a checkpoint resume would refuse). Import `type DatabaseState, readDatabaseState` from `../db/migrate.ts`, `CURRENT_VERSION` from `../db/migrations/index.ts`, `readCopyOf` from `../db/read-copy.ts`, and `findCheckpointParkedStepKey, readCheckpointOnlyTicket, readCheckpointTargetRepo` from `../db/repos/checkpoint-read.ts`. Add above `resumeRun`:

```ts
/** `--inspect` on any checkpoint, whatever its version (operator rulings, 2026-10-09 and
 *  2026-10-10): read through a private copy, with the readers that work on every shape since v7
 *  (spec §7.7). It writes nothing to the database: no migration, no backup, no run row, and the
 *  original is never opened; so it also works where resume would refuse. */
export function inspectWithoutUpgrading(
  dbPath: string,
  ident: string,
  state: DatabaseState,
): string {
  const schema =
    state.kind === "upgrade"
      ? `resume will upgrade this checkpoint from v${state.version} to v${CURRENT_VERSION}, after writing a backup`
      : state.kind === "refuse"
        ? `resume would refuse this checkpoint: ${state.error.headline}`
        : state.kind === "empty"
          ? "the checkpoint holds no tables"
          : `schema v${state.version}, current`;
  let details: string;
  try {
    // A private copy (operator ruling, 2026-10-09): the checkpoint itself is never opened.
    details = readCopyOf(dbPath, (db) => {
      const ticket = readCheckpointOnlyTicket(db);
      const targetRepo = ticket ? readCheckpointTargetRepo(db, ticket.project_id) : null;
      if (!ticket || !targetRepo) return "  (no ticket in this checkpoint)\n";
      const recorded = headBaseline(db, ticket.id);
      const current = branchHeadSha(targetRepo, branchNameFor(ticket));
      const moved = recorded !== null && current !== null && recorded !== current;
      return (
        `  recorded base: ${recorded ?? "(none)"}\n  current head:  ${current ?? "(none)"}${moved ? "  [MOVED]" : ""}\n` +
        `  would re-dispatch step: ${findCheckpointParkedStepKey(db, ticket.id) ?? "(none)"}\n`
      );
    });
  } catch (err) {
    details = `  (the rest cannot be read on this shape: ${err instanceof Error ? err.message : String(err)})\n`;
  }
  return `resume --inspect ${ident}\n  schema: ${schema}\n${details}  (no changes made)\n`;
}
```

and in `resumeRun`, right after `try {` (line 259) and before the `migrate(dbPath, ...)` call (Task 2):

```ts
    // --inspect is diagnostics only, whatever the checkpoint's version (operator rulings,
    // 2026-10-09 and 2026-10-10): it reads a private copy and writes nothing to the database (no
    // migration, no backup, no open of the original, no insertRun or markResumed). The run lock,
    // a file beside the database, is released by the finally below.
    if (args.inspect) {
      let state: DatabaseState;
      try {
        state = readDatabaseState(dbPath);
      } catch (err) {
        process.stderr.write(
          `resume --inspect ${args.resume}\n  schema: cannot be read: ${err instanceof Error ? err.message : String(err)}\n  (no changes made)\n`,
        );
        return;
      }
      process.stderr.write(inspectWithoutUpgrading(dbPath, args.resume, state));
      return;
    }
```

and delete today's `if (args.inspect) {...}` block further down (`park.ts:299-305`, after the head comparison), which no run reaches any more. Its output is kept: `inspectWithoutUpgrading` prints the same recorded base, current head (`[MOVED]` when they differ), step to dispatch again (the running step, else the failed one, as resume picks it) and `(no changes made)`, plus the `schema:` line. (`branchHeadSha` and `branchNameFor` are already imported in `park.ts`; the early `return`s sit inside the `try` whose `finally` releases the run lock.)

- [ ] **Step 4b: The existing tests' reads of run databases (operator ruling, 2026-10-09)**

These existing tests open a run database read only to check what a run left. Each such read goes through `readCopyOf` too, so the rule holds for every reader and the source guard (Task 4) can refuse read only opens everywhere else. In each site below, `const c = new Database(P, { readonly: true }); try { BODY } finally { c.close(); }` becomes `return readCopyOf(P, (c) => { BODY });` (without `return` where the block returns nothing), and `const check = new Database(P, { readonly: true }); ...; check.close();` becomes `readCopyOf(P, (check) => { ... });`. Add `import { readCopyOf } from "../../src/db/read-copy.ts";` (`"../src/db/read-copy.ts"` in `test/migrate.test.ts`), and remove the `bun:sqlite` import where no other use of `Database` is left.

- `test/lifecycle/e2e-interrupt.test.ts`: `dbRows` (line 170; its comment says "read through a connection of its own", now "read through a private copy"), `stepRow` (222), `dispatchRows` (242), and the in place check in `resume` (562: `readCopyOf(run.dbPath, (c) => expect(getLatestWorktreePath(c, run.ticketId)).toBe(run.repo));`). The file uses `Database` as a type elsewhere (lines 300, 754, 771): keep the import as `import type { Database } from "bun:sqlite";` (line 25).
- `test/lifecycle/interruption.test.ts`: `rowAfterResume` (907). The file keeps `Database` for its writers.
- `test/lifecycle/terminal.test.ts`: `interruptions` (358). Remove the import (line 10).
- `test/lifecycle/signals.test.ts`: `notes` (152) and the three `check` connections (306, 330, 361). The run's own writer `db` is open during these reads; the copy takes its `-wal` and `-shm` too, so it sees what the writer committed. The file keeps `Database` for its writers.
- `test/cli/run-pr-base.test.ts`: `recordedDefaultBranch` (13). The file keeps `Database`.
- `test/migrate.test.ts`: `creates the core SoT tables` (41). Remove the import (line 1).

- [ ] **Step 5: Run the test and see it pass**

Run: `perl -e 'alarm 600; exec @ARGV' bun test test/cli/checkpoint-readers-fixtures.test.ts test/cli/ls.test.ts test/cli/clean.test.ts test/cli/checkpoints.test.ts test/lifecycle/interruption.test.ts test/lifecycle/e2e-interrupt.test.ts test/lifecycle/terminal.test.ts test/lifecycle/signals.test.ts test/cli/run-pr-base.test.ts test/migrate.test.ts`
Expected: PASS, and the preload reports nothing left in the run's temp root.

- [ ] **Step 6: Break it on purpose, see it fail, restore**

In `listCheckpointRunningSteps`, add `, generation` to the selected columns (a column that only exists from v9). Run Step 5's command: every `narrow running step read` case fails with `no such column: generation`, and the `--fresh` cases report `could not read`. Restore. In `cleanImpl`, delete the `assertCheckpointName("ident", ...)` and `assertCheckpointName("slug", ...)` calls: `clean refuses an ident or slug that is not a valid folder name` fails on its `--all` cases (`--all` builds no checkpoint path, so it returns normally instead of exiting 64); the other cases still give 64, through `checkpointPath` at `clean.ts:151`. Restore. In `refuseUnusableCheckpoint`, list every worktree `listWorktrees` reports instead of the candidates: `clean refuses an unreadable effort (exit 65) ...` fails (the repository itself and the worktrees of another shape are listed). Restore. Add a line `rm -r ${where.dir}` to the recovery: the same test fails (no shell command may be printed). Restore. In `checkpointPath`, delete the two name checks: the `parkDir` loop of `styre run checks --slug ...` fails, since `parkDir("..", "ENG-1")` now throws the second check's error (`leaves`) instead of `not a valid slug`, and `--resume refuses an ident or slug ...` fails (no case exits 64: a name either finds the `run.db` the test placed and the inspection returns, or leads outside the state root and meets the second check's plain `Error`). Restore. In `checkpointNameProblem`, treat a slug as one folder name (refuse `/` in it): `a nested slug (team/app) works ...` fails at the fresh run (78: the harness passes `--profile`, so `assertProfileSlug` refuses it). Restore. In `listCheckpoints`, follow nested folders below the slug (list `<root>/team/app/ENG-2` as slug `team/app`): `ls and clean --all reach the folders they reach today` fails (the nested checkpoint is listed, and `clean --all --slug team/app` reaps it). Restore. In `loadRunProfile`, delete its calls: `styre run checks --slug ...` fails (`--slug ..` loads `<config>/profile.json`; `team/..` and `/abs` reach no profile and throw a plain `Error` with no code; the profile whose own slug is `..` loads instead of giving 78). Restore. In `runSetup`, delete its two calls: `styre setup refuses a slug ...` fails (the setup agent runs and throws, with no 64). Restore. In `setupBody`, delete the `assertCheckpointName("slug", effSlug)` call: `styre setup checks --slug and a derived slug itself ...` fails (the stubbed agent CLI check runs and throws, with no 64; checked on an export). Restore. In `listCheckpoints`, report a refused schema as `unreadable`: the three `... is listed as such, never as damaged` cases fail. Restore. Then, in `resumeRun`'s inspect block, put the 2026-10-09 revision back: wrap `process.stderr.write(inspectWithoutUpgrading(...)); return;` in `if (state.kind !== "current") {...}` and restore today's inspect block at `park.ts:299-305`, so a current checkpoint goes through `migrate`, `openDb` and `markResumed`: `--resume --inspect on a current checkpoint made by a fresh run changes nothing in its folder` fails on the folder's digests (`run.db` and `-wal` change; checked on an export of the plan), and at this task so do the v8 fixture cases. Restore. (After Task 4 no committed fixture is current, which is why that test makes its checkpoint with a real fresh run.) (Deleting the inspect block outright is not a break to try: the resume would then go on to the agent CLI preflight with nothing injected.)

- [ ] **Step 7: Commit**

```bash
git add src/db/repos/checkpoint-read.ts src/cli/checkpoints.ts src/cli/checkpoint-name.ts src/cli/clean.ts src/cli/ls.ts src/cli/park.ts src/cli/load-profile.ts src/cli/errors.ts src/cli/setup.ts test/helpers/run-harness.ts src/util/process/interruption.ts test/cli/checkpoint-readers-fixtures.test.ts test/lifecycle/e2e-interrupt.test.ts test/lifecycle/interruption.test.ts test/lifecycle/terminal.test.ts test/lifecycle/signals.test.ts test/cli/run-pr-base.test.ts test/migrate.test.ts
git commit -m "fix(eng-477): read checkpoints for ls, clean and --fresh with queries that work since v7" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: v8 → v9: the new columns, tables and the `origin` backfill

**Files:**
- Create: `src/db/migrations/0009-design-inputs.ts`
- Modify: `src/db/migrations/index.ts` (add `migration0009`), `src/db/schema.sql` and `docs/architecture/schema.sql` (seed row lines 53-55; `work_unit` before line 160 `UNIQUE (ticket_id, seq)`; `workflow_step` before line 194 `UNIQUE (ticket_id, step_key)`; two new tables after `run`)
- Modify: `src/db/repos/workflow-step.ts:4-27`, `src/db/repos/work-unit.ts:4-79`, `src/daemon/failure-policy.ts:210-217`
- Modify: `test/helpers/check-probes.ts` (v9 seeds and probes), `test/db/migrate-upgrade.test.ts` and `test/db/schema-shape.test.ts` (use the v9 lists), `test/migrate.test.ts:12-58`, `test/migrate-cli.test.ts:9,24-25` (it pins `schema v8`)
- Modify: `CLAUDE.md:34`
- Test: `test/db/migrate-v9.test.ts`, `test/db/read-only-guard.test.ts` (the source guard for the private copy ruling; here, the task after Task 3's last conversion)

**Interfaces:**
- Consumes: `Migration`, `MIGRATIONS`, `CURRENT_VERSION`, `migrate`, `proveSchema` (Task 2); fixtures (Task 1).
- Produces:
  - `migration0009: Migration`
  - `WorkflowStepRow` gains `input_manifest: string | null; input_fingerprint: string | null; output_digest: string | null; fingerprint_scheme: number | null; generation: number`
  - `WorkUnitRow` gains `origin: WorkUnitOrigin` where `type WorkUnitOrigin = "extract" | "reconcile"`; `insertWorkUnit` accepts `origin?: WorkUnitOrigin` (default `"extract"`)
  - tables `ticket_input (ticket_id, name, value_json, digest, captured_at)` and `workflow_step_history`
  - test helper: `SEED_ROWS_V9`, `CHECK_PROBES_V9`

- [ ] **Step 1: Write the failing test**

```ts
// test/db/migrate-v9.test.ts
import { expect, test } from "bun:test";
import { migrate } from "../../src/db/migrate.ts";
import { CURRENT_VERSION } from "../../src/db/migrations/index.ts";
import { readCopyOf } from "../../src/db/read-copy.ts";
import { insertWorkUnit, listByTicket } from "../../src/db/repos/work-unit.ts";
import { MIGRATABLE_FIXTURES, copyFixture } from "../helpers/db-fixtures.ts";
import { makeTestDb } from "../helpers/db.ts";

test("the current version is 9", () => {
  expect(CURRENT_VERSION).toBe(9);
});

for (const name of MIGRATABLE_FIXTURES) {
  test(`${name}: origin is backfilled from kind = 'reconcile', manifests are empty, generation 0`, () => {
    const path = copyFixture(name);
    migrate(path);
    readCopyOf(path, (db) => {
      const units = db
        .query<{ kind: string; origin: string }, []>(
          "SELECT kind, origin FROM work_unit ORDER BY seq",
        )
        .all();
      expect(units).toEqual([
        { kind: "backend", origin: "extract" },
        { kind: "reconcile", origin: "reconcile" },
      ]);
      const steps = db
        .query<{ m: string | null; g: number }, []>(
          "SELECT input_manifest AS m, generation AS g FROM workflow_step",
        )
        .all();
      expect(steps.every((s) => s.m === null && s.g === 0)).toBe(true);
      expect(db.query("SELECT COUNT(*) AS n FROM ticket_input").get()).toEqual({ n: 0 });
      expect(db.query("SELECT COUNT(*) AS n FROM workflow_step_history").get()).toEqual({ n: 0 });
    });
  });
}

test("insertWorkUnit records origin, defaulting to extract", () => {
  const { db, ticketId } = makeTestDb();
  insertWorkUnit(db, { ticketId, seq: 1, kind: "backend" });
  insertWorkUnit(db, { ticketId, seq: 2, kind: "reconcile", origin: "reconcile" });
  expect(listByTicket(db, ticketId).map((u) => u.origin)).toEqual(["extract", "reconcile"]);
  db.close();
});
```

- [ ] **Step 2: Run it and see it fail**

Run: `perl -e 'alarm 600; exec @ARGV' bun test test/db/migrate-v9.test.ts`
Expected: FAIL: `expect(CURRENT_VERSION).toBe(9)` receives `8`.

- [ ] **Step 3: Write the migration**

```ts
// src/db/migrations/0009-design-inputs.ts
import type { Migration } from "./types.ts";

// Each statement is the exact column or table text schema.sql v9 declares, so the structural proof
// compares equal. Added columns land last, in this order (spec §7.3).
export const TICKET_INPUT_DDL = `CREATE TABLE ticket_input (
    ticket_id   INTEGER NOT NULL REFERENCES ticket(id) ON DELETE CASCADE,
    name        TEXT    NOT NULL,
    value_json  TEXT    NOT NULL CHECK (json_valid(value_json)),
    digest      TEXT    NOT NULL,
    captured_at TEXT    NOT NULL,
    PRIMARY KEY (ticket_id, name)
)`;

export const STEP_HISTORY_DDL = `CREATE TABLE workflow_step_history (
    id                 INTEGER PRIMARY KEY,
    step_id            INTEGER NOT NULL REFERENCES workflow_step(id) ON DELETE CASCADE,
    ticket_id          INTEGER NOT NULL REFERENCES ticket(id) ON DELETE CASCADE,
    event_id           INTEGER NOT NULL REFERENCES event_log(id) ON DELETE CASCADE,
    step_key           TEXT    NOT NULL,
    status             TEXT    NOT NULL,
    attempt            INTEGER NOT NULL,
    result_json        TEXT,
    error_json         TEXT,
    input_manifest     TEXT,
    input_fingerprint  TEXT,
    output_digest      TEXT,
    fingerprint_scheme INTEGER,
    generation         INTEGER NOT NULL,
    started_at         TEXT,
    ended_at           TEXT,
    archived_at        TEXT    NOT NULL
)`;
export const STEP_HISTORY_INDEX =
  "CREATE INDEX idx_step_history_step ON workflow_step_history (step_id, generation)";

/** v8 → v9 (ENG-477, spec §7.4): only added columns and new tables; event_log is not rebuilt. */
export const migration0009: Migration = {
  version: 9,
  note: "v9: design input fingerprints, work_unit.origin, ticket_input, workflow_step_history (ENG-477)",
  up(db) {
    db.exec(
      "ALTER TABLE workflow_step ADD COLUMN input_manifest TEXT CHECK (input_manifest IS NULL OR json_valid(input_manifest))",
    );
    db.exec("ALTER TABLE workflow_step ADD COLUMN input_fingerprint TEXT");
    db.exec("ALTER TABLE workflow_step ADD COLUMN output_digest TEXT");
    db.exec("ALTER TABLE workflow_step ADD COLUMN fingerprint_scheme INTEGER");
    db.exec("ALTER TABLE workflow_step ADD COLUMN generation INTEGER NOT NULL DEFAULT 0");
    db.exec(
      "ALTER TABLE work_unit ADD COLUMN origin TEXT NOT NULL DEFAULT 'extract' CHECK (origin IN ('extract','reconcile'))",
    );
    // The integration failure path (failure-policy.ts) is the only writer of kind 'reconcile'.
    db.exec("UPDATE work_unit SET origin = 'reconcile' WHERE kind = 'reconcile'");
    db.exec(TICKET_INPUT_DDL);
    db.exec(STEP_HISTORY_DDL);
    db.exec(STEP_HISTORY_INDEX);
  },
};
```

`src/db/migrations/index.ts`: `import { migration0009 } from "./0009-design-inputs.ts";` and `export const MIGRATIONS: readonly Migration[] = [migration0008, migration0009];`.

- [ ] **Step 4: Update both schema copies**

In `src/db/schema.sql`:

Seed row (lines 53-55):

```sql
INSERT INTO schema_meta (version, applied_at, note)
VALUES (9, strftime('%Y-%m-%dT%H:%M:%SZ','now'),
        'v9: design input fingerprints, work_unit.origin, ticket_input, workflow_step_history (ENG-477)');
```

`work_unit`, after `updated_at        TEXT NOT NULL,` and before `UNIQUE (ticket_id, seq)`:

```sql
    -- v9 (ENG-477): which step wrote the unit. 'reconcile' units come from the integration
    -- failure path and stay out of design:extract's output digest. Added last (0009).
    origin            TEXT NOT NULL DEFAULT 'extract' CHECK (origin IN ('extract','reconcile')),
```

`workflow_step`, after `updated_at      TEXT NOT NULL,` and before `UNIQUE (ticket_id, step_key)`:

```sql
    -- v9 (ENG-477, design input invalidation): what a design step's success was computed from.
    -- input_manifest maps each declared input to its digest; output_digest is set only where the
    -- output lives outside the database (the plan); generation counts invalidations. Added last,
    -- in migration order (0009), so the structural proof holds.
    input_manifest     TEXT CHECK (input_manifest IS NULL OR json_valid(input_manifest)),
    input_fingerprint  TEXT,
    output_digest      TEXT,
    fingerprint_scheme INTEGER,
    generation         INTEGER NOT NULL DEFAULT 0,
```

After the `run` table (before the `§H DERIVED VIEWS` banner):

```sql
-- ----------------------------------------------------------------------------
-- ticket_input — the design inputs that are not already rows (ENG-477, spec §4): the ticket
-- text and the starting commit (written once, never rewritten), and the profile and config
-- values the design handlers receive (rewritten on resume, with an `inputs-changed` note).
-- value_json is canonical JSON; digest is its SHA-256.
-- ----------------------------------------------------------------------------
CREATE TABLE ticket_input (
    ticket_id   INTEGER NOT NULL REFERENCES ticket(id) ON DELETE CASCADE,
    name        TEXT    NOT NULL,
    value_json  TEXT    NOT NULL CHECK (json_valid(value_json)),
    digest      TEXT    NOT NULL,
    captured_at TEXT    NOT NULL,
    PRIMARY KEY (ticket_id, name)
);

-- workflow_step_history — a design step's row as it was before an invalidation reset it
-- (ENG-477, spec §6). event_id is the `invalidated` note event that caused the reset.
CREATE TABLE workflow_step_history (
    id                 INTEGER PRIMARY KEY,
    step_id            INTEGER NOT NULL REFERENCES workflow_step(id) ON DELETE CASCADE,
    ticket_id          INTEGER NOT NULL REFERENCES ticket(id) ON DELETE CASCADE,
    event_id           INTEGER NOT NULL REFERENCES event_log(id) ON DELETE CASCADE,
    step_key           TEXT    NOT NULL,
    status             TEXT    NOT NULL,
    attempt            INTEGER NOT NULL,
    result_json        TEXT,
    error_json         TEXT,
    input_manifest     TEXT,
    input_fingerprint  TEXT,
    output_digest      TEXT,
    fingerprint_scheme INTEGER,
    generation         INTEGER NOT NULL,
    started_at         TEXT,
    ended_at           TEXT,
    archived_at        TEXT    NOT NULL
);
CREATE INDEX idx_step_history_step ON workflow_step_history (step_id, generation);
```

Then: `cp src/db/schema.sql docs/architecture/schema.sql && cmp src/db/schema.sql docs/architecture/schema.sql && grep -c '^CREATE TABLE' src/db/schema.sql`
Expected: `19`.

`CLAUDE.md:34`, replace the first two sentences with: `4. **`schema.sql`** — the SQLite SoT: **19 `CREATE TABLE` statements** (`grep -c '^CREATE TABLE'`). `memory_record` (Memory/UGL) is a commented-out `-- DEFERRED` stub, not one of the 19;` and keep the rest of the line, then add after "`run` (ENG-349) is the per-invocation identity table and is live" the clause `; `ticket_input` and `workflow_step_history` (ENG-477) hold the design inputs and the rows an invalidation replaced`.

- [ ] **Step 5: Grow the repositories**

`src/db/repos/workflow-step.ts`: add to `WorkflowStepRow` after `updated_at: string;`:

```ts
  /** JSON map from each declared input to its digest at the step's success (ENG-477). */
  input_manifest: string | null;
  input_fingerprint: string | null;
  /** Digest of an output that lives outside the database (the plan). */
  output_digest: string | null;
  fingerprint_scheme: number | null;
  /** Incremented by each invalidation (0 for a new step). */
  generation: number;
```

and `COLS`:

```ts
const COLS =
  "id, ticket_id, work_unit_id, seq, step_key, step_type, status, attempt, idempotency_key, " +
  "input_json, result_json, error_json, pid, await_signal_id, started_at, ended_at, created_at, updated_at, " +
  "input_manifest, input_fingerprint, output_digest, fingerprint_scheme, generation";
```

`src/db/repos/work-unit.ts`: add `export type WorkUnitOrigin = "extract" | "reconcile";`, `origin: WorkUnitOrigin;` to `WorkUnitRow`, `, origin` at the end of `COLS`, `origin?: WorkUnitOrigin;` to `insertWorkUnit`'s parameter, and in its INSERT:

```ts
      `INSERT INTO work_unit
         (ticket_id, seq, kind, title, description, status, behavioral, files_to_touch, test_plan, verify_check_types, depends_on, origin, created_at, updated_at)
       VALUES ($t, $seq, $kind, $title, $desc, $status, $behavioral, $ftt, $tp, $vct, $dep, $origin, $now, $now)`,
```

with `$origin: p.origin ?? "extract",` in the bound values.

`src/daemon/failure-policy.ts:210-217`: add `origin: "reconcile",` to the `insertWorkUnit` call.

- [ ] **Step 6: Grow the CHECK probes and the existing migration tests**

Append to `test/helpers/check-probes.ts`:

```ts
export const SEED_ROWS_V9: string[] = [
  ...SEED_ROWS_V8,
  "INSERT INTO ticket_input (ticket_id, name, value_json, digest, captured_at) VALUES (900, 'probe', '1', 'd', 't')",
  "INSERT INTO workflow_step_history (id, step_id, ticket_id, event_id, step_key, status, attempt, generation, archived_at) VALUES (900, 900, 900, 900, 'probe', 'succeeded', 1, 0, 't')",
];

export const CHECK_PROBES_V9: CheckProbe[] = [
  ...CHECK_PROBES_V8,
  { table: "workflow_step", set: "input_manifest = 'x'", where: "id = 900" },
  { table: "work_unit", set: "origin = 'manual'", where: "id = 900" },
  { table: "ticket_input", set: "value_json = 'x'", where: "ticket_id = 900 AND name = 'probe'" },
];
```

In `test/db/migrate-upgrade.test.ts` and `test/db/schema-shape.test.ts`, replace every `SEED_ROWS_V8` with `SEED_ROWS_V9` and every `CHECK_PROBES_V8` with `CHECK_PROBES_V9`. In `test/migrate.test.ts`, import `CURRENT_VERSION` from `../src/db/migrations/index.ts`, replace both `toBe(8)` with `toBe(CURRENT_VERSION)`, rename the first test to `bootstraps a fresh DB at the current schema version`, and add `"ticket_input"` and `"workflow_step_history"` to `CORE_TABLES`.

In `test/migrate-cli.test.ts` (it runs `styre migrate` and pins the version it prints): import `CURRENT_VERSION` from `../src/db/migrations/index.ts`; rename the test (line 9) to ``"`styre migrate --db <path>` exits 0 and reports the current schema version on stderr (stdout stays empty)"``; lines 24-25 become `expect(err).toContain(`schema v${CURRENT_VERSION}`);` and `expect(out).not.toContain(`schema v${CURRENT_VERSION}`);`. Its `Bun.spawn` child has no time limit of its own: right after the spawn add `ownChild(proc);` (import `ownChild` from `./helpers/own-processes.ts`, so the preload's end of run check sees it) and `const timer = setTimeout(() => proc.kill("SIGKILL"), 60_000);`, add `clearTimeout(timer);` after `await proc.exited`, and pass `60_000` as the test's timeout.

- [ ] **Step 6b: The source guard for read only opens (operator ruling, 2026-10-09)**

Task 3 converted the last read only open. From here a source guard holds the class: no file in `src/` or `test/` may open a database read only, except `src/db/read-copy.ts` (which opens its private copy, read write) and the stated exceptions.

```ts
// test/db/read-only-guard.test.ts
import { expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/** Operator ruling (2026-10-09, spec §7.7): a database that must not change is read through
 *  readCopyOf (src/db/read-copy.ts), never by opening it read only. These files may, each for the
 *  reason given. The guard is against a read only open coming back by accident: it reads the source
 *  text, so a spelling it does not list (a quoted key, a flag held in a variable, numeric open
 *  flags, `immutable=1`) passes it, and an exception covers its whole file. */
const EXCEPTIONS: Record<string, string> = {
  "test/db/migrate-upgrade.test.ts":
    "the second connection that holds a read snapshot while the backup runs: the scenario under test, on a private copy",
  "test/db/read-only-guard.test.ts": "this guard names the patterns it refuses",
};
const PATTERNS = [/readonly:\s*true/, /[?&]mode=ro\b/, /SQLITE_OPEN_READONLY/];
const ROOT = join(import.meta.dir, "..", "..");

function sourceFiles(top: string): string[] {
  return (readdirSync(join(ROOT, top), { recursive: true }) as string[])
    .filter((f) => f.endsWith(".ts"))
    .map((f) => join(top, f));
}

test("no file in src/ or test/ opens a database read only, except the stated ones", () => {
  const offences: string[] = [];
  for (const file of [...sourceFiles("src"), ...sourceFiles("test")]) {
    if (file in EXCEPTIONS) continue;
    const text = readFileSync(join(ROOT, file), "utf8");
    for (const p of PATTERNS) if (p.test(text)) offences.push(`${file}: ${p.source}`);
  }
  expect(offences).toEqual([]);
});

test("every stated exception still needs its exception", () => {
  for (const file of Object.keys(EXCEPTIONS)) {
    const text = readFileSync(join(ROOT, file), "utf8");
    expect([file, PATTERNS.some((p) => p.test(text))]).toEqual([file, true]);
  }
});
```

Break it: put back one read only open (for example `new Database(path, { readonly: true })` in `test/migrate.test.ts`'s core tables test): the first test fails naming the file. Restore.

- [ ] **Step 7: Run the tests and see them pass**

Run: `perl -e 'alarm 600; exec @ARGV' bun test test/db test/migrate.test.ts test/migrate-cli.test.ts test/cli/checkpoint-readers-fixtures.test.ts`
Expected: PASS, including every fixture reaching v9 with the proof and 50 CHECK probes, and `styre migrate` reporting `schema v9`.

- [ ] **Step 8: Break it on purpose, see it fail, restore**

1. In `schema.sql` (both copies), move the five new `workflow_step` columns to sit before `pid`. Run Step 7: every fixture fails the proof with `table workflow_step: columns differ`. Restore.
2. Delete the `UPDATE work_unit SET origin = 'reconcile' ...` line. Run Step 7: the backfill tests fail. Restore.

- [ ] **Step 9: Run the whole suite**

Run: `perl -e 'alarm 600; exec @ARGV' bun test`
Expected: PASS. Typecheck and lint pass.

- [ ] **Step 10: Commit**

```bash
git add src/db test/helpers/check-probes.ts test/db test/migrate.test.ts test/migrate-cli.test.ts docs/architecture/schema.sql src/daemon/failure-policy.ts CLAUDE.md
git commit -m "feat(eng-477): schema v9 with design input fingerprints, ticket_input and step history" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Canonical encoding and digests

**Files:**
- Create: `src/daemon/canonical.ts`
- Test: `test/daemon/canonical.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `FINGERPRINT_SCHEME = 1`, `canonicalJson(value: unknown): string`, `sha256Hex(text: string): string`, `digestValue(value: unknown): string`.

- [ ] **Step 1: Write the failing test**

```ts
// test/daemon/canonical.test.ts
import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { canonicalJson, digestValue, sha256Hex } from "../../src/daemon/canonical.ts";

test("object key order does not change the encoding; keys come out sorted", () => {
  const a = canonicalJson({ b: 1, a: { d: 2, c: 3 } });
  const b = canonicalJson({ a: { c: 3, d: 2 }, b: 1 });
  expect(a).toBe(b);
  expect(a).toBe('{"a":{"c":3,"d":2},"b":1}');
});

test("keys that look like integers are sorted as strings, not in JavaScript's own key order", () => {
  expect(canonicalJson({ "9": "x", "10": "y" })).toBe('{"10":"y","9":"x"}');
});

test("strings and keys are normalised to NFC", () => {
  // Escapes, so no editor or copy can normalise the two spellings into one.
  const composed = "caf\u00e9";
  const decomposed = "cafe\u0301";
  expect(composed).not.toBe(decomposed);
  expect(canonicalJson({ [decomposed]: decomposed })).toBe(canonicalJson({ [composed]: composed }));
});

test("undefined members are dropped and null is kept", () => {
  expect(canonicalJson({ a: undefined, b: null })).toBe('{"b":null}');
});

test("array order is meaningful and kept", () => {
  expect(canonicalJson([2, 1])).not.toBe(canonicalJson([1, 2]));
});

test("values that have no canonical form are refused loudly", () => {
  expect(() => canonicalJson({ n: Number.NaN })).toThrow("non-finite");
  expect(() => canonicalJson({ d: new Date(0) })).toThrow("unsupported");
  expect(() => canonicalJson({ m: new Map() })).toThrow("unsupported");
  expect(() => canonicalJson([undefined])).toThrow("undefined");
  expect(() => canonicalJson({ b: 1n })).toThrow("unsupported");
});

test("digestValue is the SHA-256 of the canonical encoding", () => {
  const v = { z: [1, "a"], a: true };
  expect(digestValue(v)).toBe(createHash("sha256").update(canonicalJson(v), "utf8").digest("hex"));
  expect(sha256Hex("x")).toHaveLength(64);
});
```

- [ ] **Step 2: Run it and see it fail**

Run: `perl -e 'alarm 600; exec @ARGV' bun test test/daemon/canonical.test.ts`
Expected: FAIL with `Cannot find module '../../src/daemon/canonical.ts'`.

- [ ] **Step 3: Write the encoding**

```ts
// src/daemon/canonical.ts
import { createHash } from "node:crypto";

/** The version of everything a recorded digest depends on (spec §5.1): this encoding, how the
 *  profile and config are parsed (their defaults included), what each table step declares, and how
 *  each output is digested. A manifest recorded under an older scheme counts as changed (operator
 *  ruling, 2026-10-09): the step reruns the next time the run is in design. Bump it deliberately in
 *  a release that changes any of those; test/daemon/fingerprint-pin.test.ts fails until the bump
 *  and a new pin are made. */
export const FINGERPRINT_SCHEME = 1;

function write(v: unknown, path: string): string {
  if (v === null) return "null";
  if (typeof v === "string") return JSON.stringify(v.normalize("NFC"));
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "number") {
    if (!Number.isFinite(v)) throw new Error(`canonicalJson: non-finite number at ${path}`);
    return JSON.stringify(v);
  }
  if (Array.isArray(v)) {
    return `[${v
      .map((x, i) => {
        if (x === undefined)
          throw new Error(`canonicalJson: undefined array element at ${path}[${i}]`);
        return write(x, `${path}[${i}]`);
      })
      .join(",")}]`;
  }
  if (typeof v === "object") {
    const proto = Object.getPrototypeOf(v);
    if (proto !== Object.prototype && proto !== null)
      throw new Error(`canonicalJson: unsupported object at ${path}`);
    const entries = Object.keys(v as object)
      .filter((k) => (v as Record<string, unknown>)[k] !== undefined)
      .map((k) => [k.normalize("NFC"), (v as Record<string, unknown>)[k]] as const)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    for (let i = 1; i < entries.length; i++) {
      if (entries[i][0] === entries[i - 1][0])
        throw new Error(`canonicalJson: two keys normalise to "${entries[i][0]}" at ${path}`);
    }
    return `{${entries.map(([k, x]) => `${JSON.stringify(k)}:${write(x, `${path}.${k}`)}`).join(",")}}`;
  }
  throw new Error(`canonicalJson: unsupported ${typeof v} at ${path}`);
}

/** JSON with object keys sorted and every string normalised to NFC (spec §5.1). Built by hand, so
 *  keys that look like integers are not reordered by JavaScript. Throws on anything JSON cannot say exactly. */
export function canonicalJson(value: unknown): string {
  return write(value, "$");
}

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export function digestValue(value: unknown): string {
  return sha256Hex(canonicalJson(value));
}
```

- [ ] **Step 4: Run it and see it pass**

Run: `perl -e 'alarm 600; exec @ARGV' bun test test/daemon/canonical.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Break it on purpose, see it fail, restore**

Remove `.sort(...)` from the object branch: the key order and integer key tests fail. Restore. Remove both `.normalize("NFC")` calls: the NFC test fails. Restore.

- [ ] **Step 6: Commit**

```bash
git add src/daemon/canonical.ts test/daemon/canonical.test.ts
git commit -m "feat(eng-477): canonical JSON encoding and SHA-256 digests for design inputs" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: The declared design table and its rules

**Files:**
- Create: `src/daemon/design-graph.ts`
- Test: `test/daemon/design-graph.test.ts`

The table's fields come from the handlers and their prompt variable functions, read for this plan:
- `provision` (`handlers.ts:1341-1505`): `deps.profile.components` (loop, `planProvision`, and `environmentGate` at the end), `deps.unusableComponents`, `deps.nonPrimaryComponents`.
- `design:dispatch` (`handlers.ts:526-541`): `environmentGate` reads `deps.profile.components`; `designVars` (`prompt-vars.ts:104-120`) reads `ticket.ident`, `ticket.title`, `ticket.description`, `profile.slug`, `profile.components` (detected stacks), `profile.promptVars`, `profile.runtimeContext`; feedback from `designFeedback`.
- `design:extract` (`handlers.ts:543-588`): `extractVars` (`prompt-vars.ts:90-102`) reads `ticket.ident`, `ticket.title`, `profile.slug`, `profile.components`, `profile.promptVars`, `profile.runtimeContext`; `validateExtraction(units, profile.components)`; `validateCdotImpact(output, profile)` reads `profile.runtimeContext` (`extract-schema.ts:62-98`). The plan is read by the agent from the worktree.
- `design:size` (`handlers.ts:590-615`): `ctx.config.complexityGrading`; the units; with grading on, `complexityGradeVars` (`prompt-vars.ts:205-218`) reads `ticket.ident`, `ticket.title`, `profile.slug`, `profile.promptVars`, and the grader reads the plan.
- `design:review` (`handlers.ts:617-661`): `designReviewVars` (`prompt-vars.ts:220-248`) reads `ticket.ident`, `ticket.title`, `profile.slug`, `profile.promptVars`, the units; the reviewer reads the plan. It does NOT read `ticket.description` (the spec's table says it does; the code is authoritative per spec §3, see the hand off notes).
- `ticket.ident` is read by every handler for dispatch ids and the branch name; the recording proxy treats it as infrastructure (Task 15). It stays declared for `design:extract`, as the spec lists it.

**Interfaces:**
- Consumes: `StyreError`, `EXIT` (`src/cli/errors.ts`); `TicketRow` (`src/db/repos/ticket.ts`).
- Produces:
  - `SNAPSHOT_INPUT_NAMES` (readonly tuple) and `type SnapshotInputName` = `"ticket.ident" | "ticket.title" | "ticket.description" | "profile.slug" | "profile.promptVars" | "profile.runtimeContext" | "profile.components" | "run.unusableComponents" | "run.nonPrimaryComponents" | "config.complexityGrading"`
  - `TICKET_TEXT_INPUTS: readonly SnapshotInputName[]` (`ticket.ident`, `ticket.title`, `ticket.description`)
  - `type OutputName = "plan" | "workUnits" | "track" | "planFindings"`, `type InputName = SnapshotInputName | OutputName`
  - `type DesignStepKey = "provision" | "design:dispatch" | "design:extract" | "design:size" | "design:review"`
  - `interface InputContext { complexityGrading: boolean }`
  - `interface StepRow { kind: "step"; stepKey: DesignStepKey; stepType: string; handlerKey: string; appliesWhen: (t: Pick<TicketRow, "track">) => boolean; inputs: (c: InputContext) => readonly InputName[]; feedback: readonly string[]; produces: readonly OutputName[]; fileOutput: boolean }`
  - `interface GateRow { kind: "gate"; name: "plan-review"; appliesWhen: (t: Pick<TicketRow, "track">) => boolean; reads: readonly OutputName[]; reason: string; signature: string; stepKey: DesignStepKey }`
  - `type DesignRow = StepRow | GateRow`, `DESIGN_TABLE: readonly DesignRow[]`
  - `checkDesignTable(table: readonly DesignRow[]): string[]`, `assertDesignTable(table?: readonly DesignRow[]): void` (throws `DesignTableError`, exit 70), `ensureDesignTableChecked(): void`, `class DesignTableError extends StyreError`
  - `designRouting(table: readonly DesignRow[]): DesignStepKey[]`, `stepRow(stepKey: string): StepRow | undefined`, `isTableStep(stepKey: string): stepKey is DesignStepKey`, `declaresInput(stepKey: string, name: InputName): boolean` (true when declared under either value of `complexityGrading`), `isSnapshotInput(name: string): name is SnapshotInputName`

- [ ] **Step 1: Write the failing test**

```ts
// test/daemon/design-graph.test.ts
import { expect, test } from "bun:test";
import { EXIT } from "../../src/cli/errors.ts";
import {
  DESIGN_TABLE,
  type DesignRow,
  DesignTableError,
  type InputName,
  type StepRow,
  assertDesignTable,
  checkDesignTable,
  declaresInput,
  designRouting,
} from "../../src/daemon/design-graph.ts";

const steps = (t: readonly DesignRow[]) => t.filter((r): r is StepRow => r.kind === "step");
const replace = (key: string, patch: Partial<StepRow>): DesignRow[] =>
  DESIGN_TABLE.map((r) => (r.kind === "step" && r.stepKey === key ? { ...r, ...patch } : r));

test("the shipped table satisfies every rule", () => {
  expect(checkDesignTable(DESIGN_TABLE)).toEqual([]);
});

test("rule 1 refuses an input that is neither a snapshot input nor an earlier output", () => {
  const bad = replace("design:extract", { inputs: () => ["ghost" as InputName] });
  expect(checkDesignTable(bad).join("\n")).toMatch(/rule 1: design:extract reads ghost/);
});

test("rule 2 refuses an output with two producers", () => {
  const bad = replace("design:extract", { produces: ["workUnits", "plan"] });
  expect(checkDesignTable(bad).join("\n")).toMatch(
    /rule 2: plan is produced by design:dispatch and design:extract/,
  );
});

test("rule 3 refuses a step that reads what a later step produces", () => {
  const bad = replace("design:extract", { inputs: () => ["plan", "track"] });
  expect(checkDesignTable(bad).join("\n")).toMatch(
    /rule 3: design:extract reads track, produced later by design:size/,
  );
});

test("rule 4 refuses a step listed twice; the routing is the step rows in table order", () => {
  const dup = [...DESIGN_TABLE, steps(DESIGN_TABLE)[1]];
  expect(checkDesignTable(dup).join("\n")).toMatch(/rule 4: design:dispatch appears twice/);
  expect(designRouting(DESIGN_TABLE)).toEqual([
    "provision",
    "design:dispatch",
    "design:extract",
    "design:size",
    "design:review",
  ]);
});

test("a failed assertion is a StyreError with exit 70 naming the rule and the steps", () => {
  const bad = replace("design:size", { produces: ["track", "workUnits"] });
  try {
    assertDesignTable(bad);
    throw new Error("expected a refusal");
  } catch (err) {
    expect(err).toBeInstanceOf(DesignTableError);
    expect((err as DesignTableError).code).toBe(EXIT.INTERNAL);
    expect(String((err as DesignTableError).detail)).toContain("design:size");
  }
});

test("design:size declares the plan only when grading is on, and declaresInput sees both", () => {
  const size = steps(DESIGN_TABLE).find((r) => r.stepKey === "design:size") as StepRow;
  expect(size.inputs({ complexityGrading: false })).not.toContain("plan");
  expect(size.inputs({ complexityGrading: true })).toContain("plan");
  expect(declaresInput("design:size", "plan")).toBe(true);
  expect(declaresInput("design:dispatch", "workUnits")).toBe(false);
  expect(declaresInput("checks:dispatch", "workUnits")).toBe(false);
});
```

- [ ] **Step 2: Run it and see it fail**

Run: `perl -e 'alarm 600; exec @ARGV' bun test test/daemon/design-graph.test.ts`
Expected: FAIL with `Cannot find module '../../src/daemon/design-graph.ts'`.

- [ ] **Step 3: Write the table**

```ts
// src/daemon/design-graph.ts
import { EXIT, StyreError } from "../cli/errors.ts";
import type { TicketRow } from "../db/repos/ticket.ts";

/** Inputs Styre hands a design step that are not rows of an earlier step (spec §4). */
export const SNAPSHOT_INPUT_NAMES = [
  "ticket.ident",
  "ticket.title",
  "ticket.description",
  "profile.slug",
  "profile.promptVars",
  "profile.runtimeContext",
  "profile.components",
  "run.unusableComponents",
  "run.nonPrimaryComponents",
  "config.complexityGrading",
] as const;
export type SnapshotInputName = (typeof SNAPSHOT_INPUT_NAMES)[number];

/** Fixed for the life of a run (E2): written once, never rewritten. */
export const TICKET_TEXT_INPUTS: readonly SnapshotInputName[] = [
  "ticket.ident",
  "ticket.title",
  "ticket.description",
];

export type OutputName = "plan" | "workUnits" | "track" | "planFindings";
export type InputName = SnapshotInputName | OutputName;
export type DesignStepKey =
  | "provision"
  | "design:dispatch"
  | "design:extract"
  | "design:size"
  | "design:review";

export interface InputContext {
  complexityGrading: boolean;
}

export interface StepRow {
  kind: "step";
  stepKey: DesignStepKey;
  stepType: string;
  handlerKey: string;
  appliesWhen: (t: Pick<TicketRow, "track">) => boolean;
  /** What Styre hands the step, plus the upstream outputs it reads. */
  inputs: (c: InputContext) => readonly InputName[];
  /** Routed backwards on a loopback event; never fingerprinted (spec §6.7). */
  feedback: readonly string[];
  produces: readonly OutputName[];
  /** True when the output lives outside the database (the plan), so its digest is recorded. */
  fileOutput: boolean;
}

export interface GateRow {
  kind: "gate";
  name: "plan-review";
  appliesWhen: (t: Pick<TicketRow, "track">) => boolean;
  reads: readonly OutputName[];
  reason: string;
  signature: string;
  stepKey: DesignStepKey;
}

export type DesignRow = StepRow | GateRow;

const always = (): boolean => true;
const fullTrack = (t: Pick<TicketRow, "track">): boolean => t.track === "full";

/** The design stage, in order (spec §3). The resolver's design routing is generated from it. After
 *  its last row the resolver continues with today's checks routing, unchanged (E9). */
export const DESIGN_TABLE: readonly DesignRow[] = [
  {
    kind: "step",
    stepKey: "provision",
    stepType: "provision",
    handlerKey: "provision",
    appliesWhen: always,
    inputs: () => ["profile.components", "run.unusableComponents", "run.nonPrimaryComponents"],
    feedback: [],
    produces: [],
    fileOutput: false,
  },
  {
    kind: "step",
    stepKey: "design:dispatch",
    stepType: "dispatch",
    handlerKey: "design:dispatch",
    appliesWhen: always,
    inputs: () => [
      "ticket.title",
      "ticket.description",
      "profile.slug",
      "profile.promptVars",
      "profile.runtimeContext",
      "profile.components",
    ],
    feedback: ["design loopback findings"],
    produces: ["plan"],
    fileOutput: true,
  },
  {
    kind: "step",
    stepKey: "design:extract",
    stepType: "dispatch",
    handlerKey: "design:extract",
    appliesWhen: always,
    inputs: () => [
      "ticket.ident",
      "ticket.title",
      "profile.slug",
      "profile.promptVars",
      "profile.runtimeContext",
      "profile.components",
      "plan",
    ],
    feedback: [],
    produces: ["workUnits"],
    fileOutput: false,
  },
  {
    kind: "step",
    stepKey: "design:size",
    stepType: "dispatch",
    handlerKey: "design:size",
    appliesWhen: always,
    inputs: (c) =>
      c.complexityGrading
        ? [
            "config.complexityGrading",
            "workUnits",
            "ticket.title",
            "profile.slug",
            "profile.promptVars",
            "plan",
          ]
        : ["config.complexityGrading", "workUnits"],
    feedback: [],
    produces: ["track"],
    fileOutput: false,
  },
  {
    kind: "step",
    stepKey: "design:review",
    stepType: "dispatch",
    handlerKey: "design:review",
    appliesWhen: fullTrack, // ENG-478's D11 widens this
    inputs: () => ["ticket.title", "profile.slug", "profile.promptVars", "plan", "workUnits"],
    feedback: [],
    produces: ["planFindings"],
    fileOutput: false,
  },
  {
    kind: "gate",
    name: "plan-review",
    appliesWhen: fullTrack,
    reads: ["planFindings"],
    reason: "unresolved plan-review findings",
    signature: "review:unresolved-plan",
    stepKey: "design:review",
  },
];

export class DesignTableError extends StyreError {
  constructor(violations: string[]) {
    super({
      code: EXIT.INTERNAL,
      headline: "the declared design table breaks its own rules",
      detail: violations.join("\n"),
      recovery: "This is a Styre defect; report it with the lines above.",
    });
    this.name = "DesignTableError";
  }
}

const isSnapshot = (n: string): n is SnapshotInputName =>
  (SNAPSHOT_INPUT_NAMES as readonly string[]).includes(n);
export const isSnapshotInput = isSnapshot;

const CONTEXTS: readonly InputContext[] = [
  { complexityGrading: false },
  { complexityGrading: true },
];

/** The four rules of spec §3.1. Returns one line per violation. */
export function checkDesignTable(table: readonly DesignRow[]): string[] {
  const out: string[] = [];
  const stepRows = table.filter((r): r is StepRow => r.kind === "step");
  const producer = new Map<OutputName, { key: DesignStepKey; index: number }>();
  stepRows.forEach((r, index) => {
    for (const o of r.produces) {
      const prior = producer.get(o);
      if (prior) out.push(`rule 2: ${o} is produced by ${prior.key} and ${r.stepKey}`);
      else producer.set(o, { key: r.stepKey, index });
    }
  });
  stepRows.forEach((r, index) => {
    const read = new Set(CONTEXTS.flatMap((c) => r.inputs(c)));
    for (const n of read) {
      if (isSnapshot(n)) continue;
      const p = producer.get(n as OutputName);
      if (!p)
        out.push(
          `rule 1: ${r.stepKey} reads ${n}, which is neither a snapshot input nor an output`,
        );
      else if (p.index >= index)
        out.push(`rule 3: ${r.stepKey} reads ${n}, produced later by ${p.key}`);
    }
  });
  for (const g of table.filter((r): r is GateRow => r.kind === "gate")) {
    for (const n of g.reads)
      if (!producer.has(n)) out.push(`rule 1: gate ${g.name} reads ${n}, which no step produces`);
  }
  // Rule 4: the routing is `designRouting(table)`, the step rows in table order, so order holds by
  // construction (spec §3.1); what can still go wrong is a step listed twice.
  const seen = new Set<string>();
  for (const r of stepRows) {
    if (seen.has(r.stepKey)) out.push(`rule 4: ${r.stepKey} appears twice in the routing`);
    seen.add(r.stepKey);
  }
  return out;
}

/** The design routing the walk follows: the step rows, in table order. */
export function designRouting(table: readonly DesignRow[]): DesignStepKey[] {
  return table.filter((r): r is StepRow => r.kind === "step").map((r) => r.stepKey);
}

export function assertDesignTable(table: readonly DesignRow[] = DESIGN_TABLE): void {
  const violations = checkDesignTable(table);
  if (violations.length > 0) throw new DesignTableError(violations);
}

let checked = false;
/** Asserted when the table is first used in a process (spec §3.1). */
export function ensureDesignTableChecked(): void {
  if (checked) return;
  assertDesignTable();
  checked = true;
}

export function stepRow(stepKey: string): StepRow | undefined {
  return DESIGN_TABLE.find((r): r is StepRow => r.kind === "step" && r.stepKey === stepKey);
}

export function isTableStep(stepKey: string): stepKey is DesignStepKey {
  return stepRow(stepKey) !== undefined;
}

export function declaresInput(stepKey: string, name: InputName): boolean {
  const row = stepRow(stepKey);
  return row !== undefined && CONTEXTS.some((c) => row.inputs(c).includes(name));
}
```

- [ ] **Step 4: Run it and see it pass**

Run: `perl -e 'alarm 600; exec @ARGV' bun test test/daemon/design-graph.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Break it on purpose, see it fail, restore**

In `checkDesignTable`, change `else if (p.index >= index)` to `else if (false)`. The rule 3 test fails. Restore.

- [ ] **Step 6: Commit**

```bash
git add src/daemon/design-graph.ts test/daemon/design-graph.test.ts
git commit -m "feat(eng-477): the declared design table and its four rules" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: The snapshot (`ticket_input`), the starting commit, and the design test harnesses

**Files:**
- Create: `src/db/repos/ticket-input.ts`, `src/daemon/design-inputs.ts`
- Create: `test/helpers/design-script.ts`, `test/helpers/design-steps.ts`, `test/helpers/design-harness.ts`
- Modify: `src/daemon/run-ticket.ts:214-252` (`runTicket` takes `inputs` and captures the snapshot, of its own ticket and of every other active ticket of a reused `--db`: operator ruling, 2026-10-10)
- Modify: `src/db/repos/ticket.ts` (add `listActiveTickets` after `getByIdent`, line 80)
- Modify: `src/cli/run.ts:338,441-477` (`RunDeps.probe`, in-place starting commit, `inputs`, `recordStartingCommit`), `src/cli/run.ts:166` (`RunDeps`)
- Modify: `src/dispatch/handlers.ts:175-196` (`RegistryDeps.recordStartingCommit`), `src/dispatch/handlers.ts:1341-1343` (provision records the worktree starting commit)
- Modify: `src/cli/park.ts:445-453` (snapshot after `recover()`), `src/cli/run.ts:292-297` (pass `probe` into `resumeDeps`)
- Modify: `test/helpers/db.ts` (as PR #154 rewrote it: capture a default snapshot), `test/cli/run-e2e.test.ts:40-47,88-96`, `test/daemon/run-ticket.test.ts:465` (pass `inputs`)
- Test: `test/daemon/design-inputs.test.ts`, `test/cli/snapshot-e2e.test.ts`

**Interfaces:**
- Consumes: `canonicalJson`, `sha256Hex` (Task 5); `SNAPSHOT_INPUT_NAMES`, `SnapshotInputName`, `TICKET_TEXT_INPUTS` (Task 6); `ticket_input` table (Task 4).
- Produces:
  - repo: `interface TicketInputRow { ticket_id: number; name: string; value_json: string; digest: string; captured_at: string }`, `getInput(db, ticketId, name): TicketInputRow | null`, `listInputs(db, ticketId): TicketInputRow[]`, `insertInputIfAbsent(db, row: TicketInputRow): boolean`, `upsertInput(db, row: TicketInputRow): void`
  - `listActiveTickets(db: Database): TicketRow[]` in `src/db/repos/ticket.ts` (status `active`, by id)
  - `STARTING_COMMIT_INPUT = "run.startingCommit"`
  - `interface SnapshotSources { profile: Profile; unusableComponents: readonly UnusableComponent[]; nonPrimaryComponents: readonly NonPrimaryComponent[]; config: Pick<RuntimeConfig, "complexityGrading"> }`
  - `interface RunInputs extends SnapshotSources { startingCommit: string | null }`
  - `snapshotValues(ticket: Pick<TicketRow, "ident" | "title" | "description">, s: SnapshotSources): Record<SnapshotInputName, unknown>`
  - `captureSnapshot(db, ticketId, sources: SnapshotSources): { changed: SnapshotInputName[] }`
  - `recordStartingCommit(db, ticketId, sha: string): boolean`, `startingCommit(db, ticketId): string | null`
  - `snapshotDigest(db, ticketId, name: SnapshotInputName): string`, `snapshotValue(db, ticketId, name: SnapshotInputName): unknown`, `requireSnapshot(db, ticketId): void`
  - `runTicket(deps)` gains the required field `inputs: RunInputs`; `RunDeps.probe?: (repoDir: string, command: string) => boolean`; `RegistryDeps.recordStartingCommit?: boolean`
  - test helpers: `ScriptStep`, `ScriptUnit`, `ScriptFinding`, `DesignScript`, `ScriptCalls`, `newCalls()`, `defaultScript(overrides)`, `unitsOf(n, { behavioral, dir?, ext?, titleSuffix? })`, `sidecar(value)`, `scriptedRunner(script, calls)`, `stepOfPrompt(prompt)`, `ABSENT_RC`, `harnessProfileRaw(repo, slug?)`; `gitRepo(prefix?)`, `git(cwd, args)`, `DesignTicket`, `makeDesignTicket(opts)` (options `script`, `profile`, `config`, and `repoSetup?: (repo: string) => void`, run on the new repository before anything else), `driveUntil(t, stop, maxSteps?)`, `atStep(key)`, `STEP_TEST_TIMEOUT_MS = 30_000` (every test that drives design steps passes it as its bun test timeout: the steps run git); `class DesignHarness` (constructor `(mode?: "worktree" | "in-place", opts?: { slug?: string; repoDir?: string })`) with `fresh(opts?)`, `resume(opts?)` (`opts.inspect` for `--inspect`), `editProfile(fn)`, `editConfig(fn)`, `read(fn)`, `readAt(path, fn)`, `dbPath()`, `checkpointDir()`, `probe`, `stderr`, `calls`, `trackerCalls` (the fake tracker's calls during the last invocation), `cleanup()`; `HARNESS_TEST_TIMEOUT_MS = 60_000` (every test that drives the harness passes it as its timeout: each run starts git children)
  - `TEST_PROFILE` exported from `test/helpers/db.ts`

- [ ] **Step 1: Write the test helpers**

```ts
// test/helpers/design-script.ts
import { appendFileSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { FakeAgentRunner } from "../../src/agent/fake-runner.ts";
import type { AgentRunInput, AgentRunResult } from "../../src/agent/runner.ts";

/** The agent steps a design run can reach, recognised by the first line of their prompt template. */
export const SCRIPT_STEPS = [
  "design:dispatch",
  "design:extract",
  "design:size",
  "design:review",
  "checks:dispatch",
  "implement",
  "review",
] as const;
export type ScriptStep = (typeof SCRIPT_STEPS)[number];

const MARKERS: ReadonlyArray<readonly [string, ScriptStep]> = [
  ["You are designing ticket", "design:dispatch"],
  ["You are extracting the work breakdown", "design:extract"],
  ["You are grading the COMPLEXITY", "design:size"],
  ["You are the independent plan reviewer", "design:review"],
  ["You are authoring acceptance checks", "checks:dispatch"],
  ["You are implementing work-unit", "implement"],
  ["You are the independent code reviewer", "review"],
];

export function stepOfPrompt(prompt: string): ScriptStep {
  for (const [marker, step] of MARKERS) if (prompt.includes(marker)) return step;
  throw new Error(`design script: unrecognised prompt: ${prompt.slice(0, 120)}`);
}

export interface ScriptUnit {
  seq: number;
  kind: string;
  title: string;
  description: string;
  behavioral: boolean;
  test_plan: string | null;
  files_to_touch: string[];
  verify_check_types: string[];
  depends_on: number[];
}

export interface ScriptFinding {
  severity: "critical" | "major" | "minor" | "nit";
  category: string;
  location: string | null;
  rationale: string;
  factors: null;
  deferral_candidate: boolean;
  work_unit_seq: number | null;
}

export interface DesignScript {
  ident: string;
  /** Plan body for the n-th design:dispatch call (1-based, counted across the whole harness). */
  plan: (call: number) => string;
  /** Plan file name under docs/plans/ for the n-th call. */
  planFile: (call: number) => string;
  /** Remove the other docs/plans/*.md files first, so a new planFile is a rename. */
  renamePlan: boolean;
  units: (call: number) => ScriptUnit[];
  grade: (call: number) => number;
  planFindings: (call: number) => ScriptFinding[];
  /** This step gets a session-limit result: on the `parkOnCall`-th call (counted across the
   *  harness), or, when that is null, on the first prompt of the step that reaches this runner. */
  parkAt: ScriptStep | null;
  parkOnCall: number | null;
}

export interface ScriptCalls {
  counts: Record<ScriptStep, number>;
  prompts: Array<{ step: ScriptStep; prompt: string }>;
}

export function newCalls(): ScriptCalls {
  return {
    counts: Object.fromEntries(SCRIPT_STEPS.map((s) => [s, 0])) as Record<ScriptStep, number>,
    prompts: [],
  };
}

/** `n` units. Behavioural units carry their own test file (validateExtraction requires it), so the
 *  checks step finds work it cannot verify and pauses the run (`needs_you`) right after design. */
export function unitsOf(
  n: number,
  opts: { behavioral: boolean; dir?: string; ext?: string; titleSuffix?: string },
): ScriptUnit[] {
  const dir = opts.dir ?? "lib";
  const ext = opts.ext ?? "rb";
  return Array.from({ length: n }, (_, i) => {
    const seq = i + 1;
    const code = `${dir}/u${seq}.${ext}`;
    const test = ext === "rb" ? `test/u${seq}_test.rb` : `${dir}/u${seq}.test.${ext}`;
    return {
      seq,
      kind: "backend",
      title: `Unit ${seq}${opts.titleSuffix ?? ""}`,
      description: `Change ${seq}`,
      behavioral: opts.behavioral,
      test_plan: opts.behavioral ? `${test} asserts change ${seq}` : null,
      files_to_touch: opts.behavioral ? [code, test] : [code],
      verify_check_types: opts.behavioral ? ["test"] : [],
      depends_on: [],
    };
  });
}

export function defaultScript(overrides: Partial<DesignScript> = {}): DesignScript {
  return {
    ident: "ENG-1",
    plan: () => "Plan body, version 1",
    planFile: () => "eng-1-plan.md",
    renamePlan: false,
    units: () => unitsOf(2, { behavioral: true }),
    grade: () => 6,
    planFindings: () => [],
    parkAt: null,
    parkOnCall: null,
    ...overrides,
  };
}

export const sidecar = (value: unknown): string =>
  `Done.\n\n\`\`\`styre-sidecar\n${JSON.stringify(value)}\n\`\`\`\n`;

/** Every CDOT section addressed and none applying, so extraction passes `validateCdotImpact` under
 *  any runtime context, including a profile that leaves it at its default (`unknown` presence,
 *  which requires an analysis). `documentation.applies` is false, so `needs_docs` stays 0. */
export const ADDRESSED_CDOT = {
  data: { applies: false, analysis: "not affected", schemaChange: false },
  caching: { applies: false, analysis: "not affected" },
  observability: { applies: false, analysis: "not affected" },
  configSecrets: { applies: false, analysis: "not affected" },
  documentation: { applies: false, analysis: "not affected" },
};

const ok = (stdout: string): AgentRunResult => ({
  completed: true,
  exitCode: 0,
  stdout,
  stderr: "",
  timedOut: false,
  costUsd: null,
  tokensIn: null,
  tokensOut: null,
});

const sessionLimit = (): AgentRunResult => ({
  completed: false,
  exitCode: 1,
  stdout: "partial output written before the session limit",
  stderr: "You have reached your session limit · resets tomorrow",
  timedOut: false,
  costUsd: null,
  tokensIn: null,
  tokensOut: null,
  cause: "session-limit",
  resetAt: "tomorrow",
});

/** A FakeAgentRunner that plays each design step from `script` and counts every call in `calls`. */
export function scriptedRunner(script: DesignScript, calls: ScriptCalls): FakeAgentRunner {
  let parked = false;
  return new FakeAgentRunner((input: AgentRunInput) => {
    const step = stepOfPrompt(input.prompt);
    calls.counts[step] += 1;
    calls.prompts.push({ step, prompt: input.prompt });
    const n = calls.counts[step];
    if (
      script.parkAt === step &&
      (script.parkOnCall === null ? !parked : n === script.parkOnCall)
    ) {
      parked = true;
      return sessionLimit();
    }
    switch (step) {
      case "design:dispatch": {
        const plans = join(input.cwd, "docs", "plans");
        mkdirSync(plans, { recursive: true });
        if (script.renamePlan) {
          for (const f of readdirSync(plans)) if (f.endsWith(".md")) rmSync(join(plans, f));
        }
        writeFileSync(
          join(plans, script.planFile(n)),
          `---\nlinear: ${script.ident}\n---\n\n${script.plan(n)}\n`,
        );
        return ok("Plan written.");
      }
      case "design:extract":
        return ok(sidecar({ units: script.units(n), cdotImpact: ADDRESSED_CDOT }));
      case "design:size":
        return ok(
          sidecar({
            dimensions: { coupling: 0, blast_radius: 0, difficulty: 0 },
            overall: script.grade(n),
          }),
        );
      case "design:review":
        return ok(sidecar({ findings: script.planFindings(n) }));
      case "implement": {
        const seq = Number(input.prompt.match(/You are implementing work-unit (\d+)/)?.[1]);
        const unit = script
          .units(Math.max(1, calls.counts["design:extract"]))
          .find((u) => u.seq === seq);
        if (!unit) throw new Error(`design script: no unit ${seq} to implement`);
        const created: string[] = [];
        for (const f of unit.files_to_touch) {
          const p = join(input.cwd, f);
          if (existsSync(p)) appendFileSync(p, `# implement call ${n}\n`);
          else {
            mkdirSync(dirname(p), { recursive: true });
            writeFileSync(p, `# unit ${seq}, implement call ${n}\n`);
            created.push(f);
          }
        }
        return ok(sidecar({ new_files: created }));
      }
      case "review":
        return ok(sidecar({ findings: [] }));
      case "checks:dispatch":
        throw new Error(
          "design script: checks:dispatch is not scripted (no runnable check framework)",
        );
    }
  });
}

export const ABSENT_RC = {
  topology: { type: "cli" },
  data: { presence: "absent" },
  caching: { presence: "absent" },
  observability: { presence: "absent" },
  configSecrets: { presence: "absent" },
  documentation: { presence: "absent" },
  releasePackaging: { mechanism: "none" },
};

/** One Ruby component whose commands are `true`: provision installs nothing, the toolchain probe
 *  passes, and no check framework resolves, so behavioural work pauses at checks:dispatch. */
export function harnessProfileRaw(repo: string, slug = "harness"): Record<string, unknown> {
  return {
    slug,
    targetRepo: repo,
    defaultBranch: "main",
    checksSystem: "none",
    components: [
      {
        name: "app",
        kind: "ruby",
        paths: ["**"],
        commands: { build: "true", test: "true", check: "true" },
      },
    ],
    promptVars: { stack: "ruby" },
    runtimeContext: ABSENT_RC,
  };
}
```

```ts
// test/helpers/design-steps.ts
import type { Database } from "bun:sqlite";
import { realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_AGENT_CONFIG } from "../../src/config/agent-config.ts";
import { DEFAULT_RUNTIME_CONFIG, type RuntimeConfig } from "../../src/config/runtime-config.ts";
import { advanceOneStep } from "../../src/daemon/advance.ts";
import { captureSnapshot } from "../../src/daemon/design-inputs.ts";
import { type StepDescriptor, nextStepKey } from "../../src/daemon/resolver.ts";
import type { StepRegistry } from "../../src/daemon/step-registry.ts";
import { openDb } from "../../src/db/client.ts";
import { migrate } from "../../src/db/migrate.ts";
import { insertProject } from "../../src/db/repos/project.ts";
import { insertRun } from "../../src/db/repos/run.ts";
import { insertTicket } from "../../src/db/repos/ticket.ts";
import { buildDispatchRegistry } from "../../src/dispatch/handlers.ts";
import { type Profile, parseProfile } from "../../src/dispatch/profile.ts";
import { nowUtc } from "../../src/util/time.ts";
import {
  type DesignScript,
  type ScriptCalls,
  defaultScript,
  harnessProfileRaw,
  newCalls,
  scriptedRunner,
} from "./design-script.ts";
import { makeTempDir } from "./temp.ts";

/** Every test that drives design steps passes this as its bun test timeout: the steps run git. */
export const STEP_TEST_TIMEOUT_MS = 30_000;

/** git with a time limit: the child is stopped by its own handle if it hangs. */
export function git(cwd: string, args: string[]): string {
  const r = Bun.spawnSync(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    timeout: 30_000,
  });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
  return r.stdout.toString().trim();
}

/** A repository with one commit, in a temp folder removed when the test ends. */
export function gitRepo(prefix = "styre-ds-repo-"): string {
  const root = realpathSync(makeTempDir(prefix));
  git(root, ["init", "-q", "-b", "main"]);
  git(root, ["config", "user.email", "t@s.dev"]);
  git(root, ["config", "user.name", "T"]);
  writeFileSync(join(root, "README.md"), "x\n");
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "-m", "init"]);
  return root;
}

/** A ticket in a migrated database, with its snapshot captured and the real dispatch registry over
 *  a scripted fake agent. Steps run only through advanceOneStep. */
export interface DesignTicket {
  db: Database;
  ticketId: number;
  repo: string;
  worktreeRoot: string;
  profile: Profile;
  config: RuntimeConfig;
  script: DesignScript;
  calls: ScriptCalls;
  registry: StepRegistry;
}

export function makeDesignTicket(
  opts: {
    script?: Partial<DesignScript>;
    profile?: (repo: string) => Record<string, unknown>;
    config?: Partial<RuntimeConfig>;
    /** Runs on the new repository before anything else (a .gitignore, say). */
    repoSetup?: (repo: string) => void;
  } = {},
): DesignTicket {
  const repo = gitRepo();
  opts.repoSetup?.(repo);
  const dbPath = join(makeTempDir("styre-ds-db-"), "run.db");
  migrate(dbPath);
  const db = openDb(dbPath);
  const profile = parseProfile((opts.profile ?? harnessProfileRaw)(repo));
  const projectId = insertProject(db, {
    slug: profile.slug,
    targetRepo: repo,
    defaultBranch: "main",
  });
  const ticketId = insertTicket(db, {
    projectId,
    ident: "ENG-1",
    title: "Design ticket",
    description: "Design body",
    typeLabel: "Feature",
    branchPrefix: "feat",
  });
  insertRun(db, { runId: "design-steps-run", startedAt: nowUtc(), provider: "claude" });
  const config: RuntimeConfig = { ...DEFAULT_RUNTIME_CONFIG, ...opts.config };
  captureSnapshot(db, ticketId, {
    profile,
    unusableComponents: [],
    nonPrimaryComponents: [],
    config,
  });
  const calls = newCalls();
  const script = defaultScript({ ident: "ENG-1", ...opts.script });
  const worktreeRoot = makeTempDir("styre-ds-wt-");
  const registry = buildDispatchRegistry({
    runner: scriptedRunner(script, calls),
    agentConfig: DEFAULT_AGENT_CONFIG,
    profile,
    worktreeRoot,
  });
  return { db, ticketId, repo, worktreeRoot, profile, config, script, calls, registry };
}

/** Advance until `stop` holds for the next descriptor (checked before each step). */
export async function driveUntil(
  t: Pick<DesignTicket, "db" | "ticketId" | "registry" | "config">,
  stop: (d: StepDescriptor) => boolean,
  maxSteps = 40,
): Promise<StepDescriptor> {
  for (let i = 0; i < maxSteps; i++) {
    const d = nextStepKey(t.db, t.ticketId);
    if (stop(d)) return d;
    await advanceOneStep(t.db, t.ticketId, t.registry, { config: t.config });
  }
  throw new Error(`driveUntil: no stop after ${maxSteps} steps`);
}

export const atStep =
  (stepKey: string) =>
  (d: StepDescriptor): boolean =>
    d.kind === "step" && d.stepKey === stepKey;
```

```ts
// test/helpers/design-harness.ts
import type { Database } from "bun:sqlite";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { StyreError } from "../../src/cli/errors.ts";
import { parkDir } from "../../src/cli/park.ts";
import { type RunArgs, runImpl } from "../../src/cli/run.ts";
import { readCopyOf } from "../../src/db/read-copy.ts";
import { fakeForge } from "../../src/integrations/adapters/fake-forge.ts";
import { fakeIssueTracker } from "../../src/integrations/adapters/fake-issue-tracker.ts";
import {
  type DesignScript,
  type ScriptCalls,
  defaultScript,
  harnessProfileRaw,
  newCalls,
  scriptedRunner,
} from "./design-script.ts";
import { gitRepo } from "./design-steps.ts";
import { makeTempDir, trackTempEntriesMadeBy } from "./temp.ts";

export type HostProbe = (repoDir: string, command: string) => boolean;

/** Every test that drives the harness passes this as its bun test timeout: each run starts git
 *  children (each bounded by its own 30 s limit) and drives the whole run in process. */
export const HARNESS_TEST_TIMEOUT_MS = 60_000;

export interface HarnessRunOptions {
  script?: Partial<DesignScript>;
  /** `styre run --db <path>` (a reused database). */
  db?: string;
  acceptHead?: boolean;
  /** `styre run --resume <ticket> --inspect`. */
  inspect?: boolean;
  /** What the tracker would say now; resume must never ask it (E2). */
  trackerTitle?: string;
}

/** The whole `styre run` and `styre run --resume`, through runImpl, with a scripted agent, fake
 *  tracker and forge, a profile and a config file the test can edit between runs, and the host's
 *  tools decided by `probe`. Every call sets XDG_STATE_HOME and XDG_CONFIG_HOME to this harness's
 *  own folders and restores them after. Its folders are made with makeTempDir, and the
 *  `styre-wt-*` worktree root each run keeps is tracked, so nothing outlives the test. Resume more
 *  than once only in "in-place" mode, unless the run committed on the recreated branch in between:
 *  in worktree mode each resume recreates the ticket branch from the target repository's checked
 *  out HEAD (`git worktree add -B`, ENG-488), which moves HEAD, so the next resume is refused
 *  (exit 65) while no dispatch has recorded the new HEAD (hand off note 10). */
export class DesignHarness {
  readonly stateRoot = makeTempDir("styre-dh-state-");
  readonly configRoot = makeTempDir("styre-dh-config-");
  readonly filesRoot = makeTempDir("styre-dh-files-");
  readonly repoDir: string;
  readonly profilePath = join(this.filesRoot, "profile.json");
  readonly configPath = join(this.filesRoot, "config.json");
  readonly calls: ScriptCalls = newCalls();
  readonly ident = "ENG-1";
  readonly slug: string;
  probe: HostProbe = () => true;
  stderr: string[] = [];
  /** The fake tracker's calls during the last invocation (E2: a resume makes no `fetchTicket`). */
  trackerCalls: Array<{ method: string; args: unknown[] }> = [];
  private profileRaw: Record<string, unknown>;
  private configRaw: Record<string, unknown> = { complexityGrading: false };

  /** `opts.repoDir` adopts an existing repository (a restored recording); `opts.slug` names the
   *  project, which keys the checkpoint folder. */
  constructor(
    readonly mode: "worktree" | "in-place" = "worktree",
    opts: { slug?: string; repoDir?: string } = {},
  ) {
    this.slug = opts.slug ?? "harness";
    this.repoDir = opts.repoDir ?? gitRepo("styre-dh-repo-");
    this.profileRaw = harnessProfileRaw(this.repoDir, this.slug);
    if (mode === "in-place") {
      writeFileSync(join(this.repoDir, ".styre-disposable"), "");
      writeFileSync(join(this.repoDir, ".git", "info", "exclude"), ".styre-disposable\n");
    }
    this.write();
  }

  private write(): void {
    writeFileSync(this.profilePath, JSON.stringify(this.profileRaw, null, 2));
    writeFileSync(this.configPath, JSON.stringify(this.configRaw, null, 2));
  }

  editProfile(fn: (raw: Record<string, unknown>) => void): void {
    fn(this.profileRaw);
    this.write();
  }

  editConfig(fn: (raw: Record<string, unknown>) => void): void {
    fn(this.configRaw);
    this.write();
  }

  private withEnv<T>(fn: () => T): T {
    const prev = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = this.stateRoot;
    try {
      return fn();
    } finally {
      if (prev === undefined) Reflect.deleteProperty(process.env, "XDG_STATE_HOME");
      else process.env.XDG_STATE_HOME = prev;
    }
  }

  checkpointDir(): string {
    return this.withEnv(() => parkDir(this.slug, this.ident));
  }

  dbPath(): string {
    return join(this.checkpointDir(), "run.db");
  }

  read<T>(fn: (db: Database, ticketId: number) => T): T {
    return this.readAt(this.dbPath(), fn);
  }

  readAt<T>(path: string, fn: (db: Database, ticketId: number) => T): T {
    return readCopyOf(path, (db) => {
      const t = db.query<{ id: number }, []>("SELECT id FROM ticket ORDER BY id LIMIT 1").get();
      if (!t) throw new Error(`harness: no ticket in ${path}`);
      return fn(db, t.id);
    });
  }

  async fresh(opts: HarnessRunOptions = {}): Promise<number> {
    return this.invoke(
      {
        ticket: this.ident,
        ...(opts.db ? { db: opts.db } : {}),
        ...(this.mode === "in-place" ? { "in-place": true } : {}),
      },
      opts,
    );
  }

  async resume(opts: HarnessRunOptions = {}): Promise<number> {
    return this.invoke(
      {
        resume: this.ident,
        ...(opts.acceptHead ? { "accept-head": true } : {}),
        ...(opts.inspect ? { inspect: true } : {}),
      },
      opts,
    );
  }

  private async invoke(args: Partial<RunArgs>, opts: HarnessRunOptions): Promise<number> {
    const script = defaultScript({ ident: this.ident, ...opts.script });
    const runner = scriptedRunner(script, this.calls);
    const issueTracker = fakeIssueTracker({
      ticket: {
        ident: this.ident,
        title: opts.trackerTitle ?? "Harness ticket",
        description: "Harness body",
        typeLabel: "Feature",
        externalId: "uuid-harness",
        url: null,
      },
    });
    this.trackerCalls = issueTracker.calls;
    const ports = { issueTracker, forge: fakeForge() };
    const prev = {
      state: process.env.XDG_STATE_HOME,
      config: process.env.XDG_CONFIG_HOME,
      telemetry: process.env.STYRE_TELEMETRY,
      exit: process.exitCode ?? 0,
      cwd: process.cwd(),
      write: process.stderr.write,
    };
    process.env.XDG_STATE_HOME = this.stateRoot;
    process.env.XDG_CONFIG_HOME = this.configRoot;
    process.env.STYRE_TELEMETRY = "0";
    process.stderr.write = ((chunk: unknown) => {
      this.stderr.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    if (args["in-place"]) process.chdir(this.repoDir); // in-place discovers the repo from the cwd
    try {
      process.exitCode = 0;
      // runImpl and resume keep the run's styre-wt-* worktree root (also in place): tracked here.
      await trackTempEntriesMadeBy("styre-wt-", () =>
        runImpl(
          { args: { profile: this.profilePath, config: this.configPath, ...args } },
          { ports, runner, preflight: () => ({ ok: true, version: null }), probe: this.probe },
        ),
      );
      return Number(process.exitCode ?? 0);
    } catch (err) {
      if (err instanceof StyreError) return err.code;
      throw err;
    } finally {
      process.stderr.write = prev.write;
      process.chdir(prev.cwd);
      process.exitCode = prev.exit;
      const restore = (k: string, v: string | undefined) => {
        if (v === undefined) Reflect.deleteProperty(process.env, k);
        else process.env[k] = v;
      };
      restore("XDG_STATE_HOME", prev.state);
      restore("XDG_CONFIG_HOME", prev.config);
      restore("STYRE_TELEMETRY", prev.telemetry);
    }
  }

  /** Optional: the folders are removed when the test ends anyway (makeTempDir). */
  cleanup(): void {
    for (const d of [this.stateRoot, this.configRoot, this.filesRoot, this.repoDir])
      rmSync(d, { recursive: true, force: true });
  }
}
```

- [ ] **Step 2: Write the failing tests**

```ts
// test/daemon/design-inputs.test.ts
import { expect, test } from "bun:test";
import { SNAPSHOT_INPUT_NAMES } from "../../src/daemon/design-graph.ts";
import {
  captureSnapshot,
  recordStartingCommit,
  requireSnapshot,
  startingCommit,
} from "../../src/daemon/design-inputs.ts";
import { listByTicket as listEvents } from "../../src/db/repos/event-log.ts";
import { insertProject } from "../../src/db/repos/project.ts";
import { getInput, listInputs } from "../../src/db/repos/ticket-input.ts";
import { insertTicket, setTicketStage } from "../../src/db/repos/ticket.ts";
import { makeTestDb } from "../helpers/db.ts";
import { STEP_TEST_TIMEOUT_MS, makeDesignTicket } from "../helpers/design-steps.ts";

const sources = (t: ReturnType<typeof makeDesignTicket>, promptVars = t.profile.promptVars) => ({
  profile: { ...t.profile, promptVars },
  unusableComponents: [],
  nonPrimaryComponents: [],
  config: t.config,
});
const notes = (t: ReturnType<typeof makeDesignTicket>) =>
  listEvents(t.db, t.ticketId).filter((e) => e.reason === "inputs-changed");

test(
  "the first capture writes every declared input and the ticket text, with no note",
  () => {
    const t = makeDesignTicket();
    expect(
      listInputs(t.db, t.ticketId)
        .map((r) => r.name)
        .sort(),
    ).toEqual([...SNAPSHOT_INPUT_NAMES].sort());
    expect(JSON.parse(getInput(t.db, t.ticketId, "ticket.title")?.value_json ?? "null")).toBe(
      "Design ticket",
    );
    expect(notes(t)).toEqual([]);
  },
  STEP_TEST_TIMEOUT_MS,
);

test(
  "an unchanged capture changes nothing",
  () => {
    const t = makeDesignTicket();
    const before = listInputs(t.db, t.ticketId);
    expect(captureSnapshot(t.db, t.ticketId, sources(t)).changed).toEqual([]);
    expect(listInputs(t.db, t.ticketId)).toEqual(before);
    expect(notes(t)).toEqual([]);
  },
  STEP_TEST_TIMEOUT_MS,
);

test(
  "a changed profile field is rewritten and named in one inputs-changed note",
  () => {
    const t = makeDesignTicket();
    const old = getInput(t.db, t.ticketId, "profile.promptVars")?.digest;
    const r = captureSnapshot(t.db, t.ticketId, sources(t, { stack: "ruby", extra: "1" }));
    expect(r.changed).toEqual(["profile.promptVars"]);
    expect(getInput(t.db, t.ticketId, "profile.promptVars")?.digest).not.toBe(old);
    const [note] = notes(t);
    expect(JSON.parse(note.payload_json ?? "{}")).toMatchObject({
      event: "inputs-changed",
      names: ["profile.promptVars"],
      pastDesign: false,
    });
  },
  STEP_TEST_TIMEOUT_MS,
);

test(
  "past design, the note says the change takes effect the next time the run is in design (E6)",
  () => {
    const t = makeDesignTicket();
    setTicketStage(t.db, t.ticketId, "implement");
    captureSnapshot(t.db, t.ticketId, sources(t, { stack: "other" }));
    const payload = JSON.parse(notes(t)[0].payload_json ?? "{}");
    expect(payload.pastDesign).toBe(true);
    expect(payload.message).toContain("next time the run is in design");
  },
  STEP_TEST_TIMEOUT_MS,
);

test(
  "the starting commit is written once and never rewritten",
  () => {
    const t = makeDesignTicket();
    expect(recordStartingCommit(t.db, t.ticketId, "aaa")).toBe(true);
    expect(recordStartingCommit(t.db, t.ticketId, "bbb")).toBe(false);
    expect(startingCommit(t.db, t.ticketId)).toBe("aaa");
  },
  STEP_TEST_TIMEOUT_MS,
);

test(
  "requireSnapshot names the inputs a ticket is missing",
  () => {
    const { db } = makeTestDb({ seedTicket: false });
    const projectId = insertProject(db, { slug: "p", targetRepo: "/tmp/x" });
    const ticketId = insertTicket(db, { projectId, ident: "ENG-2" });
    expect(() => requireSnapshot(db, ticketId)).toThrow("profile.components");
    db.close();
  },
  STEP_TEST_TIMEOUT_MS,
);
```

```ts
// test/cli/snapshot-e2e.test.ts
import { afterEach, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { SNAPSHOT_INPUT_NAMES } from "../../src/daemon/design-graph.ts";
import { startingCommit } from "../../src/daemon/design-inputs.ts";
import { openDb } from "../../src/db/client.ts";
import { migrate } from "../../src/db/migrate.ts";
import { listByTicket as listEvents } from "../../src/db/repos/event-log.ts";
import { insertProject } from "../../src/db/repos/project.ts";
import { getInput, listInputs } from "../../src/db/repos/ticket-input.ts";
import { getTicket, insertTicket } from "../../src/db/repos/ticket.ts";
import { insertPending, markRunning, markSucceeded } from "../../src/db/repos/workflow-step.ts";
import { DesignHarness, HARNESS_TEST_TIMEOUT_MS } from "../helpers/design-harness.ts";
import { git } from "../helpers/design-steps.ts";
import { makeTempDir } from "../helpers/temp.ts";

const harnesses: DesignHarness[] = [];
const make = (mode: "worktree" | "in-place" = "worktree") => {
  const h = new DesignHarness(mode);
  harnesses.push(h);
  return h;
};
afterEach(() => {
  for (const h of harnesses.splice(0)) h.cleanup();
});
const fetches = (h: DesignHarness) => h.trackerCalls.filter((c) => c.method === "fetchTicket");

/** A reused database that already holds another project's tickets: OTHER-1 active, with a
 *  `provision` an older Styre finished (succeeded, no manifest), and OTHER-2 waiting. Their project
 *  is paused, so the loop does not drive them in these tests (`v_ready_tickets`); the run still
 *  prepares OTHER-1, which is active. Set up through the repositories (test setup). */
function seedOtherTickets(dbFile: string): { active: number; waiting: number } {
  migrate(dbFile);
  const db = openDb(dbFile);
  try {
    const projectId = insertProject(db, { slug: "other", targetRepo: "/tmp/other" });
    db.query("UPDATE project SET paused = 1 WHERE id = ?").run(projectId);
    const active = insertTicket(db, { projectId, ident: "OTHER-1" });
    const step = insertPending(db, {
      ticketId: active,
      stepKey: "provision",
      stepType: "provision",
    });
    markRunning(db, step.id, {});
    markSucceeded(db, step.id, {});
    const waiting = insertTicket(db, { projectId, ident: "OTHER-2", status: "waiting" });
    return { active, waiting };
  } finally {
    db.close();
  }
}

test(
  "in place: the starting commit is HEAD at run start, unchanged by resume and --accept-head (§8.11)",
  async () => {
    const h = make("in-place");
    const head = git(h.repoDir, ["rev-parse", "HEAD"]);
    expect(await h.fresh()).toBe(75); // pauses needs_you at checks:dispatch
    expect(h.read((db, id) => startingCommit(db, id))).toBe(head);
    expect(await h.resume()).toBe(75);
    expect(h.read((db, id) => startingCommit(db, id))).toBe(head);
    writeFileSync(join(h.repoDir, "operator.txt"), "an operator commit\n");
    git(h.repoDir, ["add", "operator.txt"]);
    git(h.repoDir, ["commit", "-q", "-m", "operator"]);
    expect(await h.resume()).toBe(65); // HEAD moved
    expect(await h.resume({ acceptHead: true })).toBe(75);
    expect(h.read((db, id) => startingCommit(db, id))).toBe(head);
  },
  HARNESS_TEST_TIMEOUT_MS,
);

test(
  "worktree mode: the starting commit is the commit the ticket branch was created from, unchanged by resume and --accept-head (§8.11)",
  async () => {
    const h = make("worktree");
    const main = git(h.repoDir, ["rev-parse", "main"]);
    expect(await h.fresh()).toBe(75);
    expect(h.read((db, id) => startingCommit(db, id))).toBe(main);
    git(h.repoDir, ["commit", "-q", "--allow-empty", "-m", "main moves on"]); // a later main commit
    expect(await h.resume()).toBe(75);
    expect(h.read((db, id) => startingCommit(db, id))).toBe(main);
    // spec §8.11 asks for --accept-head too: in worktree mode the branch a resume recreates can
    // move (ENG-488, hand off note 10), which is when an operator passes it
    expect(await h.resume({ acceptHead: true })).toBe(75);
    expect(h.read((db, id) => startingCommit(db, id))).toBe(main);
  },
  HARNESS_TEST_TIMEOUT_MS,
);

test(
  "E2: resume never reads the tracker; the ticket text stays as the run started",
  async () => {
    const h = make();
    expect(await h.fresh()).toBe(75);
    expect(fetches(h)).toHaveLength(1); // the probe sees the read a fresh run makes
    expect(await h.resume({ trackerTitle: "Edited in the tracker" })).toBe(75);
    expect(fetches(h)).toEqual([]); // the resume asked the tracker nothing
    h.read((db, id) => {
      expect(getTicket(db, id)?.title).toBe("Harness ticket"); // the ticket row itself
      expect(JSON.parse(getInput(db, id, "ticket.title")?.value_json ?? "null")).toBe(
        "Harness ticket",
      );
      expect(listEvents(db, id).filter((e) => e.reason === "inputs-changed")).toEqual([]);
    });
  },
  HARNESS_TEST_TIMEOUT_MS,
);

test(
  "a reused --db records the snapshot of every active ticket in it, not only its own (ruling 2026-10-10)",
  async () => {
    const h = make();
    const dbFile = join(makeTempDir("styre-reuse-"), "reuse.db");
    const other = seedOtherTickets(dbFile);
    expect(await h.fresh({ db: dbFile })).toBe(75);
    h.readAt(dbFile, (db) => {
      expect(
        listInputs(db, other.active)
          .map((r) => r.name)
          .sort(),
      ).toEqual([...SNAPSHOT_INPUT_NAMES].sort());
      expect(listInputs(db, other.waiting)).toEqual([]); // only active tickets
    });
  },
  HARNESS_TEST_TIMEOUT_MS,
);

test(
  "a reused --db keeps the ticket text and rewrites the profile with an inputs-changed note",
  async () => {
    const h = make();
    const dbFile = join(makeTempDir("styre-reuse-"), "reuse.db");
    expect(await h.fresh({ db: dbFile })).toBe(75);
    const titleAt = h.readAt(dbFile, (db, id) => getInput(db, id, "ticket.title")?.captured_at);
    h.editProfile((p) => {
      p.promptVars = { stack: "ruby", tone: "terse" };
    });
    expect(await h.fresh({ db: dbFile })).toBe(75);
    h.readAt(dbFile, (db, id) => {
      expect(getInput(db, id, "ticket.title")?.captured_at).toBe(titleAt);
      const note = listEvents(db, id).find((e) => e.reason === "inputs-changed");
      expect(JSON.parse(note?.payload_json ?? "{}").names).toEqual(["profile.promptVars"]);
    });
  },
  HARNESS_TEST_TIMEOUT_MS,
);
```

- [ ] **Step 3: Run them and see them fail**

Run: `perl -e 'alarm 600; exec @ARGV' bun test test/daemon/design-inputs.test.ts test/cli/snapshot-e2e.test.ts`
Expected: FAIL with `Cannot find module '../../src/daemon/design-inputs.ts'`.

- [ ] **Step 4: Write the repository and the snapshot**

```ts
// src/db/repos/ticket-input.ts
import type { Database } from "bun:sqlite";

export interface TicketInputRow {
  ticket_id: number;
  name: string;
  value_json: string;
  digest: string;
  captured_at: string;
}

const COLS = "ticket_id, name, value_json, digest, captured_at";

export function getInput(db: Database, ticketId: number, name: string): TicketInputRow | null {
  return (
    db
      .query<TicketInputRow, [number, string]>(
        `SELECT ${COLS} FROM ticket_input WHERE ticket_id = ? AND name = ?`,
      )
      .get(ticketId, name) ?? null
  );
}

export function listInputs(db: Database, ticketId: number): TicketInputRow[] {
  return db
    .query<TicketInputRow, [number]>(
      `SELECT ${COLS} FROM ticket_input WHERE ticket_id = ? ORDER BY name`,
    )
    .all(ticketId);
}

/** True when the row was written; an existing row is never touched. */
export function insertInputIfAbsent(db: Database, row: TicketInputRow): boolean {
  const res = db
    .query(`INSERT OR IGNORE INTO ticket_input (${COLS}) VALUES ($t, $n, $v, $d, $c)`)
    .run({
      $t: row.ticket_id,
      $n: row.name,
      $v: row.value_json,
      $d: row.digest,
      $c: row.captured_at,
    });
  return res.changes === 1;
}

export function upsertInput(db: Database, row: TicketInputRow): void {
  db.query(
    `INSERT INTO ticket_input (${COLS}) VALUES ($t, $n, $v, $d, $c)
     ON CONFLICT (ticket_id, name) DO UPDATE SET value_json = $v, digest = $d, captured_at = $c`,
  ).run({
    $t: row.ticket_id,
    $n: row.name,
    $v: row.value_json,
    $d: row.digest,
    $c: row.captured_at,
  });
}
```

```ts
// src/daemon/design-inputs.ts
import type { Database } from "bun:sqlite";
import type { NonPrimaryComponent } from "../cli/component-roles.ts";
import type { UnusableComponent } from "../cli/preflight.ts";
import type { RuntimeConfig } from "../config/runtime-config.ts";
import { appendEvent } from "../db/repos/event-log.ts";
import { getInput, insertInputIfAbsent, upsertInput } from "../db/repos/ticket-input.ts";
import { type TicketRow, getTicket } from "../db/repos/ticket.ts";
import type { Profile } from "../dispatch/profile.ts";
import { nowUtc } from "../util/time.ts";
import { canonicalJson, sha256Hex } from "./canonical.ts";
import {
  SNAPSHOT_INPUT_NAMES,
  type SnapshotInputName,
  TICKET_TEXT_INPUTS,
} from "./design-graph.ts";

/** The commit a run started from (spec §4.2). Not a fingerprinted input; ENG-478 reads it. */
export const STARTING_COMMIT_INPUT = "run.startingCommit";

/** What the design handlers receive, exactly (spec §4.1): the profile narrowed by role and by this
 *  host's toolchain, the lists of what was narrowed away, and the config. */
export interface SnapshotSources {
  profile: Profile;
  unusableComponents: readonly UnusableComponent[];
  nonPrimaryComponents: readonly NonPrimaryComponent[];
  config: Pick<RuntimeConfig, "complexityGrading">;
}

export interface RunInputs extends SnapshotSources {
  /** In place: HEAD at run start. Worktree mode: null here; provision records it (§4.2). */
  startingCommit: string | null;
}

const byComponent = <T extends { component: string }>(a: T, b: T): number =>
  a.component < b.component ? -1 : a.component > b.component ? 1 : 0;

export function snapshotValues(
  ticket: Pick<TicketRow, "ident" | "title" | "description">,
  s: SnapshotSources,
): Record<SnapshotInputName, unknown> {
  return {
    "ticket.ident": ticket.ident,
    "ticket.title": ticket.title,
    "ticket.description": ticket.description,
    "profile.slug": s.profile.slug,
    "profile.promptVars": s.profile.promptVars,
    "profile.runtimeContext": s.profile.runtimeContext,
    "profile.components": s.profile.components,
    // sets: sorted, so the host's discovery order cannot change the digest
    "run.unusableComponents": [...s.unusableComponents].sort(byComponent),
    "run.nonPrimaryComponents": [...s.nonPrimaryComponents].sort(byComponent),
    "config.complexityGrading": s.config.complexityGrading,
  };
}

/** Write the snapshot (spec §4). The ticket text is written once and never rewritten (E2); every
 *  other input is rewritten when its digest changed, and the changed names go in one `note` event,
 *  reason `inputs-changed`. Called at run start, on a reused --db, and on each resume. */
export function captureSnapshot(
  db: Database,
  ticketId: number,
  sources: SnapshotSources,
): { changed: SnapshotInputName[] } {
  const ticket = getTicket(db, ticketId);
  if (!ticket) throw new Error(`captureSnapshot: ticket ${ticketId} not found`);
  const values = snapshotValues(ticket, sources);
  const changed: SnapshotInputName[] = [];
  db.transaction(() => {
    const at = nowUtc();
    for (const name of SNAPSHOT_INPUT_NAMES) {
      const value_json = canonicalJson(values[name]);
      const row = {
        ticket_id: ticketId,
        name,
        value_json,
        digest: sha256Hex(value_json),
        captured_at: at,
      };
      if (TICKET_TEXT_INPUTS.includes(name)) {
        insertInputIfAbsent(db, row);
        continue;
      }
      const prior = getInput(db, ticketId, name);
      if (prior === null) upsertInput(db, row);
      else if (prior.digest !== row.digest) {
        upsertInput(db, row);
        changed.push(name);
      }
    }
    if (changed.length > 0) {
      const pastDesign = ticket.stage !== "design";
      appendEvent(db, {
        ticketId,
        kind: "note",
        reason: "inputs-changed",
        payload: {
          event: "inputs-changed",
          names: changed,
          pastDesign,
          message: pastDesign
            ? "recorded; the run carries on from where it paused, and the change takes effect the next time the run is in design"
            : "the design steps that read these inputs are judged again when the run next walks the design steps; a run stopped at the plan review gate stays there until the plan changes (edit it and resume with --accept-head)",
        },
      });
    }
  })();
  return { changed };
}

export function recordStartingCommit(db: Database, ticketId: number, sha: string): boolean {
  const value_json = canonicalJson(sha);
  return insertInputIfAbsent(db, {
    ticket_id: ticketId,
    name: STARTING_COMMIT_INPUT,
    value_json,
    digest: sha256Hex(value_json),
    captured_at: nowUtc(),
  });
}

export function startingCommit(db: Database, ticketId: number): string | null {
  const row = getInput(db, ticketId, STARTING_COMMIT_INPUT);
  return row === null ? null : (JSON.parse(row.value_json) as string);
}

function requireRow(db: Database, ticketId: number, name: SnapshotInputName) {
  const row = getInput(db, ticketId, name);
  if (row === null)
    throw new Error(
      `ticket ${ticketId}: ticket_input is missing ${name}; the snapshot was never captured`,
    );
  return row;
}

export function snapshotDigest(db: Database, ticketId: number, name: SnapshotInputName): string {
  return requireRow(db, ticketId, name).digest;
}

export function snapshotValue(db: Database, ticketId: number, name: SnapshotInputName): unknown {
  return JSON.parse(requireRow(db, ticketId, name).value_json);
}

/** A design table step may run only once the snapshot exists (fail fast, spec §5.2). */
export function requireSnapshot(db: Database, ticketId: number): void {
  const missing = SNAPSHOT_INPUT_NAMES.filter((n) => getInput(db, ticketId, n) === null);
  if (missing.length > 0)
    throw new Error(
      `ticket ${ticketId}: ticket_input is missing ${missing.join(", ")}; the snapshot was never captured`,
    );
}
```

- [ ] **Step 5: Wire the fresh run, the reused `--db`, the starting commit and the resume**

`src/daemon/run-ticket.ts`: import `{ type RunInputs, captureSnapshot, recordStartingCommit } from "./design-inputs.ts"` and `listActiveTickets` with the other `../db/repos/ticket.ts` names; add to `runTicket`'s parameter type, after `onTicket?`:

```ts
  /** The design inputs exactly as the handlers receive them (spec §4); captured before any step. */
  inputs: RunInputs;
```

and after `deps.onTicket?.(ticketId);`:

```ts
  // A new database gets every row; a reused --db keeps its ticket text and starting commit and
  // rewrites the rest with an `inputs-changed` note (spec §4).
  captureSnapshot(deps.db, ticketId, deps.inputs);
  if (deps.inputs.startingCommit !== null)
    recordStartingCommit(deps.db, ticketId, deps.inputs.startingCommit);
  // Operator ruling, 2026-10-10 (spec §4): a reused --db can hold other active tickets, which the
  // loop drives too (`tick` advances up to two ready tickets, loop.ts:22-41), with this run's
  // registry and so with this run's inputs. Each gets the same snapshot, with the same note, before
  // any step runs. The starting commit stays this run's ticket's own.
  for (const other of listActiveTickets(deps.db)) {
    if (other.id !== ticketId) captureSnapshot(deps.db, other.id, deps.inputs);
  }
```

`src/db/repos/ticket.ts`, after `getByIdent` (line 80):

```ts
/** Every ticket whose status is `active`, by id: the ones a run on a reused --db may drive. */
export function listActiveTickets(db: Database): TicketRow[] {
  return db
    .query<TicketRow, []>(`SELECT ${COLS} FROM ticket WHERE status = 'active' ORDER BY id`)
    .all();
}
```

`src/cli/run.ts`:
- in `RunDeps`, add `/** The toolchain probe (tests); the real `probeCommandExists` otherwise. */ probe?: (repoDir: string, command: string) => boolean;`
- line 338: `const toolchain = applyToolchainGate(profile, deps?.probe);`
- before `const runner = deps?.runner ?? resolveAgentRunner(agentConfig);` (line 441):

```ts
      const inPlace = (args["in-place"] as boolean | undefined) ?? false;
      // spec §4.2: in place, the starting commit is HEAD of the checkout at run start.
      const runStartingCommit = inPlace ? branchHeadSha(profile.targetRepo, "HEAD") : null;
```

- in the `buildDispatchRegistry({...})` call, replace `inPlace: (args["in-place"] as boolean | undefined) ?? false,` with `inPlace,` and add `recordStartingCommit: true,`
- in the `runTicket({...})` call, add:

```ts
        inputs: {
          profile,
          unusableComponents: toolchain.unusable,
          nonPrimaryComponents: loaded.nonPrimary,
          config: runtimeConfig,
          startingCommit: runStartingCommit,
        },
```

- in `resumeDeps` (lines 292-297) add `probe: deps?.probe,`.

`src/dispatch/handlers.ts`: add to `RegistryDeps`:

```ts
  /** A fresh run records, in worktree mode, the commit the ticket branch is created from, right
   *  after provision first creates it (spec §4.2). Resume never sets it: there `worktree add -B`
   *  recreates the branch (ENG-488), which is not its first creation. */
  recordStartingCommit?: boolean;
```

import `recordStartingCommit` from `../daemon/design-inputs.ts`, and in the provision handler after `ensureWorktree(repoPath, branch, worktreePath);` (line 1343):

```ts
    if (deps.recordStartingCommit === true && !deps.inPlace) {
      recordStartingCommit(ctx.db, ctx.ticket.id, worktreeHead(worktreePath));
    }
```

`src/cli/park.ts`: import `captureSnapshot` from `../daemon/design-inputs.ts`; add `probe?: (repoDir: string, command: string) => boolean;` to `resumeRun`'s `deps` type; right after the `recover(db, {...});` call (line 451):

```ts
    // spec §4: after recover() and the provision reset, before the first resolver pass, the profile
    // and config rows are rewritten from what the handlers will receive now. The ticket text and the
    // starting commit never are (E2).
    captureSnapshot(db, ticketId, {
      profile,
      unusableComponents: [],
      nonPrimaryComponents,
      config: runtimeConfig,
    });
```

(Task 8 replaces `profile` and `[]` here with the narrowed profile and its unusable list.)

`test/helpers/db.ts` (the file as PR #154 rewrote it: `makeTestDb` makes its folder with `makeTempDir("styre-m1-")`; keep that): add the imports `DEFAULT_RUNTIME_CONFIG` (`../../src/config/runtime-config.ts`), `captureSnapshot` (`../../src/daemon/design-inputs.ts`), `parseProfile` (`../../src/dispatch/profile.ts`), export

```ts
/** The profile every makeTestDb ticket's snapshot is captured from (the tests that use makeTestDb
 *  build their own registries; the snapshot only has to exist and stay stable). */
export const TEST_PROFILE = parseProfile({ slug: "test-project", targetRepo: "/tmp/repo", components: [] });
```

and inside `if (seedTicket) {`, after the `insertRun({...})` call and before `return { db, projectId, ticketId };`:

```ts
    captureSnapshot(db, ticketId, {
      profile: TEST_PROFILE,
      unusableComponents: [],
      nonPrimaryComponents: [],
      config: DEFAULT_RUNTIME_CONFIG,
    });
```

`test/cli/run-e2e.test.ts` (both `runTicket` calls, lines 40 and 88) and `test/daemon/run-ticket.test.ts:465`: add `inputs: { profile: <the profile the call already passes>, unusableComponents: [], nonPrimaryComponents: [], config: DEFAULT_RUNTIME_CONFIG, startingCommit: null },` (in `run-e2e.test.ts` the profile is the local `profile`; in `run-ticket.test.ts` hoist the inline `parseProfile({...})` into a `const profile` and pass it to both fields).

- [ ] **Step 6: Run the tests and see them pass**

Run: `perl -e 'alarm 600; exec @ARGV' bun test test/daemon/design-inputs.test.ts test/cli/snapshot-e2e.test.ts test/cli/run-e2e.test.ts test/daemon/run-ticket.test.ts`
Expected: PASS.

- [ ] **Step 7: Break it on purpose, see it fail, restore**

1. In the provision hook, drop the `deps.recordStartingCommit === true &&` condition, and in `recordStartingCommit` call `upsertInput` instead of `insertInputIfAbsent`. Run `perl -e 'alarm 600; exec @ARGV' bun test test/cli/snapshot-e2e.test.ts`: the worktree test fails, because the resumed run's provision recreates the branch from the moved `main` (ENG-488) and records that commit. Restore both.
2. In `captureSnapshot`, change `else if (prior.digest !== row.digest)` to `else if (false)`. The reused `--db` test fails (no note, profile row not rewritten). Restore.

- [ ] **Step 8: Run the whole suite**

Run: `perl -e 'alarm 600; exec @ARGV' bun test`
Expected: PASS. Typecheck and lint pass.

- [ ] **Step 9: Commit**

```bash
git add src/db/repos/ticket-input.ts src/daemon/design-inputs.ts src/daemon/run-ticket.ts src/cli/run.ts src/cli/park.ts src/dispatch/handlers.ts test/helpers test/daemon/design-inputs.test.ts test/cli/snapshot-e2e.test.ts test/cli/run-e2e.test.ts test/daemon/run-ticket.test.ts
git commit -m "feat(eng-477): snapshot the design inputs in ticket_input and record the starting commit" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Resume narrows the profile like a fresh run, pauses instead of dropping a required suite, and wires the unusable list

**Files:**
- Modify: `src/cli/preflight.ts:156-189` (one decision shared by fresh runs and resumes; the notice; the pause reason)
- Modify: `src/cli/run.ts:338-349` (fresh path uses the shared notice)
- Modify: `src/cli/park.ts:214-234` (deps: `buildRegistry` gets the wiring), `src/cli/park.ts:441-473` (narrowing and its pause after `recover()`, snapshot from the narrowed profile, registry wiring)
- Modify (hermetic probes; line numbers at the 625e154 base): `test/cli/park.test.ts:173`, `test/cli/park-agent-preflight.test.ts:80`, `test/cli/park-inplace.test.ts:127,242,333,440`, `test/lifecycle/wiring.test.ts:1004`, `test/lifecycle/e2e-interrupt.test.ts:581`, `test/cli/run-pr-base.test.ts:65,115` (both `resumeRun` deps), `test/cli/resume-requeue-forge.test.ts:56` (its `resumeRun` deps), `test/helpers/run-harness.ts:394` (`resumeParkedTicket`'s deps)
- Modify: `test/cli/toolchain-gate-invariant.test.ts:23-30` (the notice moves into `toolchainNotice`, and resume must report it too)
- Test: `test/cli/preflight.test.ts` (add cases), `test/cli/resume-narrowing-e2e.test.ts`

**Interfaces:**
- Consumes: `captureSnapshot` (Task 7), `DesignHarness` (Task 7), `pauseTicket` (`src/daemon/pause-ticket.ts:13`), `exitCodeForOutcome` (`src/cli/outcome.ts:28`), `partitionByToolchain`, `formatUnusableComponents`, `formatMissingTools`, `toolchainError` (existing).
- Produces:
  - `type ToolchainDecision = { kind: "use"; profile: Profile; unusable: UnusableComponent[] } | { kind: "refuse"; partition: ToolchainPartition; blocking: UnusableComponent[] }`
  - `toolchainDecision(profile: Profile, probe?: (repoDir: string, command: string) => boolean): ToolchainDecision`
  - `applyToolchainGate(profile, probe?)` (unchanged signature; now built on `toolchainDecision`)
  - `toolchainNotice(unusable: readonly UnusableComponent[], profile: Profile): string`
  - `resumePauseReason(blocking: readonly UnusableComponent[]): string`
  - `interface ResumeRegistryWiring { profile: Profile; unusableComponents: UnusableComponent[]; nonPrimaryComponents: NonPrimaryComponent[]; inPlace: boolean; worktreeRoot: string }`
  - `resumeRun` deps: `buildRegistry?: (resumeContext: ResumeContext | undefined, wiring: ResumeRegistryWiring) => StepRegistry` and `probe?: (repoDir: string, command: string) => boolean`

- [ ] **Step 1: Write the failing tests**

Append to `test/cli/preflight.test.ts` (it already imports `parseProfile`, line 16; add only the new `preflight.ts` names below, in a new import statement at the top):

```ts
import { resumePauseReason, toolchainDecision, toolchainNotice } from "../../src/cli/preflight.ts";

const twoComponents = (required: boolean) =>
  parseProfile({
    slug: "p",
    targetRepo: "/tmp/p",
    components: [
      { name: "app", kind: "ruby", paths: ["app/**"], commands: { build: "true", test: "true", check: "true" } },
      {
        name: "lib",
        kind: "ruby",
        paths: ["lib/**"],
        commands: { build: "lib-build", test: "lib-test", check: "lib-check" },
        ...(required ? { testPolicy: { suite: "required" } } : {}),
      },
    ],
  });
const libMissing = (_dir: string, cmd: string) => !cmd.startsWith("lib-");

test("toolchainDecision narrows an optional component away, as the fresh gate does", () => {
  const d = toolchainDecision(twoComponents(false), libMissing);
  if (d.kind !== "use") throw new Error("expected use");
  expect(d.profile.components.map((c) => c.name)).toEqual(["app"]);
  expect(d.unusable.map((u) => u.component)).toEqual(["lib"]);
  expect(toolchainNotice(d.unusable, d.profile)).toContain(
    "skipping 1 component(s) whose toolchain is absent; the run continues with app.",
  );
});

test("toolchainDecision refuses to drop a required suite and names it", () => {
  const d = toolchainDecision(twoComponents(true), libMissing);
  if (d.kind !== "refuse") throw new Error("expected refuse");
  expect(d.blocking.map((u) => u.component)).toEqual(["lib"]);
  const reason = resumePauseReason(d.blocking);
  expect(reason).toContain("lib");
  expect(reason).toContain("lib-build");
});
```

```ts
// test/cli/resume-narrowing-e2e.test.ts
import { afterEach, expect, test } from "bun:test";
import { listByTicket as listEvents } from "../../src/db/repos/event-log.ts";
import { listByTicket as listSignals } from "../../src/db/repos/ground-truth-signal.ts";
import { listPending } from "../../src/db/repos/signal.ts";
import { getInput } from "../../src/db/repos/ticket-input.ts";
import { DesignHarness, HARNESS_TEST_TIMEOUT_MS } from "../helpers/design-harness.ts";

const harnesses: DesignHarness[] = [];
const make = (mode: "worktree" | "in-place", required: boolean): DesignHarness => {
  const h = new DesignHarness(mode);
  h.editProfile((p) => {
    (p.components as unknown[]).push({
      name: "lib",
      kind: "ruby",
      paths: ["vendor-lib/**"],
      commands: { build: "lib-build", test: "lib-test", check: "lib-check" },
      ...(required ? { testPolicy: { suite: "required" } } : {}),
    });
  });
  harnesses.push(h);
  return h;
};
afterEach(() => {
  for (const h of harnesses.splice(0)) h.cleanup();
});
const libMissing = (_dir: string, cmd: string) => !cmd.startsWith("lib-");
const changedNotes = (h: DesignHarness) =>
  h.read((db, id) => listEvents(db, id).filter((e) => e.reason === "inputs-changed"));
const components = (h: DesignHarness) =>
  h.read((db, id) =>
    (
      JSON.parse(getInput(db, id, "profile.components")?.value_json ?? "[]") as { name: string }[]
    ).map((c) => c.name),
  );

test(
  "a resume missing an optional component's tools narrows it, says so, and reports it for the PR",
  async () => {
    const h = make("worktree", false);
    expect(await h.fresh()).toBe(75);
    expect(components(h)).toEqual(["app", "lib"]);
    h.probe = libMissing;
    expect(await h.resume()).toBe(75);
    expect(h.stderr.join("")).toContain(
      "resume: skipping 1 component(s) whose toolchain is absent; the run continues with app.",
    );
    expect(components(h)).toEqual(["app"]);
    const note = changedNotes(h).at(-1);
    expect(JSON.parse(note?.payload_json ?? "{}").names).toEqual([
      "profile.components",
      "run.unusableComponents",
    ]);
    // worktree mode reruns provision (recreated worktree); it now carries the unusable list (ENG-412)
    const toolchain = h.read((db, id) =>
      listSignals(db, id).filter((s) => s.signal_type === "toolchain"),
    );
    expect(JSON.parse(toolchain.at(-1)?.detail_json ?? "{}").components).toEqual(["lib"]);
  },
  HARNESS_TEST_TIMEOUT_MS,
);

test(
  "a resume missing a required suite's tools pauses needs_you (75) and drops nothing",
  async () => {
    const h = make("in-place", true);
    expect(await h.fresh()).toBe(75);
    const agentCalls = JSON.stringify(h.calls.counts);
    h.probe = libMissing;
    expect(await h.resume()).toBe(75);
    const out = h.stderr.join("");
    expect(out).toContain("resume: paused:");
    expect(out).toContain("lib-build");
    expect(JSON.stringify(h.calls.counts)).toBe(agentCalls); // nothing ran
    expect(components(h)).toEqual(["app", "lib"]);
    expect(changedNotes(h)).toEqual([]);
    h.read((db, id) => {
      const pending = listPending(db, id).filter((s) => s.signal_type === "human_resume");
      // exactly one, written by pauseTicket after the resume transaction consumed the checks
      // pause's signal: only the narrowing placed after that transaction (spec §4.1) leaves this
      expect(pending.length).toBe(1);
      expect(pending[0]?.reason).toStartWith("this host lacks the tools for lib");
    });
    h.probe = () => true; // the operator installs the tools
    expect(await h.resume()).toBe(75); // back to the checks pause, with nothing changed
    expect(changedNotes(h)).toEqual([]);
  },
  HARNESS_TEST_TIMEOUT_MS,
);

for (const mode of ["in-place", "worktree"] as const) {
  test(
    `${mode}: no false change when a component's toolchain was already missing at the fresh run`,
    async () => {
      const h = make(mode, false);
      h.probe = libMissing;
      expect(await h.fresh()).toBe(75);
      expect(components(h)).toEqual(["app"]);
      expect(await h.resume()).toBe(75);
      expect(changedNotes(h)).toEqual([]);
    },
    HARNESS_TEST_TIMEOUT_MS,
  );
}
```

- [ ] **Step 2: Run them and see them fail**

Run: `perl -e 'alarm 600; exec @ARGV' bun test test/cli/preflight.test.ts test/cli/resume-narrowing-e2e.test.ts`
Expected: FAIL with `toolchainDecision is not a function` (or an export error), and the e2e cases fail on the missing `resume: skipping` notice.

- [ ] **Step 3: Share the toolchain decision**

Replace `src/cli/preflight.ts:156-189` (from `/** What the run decided about its own toolchain` to the end of `applyToolchainGate`) with:

```ts
/** What the run decided about its own toolchain: the components it will use, and the ones it
 *  will not. Returned rather than applied in place so the caller can report the loss. */
export interface ToolchainGate {
  /** `profile`, narrowed to the components this machine can actually use. */
  profile: Profile;
  /** Components dropped from that profile, with the tools whose absence dropped them. */
  unusable: UnusableComponent[];
}

/** The one toolchain decision, for fresh runs and resumes alike (spec §4.1), so both hand the
 *  handlers the same profile. `refuse` when nothing is usable, or when a component whose suite is
 *  `required` is unusable (narrowing it away would drop the suite's declaration and its evidence). */
export type ToolchainDecision =
  | { kind: "use"; profile: Profile; unusable: UnusableComponent[] }
  | { kind: "refuse"; partition: ToolchainPartition; blocking: UnusableComponent[] };

export function toolchainDecision(
  profile: Profile,
  probe: (repoDir: string, command: string) => boolean = probeCommandExists,
): ToolchainDecision {
  const partition = partitionByToolchain(profile, probe);
  const required = partition.unusable.filter((u) =>
    profile.components.some((c) => c.name === u.component && suiteRequirement(c) === "required"),
  );
  if (partition.fatal || required.length > 0)
    return { kind: "refuse", partition, blocking: partition.fatal ? partition.unusable : required };
  if (partition.unusable.length === 0) return { kind: "use", profile, unusable: [] };
  return {
    kind: "use",
    profile: { ...profile, components: partition.usable },
    unusable: partition.unusable,
  };
}

/**
 * The toolchain decision at run start (ENG-412), extracted so it is testable without driving a
 * whole run: throws `toolchainError` (exit 69) iff the decision refuses, else returns the narrowed
 * profile plus what it dropped. Fresh runs only: `--resume` pauses instead (spec §4.1).
 *
 * The narrowing is returned as a NEW profile and never written back to disk. What is missing is a
 * property of this machine; the profile describes the repo.
 */
export function applyToolchainGate(
  profile: Profile,
  probe: (repoDir: string, command: string) => boolean = probeCommandExists,
): ToolchainGate {
  const d = toolchainDecision(profile, probe);
  if (d.kind === "refuse") throw toolchainError(formatMissingTools(d.partition.missing));
  return { profile: d.profile, unusable: d.unusable };
}

/** The stderr notice of a narrowing, the same sentence on a fresh run (`run: `) and a resume
 *  (`resume: `). */
export function toolchainNotice(unusable: readonly UnusableComponent[], profile: Profile): string {
  const kept = profile.components.map((c) => c.name).join(", ");
  return `skipping ${unusable.length} component(s) whose toolchain is absent; the run continues with ${kept}.\n${formatUnusableComponents([...unusable])}`;
}

/** Why a resume paused instead of narrowing: each blocking component and its missing tools. */
export function resumePauseReason(blocking: readonly UnusableComponent[]): string {
  const named = blocking
    .map((u) => `${u.component} (missing: ${u.missing.map((m) => `\`${m.command}\``).join(", ")})`)
    .join("; ");
  return `this host lacks the tools for ${named}; resuming without them would drop a required suite or leave nothing to run. Install them and resume.`;
}
```

`src/cli/run.ts:340-349` (the `if (toolchain.unusable.length > 0) {...}` block after `profile = toolchain.profile;`, which stays) becomes:

```ts
    if (toolchain.unusable.length > 0) {
      // Said here for whoever is watching the run, and again in the PR body (the `toolchain`
      // signal emitted by `provision`).
      process.stderr.write(`run: ${toolchainNotice(toolchain.unusable, profile)}\n`);
    }
```

with `toolchainNotice` added to the `./preflight.ts` import and `formatUnusableComponents` removed from it (its only use in `run.ts` was this block).

`test/cli/toolchain-gate-invariant.test.ts` asserts `src.includes("formatUnusableComponents(")` on `run.ts` (line 27), which the block above removes. Replace its second test (lines 23-30) with:

```ts
test("run and resume report what they skipped — the narrowing is never silent", () => {
  const run = readFileSync("src/cli/run.ts", "utf8");
  const park = readFileSync("src/cli/park.ts", "utf8");

  // Said to the operator at run time, the same notice on a fresh run and on a resume...
  expect(run.includes("toolchainNotice(")).toBe(true);
  expect(park.includes("toolchainNotice(")).toBe(true);
  // ...and carried into the run so it can reach the PR (handlers.ts turns this into a signal).
  expect(run.includes("unusableComponents:")).toBe(true);
  expect(park.includes("unusableComponents: toolchain.unusable")).toBe(true);
});
```

- [ ] **Step 4: Narrow, pause and wire on resume**

`src/cli/park.ts`:
- imports: `import { pauseTicket } from "../daemon/pause-ticket.ts";`, `import { type UnusableComponent, resumePauseReason, toolchainDecision, toolchainNotice } from "./preflight.ts";`
- export near `ResumeArgs`:

```ts
/** What the resumed run's registry is built from (spec §4.1): the profile after the toolchain
 *  narrowing, and the lists of what was narrowed away, so provision reports them (ENG-412, ENG-425). */
export interface ResumeRegistryWiring {
  profile: Profile;
  unusableComponents: UnusableComponent[];
  nonPrimaryComponents: NonPrimaryComponent[];
  inPlace: boolean;
  worktreeRoot: string;
}
```

- `deps.buildRegistry` type becomes `(resumeContext: { stepKey: string; transcript: string } | undefined, wiring: ResumeRegistryWiring) => StepRegistry`.
- Replace everything from the `captureSnapshot(db, ticketId, {...})` call added in Task 7 to the end of the `const registry = ...` statement (lines 453-463 before Task 7) with:

```ts
    // spec §4.1: the same toolchain narrowing as a fresh run, here: after --inspect, after the resume
    // transaction (a pause written before it would be consumed by it) and recover(), before the
    // snapshot. Never exit 69: where the fresh gate would refuse, pause for the operator instead.
    // A ticket the resume transaction already left waiting (a plan review gate stop applied again)
    // gets no second pause: one human_resume and one escalation are enough (operator ruling,
    // 2026-10-09). The tool gap is still recorded, as a note, and said as what it is.
    const toolchain = toolchainDecision(profile, deps?.probe);
    if (toolchain.kind === "refuse") {
      const reason = resumePauseReason(toolchain.blocking);
      if (getTicket(db, ticketId)?.status === "waiting") {
        appendEvent(db, {
          ticketId,
          kind: "note",
          reason: "toolchain-missing",
          payload: { event: "toolchain-missing", detail: reason },
        });
        process.stderr.write(
          `resume: paused: the run is already waiting for you, and ${reason}\n`,
        );
      } else {
        pauseTicket(db, ticketId, reason);
        process.stderr.write(`resume: paused: ${reason}\n`);
      }
      closeDb();
      process.exitCode = exitCodeForOutcome("paused"); // 75, needs_you
      return;
    }
    const runProfile = toolchain.profile;
    if (toolchain.unusable.length > 0) {
      process.stderr.write(`resume: ${toolchainNotice(toolchain.unusable, runProfile)}\n`);
    }

    // spec §4: after recover() and the provision reset, before the first resolver pass, the profile
    // and config rows are rewritten from what the handlers will receive now. The ticket text and the
    // starting commit never are (E2).
    captureSnapshot(db, ticketId, {
      profile: runProfile,
      unusableComponents: toolchain.unusable,
      nonPrimaryComponents,
      config: runtimeConfig,
    });

    const wiring: ResumeRegistryWiring = {
      profile: runProfile,
      unusableComponents: toolchain.unusable,
      nonPrimaryComponents,
      inPlace,
      worktreeRoot, // minted once above (in-place = repo root), shared with the reconcile
    };
    const registry: StepRegistry = deps?.buildRegistry
      ? deps.buildRegistry(resumeContext, wiring)
      : buildDispatchRegistry({
          runner: deps?.runner ?? resolveAgentRunner(runtimeConfig.agent ?? DEFAULT_AGENT_CONFIG),
          agentConfig: runtimeConfig.agent ?? DEFAULT_AGENT_CONFIG,
          ...wiring,
          resumeContext,
        });
```

and in the `driveToTerminal(...)` call below it, `profile,` becomes `profile: runProfile,`.

- [ ] **Step 5: Make the existing resume tests hermetic**

In each `resumeRun(...)` deps object named in **Files** (and in `resumeParkedTicket` in `test/helpers/run-harness.ts`), add `probe: () => true,`. These tests are about other behaviour; the real `probeCommandExists` would make them depend on the host's tools.

- [ ] **Step 6: Run the tests and see them pass**

Run: `perl -e 'alarm 600; exec @ARGV' bun test test/cli/preflight.test.ts test/cli/resume-narrowing-e2e.test.ts test/cli/toolchain-gate-invariant.test.ts test/cli/run-preflight.test.ts test/cli/park.test.ts test/cli/park-inplace.test.ts test/cli/park-resume-e2e.test.ts`
Expected: PASS.

- [ ] **Step 7: Break it on purpose, see it fail, restore**

1. In `resumeRun`, replace the `toolchainDecision(...)` block with `const runProfile = profile; const toolchain = { unusable: [] as UnusableComponent[] };` (no narrowing, as before this task). The optional component test and both "no false change" tests fail (the snapshot gains `lib`, an `inputs-changed` note appears). Restore.
2. Move the narrowing block above the resume transaction (`db.transaction(() => {...})()` at line 409). The required suite test fails: the ticket is still `waiting` there, so the block takes its waiting branch and writes no signal of its own; the one pending `human_resume` is the checks pause's (its reason starts `checks:dispatch:`), not `this host lacks the tools for lib`. Restore.

- [ ] **Step 8: Run the whole suite**

Run: `perl -e 'alarm 600; exec @ARGV' bun test`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src/cli/preflight.ts src/cli/run.ts src/cli/park.ts test/cli test/lifecycle/wiring.test.ts test/lifecycle/e2e-interrupt.test.ts test/helpers/run-harness.ts
git commit -m "fix(eng-477): resume narrows the profile like a fresh run and pauses rather than drop a required suite" -m "Resume now applies the same toolchain decision as a fresh run after the resume transaction and recover(), prints the same notice, passes the unusable list to provision, and pauses needs_you (exit 75) where the fresh gate would refuse. It never exits 69." -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Record each table step's manifest in its success transaction

**Files:**
- Create: `src/daemon/design-digests.ts`
- Modify: `src/daemon/step-registry.ts:16-41` (optional success commit per handler), `src/engine/step-journal.ts:54,152` (`onSucceed` receives the result)
- Modify: `src/db/repos/workflow-step.ts` (add `recordManifest`)
- Modify: `src/dispatch/plan-frontmatter.ts:8-19` (`linearFromFrontmatter`), `src/dispatch/worktree.ts` (add `planFilesAt` after `fileContentAt`, lines 314-326)
- Modify: `src/dispatch/handlers.ts:526-541` (`design:dispatch` returns `planDigest`; when no plan for the ticket is committed at the branch head it fails at once with a `StepPrerequisiteError`, which escalates without a retry: operator ruling, 2026-10-10)
- Modify: `src/daemon/advance.ts:173-226` (snapshot precondition; `onSucceed` = own rows, then manifest, then verdict)
- Modify (mocks): `test/helpers/skeleton-registry.ts:19`, `test/daemon/advance.test.ts:37,100,325,354`, `test/daemon/advance-leftovers.test.ts:69,101,125,158,176,198,221,243`, `test/daemon/loop.test.ts:14` (each normally returning `design:dispatch` mock adds `planDigest: EMPTY_PLAN_DIGEST` to its result); `test/daemon/loop.test.ts` and `test/lifecycle/e2e-interrupt.test.ts` (capture a snapshot after their direct `insertTicket`)
- Modify (tests that seed a succeeded `design:dispatch` without a plan digest and then run `design:extract` or `design:review`; from this task those steps record a manifest whose `plan` input needs the digest, so they move onto real steps here, spec §8): `test/helpers/design-steps.ts` (add `reachDesignStep`, and a `repoSetup` option on `makeDesignTicket`), `test/dispatch/design-extract.test.ts`, `test/dispatch/design-extract-retry-feedback.test.ts`, `test/dispatch/completeness-e2e.test.ts:348-370`, `test/dispatch/design-review-e2e.test.ts` (`readyForDesignReview` and Flow 4, whose hand seeded `design:dispatch` row is lines 271-278), `test/dispatch/design-review-handler.test.ts`, `test/dispatch/design-size-e2e.test.ts` (`readyForSize`, lines 45-60: its flows "grader off: 2-unit ticket ... design:review is dispatched" and "grader on: 1-unit ... design:review is dispatched" run the real `design:review` after a hand marked `design:dispatch`), `test/daemon/advance.test.ts:241-289` (`design:review step with blocking plan finding`). As PR #154 left them, each of these files makes its registry's worktree root inline with `makeTempDir(...)`.
- Test: `test/daemon/manifest-recording.test.ts`, `test/daemon/design-digests.test.ts`, `test/daemon/fingerprint-pin.test.ts` (operator ruling, 2026-10-09: the digests of a fixed set of inputs are pinned per `FINGERPRINT_SCHEME`)

**Interfaces:**
- Consumes: `DESIGN_TABLE`, `StepRow`, `stepRow`, `isSnapshotInput`, `ensureDesignTableChecked`, `InputContext` (Task 6); `snapshotDigest`, `snapshotValue`, `requireSnapshot`, `captureSnapshot` (Task 7); `digestValue`, `FINGERPRINT_SCHEME` (Task 5); `makeDesignTicket`, `driveUntil`, `atStep`, `git`, `gitRepo`, `defaultScript`, `newCalls`, `scriptedRunner`, `unitsOf`, `ScriptUnit`, `ScriptCalls`, `ABSENT_RC`, `TEST_PROFILE` (Task 7).
- Produces:
  - test helper: `reachDesignStep(opts: { db: Database; ticketId: number; profile: Profile; worktreeRoot: string; target: string; units?: ScriptUnit[]; config?: RuntimeConfig; inPlace?: boolean }): Promise<ScriptCalls>` in `test/helpers/design-steps.ts` (first used here; Tasks 13 and later reference it)
  - `type StepCommit = (db: Database, ticketId: number, result: unknown) => void`; `StepRegistry.register(handlerKey, handler, opts?: { commit?: StepCommit })`; `StepRegistry.resolveCommit(handlerKey): StepCommit | undefined`
  - `RunStepParams.onSucceed?: (step: WorkflowStepRow, result: unknown) => void`
  - `recordManifest(db, id, m: { manifest: Record<string, string>; fingerprint: string; outputDigest: string | null; scheme: number }): void`
  - `linearFromFrontmatter(text: string): string | null`; `planFilesAt(repoPath: string, ref: string): { path: string; content: string }[]`
  - `digestWorkUnits(db, ticketId): string`, `digestTrack(db, ticketId): string`, `ticketPlanFilesAt(repoPath: string, ref: string, ident: string): { path: string; content: string }[]`, `planDigestOf(files): string`, `planDigestAt(repoPath: string, ref: string, ident: string): string`, `EMPTY_PLAN_DIGEST: string`, `inputContext(db, ticketId): InputContext`, `currentManifest(db, ticketId, row: StepRow): Record<string, string>`, `changedInputs(recorded: Record<string, string>, current: Record<string, string>): string[]`, `recordStepManifest(db, ticketId, stepId: number, row: StepRow, outputDigest: string | null): void`, `planDigestFromResult(result: unknown): string`
  - `design:dispatch`'s result gains `planDigest: string`

- [ ] **Step 1: Write the failing tests**

```ts
// test/daemon/design-digests.test.ts
import { expect, test } from "bun:test";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { digestWorkUnits, planDigestAt } from "../../src/daemon/design-digests.ts";
import { insertTicket, setNeedsDocs } from "../../src/db/repos/ticket.ts";
import { insertWorkUnit, setBaseSha, setStatus } from "../../src/db/repos/work-unit.ts";
import { makeTestDb } from "../helpers/db.ts";
import { STEP_TEST_TIMEOUT_MS, git, gitRepo } from "../helpers/design-steps.ts";

const plan = (ident: string, body: string) => `---\nlinear: ${ident}\n---\n\n${body}\n`;
function commitAll(repo: string, msg: string) {
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-q", "-m", msg]);
}

test(
  "a renamed plan changes the digest; another ticket's plan and a nested file do not",
  () => {
    const repo = gitRepo();
    mkdirSync(join(repo, "docs", "plans", "sub"), { recursive: true });
    writeFileSync(join(repo, "docs", "plans", "a.md"), plan("ENG-1", "body"));
    commitAll(repo, "plan a");
    const first = planDigestAt(repo, "main", "ENG-1");
    renameSync(join(repo, "docs", "plans", "a.md"), join(repo, "docs", "plans", "b.md"));
    commitAll(repo, "rename");
    const renamed = planDigestAt(repo, "main", "ENG-1");
    expect(renamed).not.toBe(first);
    writeFileSync(join(repo, "docs", "plans", "other.md"), plan("ENG-9", "another ticket"));
    writeFileSync(join(repo, "docs", "plans", "sub", "x.md"), plan("ENG-1", "nested"));
    commitAll(repo, "unrelated");
    expect(planDigestAt(repo, "main", "ENG-1")).toBe(renamed);
    writeFileSync(join(repo, "docs", "plans", "b.md"), plan("ENG-1", "edited body"));
    commitAll(repo, "edit");
    expect(planDigestAt(repo, "main", "ENG-1")).not.toBe(renamed);
  },
  STEP_TEST_TIMEOUT_MS,
);

test(
  "the plan digest reads git at the ref, never the working tree",
  () => {
    const repo = gitRepo();
    mkdirSync(join(repo, "docs", "plans"), { recursive: true });
    writeFileSync(join(repo, "docs", "plans", "a.md"), plan("ENG-1", "committed"));
    commitAll(repo, "plan");
    const committed = planDigestAt(repo, "main", "ENG-1");
    writeFileSync(join(repo, "docs", "plans", "a.md"), plan("ENG-1", "uncommitted edit"));
    expect(planDigestAt(repo, "main", "ENG-1")).toBe(committed);
  },
  STEP_TEST_TIMEOUT_MS,
);

test(
  "a missing ref fails loudly",
  () => {
    expect(() => planDigestAt(gitRepo(), "feat/never", "ENG-1")).toThrow("git ls-tree");
  },
  STEP_TEST_TIMEOUT_MS,
);

test(
  "the units digest ignores ids, status, base_sha and reconcile units, and covers needs_docs",
  () => {
    const { db, projectId } = makeTestDb();
    const a = insertTicket(db, { projectId, ident: "ENG-10" });
    const b = insertTicket(db, { projectId, ident: "ENG-11" });
    const unit = (ticketId: number) =>
      insertWorkUnit(db, {
        ticketId,
        seq: 1,
        kind: "backend",
        title: "t",
        description: "d",
        behavioral: 0,
        filesToTouch: ["a.ts"],
        verifyCheckTypes: [],
        dependsOn: [],
      });
    const ua = unit(a);
    unit(b); // a different id
    expect(digestWorkUnits(db, a)).toBe(digestWorkUnits(db, b));
    setStatus(db, ua.id, "verified");
    setBaseSha(db, ua.id, "abc");
    insertWorkUnit(db, {
      ticketId: a,
      seq: 2,
      kind: "reconcile",
      origin: "reconcile",
      dependsOn: [1],
    });
    expect(digestWorkUnits(db, a)).toBe(digestWorkUnits(db, b));
    setNeedsDocs(db, a, 1);
    expect(digestWorkUnits(db, a)).not.toBe(digestWorkUnits(db, b));
    db.close();
  },
  STEP_TEST_TIMEOUT_MS,
);
```

```ts
// test/daemon/manifest-recording.test.ts
import { expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_RUNTIME_CONFIG } from "../../src/config/runtime-config.ts";
import { advanceOneStep } from "../../src/daemon/advance.ts";
import { digestValue } from "../../src/daemon/canonical.ts";
import { currentManifest, inputContext, planDigestAt } from "../../src/daemon/design-digests.ts";
import { DESIGN_TABLE, type StepRow } from "../../src/daemon/design-graph.ts";
import { StepRegistry } from "../../src/daemon/step-registry.ts";
import { insertProject } from "../../src/db/repos/project.ts";
import { listPending } from "../../src/db/repos/signal.ts";
import { getTicket, insertTicket, setTicketStage } from "../../src/db/repos/ticket.ts";
import { insertWorkUnit } from "../../src/db/repos/work-unit.ts";
import { getByKey } from "../../src/db/repos/workflow-step.ts";
import { makeTestDb } from "../helpers/db.ts";
import {
  STEP_TEST_TIMEOUT_MS,
  atStep,
  driveUntil,
  git,
  makeDesignTicket,
} from "../helpers/design-steps.ts";

const rows = DESIGN_TABLE.filter((r): r is StepRow => r.kind === "step");

test(
  "every design step records its manifest, fingerprint and scheme at success; the plan its digest",
  async () => {
    const t = makeDesignTicket(); // two behavioural units: full track, design:review runs
    await driveUntil(t, atStep("checks:dispatch"));
    for (const row of rows) {
      const step = getByKey(t.db, t.ticketId, row.stepKey);
      expect(step?.status).toBe("succeeded");
      const manifest = JSON.parse(step?.input_manifest ?? "null") as Record<string, string>;
      expect(Object.keys(manifest).sort()).toEqual(
        [...row.inputs(inputContext(t.db, t.ticketId))].sort(),
      );
      expect(step?.input_fingerprint).toBe(digestValue(manifest));
      expect(step?.fingerprint_scheme).toBe(1);
      expect(manifest).toEqual(currentManifest(t.db, t.ticketId, row)); // stable on recompute
      if (row.fileOutput)
        expect(step?.output_digest).toBe(planDigestAt(t.repo, "feat/ENG-1", "ENG-1"));
      else expect(step?.output_digest).toBeNull();
    }
  },
  STEP_TEST_TIMEOUT_MS,
);

test(
  "provision run while the ticket is in implement records its manifest too (§5.2)",
  async () => {
    const t = makeDesignTicket();
    setTicketStage(t.db, t.ticketId, "implement");
    insertWorkUnit(t.db, { ticketId: t.ticketId, seq: 1, kind: "backend", status: "verifying" });
    const outcome = await advanceOneStep(t.db, t.ticketId, t.registry, { config: t.config });
    expect(outcome).toEqual({ kind: "stepped", stepKey: "provision" });
    expect(getByKey(t.db, t.ticketId, "provision")?.input_manifest).not.toBeNull();
  },
  STEP_TEST_TIMEOUT_MS,
);

test(
  "design:dispatch escalates at once, retrying nothing, when its plan is not committed at the branch head",
  async () => {
    // The target repository ignores docs/plans/: the agent writes the plan, the postcondition sees
    // it in the worktree, the commit stages nothing, and the digest would be the empty list forever.
    const t = makeDesignTicket({
      repoSetup: (repo) => {
        writeFileSync(join(repo, ".gitignore"), "docs/plans/\n");
        git(repo, ["add", ".gitignore"]);
        git(repo, ["commit", "-q", "-m", "ignore the plans"]);
      },
    });
    await driveUntil(t, atStep("design:dispatch"));
    const outcome = await advanceOneStep(t.db, t.ticketId, t.registry, { config: t.config });
    // operator ruling, 2026-10-10: not retryable (a StepPrerequisiteError): the step records
    // attempt 1, its one execution, and no retry is spent; the operator is told what to change
    expect(outcome).toEqual({ kind: "escalated", stepKey: "design:dispatch" });
    expect(t.calls.counts["design:dispatch"]).toBe(1);
    const step = getByKey(t.db, t.ticketId, "design:dispatch");
    expect(step?.status).toBe("failed");
    expect(step?.attempt).toBe(1);
    expect(getTicket(t.db, t.ticketId)?.status).toBe("waiting");
    const reason = listPending(t.db, t.ticketId).find(
      (p) => p.signal_type === "human_resume",
    )?.reason;
    expect(reason).toContain("the plan for ENG-1 is not committed");
    expect(reason).toContain("remove docs/plans/ from .gitignore");
  },
  STEP_TEST_TIMEOUT_MS,
);

test(
  "a table step does not run without a snapshot; the run stops loudly",
  async () => {
    const { db } = makeTestDb({ seedTicket: false });
    const projectId = insertProject(db, { slug: "p", targetRepo: "/tmp/x" });
    const ticketId = insertTicket(db, { projectId, ident: "ENG-3" });
    const registry = new StepRegistry();
    let ran = false;
    registry.register("provision", () => {
      ran = true;
      return {};
    });
    await expect(
      advanceOneStep(db, ticketId, registry, { config: DEFAULT_RUNTIME_CONFIG }),
    ).rejects.toThrow("ticket_input is missing");
    expect(ran).toBe(false);
    db.close();
  },
  STEP_TEST_TIMEOUT_MS,
);
```

```ts
// test/daemon/fingerprint-pin.test.ts
import { expect, test } from "bun:test";
import { DEFAULT_RUNTIME_CONFIG } from "../../src/config/runtime-config.ts";
import { FINGERPRINT_SCHEME, digestValue } from "../../src/daemon/canonical.ts";
import { digestTrack, digestWorkUnits, planDigestOf } from "../../src/daemon/design-digests.ts";
import { DESIGN_TABLE, type StepRow } from "../../src/daemon/design-graph.ts";
import { captureSnapshot } from "../../src/daemon/design-inputs.ts";
import { insertProject } from "../../src/db/repos/project.ts";
import { listInputs } from "../../src/db/repos/ticket-input.ts";
import { insertTicket, setNeedsDocs, setTicketTrack } from "../../src/db/repos/ticket.ts";
import { insertWorkUnit } from "../../src/db/repos/work-unit.ts";
import { parseProfile } from "../../src/dispatch/profile.ts";
import { makeTestDb } from "../helpers/db.ts";

/** The digests of a fixed set of inputs, per FINGERPRINT_SCHEME (operator ruling, 2026-10-09, spec
 *  §5.1). A change to the encoding, to how the profile or config is parsed (a new default included),
 *  to what a table step declares, or to how a snapshot row or an output is digested changes one of
 *  them: paused runs would rerun their design steps although nobody edited anything. That is a
 *  scheme change. Bump FINGERPRINT_SCHEME deliberately and add its pin here; never edit an existing
 *  pin. */
const PINNED: Record<number, Record<string, string>> = {
  1: {
    // Task 9 Step 7a: the values this test prints on its first run, copied here once.
  },
};

/** Frozen here, never shared with other tests: an edit to a shared helper must not fail the pin. The
 *  second component's test policy pins how an optional object reaches the snapshot (its schema has
 *  no defaults today; a default added there would change the pin, as it should). */
const PINNED_PROFILE = {
  slug: "pinned",
  targetRepo: "/pinned/repo",
  defaultBranch: "main",
  checksSystem: "none",
  components: [
    {
      name: "app",
      kind: "ruby",
      paths: ["app/**"],
      commands: { build: "true", test: "true", check: "true" },
    },
    {
      name: "lib",
      kind: "ruby",
      paths: ["lib/**"],
      commands: { build: "true", test: "true", check: "true" },
      testPolicy: { suite: "required" },
    },
  ],
  promptVars: { stack: "ruby" },
  runtimeContext: {
    topology: { type: "cli" },
    data: { presence: "absent" },
    caching: { presence: "absent" },
    observability: { presence: "absent" },
    configSecrets: { presence: "absent" },
    documentation: { presence: "absent" },
    releasePackaging: { mechanism: "none" },
  },
};

function computed(): Record<string, string> {
  const out: Record<string, string> = {};
  const { db } = makeTestDb({ seedTicket: false });
  try {
    const projectId = insertProject(db, { slug: "pinned", targetRepo: "/pinned/repo" });
    const ticketId = insertTicket(db, {
      projectId,
      ident: "ENG-1",
      title: "Pinned title",
      description: "Pinned body",
    });
    // The snapshot digests as captureSnapshot records them, which is what a manifest compares.
    captureSnapshot(db, ticketId, {
      profile: parseProfile(PINNED_PROFILE),
      unusableComponents: [],
      nonPrimaryComponents: [],
      config: DEFAULT_RUNTIME_CONFIG,
    });
    for (const row of listInputs(db, ticketId)) out[`snapshot ${row.name}`] = row.digest;
    insertWorkUnit(db, {
      ticketId,
      seq: 1,
      kind: "backend",
      title: "Unit 1",
      description: "Change 1",
      behavioral: 1,
      testPlan: "test/u1_test.rb asserts change 1",
      filesToTouch: ["lib/u1.rb", "test/u1_test.rb"],
      verifyCheckTypes: ["test"],
      dependsOn: [],
    });
    insertWorkUnit(db, {
      ticketId,
      seq: 2,
      kind: "backend",
      title: "Unit 2",
      description: "Change 2",
      behavioral: 0,
      testPlan: null,
      filesToTouch: ["lib/u2.rb"],
      verifyCheckTypes: [],
      dependsOn: [1],
    });
    setNeedsDocs(db, ticketId, 1);
    setTicketTrack(db, ticketId, "full");
    out["output workUnits"] = digestWorkUnits(db, ticketId);
    out["output track"] = digestTrack(db, ticketId);
  } finally {
    db.close();
  }
  out["output plan"] = planDigestOf([
    { path: "docs/plans/eng-1-plan.md", content: "---\nlinear: ENG-1\n---\n\nPinned plan\n" },
  ]);
  for (const row of DESIGN_TABLE.filter((r): r is StepRow => r.kind === "step")) {
    for (const complexityGrading of [false, true]) {
      // Sorted: a manifest is a map, so the order a row lists its inputs in never reaches a digest.
      const key = `declared ${row.stepKey} grading ${complexityGrading ? "on" : "off"}`;
      out[key] = digestValue([...row.inputs({ complexityGrading })].sort());
    }
  }
  return out;
}

test(`the digests of a fixed set of inputs are those pinned for scheme ${FINGERPRINT_SCHEME}`, () => {
  // Failing? Something a recorded digest depends on changed. Decide it deliberately: bump
  // FINGERPRINT_SCHEME (spec §5.1) and add the new pin under the new number.
  expect(computed()).toEqual(PINNED[FINGERPRINT_SCHEME] ?? {});
});
```

- [ ] **Step 2: Run them and see them fail**

Run: `perl -e 'alarm 600; exec @ARGV' bun test test/daemon/design-digests.test.ts test/daemon/manifest-recording.test.ts test/daemon/fingerprint-pin.test.ts`
Expected: FAIL with `Cannot find module '../../src/daemon/design-digests.ts'`.

- [ ] **Step 3: Add the plan file reader and the frontmatter parser**

`src/dispatch/plan-frontmatter.ts`, replace `planFrontmatterLinear` with:

```ts
/** The `linear:` value from a plan's leading `---`-fenced frontmatter, or null. Only the leading
 *  frontmatter block is scanned, so a `linear:` mention in the plan BODY does not count. */
export function linearFromFrontmatter(text: string): string | null {
  const fm = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (fm === null) return null;
  const line = fm[1].match(/^linear:\s*(\S+)\s*$/m);
  return line ? line[1] : null;
}

/** `linearFromFrontmatter` of a file on disk; null when it is missing or unreadable. */
export function planFrontmatterLinear(path: string): string | null {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  return linearFromFrontmatter(text);
}
```

`src/dispatch/worktree.ts`, after `fileContentAt`:

```ts
/** Every `docs/plans/*.md` (not nested) at `ref`, read through git, never the working tree (spec
 *  §5.3: the resolver and the plan digest never read the worktree). A missing ref throws. */
export function planFilesAt(repoPath: string, ref: string): { path: string; content: string }[] {
  const paths = gitPathsZ(["ls-tree", "-r", "--name-only", "-z", ref, "--", "docs/plans/"], repoPath)
    .filter((p) => /^docs\/plans\/[^/]+\.md$/.test(p))
    .sort();
  return paths.map((path) => {
    const content = fileContentAt(ref, path, repoPath);
    if (content === null) throw new Error(`git show ${ref}:${path} returned nothing for a listed file`);
    return { path, content };
  });
}
```

- [ ] **Step 4: Write the digests**

```ts
// src/daemon/design-digests.ts
import type { Database } from "bun:sqlite";
import { getTicket } from "../db/repos/ticket.ts";
import {
  listByTicket as listUnits,
  parseDependsOn,
  parseFilesToTouch,
  parseVerifyCheckTypes,
} from "../db/repos/work-unit.ts";
import { getByKey, recordManifest } from "../db/repos/workflow-step.ts";
import { linearFromFrontmatter } from "../dispatch/plan-frontmatter.ts";
import { planFilesAt } from "../dispatch/worktree.ts";
import { FINGERPRINT_SCHEME, digestValue } from "./canonical.ts";
import {
  type InputContext,
  type OutputName,
  type StepRow,
  isSnapshotInput,
} from "./design-graph.ts";
import { snapshotDigest, snapshotValue } from "./design-inputs.ts";

/** design:extract's output (spec §5.3): only the fields it wrote, units of origin `extract` by
 *  seq, plus ticket.needs_docs. No ids, no timestamps, no status or base_sha (later stages change them). */
export function digestWorkUnits(db: Database, ticketId: number): string {
  const ticket = getTicket(db, ticketId);
  if (!ticket) throw new Error(`digestWorkUnits: ticket ${ticketId} not found`);
  const units = listUnits(db, ticketId)
    .filter((u) => u.origin === "extract")
    .map((u) => ({
      seq: u.seq,
      kind: u.kind,
      title: u.title,
      description: u.description,
      behavioral: u.behavioral,
      test_plan: u.test_plan,
      files_to_touch: parseFilesToTouch(u),
      verify_check_types: parseVerifyCheckTypes(u),
      depends_on: parseDependsOn(u),
    }));
  return digestValue({ units, needsDocs: ticket.needs_docs });
}

/** design:size's output. */
export function digestTrack(db: Database, ticketId: number): string {
  return digestValue(getTicket(db, ticketId)?.track ?? null);
}

/** The `docs/plans/*.md` files at `ref` whose frontmatter `linear:` is this ticket, sorted by
 *  path, read through git (spec §5.3). */
export function ticketPlanFilesAt(
  repoPath: string,
  ref: string,
  ident: string,
): { path: string; content: string }[] {
  return planFilesAt(repoPath, ref).filter((f) => linearFromFrontmatter(f.content) === ident);
}

/** The plan's digest (spec §5.3): path and content of each file, sorted by path. A renamed or
 *  extra plan file changes it. */
export function planDigestOf(files: readonly { path: string; content: string }[]): string {
  return digestValue(files.map((f) => ({ path: f.path, content: f.content })));
}

export function planDigestAt(repoPath: string, ref: string, ident: string): string {
  return planDigestOf(ticketPlanFilesAt(repoPath, ref, ident));
}

/** The digest of "no plan file for this ticket". Test mocks of design:dispatch return it. */
export const EMPTY_PLAN_DIGEST = digestValue([]);

export function inputContext(db: Database, ticketId: number): InputContext {
  return { complexityGrading: snapshotValue(db, ticketId, "config.complexityGrading") === true };
}

function outputDigest(db: Database, ticketId: number, name: OutputName): string {
  switch (name) {
    case "plan": {
      const s = getByKey(db, ticketId, "design:dispatch");
      if (!s || s.status !== "succeeded" || s.output_digest === null)
        throw new Error(
          `ticket ${ticketId}: the plan has no recorded digest (design:dispatch is ${s?.status ?? "absent"})`,
        );
      return s.output_digest;
    }
    case "workUnits":
      return digestWorkUnits(db, ticketId);
    case "track":
      return digestTrack(db, ticketId);
    case "planFindings":
      throw new Error(
        "plan findings are read only by the gate; they are never a fingerprinted input",
      );
  }
}

/** The manifest `row` would record now: each declared input's current digest. Database only. */
export function currentManifest(
  db: Database,
  ticketId: number,
  row: StepRow,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of row.inputs(inputContext(db, ticketId))) {
    out[name] = isSnapshotInput(name)
      ? snapshotDigest(db, ticketId, name)
      : outputDigest(db, ticketId, name);
  }
  return out;
}

/** Input names whose digest differs, or that are present on one side only, sorted. */
export function changedInputs(
  recorded: Record<string, string>,
  current: Record<string, string>,
): string[] {
  return [...new Set([...Object.keys(recorded), ...Object.keys(current)])]
    .filter((n) => recorded[n] !== current[n])
    .sort();
}

/** Called inside the success transaction (spec §5.2). `outputDigest` is computed before it. */
export function recordStepManifest(
  db: Database,
  ticketId: number,
  stepId: number,
  row: StepRow,
  outputDigest: string | null,
): void {
  if (row.fileOutput && outputDigest === null)
    throw new Error(`${row.stepKey} succeeded without the digest of its file output`);
  const manifest = currentManifest(db, ticketId, row);
  recordManifest(db, stepId, {
    manifest,
    fingerprint: digestValue(manifest),
    outputDigest: row.fileOutput ? outputDigest : null,
    scheme: FINGERPRINT_SCHEME,
  });
}

export function planDigestFromResult(result: unknown): string {
  const d = (result as { planDigest?: unknown } | null)?.planDigest;
  if (typeof d !== "string") throw new Error("design:dispatch succeeded without a plan digest");
  return d;
}
```

`src/db/repos/workflow-step.ts`, after `markSucceeded`:

```ts
/** The manifest a design table step's success was computed from (ENG-477 §5.2). */
export function recordManifest(
  db: Database,
  id: number,
  m: { manifest: Record<string, string>; fingerprint: string; outputDigest: string | null; scheme: number },
): void {
  db.query(
    `UPDATE workflow_step
       SET input_manifest = $m, input_fingerprint = $f, output_digest = $o, fingerprint_scheme = $s,
           updated_at = $now
     WHERE id = $id`,
  ).run({
    $m: JSON.stringify(m.manifest),
    $f: m.fingerprint,
    $o: m.outputDigest,
    $s: m.scheme,
    $now: nowUtc(),
    $id: id,
  });
}
```

- [ ] **Step 5: The registry commit, the journal's result, and advance**

`src/daemon/step-registry.ts`:

```ts
/** Writes a step's own database outputs inside its success transaction (spec §6.2), from the
 *  handler's result, before any verdict reads them. */
export type StepCommit = (db: Database, ticketId: number, result: unknown) => void;

export class StepRegistry {
  constructor(readonly synchronize: (db: Database, ticketId: number) => void = () => {}) {}

  private readonly handlers = new Map<string, StepHandler>();
  private readonly commits = new Map<string, StepCommit>();

  register(handlerKey: string, handler: StepHandler, opts?: { commit?: StepCommit }): void {
    if (this.handlers.has(handlerKey)) {
      throw new Error(`StepRegistry: handlerKey '${handlerKey}' already registered`);
    }
    this.handlers.set(handlerKey, handler);
    if (opts?.commit) this.commits.set(handlerKey, opts.commit);
  }

  resolve(handlerKey: string): StepHandler | undefined {
    return this.handlers.get(handlerKey);
  }

  resolveCommit(handlerKey: string): StepCommit | undefined {
    return this.commits.get(handlerKey);
  }

  has(handlerKey: string): boolean {
    return this.handlers.has(handlerKey);
  }
}
```

`src/engine/step-journal.ts`: line 54 `onSucceed?: (step: steps.WorkflowStepRow, result: unknown) => void;` and line 152 `params.onSucceed?.(current, result);`.

`src/dispatch/handlers.ts` `design:dispatch` (lines 526-541):

```ts
  registry.register("design:dispatch", async (ctx: HandlerContext) => {
    await environmentGate(ctx);
    const outcome = await runAgentDispatch(
      ctx,
      depsFor(ctx, deps, deps.timeoutMs ?? DESIGN_TIMEOUT_MS),
      {
        handlerKey: "design:dispatch",
        template: DESIGN_TEMPLATE,
        vars: designVars(ctx.ticket, deps.profile, designFeedback(ctx.db, ctx.ticket.id)),
        commitScope: planScope,
        postcondition: ({ worktreePath }) => {
          if (!hasTicketPlan(join(worktreePath, "docs", "plans"), ctx.ticket.ident)) {
            throw new Error(
              "design:dispatch postcondition: no plan for this ticket under docs/plans/",
            );
          }
        },
      },
    );
    // spec §5.3: the plan's digest at the branch head, read through git before the success
    // transaction (anything slow is computed before it, §5.2).
    const { repoPath, branch } = worktreeFor(ctx, deps);
    const planFiles = ticketPlanFilesAt(repoPath, branch, ctx.ticket.ident);
    if (planFiles.length === 0) {
      // The postcondition found the plan in the worktree, but git has none at the branch head
      // (an ignored docs/plans/, say). The digest of nothing never changes, so every later plan
      // edit would go unseen. Operator ruling, 2026-10-10 (spec §5.3): fail at once without a
      // retry (a retry writes the same ignored file), and escalate with what to change.
      throw new StepPrerequisiteError(
        `the plan for ${ctx.ticket.ident} is not committed at ${branch}: Styre reads the plan from git, so docs/plans/ must be committed. If docs/plans/ is ignored, remove docs/plans/ from .gitignore (or the rule that ignores it), commit that on the ticket branch, then resume with --accept-head (the commit moves the branch HEAD).`,
      );
    }
    return { ...outcome, planDigest: planDigestOf(planFiles) };
  });
```

(import `planDigestOf` and `ticketPlanFilesAt` from `../daemon/design-digests.ts`).

`src/daemon/advance.ts`: imports `ensureDesignTableChecked, stepRow` from `./design-graph.ts`, `planDigestFromResult, recordStepManifest` from `./design-digests.ts`, `requireSnapshot` from `./design-inputs.ts`, `type WorkflowStepRow` from `../db/repos/workflow-step.ts`. After `const handler = registry.resolve(...)` and its check (line 184):

```ts
    // A design table step needs the table checked and the snapshot present before it may run
    // (spec §3.1, §5.2). Thrown here, outside the step's try: a missing snapshot is a defect, not a
    // step failure to retry.
    const row = stepRow(d.stepKey);
    if (row) {
      ensureDesignTableChecked();
      requireSnapshot(db, ticketId);
    }
    const commit = registry.resolveCommit(d.handlerKey);
```

and replace the `onSucceed:` property (lines 211-225) with:

```ts
        onSucceed:
          commit || row || VERDICT_BEARING_STEPS.has(d.stepKey)
            ? (step: WorkflowStepRow, result: unknown) => {
                // In this order (spec §6.2): the step's own rows, then its manifest, then any
                // verdict that reads those rows.
                commit?.(db, ticketId, result);
                if (row) {
                  recordStepManifest(
                    db,
                    ticketId,
                    step.id,
                    row,
                    row.fileOutput ? planDigestFromResult(result) : null,
                  );
                }
                if (!VERDICT_BEARING_STEPS.has(d.stepKey)) return;
                const cfg = opts?.config ?? DEFAULT_RUNTIME_CONFIG;
                verdictBox.value =
                  d.stepKey === "checks:classify"
                    ? applyChecksVerdict(db, ticketId, { stepKey: d.stepKey })
                    : d.stepKey === "verify:checks-gate"
                      ? applyAcCheckGateVerdict(db, ticketId, { stepKey: d.stepKey })
                      : d.stepKey === "checks:arbitrate"
                        ? applyArbiterVerdict(db, ticketId, { stepKey: d.stepKey })
                        : d.stepKey === "checks:reauthor"
                          ? applyReauthorVerdict(db, ticketId, { stepKey: d.stepKey })
                          : applyReviewVerdict(db, ticketId, cfg, { stepKey: d.stepKey });
              }
            : undefined,
```

- [ ] **Step 6: Update the existing mocks and direct ticket inserts**

Every `registry.register("design:dispatch", ...)` mock listed in **Files** that returns normally gets `planDigest: EMPTY_PLAN_DIGEST` in its returned object (import `EMPTY_PLAN_DIGEST` from `src/daemon/design-digests.ts`); for example `test/helpers/skeleton-registry.ts:19` becomes `r.register("design:dispatch", () => ({ plan: "ok", planDigest: EMPTY_PLAN_DIGEST }));` and a mock that returns `{}` returns `{ planDigest: EMPTY_PLAN_DIGEST }`. Mocks that throw stay as they are.

In `test/daemon/loop.test.ts` and `test/lifecycle/e2e-interrupt.test.ts`, right after each direct `insertTicket(...)` add:

```ts
captureSnapshot(db, ticketId, {
  profile: TEST_PROFILE,
  unusableComponents: [],
  nonPrimaryComponents: [],
  config: DEFAULT_RUNTIME_CONFIG,
});
```

(importing `captureSnapshot` from `src/daemon/design-inputs.ts`, `TEST_PROFILE` from `test/helpers/db.ts`, `DEFAULT_RUNTIME_CONFIG` from `src/config/runtime-config.ts`; use that file's own variable name for `db`).

`test/daemon/loop.test.ts`, `tick respects the maxConcurrent (K) cap` (lines 36-43), does not keep the ids of the two tickets it inserts, and with K=2 over three ready tickets either may be stepped: keep both, `const eng2 = insertTicket(db, { projectId, ident: "ENG-2" });` and `const eng3 = insertTicket(db, { projectId, ident: "ENG-3" });`, and capture the snapshot above for each (`for (const ticketId of [eng2, eng3]) captureSnapshot(db, ticketId, {...});`). `makeTestDb` already captured one for `ENG-1`.

One difference in `test/lifecycle/e2e-interrupt.test.ts`: its `setUp` builds the run's own `profile` (the `parseProfile({...})` after `seed(...)`). Move that `const profile = parseProfile({...})` above `insertTicket`, and capture with `profile: profile` instead of `TEST_PROFILE`. Its design stage case (Task 13) resumes with that profile; a snapshot of another profile would read as an edit at resume and rerun design work under the parking runner.

- [ ] **Step 7: Move the tests that seed a digestless `design:dispatch` onto real steps**

From this task `design:extract` and `design:review` record a manifest whose `plan` input is `design:dispatch`'s recorded digest, and `outputDigest("plan")` throws when a test marked `design:dispatch` succeeded by hand. Spec §8: nothing is set up by writing step rows directly. So these tests reach their step through the real design steps, here, with a helper defined in this task.

Append to `test/helpers/design-steps.ts` (add `getTicket` to its `ticket.ts` import, and `type ScriptUnit` and `unitsOf` to its `./design-script.ts` import):

```ts
/** For the existing tests that used to seed rows (spec §8): run the real design steps, with a
 *  scripted agent, until `target` is the next step. `target` is a design table step or
 *  `checks:dispatch`, the first step after the table. Uses the caller's profile, worktree root and
 *  mode (`inPlace`), so the caller's own registry then finds the same worktree or checkout. `units`
 *  is what the scripted `design:extract` returns. */
export async function reachDesignStep(opts: {
  db: Database;
  ticketId: number;
  profile: Profile;
  worktreeRoot: string;
  target: string;
  units?: ScriptUnit[];
  config?: RuntimeConfig;
  inPlace?: boolean;
}): Promise<ScriptCalls> {
  const ident = getTicket(opts.db, opts.ticketId)?.ident ?? "ENG-1";
  const calls = newCalls();
  const units = opts.units ?? unitsOf(2, { behavioral: false, dir: "src", ext: "ts" });
  const script = defaultScript({ ident, units: () => units });
  const registry = buildDispatchRegistry({
    runner: scriptedRunner(script, calls),
    agentConfig: DEFAULT_AGENT_CONFIG,
    profile: opts.profile,
    worktreeRoot: opts.worktreeRoot,
    inPlace: opts.inPlace ?? false,
  });
  await driveUntil(
    { db: opts.db, ticketId: opts.ticketId, registry, config: opts.config ?? DEFAULT_RUNTIME_CONFIG },
    atStep(opts.target),
    20,
  );
  return calls;
}
```

Everything it calls exists by now: `makeTestDb`'s snapshot and `defaultScript`/`scriptedRunner`/`unitsOf`/`ADDRESSED_CDOT` (Task 7), the manifest recording and the plan digest (this task). The scripted extract answers with every CDOT section addressed, so it passes `validateCdotImpact` under a profile whose runtime context is left at its default.

The design handler tests: in each of `test/dispatch/design-extract.test.ts`, `design-extract-retry-feedback.test.ts`, `completeness-e2e.test.ts`, `design-review-e2e.test.ts` and `design-review-handler.test.ts`:
1. Split the file's `registryFor(repo, runner, ...extra)`: move its `parseProfile({...})` argument, unchanged, into `function profileFor(repo: string, ...extra)` with the same extra parameters, and make `registryFor` call `profileFor(repo, ...extra)`.
2. Give each repository one worktree root, shared by the seeder and the test's registry (PR #154 left each `registryFor` minting a new one per call with `makeTempDir(...)`, which a registry built after the seeder could not share):

```ts
const roots = new Map<string, string>();
function rootFor(repo: string): string {
  let root = roots.get(repo);
  if (root === undefined) {
    root = makeTempDir("styre-wtroot-");
    roots.set(repo, root);
  }
  return root;
}
```

and in `registryFor` replace `worktreeRoot: makeTempDir("...")` with `worktreeRoot: rootFor(repo)` (the file already imports `makeTempDir` from `../helpers/temp.ts`).
3. Replace the seeder with real steps (import `reachDesignStep` from `../helpers/design-steps.ts`, and `unitsOf` and `type ScriptUnit` from `../helpers/design-script.ts` where used):

```ts
async function readyForExtract(db: ReturnType<typeof makeTestDb>["db"], ticketId: number, repo: string): Promise<void> {
  await reachDesignStep({ db, ticketId, profile: profileFor(repo), worktreeRoot: rootFor(repo), target: "design:extract" });
}
```

`readyForDesignReview` keeps the units the file seeded (the scripted extract writes them; a planned unit names at least one file, so each gets one):

```ts
// design-review-e2e.test.ts: the two backend units it seeded, neither behavioural
const REVIEW_UNITS: ScriptUnit[] = unitsOf(2, { behavioral: false, dir: "src", ext: "ts" }).map((u) => ({
  ...u,
  verify_check_types: ["test"],
}));
// design-review-handler.test.ts: the same first unit, and its docs unit as seeded
const REVIEW_UNITS: ScriptUnit[] = [
  { ...unitsOf(1, { behavioral: false, dir: "src", ext: "ts" })[0], verify_check_types: ["test"] },
  {
    seq: 2,
    kind: "docs",
    title: "Release note (plan Task 3)",
    description: "Document enum serialization",
    behavioral: false,
    test_plan: null,
    files_to_touch: ["docs/releases/3.0.txt"],
    verify_check_types: ["test"],
    depends_on: [],
  },
];

async function readyForDesignReview(db: ReturnType<typeof makeTestDb>["db"], ticketId: number, repo: string): Promise<void> {
  await reachDesignStep({
    db,
    ticketId,
    profile: profileFor(repo),
    worktreeRoot: rootFor(repo),
    target: "design:review",
    units: REVIEW_UNITS,
  });
}
```

(`readyForDesignReview` no longer calls `setTicketTrack`: two units size to `full`.)
4. At every call site, `readyForX(db, ticketId);` becomes `await readyForX(db, ticketId, repo);`. In the `design-extract.test.ts` cases that pass `rc` or `pattern` to `registryFor`, pass the same values to `profileFor` inside `readyForExtract` by adding the same optional parameters to it and at those call sites.
5. `design-review-e2e.test.ts` Flow 4 (`fast-track ticket ... WITHOUT ever creating design:review step`, lines 271-278: the comment, the `insertPending` and the `UPDATE`): replace the hand seeded `design:dispatch` row with `await readyForExtract(db, ticketId, repo);` (add `readyForExtract`, as above, to that file). Its runner's first call is then `design:extract`, as its comments expect; provision has already run.
5a. `design-size-e2e.test.ts`: its `readyForSize` (lines 45-60) marks `design:dispatch` and `design:extract` succeeded by hand, and two of its flows then run the real `design:review`, whose manifest needs the plan digest. Apply items 1, 2, 4 and 6, with this seeder, which keeps the units it seeded (`backend` units that are not behavioural, with `verify_check_types: ["test"]`); the hand marked `design:extract` row goes with it, and its three call sites (lines 86, 147, 223) become `await readyForSize(db, ticketId, repo, <the same count>);`:

```ts
async function readyForSize(
  db: ReturnType<typeof makeTestDb>["db"],
  ticketId: number,
  repo: string,
  unitCount: number,
): Promise<void> {
  await reachDesignStep({
    db,
    ticketId,
    profile: profileFor(repo),
    worktreeRoot: rootFor(repo),
    target: "design:size",
    units: unitsOf(unitCount, { behavioral: false, dir: "src", ext: "ts" }).map((u) => ({
      ...u,
      verify_check_types: ["test"],
    })),
  });
}
```
6. Remove the imports these changes leave unused (`insertPending`, `setTicketTrack`, `insertWorkUnit`, `getByKey`, wherever no other use remains): `tsconfig.json` sets `noUnusedLocals`.

`test/daemon/advance.test.ts`, `design:review step with blocking plan finding → outcome loopback and stage design`: replace its seeding (`seedProvisionDone`, `setTicketStage`, `setTicketTrack`, the `design:dispatch` row, the work unit) with

```ts
  const repo = gitRepo();
  db.query("UPDATE project SET target_repo = ? WHERE id = ?").run(repo, projectId);
  const profile = parseProfile({
    slug: "test-project",
    targetRepo: repo,
    components: [{ name: "app", kind: "node", paths: ["**"], commands: { test: "bun test" } }],
    runtimeContext: ABSENT_RC,
  });
  await reachDesignStep({
    db,
    ticketId,
    profile,
    worktreeRoot: makeTempDir("styre-adv-wt-"),
    target: "design:review",
  });
```

(destructure `projectId` from `makeTestDb()`, import `STEP_TEST_TIMEOUT_MS`, `gitRepo`, `reachDesignStep` from `../helpers/design-steps.ts`, `ABSENT_RC` from `../helpers/design-script.ts`, `makeTempDir` from `../helpers/temp.ts`, and `parseProfile`, and pass `STEP_TEST_TIMEOUT_MS` as that test's timeout: it now runs git. The file's other imports keep other users at this point.)

- [ ] **Step 7a: Record the scheme 1 pin, once (before Step 8, which runs `test/daemon`)**

Run: `perl -e 'alarm 600; exec @ARGV' bun test test/daemon/fingerprint-pin.test.ts`
Expected: FAIL, `expect(received).toEqual(expected)` with `expected` empty and `received` holding 23 digests (the 10 snapshot rows as `captureSnapshot` recorded them, 3 outputs, and the sorted declared input list of each of the 5 table steps with grading off and on). Copy the received object, exactly as printed, into `PINNED[1]` (replacing the comment), rerun: PASS. From here on the pin is never edited: a change that alters it bumps `FINGERPRINT_SCHEME` and adds `PINNED[2]`.

- [ ] **Step 8: Run the tests and see them pass**

Run: `perl -e 'alarm 600; exec @ARGV' bun test test/daemon test/engine test/dispatch/design-extract.test.ts test/dispatch/design-extract-retry-feedback.test.ts test/dispatch/completeness-e2e.test.ts test/dispatch/design-review-e2e.test.ts test/dispatch/design-review-handler.test.ts test/dispatch/design-size-e2e.test.ts`
Expected: PASS.

- [ ] **Step 9: Break it on purpose, see it fail, restore**

0. In `digestWorkUnits`, rename the `needsDocs` key to `needs_docs`: `fingerprint-pin.test.ts` fails on `output workUnits` (as would any change a recorded digest depends on). Restore. Then set `FINGERPRINT_SCHEME = 2` in `canonical.ts`: the pin test fails (no pin for scheme 2 yet). Restore.
1. Add `status: u.status,` to the mapped unit in `digestWorkUnits`: the units digest test fails. Restore.
2. Remove the `if (row) { recordStepManifest(...) }` block from `onSucceed`: the manifest recording tests fail. Restore.
3. Remove `requireSnapshot(db, ticketId);`: the "does not run without a snapshot" test fails (the handler runs, then the step fails inside its transaction and is retried instead of stopping the run). Restore.
3a. In the `design:dispatch` handler, drop the `planFiles.length === 0` check: `design:dispatch escalates at once, retrying nothing, when its plan is not committed ...` fails (the step succeeds with the digest of nothing). Restore. Throw a plain `Error` there instead of `StepPrerequisiteError`: the same test fails (the outcome is `retry`, and the agent is called again). Restore.
4. In `test/dispatch/design-extract.test.ts`, put back the old `readyForExtract` body (a `design:dispatch` row marked succeeded by hand): its tests fail, because `design:extract`'s success transaction throws `the plan has no recorded digest` and the step is marked failed. Restore.

- [ ] **Step 10: Run the whole suite, then commit**

Run: `perl -e 'alarm 600; exec @ARGV' bun test`
Expected: PASS.

```bash
git add src/daemon/design-digests.ts src/daemon/step-registry.ts src/engine/step-journal.ts src/db/repos/workflow-step.ts src/dispatch/plan-frontmatter.ts src/dispatch/worktree.ts src/dispatch/handlers.ts src/daemon/advance.ts test
git commit -m "feat(eng-477): record each design step's input manifest and the plan digest at success" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: `invalidateSteps`: note event, history, reset and output clearing in one transaction

**Files:**
- Create: `src/daemon/invalidate.ts`, `src/daemon/design-outputs.ts` (the clearing rules; Task 11 adds the commits), `src/db/repos/step-history.ts`
- Modify: `src/db/repos/workflow-step.ts` (add `resetForInvalidate`), `src/db/repos/ticket.ts` (add `clearTicketTrack` after `setTicketTrack`, line 104)
- Modify: `src/daemon/resolver.ts:12-25` (the `invalidate` descriptor), `src/daemon/advance.ts:118-135` (apply it)
- Modify: `src/dispatch/provision.ts:258-283` (`resetProvision` and `resetProvisionIfManifestTouched` through `invalidateSteps`)
- Modify: `src/db/repos/review-finding.ts` (add `listByTicket` after `listOpenByTicket`, which ends at line 98)
- Test: `test/daemon/invalidate.test.ts`

**Interfaces:**
- Consumes: `DesignStepKey`, `isTableStep` (Task 6); `makeDesignTicket`, `driveUntil`, `atStep` (Task 7); `WorkflowStepRow` with `generation` (Task 4).
- Produces:
  - `listByTicket(db, ticketId): ReviewFindingRow[]` in `src/db/repos/review-finding.ts`
  - `type InvalidateCause = "inputs" | "feedback" | "worktree-recreated" | "manifest-touched"`
  - `interface InvalidateReason { cause: InvalidateCause; changed?: string[] }`
  - `invalidateSteps(db, ticketId, stepKeys: readonly DesignStepKey[], reason: InvalidateReason): { eventId: number; generations: Partial<Record<DesignStepKey, number>> }` (the generation after the bump, per step that had a row)
  - `CLEAR_OUTPUTS: Record<DesignStepKey, (db: Database, ticketId: number) => void>`
  - `archiveStep(db, step: WorkflowStepRow, eventId: number): void`, `listStepHistory(db, ticketId, stepKey?: string): StepHistoryRow[]`, `interface StepHistoryRow`
  - `resetForInvalidate(db, id): void`, `clearTicketTrack(db, id): void`
  - `StepDescriptor` gains `{ kind: "invalidate"; stepKeys: DesignStepKey[]; reason: InvalidateReason }`
  - `resetProvision(db, ticketId, cause?: "worktree-recreated" | "manifest-touched"): void`

- [ ] **Step 1: Write the failing test**

```ts
// test/daemon/invalidate.test.ts
import { expect, test } from "bun:test";
import { invalidateSteps } from "../../src/daemon/invalidate.ts";
import { listByTicket as listEvents } from "../../src/db/repos/event-log.ts";
import { listByTicket as listFindings } from "../../src/db/repos/review-finding.ts";
import { listStepHistory } from "../../src/db/repos/step-history.ts";
import { getTicket, setNeedsDocs } from "../../src/db/repos/ticket.ts";
import { insertWorkUnit, listByTicket as listUnits } from "../../src/db/repos/work-unit.ts";
import { getByKey } from "../../src/db/repos/workflow-step.ts";
import { resetProvision, resetProvisionIfManifestTouched } from "../../src/dispatch/provision.ts";
import {
  STEP_TEST_TIMEOUT_MS,
  atStep,
  driveUntil,
  makeDesignTicket,
} from "../helpers/design-steps.ts";

/** A ticket whose design ran for real: two behavioural units, full track, one minor plan finding
 *  tied to unit 1, a reconcile unit, needs_docs set. */
async function designedTicket() {
  const t = makeDesignTicket({
    script: {
      planFindings: () => [
        {
          severity: "minor",
          category: "clarity",
          location: "plan:Unit 1",
          rationale: "name the file",
          factors: null,
          deferral_candidate: false,
          work_unit_seq: 1,
        },
      ],
    },
  });
  await driveUntil(t, atStep("checks:dispatch"));
  insertWorkUnit(t.db, {
    ticketId: t.ticketId,
    seq: 3,
    kind: "reconcile",
    origin: "reconcile",
    dependsOn: [1, 2],
  });
  setNeedsDocs(t.db, t.ticketId, 1);
  return t;
}

test(
  "invalidating design:extract archives, resets, clears every unit and needs_docs, and keeps the plan findings detached",
  async () => {
    const t = await designedTicket();
    const before = getByKey(t.db, t.ticketId, "design:extract");
    const { eventId, generations } = invalidateSteps(t.db, t.ticketId, ["design:extract"], {
      cause: "inputs",
      changed: ["plan"],
    });
    expect(generations).toEqual({ "design:extract": 1 });
    expect(listUnits(t.db, t.ticketId)).toEqual([]); // reconcile unit included
    expect(getTicket(t.db, t.ticketId)?.needs_docs).toBe(0);
    const findings = listFindings(t.db, t.ticketId).filter((f) => f.review_kind === "plan");
    expect(findings.length).toBe(1);
    expect(findings[0].work_unit_id).toBeNull();
    const after = getByKey(t.db, t.ticketId, "design:extract");
    expect(after).toMatchObject({
      status: "pending",
      attempt: 0,
      result_json: null,
      error_json: null,
      input_manifest: null,
      input_fingerprint: null,
      output_digest: null,
      fingerprint_scheme: null,
      generation: 1,
    });
    const [h] = listStepHistory(t.db, t.ticketId, "design:extract");
    expect(h).toMatchObject({
      event_id: eventId,
      status: "succeeded",
      attempt: before?.attempt,
      input_manifest: before?.input_manifest,
      generation: 0,
    });
    const note = listEvents(t.db, t.ticketId).find((e) => e.id === eventId);
    expect(note?.kind).toBe("note");
    expect(note?.reason).toBe("invalidated");
    expect(JSON.parse(note?.payload_json ?? "{}")).toEqual({
      event: "invalidated",
      stepKeys: ["design:extract"],
      cause: "inputs",
      changed: ["plan"],
    });
    expect(listEvents(t.db, t.ticketId).some((e) => e.kind === "loopback")).toBe(false);
  },
  STEP_TEST_TIMEOUT_MS,
);

test(
  "design:size clears the track; provision, design:dispatch and design:review clear nothing",
  async () => {
    const t = await designedTicket();
    invalidateSteps(t.db, t.ticketId, ["design:size"], { cause: "inputs", changed: ["workUnits"] });
    expect(getTicket(t.db, t.ticketId)?.track).toBeNull();
    const units = listUnits(t.db, t.ticketId).length;
    invalidateSteps(t.db, t.ticketId, ["provision", "design:dispatch", "design:review"], {
      cause: "feedback",
    });
    expect(listUnits(t.db, t.ticketId).length).toBe(units);
    expect(listFindings(t.db, t.ticketId).length).toBe(1);
    for (const k of ["provision", "design:dispatch", "design:review"]) {
      expect(getByKey(t.db, t.ticketId, k)?.generation).toBe(1);
    }
  },
  STEP_TEST_TIMEOUT_MS,
);

test(
  "resetProvision and the manifest touch hook go through the same function, with their causes",
  async () => {
    const t = await designedTicket();
    resetProvision(t.db, t.ticketId);
    await driveUntil(t, atStep("checks:dispatch")); // provision reruns and succeeds again
    resetProvisionIfManifestTouched(t.db, t.ticketId, ["Gemfile.lock"]);
    const causes = listStepHistory(t.db, t.ticketId, "provision").map((h) => {
      const note = listEvents(t.db, t.ticketId).find((e) => e.id === h.event_id);
      return JSON.parse(note?.payload_json ?? "{}").cause;
    });
    expect(causes).toEqual(["worktree-recreated", "manifest-touched"]);
    expect(getByKey(t.db, t.ticketId, "provision")?.generation).toBe(2);
  },
  STEP_TEST_TIMEOUT_MS,
);

test(
  "only design table steps can be invalidated",
  async () => {
    const t = makeDesignTicket();
    expect(() =>
      invalidateSteps(t.db, t.ticketId, ["checks:dispatch" as never], { cause: "inputs" }),
    ).toThrow("not a design table step");
  },
  STEP_TEST_TIMEOUT_MS,
);
```

Add `listByTicket` to `src/db/repos/review-finding.ts` (it exports only `getById`, `insertFinding`, `listByDispatch`, `listOpenByTicket`, `latestDispatchForStep` and `setStatus` today), after `listOpenByTicket`:

```ts
export function listByTicket(db: Database, ticketId: number): ReviewFindingRow[] {
  return db
    .query<ReviewFindingRow, [number]>(`SELECT ${COLS} FROM review_finding WHERE ticket_id = ? ORDER BY id`)
    .all(ticketId);
}
```

- [ ] **Step 2: Run it and see it fail**

Run: `perl -e 'alarm 600; exec @ARGV' bun test test/daemon/invalidate.test.ts`
Expected: FAIL with `Cannot find module '../../src/daemon/invalidate.ts'`.

- [ ] **Step 3: Write the repositories**

```ts
// src/db/repos/step-history.ts
import type { Database } from "bun:sqlite";
import { nowUtc } from "../../util/time.ts";
import type { WorkflowStepRow } from "./workflow-step.ts";

export interface StepHistoryRow {
  id: number;
  step_id: number;
  ticket_id: number;
  event_id: number;
  step_key: string;
  status: string;
  attempt: number;
  result_json: string | null;
  error_json: string | null;
  input_manifest: string | null;
  input_fingerprint: string | null;
  output_digest: string | null;
  fingerprint_scheme: number | null;
  generation: number;
  started_at: string | null;
  ended_at: string | null;
  archived_at: string;
}

const COLS =
  "id, step_id, ticket_id, event_id, step_key, status, attempt, result_json, error_json, input_manifest, " +
  "input_fingerprint, output_digest, fingerprint_scheme, generation, started_at, ended_at, archived_at";

/** Copy `step` as it is now, before an invalidation resets it (spec §6 step 2). */
export function archiveStep(db: Database, step: WorkflowStepRow, eventId: number): void {
  db.query(
    `INSERT INTO workflow_step_history
       (step_id, ticket_id, event_id, step_key, status, attempt, result_json, error_json, input_manifest,
        input_fingerprint, output_digest, fingerprint_scheme, generation, started_at, ended_at, archived_at)
     VALUES ($sid, $tid, $eid, $key, $status, $attempt, $result, $error, $manifest,
        $fingerprint, $output, $scheme, $generation, $started, $ended, $now)`,
  ).run({
    $sid: step.id,
    $tid: step.ticket_id,
    $eid: eventId,
    $key: step.step_key,
    $status: step.status,
    $attempt: step.attempt,
    $result: step.result_json,
    $error: step.error_json,
    $manifest: step.input_manifest,
    $fingerprint: step.input_fingerprint,
    $output: step.output_digest,
    $scheme: step.fingerprint_scheme,
    $generation: step.generation,
    $started: step.started_at,
    $ended: step.ended_at,
    $now: nowUtc(),
  });
}

export function listStepHistory(
  db: Database,
  ticketId: number,
  stepKey?: string,
): StepHistoryRow[] {
  return stepKey === undefined
    ? db
        .query<StepHistoryRow, [number]>(
          `SELECT ${COLS} FROM workflow_step_history WHERE ticket_id = ? ORDER BY id`,
        )
        .all(ticketId)
    : db
        .query<StepHistoryRow, [number, string]>(
          `SELECT ${COLS} FROM workflow_step_history WHERE ticket_id = ? AND step_key = ? ORDER BY id`,
        )
        .all(ticketId, stepKey);
}
```

`src/db/repos/workflow-step.ts`, after `resetAttempt`:

```ts
/** spec §6 step 3: a fresh round in a new generation, keeping nothing the step recorded. */
export function resetForInvalidate(db: Database, id: number): void {
  db.query(
    `UPDATE workflow_step
       SET status = 'pending', attempt = 0, result_json = NULL, error_json = NULL, pid = NULL,
           input_manifest = NULL, input_fingerprint = NULL, output_digest = NULL,
           fingerprint_scheme = NULL, generation = generation + 1, updated_at = $now
     WHERE id = $id`,
  ).run({ $now: nowUtc(), $id: id });
}
```

`src/db/repos/ticket.ts`, after `setTicketTrack`:

```ts
/** design:size's output cleared by an invalidation (spec §6.1). */
export function clearTicketTrack(db: Database, id: number): void {
  db.query("UPDATE ticket SET track = NULL, updated_at = $now WHERE id = $id").run({
    $now: nowUtc(),
    $id: id,
  });
}
```

- [ ] **Step 4: Write the clearing rules and `invalidateSteps`**

```ts
// src/daemon/design-outputs.ts
import type { Database } from "bun:sqlite";
import { clearTicketTrack, setNeedsDocs } from "../db/repos/ticket.ts";
import { deleteByTicket as deleteUnits } from "../db/repos/work-unit.ts";
import type { DesignStepKey } from "./design-graph.ts";

/** What an invalidation clears, per step (spec §6.1). */
export const CLEAR_OUTPUTS: Record<DesignStepKey, (db: Database, ticketId: number) => void> = {
  // reruns; nothing in the database
  provision: () => {},
  // the rerun revises the plan file in place
  "design:dispatch": () => {},
  "design:extract": (db, ticketId) => {
    // Every unit goes, reconcile units included (a stale one would collide on UNIQUE (ticket_id,
    // seq) or depend on units that no longer exist). Findings tied to a unit are detached first, so
    // the unit foreign key's cascade does not delete them: code findings as today, and plan
    // findings too (spec §6.1).
    db.query(
      "UPDATE review_finding SET work_unit_id = NULL WHERE ticket_id = ? AND work_unit_id IS NOT NULL",
    ).run(ticketId);
    deleteUnits(db, ticketId);
    setNeedsDocs(db, ticketId, 0);
  },
  "design:size": (db, ticketId) => clearTicketTrack(db, ticketId),
  // requiredPlanFindings already reads only the latest design:review dispatch
  "design:review": () => {},
};
```

```ts
// src/daemon/invalidate.ts
import type { Database } from "bun:sqlite";
import { appendEvent } from "../db/repos/event-log.ts";
import { archiveStep } from "../db/repos/step-history.ts";
import { getByKey, resetForInvalidate } from "../db/repos/workflow-step.ts";
import { type DesignStepKey, isTableStep } from "./design-graph.ts";
import { CLEAR_OUTPUTS } from "./design-outputs.ts";

export type InvalidateCause = "inputs" | "feedback" | "worktree-recreated" | "manifest-touched";

export interface InvalidateReason {
  cause: InvalidateCause;
  /** The input names whose digests changed (cause `inputs`). */
  changed?: string[];
}

/** Apply an invalidate (spec §6), in one transaction: one `note` event, reason `invalidated` (not
 *  a loopback, so v_rejection_counts and REVIEW_REPAIR_LIMIT do not count it); for each step, its
 *  row copied to workflow_step_history with that event's id, then reset to a fresh round in the
 *  next generation; then its outputs cleared (§6.1). Returns the event id and each step's new
 *  generation. The one function that invalidates a design table step. (recover() and the failure
 *  policy still return a running or failed step to pending; that is a retry of the same round, not
 *  an invalidation, and such a step holds no manifest.) */
export function invalidateSteps(
  db: Database,
  ticketId: number,
  stepKeys: readonly DesignStepKey[],
  reason: InvalidateReason,
): { eventId: number; generations: Partial<Record<DesignStepKey, number>> } {
  for (const key of stepKeys) {
    if (!isTableStep(key)) throw new Error(`invalidateSteps: '${key}' is not a design table step`);
  }
  return db.transaction(() => {
    const event = appendEvent(db, {
      ticketId,
      kind: "note",
      reason: "invalidated",
      payload: {
        event: "invalidated",
        stepKeys: [...stepKeys],
        cause: reason.cause,
        changed: reason.changed ?? [],
      },
    });
    const generations: Partial<Record<DesignStepKey, number>> = {};
    for (const key of stepKeys) {
      const step = getByKey(db, ticketId, key);
      if (step) {
        archiveStep(db, step, event.id);
        resetForInvalidate(db, step.id);
        generations[key] = step.generation + 1;
      }
      CLEAR_OUTPUTS[key](db, ticketId);
    }
    return { eventId: event.id, generations };
  })();
}
```

- [ ] **Step 5: The descriptor, its interpreter, and `resetProvision`**

`src/daemon/resolver.ts`: import `type DesignStepKey` from `./design-graph.ts` and `type InvalidateReason` from `./invalidate.ts`; add to `StepDescriptor`:

```ts
  | { kind: "invalidate"; stepKeys: DesignStepKey[]; reason: InvalidateReason }
```

`src/daemon/advance.ts`, import `invalidateSteps` from `./invalidate.ts`; after the `mark-verified` branch (line 136):

```ts
    if (d.kind === "invalidate") {
      // The resolver only detected the mismatch; the reset happens here, in one transaction
      // (spec §6). The next pass runs the invalidated step.
      invalidateSteps(db, ticketId, d.stepKeys, d.reason);
      continue;
    }
```

`src/dispatch/provision.ts`: import `invalidateSteps` from `../daemon/invalidate.ts` (remove `resetToPending`, `resetAttempt` from its imports if no longer used), and replace `resetProvision` and `resetProvisionIfManifestTouched`:

```ts
/** Reset a succeeded `provision` through the invalidate function (spec §6), so it leaves history
 *  and opens a new generation: on resume when the worktree was recreated (its installed deps are
 *  gone), and from implement:dispatch when a diff touched a dependency manifest. A no-op unless
 *  provision is currently `succeeded`. */
export function resetProvision(
  db: Database,
  ticketId: number,
  cause: "worktree-recreated" | "manifest-touched" = "worktree-recreated",
): void {
  const s = getByKey(db, ticketId, "provision");
  if (s && s.status === "succeeded") invalidateSteps(db, ticketId, ["provision"], { cause });
}

export function resetProvisionIfManifestTouched(
  db: Database,
  ticketId: number,
  changedFiles: string[],
): void {
  if (diffTouchesManifest(changedFiles)) resetProvision(db, ticketId, "manifest-touched");
}
```

- [ ] **Step 6: Run the tests and see them pass**

Run: `perl -e 'alarm 600; exec @ARGV' bun test test/daemon/invalidate.test.ts test/dispatch/provision.test.ts test/dispatch/checks-provision-reset.test.ts test/cli/park.test.ts`
Expected: PASS.

- [ ] **Step 7: Break it on purpose, see it fail, restore**

1. Remove the `UPDATE review_finding ...` statement from `CLEAR_OUTPUTS["design:extract"]`: the first test fails (the plan finding is deleted by the cascade). Restore.
2. Remove `archiveStep(db, step, event.id);`: the first test fails on the history row. Restore.
3. Make `resetProvision` call `resetToPending` again: the third test fails (no history, generation 0). Restore.

- [ ] **Step 8: Run the whole suite, then commit**

Run: `perl -e 'alarm 600; exec @ARGV' bun test`
Expected: PASS.

```bash
git add src/daemon/invalidate.ts src/daemon/design-outputs.ts src/db/repos/step-history.ts src/db/repos/workflow-step.ts src/db/repos/ticket.ts src/db/repos/review-finding.ts src/daemon/resolver.ts src/daemon/advance.ts src/dispatch/provision.ts test/daemon/invalidate.test.ts
git commit -m "feat(eng-477): invalidate design steps in one transaction with history and output clearing" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 11: Design handlers write their database outputs in the success transaction

**Files:**
- Modify: `src/daemon/design-outputs.ts` (add the commits)
- Modify: `src/dispatch/handlers.ts:543-661` (`design:extract`, `design:size`, `design:review` return their rows and register a commit)
- Test: `test/dispatch/design-commits.test.ts`

**Interfaces:**
- Consumes: `StepCommit`, `register(..., { commit })` (Task 9); `ExtractedWorkUnit` (`src/dispatch/extract-schema.ts:20`); `insertWorkUnit` with `origin` (Task 4); `insertFinding` (`src/db/repos/review-finding.ts:34`).
- Produces:
  - `interface ExtractResult { units: number; extracted: ExtractedWorkUnit[]; needsDocs: boolean }`; `writeExtractOutputs(db, ticketId, result: unknown): void`
  - `interface SizeResult { track: "fast" | "full"; graded: boolean; overall?: number }`; `writeSizeOutput(db, ticketId, result: unknown): void`
  - `interface PlanFindingInput { workUnitId: number | null; severity: string; category: string; factorsJson: string | null; deferralCandidate: 0 | 1; blocksShip: 0 | 1 | null; location: string | null; rationale: string }`; `interface ReviewResult { findings: number; blocking: number; dispatchId: string; filed: PlanFindingInput[] }`; `writePlanFindings(db, ticketId, result: unknown): void`

- [ ] **Step 1: Write the failing test**

```ts
// test/dispatch/design-commits.test.ts
import { expect, test } from "bun:test";
import { advanceOneStep } from "../../src/daemon/advance.ts";
import { StepRegistry } from "../../src/daemon/step-registry.ts";
import { listByTicket as listFindings } from "../../src/db/repos/review-finding.ts";
import { getTicket } from "../../src/db/repos/ticket.ts";
import { listByTicket as listUnits } from "../../src/db/repos/work-unit.ts";
import { getByKey } from "../../src/db/repos/workflow-step.ts";
import {
  STEP_TEST_TIMEOUT_MS,
  atStep,
  driveUntil,
  makeDesignTicket,
} from "../helpers/design-steps.ts";

/** The real registry, with one step's commit made to throw on its first call: the handler's work is
 *  done and returned, but the success transaction never commits (a crash at that point). */
function failFirstCommit(real: StepRegistry, handlerKey: string): StepRegistry {
  let failed = false;
  const wrapped = new StepRegistry(real.synchronize);
  for (const key of [
    "provision",
    "design:dispatch",
    "design:extract",
    "design:size",
    "design:review",
    "checks:dispatch",
    "checks:classify",
  ]) {
    const handler = real.resolve(key);
    if (!handler) continue;
    const commit = real.resolveCommit(key);
    wrapped.register(key, handler, {
      commit: (db, ticketId, result) => {
        if (key === handlerKey && !failed) {
          failed = true;
          throw new Error(`injected: the success transaction of ${key} did not commit`);
        }
        commit?.(db, ticketId, result);
      },
    });
  }
  return wrapped;
}

test(
  "a design:extract whose success did not commit leaves no units, and its rerun writes them once",
  async () => {
    const t = makeDesignTicket();
    await driveUntil(t, atStep("design:extract"));
    const registry = failFirstCommit(t.registry, "design:extract");
    const first = await advanceOneStep(t.db, t.ticketId, registry, { config: t.config });
    expect(first.kind).toBe("retry");
    expect(listUnits(t.db, t.ticketId)).toEqual([]);
    expect(getByKey(t.db, t.ticketId, "design:extract")?.status).not.toBe("succeeded");
    await driveUntil({ ...t, registry }, atStep("design:size"));
    expect(listUnits(t.db, t.ticketId).map((u) => u.seq)).toEqual([1, 2]); // no UNIQUE (ticket_id, seq) error
    expect(t.calls.counts["design:extract"]).toBe(2);
  },
  STEP_TEST_TIMEOUT_MS,
);

test(
  "design:size writes the track only when its success commits",
  async () => {
    const t = makeDesignTicket();
    await driveUntil(t, atStep("design:size"));
    const registry = failFirstCommit(t.registry, "design:size");
    await advanceOneStep(t.db, t.ticketId, registry, { config: t.config });
    expect(getTicket(t.db, t.ticketId)?.track).toBeNull();
    await advanceOneStep(t.db, t.ticketId, registry, { config: t.config });
    expect(getTicket(t.db, t.ticketId)?.track).toBe("full");
  },
  STEP_TEST_TIMEOUT_MS,
);

test(
  "design:review's findings are written before its verdict reads them, and only on success",
  async () => {
    const t = makeDesignTicket({
      script: {
        planFindings: () => [
          {
            severity: "critical",
            category: "feasibility",
            location: "plan:Unit 1",
            rationale: "not feasible",
            factors: null,
            deferral_candidate: false,
            // tied to no unit: until Task 14, today's redesign deletes the units with the findings
            // tied to them, and this test counts the plan finding after the loopback
            work_unit_seq: null,
          },
        ],
      },
    });
    await driveUntil(t, atStep("design:review"));
    const registry = failFirstCommit(t.registry, "design:review");
    await advanceOneStep(t.db, t.ticketId, registry, { config: t.config }); // commit fails: no rows
    expect(listFindings(t.db, t.ticketId)).toEqual([]);
    const outcome = await advanceOneStep(t.db, t.ticketId, registry, { config: t.config });
    expect(outcome).toEqual({ kind: "loopback", stepKey: "design:review" }); // the verdict saw the row
    expect(listFindings(t.db, t.ticketId).filter((f) => f.review_kind === "plan").length).toBe(1);
  },
  STEP_TEST_TIMEOUT_MS,
);
```

- [ ] **Step 2: Run it and see it fail**

Run: `perl -e 'alarm 600; exec @ARGV' bun test test/dispatch/design-commits.test.ts`
Expected: FAIL: the first test finds units after the failed commit (`expect(listUnits(...)).toEqual([])` receives two units), because extract still inserts them before `markSucceeded`.

- [ ] **Step 3: Write the commits**

Append to `src/daemon/design-outputs.ts`:

```ts
import { insertFinding } from "../db/repos/review-finding.ts";
import { setTicketTrack } from "../db/repos/ticket.ts";
import { insertWorkUnit } from "../db/repos/work-unit.ts";
import type { ExtractedWorkUnit } from "../dispatch/extract-schema.ts";

/** design:extract's result: its rows, written by writeExtractOutputs in the success transaction. */
export interface ExtractResult {
  units: number;
  extracted: ExtractedWorkUnit[];
  needsDocs: boolean;
}

export function writeExtractOutputs(db: Database, ticketId: number, result: unknown): void {
  const r = result as ExtractResult;
  for (const u of r.extracted) {
    insertWorkUnit(db, {
      ticketId,
      seq: u.seq,
      kind: u.kind,
      title: u.title,
      description: u.description,
      behavioral: u.behavioral ? 1 : 0, // the carry: classify explicitly, never default
      testPlan: u.test_plan,
      filesToTouch: u.files_to_touch,
      verifyCheckTypes: u.verify_check_types,
      dependsOn: u.depends_on,
      origin: "extract",
    });
  }
  setNeedsDocs(db, ticketId, r.needsDocs ? 1 : 0);
}

export interface SizeResult {
  track: "fast" | "full";
  graded: boolean;
  overall?: number;
}

export function writeSizeOutput(db: Database, ticketId: number, result: unknown): void {
  setTicketTrack(db, ticketId, (result as SizeResult).track);
}

export interface PlanFindingInput {
  workUnitId: number | null;
  severity: string;
  category: string;
  factorsJson: string | null;
  deferralCandidate: 0 | 1;
  blocksShip: 0 | 1 | null;
  location: string | null;
  rationale: string;
}

export interface ReviewResult {
  findings: number;
  blocking: number;
  dispatchId: string;
  filed: PlanFindingInput[];
}

/** design:review's rows, as rows of this step's dispatch (spec §3.1 rule 2), written before
 *  applyReviewVerdict reads them in the same transaction (spec §6.2). */
export function writePlanFindings(db: Database, ticketId: number, result: unknown): void {
  const r = result as ReviewResult;
  for (const f of r.filed) {
    insertFinding(db, {
      ticketId,
      reviewKind: "plan",
      dispatchId: r.dispatchId,
      workUnitId: f.workUnitId,
      severity: f.severity,
      category: f.category,
      factorsJson: f.factorsJson,
      deferralCandidate: f.deferralCandidate,
      blocksShip: f.blocksShip,
      location: f.location,
      rationale: f.rationale,
    });
  }
}
```

(merge the new `import` lines with the file's existing imports at the top: `setNeedsDocs` and `clearTicketTrack` are already imported from `../db/repos/ticket.ts`; add `setTicketTrack` there.)

- [ ] **Step 4: Return rows from the handlers and register the commits**

In `src/dispatch/handlers.ts` import `writeExtractOutputs, writePlanFindings, writeSizeOutput, type ExtractResult, type PlanFindingInput, type ReviewResult, type SizeResult` from `../daemon/design-outputs.ts`, and remove `insertWorkUnit`, `setNeedsDocs`, `setTicketTrack`, `insertFinding` from the imports if they have no other user.

`design:extract`: replace lines 570-588 (from `for (const u of parsed.value.units) {` through the registration's closing `});`) with:

```ts
    // Written by writeExtractOutputs inside the success transaction (spec §6.2): a crash before
    // markSucceeded leaves no partial units, so the rerun cannot hit UNIQUE (ticket_id, seq).
    const result: ExtractResult = {
      units: parsed.value.units.length,
      extracted: parsed.value.units,
      needsDocs: parsed.value.cdotImpact.documentation.applies,
    };
    return result;
  }, { commit: writeExtractOutputs });
```

`design:size` (lines 590-615):

```ts
  registry.register(
    "design:size",
    async (ctx: HandlerContext) => {
      const units = listUnits(ctx.db, ctx.ticket.id);
      if (!ctx.config.complexityGrading) {
        const off: SizeResult = { track: sizeTrack(units), graded: false }; // sprawl only, no agent
        return off;
      }
      // on: cold cheap-tier grader → daemon combines the grade with sprawl.
      const result = await runAgentDispatch(ctx, depsFor(ctx, deps, deps.timeoutMs ?? DESIGN_TIMEOUT_MS), {
        handlerKey: "design:size",
        template: DESIGN_COMPLEXITY_GRADE_TEMPLATE,
        vars: complexityGradeVars(ctx.ticket, deps.profile, units),
        postcondition: () => {}, // read-only: nothing commits
      });
      const parsed = extractSidecar(result.output, ComplexityGradeSchema);
      if (!parsed.ok) {
        throw new Error(`design:size grade sidecar ${parsed.reason}: ${parsed.detail}`);
      }
      const on: SizeResult = {
        track: combineTrack(units.length, parsed.value.overall),
        graded: true,
        overall: parsed.value.overall,
      };
      return on;
    },
    { commit: writeSizeOutput },
  );
```

`design:review`: replace lines 640-661 (from `let blocking = 0;` through the registration's closing `});`) with:

```ts
    const filed: PlanFindingInput[] = parsed.value.findings.map((f) => ({
      workUnitId: f.work_unit_seq === null ? null : (seqToId.get(f.work_unit_seq) ?? null),
      severity: f.severity,
      category: f.category,
      factorsJson: f.factors === null ? null : JSON.stringify(f.factors),
      deferralCandidate: f.deferral_candidate ? 1 : 0,
      blocksShip: computeBlocksShip(f.severity, f.deferral_candidate),
      location: f.location,
      rationale: f.rationale,
    }));
    const review: ReviewResult = {
      findings: filed.length,
      blocking: filed.filter((f) => f.blocksShip === 1).length,
      dispatchId: result.dispatchId,
      filed,
    };
    return review;
  }, { commit: writePlanFindings });
```

Check that nothing reads the old result shapes: `grep -rn '"design:extract"\|"design:size"\|"design:review"' src | grep -n result_json` must show no reader of `result_json` for these steps (the review step's `result_json` reader in `review-resume.ts:60` is for the code `review` step only).

- [ ] **Step 5: Run the tests and see them pass**

Run: `perl -e 'alarm 600; exec @ARGV' bun test test/dispatch/design-commits.test.ts test/dispatch/design-extract.test.ts test/dispatch/design-size.test.ts test/dispatch/design-size-e2e.test.ts test/dispatch/design-review-e2e.test.ts test/dispatch/design-review-handler.test.ts test/dispatch/design-extract-retry-feedback.test.ts`
Expected: PASS.

- [ ] **Step 6: Break it on purpose, see it fail, restore**

Move the `writeExtractOutputs(ctx.db, ctx.ticket.id, result)` call into the extract handler before its `return` (writing before the success commit). The first test fails (units present after the failed commit, then the rerun throws `UNIQUE constraint failed: work_unit.ticket_id, work_unit.seq`). Restore.

- [ ] **Step 7: Run the whole suite, then commit**

Run: `perl -e 'alarm 600; exec @ARGV' bun test`
Expected: PASS.

```bash
git add src/daemon/design-outputs.ts src/dispatch/handlers.ts test/dispatch/design-commits.test.ts
git commit -m "fix(eng-477): design handlers write their rows in the success transaction" -m "A crash between design:extract's work and its success no longer leaves partial units for the rerun to collide with." -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 12: The adopt pass for runs paused by an older Styre (D9)

**Files:**
- Create: `src/daemon/adopt.ts`
- Modify: `src/cli/park.ts` (call the adopt pass right after `captureSnapshot`, before the registry), `src/daemon/run-ticket.ts` (call it right after `captureSnapshot`, for a reused `--db`: for this run's ticket and for every other active ticket, operator ruling 2026-10-10)
- Modify test: `test/cli/snapshot-e2e.test.ts` (add a case)
- Test: `test/daemon/adopt.test.ts`, `test/cli/adopt-v8-e2e.test.ts` (Task 14 appends the end to end resumes of the other two recordings)

The pass follows the operator ruling of 2026-10-09 (C1, now in spec §7.6): it goes through the table in order, as the walk does, and stops at the first applicable step that is not succeeded. A succeeded step after that point cannot be adopted against inputs that do not exist yet (`design:extract`'s manifest reads the plan digest that a pending `design:dispatch` has not recorded): it is recorded with an empty manifest `{}` under the current scheme, so the walk invalidates it with cause `inputs` through the ordinary comparison once its upstream reruns, and the `adopted` note lists it as "will rerun". Two applications of the same rule, for the operator to confirm (hand off note 12):
- `provision` produces nothing a later step reads, so a `provision` reset for a recreated worktree (every worktree mode resume) does not stop the pass: the walk reaches the later steps with the same inputs whether `provision` ran or not. Stopping there would rerun the whole design stage of every older run resumed in worktree mode, which D9 forbids.
- When the plan cannot be read at the branch head (the branch is gone, as on a reused `--db` whose branch was deleted, or it holds no plan file for the ticket), `design:dispatch` cannot be adopted either: it and every step after it are recorded as "will rerun" (review minor 1). A step whose "applies when" is false is never reached by the walk; if it is succeeded without a manifest it is recorded as "will rerun" too, so it can never reach the walk unfingerprinted later.

**Interfaces:**
- Consumes: `DESIGN_TABLE`, `StepRow`, `DesignStepKey` (Task 6); `ticketPlanFilesAt`, `planDigestOf`, `recordStepManifest` (Task 9); `recordManifest` (Task 9); `FINGERPRINT_SCHEME`, `digestValue` (Task 5); `branchHeadSha` (`src/dispatch/worktree.ts:269`); `RECORDED_RUNS`, `copyRecordedRun`, `RecordedMeta`, `fixtureVersion` (Task 1); `DesignHarness` with `slug` and `repoDir` options, `HARNESS_TEST_TIMEOUT_MS`, `STEP_TEST_TIMEOUT_MS`, `gitRepo`, `harnessProfileRaw` (Task 7); `captureSnapshot` (Task 7).
- Produces: `interface AdoptContext { repoPath: string; branch: string }`; `interface AdoptResult { adopted: DesignStepKey[]; willRerun: DesignStepKey[] }`; `adoptUnfingerprinted(db: Database, ticketId: number, ctx: AdoptContext): AdoptResult` (both lists in table order; both empty, and no event, when there is nothing to record). The `adopted` note's payload: `{ event: "adopted", stepKeys, willRerun, message }`.

- [ ] **Step 1: Write the failing tests**

```ts
// test/daemon/adopt.test.ts
import { expect, test } from "bun:test";
import { join } from "node:path";
import { DEFAULT_RUNTIME_CONFIG } from "../../src/config/runtime-config.ts";
import { adoptUnfingerprinted } from "../../src/daemon/adopt.ts";
import { FINGERPRINT_SCHEME } from "../../src/daemon/canonical.ts";
import { captureSnapshot } from "../../src/daemon/design-inputs.ts";
import { openDb } from "../../src/db/client.ts";
import { migrate } from "../../src/db/migrate.ts";
import { listByTicket as listEvents } from "../../src/db/repos/event-log.ts";
import { getByKey, recordManifest } from "../../src/db/repos/workflow-step.ts";
import { parseProfile } from "../../src/dispatch/profile.ts";
import { copyRecordedRun } from "../helpers/db-fixtures.ts";
import { harnessProfileRaw } from "../helpers/design-script.ts";
import {
  STEP_TEST_TIMEOUT_MS,
  atStep,
  driveUntil,
  gitRepo,
  makeDesignTicket,
} from "../helpers/design-steps.ts";

test(
  "a run whose design steps all carry manifests adopts nothing and writes no event",
  async () => {
    const t = makeDesignTicket();
    await driveUntil(t, atStep("checks:dispatch"));
    const r = adoptUnfingerprinted(t.db, t.ticketId, { repoPath: t.repo, branch: "feat/ENG-1" });
    expect(r).toEqual({ adopted: [], willRerun: [] });
    expect(listEvents(t.db, t.ticketId).some((e) => e.reason === "adopted")).toBe(false);
  },
  STEP_TEST_TIMEOUT_MS,
);

test(
  "a manifest from an older scheme is never adopted again (ruling 2026-10-09)",
  async () => {
    const t = makeDesignTicket();
    await driveUntil(t, atStep("checks:dispatch"));
    const step = getByKey(t.db, t.ticketId, "design:extract");
    if (!step?.input_manifest) throw new Error("design:extract recorded no manifest");
    recordManifest(t.db, step.id, {
      manifest: JSON.parse(step.input_manifest) as Record<string, string>,
      fingerprint: step.input_fingerprint ?? "",
      outputDigest: null,
      scheme: FINGERPRINT_SCHEME - 1,
    });
    const r = adoptUnfingerprinted(t.db, t.ticketId, { repoPath: t.repo, branch: "feat/ENG-1" });
    expect(r).toEqual({ adopted: [], willRerun: [] });
    expect(getByKey(t.db, t.ticketId, "design:extract")?.fingerprint_scheme).toBe(
      FINGERPRINT_SCHEME - 1,
    );
  },
  STEP_TEST_TIMEOUT_MS,
);

test(
  "a reused database whose ticket branch is gone: design:dispatch and every step after it will rerun",
  () => {
    // A v8 run paused in implement, its database reused against a repository without the branch.
    const dbPath = join(copyRecordedRun("v8-paused-worktree"), "run.db");
    migrate(dbPath);
    const db = openDb(dbPath);
    try {
      const ticketId = (db.query("SELECT id FROM ticket").get() as { id: number }).id;
      const repo = gitRepo(); // no feat/ENG-1 here
      captureSnapshot(db, ticketId, {
        profile: parseProfile(harnessProfileRaw(repo, "fixture")),
        unusableComponents: [],
        nonPrimaryComponents: [],
        config: DEFAULT_RUNTIME_CONFIG,
      });
      const willRerun = [
        "design:dispatch",
        "design:extract",
        "design:size",
        "design:review",
      ] as const;
      expect(adoptUnfingerprinted(db, ticketId, { repoPath: repo, branch: "feat/ENG-1" })).toEqual({
        adopted: ["provision"],
        willRerun: [...willRerun],
      });
      for (const k of willRerun) {
        expect(getByKey(db, ticketId, k)?.input_manifest).toBe("{}");
        expect(getByKey(db, ticketId, k)?.fingerprint_scheme).toBe(1);
      }
      const note = listEvents(db, ticketId).find((e) => e.reason === "adopted");
      expect(JSON.parse(note?.payload_json ?? "{}").willRerun).toEqual(willRerun);
    } finally {
      db.close();
    }
  },
  STEP_TEST_TIMEOUT_MS,
);

test(
  "a v8 run paused during a redesign: the pass stops at the pending design:dispatch and nothing throws (C1)",
  () => {
    // v8's redesign reset design:dispatch, design:extract and design:review but kept design:size
    // succeeded; the regenerated design:dispatch then paused. Adopting design:size (grading on)
    // would read the plan digest of a design:dispatch that has none.
    const dir = copyRecordedRun("v8-redesign-graded-worktree");
    const dbPath = join(dir, "run.db");
    migrate(dbPath);
    const db = openDb(dbPath);
    try {
      const ticketId = (db.query("SELECT id FROM ticket").get() as { id: number }).id;
      const repo = gitRepo();
      captureSnapshot(db, ticketId, {
        profile: parseProfile(harnessProfileRaw(repo, "fixture")),
        unusableComponents: [],
        nonPrimaryComponents: [],
        config: { ...DEFAULT_RUNTIME_CONFIG, complexityGrading: true },
      });
      expect(adoptUnfingerprinted(db, ticketId, { repoPath: repo, branch: "feat/ENG-1" })).toEqual({
        adopted: ["provision"],
        willRerun: ["design:size"],
      });
      expect(getByKey(db, ticketId, "design:size")?.input_manifest).toBe("{}");
      expect(getByKey(db, ticketId, "design:dispatch")?.input_manifest).toBeNull(); // not succeeded
    } finally {
      db.close();
    }
  },
  STEP_TEST_TIMEOUT_MS,
);
```

```ts
// test/cli/adopt-v8-e2e.test.ts
import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
} from "node:fs";
import { join } from "node:path";
import { listByTicket as listEvents } from "../../src/db/repos/event-log.ts";
import { getByKey } from "../../src/db/repos/workflow-step.ts";
import {
  type RecordedMeta,
  type RecordedRun,
  copyRecordedRun,
  fixtureVersion,
} from "../helpers/db-fixtures.ts";
import { DesignHarness, HARNESS_TEST_TIMEOUT_MS } from "../helpers/design-harness.ts";
import { unitsOf } from "../helpers/design-script.ts";
import { git } from "../helpers/design-steps.ts";
import { makeTempDir } from "../helpers/temp.ts";

const harnesses: DesignHarness[] = [];
afterEach(() => {
  for (const h of harnesses.splice(0)) h.cleanup();
});

/** The resumed run's agent: the same two units the recordings extracted, no plan findings. */
const RESUME_SCRIPT = { units: () => unitsOf(2, { behavioral: false }), planFindings: () => [] };
const DESIGN_AGENTS = [
  "design:dispatch",
  "design:extract",
  "design:size",
  "design:review",
] as const;

/** Restore a recorded v8 run from a private copy: its repository from the bundle, its checkpoint
 *  into the harness's state folder. The recording's absolute repository path does not exist here,
 *  so the project row is pointed at the restored repository: the one direct write, and it is a
 *  relocation, not state. */
function restoreRecordedRun(name: RecordedRun): { h: DesignHarness; meta: RecordedMeta } {
  const recorded = copyRecordedRun(name);
  const meta = JSON.parse(readFileSync(join(recorded, "meta.json"), "utf8")) as RecordedMeta;
  const parent = realpathSync(makeTempDir("styre-v8-restored-"));
  git(parent, ["clone", "-q", join(recorded, "repo.bundle"), "repo"]);
  const repo = join(parent, "repo");
  git(repo, ["branch", meta.branch, `origin/${meta.branch}`]);
  git(repo, ["config", "user.email", "t@s.dev"]);
  git(repo, ["config", "user.name", "T"]);
  const h = new DesignHarness("worktree", { slug: meta.slug, repoDir: repo });
  harnesses.push(h);
  mkdirSync(h.checkpointDir(), { recursive: true });
  copyFileSync(join(recorded, "run.db"), h.dbPath());
  const transcript = join(recorded, "transcript.json");
  if (existsSync(transcript)) {
    copyFileSync(transcript, join(h.checkpointDir(), "transcript.json"));
  }
  const db = new Database(h.dbPath());
  db.query("UPDATE project SET target_repo = ?").run(repo);
  db.close();
  return { h, meta };
}

const adoptedNote = (h: DesignHarness) =>
  h.read((db, id) =>
    listEvents(db, id)
      .filter((e) => e.reason === "adopted")
      .map((e) => JSON.parse(e.payload_json ?? "{}") as Record<string, unknown>),
  );
const invalidations = (h: DesignHarness) =>
  h.read((db, id) =>
    listEvents(db, id)
      .filter((e) => e.reason === "invalidated")
      .map(
        (e) =>
          JSON.parse(e.payload_json ?? "{}") as {
            event: string;
            stepKeys: string[];
            cause: string;
            changed: string[];
          },
      )
      .map((p) => `${p.stepKeys.join("+")}:${p.cause}`),
  );

test(
  "D9: a v8 run paused in worktree mode resumes, is adopted, reruns no finished design step, and completes",
  async () => {
    const { h } = restoreRecordedRun("v8-paused-worktree");
    expect(fixtureVersion(h.dbPath())).toBe(8);
    const code = await h.resume({ script: RESUME_SCRIPT });
    expect(code).toBe(0); // pr-ready
    expect(fixtureVersion(h.dbPath())).toBe(9);
    const backup = /^run\.db\.v8\.\d{8}T\d{9}Z\.bak$/;
    expect(readdirSync(h.checkpointDir()).some((f) => backup.test(f))).toBe(true);
    for (const s of DESIGN_AGENTS) expect(h.calls.counts[s]).toBe(0); // no design agent ran again
    const notes = adoptedNote(h);
    expect(notes).toHaveLength(1);
    // provision was reset for the recreated worktree before the pass, so it reran instead
    expect(notes[0]?.stepKeys).toEqual([...DESIGN_AGENTS]);
    expect(notes[0]?.willRerun).toEqual([]);
    expect(String(notes[0]?.message)).toContain("cannot be detected");
    expect(invalidations(h)).toEqual(["provision:worktree-recreated"]);
    h.read((db, id) => {
      for (const k of ["provision", ...DESIGN_AGENTS]) {
        expect(getByKey(db, id, k)?.fingerprint_scheme).toBe(1);
      }
    });
  },
  HARNESS_TEST_TIMEOUT_MS,
);

test(
  "--inspect on a v8 checkpoint reports the upgrade a resume would make, and makes none",
  async () => {
    const { h } = restoreRecordedRun("v8-paused-worktree");
    expect(await h.resume({ inspect: true })).toBe(0);
    const out = h.stderr.join("");
    expect(out).toContain(
      "resume will upgrade this checkpoint from v8 to v9, after writing a backup",
    );
    expect(out).toContain("would re-dispatch step: implement:wu1:dispatch");
    expect(fixtureVersion(h.dbPath())).toBe(8); // not migrated
    expect(readdirSync(h.checkpointDir()).some((f) => f.endsWith(".bak"))).toBe(false);
  },
  HARNESS_TEST_TIMEOUT_MS,
);
```

- [ ] **Step 2: Run them and see them fail**

Run: `perl -e 'alarm 600; exec @ARGV' bun test test/daemon/adopt.test.ts test/cli/adopt-v8-e2e.test.ts`
Expected: FAIL with `Cannot find module '../../src/daemon/adopt.ts'`.

- [ ] **Step 3: Write the adopt pass**

```ts
// src/daemon/adopt.ts
import type { Database } from "bun:sqlite";
import { appendEvent } from "../db/repos/event-log.ts";
import { getTicket } from "../db/repos/ticket.ts";
import { type WorkflowStepRow, getByKey, recordManifest } from "../db/repos/workflow-step.ts";
import { branchHeadSha } from "../dispatch/worktree.ts";
import { FINGERPRINT_SCHEME, digestValue } from "./canonical.ts";
import { planDigestOf, recordStepManifest, ticketPlanFilesAt } from "./design-digests.ts";
import { DESIGN_TABLE, type DesignStepKey, type StepRow } from "./design-graph.ts";

export interface AdoptContext {
  repoPath: string;
  branch: string;
}

export interface AdoptResult {
  /** Recorded with today's inputs: they count as done. */
  adopted: DesignStepKey[];
  /** Recorded with an empty manifest: the walk invalidates each one (cause `inputs`) when it
   *  reaches it, after the steps before it have run. */
  willRerun: DesignStepKey[];
}

/** Succeeded with no manifest at all: finished under a Styre older than ENG-477. A manifest
 *  recorded under an older scheme is never adopted again; the walk counts it as changed (operator
 *  ruling, 2026-10-09, spec §5.1). */
const unfingerprinted = (s: WorkflowStepRow | null): boolean =>
  s !== null && s.status === "succeeded" && s.input_manifest === null;

/** The plan's digest at the branch head, or null when it cannot be read there: the branch is gone,
 *  or holds no plan file for this ticket. Read through git, before any transaction (spec §5.2). */
function readablePlanDigest(ctx: AdoptContext, ident: string): string | null {
  if (branchHeadSha(ctx.repoPath, ctx.branch) === null) return null;
  const files = ticketPlanFilesAt(ctx.repoPath, ctx.branch, ident);
  return files.length === 0 ? null : planDigestOf(files);
}

/** spec §7.6 (D9) and the operator rulings of 2026-10-09: a run paused by an older Styre has
 *  succeeded design steps with no manifest. Going through the table
 *  in order, as the walk does, each one before the first applicable step that is not succeeded is
 *  recorded with its manifest from the current inputs (and, for design:dispatch, the plan's digest
 *  at the branch head), so it counts as done and the run continues without rerunning it. Each one
 *  after that point, or whose plan cannot be read, or that does not apply, is recorded with an
 *  empty manifest: its inputs do not exist yet, so the walk invalidates it through the ordinary
 *  comparison once its upstream has run. `provision` produces nothing a later step reads, so its
 *  reset for a recreated worktree does not stop the pass. One `note`, reason `adopted`, lists both
 *  sets, and says that an edit made between the pause and the upgrade cannot be detected. Runs
 *  after the snapshot and before the first resolver pass: on every resume and on a reused --db. */
export function adoptUnfingerprinted(
  db: Database,
  ticketId: number,
  ctx: AdoptContext,
): AdoptResult {
  const ticket = getTicket(db, ticketId);
  if (!ticket) throw new Error(`adopt: ticket ${ticketId} not found`);
  const rows = DESIGN_TABLE.filter((r): r is StepRow => r.kind === "step");
  const candidates = rows.filter((r) => unfingerprinted(getByKey(db, ticketId, r.stepKey)));
  if (candidates.length === 0) return { adopted: [], willRerun: [] };
  const planDigest = candidates.some((r) => r.fileOutput)
    ? readablePlanDigest(ctx, ticket.ident)
    : null;
  const adopted: StepRow[] = [];
  const willRerun: StepRow[] = [];
  let stopped = false;
  for (const row of rows) {
    const step = getByKey(db, ticketId, row.stepKey);
    const applies = row.appliesWhen(ticket);
    if (unfingerprinted(step)) {
      const unreadable = row.fileOutput && planDigest === null;
      if (stopped || !applies || unreadable) willRerun.push(row);
      else adopted.push(row);
      if (applies && unreadable) stopped = true;
    } else if (applies && step?.status !== "succeeded" && row.produces.length > 0) {
      stopped = true; // a later step's inputs include what this one has not produced yet
    }
  }
  db.transaction(() => {
    // table order: design:extract's manifest reads the plan digest adopted just before it
    for (const row of adopted) {
      const step = getByKey(db, ticketId, row.stepKey);
      if (!step) throw new Error(`adopt: ${row.stepKey} vanished`);
      recordStepManifest(db, ticketId, step.id, row, row.fileOutput ? planDigest : null);
    }
    for (const row of willRerun) {
      const step = getByKey(db, ticketId, row.stepKey);
      if (!step) throw new Error(`adopt: ${row.stepKey} vanished`);
      recordManifest(db, step.id, {
        manifest: {},
        fingerprint: digestValue({}),
        outputDigest: null,
        scheme: FINGERPRINT_SCHEME,
      });
    }
    appendEvent(db, {
      ticketId,
      kind: "note",
      reason: "adopted",
      payload: {
        event: "adopted",
        stepKeys: adopted.map((r) => r.stepKey),
        willRerun: willRerun.map((r) => r.stepKey),
        message:
          "these design steps finished under an older Styre; their inputs are recorded as they are now, so an edit made between the pause and the upgrade cannot be detected. Those under willRerun finished after a step that has not, so they run again once it has",
      },
    });
  })();
  return {
    adopted: adopted.map((r) => r.stepKey),
    willRerun: willRerun.map((r) => r.stepKey),
  };
}
```

- [ ] **Step 4: Call it on resume and on a reused `--db`**

`src/cli/park.ts`: import `adoptUnfingerprinted` from `../daemon/adopt.ts`; right after the `captureSnapshot(db, ticketId, {...})` call (Task 8):

```ts
    // spec §7.6: after the snapshot, before the first resolver pass.
    adoptUnfingerprinted(db, ticketId, { repoPath: project.target_repo, branch });
```

`src/daemon/run-ticket.ts`: import `adoptUnfingerprinted` from `./adopt.ts`, `getProject` from `../db/repos/project.ts`, `branchNameFor` from `../agent/branch.ts`; after Task 7's loop over the other active tickets (which follows the `recordStartingCommit` lines), so that every ticket has its snapshot before any adopt pass reads it:

```ts
  // A reused --db can hold steps an older Styre finished (spec §7.6); a new database has none.
  // A reused database whose branch is gone records those steps as "will rerun" (never throws).
  const ticketRow = getTicket(deps.db, ticketId);
  const project = getProject(deps.db, projectId);
  if (!ticketRow || !project)
    throw new Error(`runTicket: ticket ${ticketId} or its project vanished`);
  adoptUnfingerprinted(deps.db, ticketId, {
    repoPath: project.target_repo,
    branch: branchNameFor(ticketRow),
  });
  // Operator ruling, 2026-10-10 (spec §4): every other active ticket of a reused --db too, after
  // its snapshot (Task 7), with the same note.
  for (const other of listActiveTickets(deps.db)) {
    if (other.id === ticketId) continue;
    const otherProject = getProject(deps.db, other.project_id);
    if (!otherProject) throw new Error(`runTicket: the project of ticket ${other.id} vanished`);
    adoptUnfingerprinted(deps.db, other.id, {
      repoPath: otherProject.target_repo,
      branch: branchNameFor(other),
    });
  }
```

`test/cli/snapshot-e2e.test.ts` (Task 7's file; it already imports `listByTicket as listEvents`), add `getByKey` to its `../../src/db/repos/workflow-step.ts` import, and append:

```ts
test(
  "a reused --db runs the adopt pass for every active ticket in it, with the same note (ruling 2026-10-10)",
  async () => {
    const h = make();
    const dbFile = join(makeTempDir("styre-reuse-"), "reuse.db");
    const other = seedOtherTickets(dbFile);
    expect(await h.fresh({ db: dbFile })).toBe(75);
    h.readAt(dbFile, (db) => {
      expect(getByKey(db, other.active, "provision")?.input_manifest).not.toBeNull();
      const note = listEvents(db, other.active).find((e) => e.reason === "adopted");
      expect(JSON.parse(note?.payload_json ?? "{}").stepKeys).toEqual(["provision"]);
      expect(listEvents(db, other.waiting).some((e) => e.reason === "adopted")).toBe(false);
    });
  },
  HARNESS_TEST_TIMEOUT_MS,
);
```

- [ ] **Step 5: Run the tests and see them pass**

Run: `perl -e 'alarm 600; exec @ARGV' bun test test/daemon/adopt.test.ts test/cli/adopt-v8-e2e.test.ts test/cli/snapshot-e2e.test.ts test/cli/park.test.ts test/cli/park-inplace.test.ts test/lifecycle/wiring.test.ts`
Expected: PASS. (The resumes of the other two recordings, which go through the walk and the new redesign, are tested end to end in Task 14, once both exist.)

- [ ] **Step 6: Break it on purpose, see it fail, restore**

1. Comment out the `adoptUnfingerprinted(...)` call in `park.ts`. The D9 test still completes but fails on the `adopted` note and on `fingerprint_scheme`. Restore. (The recorded run is paused in `implement`, where the walk does not run, so this stays the failure after Task 13 too.)
2. In `adoptUnfingerprinted`, drop the `stopped` condition (adopt every succeeded step, as the first version of this plan did). Run `test/daemon/adopt.test.ts`: "a v8 run paused during a redesign" fails with `the plan has no recorded digest (design:dispatch is running)` (in that unit test the recording is migrated but not recovered, so the interrupted step is still `running`). Restore. (Task 14 Step 8 repeats this break against the end to end recordings.)
3. In `readablePlanDigest`, remove the `branchHeadSha(...) === null` check: the reused database test fails with `git ls-tree`. Restore.

- [ ] **Step 7: Run the whole suite, then commit**

Run: `perl -e 'alarm 600; exec @ARGV' bun test`
Expected: PASS.

```bash
git add src/daemon/adopt.ts src/cli/park.ts src/daemon/run-ticket.ts test/daemon/adopt.test.ts test/cli/adopt-v8-e2e.test.ts
git commit -m "feat(eng-477): adopt design steps finished under an older Styre on resume" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 13: The walk: design routing generated from the table, early cutoff, extract and size gating

**Files:**
- Create: `src/daemon/design-walk.ts`
- Modify: `src/daemon/resolver.ts:1-10,99-135` (design case delegates to the walk; `requiredPlanFindings` import moves to the walk)
- Modify: `src/cli/park.ts:259` (resume refuses, exit 65, a run whose manifests were recorded under a newer `FINGERPRINT_SCHEME`, before anything is written, and `--inspect` says so), `src/cli/run.ts:426-428` (a fresh run on a reused `--db` refuses it the same way): operator rulings, 2026-10-10
- Modify (existing tests that seeded design rows directly and break once the walk refuses a succeeded design step without a manifest; each now reaches its state through real steps. The tests that already broke at Task 9 moved there):
  - `test/daemon/resolver.test.ts:21-106` (the six design tests replaced, code below)
  - `test/dispatch/design-size.test.ts` (`readyForSize`, lines 43-61; `design-size-e2e.test.ts` moved in Task 9, because it runs `design:review`)
  - `test/daemon/advance.test.ts:24-30,94-132`, `test/daemon/advance-leftovers.test.ts:11,30-33` (`seedProvisionDone`), `test/helpers/skeleton-registry.ts:20-30`
  - `test/daemon/review-resume.test.ts:179-183`
  - `test/helpers/design-steps.ts` (add `reachChecksStep`), and the checks tests that marked design done by hand: `test/dispatch/checks-handler.test.ts` (`markDesignDone`, 15 call sites), `test/dispatch/checks-reauthor-e2e.test.ts:43-51,142-150,242-250`, `test/dispatch/scope-disposition-smoke.test.ts:129-136,148-157,174-196,378-386`, `test/lifecycle/e2e-interrupt.test.ts:1016-1060` (`interruptChecksTestRun`)
- Test: `test/daemon/design-walk.test.ts`, `test/cli/walk-resume-e2e.test.ts`

**Interfaces:**
- Consumes: `DESIGN_TABLE`, `GateRow`, `ensureDesignTableChecked` (Task 6); `currentManifest`, `changedInputs` (Task 9); `FINGERPRINT_SCHEME` (Task 5); `invalidate` descriptor and its interpreter (Task 10); `captureSnapshot` (Task 7); `makeDesignTicket`, `driveUntil`, `atStep`, `DesignHarness`, `unitsOf`, `ScriptUnit` (Task 7); `reachDesignStep` (Task 9, with its `profileFor`/`rootFor` test pattern).
- Produces: `walkDesign(db: Database, ticket: TicketRow): StepDescriptor | null` (null: past the table's last row); `newerSchemeRecorded(path: string): number | null` (the highest `fingerprint_scheme` in the database when it is newer than `FINGERPRINT_SCHEME`, read through one private copy); `newerSchemeRefusal(ident: string, scheme: number): string` (the refusal text, shared by resume and a reused `--db`); test helper `reachChecksStep(opts: { db: Database; ticketId: number; profile: Profile; worktreeRoot: string; inPlace?: boolean; unit: { kind: string; behavioral: boolean; verifyCheckTypes: string[]; filesToTouch?: string[]; testFile?: string } }): Promise<void>` in `test/helpers/design-steps.ts`.

- [ ] **Step 1: Write the failing tests**

```ts
// test/daemon/design-walk.test.ts
import { expect, test } from "bun:test";
import { FINGERPRINT_SCHEME } from "../../src/daemon/canonical.ts";
import { captureSnapshot } from "../../src/daemon/design-inputs.ts";
import { nextStepKey } from "../../src/daemon/resolver.ts";
import { listByTicket as listEvents } from "../../src/db/repos/event-log.ts";
import { setTicketStage } from "../../src/db/repos/ticket.ts";
import { getByKey, recordManifest } from "../../src/db/repos/workflow-step.ts";
import { runStep } from "../../src/engine/step-journal.ts";
import { unitsOf } from "../helpers/design-script.ts";
import {
  type DesignTicket,
  STEP_TEST_TIMEOUT_MS,
  atStep,
  driveUntil,
  makeDesignTicket,
} from "../helpers/design-steps.ts";

const recapture = (t: DesignTicket, profile = t.profile, complexityGrading = false) =>
  captureSnapshot(t.db, t.ticketId, {
    profile,
    unusableComponents: [],
    nonPrimaryComponents: [],
    config: { complexityGrading },
  });

test(
  "the design stage routes provision, dispatch, extract, size, review, then the checks steps, then advances",
  async () => {
    const t = makeDesignTicket({ script: { units: () => unitsOf(2, { behavioral: false }) } });
    const seen: string[] = [];
    const d = await driveUntil(t, (next) => {
      if (next.kind === "step") seen.push(next.stepKey);
      return next.kind === "advance";
    });
    expect(d).toEqual({ kind: "advance", from: "design", to: "implement" });
    expect(seen).toEqual([
      "provision",
      "design:dispatch",
      "design:extract",
      "design:size",
      "design:review",
      "checks:dispatch",
      "checks:classify",
    ]);
  },
  STEP_TEST_TIMEOUT_MS,
);

test(
  "a fast track skips design:review and its gate",
  async () => {
    const t = makeDesignTicket({ script: { units: () => unitsOf(1, { behavioral: false }) } });
    const seen: string[] = [];
    await driveUntil(t, (next) => {
      if (next.kind === "step") seen.push(next.stepKey);
      return next.kind === "advance";
    });
    expect(seen).not.toContain("design:review");
  },
  STEP_TEST_TIMEOUT_MS,
);

test(
  "a changed input invalidates exactly the first step that reads it, naming the input",
  async () => {
    const t = makeDesignTicket();
    await driveUntil(t, atStep("checks:dispatch"));
    recapture(t, { ...t.profile, promptVars: { stack: "ruby", tone: "terse" } });
    expect(nextStepKey(t.db, t.ticketId)).toEqual({
      kind: "invalidate",
      stepKeys: ["design:dispatch"],
      reason: { cause: "inputs", changed: ["profile.promptVars"] },
    });
  },
  STEP_TEST_TIMEOUT_MS,
);

test(
  "early cutoff: an unchanged output leaves its readers done; a changed one invalidates them next",
  async () => {
    // runtimeContext is read by dispatch and extract only. The plan is unchanged, so size and review
    // (which read the plan and the units) stay done.
    const t = makeDesignTicket();
    await driveUntil(t, atStep("checks:dispatch"));
    recapture(t, {
      ...t.profile,
      runtimeContext: {
        ...t.profile.runtimeContext,
        topology: { type: "web-service", detail: "" },
      },
    });
    await driveUntil(t, atStep("checks:dispatch"));
    const invalidated = listEvents(t.db, t.ticketId)
      .filter((e) => e.reason === "invalidated")
      .map((e) => JSON.parse(e.payload_json ?? "{}").stepKeys[0]);
    expect(invalidated).toEqual(["design:dispatch", "design:extract"]);
    expect(t.calls.counts["design:review"]).toBe(1);
  },
  STEP_TEST_TIMEOUT_MS,
);

test(
  "design:extract and design:size are gated by the walk, not by rows or columns",
  async () => {
    const t = makeDesignTicket();
    await driveUntil(t, atStep("checks:dispatch"));
    recapture(t, t.profile, true); // grading on: size's inputs change; the track column is still set
    expect(nextStepKey(t.db, t.ticketId)).toMatchObject({
      kind: "invalidate",
      stepKeys: ["design:size"],
    });
  },
  STEP_TEST_TIMEOUT_MS,
);

test(
  "the walk runs only in design: past design an edit is not compared (E6)",
  async () => {
    const t = makeDesignTicket();
    await driveUntil(t, atStep("checks:dispatch"));
    setTicketStage(t.db, t.ticketId, "implement");
    recapture(t, { ...t.profile, promptVars: { stack: "other" } });
    expect(nextStepKey(t.db, t.ticketId).kind).not.toBe("invalidate");
  },
  STEP_TEST_TIMEOUT_MS,
);

test(
  "a succeeded design step with no manifest is refused loudly (the adopt pass did not run)",
  async () => {
    const t = makeDesignTicket();
    await runStep(t.db, {
      ticketId: t.ticketId,
      stepKey: "provision",
      stepType: "provision",
      execute: () => ({}),
    });
    expect(() => nextStepKey(t.db, t.ticketId)).toThrow("without an input manifest");
  },
  STEP_TEST_TIMEOUT_MS,
);

test(
  "a manifest recorded under an older scheme counts as changed: the step reruns (ruling 2026-10-09)",
  async () => {
    const t = makeDesignTicket();
    await driveUntil(t, atStep("checks:dispatch"));
    const step = getByKey(t.db, t.ticketId, "design:dispatch");
    if (!step?.input_manifest) throw new Error("design:dispatch recorded no manifest");
    // What an older scheme left: the same manifest, stamped with the previous scheme number.
    recordManifest(t.db, step.id, {
      manifest: JSON.parse(step.input_manifest) as Record<string, string>,
      fingerprint: step.input_fingerprint ?? "",
      outputDigest: step.output_digest,
      scheme: FINGERPRINT_SCHEME - 1,
    });
    expect(nextStepKey(t.db, t.ticketId)).toMatchObject({
      kind: "invalidate",
      stepKeys: ["design:dispatch"],
      reason: { cause: "inputs" },
    });
    // past design the walk does not run: the change waits for the next design visit
    setTicketStage(t.db, t.ticketId, "implement");
    expect(nextStepKey(t.db, t.ticketId).kind).not.toBe("invalidate");
  },
  STEP_TEST_TIMEOUT_MS,
);

test(
  "the plan-review gate escalates while blocking findings remain on the latest review",
  async () => {
    const blocking = {
      severity: "critical" as const,
      category: "feasibility",
      location: "plan:Unit 1",
      rationale: "not feasible",
      factors: null,
      deferral_candidate: false,
      work_unit_seq: 1,
    };
    const t = makeDesignTicket({ script: { planFindings: () => [blocking] } });
    // round 1 blocks → redesign; the plan does not change, so the latest review's blocking findings
    // remain and the gate row fires
    await driveUntil(t, (d) => d.kind === "escalate", 30);
    expect(getByKey(t.db, t.ticketId, "design:review")?.status).toBe("succeeded");
    expect(nextStepKey(t.db, t.ticketId)).toMatchObject({
      kind: "escalate",
      signature: "review:unresolved-plan",
      stepKey: "design:review",
    });
  },
  STEP_TEST_TIMEOUT_MS,
);
```

```ts
// test/cli/walk-resume-e2e.test.ts
import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import { FINGERPRINT_SCHEME } from "../../src/daemon/canonical.ts";
import { openDb } from "../../src/db/client.ts";
import { listByTicket as listEvents } from "../../src/db/repos/event-log.ts";
import { getRun } from "../../src/db/repos/run.ts";
import { getTicket } from "../../src/db/repos/ticket.ts";
import { getByKey, recordManifest } from "../../src/db/repos/workflow-step.ts";
import { DesignHarness, HARNESS_TEST_TIMEOUT_MS } from "../helpers/design-harness.ts";
import { makeTempDir } from "../helpers/temp.ts";

const harnesses: DesignHarness[] = [];
afterEach(() => {
  for (const h of harnesses.splice(0)) h.cleanup();
});
const invalidations = (h: DesignHarness) =>
  h.read((db, id) =>
    listEvents(db, id)
      .filter((e) => e.reason === "invalidated")
      .map(
        (e) =>
          JSON.parse(e.payload_json ?? "{}") as {
            event: string;
            stepKeys: string[];
            cause: string;
            changed: string[];
          },
      ),
  );

test(
  "an unchanged resume in worktree mode reruns only provision, for the recreated worktree",
  async () => {
    const h = new DesignHarness("worktree");
    harnesses.push(h);
    expect(await h.fresh()).toBe(75); // design done, paused at checks:dispatch
    const before = { ...h.calls.counts };
    expect(await h.resume()).toBe(75);
    expect(invalidations(h)).toEqual([
      { event: "invalidated", stepKeys: ["provision"], cause: "worktree-recreated", changed: [] },
    ]);
    for (const s of ["design:dispatch", "design:extract", "design:review"] as const) {
      expect(h.calls.counts[s]).toBe(before[s]);
    }
    expect(h.read((db, id) => listEvents(db, id).some((e) => e.reason === "inputs-changed"))).toBe(
      false,
    );
  },
  HARNESS_TEST_TIMEOUT_MS,
);

test(
  "an unchanged resume in place reruns nothing",
  async () => {
    const h = new DesignHarness("in-place");
    harnesses.push(h);
    expect(await h.fresh()).toBe(75);
    const before = { ...h.calls.counts };
    expect(await h.resume()).toBe(75);
    expect(await h.resume()).toBe(75);
    expect(invalidations(h)).toEqual([]);
    expect(h.calls.counts).toEqual(before);
  },
  HARNESS_TEST_TIMEOUT_MS,
);

/** What a newer Styre would leave: design:dispatch's manifest stamped with a later scheme.
 *  Written through the repository on this test's own database (test setup). */
function stampNewerScheme(path: string, ticketId: number): void {
  const db = openDb(path);
  try {
    const step = getByKey(db, ticketId, "design:dispatch");
    if (!step?.input_manifest) throw new Error("design:dispatch recorded no manifest");
    recordManifest(db, step.id, {
      manifest: JSON.parse(step.input_manifest) as Record<string, string>,
      fingerprint: step.input_fingerprint ?? "",
      outputDigest: step.output_digest,
      scheme: FINGERPRINT_SCHEME + 1,
    });
  } finally {
    db.close();
  }
}

/** What a refusal must leave as it was: the events, the run row, the ticket's status. */
const runState = (h: DesignHarness, path: string) =>
  h.readAt(path, (db, id) => ({
    events: listEvents(db, id).length,
    attempt: getRun(db)?.attempt,
    status: getTicket(db, id)?.status,
  }));

test(
  "a manifest from a newer scheme: resume refuses (65), changes nothing, and --inspect says so (ruling 2026-10-10)",
  async () => {
    const h = new DesignHarness("in-place");
    harnesses.push(h);
    expect(await h.fresh()).toBe(75);
    stampNewerScheme(
      h.dbPath(),
      h.read((_db, id) => id),
    );
    const before = runState(h, h.dbPath());
    const calls = JSON.stringify(h.calls.counts);
    expect(await h.resume()).toBe(65);
    expect(h.stderr.join("")).toContain("this run was recorded by a newer Styre; use that version");
    expect(runState(h, h.dbPath())).toEqual(before); // no markResumed, no event, no status change
    expect(JSON.stringify(h.calls.counts)).toBe(calls);
    expect(await h.resume({ inspect: true })).toBe(0);
    expect(h.stderr.join("")).toContain(
      "resume would refuse it: this run was recorded by a newer Styre",
    );
  },
  HARNESS_TEST_TIMEOUT_MS,
);

test(
  "a manifest from a newer scheme on a reused --db: the run refuses (65) and changes nothing (ruling 2026-10-10)",
  async () => {
    const h = new DesignHarness("in-place");
    harnesses.push(h);
    const dbFile = join(makeTempDir("styre-walk-reuse-"), "reuse.db");
    expect(await h.fresh({ db: dbFile })).toBe(75);
    stampNewerScheme(
      dbFile,
      h.readAt(dbFile, (_db, id) => id),
    );
    const before = runState(h, dbFile);
    const calls = JSON.stringify(h.calls.counts);
    expect(await h.fresh({ db: dbFile })).toBe(65);
    expect(h.stderr.join("")).toContain("run refused: this run was recorded by a newer Styre");
    expect(runState(h, dbFile)).toEqual(before);
    expect(JSON.stringify(h.calls.counts)).toBe(calls);
  },
  HARNESS_TEST_TIMEOUT_MS,
);
```

- [ ] **Step 2: Run them and see them fail**

Run: `perl -e 'alarm 600; exec @ARGV' bun test test/daemon/design-walk.test.ts test/cli/walk-resume-e2e.test.ts`
Expected: FAIL: `a changed input invalidates exactly...` receives `{ kind: "step", stepKey: "checks:dispatch", ... }` instead of an `invalidate`, and `a succeeded design step with no manifest` does not throw.

- [ ] **Step 3: Write the walk**

```ts
// src/daemon/design-walk.ts
import type { Database } from "bun:sqlite";
import { classifyDatabase } from "../db/migrate.ts";
import { readCopyOf } from "../db/read-copy.ts";
import { requiredPlanFindings } from "../db/repos/review-round.ts";
import type { TicketRow } from "../db/repos/ticket.ts";
import { getByKey } from "../db/repos/workflow-step.ts";
import { FINGERPRINT_SCHEME } from "./canonical.ts";
import { changedInputs, currentManifest } from "./design-digests.ts";
import { DESIGN_TABLE, type GateRow, ensureDesignTableChecked } from "./design-graph.ts";
import type { StepDescriptor } from "./resolver.ts";

/** The highest fingerprint scheme recorded in the database at `path` when it is newer than this
 *  Styre's, else null (operator rulings, 2026-10-10, spec §5.1). One private copy, so it changes
 *  nothing. A database that is not at the current version has no newer manifest: an older one has
 *  no `fingerprint_scheme` column, and a newer one is refused by `migrate` anyway. */
export function newerSchemeRecorded(path: string): number | null {
  const max = readCopyOf(path, (db) =>
    classifyDatabase(db, path).kind === "current"
      ? (db
          .query<{ s: number | null }, []>("SELECT MAX(fingerprint_scheme) AS s FROM workflow_step")
          .get()?.s ?? null)
      : null,
  );
  return max !== null && max > FINGERPRINT_SCHEME ? max : null;
}

/** The refusal of a run fingerprinted under a newer scheme: the same text on a resume and on a
 *  run that reuses the database (`--db`). */
export function newerSchemeRefusal(ident: string, scheme: number): string {
  return `this run was recorded by a newer Styre; use that version.\n  Its design steps were fingerprinted under scheme ${scheme}; this Styre knows scheme ${FINGERPRINT_SCHEME} and cannot compare them.\n  Nothing was changed. Or start the ticket over: styre run ${ident} --fresh.\n`;
}

const GATE_FIRES: Record<GateRow["name"], (db: Database, ticketId: number) => boolean> = {
  // today's resolver rule: blocking findings of the latest design:review dispatch remain
  "plan-review": (db, ticketId) => requiredPlanFindings(db, ticketId).length > 0,
};

/** The design routing, generated from the declared table (spec §5.4). Walks the rows in order:
 *  skip a row whose "applies when" is false; a step that is not succeeded is the next step and the
 *  walk stops there; a succeeded step's manifest is recomputed and compared with the recorded one,
 *  and a mismatch invalidates that step alone (its readers are judged afresh after it reruns: early
 *  cutoff); a gate that fires returns its escalation. Null past the last row. Reads the database
 *  only, never the worktree. Pure: the interpreter applies what it returns. */
export function walkDesign(db: Database, ticket: TicketRow): StepDescriptor | null {
  ensureDesignTableChecked();
  for (const row of DESIGN_TABLE) {
    if (!row.appliesWhen(ticket)) continue;
    if (row.kind === "gate") {
      if (GATE_FIRES[row.name](db, ticket.id))
        return {
          kind: "escalate",
          reason: row.reason,
          signature: row.signature,
          stepKey: row.stepKey,
        };
      continue;
    }
    const step = getByKey(db, ticket.id, row.stepKey);
    if (step?.status !== "succeeded") {
      return {
        kind: "step",
        stepKey: row.stepKey,
        stepType: row.stepType,
        handlerKey: row.handlerKey,
        workUnitId: null,
      };
    }
    // Neither can reach here: the adopt pass (resume, reused --db) records a manifest for every
    // succeeded step without one, and both a resume and a run on a reused --db refuse a newer
    // scheme before they start (65; operator rulings, 2026-10-10).
    if (step.input_manifest === null || (step.fingerprint_scheme ?? 0) > FINGERPRINT_SCHEME) {
      throw new Error(
        `design walk: '${row.stepKey}' succeeded without an input manifest this Styre can compare (scheme ${step.fingerprint_scheme ?? "none"}, this Styre ${FINGERPRINT_SCHEME}); the adopt pass should have recorded one, and a resume or a reused --db refuses a newer scheme`,
      );
    }
    // Operator ruling (2026-10-09, spec §5.1): a manifest recorded under an older scheme counts as
    // changed. Its digests are not comparable, so the step reruns now that the run is in design.
    const recorded =
      step.fingerprint_scheme === FINGERPRINT_SCHEME
        ? (JSON.parse(step.input_manifest) as Record<string, string>)
        : {};
    const changed = changedInputs(recorded, currentManifest(db, ticket.id, row));
    if (changed.length > 0) {
      return { kind: "invalidate", stepKeys: [row.stepKey], reason: { cause: "inputs", changed } };
    }
  }
  return null;
}
```

`src/daemon/resolver.ts`: remove `import { requiredPlanFindings, unresolvedReviewReason }` → `import { unresolvedReviewReason } from "../db/repos/review-round.ts";`, import `walkDesign` from `./design-walk.ts`, and replace the whole `case "design": {...}` (lines 99-135) with:

```ts
    case "design": {
      // Generated from the declared design table (src/daemon/design-graph.ts, spec §3, §5.4):
      // provision, design:dispatch, design:extract, design:size, design:review and its gate, each
      // "done" only when done with the inputs it has now.
      const designStep = walkDesign(db, ticket);
      if (designStep !== null) return designStep;
      // Past the table's last row: today's checks routing, unchanged (E9).
      if (!done(db, ticketId, "checks:dispatch")) {
        return step("checks:dispatch", "dispatch", "checks:dispatch", null);
      }
      if (!done(db, ticketId, "checks:classify")) {
        return step("checks:classify", "dispatch", "checks:classify", null);
      }
      return { kind: "advance", from: "design", to: "implement" };
    }
```

`src/cli/park.ts` (operator rulings, 2026-10-10, spec §5.1): import `newerSchemeRecorded, newerSchemeRefusal` from `../daemon/design-walk.ts`; in `resumeRun`, right after Task 3's `if (args.inspect) {...}` block and before `migrate(dbPath, ...)`, add:

```ts
    // A manifest recorded under a newer FINGERPRINT_SCHEME (operator ruling, 2026-10-10): this
    // Styre cannot compare it. Refuse before anything is written, like a HEAD that moved (65).
    const newerScheme = newerSchemeRecorded(dbPath);
    if (newerScheme !== null) {
      process.stderr.write(`resume refused: ${newerSchemeRefusal(args.resume, newerScheme)}`);
      process.exitCode = 65; // EXIT.RESUME_REFUSED, inside the try whose finally releases the lock
      return;
    }
```

and make `--inspect` say so (review n3: Review Focus 10 promises a report also where resume would refuse). Above `inspectWithoutUpgrading`, add

```ts
/** `--inspect` says when resume would refuse a run fingerprinted under a newer scheme (Task 13). */
function newerSchemeNote(dbPath: string): string {
  const newer = newerSchemeRecorded(dbPath);
  return newer === null
    ? ""
    : `; resume would refuse it: this run was recorded by a newer Styre (fingerprint scheme ${newer}); use that version`;
}
```

and in `inspectWithoutUpgrading` the current case of `schema` becomes `` `schema v${state.version}, current${newerSchemeNote(dbPath)}` ``.

`src/cli/run.ts` (operator ruling, 2026-10-10: a fresh run on a reused `--db` refuses the same way, with the same message): import `newerSchemeRecorded, newerSchemeRefusal` from `../daemon/design-walk.ts`, and right after `try {` (line 426), before `migrate(dbPath, ...)`, add:

```ts
      // A reused --db holding manifests from a newer FINGERPRINT_SCHEME (operator ruling,
      // 2026-10-10): refused as resume refuses it (65), before anything is written.
      const newerScheme = explicitDb && existsSync(dbPath) ? newerSchemeRecorded(dbPath) : null;
      if (newerScheme !== null) {
        process.stderr.write(`run refused: ${newerSchemeRefusal(ident, newerScheme)}`);
        process.exitCode = 65; // EXIT.RESUME_REFUSED
        return;
      }
```

(For an explicit `--db` nothing before this point writes: the folder, the refusal of an existing checkpoint and the run lock are all for the checkpoint location only. The `return` runs the `finally` that would release a lock.) Each check reads one private copy of the database: the version and the highest scheme come from the same copy.

- [ ] **Step 4: Move the existing tests off seeded rows**

`test/daemon/resolver.test.ts`: delete the six tests from `design: first asks for provision` through `design full-track: provision + units + track=full, asks for design:review before advancing` (lines 25-106); their behaviour is covered by the first two tests of `test/daemon/design-walk.test.ts` above. Keep the `succeed()` helper (the implement stage tests use it).

`test/daemon/review-resume.test.ts`, in `plan review cannot accept risks...`: delete the `for (const key of ["provision", "design:dispatch"]) {...}` loop and the `expect(nextStepKey(db, ticketId)).toMatchObject({ kind: "escalate", stepKey: "design:review" });` line (the gate is covered by `the plan-review gate escalates...` above, through real steps), and remove `nextStepKey` from the imports if unused.

`test/helpers/skeleton-registry.ts`: delete the `setTicketTrack(ctx.db, ctx.ticket.id, "fast");` line from the `design:extract` mock and register a size mock after it:

```ts
  r.register("design:size", (ctx: HandlerContext) => {
    setTicketTrack(ctx.db, ctx.ticket.id, "fast");
    return { track: "fast", graded: false };
  });
```

`test/daemon/advance.test.ts` and `test/daemon/advance-leftovers.test.ts`: replace each `seedProvisionDone` body with a real run of a provision step:

```ts
async function seedProvisionDone(db: Parameters<typeof advanceOneStep>[0], ticketId: number): Promise<void> {
  const r = new StepRegistry();
  r.register("provision", () => ({}));
  const outcome = await advanceOneStep(db, ticketId, r);
  if (outcome.kind !== "stepped" || outcome.stepKey !== "provision")
    throw new Error(`seedProvisionDone: expected provision to run, got ${JSON.stringify(outcome)}`);
}
```

and `await` every call. Then remove the imports this leaves unused (`tsconfig.json` sets `noUnusedLocals`): `markSucceeded` in `advance.test.ts`; `insertPending` and `markSucceeded` in `advance-leftovers.test.ts`.

In `advance.test.ts`'s `an advance descriptor sets the stage and writes a transition event`, register `design:size` (`(ctx) => { setTicketTrack(ctx.db, ctx.ticket.id, "fast"); return { track: "fast", graded: false }; }`), delete the manual `setTicketTrack(db, ticketId, "fast");`, and replace the five `advanceOneStep` calls before the final one with a loop on the descriptor, not on the stage:

```ts
  // provision, design:dispatch, design:extract, design:size, checks:dispatch, checks:classify. Stop
  // when the next descriptor is the advance: the call after it collapses the advance inline and
  // runs implement:wu1:dispatch.
  while (nextStepKey(db, ticketId).kind !== "advance") await advanceOneStep(db, ticketId, registry);
  const outcome = await advanceOneStep(db, ticketId, registry);
```

and keep `expect(outcome).toEqual({ kind: "stepped", stepKey: "implement:wu1:dispatch" })` (import `nextStepKey` from `../../src/daemon/resolver.ts`). A loop on `stage === "design"` would be wrong: the call that collapses the advance starts while the stage is still `design`, so it runs inside such a loop and the final call would run the step after `implement:wu1:dispatch`.

`test/dispatch/design-size.test.ts`: apply Task 9 Step 7's pattern (items 1, 2, 4 and 6: `profileFor`, `rootFor`, `await` at the call sites, unused imports) with the same `readyForSize` as Task 9 Step 7 item 5a gives `design-size-e2e.test.ts` (it seeded the same units: `backend`, not behavioural, `verify_check_types: ["test"]`); its hand marked `provision` and `design:dispatch` rows go with it, and its six call sites (lines 67, 81, 113, 124, 135, 146) become `await readyForSize(db, ticketId, repo, <the same count>);`.

The checks tests that marked design done by hand. Append to `test/helpers/design-steps.ts` (add `basename`, `dirname` to its `node:path` import):

```ts
/** For the checks tests that used to mark design done by hand (spec §8): run the real design
 *  steps until `checks:dispatch` is next, with the one planned unit those tests seeded. Provision
 *  runs here (creating the worktree), so the caller's first step is `checks:dispatch`. A behavioural
 *  unit carries its own test file (validateExtraction requires it): `testFile`, or a `tests/` file
 *  beside the unit's first file, which the default test file pattern matches. */
export async function reachChecksStep(opts: {
  db: Database;
  ticketId: number;
  profile: Profile;
  worktreeRoot: string;
  inPlace?: boolean;
  unit: {
    kind: string;
    behavioral: boolean;
    verifyCheckTypes: string[];
    filesToTouch?: string[];
    testFile?: string;
  };
}): Promise<void> {
  const files = opts.unit.filesToTouch ?? ["src/unit1.py"];
  const first = files[0] ?? "src/unit1.py";
  const testFile = opts.unit.testFile ?? `${dirname(first)}/tests/test_${basename(first)}`;
  await reachDesignStep({
    db: opts.db,
    ticketId: opts.ticketId,
    profile: opts.profile,
    worktreeRoot: opts.worktreeRoot,
    inPlace: opts.inPlace,
    target: "checks:dispatch",
    units: [
      {
        seq: 1,
        kind: opts.unit.kind,
        title: "Unit 1",
        description: "Change 1",
        behavioral: opts.unit.behavioral,
        test_plan: opts.unit.behavioral ? `${testFile} asserts change 1` : null,
        files_to_touch: opts.unit.behavioral ? [...files, testFile] : files,
        verify_check_types: opts.unit.verifyCheckTypes,
        depends_on: [],
      },
    ],
  });
}
```

Each file keeps the unit kind, `behavioral` value and `verifyCheckTypes` it seeded (`insertWorkUnit` defaults `behavioral` to 1, so a seed that omitted it passes `behavioral: true`), and its fast track (one unit sizes to `fast`). Each imports `reachChecksStep` from `../helpers/design-steps.ts`. Then remove the imports each file is left without a use for (`runStep`, `insertWorkUnit`, `setTicketTrack`, `markSucceeded`, `insertPending`):

- `test/dispatch/checks-handler.test.ts`: delete `markDesignDone`. At each of its call sites, delete the `await markDesignDone(...)`, `insertWorkUnit(...)` and `setTicketTrack(..., "fast")` lines; hoist the `parseProfile({...})` and the `worktreeRoot` the test passes to its first `buildDispatchRegistry` into `const profile` and `const worktreeRoot` (where they are inline; PR #154 made each inline root a `makeTempDir("...")` call, so the hoisted line is `const worktreeRoot = makeTempDir("...");` with the same prefix); and replace the test's first `advanceOneStep(...)` marked `// provision` (or `// provision (no-op)`) with `await reachChecksStep({ db, ticketId, profile, worktreeRoot, unit: { kind, behavioral, verifyCheckTypes: ["test"], filesToTouch } })`, with `kind` and `filesToTouch` as the deleted `insertWorkUnit` had them, and `behavioral: fixture.behavioral !== 0` in `runSingleCheckDispatch`, `true` elsewhere. Where the step after it was `let outcome = await advanceOneStep(...); // provision` followed by `outcome = ...`, the second line becomes `let outcome = ...`. The two tests with no `// provision` call (lines 733 and 804) drive a bounded loop until `checks:dispatch` succeeds: call `reachChecksStep` just before the loop and leave the loop as it is.
- `test/dispatch/checks-reauthor-e2e.test.ts`, in each of its three tests: delete the `runStep(... "design:dispatch" ...)`, `insertWorkUnit` and `setTicketTrack` seeding (lines 43-51, 142-150, 242-250); hoist the registry's `profile` and `worktreeRoot` (`makeTempDir("styre-rewt-")`, `makeTempDir("styre-weak-wt-")`, `makeTempDir("styre-heal-wt-")`) into consts; call `await reachChecksStep({ db, ticketId, profile, worktreeRoot, unit: { kind: "python", behavioral: true, verifyCheckTypes: ["test"] } })` before the drive loop. The loop is bounded by its own condition and now starts at `checks:dispatch`.
- `test/dispatch/scope-disposition-smoke.test.ts`: delete `markDesignDone` and its three seeding lines in `setupChecks` and in `A7`. In `driveChecks`, hoist `const profile = opts?.profile ?? pythonProfile(h.repo);`, pass it to `buildDispatchRegistry`, and replace `await advanceOneStep(h.db, h.ticketId, registry); // provision (creates the worktree)` with `await reachChecksStep({ db: h.db, ticketId: h.ticketId, profile, worktreeRoot: h.worktreeRoot, unit: { kind: "python", behavioral: true, verifyCheckTypes: ["test"] } }); // provision (creates the worktree) and design, through real steps`. `beforeChecks(wt)` still runs between the worktree's creation and `checks:dispatch`.
- `test/lifecycle/e2e-interrupt.test.ts`, `interruptChecksTestRun`: in its `seed` callback delete the `track = 'fast'` from the `UPDATE` (the ticket already starts in `design`, so the `UPDATE` goes), the `design:dispatch` row and the `insertWorkUnit`; keep `insertAc`. Right after `setUp(...)` returns, before `headAtStart` is read:

```ts
  // design through real steps, in place, with the run's own profile (Task 9 captured the snapshot
  // from it), so the plan's commit lands before headAtStart
  const designDb = openDb(run.dbPath);
  try {
    await reachChecksStep({
      db: designDb,
      ticketId: run.ticketId,
      profile: run.profile,
      worktreeRoot: run.repo,
      inPlace: true,
      unit: { kind: "backend", behavioral: false, verifyCheckTypes: [], filesToTouch: ["src/unit1.js"] },
    });
  } finally {
    designDb.close();
  }
```

  and, since design now leaves its own dispatch rows, narrow the dispatch row assertion to the checks step: `const rows = dispatchRows(run.dbPath).filter((d) => d.step_id === i.during.id);` (the `toHaveLength(1)` and the `clean-success` expectation stay).

- [ ] **Step 5: Run the tests and see them pass**

Run: `perl -e 'alarm 600; exec @ARGV' bun test test/daemon test/dispatch test/lifecycle/e2e-interrupt.test.ts test/cli/walk-resume-e2e.test.ts`
Expected: PASS.

- [ ] **Step 6: Break it on purpose, see it fail, restore**

1. In `walkDesign`, delete the manifest comparison (treat every succeeded step as done). The `a changed input invalidates...`, `early cutoff` and `gated by the walk` tests fail. Restore.
2. Return `stepKeys: [row.stepKey, ...later steps]` (invalidate everything after the mismatch): `early cutoff` fails (design:review is invalidated and called twice). Restore.
3. In `park.ts`, comment out `adoptUnfingerprinted(...)`. `test/cli/adopt-v8-e2e.test.ts` fails on `adopted.length` and `fingerprint_scheme`, not in the walk: the recorded run is paused in `implement`, where the walk does not run. Restore.
4. In `test/dispatch/checks-handler.test.ts`, put back one `markDesignDone(...)` seed in place of its `reachChecksStep` call: that test fails with `succeeded without an input manifest`. Restore.
5. In `resumeRun`, delete the `newerSchemeRecorded` refusal: `a manifest from a newer scheme: resume refuses (65) ...` fails (no 65: the resume marks the run resumed and goes on). Restore.
6. In `runImpl`, make `newerScheme` always null: `a manifest from a newer scheme on a reused --db ...` fails (`Expected: 65, Received: 75`: the run goes on to its checks pause; past design the walk does not look at the manifests). Restore.
7. In `inspectWithoutUpgrading`, drop `${newerSchemeNote(dbPath)}`: the resume test fails on its `--inspect` assertion. Restore.

- [ ] **Step 7: Run the whole suite, then commit**

Run: `perl -e 'alarm 600; exec @ARGV' bun test`
Expected: PASS.

```bash
git add src/daemon/design-walk.ts src/daemon/resolver.ts src/cli/park.ts src/cli/run.ts test
git commit -m "feat(eng-477): route the design stage by walking the declared table with input manifests" -m "A succeeded design step is done only when its recorded inputs still match; a mismatch invalidates that step alone, and its readers are judged again after it reruns (early cutoff). design:extract and design:size move from row and column gating to this rule." -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 14: Loopbacks invalidate their consumer; feedback and the carryover belong to a generation

**Files:**
- Modify: `src/daemon/review-verdict.ts:1-28,162-220,255-285` (`redesignLoopback` takes the steps to invalidate; consumer and generation on the event)
- Modify: `src/daemon/review-resume.ts:1-18,95-104,139-149` (retry-plan only when the run stopped at the plan review gate; with a moved HEAD it invalidates dispatch and extract)
- Modify: `src/dispatch/design-feedback.ts:18-30` (only the current generation's feedback)
- Modify: `src/dispatch/run-dispatch.ts:36-38,147-150` (`ResumeContext` with a generation), `src/dispatch/handlers.ts:192` (`RegistryDeps.resumeContext` type)
- Modify: `src/cli/park.ts:127-159` (`dumpPark` records the parked step's generation), `src/cli/park.ts:219-221,408-434` (`resumeContext` carries it)
- Modify tests: `test/daemon/review-verdict.test.ts:336-372,433-466,510-540`, `test/daemon/review-resume.test.ts:177-230` (the three plan review cases: each run now stops at the gate first), `test/daemon/run-ticket.test.ts:412` (`redesignLoopback`'s new last argument), `test/dispatch/run-dispatch.test.ts:278` (`ResumeContext` gains `generation` and `manifest`)
- Test: `test/daemon/loopback-invalidate.test.ts`, `test/dispatch/design-feedback.test.ts` (add cases), `test/daemon/review-resume.test.ts` (add a case), `test/cli/plan-review-resume-e2e.test.ts`, `test/cli/adopt-v8-e2e.test.ts` (append the resumes of the plan gate and redesign recordings, which need the walk and this task's redesign)

**Why retry-plan needs a new condition (operator ruling C2, 2026-10-09, now in spec §6.4).** Today a redesign resets `design:review` to pending; after this task it stays `succeeded`, with the blocking findings of the latest `design:review` dispatch, until the review reruns. `planReviewResume` (`review-resume.ts:95-101`) reads exactly that state (stage `design`, `design:review` succeeded, `requiredPlanFindings` not empty) as "stopped at the plan review gate" and returns `retry-plan`. So any pause in design after a plan review redesign (a budget pause in the regenerated `design:dispatch`, an interrupt, a crash) would be misread on resume: with HEAD unchanged, `applyReviewVerdict('design:review')` finds the same findings signature as the redesign loopback just written and escalates inside the resume transaction, every time; with HEAD moved, each resume writes another redesign until `REVIEW_REPAIR_LIMIT`. `event_log` has no step key column, so the condition (operator ruling, 2026-10-09) uses what the gate and the verdict write: some `escalated` event since the last `resumed` event is plan review's, either the gate's (signature `review:unresolved-plan`) or the verdict's ("no progress: identical plan-review findings" and its repair limit escalation, identified by its `review:` findings signature together with the latest `design:review` dispatch id, never by the dispatch id alone), and no design `loopback` or `invalidated` note came after it. Any escalation of another kind is ignored: the projector giving up on a row (`escalateProjection`, no signature), the resume's toolchain pause (`pauseTicket`, no signature), the invalidate loop guard and the step replay guard (signatures `invalidate-loop:<step>` and `step-replay-no-progress:<step>`; they carry the ticket's latest dispatch id, which can be the `design:review` dispatch). Not only the latest escalation counts: a run that stopped at the gate can get one of those afterwards without leaving the gate, and reading only the latest would drop the operator's documented way out (edit the plan, resume with `--accept-head`). v8 wrote the same events, so an upgraded checkpoint answers the same.

**Interfaces:**
- Consumes: `invalidateSteps` (Task 10); `makeDesignTicket`, `driveUntil`, `atStep`, `newCalls`, `scriptedRunner`, `unitsOf` (Task 7); `captureSnapshot` (Task 7); `getByKey` with `generation` (Task 4); `stepRow` (Task 6); `currentManifest`, `changedInputs` (Task 9).
- Produces:
  - `redesignLoopback(db, ticketId, signature: string, blocking: ReviewFindingRow[], dispatchId: string | null, invalidate: readonly ("design:dispatch" | "design:extract")[]): void`
  - design loopback event payload `{ findings, consumer: "design:dispatch", generation: number }`
  - `interface ResumeContext { stepKey: string; transcript: string; generation: number; manifest: Record<string, string> | null }` exported from `src/dispatch/run-dispatch.ts`; `RegistryDeps.resumeContext?: ResumeContext`; `DispatchDeps.resumeContext?: ResumeContext`
  - `carryoverMismatch(ctx: HandlerContext, rc: ResumeContext): string[] | null` exported from `src/dispatch/run-dispatch.ts` (pure: null when the carryover is not this dispatch's, `[]` when it applies, else the changed input names)
  - `transcript.json` gains `generation: number | null` and `manifest: Record<string, string> | null`

- [ ] **Step 1: Write the failing tests**

```ts
// test/daemon/loopback-invalidate.test.ts
import { expect, test } from "bun:test";
import { DEFAULT_AGENT_CONFIG } from "../../src/config/agent-config.ts";
import { captureSnapshot } from "../../src/daemon/design-inputs.ts";
import { redesignLoopback } from "../../src/daemon/review-verdict.ts";
import { listByTicket as listEvents } from "../../src/db/repos/event-log.ts";
import {
  getById as getFinding,
  insertFinding,
  setStatus as setFindingStatus,
} from "../../src/db/repos/review-finding.ts";
import { listStepHistory } from "../../src/db/repos/step-history.ts";
import { getTicket } from "../../src/db/repos/ticket.ts";
import { listByTicket as listUnits } from "../../src/db/repos/work-unit.ts";
import { getByKey } from "../../src/db/repos/workflow-step.ts";
import { buildDispatchRegistry } from "../../src/dispatch/handlers.ts";
import { type ScriptFinding, newCalls, scriptedRunner, unitsOf } from "../helpers/design-script.ts";
import {
  type DesignTicket,
  STEP_TEST_TIMEOUT_MS,
  atStep,
  driveUntil,
  makeDesignTicket,
} from "../helpers/design-steps.ts";

const blocking: ScriptFinding = {
  severity: "critical",
  category: "feasibility",
  location: "plan:Unit 1",
  rationale: "FIX-THE-PLAN",
  factors: null,
  deferral_candidate: false,
  work_unit_seq: 1,
};
const generation = (t: DesignTicket, key: string) =>
  getByKey(t.db, t.ticketId, key)?.generation ?? 0;
const invalidated = (t: DesignTicket) =>
  listEvents(t.db, t.ticketId)
    .filter((e) => e.reason === "invalidated")
    .map(
      (e) =>
        JSON.parse(e.payload_json ?? "{}") as {
          event: string;
          stepKeys: string[];
          cause: string;
          changed: string[];
        },
    );

test(
  "a plan-review redesign invalidates design:dispatch with cause feedback and records the consumer's generation",
  async () => {
    const t = makeDesignTicket({
      script: {
        planFindings: (n) => (n === 1 ? [blocking] : []),
        plan: (n) => `Plan body, version ${n}`,
      },
    });
    await driveUntil(t, () => generation(t, "design:dispatch") === 1);
    expect(invalidated(t)).toEqual([
      { event: "invalidated", stepKeys: ["design:dispatch"], cause: "feedback", changed: [] },
    ]);
    const loopback = listEvents(t.db, t.ticketId)
      .filter((e) => e.kind === "loopback")
      .at(-1);
    expect(JSON.parse(loopback?.payload_json ?? "{}")).toMatchObject({
      consumer: "design:dispatch",
      generation: 1,
    });
    expect(listUnits(t.db, t.ticketId).length).toBe(2); // the units stay until the plan's readers are judged
    expect(getByKey(t.db, t.ticketId, "design:review")?.status).toBe("succeeded");
  },
  STEP_TEST_TIMEOUT_MS,
);

test(
  "early cutoff after a plan-review redesign: a changed plan reruns extract and review, not size (§8.5)",
  async () => {
    const t = makeDesignTicket({
      script: {
        planFindings: (n) => (n === 1 ? [blocking] : []),
        plan: (n) => `Plan body, version ${n}`,
      },
    });
    await driveUntil(t, atStep("checks:dispatch"));
    expect(invalidated(t).map((i) => [i.stepKeys[0], i.cause])).toEqual([
      ["design:dispatch", "feedback"],
      ["design:extract", "inputs"],
      ["design:review", "inputs"],
    ]);
    expect(t.calls.counts["design:review"]).toBe(2);
    expect(generation(t, "design:size")).toBe(0);
  },
  STEP_TEST_TIMEOUT_MS,
);

test(
  "a redesign that changes the units reruns size and review (§8.5)",
  async () => {
    const t = makeDesignTicket({
      script: {
        planFindings: (n) => (n === 1 ? [blocking] : []),
        plan: (n) => `Plan body, version ${n}`,
        units: (n) => unitsOf(n === 1 ? 2 : 3, { behavioral: true }),
      },
    });
    await driveUntil(t, atStep("checks:dispatch"));
    const keys = invalidated(t).map((i) => i.stepKeys[0]);
    expect(keys).toContain("design:size");
    expect(keys).toContain("design:review");
    expect(listUnits(t.db, t.ticketId).length).toBe(3);
  },
  STEP_TEST_TIMEOUT_MS,
);

test(
  "a code-review redesign re-creates and re-implements the units even when the plan is identical (§8.5)",
  async () => {
    const t = makeDesignTicket({ script: { units: () => unitsOf(2, { behavioral: false }) } });
    // driveUntil sees only the descriptors nextStepKey returns between calls: advanceOneStep runs an
    // `advance` and a `mark-verified` inline, together with the implement dispatch after them
    // (advance.ts:120-136), so stop at the completeness steps, which it returns
    await driveUntil(t, atStep("completeness:wu2")); // both units implemented
    const oldIds = listUnits(t.db, t.ticketId).map((u) => u.id);
    const implementBefore = t.calls.counts.implement;
    const finding = insertFinding(t.db, {
      ticketId: t.ticketId,
      reviewKind: "code",
      severity: "major",
      category: "plan-defect",
      blocksShip: 1,
      workUnitId: oldIds[0],
      rationale: "CODE-FINDING",
    });
    redesignLoopback(t.db, t.ticketId, "review:plan-defect", [finding], null, [
      "design:dispatch",
      "design:extract",
    ]);
    expect(getTicket(t.db, t.ticketId)?.stage).toBe("design");
    expect(getFinding(t.db, finding.id)?.work_unit_id).toBeNull(); // detached, kept open
    // The open finding now goes to unit 1 (findingsForUnit), and its implement must answer exactly
    // its id (assertExactFindingIds). This script's implement answers none, so the finding is
    // settled here as a review round settles one (review-round.ts:149); this test is about units.
    setFindingStatus(t.db, finding.id, "fixed");
    await driveUntil(t, atStep("completeness:wu1"));
    expect(listUnits(t.db, t.ticketId).length).toBe(2);
    // made again: work_unit.id is not AUTOINCREMENT, so the new units may reuse the old ids; the
    // invalidation of design:extract and its second call show it instead
    expect(invalidated(t).flatMap((i) => i.stepKeys)).toContain("design:extract");
    expect(t.calls.counts["design:dispatch"]).toBe(2);
    expect(t.calls.counts["design:extract"]).toBe(2);
    expect(generation(t, "design:size")).toBe(0); // same units: size stays done
    expect(t.calls.counts.implement).toBe(implementBefore + 1); // unit 1 implemented again
  },
  STEP_TEST_TIMEOUT_MS,
);

test(
  "feedback reaches only its own generation; a later rerun for changed inputs gets none (§6.5, §8.7)",
  async () => {
    const t = makeDesignTicket({
      script: {
        planFindings: (n) => (n === 1 ? [blocking] : []),
        plan: (n) => `Plan body, version ${n}`,
      },
    });
    await driveUntil(t, atStep("checks:dispatch"));
    const prompts = () =>
      t.calls.prompts.filter((p) => p.step === "design:dispatch").map((p) => p.prompt);
    expect(prompts()[1]).toContain("FIX-THE-PLAN"); // generation 1 got the findings
    captureSnapshot(t.db, t.ticketId, {
      profile: { ...t.profile, promptVars: { stack: "ruby", tone: "terse" } },
      unusableComponents: [],
      nonPrimaryComponents: [],
      config: t.config,
    });
    await driveUntil(t, atStep("checks:dispatch"));
    expect(generation(t, "design:dispatch")).toBe(2);
    expect(prompts()[2]).not.toContain("FIX-THE-PLAN");
    expect(listStepHistory(t.db, t.ticketId, "design:dispatch").length).toBe(2);
  },
  STEP_TEST_TIMEOUT_MS,
);

test(
  "the carryover transcript reaches only the generation it was written in (§6.5, §8.7)",
  async () => {
    const t = makeDesignTicket({
      script: {
        planFindings: (n) => (n === 1 ? [blocking] : []),
        plan: (n) => `Plan body, version ${n}`,
      },
    });
    const calls = newCalls();
    const registry = buildDispatchRegistry({
      runner: scriptedRunner(t.script, calls),
      agentConfig: DEFAULT_AGENT_CONFIG,
      profile: t.profile,
      worktreeRoot: t.worktreeRoot,
      // manifest null: a transcript written before ENG-477, kept as it is (spec §6.5)
      resumeContext: {
        stepKey: "design:dispatch",
        transcript: "CARRIED-PARTIAL-OUTPUT",
        generation: 0,
        manifest: null,
      },
    });
    await driveUntil({ ...t, registry }, atStep("checks:dispatch"));
    const dispatchPrompts = calls.prompts
      .filter((p) => p.step === "design:dispatch")
      .map((p) => p.prompt);
    expect(dispatchPrompts[0]).toContain("CARRIED-PARTIAL-OUTPUT"); // generation 0
    expect(dispatchPrompts[1]).not.toContain("CARRIED-PARTIAL-OUTPUT"); // generation 1, after the redesign
  },
  STEP_TEST_TIMEOUT_MS,
);

test(
  "a carryover recorded under other inputs is dropped, with a note naming them (spec §6.5)",
  async () => {
    const t = makeDesignTicket({ script: { planFindings: () => [] } });
    const calls = newCalls();
    const registry = buildDispatchRegistry({
      runner: scriptedRunner(t.script, calls),
      agentConfig: DEFAULT_AGENT_CONFIG,
      profile: t.profile,
      worktreeRoot: t.worktreeRoot,
      resumeContext: {
        stepKey: "design:dispatch",
        transcript: "CARRIED-PARTIAL-OUTPUT",
        generation: 0,
        manifest: { "profile.promptVars": "a digest no current input has" },
      },
    });
    await driveUntil({ ...t, registry }, atStep("checks:dispatch"));
    const dispatchPrompts = calls.prompts
      .filter((p) => p.step === "design:dispatch")
      .map((p) => p.prompt);
    expect(dispatchPrompts[0]).not.toContain("CARRIED-PARTIAL-OUTPUT");
    const notes = listEvents(t.db, t.ticketId)
      .filter((e) => e.reason === "carryover-dropped")
      .map((e) => JSON.parse(e.payload_json ?? "{}") as { stepKey: string; changed: string[] });
    expect(notes).toHaveLength(1);
    expect(notes[0]?.stepKey).toBe("design:dispatch");
    expect(notes[0]?.changed).toContain("profile.promptVars");
  },
  STEP_TEST_TIMEOUT_MS,
);
```

Append to `test/dispatch/design-feedback.test.ts` (it already imports `appendEvent`, `designFeedback` and `makeTestDb`; add only the two imports below, at the top):

```ts
import { invalidateSteps } from "../../src/daemon/invalidate.ts";
import {
  STEP_TEST_TIMEOUT_MS,
  atStep,
  driveUntil,
  makeDesignTicket,
} from "../helpers/design-steps.ts";

test("a loopback written before ENG-477 (no consumer) is generation 0 feedback for design:dispatch", async () => {
  // design:dispatch has really run once (generation 0); the loopback is written as an older Styre
  // wrote it, with no consumer and no generation.
  const t = makeDesignTicket();
  await driveUntil(t, atStep("design:extract"));
  appendEvent(t.db, {
    ticketId: t.ticketId,
    kind: "loopback",
    loop: "design",
    routeTo: "review",
    signature: "s",
    payload: { findings: [{ category: "x", location: null, rationale: "LEGACY-FINDING" }] },
  });
  expect(designFeedback(t.db, t.ticketId)).toContain("LEGACY-FINDING");
  invalidateSteps(t.db, t.ticketId, ["design:dispatch"], { cause: "inputs", changed: ["profile.promptVars"] });
  expect(designFeedback(t.db, t.ticketId)).toBe("");
}, STEP_TEST_TIMEOUT_MS);
```

```ts
// test/cli/plan-review-resume-e2e.test.ts
import { afterEach, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { listByTicket as listEvents } from "../../src/db/repos/event-log.ts";
import { listPending } from "../../src/db/repos/signal.ts";
import { getByKey } from "../../src/db/repos/workflow-step.ts";
import { DesignHarness, HARNESS_TEST_TIMEOUT_MS } from "../helpers/design-harness.ts";
import type { ScriptFinding } from "../helpers/design-script.ts";
import { git } from "../helpers/design-steps.ts";

const harnesses: DesignHarness[] = [];
afterEach(() => {
  for (const h of harnesses.splice(0)) h.cleanup();
});

const blocking: ScriptFinding = {
  severity: "critical",
  category: "feasibility",
  location: "plan:Unit 1",
  rationale: "FIX-THE-PLAN",
  factors: null,
  deferral_candidate: false,
  work_unit_seq: null,
};

test(
  "a budget pause in the regenerated design:dispatch after a plan review redesign resumes and dispatches it (C2)",
  async () => {
    const h = new DesignHarness("in-place");
    harnesses.push(h);
    const script = {
      plan: (n: number) => `Plan body, version ${n}`,
      planFindings: (n: number) => (n === 1 ? [blocking] : []),
    };
    // review 1 blocks, the redesign regenerates design:dispatch, and that dispatch pauses
    const paused = { ...script, parkAt: "design:dispatch" as const, parkOnCall: 2 };
    expect(await h.fresh({ script: paused })).toBe(75);
    expect(h.calls.counts["design:dispatch"]).toBe(2);
    expect(await h.resume({ script })).toBe(75); // design finishes; the checks pause follows
    expect(h.calls.counts["design:dispatch"]).toBe(3); // the paused dispatch ran again
    expect(h.calls.counts["design:review"]).toBe(2); // the new plan was reviewed
    h.read((db, id) => {
      expect(getByKey(db, id, "design:dispatch")?.status).toBe("succeeded");
      const escalations = listEvents(db, id).filter((e) => e.kind === "escalated");
      expect(escalations.some((e) => (e.reason ?? "").includes("plan-review"))).toBe(false);
    });
  },
  HARNESS_TEST_TIMEOUT_MS,
);

test(
  "a gate stop resumed on a host missing a required suite's tools pauses once, and the edited plan is redesigned next (ruling 2026-10-09)",
  async () => {
    const h = new DesignHarness("in-place");
    harnesses.push(h);
    h.editProfile((p) => {
      (p.components as unknown[]).push({
        name: "lib",
        kind: "ruby",
        paths: ["vendor-lib/**"],
        commands: { build: "lib-build", test: "lib-test", check: "lib-check" },
        testPolicy: { suite: "required" },
      });
    });
    const plan = (n: number) => `Plan body, version ${n}`;
    // every review returns the same blocking finding: one redesign, then the stop at the gate
    const stuck = { plan, planFindings: () => [blocking] };
    expect(await h.fresh({ script: stuck })).toBe(75);
    expect(h.calls.counts["design:dispatch"]).toBe(2);

    // resume 1, HEAD unchanged, on a host without lib's tools: the verdict stops the run at the
    // gate again inside the resume transaction, and the toolchain pause adds nothing to it
    h.probe = (_dir, cmd) => !cmd.startsWith("lib-");
    expect(await h.resume({ script: stuck })).toBe(75);
    h.read((db, id) => {
      expect(listPending(db, id).filter((x) => x.signal_type === "human_resume")).toHaveLength(1);
      const events = listEvents(db, id);
      const since = events.slice(events.findLastIndex((e) => e.kind === "resumed") + 1);
      expect(since.filter((e) => e.kind === "escalated")).toHaveLength(1);
      expect(since.some((e) => e.reason === "toolchain-missing")).toBe(true); // the gap is on record
    });

    // the operator installs the tools and edits the plan, then resumes with --accept-head
    h.probe = () => true;
    writeFileSync(
      join(h.repoDir, "docs", "plans", "eng-1-plan.md"),
      "---\nlinear: ENG-1\n---\n\nEdited by the operator\n",
    );
    git(h.repoDir, ["commit", "-q", "-am", "operator edits the plan"]);
    const clean = { plan, planFindings: () => [] };
    expect(await h.resume({ acceptHead: true, script: clean })).toBe(75); // the checks pause
    expect(h.calls.counts["design:dispatch"]).toBe(3); // redesigned from the gate
    h.read((db, id) => {
      const loopbacks = listEvents(db, id).filter((e) => e.kind === "loopback");
      expect(loopbacks.at(-1)?.signature).toBe("review:operator-plan-head-changed");
    });
  },
  HARNESS_TEST_TIMEOUT_MS,
);
```

Append to `test/cli/adopt-v8-e2e.test.ts` (Task 12) the end to end resumes of the other two recorded v8 runs (operator ruling C1): add `writeFileSync` to its `node:fs` import and `import { getTicket } from "../../src/db/repos/ticket.ts";`, then:

```ts
/** The operator's way out of the plan review gate: edit the plan on the ticket branch. */
function editPlanOnBranch(h: DesignHarness, branch: string): void {
  const wt = join(makeTempDir("styre-v8-edit-"), "wt");
  git(h.repoDir, ["worktree", "add", wt, branch]);
  writeFileSync(
    join(wt, "docs", "plans", "eng-1-plan.md"),
    "---\nlinear: ENG-1\n---\n\nRecorded plan, edited by the operator\n",
  );
  git(wt, ["commit", "-q", "-am", "operator edits the plan"]);
  git(h.repoDir, ["worktree", "remove", "--force", wt]);
}

test(
  "a v8 run stopped at the plan review gate, resumed with HEAD unchanged, stays at the gate; the operator's plan edit then finishes it",
  async () => {
    const { h, meta } = restoreRecordedRun("v8-plan-gate-worktree");
    expect(await h.resume({ script: RESUME_SCRIPT })).toBe(75); // the same findings: still stopped
    expect(fixtureVersion(h.dbPath())).toBe(9);
    const first = adoptedNote(h);
    expect(first).toHaveLength(1);
    expect(first[0]?.stepKeys).toEqual([...DESIGN_AGENTS]); // every design step had succeeded
    expect(first[0]?.willRerun).toEqual([]);
    h.read((db, id) => {
      expect(getTicket(db, id)?.status).toBe("waiting");
      const events = listEvents(db, id);
      const resumedAt = events.findLastIndex((e) => e.kind === "resumed");
      const escalated = events.slice(resumedAt + 1).filter((e) => e.kind === "escalated");
      expect(escalated).toHaveLength(1); // stopped again at the gate by the resume itself
    });
    for (const s of DESIGN_AGENTS) expect(h.calls.counts[s]).toBe(0);

    editPlanOnBranch(h, meta.branch);
    expect(await h.resume({ acceptHead: true, script: RESUME_SCRIPT })).toBe(0); // pr-ready
    expect(h.calls.counts["design:dispatch"]).toBe(1); // the redesign
    expect(h.calls.counts["design:extract"]).toBe(1);
    expect(h.calls.counts["design:review"]).toBe(1); // the plan changed
    expect(invalidations(h)).toEqual([
      "provision:worktree-recreated",
      "design:dispatch+design:extract:feedback",
      "design:review:inputs",
    ]); // design:size stays done: the same units
  },
  HARNESS_TEST_TIMEOUT_MS,
);

test(
  "a v8 run stopped at the plan review gate, resumed after the operator edited the plan, finishes",
  async () => {
    const { h, meta } = restoreRecordedRun("v8-plan-gate-worktree");
    editPlanOnBranch(h, meta.branch);
    expect(await h.resume({ acceptHead: true, script: RESUME_SCRIPT })).toBe(0); // pr-ready
    const notes = adoptedNote(h);
    expect(notes).toHaveLength(1);
    // the resume's redesign left design:dispatch pending: size and review are past it
    expect(notes[0]?.stepKeys).toEqual([]);
    expect(notes[0]?.willRerun).toEqual(["design:size", "design:review"]);
    expect(invalidations(h)).toEqual([
      "provision:worktree-recreated",
      "design:dispatch+design:extract:feedback",
      "design:size:inputs",
      "design:review:inputs",
    ]);
    expect(h.calls.counts["design:review"]).toBe(1);
  },
  HARNESS_TEST_TIMEOUT_MS,
);

test(
  "a v8 run paused during a redesign with grading on resumes, reruns the steps past the pause, and finishes",
  async () => {
    const { h } = restoreRecordedRun("v8-redesign-graded-worktree");
    h.editConfig((c) => {
      c.complexityGrading = true;
    });
    expect(await h.resume({ script: RESUME_SCRIPT })).toBe(0); // pr-ready
    const notes = adoptedNote(h);
    expect(notes).toHaveLength(1);
    expect(notes[0]?.stepKeys).toEqual([]);
    expect(notes[0]?.willRerun).toEqual(["design:size"]); // succeeded under v8, past the pause
    expect(invalidations(h)).toEqual(["provision:worktree-recreated", "design:size:inputs"]);
    expect(h.calls.counts["design:size"]).toBe(1); // the grader, once
    const dispatch = h.calls.prompts.find((p) => p.step === "design:dispatch")?.prompt ?? "";
    expect(dispatch).toContain("RECORDED-BLOCKING-FINDING"); // the v8 redesign's feedback
    expect(dispatch).toContain("partial output written before the session limit"); // the carryover
  },
  HARNESS_TEST_TIMEOUT_MS,
);
```

- [ ] **Step 2: Run them and see them fail**

Run: `perl -e 'alarm 600; exec @ARGV' bun test test/daemon/loopback-invalidate.test.ts test/dispatch/design-feedback.test.ts test/daemon/review-resume.test.ts test/cli/plan-review-resume-e2e.test.ts test/cli/adopt-v8-e2e.test.ts`
Expected: FAIL. `review-resume.test.ts`'s new case gets `retry-plan` where it wants `none`; the recorded plan gate resumes find `design:review` reset by today's redesign rather than invalidated, and the redesign recording's `design:size` is never judged again. The e2e budget pause test passes before this task's code (today's redesign resets `design:review`, so today's `retry-plan` rule does not fire); it guards the new redesign together with the new condition, and Step 8 break 4 proves it can fail. bun runs without type checking, so the sixth argument to the old five parameter `redesignLoopback` is ignored and the code-review test runs today's redesign; the plan-review test finds `design:extract` and `design:review` reset by the old list; the feedback and carryover tests see the old findings and transcript in later generations; and `buildDispatchRegistry` ignores the `manifest` field, so no `carryover-dropped` note is written. (`bun run typecheck` additionally reports the extra argument and the unknown `manifest` field.)

- [ ] **Step 3: `redesignLoopback` invalidates its consumer**

`src/daemon/review-verdict.ts`: import `invalidateSteps` from `./invalidate.ts`; remove `deleteByTicket` from the work-unit import. Replace `redesignLoopback` (lines 162-220):

```ts
/** The redesign loopback (spec §6.4, §6.7). It invalidates the step that consumes its feedback,
 *  design:dispatch, with cause `feedback`, through the one invalidate function, then appends its
 *  event carrying the findings, the consumer and the consumer's generation after the bump (§6.5),
 *  so the rerun sees exactly this round's findings. A code review redesign (and review-resume's
 *  retry-plan when HEAD moved) also invalidates design:extract: the units are re-created and
 *  implemented again even when the plan comes back identical, with findings tied to a unit detached first
 *  (§6.1). Everything else in design follows from fingerprints. The later-stage resets (review,
 *  verify, merge) stay until ENG-475. */
export function redesignLoopback(
  db: Database,
  ticketId: number,
  signature: string,
  blocking: ReviewFindingRow[],
  dispatchId: string | null,
  invalidate: readonly ("design:dispatch" | "design:extract")[],
): void {
  if (!invalidate.includes("design:dispatch"))
    throw new Error("redesignLoopback: a redesign must invalidate design:dispatch, its feedback's consumer");
  // The snapshot rides event_log.payload_json and survives replacement of the old plan (ENG-272).
  const findings = blocking.map((f) => ({
    category: f.category,
    location: f.location,
    rationale: f.rationale,
  }));
  db.transaction(() => {
    const ticket = getTicket(db, ticketId);
    const from = ticket?.stage ?? "review";
    const { generations } = invalidateSteps(db, ticketId, invalidate, { cause: "feedback" });
    const consumerGeneration =
      generations["design:dispatch"] ?? getByKey(db, ticketId, "design:dispatch")?.generation ?? 0;
    const reviewStep = getByKey(db, ticketId, "review");
    if (reviewStep) {
      resetToPending(db, reviewStep.id);
      resetAttempt(db, reviewStep.id);
    }
    resetTicketVerifySteps(db, ticketId);
    resetMergeSteps(db, ticketId);
    setTicketStage(db, ticketId, "design");
    appendEvent(db, {
      ticketId,
      dispatchId: dispatchId ?? undefined,
      kind: "loopback",
      loop: "design",
      routeTo: "review",
      signature,
      payload: { findings, consumer: "design:dispatch", generation: consumerGeneration },
    });
    // Project the rewind to design when it actually changes stage (code-review plan-defect: review→
    // design). Plan-review redesign is already IN design → no spurious projection.
    if (ticket && from !== "design") {
      enqueueStageProjection(db, ticket, from, "design");
    }
  })();
}
```

In `applyReviewVerdict`: line 264 becomes `redesignLoopback(db, ticketId, signature, blocking, dispatchId, ["design:dispatch"]);` (plan review) and line 283 becomes `redesignLoopback(db, ticketId, signature, blocking, dispatchId, ["design:dispatch", "design:extract"]);` (code review plan defect).

`src/daemon/review-resume.ts`: merge `type EventLogRow` and `listByTicket as listEvents` into its `../db/repos/event-log.ts` import (it already imports `appendEvent` there), import `DESIGN_TABLE` and `type GateRow` from `./design-graph.ts`, and add above `planReviewResume`:

```ts
/** The plan review gate row's escalation signature (`review:unresolved-plan`). */
function planGateSignature(): string {
  const gate = DESIGN_TABLE.find(
    (r): r is GateRow => r.kind === "gate" && r.name === "plan-review",
  );
  if (!gate) throw new Error("the declared design table has no plan-review gate");
  return gate.signature;
}

/** An escalation from plan review: the gate row's (its signature), or the plan review verdict's
 *  ("no progress: identical plan-review findings", or its repair limit), which carries the blocking
 *  findings' `review:` signature and the latest design:review dispatch. Never by dispatch id alone:
 *  the interpreter's other escalations (the invalidate loop guard, the step replay guard) carry the
 *  ticket's latest dispatch, which can be that design:review dispatch. */
function isPlanReviewEscalation(
  e: EventLogRow,
  gateSignature: string,
  reviewDispatch: string | null,
): boolean {
  if (e.kind !== "escalated" || e.signature === null) return false;
  if (e.signature === gateSignature) return true;
  return (
    e.signature.startsWith("review:") && reviewDispatch !== null && e.dispatch_id === reviewDispatch
  );
}

/** True when the run stopped at the plan review gate (operator ruling, 2026-10-09; spec §6.4): an
 *  escalation since the last `resumed` event is plan review's, and no design loopback or
 *  `invalidated` note came after it. Any such escalation, not only the latest: a later escalation of
 *  another kind in the same run (the projector giving up on a row, the resume's toolchain pause)
 *  does not move the run off the gate, and is ignored. event_log has no step key column; these are
 *  what the gate and the verdict write, and v8 wrote them the same way. A run paused anywhere else
 *  in design, a budget pause in a redesign's regenerated design:dispatch say, is not at the gate,
 *  although design:review is still succeeded with blocking findings from before the redesign. */
export function stoppedAtPlanReviewGate(db: Database, ticketId: number): boolean {
  const events = listEvents(db, ticketId);
  const since = events.slice(events.findLastIndex((e) => e.kind === "resumed") + 1);
  const gate = planGateSignature();
  const review = latestDispatchForStep(db, ticketId, "design:review");
  const at = since.findLastIndex((e) => isPlanReviewEscalation(e, gate, review));
  if (at === -1) return false;
  const movedOn = since
    .slice(at + 1)
    .some(
      (e) =>
        (e.kind === "loopback" && e.loop === "design") ||
        (e.kind === "note" && e.reason === "invalidated"),
    );
  return !movedOn;
}
```

and add `stoppedAtPlanReviewGate(db, ticketId)` as the last condition of the plan review branch (lines 95-99), which becomes:

```ts
  if (
    ticket?.stage === "design" &&
    getByKey(db, ticketId, "design:review")?.status === "succeeded" &&
    requiredPlanFindings(db, ticketId).length &&
    stoppedAtPlanReviewGate(db, ticketId)
  ) {
```

A run that did not stop at the gate falls through to the existing code, which returns `none` for a ticket in design (and throws `no completed unresolved review to retry` when `--review-action` was given).

`src/daemon/review-resume.ts:140-147`:

```ts
    if (plan.moved)
      redesignLoopback(
        db,
        ticketId,
        "review:operator-plan-head-changed",
        requiredPlanFindings(db, ticketId),
        latestDispatchForStep(db, ticketId, "design:review"),
        ["design:dispatch", "design:extract"],
      );
    else applyReviewVerdict(db, ticketId, config, { stepKey: "design:review" }); // design:dispatch only
```

- [ ] **Step 4: Feedback scoped to the generation**

Replace `designFeedback` in `src/dispatch/design-feedback.ts` (lines 18-30), adding `import { getByKey } from "../db/repos/workflow-step.ts";`:

```ts
export function designFeedback(db: Database, ticketId: number): string {
  // spec §6.5: only the loopback addressed to design:dispatch's CURRENT generation. A rerun for
  // changed inputs starts a new generation with no feedback, so old findings never return.
  const current = getByKey(db, ticketId, "design:dispatch")?.generation ?? 0;
  const ours = listEvents(db, ticketId).filter((e) => {
    if (e.kind !== "loopback" || e.loop !== "design" || e.payload_json === null) return false;
    const p = JSON.parse(e.payload_json) as { consumer?: string; generation?: number };
    // A loopback written before ENG-477 names no consumer: it was for design:dispatch, and an
    // upgraded checkpoint's steps start at generation 0.
    return (p.consumer ?? "design:dispatch") === "design:dispatch" && (p.generation ?? 0) === current;
  });
  const latest = ours[ours.length - 1];
  if (!latest?.payload_json) return "";
  const findings = (JSON.parse(latest.payload_json) as { findings?: FindingSnapshot[] }).findings;
  if (!findings || findings.length === 0) return "";
  const lines = findings.map(
    (f) => `- [${f.category ?? "?"}] ${f.location ?? "plan-wide"}: ${f.rationale ?? ""}`,
  );
  return `## Prior plan-review feedback (address before finalizing)\n\nA prior plan review raised the following. For EACH, either revise the plan to address it, or state explicitly in the plan why it does not apply or is an accepted trade-off — a bare "no changes needed" is not a disposition:\n${lines.join("\n")}`;
}
```

- [ ] **Step 5: The carryover belongs to a generation**

`src/dispatch/run-dispatch.ts`:

```ts
/** Set only when resuming a parked run: the interrupted step's partial output, prepended to THAT
 *  step's re-dispatch while its generation is still current (spec §6.5), so a step invalidated
 *  since never receives output written under its old inputs. */
export interface ResumeContext {
  stepKey: string;
  transcript: string;
  generation: number;
  /** The step's input manifest when the run paused, for a table step; null for any other step and
   *  for a transcript written before ENG-477 (kept as it is, like a step the adopt pass keeps). */
  manifest: Record<string, string> | null;
}

/** The carryover's fit to this dispatch (spec §6.5), computed without side effects. Null: the
 *  carryover is not this dispatch's (another step, or a generation invalidated since). `[]`: it
 *  applies (same step, same generation, and, for a table step paused before it finished, the same
 *  inputs, or a transcript written before ENG-477, kept as it is). Otherwise the input names that
 *  differ: a step that was never finished is not invalidated when an upstream step reruns, so its
 *  generation alone cannot tell. The caller (`dispatchAndRecord`) withholds the carryover on an
 *  answer that is not empty and records one `carryover-dropped` note per dispatch that withholds it, so a
 *  retried attempt of the same step writes another. */
export function carryoverMismatch(ctx: HandlerContext, rc: ResumeContext): string[] | null {
  if (rc.stepKey !== ctx.step.step_key || rc.generation !== ctx.step.generation) return null;
  if (rc.manifest === null) return [];
  const row = stepRow(rc.stepKey);
  if (row === undefined) {
    throw new Error(`resume: a carryover manifest was recorded for ${rc.stepKey}, which is not a design table step`);
  }
  return changedInputs(rc.manifest, currentManifest(ctx.db, ctx.ticket.id, row));
}
```

Imports in `run-dispatch.ts`: `stepRow` from `../daemon/design-graph.ts`; `changedInputs`, `currentManifest` from `../daemon/design-digests.ts` (`appendEvent` and `HandlerContext` are already imported).

`DispatchDeps.resumeContext?: ResumeContext;` and, replacing lines 147-150:

```ts
  // spec §6.5: the carryover reaches only the dispatch it belongs to. When it is withheld because
  // the inputs changed, a note names them: one `carryover-dropped` note per dispatch that withholds
  // it (a retried attempt of the same step writes another).
  const mismatch = deps.resumeContext ? carryoverMismatch(ctx, deps.resumeContext) : null;
  if (mismatch !== null && mismatch.length > 0) {
    appendEvent(ctx.db, {
      ticketId: ctx.ticket.id,
      kind: "note",
      reason: "carryover-dropped",
      payload: { event: "carryover-dropped", stepKey: ctx.step.step_key, changed: mismatch },
    });
  }
  if (deps.resumeContext && mismatch !== null && mismatch.length === 0) {
    // chain off `prompt` (NOT rendered.prompt) so both prepends compose (design §1, review Important)
    prompt = `${CARRYOVER_PREFIX}\n\n${deps.resumeContext.transcript}\n\n${CARRYOVER_SUFFIX}\n\n${prompt}`;
  }
```

`src/dispatch/handlers.ts:192`: `resumeContext?: import("./run-dispatch.ts").ResumeContext;`.

`src/cli/park.ts`:
- in `dumpPark`, before `db.exec("PRAGMA wal_checkpoint(TRUNCATE);")`:

```ts
  // The step the park left running: its generation, and for a table step its inputs, scope the
  // carryover (spec §6.5).
  const parked = listByStatus(db, "running").at(0);
  const parkedGeneration = parked?.generation ?? null;
  const parkedRow = parked ? stepRow(parked.step_key) : undefined;
  const parkedManifest = parked && parkedRow ? currentManifest(db, parked.ticket_id, parkedRow) : null;
```

and add `generation: parkedGeneration, manifest: parkedManifest,` to the `transcript.json` object (imports: `stepRow` from `../daemon/design-graph.ts`, `currentManifest` from `../daemon/design-digests.ts`);
- `resumeContext` becomes `let resumeContext: ResumeContext | undefined;` (import the type from `../dispatch/run-dispatch.ts`), the `buildRegistry` deps type uses `ResumeContext | undefined`, and its assignment (lines 428-431):

```ts
          const tj = JSON.parse(readFileSync(join(dir, "transcript.json"), "utf8")) as {
            transcript: string;
            generation?: number | null;
            manifest?: Record<string, string> | null;
          };
          resumeContext = {
            stepKey: parkedStep.step_key,
            transcript: tj.transcript,
            // A transcript written before ENG-477 has no generation and no manifest: it belongs to
            // the parked step as it is now.
            generation: tj.generation ?? parkedStep.generation,
            manifest: tj.manifest ?? null,
          };
```

- [ ] **Step 6: Update the existing redesign assertions**

`test/daemon/run-ticket.test.ts:412` (`both loopbacks reset the merge steps with a fresh attempt budget`): `else redesignLoopback(db, ticketId, "sig", [], null, ["design:dispatch"]);` (with five arguments it fails typecheck, TS2554, and `invalidate.includes` throws on `undefined`).

`test/dispatch/run-dispatch.test.ts:278` (`compose: retry-feedback AND resumeContext carryover both survive`): `resumeContext: { stepKey: fresh.step_key, transcript: "PRIOR PARTIAL OUTPUT", generation: fresh.generation, manifest: null },` (without `generation`, typecheck fails, TS2739, and `carryoverMismatch` drops the carryover). With `manifest: null` the carryover is kept, as for a transcript written before this change.

`test/daemon/review-verdict.test.ts`:
- `plan-review redesign preserves a per-unit blocking finding for the redesign feedback`: `expect(units.length).toBe(1); // the units stay; design:extract reruns only if the new plan changes`.
- `plan review: a blocking plan finding loops back to re-design`: replace the last two expectations with

```ts
  expect(units.length).toBe(1); // kept: design:extract is judged again once the new plan exists
  expect(drAfter?.status).toBe("succeeded"); // reruns when its input, the plan, changes
  expect(dispatchAfter?.status).toBe("pending");
  expect(dispatchAfter?.generation).toBe(1);
```

adding `const dispatchAfter = getByKey(db, ticketId, "design:dispatch");` before `db.close()`.
- `redesign loopback gives the design steps their attempt budget back (STYRE-7)`: the step that gets its budget back is the consumer. Replace the `design:extract` setup with a succeeded `design:dispatch` that used two attempts:

```ts
  const dispatch = insertPending(db, { ticketId, stepKey: "design:dispatch", stepType: "dispatch" });
  markRunning(db, dispatch.id, {});
  markRunning(db, dispatch.id, {});
  markSucceeded(db, dispatch.id, {});
  expect(getByKey(db, ticketId, "design:dispatch")?.attempt).toBe(2);
```

and read `const after = getByKey(db, ticketId, "design:dispatch");` (import `markSucceeded`).

`test/daemon/review-resume.test.ts` (its tests build their state with repository calls, as the whole file does; the gate's escalation is added the same way, as the interpreter writes it): add after `seed`:

```ts
/** The run stopped at the plan review gate: the escalation the interpreter writes for the gate row. */
function stopAtPlanGate(db: Database, ticketId: number): void {
  appendEvent(db, {
    ticketId,
    kind: "escalated",
    reason: "unresolved plan-review findings",
    signature: "review:unresolved-plan",
  });
}
```

- import `pauseTicket` from `../../src/daemon/pause-ticket.ts`;
- in `plan review cannot accept risks...`, call `stopAtPlanGate(db, ticketId);` right after `seed("plan")`;
- in `same-HEAD repeated plan findings stay paused; explicit moved HEAD re-arms design`, call `stopAtPlanGate(db, ticketId);` after its `appendEvent(... loopback ...)` (the loopback came first, then the stop);
- in `unchanged code retries and all plan retries respect the durable repair cap`, call `if (kind === "plan") stopAtPlanGate(db, ticketId);` after the loop of loopbacks;
- add:

```ts
test("a plan review resume is retry-plan only when the run stopped at the plan review gate (C2)", () => {
  const { db, ticketId } = seed("plan");
  // stage design, design:review succeeded, blocking findings: but no stop at the gate (a pause in
  // a redesign's regenerated design:dispatch looks like this)
  expect(planReviewResume(db, ticketId, HEAD, false, {}).kind).toBe("none");
  // the plan review verdict's escalation (its dispatch is the latest design:review dispatch)
  appendEvent(db, {
    ticketId,
    dispatchId: "review-1",
    kind: "escalated",
    reason: "no progress: identical plan-review findings",
    signature: "review:x",
  });
  expect(planReviewResume(db, ticketId, HEAD, false, {}).kind).toBe("retry-plan");
  // a redesign after the stop: the run moved on
  appendEvent(db, {
    ticketId,
    kind: "loopback",
    loop: "design",
    routeTo: "review",
    signature: "s",
  });
  expect(planReviewResume(db, ticketId, HEAD, false, {}).kind).toBe("none");
  // a resume since the stop: the stop belongs to an earlier run
  stopAtPlanGate(db, ticketId);
  appendEvent(db, { ticketId, kind: "resumed", reason: "resume" });
  expect(planReviewResume(db, ticketId, HEAD, false, {}).kind).toBe("none");
});

test("an unrelated escalation after a gate stop does not hide it (ruling 2026-10-09)", () => {
  const { db, ticketId } = seed("plan");
  stopAtPlanGate(db, ticketId);
  // the projector giving up on a row in the run's final drain: a reason, no signature, no dispatch
  appendEvent(db, { ticketId, kind: "escalated", reason: "projection failed after 5 attempts" });
  expect(planReviewResume(db, ticketId, HEAD, false, {}).kind).toBe("retry-plan");
  // the resume's toolchain pause, written by pauseTicket
  pauseTicket(db, ticketId, "this host lacks the tools for lib (missing: `lib-build`)");
  expect(planReviewResume(db, ticketId, HEAD, false, {}).kind).toBe("retry-plan");
});

test("an escalation of the invalidate loop guard that carries the design:review dispatch id is not a gate stop", () => {
  const { db, ticketId } = seed("plan");
  // the interpreter's escalations carry the ticket's latest dispatch: here the design:review one
  appendEvent(db, {
    ticketId,
    dispatchId: "review-1",
    kind: "escalated",
    reason: "design step 'provision' keeps finding changed inputs",
    signature: "invalidate-loop:provision",
  });
  expect(planReviewResume(db, ticketId, HEAD, false, {}).kind).toBe("none");
});
```

- in `plan review cannot accept risks...`, the last line becomes `expect(getByKey(db, ticketId, "design:review")?.status).toBe("succeeded");` followed by

```ts
  const loopback = events(db, ticketId).filter((e) => e.kind === "loopback").at(-1);
  expect(JSON.parse(loopback?.payload_json ?? "{}")).toMatchObject({ consumer: "design:dispatch" });
```

- in `same-HEAD repeated plan findings stay paused; explicit moved HEAD re-arms design`, the last line becomes `expect(listUnits(db, ticketId)).toEqual([]); // dispatch and extract invalidated: units re-created` (import `listByTicket as listUnits` from `../../src/db/repos/work-unit.ts`).

- [ ] **Step 7: Run the tests and see them pass**

Run: `perl -e 'alarm 600; exec @ARGV' bun test test/daemon test/dispatch test/cli/park.test.ts test/cli/park-resume-e2e.test.ts test/cli/plan-review-resume-e2e.test.ts test/cli/adopt-v8-e2e.test.ts`
Expected: PASS.

- [ ] **Step 8: Break it on purpose, see it fail, restore**

1. In `designFeedback`, drop the generation condition: the feedback test fails (the old findings reach generation 2). Restore.
2. In `carryoverMismatch`, drop `|| rc.generation !== ctx.step.generation`: the generation carryover test fails. Restore.
2a. In `carryoverMismatch`, replace the last `return changedInputs(...)` with `return [];`: the "recorded under other inputs" test fails. Restore.
3. In `applyReviewVerdict`'s plan-defect path, pass `["design:dispatch"]` only: the existing `review-verdict.test.ts` test `blocking plan-defect, config redesign → loopback to design (units cleared, design+review steps reset)` (line 182) fails on `expect(units.length).toBe(0)`. (The code review redesign test in `loopback-invalidate.test.ts` calls `redesignLoopback` directly with both steps, so this change does not reach it.) Restore.
4. In `planReviewResume`, drop `stoppedAtPlanReviewGate(db, ticketId)` from the plan review branch: `a budget pause in the regenerated design:dispatch after a plan review redesign resumes and dispatches it` fails (the resume reapplies the plan review verdict, escalates on the same findings, and dispatches nothing: `design:dispatch` stays at two calls), and so does `a plan review resume is retry-plan only when the run stopped at the plan review gate`. Restore.
4a. In `stoppedAtPlanReviewGate`, look only at the latest `escalated` event (`since.findLastIndex((e) => e.kind === "escalated")`): `an unrelated escalation after a gate stop does not hide it` fails. Only that unit case catches this break: the end to end test `a gate stop resumed on a host missing a required suite's tools ...` still passes, because the pause skip (break 4b's subject) leaves no second escalation after the verdict's. Restore. In `isPlanReviewEscalation`, accept a dispatch id match without the `review:` signature: `an escalation of the invalidate loop guard that carries the design:review dispatch id is not a gate stop` fails. Restore.
4b. In `resumeRun` (Task 8's narrowing block), call `pauseTicket` even when the ticket is already waiting: the gate and tools end to end test fails on two pending `human_resume` signals. Restore.
5. In `adoptUnfingerprinted`, drop the `stopped` condition again: `a v8 run stopped at the plan review gate, resumed after the operator edited the plan, finishes` and `a v8 run paused during a redesign with grading on ...` fail with exit 70 (`the plan has no recorded digest`). Restore.

- [ ] **Step 9: Run the whole suite, then commit**

Run: `perl -e 'alarm 600; exec @ARGV' bun test`
Expected: PASS.

```bash
git add src/daemon/review-verdict.ts src/daemon/review-resume.ts src/dispatch/design-feedback.ts src/dispatch/run-dispatch.ts src/dispatch/handlers.ts src/cli/park.ts test
git commit -m "feat(eng-477): redesign loopbacks invalidate their consumer; feedback and carryover belong to a generation" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 15: Enforcement: the current step slot, named accessors, the recording proxy test, the source guard

**Files:**
- Create: `src/daemon/current-step.ts`, `src/daemon/design-reads.ts`
- Modify: `src/daemon/advance.ts:187-281` (set the slot before `runStep`, clear it in `finally`)
- Modify: `src/dispatch/handlers.ts` (`design:size` and `design:review` read units through `readWorkUnitsForDesign`)
- Test: `test/daemon/design-reads.test.ts`, `test/daemon/design-reads-proxy.test.ts`, `test/dispatch/design-handler-guard.test.ts`

**Interfaces:**
- Consumes: `declaresInput`, `DESIGN_TABLE`, `isSnapshotInput`, `InputName` (Task 6); `makeDesignTicket`, `driveUntil`, `atStep` (Task 7); `scriptedRunner`, `newCalls`, `defaultScript` (Task 7).
- Produces:
  - `setCurrentStep(stepKey: string | null): void`, `currentStepKey(): string | null`
  - `class UndeclaredReadError extends Error`, `readWorkUnitsForDesign(db: Database, ticketId: number): WorkUnitRow[]`

- [ ] **Step 1: Write the failing tests**

```ts
// test/daemon/design-reads.test.ts
import { afterEach, expect, test } from "bun:test";
import { setCurrentStep } from "../../src/daemon/current-step.ts";
import { UndeclaredReadError, readWorkUnitsForDesign } from "../../src/daemon/design-reads.ts";
import { makeTestDb } from "../helpers/db.ts";

afterEach(() => setCurrentStep(null));

test("an accessor answers the step that declares the read", () => {
  const { db, ticketId } = makeTestDb();
  for (const key of ["design:size", "design:review"]) {
    setCurrentStep(key);
    expect(readWorkUnitsForDesign(db, ticketId)).toEqual([]);
  }
  db.close();
});

test("an accessor called while another step is current throws (§8.10)", () => {
  const { db, ticketId } = makeTestDb();
  setCurrentStep("design:dispatch");
  expect(() => readWorkUnitsForDesign(db, ticketId)).toThrow(UndeclaredReadError);
  setCurrentStep("checks:dispatch"); // outside the table: reads the repositories directly instead
  expect(() => readWorkUnitsForDesign(db, ticketId)).toThrow(UndeclaredReadError);
  setCurrentStep(null);
  expect(() => readWorkUnitsForDesign(db, ticketId)).toThrow("no step in flight");
  db.close();
});
```

```ts
// test/daemon/design-reads-proxy.test.ts
import { expect, test } from "bun:test";
import { DEFAULT_AGENT_CONFIG } from "../../src/config/agent-config.ts";
import { currentStepKey } from "../../src/daemon/current-step.ts";
import {
  DESIGN_TABLE,
  type InputName,
  type StepRow,
  declaresInput,
  isSnapshotInput,
} from "../../src/daemon/design-graph.ts";
import { type HandlerContext, StepRegistry } from "../../src/daemon/step-registry.ts";
import { buildDispatchRegistry } from "../../src/dispatch/handlers.ts";
import { defaultScript, newCalls, scriptedRunner } from "../helpers/design-script.ts";
import {
  STEP_TEST_TIMEOUT_MS,
  atStep,
  driveUntil,
  makeDesignTicket,
} from "../helpers/design-steps.ts";

type Label = "ticket" | "profile" | "config";
/** Fields every handler may read: identity and routing of the ticket, not design inputs. `ident`
 *  names dispatches and the branch for every step (it is fixed for the run, E2). */
const INFRASTRUCTURE: Record<Label, ReadonlySet<string>> = {
  ticket: new Set(["id", "project_id", "ident", "stage", "branch_name", "branch_prefix"]),
  profile: new Set(),
  config: new Set(),
};

function recording<T extends object>(target: T, label: Label, reads: Map<string, Set<string>>): T {
  return new Proxy(target, {
    get(obj, prop, receiver) {
      const step = currentStepKey();
      if (step !== null && typeof prop === "string") {
        const seen = reads.get(step) ?? new Set<string>();
        seen.add(`${label}.${prop}`);
        reads.set(step, seen);
      }
      return Reflect.get(obj, prop, receiver);
    },
  });
}

/** Wraps each handler so the ticket and config it receives are recording proxies. */
class RecordingRegistry extends StepRegistry {
  constructor(
    private readonly real: StepRegistry,
    private readonly reads: Map<string, Set<string>>,
  ) {
    super(real.synchronize);
  }
  override resolve(handlerKey: string) {
    const h = this.real.resolve(handlerKey);
    if (!h) return h;
    return (ctx: HandlerContext) =>
      h({
        ...ctx,
        ticket: recording(ctx.ticket, "ticket", this.reads),
        config: recording(ctx.config, "config", this.reads),
      });
  }
  override resolveCommit(handlerKey: string) {
    return this.real.resolveCommit(handlerKey);
  }
}

async function readsOf(complexityGrading: boolean): Promise<Map<string, Set<string>>> {
  const t = makeDesignTicket({ config: { complexityGrading } });
  const reads = new Map<string, Set<string>>();
  const real = buildDispatchRegistry({
    runner: scriptedRunner(defaultScript(), newCalls()),
    agentConfig: DEFAULT_AGENT_CONFIG,
    profile: recording(t.profile, "profile", reads),
    worktreeRoot: t.worktreeRoot,
  });
  await driveUntil(
    { ...t, registry: new RecordingRegistry(real, reads) },
    atStep("checks:dispatch"),
  );
  return reads;
}

const tableSteps = DESIGN_TABLE.filter((r): r is StepRow => r.kind === "step");

for (const grading of [false, true]) {
  test(
    `grading ${grading ? "on" : "off"}: no design handler reads a field the table does not declare for it (§8.10)`,
    async () => {
      const reads = await readsOf(grading);
      const undeclared: string[] = [];
      for (const row of tableSteps) {
        for (const read of reads.get(row.stepKey) ?? []) {
          const [label, field] = read.split(".") as [Label, string];
          if (INFRASTRUCTURE[label].has(field)) continue;
          if (!declaresInput(row.stepKey, read as InputName))
            undeclared.push(`${row.stepKey} reads ${read}`);
        }
      }
      expect(undeclared).toEqual([]);
    },
    STEP_TEST_TIMEOUT_MS,
  );
}

test(
  "every declared ticket, profile and config input is read by its step in some branch",
  async () => {
    const off = await readsOf(false);
    const on = await readsOf(true);
    const missing: string[] = [];
    for (const row of tableSteps) {
      const seen = new Set([...(off.get(row.stepKey) ?? []), ...(on.get(row.stepKey) ?? [])]);
      for (const name of [
        ...row.inputs({ complexityGrading: false }),
        ...row.inputs({ complexityGrading: true }),
      ]) {
        if (!isSnapshotInput(name) || name.startsWith("run.")) continue; // run.* come from the registry, not the proxied objects
        if (!seen.has(name)) missing.push(`${row.stepKey} never reads ${name}`);
      }
    }
    expect([...new Set(missing)]).toEqual([]);
  },
  STEP_TEST_TIMEOUT_MS,
);
```

```ts
// test/dispatch/design-handler-guard.test.ts
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// spec §3 (E8): design handlers read upstream rows only through the named accessors in
// src/daemon/design-reads.ts, which check the current step at run time. This guard keeps the
// design handler blocks in handlers.ts from calling the upstream repositories directly.
const SOURCE = readFileSync(join(import.meta.dir, "../../src/dispatch/handlers.ts"), "utf8");
const GUARDED = ["work-unit", "review-finding", "review-round", "ticket"];

function importedNames(source: string): string[] {
  const names: string[] = [];
  const re = /import\s*\{([^}]*)\}\s*from\s*"\.\.\/db\/repos\/([a-z-]+)\.ts"/g;
  for (const m of source.matchAll(re)) {
    if (!GUARDED.includes(m[2])) continue;
    for (const part of m[1].split(",")) {
      const local = part
        .trim()
        .split(/\s+as\s+/)
        .pop()
        ?.replace(/^type\s+/, "")
        .trim();
      if (local && !/^[A-Z]/.test(local)) names.push(local); // values, not types
    }
  }
  return names;
}

/** The text of each `registry.register("<key>", ...)` call for the design table's steps. */
function designBlocks(source: string): Map<string, string> {
  const out = new Map<string, string>();
  const re = /registry\.register\(\s*"(provision|design:[a-z]+)"/g;
  for (const m of source.matchAll(re)) {
    let depth = 0;
    let i = source.indexOf("(", m.index);
    const start = i;
    for (; i < source.length; i++) {
      if (source[i] === "(") depth++;
      else if (source[i] === ")" && --depth === 0) break;
    }
    out.set(m[1], source.slice(start, i + 1));
  }
  return out;
}

test("design handlers do not call the upstream repositories directly", () => {
  const names = importedNames(SOURCE);
  expect(names.length).toBeGreaterThan(0);
  const blocks = designBlocks(SOURCE);
  expect([...blocks.keys()].sort()).toEqual(
    ["design:dispatch", "design:extract", "design:review", "design:size", "provision"].sort(),
  );
  const offences: string[] = [];
  for (const [key, text] of blocks) {
    for (const name of names) {
      if (new RegExp(`\\b${name}\\s*\\(`).test(text)) offences.push(`${key} calls ${name}`);
    }
  }
  expect(offences).toEqual([]);
});
```

- [ ] **Step 2: Run them and see them fail**

Run: `perl -e 'alarm 600; exec @ARGV' bun test test/daemon/design-reads.test.ts test/daemon/design-reads-proxy.test.ts test/dispatch/design-handler-guard.test.ts`
Expected: FAIL: the first two files with `Cannot find module '../../src/daemon/current-step.ts'`, and the guard with `design:size calls listUnits` and `design:review calls listUnits`.

- [ ] **Step 3: Write the slot and the accessor**

```ts
// src/daemon/current-step.ts
/** The step key in flight, set by advance.ts around runStep and cleared after (spec §3, E8). Steps
 *  run one at a time per ticket, and `styre run` drives one ticket, so one slot suffices. */
let current: string | null = null;

export function setCurrentStep(stepKey: string | null): void {
  current = stepKey;
}

export function currentStepKey(): string | null {
  return current;
}
```

```ts
// src/daemon/design-reads.ts
import type { Database } from "bun:sqlite";
import { type WorkUnitRow, listByTicket } from "../db/repos/work-unit.ts";
import { currentStepKey } from "./current-step.ts";
import { type OutputName, declaresInput } from "./design-graph.ts";

/** A design handler read an upstream output its row does not declare (spec §3, E8). */
export class UndeclaredReadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UndeclaredReadError";
  }
}

function assertDeclared(output: OutputName): void {
  const step = currentStepKey();
  if (step === null) throw new UndeclaredReadError(`no step in flight reads ${output}`);
  if (!declaresInput(step, output))
    throw new UndeclaredReadError(
      `${step} reads ${output}, which the design table does not declare for it`,
    );
}

/** design:extract's units, for the design steps that declare them (design:size, design:review).
 *  Steps outside the table keep reading the repository directly. */
export function readWorkUnitsForDesign(db: Database, ticketId: number): WorkUnitRow[] {
  assertDeclared("workUnits");
  return listByTicket(db, ticketId);
}
```

- [ ] **Step 4: Set the slot in advance, and use the accessor in the handlers**

`src/daemon/advance.ts`: import `setCurrentStep` from `./current-step.ts`; immediately before `const execution = await runStep(db, {` add `setCurrentStep(d.stepKey);`, and at the start of the existing `finally {` block (line 279) add `setCurrentStep(null);` before `checkAgentLeftovers(...)`.

`src/dispatch/handlers.ts`: import `readWorkUnitsForDesign` from `../daemon/design-reads.ts`; in `design:size` and `design:review`, replace `const units = listUnits(ctx.db, ctx.ticket.id);` with `const units = readWorkUnitsForDesign(ctx.db, ctx.ticket.id);`.

- [ ] **Step 5: Run the tests and see them pass**

Run: `perl -e 'alarm 600; exec @ARGV' bun test test/daemon/design-reads.test.ts test/daemon/design-reads-proxy.test.ts test/dispatch/design-handler-guard.test.ts test/dispatch/design-size.test.ts test/dispatch/design-review-e2e.test.ts`
Expected: PASS.

- [ ] **Step 6: Break it on purpose, see it fail, restore**

1. At the top of the `design:review` handler add `void ctx.ticket.description;`. The proxy test fails with `design:review reads ticket.description`. Restore.
2. In `design:size`, put back `listUnits(ctx.db, ctx.ticket.id)`. The guard fails with `design:size calls listUnits`. Restore.
3. Remove `setCurrentStep(d.stepKey);` from advance. design:size and design:review throw `no step in flight reads workUnits` (the size test fails). Restore.

- [ ] **Step 7: Run the whole suite, then commit**

Run: `perl -e 'alarm 600; exec @ARGV' bun test`
Expected: PASS.

```bash
git add src/daemon/current-step.ts src/daemon/design-reads.ts src/daemon/advance.ts src/dispatch/handlers.ts test/daemon/design-reads.test.ts test/daemon/design-reads-proxy.test.ts test/dispatch/design-handler-guard.test.ts
git commit -m "test(eng-477): enforce the design table: accessors checked at run time, a recording proxy, a source guard" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 16: The invalidate loop guard

**Files:**
- Modify: `src/daemon/design-walk.ts` (escalate before a fourth `inputs` invalidation of one step since the run was last started: the latest `resumed` event, or the latest `reused-database` note)
- Modify: `src/daemon/run-ticket.ts` (a `styre run` on a reused `--db` whose ticket already exists writes a `reused-database` note; review minor 2: that path rewrites the inputs as a resume does, spec §4, but appends no `resumed` event, so without the note the count would accumulate across separate runs)
- Test: `test/daemon/invalidate-loop.test.ts`

**Interfaces:**
- Consumes: `walkDesign` (Task 13); `captureSnapshot` (Task 7); `makeDesignTicket`, `driveUntil`, `atStep` (Task 7).
- Produces: `INVALIDATE_LOOP_LIMIT = 3`; `inputsInvalidationsSinceResume(db: Database, ticketId: number, stepKey: string): number` (counted after the latest `resumed` event or `reused-database` note); the escalation `{ kind: "escalate", signature: "invalidate-loop:<step>", stepKey: <step> }`; the `note` reason `reused-database` (payload `{ event: "reused-database" }`).

- [ ] **Step 1: Write the failing test**

```ts
// test/daemon/invalidate-loop.test.ts
import { expect, test } from "bun:test";
import { join } from "node:path";
import { advanceOneStep } from "../../src/daemon/advance.ts";
import { captureSnapshot } from "../../src/daemon/design-inputs.ts";
import { invalidateSteps } from "../../src/daemon/invalidate.ts";
import { nextStepKey } from "../../src/daemon/resolver.ts";
import { appendEvent, listByTicket as listEvents } from "../../src/db/repos/event-log.ts";
import { getTicket } from "../../src/db/repos/ticket.ts";
import { DesignHarness, HARNESS_TEST_TIMEOUT_MS } from "../helpers/design-harness.ts";
import {
  type DesignTicket,
  STEP_TEST_TIMEOUT_MS,
  atStep,
  driveUntil,
  makeDesignTicket,
} from "../helpers/design-steps.ts";
import { makeTempDir } from "../helpers/temp.ts";

/** A digest that changes on every pass: the stand-in for a defect such as an unstable encoding. */
function unstable(t: DesignTicket, i: number): void {
  captureSnapshot(t.db, t.ticketId, {
    profile: { ...t.profile, promptVars: { stack: "ruby", pass: String(i) } },
    unusableComponents: [],
    nonPrimaryComponents: [],
    config: t.config,
  });
}

test(
  "a step invalidated for inputs more than three times since the last resume escalates invalidate-loop (§8.14)",
  async () => {
    const t = makeDesignTicket();
    await driveUntil(t, atStep("checks:dispatch"));
    for (let i = 1; i <= 3; i++) {
      unstable(t, i);
      await driveUntil(t, atStep("checks:dispatch"));
    }
    unstable(t, 4);
    const d = nextStepKey(t.db, t.ticketId);
    expect(d).toMatchObject({
      kind: "escalate",
      signature: "invalidate-loop:design:dispatch",
      stepKey: "design:dispatch",
    });
  },
  STEP_TEST_TIMEOUT_MS,
);

test(
  "feedback invalidations do not count toward the guard",
  async () => {
    const t = makeDesignTicket();
    await driveUntil(t, atStep("checks:dispatch"));
    for (let i = 1; i <= 4; i++) {
      invalidateSteps(t.db, t.ticketId, ["design:dispatch"], { cause: "feedback" });
      await driveUntil(t, atStep("checks:dispatch"));
    }
    unstable(t, 1);
    expect(nextStepKey(t.db, t.ticketId)).toMatchObject({
      kind: "invalidate",
      stepKeys: ["design:dispatch"],
    });
  },
  STEP_TEST_TIMEOUT_MS,
);

test(
  "the count starts again after a resumed event",
  async () => {
    const t = makeDesignTicket();
    await driveUntil(t, atStep("checks:dispatch"));
    for (let i = 1; i <= 3; i++) {
      unstable(t, i);
      await driveUntil(t, atStep("checks:dispatch"));
    }
    appendEvent(t.db, { ticketId: t.ticketId, kind: "resumed", reason: "resume" });
    unstable(t, 4);
    expect(nextStepKey(t.db, t.ticketId)).toMatchObject({
      kind: "invalidate",
      stepKeys: ["design:dispatch"],
    });
  },
  STEP_TEST_TIMEOUT_MS,
);

test(
  "the count starts again after a reused-database note",
  async () => {
    const t = makeDesignTicket();
    await driveUntil(t, atStep("checks:dispatch"));
    for (let i = 1; i <= 3; i++) {
      unstable(t, i);
      await driveUntil(t, atStep("checks:dispatch"));
    }
    appendEvent(t.db, {
      ticketId: t.ticketId,
      kind: "note",
      reason: "reused-database",
      payload: { event: "reused-database" },
    });
    unstable(t, 4);
    expect(nextStepKey(t.db, t.ticketId)).toMatchObject({
      kind: "invalidate",
      stepKeys: ["design:dispatch"],
    });
  },
  STEP_TEST_TIMEOUT_MS,
);

test(
  "a second styre run on a reused --db writes a reused-database note; the first does not",
  async () => {
    const h = new DesignHarness("in-place");
    const dbFile = join(makeTempDir("styre-reuse-loop-"), "reuse.db");
    const notes = () =>
      h.readAt(dbFile, (db, id) =>
        listEvents(db, id).filter((e) => e.reason === "reused-database"),
      );
    expect(await h.fresh({ db: dbFile })).toBe(75);
    expect(notes()).toEqual([]);
    expect(await h.fresh({ db: dbFile })).toBe(75);
    expect(notes()).toHaveLength(1);
  },
  HARNESS_TEST_TIMEOUT_MS,
);

test(
  "the interpreter escalates the loop to the operator",
  async () => {
    const t = makeDesignTicket();
    await driveUntil(t, atStep("checks:dispatch"));
    for (let i = 1; i <= 4; i++) {
      unstable(t, i);
      await driveUntil(
        t,
        (d) => (d.kind === "step" && d.stepKey === "checks:dispatch") || d.kind === "escalate",
      );
    }
    expect(await advanceOneStep(t.db, t.ticketId, t.registry, { config: t.config })).toEqual({
      kind: "escalated",
      stepKey: "design:dispatch",
    });
    expect(getTicket(t.db, t.ticketId)?.status).toBe("waiting");
    expect(listEvents(t.db, t.ticketId).at(-1)?.signature).toBe("invalidate-loop:design:dispatch");
  },
  STEP_TEST_TIMEOUT_MS,
);
```

- [ ] **Step 2: Run it and see it fail**

Run: `perl -e 'alarm 600; exec @ARGV' bun test test/daemon/invalidate-loop.test.ts`
Expected: FAIL: the first test receives `{ kind: "invalidate", stepKeys: ["design:dispatch"], ... }` instead of the escalation.

- [ ] **Step 3: Add the guard to the walk**

In `src/daemon/design-walk.ts`, import `listByTicket as listEvents` from `../db/repos/event-log.ts`, add:

```ts
/** spec §6.6: an unchanged step cannot be invalidated again after it reruns, so more than three
 *  `inputs` invalidations of one step since the run was last started is a defect (an unstable
 *  digest, say). Fail fast. */
export const INVALIDATE_LOOP_LIMIT = 3;

/** A start of the run on an existing database: a resume, or a `styre run` on a reused --db. */
const startsARun = (e: { kind: string; reason: string | null }): boolean =>
  e.kind === "resumed" || (e.kind === "note" && e.reason === "reused-database");

export function inputsInvalidationsSinceResume(
  db: Database,
  ticketId: number,
  stepKey: string,
): number {
  const events = listEvents(db, ticketId);
  const since = events.filter(startsARun).at(-1)?.seq ?? 0;
  return events.filter((e) => {
    if (e.seq <= since || e.kind !== "note" || e.reason !== "invalidated" || e.payload_json === null) return false;
    const p = JSON.parse(e.payload_json) as { cause?: string; stepKeys?: string[] };
    return p.cause === "inputs" && (p.stepKeys ?? []).includes(stepKey);
  }).length;
}
```

`src/daemon/run-ticket.ts`: import `getByIdent` from `../db/repos/ticket.ts` and `appendEvent` from `../db/repos/event-log.ts`; in `runTicket`, right before `const ticketId = insertTicket(deps.db, {`, add `const reused = getByIdent(deps.db, projectId, ingested.ident) !== null;`, and right before the `captureSnapshot(deps.db, ticketId, deps.inputs);` line added in Task 7:

```ts
  // A `styre run` on a reused --db drives an existing ticket again: the loop guard counts from
  // here, as it does from a resume (spec §6.6). A new database has no such ticket.
  if (reused) {
    appendEvent(deps.db, {
      ticketId,
      kind: "note",
      reason: "reused-database",
      payload: { event: "reused-database" },
    });
  }
```

and in Task 7's loop over the other active tickets, replace its body with the same note before each one's snapshot (operator ruling, 2026-10-10: every active ticket of a reused `--db` is prepared with the same notes; each is driven again on it, so the loop guard counts from here for it too):

```ts
    if (other.id === ticketId) continue;
    appendEvent(deps.db, {
      ticketId: other.id,
      kind: "note",
      reason: "reused-database",
      payload: { event: "reused-database" },
    });
    captureSnapshot(deps.db, other.id, deps.inputs);
```

and in `walkDesign` replace the mismatch return with:

```ts
    if (changed.length > 0) {
      if (inputsInvalidationsSinceResume(db, ticket.id, row.stepKey) >= INVALIDATE_LOOP_LIMIT) {
        return {
          kind: "escalate",
          reason: `design step '${row.stepKey}' keeps finding changed inputs (${changed.join(", ")}) after rerunning; an input digest is unstable`,
          signature: `invalidate-loop:${row.stepKey}`,
          stepKey: row.stepKey,
        };
      }
      return { kind: "invalidate", stepKeys: [row.stepKey], reason: { cause: "inputs", changed } };
    }
```

- [ ] **Step 4: Run it and see it pass**

Run: `perl -e 'alarm 600; exec @ARGV' bun test test/daemon/invalidate-loop.test.ts test/daemon/design-walk.test.ts`
Expected: PASS.

- [ ] **Step 5: Break it on purpose, see it fail, restore**

1. Set `INVALIDATE_LOOP_LIMIT = 1_000`: the first test (`... escalates invalidate-loop (§8.14)`) and the sixth (`the interpreter escalates the loop to the operator`) fail; the fourth, on the `reused-database` note, expects an invalidation and still passes. Restore.
2. Drop `p.cause === "inputs" &&` from the filter: `feedback invalidations do not count toward the guard` fails (it escalates). Restore.
3. Drop the `e.seq <= since ||` condition: `the count starts again after a resumed event` fails. Restore.
4. In `startsARun`, drop the `reused-database` clause: `the count starts again after a reused-database note` fails. Restore.

- [ ] **Step 6: Commit**

```bash
git add src/daemon/design-walk.ts src/daemon/run-ticket.ts test/daemon/invalidate-loop.test.ts
git commit -m "feat(eng-477): escalate invalidate-loop when a design step keeps being invalidated for inputs" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 17: The end to end tests of spec §8 not already written

Earlier tasks own: §8.3 (Tasks 8, 13), §8.4 (Task 8), §8.5 (Task 14), §8.10 (Tasks 6, 15), §8.11 (Task 7), §8.12 (Tasks 2, 3, 4), §8.13 (Task 12), §8.14 (Task 16), §8.15 (Tasks 5, 9). This task adds §8.1, §8.2, §8.6, §8.7, §8.8 and §8.9 end to end. Tests that resume more than once use in-place mode: in worktree mode every resume recreates the ticket branch (`git worktree add -B` with no start point resets it to the target repository's checked out HEAD, ENG-488), which moves HEAD, so the next resume is refused unless a dispatch has committed on the recreated branch since (hand off note 10); that is the known limit the PR names.

**Files:**
- Create: `test/fixtures/design/crash-resume.ts`
- Test: `test/cli/design-inputs-e2e.test.ts`, `test/cli/design-crash-e2e.test.ts`, `test/daemon/design-livelock.test.ts`

**Interfaces:**
- Consumes: `DesignHarness`, `HARNESS_TEST_TIMEOUT_MS` (Task 7, with `slug`/`repoDir` options), `STEP_TEST_TIMEOUT_MS`, `scriptedRunner`, `defaultScript`, `newCalls`, `unitsOf`, `harnessProfileRaw` (Task 7); `makeTempDir`, `trackTempEntriesMadeBy` (`test/helpers/temp.ts`); `ownChild` (`test/helpers/own-processes.ts`); `resumeRun`, `ResumeRegistryWiring` (Task 8); `redesignLoopback` (Task 14); `currentManifest` (Task 9); `listStepHistory` (Task 10); `DESIGN_TABLE`, `StepRow` (Task 6); `StepRegistry` with `resolveCommit` (Task 9); `loadRunProfile` (`src/cli/load-profile.ts:40`); `discoverRuntimeConfig` (`src/config/discover.ts`).
- Produces: nothing used by later tasks. (The "after invalidate" crash point needs no production seam: the crash driver stops inside its `resolve` override once the step's generation has grown, second review m2.)

- [ ] **Step 1: Write the per input, E6, feedback and output clearing tests**

```ts
// test/cli/design-inputs-e2e.test.ts
import { afterEach, describe, expect, test } from "bun:test";
import { captureSnapshot } from "../../src/daemon/design-inputs.ts";
import { redesignLoopback } from "../../src/daemon/review-verdict.ts";
import { openDb } from "../../src/db/client.ts";
import { listByTicket as listEvents } from "../../src/db/repos/event-log.ts";
import { listByTicket as listFindings } from "../../src/db/repos/review-finding.ts";
import { listStepHistory } from "../../src/db/repos/step-history.ts";
import { listByTicket as listUnits } from "../../src/db/repos/work-unit.ts";
import { DesignHarness, HARNESS_TEST_TIMEOUT_MS } from "../helpers/design-harness.ts";
import { type ScriptFinding, type ScriptStep, unitsOf } from "../helpers/design-script.ts";
import { atStep, driveUntil, makeDesignTicket } from "../helpers/design-steps.ts";

const harnesses: DesignHarness[] = [];
const make = (): DesignHarness => {
  const h = new DesignHarness("in-place");
  harnesses.push(h);
  return h;
};
afterEach(() => {
  for (const h of harnesses.splice(0)) h.cleanup();
});

const inputInvalidations = (h: DesignHarness): string[] =>
  h.read((db, id) =>
    listEvents(db, id)
      .filter((e) => e.reason === "invalidated")
      .map(
        (e) =>
          JSON.parse(e.payload_json ?? "{}") as {
            event: string;
            stepKeys: string[];
            cause: string;
            changed: string[];
          },
      )
      .filter((p) => p.cause === "inputs")
      .flatMap((p) => p.stepKeys),
  );
const AGENT_STEPS: Record<string, ScriptStep | null> = {
  provision: null,
  "design:dispatch": "design:dispatch",
  "design:extract": "design:extract",
  "design:size": "design:size",
  "design:review": "design:review",
};

interface InputCase {
  input: string;
  edit: (h: DesignHarness) => void;
  reruns: string[];
}

const CASES: InputCase[] = [
  {
    input: "profile.components",
    edit: (h) =>
      h.editProfile((p) => {
        p.components = [
          ...(p.components as unknown[]),
          {
            name: "extra",
            kind: "ruby",
            paths: ["extra/**"],
            commands: { build: "true", test: "true", check: "true" },
          },
        ];
      }),
    reruns: ["provision", "design:dispatch", "design:extract"],
  },
  {
    input: "profile.promptVars",
    edit: (h) =>
      h.editProfile((p) => {
        p.promptVars = { stack: "ruby", tone: "terse" };
      }),
    reruns: ["design:dispatch", "design:extract", "design:review"],
  },
  {
    input: "profile.runtimeContext",
    edit: (h) =>
      h.editProfile((p) => {
        p.runtimeContext = { ...(p.runtimeContext as object), topology: { type: "web-service" } };
      }),
    reruns: ["design:dispatch", "design:extract"],
  },
  {
    input: "run.nonPrimaryComponents",
    edit: (h) =>
      h.editProfile((p) => {
        p.components = [
          ...(p.components as unknown[]),
          {
            name: "fixture-app",
            kind: "ruby",
            role: "fixture",
            paths: ["fixtures/**"],
            commands: { build: "true", test: "true", check: "true" },
          },
        ];
      }),
    reruns: ["provision"], // the narrowed profile is unchanged; only provision reads the list
  },
  {
    input: "config.complexityGrading",
    edit: (h) =>
      h.editConfig((c) => {
        c.complexityGrading = true;
      }),
    reruns: ["design:size"], // grade 6 keeps the track full, so design:review stays done
  },
];

describe("§8.1: each input reruns exactly its dependants", () => {
  for (const c of CASES) {
    test(
      `${c.input}`,
      async () => {
        const h = make();
        expect(await h.fresh()).toBe(75); // design done; paused at checks:dispatch
        const before = { ...h.calls.counts };
        c.edit(h);
        expect(await h.resume()).toBe(75);
        expect(inputInvalidations(h).sort()).toEqual([...c.reruns].sort());
        for (const [key, agent] of Object.entries(AGENT_STEPS)) {
          if (agent === null) continue;
          // design:size calls an agent only with grading on, which is the one case that reruns it
          expect(h.calls.counts[agent]).toBe(
            c.reruns.includes(key) ? before[agent] + 1 : before[agent],
          );
        }
        // the checks steps are outside the table: never invalidated, no history (E9)
        h.read((db, id) => {
          expect(listStepHistory(db, id).some((r) => r.step_key.startsWith("checks:"))).toBe(false);
        });
      },
      HARNESS_TEST_TIMEOUT_MS,
    );
  }

  test(
    "profile.slug (not editable across a resume: the checkpoint folder is keyed by it)",
    async () => {
      const t = makeDesignTicket();
      await driveUntil(t, atStep("checks:dispatch"));
      captureSnapshot(t.db, t.ticketId, {
        profile: { ...t.profile, slug: "renamed" },
        unusableComponents: [],
        nonPrimaryComponents: [],
        config: t.config,
      });
      await driveUntil(t, atStep("checks:dispatch"));
      const invalidated = listEvents(t.db, t.ticketId)
        .filter((e) => e.reason === "invalidated")
        .map((e) => JSON.parse(e.payload_json ?? "{}").stepKeys[0]);
      expect(invalidated).toEqual(["design:dispatch", "design:extract", "design:review"]);
    },
    HARNESS_TEST_TIMEOUT_MS,
  );
});

test(
  "§8.2 (E6): an edit while paused in implement reruns nothing now, says so, and a later redesign picks it up",
  async () => {
    const h = make();
    const script = { units: () => unitsOf(2, { behavioral: false }), parkAt: "implement" as const };
    expect(await h.fresh({ script })).toBe(75); // parked at implement:wu1:dispatch
    const designCalls = () => [
      h.calls.counts["design:dispatch"],
      h.calls.counts["design:extract"],
      h.calls.counts["design:review"],
    ];
    const before = designCalls();
    h.editProfile((p) => {
      p.promptVars = { stack: "ruby", tone: "terse" };
    });
    expect(await h.resume({ script })).toBe(75); // parks at implement again
    expect(designCalls()).toEqual(before);
    expect(inputInvalidations(h)).toEqual([]);
    const note = h.read((db, id) => listEvents(db, id).find((e) => e.reason === "inputs-changed"));
    expect(JSON.parse(note?.payload_json ?? "{}")).toMatchObject({
      pastDesign: true,
      names: ["profile.promptVars"],
    });
    // a redesign (as code review's plan-defect route would make) returns the run to design
    const db = openDb(h.dbPath()); // foreign keys on, so deleting the units cascades as in a run
    const id = (db.query("SELECT id FROM ticket").get() as { id: number }).id;
    redesignLoopback(db, id, "review:plan-defect", [], null, ["design:dispatch", "design:extract"]);
    db.close();
    expect(await h.resume({ script })).toBe(75);
    expect(inputInvalidations(h)).toContain("design:review"); // the edit took effect in design
  },
  HARNESS_TEST_TIMEOUT_MS,
);

test(
  "§8.7: after a redesign, a profile edit and a resume, the next generation gets no stale findings and no carryover",
  async () => {
    const finding = (rationale: string, location: string): ScriptFinding => ({
      severity: "critical",
      category: "feasibility",
      location,
      rationale,
      factors: null,
      deferral_candidate: false,
      work_unit_seq: null,
    });
    const script = {
      plan: (n: number) => `Plan body, version ${n}`,
      planFindings: (n: number) =>
        n === 1
          ? [finding("ROUND-ONE", "plan:a")]
          : n === 2
            ? [finding("ROUND-TWO", "plan:b")]
            : [],
      parkAt: "design:dispatch" as const,
      parkOnCall: 2, // the generation 1 dispatch, right after the first redesign
    };
    const h = make();
    expect(await h.fresh({ script })).toBe(75); // budget pause, transcript for design:dispatch gen 1
    h.editProfile((p) => {
      p.promptVars = { stack: "ruby", tone: "terse" };
    });
    expect(await h.resume({ script: { ...script, parkAt: null, parkOnCall: null } })).toBe(75);
    const prompts = h.calls.prompts
      .filter((p) => p.step === "design:dispatch")
      .map((p) => p.prompt);
    // call 3: generation 1 resumed. The parked step was never finished, so the edit did not
    // invalidate it: it keeps its generation's findings. But the edit changed one of its inputs, so its
    // partial output from before the pause is withheld, with one note naming the input (spec §6.5).
    expect(prompts[2]).toContain("ROUND-ONE");
    expect(prompts[2]).not.toContain("partial output written before the session limit");
    const dropped = h.read((db, id) =>
      listEvents(db, id)
        .filter((e) => e.reason === "carryover-dropped")
        .map((e) => JSON.parse(e.payload_json ?? "{}") as { stepKey: string; changed: string[] }),
    );
    expect(dropped).toHaveLength(1);
    expect(dropped[0]?.stepKey).toBe("design:dispatch");
    expect(dropped[0]?.changed).toContain("profile.promptVars");
    // call 4: generation 2, after the second redesign: only round two, no carryover
    expect(prompts[3]).toContain("ROUND-TWO");
    expect(prompts[3]).not.toContain("ROUND-ONE");
    expect(prompts[3]).not.toContain("partial output written before the session limit");
  },
  HARNESS_TEST_TIMEOUT_MS,
);

test(
  "§8.7: a run paused in design:review keeps its carryover when nothing changed",
  async () => {
    const script = {
      plan: (n: number) => `Plan body, version ${n}`,
      parkAt: "design:review" as const,
      parkOnCall: 1,
    };
    const h = make();
    expect(await h.fresh({ script })).toBe(75); // budget pause in design:review, before it finished
    expect(await h.resume({ script: { ...script, parkAt: null, parkOnCall: null } })).toBe(75);
    const prompts = h.calls.prompts.filter((p) => p.step === "design:review").map((p) => p.prompt);
    expect(prompts[1]).toContain("partial output written before the session limit");
    expect(
      h.read((db, id) => listEvents(db, id).some((e) => e.reason === "carryover-dropped")),
    ).toBe(false);
  },
  HARNESS_TEST_TIMEOUT_MS,
);

test(
  "§8.7: a run paused in design:review drops its carryover when an edit changes the plan",
  async () => {
    const script = {
      plan: (n: number) => `Plan body, version ${n}`,
      parkAt: "design:review" as const,
      parkOnCall: 1,
    };
    const h = make();
    expect(await h.fresh({ script })).toBe(75);
    h.editProfile((p) => {
      p.promptVars = { stack: "ruby", tone: "terse" }; // read by design:review, and by design:dispatch, which writes plan version 2
    });
    expect(await h.resume({ script: { ...script, parkAt: null, parkOnCall: null } })).toBe(75);
    const prompts = h.calls.prompts.filter((p) => p.step === "design:review").map((p) => p.prompt);
    expect(prompts[1]).not.toContain("partial output written before the session limit");
    const dropped = h.read((db, id) =>
      listEvents(db, id)
        .filter((e) => e.reason === "carryover-dropped")
        .map((e) => JSON.parse(e.payload_json ?? "{}") as { stepKey: string; changed: string[] }),
    );
    expect(dropped).toHaveLength(1);
    expect(dropped[0]?.stepKey).toBe("design:review");
    expect(dropped[0]?.changed).toEqual(expect.arrayContaining(["plan", "profile.promptVars"]));
  },
  HARNESS_TEST_TIMEOUT_MS,
);

test(
  "§8.9: an extract invalidated by an edit clears every unit and needs_docs, keeps the plan finding detached, and leaves history",
  async () => {
    const h = make();
    const script = {
      planFindings: () => [
        {
          severity: "minor" as const,
          category: "clarity",
          location: "plan:Unit 1",
          rationale: "name it",
          factors: null,
          deferral_candidate: false,
          work_unit_seq: 1,
        },
      ],
    };
    expect(await h.fresh({ script })).toBe(75);
    h.editProfile((p) => {
      p.runtimeContext = { ...(p.runtimeContext as object), topology: { type: "web-service" } };
    });
    expect(await h.resume({ script })).toBe(75);
    h.read((db, id) => {
      const units = listUnits(db, id);
      expect(units.map((u) => u.seq)).toEqual([1, 2]);
      // made again (work_unit.id is not AUTOINCREMENT, so ids may repeat): the history row below
      // and the detached finding show it
      const planFindings = listFindings(db, id).filter((f) => f.review_kind === "plan");
      expect(planFindings.length).toBe(1); // design:review did not rerun: same plan, same units
      expect(planFindings[0].work_unit_id).toBeNull(); // detached when the units were deleted
      expect(listStepHistory(db, id, "design:extract").length).toBe(1);
    });
  },
  HARNESS_TEST_TIMEOUT_MS,
);
```

`make()` is in-place; for `§8.9` the review's inputs are unchanged (the runtime context is read by dispatch and extract only), so it stays done and its finding stays as the latest review's, detached.

- [ ] **Step 2: Write the livelock test**

```ts
// test/daemon/design-livelock.test.ts
import { expect, test } from "bun:test";
import { advanceOneStep } from "../../src/daemon/advance.ts";
import { nextStepKey } from "../../src/daemon/resolver.ts";
import { getTicket } from "../../src/db/repos/ticket.ts";
import { unitsOf } from "../helpers/design-script.ts";
import { STEP_TEST_TIMEOUT_MS, makeDesignTicket } from "../helpers/design-steps.ts";

test(
  "§8.6: plan review goes from findings to none and design finishes in a fixed number of steps",
  async () => {
    const t = makeDesignTicket({
      script: {
        units: () => unitsOf(2, { behavioral: false }),
        plan: (n) => `Plan body, version ${n}`,
        planFindings: (n) =>
          n === 1
            ? [
                {
                  severity: "major",
                  category: "completeness",
                  location: "plan:1",
                  rationale: "missing a step",
                  factors: null,
                  deferral_candidate: false,
                  work_unit_seq: null,
                },
              ]
            : [],
      },
    });
    let steps = 0;
    while (getTicket(t.db, t.ticketId)?.stage === "design") {
      expect(nextStepKey(t.db, t.ticketId).kind).not.toBe("escalate");
      await advanceOneStep(t.db, t.ticketId, t.registry, { config: t.config });
      steps++;
      if (steps > 20) throw new Error("design did not finish: livelock");
    }
    // provision, dispatch, extract, size, review (blocks) | dispatch, extract, review (clean),
    // checks:dispatch, checks:classify | the advance to implement, collapsed inline into the call
    // that runs implement:wu1:dispatch. Invalidations collapse inline too: eleven calls.
    expect(steps).toBe(11);
    expect(t.calls.counts["design:dispatch"]).toBe(2);
    expect(t.calls.counts["design:extract"]).toBe(2);
    expect(t.calls.counts["design:review"]).toBe(2);
  },
  STEP_TEST_TIMEOUT_MS,
);
```

- [ ] **Step 3: Write the crash driver and the crash tests**

```ts
// test/fixtures/design/crash-resume.ts
// Usage: bun test/fixtures/design/crash-resume.ts <spec.json>
// Resumes a paused design harness run (in place) with the real handlers and a scripted agent, and
// blocks at one crash point, writing <readyFile> first, so the parent test can SIGKILL this process:
//   before-commit    the step's handler returned; its success transaction has not run
//   after-commit     the step's success committed (seen at the start of the next step)
//   after-invalidate the step's invalidate transaction committed; the step is pending in its new
//                    generation and has not started (seen when advance.ts resolves its handler)
// XDG_STATE_HOME, XDG_CONFIG_HOME and TMPDIR come from the parent; no real agent runs. Bounded:
// it exits on its own after 60 s, or as soon as its parent is gone.
import type { Database } from "bun:sqlite";
import { readFileSync, writeFileSync } from "node:fs";
import { loadRunProfile } from "../../../src/cli/load-profile.ts";
import { resumeRun } from "../../../src/cli/park.ts";
import { DEFAULT_AGENT_CONFIG } from "../../../src/config/agent-config.ts";
import { discoverRuntimeConfig } from "../../../src/config/discover.ts";
import { type HandlerContext, StepRegistry } from "../../../src/daemon/step-registry.ts";
import { getByKey } from "../../../src/db/repos/workflow-step.ts";
import { buildDispatchRegistry } from "../../../src/dispatch/handlers.ts";
import { fakeForge } from "../../../src/integrations/adapters/fake-forge.ts";
import { fakeIssueTracker } from "../../../src/integrations/adapters/fake-issue-tracker.ts";
import { defaultScript, newCalls, scriptedRunner } from "../../helpers/design-script.ts";

interface CrashSpec {
  profilePath: string;
  configPath: string;
  ident: string;
  step: string;
  point: "before-commit" | "after-commit" | "after-invalidate";
  readyFile: string;
}
const spec = JSON.parse(readFileSync(process.argv[2] ?? "", "utf8")) as CrashSpec;

/** Signal readiness, then wait for the parent's SIGKILL. Synchronous, so nothing else in this
 *  process runs meanwhile; never endless: it exits after 60 s, or when its parent is gone (the
 *  parent pid changes when the parent dies). */
function block(): never {
  writeFileSync(spec.readyFile, "ready");
  const parent = process.ppid;
  const until = Date.now() + 60_000;
  while (Date.now() < until && process.ppid === parent) Bun.sleepSync(100);
  process.exit(3);
}

class CrashRegistry extends StepRegistry {
  private ran = false;
  private db: Database | null = null;
  private ticketId = 0;
  /** The crashed step's generation when this process started driving the run. */
  private startGeneration: number | null = null;
  constructor(private readonly real: StepRegistry) {
    super((db, ticketId) => {
      real.synchronize(db, ticketId);
      this.db = db;
      this.ticketId = ticketId;
      this.startGeneration ??= getByKey(db, ticketId, spec.step)?.generation ?? 0;
      if (
        spec.point === "after-commit" &&
        this.ran &&
        getByKey(db, ticketId, spec.step)?.status === "succeeded"
      )
        block();
    });
  }
  override resolve(handlerKey: string) {
    // after-invalidate: advance.ts resolves the handler after the invalidate transaction committed
    // and before runStep marks the step running, and nothing writes in between (nextStepKey is
    // pure; prepareVerificationRetry writes only for suite steps). Here the step is pending in a
    // generation newer than the one it had when this process started.
    if (spec.point === "after-invalidate" && handlerKey === spec.step && this.db !== null) {
      const step = getByKey(this.db, this.ticketId, spec.step);
      if (step?.status === "pending" && step.generation > (this.startGeneration ?? 0)) block();
    }
    const h = this.real.resolve(handlerKey);
    if (!h) return h;
    return async (ctx: HandlerContext) => {
      const ours = ctx.step.step_key === spec.step;
      const result = await h(ctx);
      if (ours) this.ran = true;
      if (ours && spec.point === "before-commit") block();
      return result;
    };
  }
  override resolveCommit(handlerKey: string) {
    return this.real.resolveCommit(handlerKey);
  }
}

const loaded = loadRunProfile({ profile: spec.profilePath });
const config = discoverRuntimeConfig({ explicitPath: spec.configPath, slug: loaded.slug });
await resumeRun(
  { resume: spec.ident },
  loaded.profile,
  config,
  {
    ports: {
      issueTracker: fakeIssueTracker({
        ticket: {
          ident: spec.ident,
          title: "Harness ticket",
          description: "Harness body",
          typeLabel: "Feature",
          externalId: "uuid-harness",
          url: null,
        },
      }),
      forge: fakeForge(),
    },
    preflight: () => ({ ok: true, version: null }),
    probe: () => true,
    buildRegistry: (resumeContext, wiring) =>
      new CrashRegistry(
        buildDispatchRegistry({
          runner: scriptedRunner(defaultScript({ ident: spec.ident }), newCalls()),
          agentConfig: DEFAULT_AGENT_CONFIG,
          ...wiring,
          resumeContext,
        }),
      ),
  },
  loaded.nonPrimary,
);
throw new Error(`crash-resume: the run ended without reaching ${spec.point} of ${spec.step}`);
```

```ts
// test/cli/design-crash-e2e.test.ts
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { currentManifest } from "../../src/daemon/design-digests.ts";
import { DESIGN_TABLE, type StepRow } from "../../src/daemon/design-graph.ts";
import { listByTicket as listEvents } from "../../src/db/repos/event-log.ts";
import { listByTicket as listUnits } from "../../src/db/repos/work-unit.ts";
import { getByKey } from "../../src/db/repos/workflow-step.ts";
import { DesignHarness } from "../helpers/design-harness.ts";
import { ownChild } from "../helpers/own-processes.ts";
import { makeTempDir, trackTempEntriesMadeBy } from "../helpers/temp.ts";

const DRIVER = join(import.meta.dir, "../fixtures/design/crash-resume.ts");
/** A fresh run, the child up to its crash point, and the resume after it. */
const CRASH_TEST_TIMEOUT_MS = 120_000;
const harnesses: DesignHarness[] = [];
afterEach(() => {
  for (const h of harnesses.splice(0)) h.cleanup();
});

type Point = "before-commit" | "after-commit" | "after-invalidate";
/** The edit that makes each step rerun on the next resume (in place, so provision reruns only
 *  when its own inputs change). */
const editPromptVars = (h: DesignHarness): void =>
  h.editProfile((p) => {
    p.promptVars = { stack: "ruby", tone: "terse" };
  });
const EDITS: Record<string, (h: DesignHarness) => void> = {
  provision: (h) =>
    h.editProfile((p) => {
      p.components = [
        ...(p.components as unknown[]),
        {
          name: "extra",
          kind: "ruby",
          paths: ["extra/**"],
          commands: { build: "true", test: "true", check: "true" },
        },
      ];
    }),
  "design:dispatch": editPromptVars,
  "design:extract": editPromptVars,
  "design:size": (h) =>
    h.editConfig((c) => {
      c.complexityGrading = true;
    }),
  "design:review": editPromptVars,
};

/** Dispatch rows written by `step` (agent steps), counted through the dispatch's step id. */
const dispatches = (h: DesignHarness, step: string): number =>
  h.read(
    (db, id) =>
      (
        db
          .query(
            "SELECT COUNT(*) AS n FROM dispatch d JOIN workflow_step w ON w.id = d.step_id WHERE d.ticket_id = ? AND w.step_key = ? AND d.outcome = 'clean-success'",
          )
          .get(id, step) as { n: number }
      ).n,
  );

/** Run the crash driver until it reaches `point` of `step`, then SIGKILL it through its own handle.
 *  The child is claimed with ownChild at once (the preload's end of run check sees it), bounds
 *  itself (crash-resume.ts), and has a 60 s deadline here. Its run keeps a styre-wt-* root in the
 *  shared temp root (TMPDIR is passed on), and a project command it ran may leave its styre-cmd-*
 *  folder there (PR #156): SIGKILL lets no exit check remove it, and only a later sweep would.
 *  Both are tracked for removal, so the preload's temp guard sees nothing left. */
async function crashChild(h: DesignHarness, step: string, point: Point): Promise<void> {
  const dir = makeTempDir("styre-crash-");
  const readyFile = join(dir, "ready");
  const specPath = join(dir, "spec.json");
  writeFileSync(
    specPath,
    JSON.stringify({
      profilePath: h.profilePath,
      configPath: h.configPath,
      ident: h.ident,
      step,
      point,
      readyFile,
    }),
  );
  const log = join(dir, "stderr.log");
  const drive = async () => {
    const child = Bun.spawn([process.execPath, DRIVER, specPath], {
      env: {
        ...process.env,
        XDG_STATE_HOME: h.stateRoot,
        XDG_CONFIG_HOME: h.configRoot,
        STYRE_TELEMETRY: "0",
      },
      stdout: "ignore",
      stderr: Bun.file(log), // a file, so a full pipe can never stall the child before its crash point
    });
    ownChild(child);
    const deadline = Date.now() + 60_000;
    try {
      while (!existsSync(readyFile)) {
        if (child.exitCode !== null || Date.now() > deadline) {
          const why = existsSync(log) ? readFileSync(log, "utf8") : "";
          throw new Error(`crash driver did not reach ${point} of ${step}: ${why}`);
        }
        await Bun.sleep(50);
      }
    } finally {
      child.kill("SIGKILL"); // this child only, by its own handle
      await child.exited;
    }
  };
  await trackTempEntriesMadeBy("styre-cmd-", () => trackTempEntriesMadeBy("styre-wt-", drive));
}

const rows = DESIGN_TABLE.filter((r): r is StepRow => r.kind === "step");

describe("§8.8: a child process SIGKILLed at each design step leaves nothing duplicated or stale", () => {
  for (const row of rows) {
    for (const point of ["before-commit", "after-commit", "after-invalidate"] as const) {
      test(
        `${row.stepKey}, ${point}`,
        async () => {
          const h = new DesignHarness("in-place");
          harnesses.push(h);
          expect(await h.fresh()).toBe(75); // design done; paused at checks:dispatch
          // provision runs no agent; design:size runs one only once its edit turns grading on, so its
          // fresh run wrote no dispatch row to compare against
          const agent = row.stepKey !== "provision" && row.stepKey !== "design:size";
          const before = agent ? dispatches(h, row.stepKey) : 0;
          EDITS[row.stepKey](h);
          await crashChild(h, row.stepKey, point);
          const endedAtCrash = h.read((db, id) => getByKey(db, id, row.stepKey)?.ended_at);
          expect(await h.resume()).toBe(75); // the next resume finishes design again
          h.read((db, id) => {
            // no duplicate or partial outputs
            expect(listUnits(db, id).map((u) => u.seq)).toEqual([1, 2]);
            // every design step's recorded manifest matches its inputs now
            for (const r of rows) {
              const s = getByKey(db, id, r.stepKey);
              if (!r.appliesWhen({ track: "full" }) || s?.status !== "succeeded") continue;
              expect(JSON.parse(s.input_manifest ?? "null")).toEqual(currentManifest(db, id, r));
            }
            // one invalidation of the crashed step, whatever the crash point
            const invalidations = listEvents(db, id).filter(
              (e) =>
                e.reason === "invalidated" &&
                (JSON.parse(e.payload_json ?? "{}").stepKeys as string[]).includes(row.stepKey),
            );
            expect(invalidations.length).toBe(1);
          });
          if (point === "after-commit") {
            // committed before the crash: never run again for the same inputs
            expect(h.read((db, id) => getByKey(db, id, row.stepKey)?.ended_at)).toBe(endedAtCrash);
          }
          if (agent) {
            const ran = dispatches(h, row.stepKey) - before;
            // before-commit: the uncommitted success is redone once; otherwise exactly one run
            expect(ran).toBe(point === "before-commit" ? 2 : 1);
          }
        },
        CRASH_TEST_TIMEOUT_MS,
      );
    }
  }
});
```

- [ ] **Step 4: Run them and see them fail, then pass**

These tests exercise behaviour built in Tasks 7 to 16, so they pass on first run if those tasks are correct. Prove each can fail before trusting it:
1. Run: `perl -e 'alarm 600; exec @ARGV' bun test test/cli/design-inputs-e2e.test.ts test/daemon/design-livelock.test.ts test/cli/design-crash-e2e.test.ts`. Expected: PASS.
2. In `walkDesign`, invalidate every step after the first mismatch as well (`stepKeys: DESIGN_TABLE...slice(index)`): §8.1 fails for each case (extra reruns). Restore.
3. In `src/daemon/design-outputs.ts`, move `writeExtractOutputs` into the extract handler (write before the success commit): the `design:extract, before-commit` crash case fails with a `UNIQUE constraint failed: work_unit.ticket_id, work_unit.seq` rerun failure. Restore.
4. In `captureSnapshot`, set `pastDesign` to `false` always: §8.2 fails on the note. Restore.
5. In `resumeRun` (`park.ts`), build the resume context with `manifest: null` instead of `tj.manifest ?? null`: the first §8.7 test fails on `prompts[2]` (the carryover reaches call 3) and on the missing `carryover-dropped` note, and "drops its carryover when an edit changes the plan" fails on `prompts[1]`. Restore. (The generation condition is proven by Task 14's `the carryover transcript reaches only the generation it was written in`, whose transcript has no manifest.)
5a. In `dumpPark`, write `manifest: null` always: "drops its carryover when an edit changes the plan" fails. Restore.
6. Make `applyReviewVerdict`'s plan review path a no-op loopback that does not invalidate design:dispatch (pass `[]`, which `redesignLoopback` refuses): the livelock test fails loudly. Restore.
7. In `resetForInvalidate`, drop `generation = generation + 1`: every `..., after-invalidate` crash case fails with `crash driver did not reach after-invalidate`. Restore.

- [ ] **Step 5: Run the whole suite, then commit**

Run: `perl -e 'alarm 600; exec @ARGV' bun test`
Expected: PASS.

```bash
git add test/fixtures/design/crash-resume.ts test/cli/design-inputs-e2e.test.ts test/cli/design-crash-e2e.test.ts test/daemon/design-livelock.test.ts
git commit -m "test(eng-477): end to end coverage of design input invalidation, E6, feedback, crashes and clearing" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 18: Docs (spec §9)

Both `schema.sql` copies and the `CLAUDE.md` table count were updated with the schema in Task 4. This task changes no code.

**Files:**
- Modify: `docs/architecture/minimal-loop.md:29-37` (§1 design branch), `:197` (§2 redesign row)
- Modify: `docs/architecture/control-loop.md:80-81` (start up), `:112-121` (§2.3 descriptor list), `:241-299` (§4 S1 guards), `:728-730` (§6.2), `:820-824` (§8.3 design rows), `:955` (§10)
- Modify: `docs/architecture/build-operations.md:54,58,70-72,208` (§5, after item 4: a ticket driven through the core's step code needs its snapshot first)
- Modify: `docs/architecture/runtime-parameters.md` (the `--slug` rows at lines 41, 147 and 177, Resume flow, `styre migrate`, `styre ls` (93-129), `styre clean <ident>` (136 on), the exit code table rows `65`, `70`, `75`, a new section "Design inputs and invalidation", and line 24, the output stream of `styre migrate`)
- Modify: `docs/architecture/glossary.md:169-172` (`styre ls`: the unreadable checkpoints section)
- Modify: `CLAUDE.md:82-83` (`styre ls` and `styre clean`: the checkpoints they cannot use), `:86` (Stream contract: `styre migrate` prints to stderr)
- Modify: `docs/architecture/conventions.md:108-110` (nested slugs: what is refused), `:149-160` (Checkpoints)
- Modify: `README.md:135-140` (its copy of the exit code table: rows `64`, `65` and `78` match `runtime-parameters.md`)
- Modify: `docs/architecture/telemetry-export.md:101` (after the ENG-485 note reasons)
- Modify: `SECURITY.md:189-192` (Limits, stated plainly: after the **Interrupted checks step, worktree mode** bullet)
- Modify: `docs/architecture/brainstorm.md:422` (§11, a new first entry)
- Test: `test/lifecycle/messages-doc.test.ts` (existing; must stay green: no new `styre: ` messages were added)

**Interfaces:**
- Consumes: the names and messages of Tasks 2 to 16.
- Produces: none.

- [ ] **Step 1: `minimal-loop.md`**

Replace the `'design':` branch of the pseudocode (lines 29-37) with:

```
  'design':
    # Generated from the declared table (src/daemon/design-graph.ts; ENG-477). For each row, in order:
    #   skip it when its "applies when" is false (design:review and its gate: track == 'full');
    #   not succeeded                          → return it (the walk stops at the first step not done)
    #   succeeded, manifest ≠ current inputs   → invalidate it alone (cause inputs), recurse
    #   succeeded, manifest = current inputs   → done; next row
    # Rows: provision → design:dispatch → design:extract → design:size → design:review → plan review gate
    if gate fires (blocking findings on the latest design:review): escalate('review:unresolved-plan')
    if the same step was invalidated for inputs > 3 times since the run was last started (a resume, or a reused --db): escalate('invalidate-loop:<step>')
    # past the table: today's checks routing, unchanged (E9)
    if not done('checks:dispatch'):                    return 'checks:dispatch'
    if not done('checks:classify'):                    return 'checks:classify'
    advance('design' -> 'implement'); recurse
```

and add, after the code block, the paragraph:

```
**"Done" in design means done with these inputs (ENG-477).** Each design table step records, in its
success transaction, a manifest of its inputs' digests: snapshot inputs from `ticket_input` (the
ticket text, fixed for the run; the profile and config values as the handlers receive them,
rewritten on each resume), the outputs it reads (units, track, and the plan's digest recorded on
`design:dispatch`). The walk recomputes the manifest from SQLite (it never reads the worktree) and
invalidates a step whose inputs changed; its readers are judged again after it reruns (early cutoff).
The walk runs only while the ticket is in design: an edit made while paused later is recorded and
takes effect the next time the run is in design. The checks steps keep today's gating (E9).
```

In §2's table, replace the `plan-review blocking, or code-review plan-defect ...` row with:

```
| plan review blocking | `invalidate(design:dispatch)` with cause `feedback` (history, reset, generation + 1); the loopback event carries the findings, `consumer: design:dispatch` and that generation; reset+zero `review`; reset ticket verify steps; reset+zero `merge:push`/`merge:pr-ensure`; `stage='design'`. Everything else in design follows from fingerprints | `design` |
| a code review finding of category `plan-defect` (one that blames the plan, not the code) with `onPlanDefect='redesign'`, or a resume of a run stopped at the plan review gate after the operator moved HEAD (`retry-plan` in `review-resume.ts`: the resume's plan review action) | the same, invalidating `design:dispatch` and `design:extract` (all units deleted, reconcile units included; findings tied to a unit detached first; `needs_docs` = 0), so the units are made again and implemented again even when the plan is identical | `design` |
```

- [ ] **Step 2: `control-loop.md`**

- Line 81: `migrate()                       # §10 create, or upgrade (backup, versioned migrations, structural proof)`.
- §2.3, in the descriptor list after `'mark-verified'`:

```
  'invalidate'    → design only (ENG-477): one transaction — a `note` event (reason `invalidated`,
                    with the step keys, the cause and the changed input names; not a loopback), the
                    step's row copied to workflow_step_history, the step reset to a fresh round in the
                    next generation, its outputs cleared (minimal-loop §2); recurse
```

- §4, S1a guard: `- **Guard:** `stage='design'`; `provision` done with its current inputs; worktree exists. "Done" for every design step (S1a, S1b, S1b2, S1c, and provision) means succeeded **and** its recorded input manifest equals its inputs now (ENG-477, minimal-loop §1).`
- S1b guard: `- **Guard:** S1a done with its current inputs (the plan's digest is one of S1b's inputs). Rows are no longer the gate.`
- S1b output, append: `Units are written in the success transaction, with `origin='extract'`; a crash before it leaves none.`
- S1b2 guard: `- **Guard:** S1b done with its current inputs; `design:size` not done with its current inputs (the `ticket.track` column is no longer the gate).`
- S1a output, append: `The runner records the plan's digest (path and content of the `docs/plans/*.md` files whose frontmatter names this ticket, at the branch head, read through git) when S1a succeeds.`
- §6.2, append:

```
**Replay beside invalidate (ENG-477).** In the design stage a succeeded step is replayed only while
its recorded input manifest matches its inputs now. When it does not, the resolver returns
`invalidate` instead of the step, so the journal's replay is never asked to stand for a step whose
inputs changed (that request would escalate with signature `step-replay-no-progress`, the journal's guard against replaying a finished step).
```

- §8.3, after the DV2 row:

```
| DI1 | design walk | a succeeded design step's inputs changed (an edit while paused, another host's toolchain) | invalidate that step (cause `inputs`); readers judged again after it reruns | step | escalate with signature `invalidate-loop:<step>` (the invalidate loop guard) after 3 since the run was last started (a resume or a reused `--db`) |
```

and change DV1's "Routes to" to `→ S1a redesign with findings (invalidate design:dispatch, cause feedback)`.
- §10, line 955: `- **Self-bootstrapping schema** — `migrate()` creates the DB, or upgrades it: a `VACUUM INTO` backup next to it, each pending migration in its own transaction with a foreign key check, then a structural comparison against `schema.sql`. Checkpoints from v7 on are upgraded; newer, older or unknown shapes are refused (exit 65). No manual SQL.`

- [ ] **Step 3: `build-operations.md`**

Line 54: `  - **Upgrade** (any target): replace the binary/image; `migrate()` applies schema migrations on start, after a `VACUUM INTO` backup, and proves the result against `schema.sql` (ENG-477). Paused runs from v7 on resume on the new binary.`
Line 58: `  - **`styre migrate`** — bootstraps the SQLite SoT under `$XDG_STATE_HOME/styre/`, or upgrades an existing one the same way `run` does.`

In §5, after item 4 (lines 207-208) and before `## 6`, add a paragraph of its own (review minor m4: a seam change, stated; it concerns drivers of the core's step code, not the telemetry export of item 3):

```
**A ticket driven through the core's step code needs its design inputs first** (ENG-477). Every
design step requires the ticket's snapshot in `ticket_input`, written by `captureSnapshot`
(`src/daemon/design-inputs.ts`). `styre run` writes it for every active ticket it drives, fresh,
resumed or on a reused `--db`. A driver that calls `tick` or `advanceOneStep` itself
(`src/daemon/loop.ts`) must call `captureSnapshot` before a ticket's first step; otherwise that step
stops the run with an internal error naming the missing snapshot.
```

- [ ] **Step 4: `runtime-parameters.md`**

- Line 24 is wrong today: `src/cli/migrate.ts` writes with `process.stderr.write`, and this plan's new `migrate: ` lines go there too (operator ruling, 2026-10-09: fix the docs, not the code). Replace lines 24 and 25 with:

```
- **`styre setup` prints human output to stdout** via `console.log` (`src/cli/setup.ts`).
  **`styre migrate`** and **`styre notify`** print to stderr (`src/cli/migrate.ts`).
```

- In `CLAUDE.md`, the **Stream contract** line becomes: `` Stream contract: `styre run` writes **only NDJSON telemetry to stdout** and all human-readable output to **stderr**; `setup` prints human output to stdout, `migrate` and `notify` to stderr. ``
- In `CLAUDE.md:82`, after "and running efforts" add `` ; also checkpoints it cannot read and checkpoints whose schema it cannot use, each with the reason ``. In `CLAUDE.md:83`, after "refuses a live run (exit `75`)" add `` ; refuses a checkpoint it cannot read or whose schema it cannot use (exit `65`), removes nothing, and names the folder and the worktrees that look like the run's, for removal by hand; refuses an ident or slug that is not a valid folder name (exit `64`; a slug may nest with `/`, each part a folder name: see `conventions.md`) ``, and after "skipping resumable pauses and live runs" add `` and checkpoints it cannot use ``.

- In **Resume flow**, append:

```
Resume also reads the profile and config again and narrows the profile to this host's toolchain exactly
as a fresh run does, printing the same notice (`resume: skipping N component(s) whose toolchain is
absent; …`). Where a fresh run would refuse (nothing usable, or a component whose suite is
`required` is unusable), resume never exits `69`: it pauses for the operator (`needs_you`, exit `75`)
with `resume: paused: this host lacks the tools for <component> (missing: <tools>); …`. Install the
tools and resume. A database written by an older Styre (schema v7 or v8) is upgraded first, and its
finished design steps are adopted (see Design inputs and invalidation).
```

- In **`styre migrate`**, after the first paragraph:

```
An older database (schema v7 or v8) is upgraded: first a backup next to it,
`<db>.v<old>.<UTC timestamp>.bak` (`VACUUM INTO`), then each migration in its own transaction, then
a structural comparison with `schema.sql`. It prints, on stderr,
`migrate: backed up <db> (schema v<old>) to <backup>` and `migrate: upgraded <db> from schema
v<old> to v<new>`, then `upgraded from v<old>: <db> (schema v<new>)`. `styre run` (fresh and
`--resume`) upgrades the same way. Refusals (exit `65`): `migrate: <db> is schema v<N>, newer than
this Styre's v<M>`; `migrate: <db> is schema v<N> but has a shape this Styre does not know`;
`migrate: <db> is schema v<N>; Styre upgrades checkpoints from v7 on`. Each says to start that run
over with `--fresh`. A migration that fails leaves the database at the last version that completed
(exit `70`); the backup is kept. The structural comparison runs inside the last migration's
transaction, so a difference rolls that migration back too. `styre ls`, `styre clean`, `--fresh`
and `--resume --inspect` read a checkpoint without upgrading it; `--inspect` writes nothing to it,
whatever its version: no migration, no backup, no run row.
```

- In the `styre ls` section (lines 93-129): "Prints three sections, in order" becomes "Prints up to five sections, in order"; in its code block, between the `Finished leftovers` lines and `Running:`, add

```
Unreadable checkpoints (remove by hand: `styre clean <ident> --slug <slug>` names what to remove; or start over with `styre run <ident> --slug <slug> --fresh`):
  <slug>/<ident>[ (running)]  <reason>

Checkpoints this Styre cannot use (use the Styre that wrote them; or remove by hand, or start over with `styre run <ident> --slug <slug> --fresh`):
  <slug>/<ident>[ (running)]  <reason>
```

  after the **Finished leftovers** bullet add

```
- **Unreadable checkpoints** — checkpoints `ls` could not read, with the reason: damaged (including
  a database the readers cannot query; the reason names the error, for example a missing column),
  written to so steadily that no stable copy could be taken in 3 attempts, or holding no ticket.
  Never dropped from the listing; `(running)` marks one a live run holds. Never resumable, and
  `styre clean --all` never reaps them. Two ways out: remove it by hand (see `styre clean`;
  `styre clean <ident> --slug <slug>` refuses, removes nothing, and names the checkpoint folder and
  the worktrees that look like the run's), or `styre run <ident> --slug <slug> --fresh` discards it
  and starts the ticket over, a full new run. A checkpoint folder without its `run.db` is not
  listed, as before. The section is omitted when empty.
- **Checkpoints this Styre cannot use** — checkpoints whose schema this Styre refuses: written by a
  newer Styre (`schema vN`), an unknown database shape, or older than v7. They are not damaged, and
  `ls` says why. Use the Styre that wrote them, which keeps the paused work; or remove by hand
  (`styre clean` refuses them, exit `65`, and names what to remove; see `styre clean`); or start
  over with `styre run <ident> --slug <slug> --fresh`, a full new run. The section is omitted when
  empty.

`ls` reaches the same folders as before: `<state>/<slug>/<ident>`, two levels down. A checkpoint
under a nested slug (`team/app`) is not listed yet (ENG-491).

`ls`, `clean`, `--fresh` and `--inspect` never open a checkpoint itself: they read a private copy of
it, and of its `-wal` and `-shm`, removed afterwards.
```

  and "a fourth section follows" (the stopped orphans) becomes "a last section follows".
- In the `styre clean <ident>` section (line 136 on), after its bullets, add:

```
- **A checkpoint `clean` cannot use**: one it cannot read (damaged, or no ticket recorded) or one
  whose schema this Styre refuses (written by a newer Styre, an unknown shape, older than v7).
  `clean` refuses (exit `65`) and removes nothing: no folder, no worktree, no branch. It names the
  reason, the checkpoint folder, and the worktrees of the target repository that look like the
  run's (a folder named after the ident whose parent folder's name starts with `styre-wt-`; never
  the repository itself), or says none was found. It prints no command. With a live lock it
  refuses with exit `75` first. `--purge` refuses the same way (exit `65`). A checkpoint folder
  without its `run.db` is still "no styre effort" (exit `64`), as before.

  For a checkpoint written by a newer Styre, use that Styre: it keeps the paused work. Otherwise,
  to remove the run by hand: look in each worktree `clean` named for uncommitted or untracked work
  first, and decide yourself what to keep, since `git worktree remove` refuses a worktree that
  holds any; then remove each one with `git worktree remove` run in the target repository, and
  last delete the checkpoint folder `clean` named. Edits an interrupted step left in the
  repository itself are not touched (for an in place run, check `git status` there). To start the
  ticket over instead, `styre run <ident> --slug <slug> --fresh` discards the checkpoint and
  starts a full new run.
- `styre clean --all` skips both kinds, and reaches the same folders as before (a nested slug's
  checkpoints are not reached yet: ENG-491).
- The ident and `--slug` are checked before any path is built from them. An ident is one folder
  name: empty, `.`, `..`, or one containing `/`, `\` or a NUL character is refused. A slug may
  contain `/` and then nests (see `conventions.md`); each part between slashes must be a folder
  name by the same rule, so `team/app` is accepted and `team/..`, `/abs`, `a//b` and `a/./b` are
  refused. Exit `64` for a name given on the command line or derived from the repository, `78`
  for a slug read from a profile file. `styre run` (fresh and `--resume`) and `styre setup` apply
  the same check, to the `--slug` flag, a derived slug, the profile's own slug and the ticket's
  ident; `setup` never writes a profile whose slug `run` would refuse.
```

- `README.md`, the copy of the exit code table (lines 135-140), so it matches `runtime-parameters.md`:
  - row `64`: append `; or an ident or slug that is not a valid folder name (see docs/architecture/conventions.md)` to the meaning.
  - row `65` becomes `` | `65` | checkpoint refused — `run --resume` refused because the branch HEAD moved since the run paused (without `--accept-head`) or another resume holds the lock; a database that cannot be upgraded (written by a newer Styre, older than v7, or of an unknown shape); or `styre clean <ident>` refusing a checkpoint it cannot read or whose schema it cannot use (nothing removed) | resume: `--accept-head`, or retry once the other resume releases the lock; a newer Styre's checkpoint: use that Styre; otherwise remove by hand (see `styre clean` in docs/architecture/runtime-parameters.md) or start over with `--fresh` | ``.
  - row `78`: append `; or a profile whose own slug is not a valid folder name (rerun styre setup with --slug)` to the meaning.
- `docs/architecture/glossary.md:169-172` (`styre ls`): "lists every effort in three sections" becomes "lists every effort in up to five sections", with `Unreadable checkpoints (...)` (the checkpoints it could not read, with the reason) and `Checkpoints this Styre cannot use (...)` (a schema it refuses, with the reason) named between the leftovers and `Running:`.
- `docs/architecture/build-operations.md:70-72` (`styre ls`): "lists every effort in three sections: ... and currently running efforts." becomes "lists every effort in up to five sections: paused/resumable efforts (each with its `styre run --resume` hint), finished leftovers not yet cleaned (reapable via `styre clean --all`), checkpoints it could not read and checkpoints whose schema it cannot use (each with the reason), and currently running efforts."
- In the exit code table: row `65` add `, or a database that cannot be upgraded: newer than this Styre, older than v7, or of an unknown shape (start that run over with `--fresh`); also `styre clean <ident>` refusing a checkpoint it cannot read or whose schema it cannot use (nothing removed), and a resume, or a fresh run on a reused `--db`, of a run whose design steps were fingerprinted by a newer Styre ("this run was recorded by a newer Styre; use that version", nothing changed)` to the Meaning, its Name `resume refused (`EX_DATAERR`)` becomes `checkpoint refused (`EX_DATAERR`)`, and its Retry column gains `. A database written by a newer Styre: use that Styre, which keeps the paused work; otherwise, or for one that cannot be upgraded, start over with `--fresh`. `styre clean <ident>` on a checkpoint it cannot use: not as is; for a newer Styre's checkpoint use that Styre first; otherwise remove the run by hand (see `styre clean <ident>` above), or start over with `styre run <ident> --slug <slug> --fresh`.`; row `64` add `, or an ident or slug that is not a valid folder name (see `conventions.md`: an ident is one folder name; a slug may nest with `/`, each part one folder name), given on the command line, derived from the repository, or from the tracker (`styre run` fresh or `--resume`, `styre clean`, `styre setup`)` to the Meaning; row `78` add `, or a profile whose own `slug` is not a valid folder name (`styre run`, `styre clean --profile`; rerun `styre setup` with `--slug`)` to the Meaning; row `70` add `Also: a migration that failed (the database stays at the last version that completed; the backup is kept), and a declared design table that breaks its own rules (`the declared design table breaks its own rules`, a Styre defect).`; row `75` add `, or a resume paused because this host lacks a required suite's tools` inside the `needs_you` parenthesis, and `, or the invalidate loop guard's escalation (signature `invalidate-loop:<step>`: a design step kept finding changed inputs)` after it.
- New section before `## Exit codes (error codes) and their meaning`:

```
## Design inputs and invalidation (ENG-477)

A design step is done only while its recorded inputs still match. What counts as an input is the
declared table in `src/daemon/design-graph.ts`: the ticket text (fixed for the run; resume never
reads the tracker, so start over with `--fresh` to pick up an edited ticket), the profile's slug,
prompt variables, runtime context and components, the lists of components narrowed away for this
host or as not part of the product, and `complexityGrading`. Model choices and `onPlanDefect` are
not inputs.

The plan is read from git at the branch head, never from the worktree, so it must be committed.
When `design:dispatch` finds no plan for the ticket committed there (for example because
`docs/plans/` is in `.gitignore`), it stops at once, without a retry, and the run waits for you
(exit `75`) with that reason: remove `docs/plans/` from `.gitignore`, commit that on the ticket branch,
then resume with `--accept-head` (the commit moves the branch HEAD, so a plain resume is refused).

A run on a reused `--db` prepares every active ticket in that database the same way (the snapshot
and, for steps an older Styre finished, the adopt pass below), not only its own: the loop drives
every ready ticket it finds.

A run whose design steps were fingerprinted by a newer Styre (a newer fingerprint scheme) is
refused before anything changes (exit `65`), on resume and on a fresh run that reuses its database
(`--db`): use that version. `--inspect` says so.

Notes written to the run's events (and emitted as `event` rows):
- `inputs-changed`: on a resume (or a reused `--db`), the inputs whose values changed. Past design,
  the note says the change takes effect the next time the run is in design; the run carries on. In
  design, it says the steps that read them are judged again when the run next walks the design
  steps. A run stopped at the plan review gate is judged by that gate first, which stays closed
  until the plan changes: edit the plan and resume with `--accept-head`.
- `carryover-dropped`: a step paused before it finished is dispatched again under other inputs, so
  its partial output from before the pause is not passed on; the note names the changed inputs.
- `invalidated`: a design step was reset, with the changed input names; its previous row is kept in
  `workflow_step_history`. The cause is one of: `inputs` (an input the step reads changed),
  `feedback` (a review sent the plan back to be redesigned), `worktree-recreated` (`provision` runs
  again because a resume recreated the worktree and its installed dependencies are gone), or
  `manifest-touched` (`provision` runs again because a change touched a dependency manifest).
- `adopted`: on the first resume after an upgrade, the finished design steps of a run paused by an
  older Styre, recorded with today's inputs (`stepKeys`); an edit made between the pause and the
  upgrade cannot be detected. Steps that finished after a step that has not (a pause in the middle
  of a redesign, say), or whose plan cannot be read at the branch head, are listed under
  `willRerun`: they run again once the steps before them have.
- `reused-database`: a `styre run` on a reused `--db`, on its own ticket when it already existed and
  on every other active ticket there; the loop guard below counts from it, as from a resume.
- `toolchain-missing`: a resume found this host without a required suite's tools while the run was
  already waiting for you (stopped again at a review); it records the missing tools instead of a
  second pause.

Escalation `invalidate-loop:<step>` (the invalidate loop guard): a design step was invalidated for
changed inputs more than three times since the run was last started (a resume, or a run on a reused
`--db`). This is a defect (an unstable digest); the run pauses (`needs_you`).

**Fingerprint scheme.** Every recorded manifest carries the scheme number (`FINGERPRINT_SCHEME`) of
the Styre that recorded it. The scheme covers everything a digest depends on: the encoding, how the
profile and config are parsed (their defaults included), what each design step declares as its
inputs, and how each output is digested. A release that changes any of these (a new profile field
with a default, a changed config default, a declared input added or removed) bumps the scheme; a
test that pins the digests of a fixed set of inputs fails until it does. A step whose manifest was
recorded under an older scheme counts as changed: it reruns the next time the run is in design, and
a run paused past design is unaffected until a redesign brings it back. Side effects of a bump on a
paused run's first resume: the `inputs-changed` note may name inputs nobody edited (their digests
are computed differently now; past design its message still says the change takes effect the next
time the run is in design), and a step paused before it finished loses its partial output from
before the pause (a `carryover-dropped` note), because its recorded inputs no longer compare equal.
The adopt pass never adopts an older scheme's manifest; it only records steps that have none.

`--resume --inspect` is read only, whatever the checkpoint's version: it reads a private copy and
never opens or changes the database (no migration, no backup, and no run row: before this change it
marked the run resumed). Like every resume it takes and releases the run lock, so it cannot race a
live resume. It reads through queries that work on every shape since v7, and for a checkpoint an older
Styre wrote it says either
`resume will upgrade this checkpoint from v<old> to v<new>, after writing a backup` or why resume
would refuse it (newer than this Styre, a shape it does not know, older than v7), with the same
recorded base, current head and step to dispatch again it shows today.
```

- [ ] **Step 5: `conventions.md`, `telemetry-export.md`, `SECURITY.md`, `brainstorm.md`**

`conventions.md:108-110`: keep the nested slug sentence (it stays true for `run`, `clean <ident>` and `setup`; `ls` and `clean --all` do not list nested slugs yet, ENG-491, and the added text says so) and add after it: `` A slug may contain `/`, and each part between slashes must be a folder name: not empty, not `.` or `..`, and with no `\` or NUL character; `team/app` is accepted, while `team/..`, `/abs`, `a//b` and `a/./b` are refused. `styre ls` and `styre clean --all` do not yet list checkpoints under a nested slug (ENG-491); `styre clean <ident> --slug team/app` reaches one. An ident is one folder name by the same rule, with no `/` either. `styre setup`, `styre run` and `styre clean` refuse any other name before building a path from it: exit `64` for a name given on the command line or derived from the repository (a folder name holding `\`, for example: pass `--slug`), `78` for a slug read from a profile file (rerun `styre setup` with `--slug`). ``

`runtime-parameters.md`, the three `--slug` rows (lines 41, 147 and 177): append `` May contain `/` (it nests); see `conventions.md` for the names refused. `` to the description.

`conventions.md`, append to **Checkpoints**:

```
When `styre run` (or `styre migrate`) upgrades a checkpoint written by an older Styre, it first
writes a backup next to it: `run.db.v<old version>.<UTC timestamp>.bak`, made with `VACUUM INTO`
(complete even while another reader holds a snapshot). It is never deleted by Styre; `styre clean`
removes it with the checkpoint folder.
```

`telemetry-export.md`, after the ENG-485 note reasons:

```
**Six `note` reasons from ENG-477** (no new kind, no schema change), all with `payload_json.event`
equal to the reason:
- **`inputs-changed`** (a resume, or a run on a reused `--db`, found design inputs changed) —
  `names` (the changed inputs), `pastDesign`, `message`.
- **`invalidated`** (design steps were reset to run again) — `stepKeys`, `changed`, and `cause`:
  `inputs` (an input the step reads changed), `feedback` (a review sent the plan back),
  `worktree-recreated` (`provision` runs again because a resume recreated the worktree) or
  `manifest-touched` (`provision` runs again because a change touched a dependency manifest).
- **`adopted`** (design steps finished under an older Styre were recorded) — `stepKeys` (recorded
  with today's inputs), `willRerun` (recorded with an empty
  manifest, run again once the steps before them have), `message`.
- **`reused-database`** — no other field: a `styre run` on a reused `--db` whose ticket already
  exists.
- **`toolchain-missing`** — `detail`: a resume found this host without a required suite's tools
  while the run was already waiting for the operator, so no second pause was written.
- **`carryover-dropped`** — `stepKey`, `changed`: a step paused before it finished was dispatched
  again under other inputs, so its partial output from before the pause was not passed on.
A design `loopback` event's payload also carries `consumer` (`design:dispatch`) and `generation`.
```

`SECURITY.md`, in **Limits, stated plainly**, after the **Interrupted checks step, worktree mode** bullet:

```
- **Design reruns in worktree mode depend on the ticket branch surviving a resume** (ENG-488). The
  plan's digest is recorded from the branch, and the starting commit is read right after a fresh run
  creates it. `git worktree add -B` on resume recreates the branch from the target repository's
  checked out HEAD, which drops the run's commits and moves HEAD: a second resume is refused until
  `--accept-head`, unless a dispatch has committed on the recreated branch in between. In place mode
  is unaffected. Until ENG-488 lands this is the known limit of design input invalidation.
```

`brainstorm.md` §11, a new first entry right under `## 11. Changelog`:

```
- **2026-10-09 — ENG-477: design steps rerun when their recorded inputs change; Styre upgrades old databases.** Design: `docs/brainstorms/2026-10-09-eng-477-design-input-invalidation-design.md` (rev 5, decisions E1 to E9; E7 withdrawn); plan: `docs/plans/2026-10-09-eng-477-design-input-invalidation.md`. Implements umbrella D7 for the design stage and D9: a declared table (`src/daemon/design-graph.ts`) generates the design routing; each step records a manifest of input digests (snapshot rows in `ticket_input`, output rows, the plan digest) and the walk invalidates only a step whose inputs changed (early cutoff). Loopbacks invalidate the step that consumes their feedback, and feedback and the carryover belong to that step's generation. `migrate()` now upgrades: `VACUUM INTO` backup, versioned migrations (v7 → v8 replaces `ensureRunTable`, v8 → v9 adds the new columns and tables), structural proof; old paused runs are adopted on resume (operator ruling: the pass stops at the first applicable step that is not succeeded; the steps after it are recorded with an empty manifest and rerun). A resume applies its plan review action (`retry-plan`: apply the plan review verdict again, or redesign when HEAD moved) only when the run stopped at the plan review gate (operator ruling). Resume narrows the profile like a fresh run and pauses rather than drop a required suite. The checks steps keep today's rules (E9, ENG-475; ENG-490). Known limit: ENG-488 in worktree mode.
```

- [ ] **Step 6: Check, then commit**

Run: `cmp src/db/schema.sql docs/architecture/schema.sql && grep -c '^CREATE TABLE' docs/architecture/schema.sql && perl -e 'alarm 600; exec @ARGV' bun test test/lifecycle/messages-doc.test.ts`
Expected: `19`, then PASS.

Read every paragraph written in Steps 1 to 5 once more for coined hyphenated compounds (Global Constraints); write any you find out in plain words.

```bash
git add docs/architecture SECURITY.md CLAUDE.md README.md
git commit -m "docs(eng-477): design input invalidation, database upgrades and resume narrowing" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Before opening the PR

Not part of this plan's tasks, but required by `CLAUDE.md` before `gh pr create`: dispatch an independent adversarial reviewer over the exact HEAD, write `.claude/reviews/<full-sha>.md` with its findings and the `reviewed-sha:` and `reviewed-remote:` lines, and review again after any fix commit. The PR body names ENG-488 as the known limit for worktree mode (spec §4.2), states the seam change (a ticket driven through `tick` or `advanceOneStep` by anything but `styre run` must get `captureSnapshot` before its first step; `build-operations.md` §5), and lists the hand off notes below that the operator has not yet ruled on.

## Spec coverage

| Spec section / requirement | Task |
|---|---|
| E1 an edit reruns its readers and their dependants | 13, 17 (§8.1) |
| E2 ticket text fixed; resume never reads the tracker | 7 |
| E3 only `complexityGrading` among config keys | 6, 7 |
| E4 scope is the design stage | 6, 13 |
| E5 manifests, output digests, early cutoff | 9, 13, 14 |
| E6 an edit past design takes effect at the next design visit | 7, 13, 17 (§8.2) |
| E8 table enforced by tests, proxy, accessors | 15 |
| E9 checks steps unchanged | 13 (routing kept), 17 (never invalidated) |
| §3 the table, generated routing | 6, 13 |
| §3 recording proxy, accessors, current step slot, source guard | 15 |
| §3.1 four rules, unit test and assertion on first use, exit 70 | 6, 9 (assertion before a table step), 13 (walk) |
| §3.2 environment observations out; reconcile units out via `origin` | 4, 9 (digest), 10 (clearing) |
| §4 `ticket_input`, run start, reused `--db`, resume, `inputs-changed` note | 7, 8 |
| §4.1 one profile for fresh runs and resumes; placement; wiring; pause; notice; never 69 | 8 |
| §4.2 starting commit per mode, never rewritten | 7 |
| §5.1 canonical encoding | 5 |
| §5.2 manifest columns, recorded in any stage, slow work outside the transaction | 4, 9 |
| §5.3 digests: snapshot, units, track, plan through git | 9 |
| §5.4 the walk; only in design; extract and size gating moved | 13 |
| §6 invalidate in one transaction; `resetProvision` and the manifest touch hook through it | 10 |
| §6.1 clearing rules | 10 |
| §6.2 outputs written in `onSucceed`; own rows before the verdict | 9 (ordering), 11 |
| §6.3 no files restored | (nothing to build; the plan file is revised in place by the rerun) |
| §6.4 loopbacks: plan review, code review, retry-plan; later stage resets kept | 14 |
| §6.4 ruling (2026-10-09): retry-plan only when the run stopped at the plan review gate (any plan review escalation since the last resume, by signature; others ignored; no second toolchain pause on a waiting ticket) | 14 (condition, unit and end to end tests, v8 recordings), 8 (the pause skip) |
| §5.1 ruling (2026-10-09): an older scheme's manifest counts as changed; adopt only steps with no manifest; pinned digests | 9 (pin test), 12 (adopt), 13 (walk), 18 (docs, side effects of a bump) |
| §6.5 feedback and carryover per generation | 14, 17 (§8.7) |
| §6.6 livelock reasoning; invalidate loop guard (counted since a resume or, by ruling 2026-10-09, a run on a reused `--db`) | 16, 17 (§8.6) |
| §12 risk: profile fields with defaults change paused runs' digests | 9 (pin test), 18 (docs) |
| §6.7 the general rule (applied to design) | 14 |
| §7.1 migrations runner, table of outcomes, backup, foreign keys, per migration transaction; a failed migration or proof leaves the previous version | 2 (the proof inside the last migration's transaction) |
| §7.2 table rebuild helper, test exercising it (on `signal`, with its incoming foreign key, foreign keys off and inside a transaction, as a migration runs it) | 2 |
| §7.3 structural proof, column order, AUTOINCREMENT, CHECK probes in tests | 2, 4 |
| §7.4 known shapes, v7 → v8 conditions, v8 → v9, v6 refused, `ensureRunTable` removed | 2, 4 |
| §7.5 one fixture per shape from each release's own code; recorded databases of real paused runs | 1 (seven shapes, three recorded v8 runs; hand off note 11) |
| §7.6 adopt pass; ruling (2026-10-09): stop at the first applicable step that is not succeeded, later steps "will rerun" | 12 (pass, unit tests), 14 (the plan gate and redesign recordings resumed end to end) |
| §7.7 readers that do not migrate, for ls, clean, `--fresh`, test per fixture; rulings (2026-10-09, 2026-10-10): `--resume --inspect` is read only whatever the version | 3 |
| §7.7 ruling (2026-10-09): reads that must not change a database go through a private copy; fixtures in DELETE mode | 1 (`readCopyOf`, its tests, the generator, the header test), 2 (`readDatabaseState`), 3 (ls, clean, `--fresh`, `--inspect`), 7 (the harness's reads) |
| §7.7 rulings (2026-10-10): a schema this Styre cannot use is listed as `incompatible`; `clean` refuses unreadable and incompatible checkpoints (exit 65), adds no new delete path, and names what to remove as plain text; `ls` and `clean --all` reach today's folders; an ident is one folder name, a slug may nest with `/` (64, or 78 from a profile file), checked by `run`, `clean` and `setup` | 3 (`listCheckpoints`, `ls`, `clean`, `checkpoint-name.ts`, `loadRunProfile`, `setup`, the fixture tests and their breaks), 18 (docs, README's exit table) |
| Rulings (2026-10-10): §4 a reused `--db` prepares every active ticket; §5.1 a newer scheme is refused on resume and on a reused `--db` (65), and `--inspect` reports it; §5.3 an uncommitted plan escalates without a retry; §7.7 every `--inspect` is read only | 7, 12 and 16 (every active ticket); 13 (newer scheme); 9 (uncommitted plan); 3 (`--inspect`); 18 (docs) |
| §8.1 to §8.15 | 17 (8.1, 8.2, 8.6, 8.7, 8.8 with a crash point right after the invalidate transaction, 8.9); 13 and 8 (8.3); 8 (8.4); 14 (8.5); 6 and 15 (8.10); 7 (8.11); 2, 3, 4 (8.12); 12 and 14 (8.13); 16 (8.14); 5 and 9 (8.15) |
| §9 docs, both schema copies, CLAUDE.md count, brainstorm changelog | 4, 18 |
| §10 acceptance criteria | 13, 16, 17, 10, 12, 6, 18 |
| §11 out of scope (other stages, checks steps, new design steps, checklist derivation, ticket refetch, ENG-488) | not built; ENG-488 named (18) |

## Hand off notes (places where the code and the spec differ, and how this plan resolves each)

1. **`design:review`'s inputs.** The spec's table lists "ticket title and description"; `designReviewVars` (`src/dispatch/prompt-vars.ts:220-248`) reads the title only. The spec says the exact fields come from the code, so the table declares `ticket.title` (Task 6), and the recording proxy test (Task 15) would fail if the handler started reading the description.
2. **The cause for the manifest touch hook.** The spec names `worktree-recreated` for `resetProvision` and says `resetProvisionIfManifestTouched` "calls the same function"; it names no cause for it. The plan uses `manifest-touched` (Task 10).
3. **A succeeded step without a manifest outside the adopt pass.** The adopt pass runs on resume and on a reused `--db`, the only paths that can bring one. The walk refuses such a step loudly (Task 13) rather than adopting silently, per the fail fast rule. A step recorded under an older scheme is not adopted: operator ruling (2026-10-09, now in spec §5.1), it counts as changed and reruns the next time the run is in design (Task 13).
4. **The worktree starting commit.** `ensureWorktree` (`src/dispatch/worktree.ts:60`) runs `git worktree add -B` on every resume (ENG-488), so "first created" is not visible in git. The plan records it only from a fresh run's provision, through a registry flag (Task 7). So a worktree mode run that stopped before its first `provision` created the branch (a crash, a stop, a pause before it) has no starting commit for its whole life: resume never records one, and `startingCommit()` returns null. ENG-478, which reads it, must handle null (review minor m5).
5. **Exit codes for refused and failed migrations** are not specified. The plan uses `65` for refusals (with the resume refusals) and `70` for a failed migration (Task 2), documented in Task 18.
6. **The carryover for a parked step that is not succeeded.** Such a step is never invalidated (the walk stops at it), so its generation does not change when an upstream step reruns first. Operator ruling (2026-10-09), now in spec §6.5: `transcript.json` records the parked table step's manifest, and the carryover is dropped, with a `carryover-dropped` note, when the inputs differ at dispatch (Tasks 14, 17, 18).
7. **`readPlanFindings`.** The spec names it as an example accessor, but no design handler reads plan findings; only the resolver's gate does, outside any step. The plan builds `readWorkUnitsForDesign` only (Task 15); the gate keeps reading `review-round.ts`.
8. **Existing tests that seeded design rows directly** cannot keep doing so. The ones that run `design:extract` or `design:review` after a hand marked `design:dispatch` break as soon as manifests are recorded (the `plan` input needs its digest), so Task 9 moves them onto real steps through `reachDesignStep` (defined there); `design-size-e2e.test.ts` is one of them (two of its flows run the real `design:review`). The rest (resolver, `design-size.test.ts`, advance, review-resume, and the checks tests that marked design done by hand) break once the walk refuses unfingerprinted steps; Task 13 moves them, adds `reachChecksStep` for the checks tests, and deletes the six resolver design tests in favour of real step equivalents. One more existing test breaks at Task 9 unless the reused database case is handled: `test/lifecycle/wiring.test.ts` (`with a reused --db, the interruption names the ticket this run inserted`, lines 698-735), whose reused database holds two other active tickets that `tick` advances first. Operator ruling (2026-10-10, spec §4): a run on a reused `--db` records the snapshot and runs the adopt pass for every active ticket in it, with the same notes (Tasks 7, 12 and 16), so that test stays green unchanged, and `snapshot-e2e.test.ts` covers the rule.
9. **`runtime-parameters.md` and `CLAUDE.md` say `styre migrate` prints to stdout**; `src/cli/migrate.ts:15` writes to stderr. Operator ruling (2026-10-09): the code stays, and Task 18 corrects both docs.
10. **Multiple resumes in worktree mode.** On each resume `git worktree add -B <branch> <path>` with no start point (`worktree.ts:71`) resets the ticket branch to the target repository checkout's current HEAD (the base only when the operator's checkout sits on it), which moves the branch HEAD. `headBaseline` (`park.ts:199-212`) takes the latest dispatch row with a `branch_head_sha`, and a parked dispatch records none (`run-dispatch.ts:232-241`), so the next resume is refused (exit 65, until `--accept-head`) only when the run paused again before any dispatch committed on the recreated branch; once one has, the baseline is the new HEAD and a second resume passes the guard. The plan's tests that resume more than once in worktree mode are all in the refused case or use `--accept-head`; the others use in-place mode (Task 17 intro). ENG-488 is the known limit.
11. **The v7 and v6 fixtures are seeded through each release's repositories, not its handlers** (spec §7.5 says "seeded through that era's real handlers where they can run"; review minor 8). The lockfile of v0.9.0 and v0.10.0 matches today's, so their handlers could be driven; but the migration and reader tests need rows that no single real run of those releases leaves together (a reconcile unit, a step waiting on a signal, an interrupted running step with its note), and every column and constraint is still the release's own (`migrate()` and the repositories of that release, Task 1). The real handler path is covered by the three recorded v8 runs, the version a paused run resumes from. For the operator to confirm.
12. **The adopt pass's stopping rule** (operator ruling C1, 2026-10-09). Two applications of the ruling, for the operator to confirm (Task 12): a pending `provision` (reset for a recreated worktree on every worktree mode resume) does not stop the pass, because it produces nothing a later step reads (stopping there would rerun the whole design stage of every older run resumed in worktree mode, against D9); and when the plan cannot be read at the branch head (the branch is gone, or holds no plan file), `design:dispatch` and every step after it are "will rerun" (review minor 1). A succeeded step whose "applies when" is false is recorded as "will rerun" too, so it can never reach the walk without a manifest.
13. **A profile schema field with a default changes paused runs' digests** (first review minor 11). The snapshot holds the parsed profile, so a release that adds a field with a default to a component, `runtimeContext` or `promptVars` (or changes a config default or how a field is parsed) changes the digests the steps that read them compare against. Under the scheme rule (note 17) such a release must bump the scheme, which the pin test enforces; the steps then rerun at the next design visit, a deliberate decision rather than an accident. Spec §12 now lists this risk.
14. **Machine identifiers in kebab case.** Closed by operator ruling (2026-10-09): event reasons (`inputs-changed`, `invalidated`, `adopted`, `carryover-dropped`, `reused-database`), cause values (`worktree-recreated`, `manifest-touched`), crash point names and shape ids keep the codebase's kebab case. Docs always show them in backticks with a plain English explanation beside each, and never use them as words in sentences. Every Task 18 doc block was checked against this (the §2 rows of `minimal-loop.md`, where `retry-plan` now carries its explanation and two coined hyphenated words became plain words, the exit code row, the DI1 row, the §6.2 paragraph, the notes and causes in `runtime-parameters.md` and `telemetry-export.md`, and the brainstorm changelog entry).
15. **`--resume --inspect` is read only.** Closed by operator ruling (2026-10-10), which replaces the 2026-10-09 choice to keep today's path for a current checkpoint: every `--inspect`, whatever the version, decides from `readDatabaseState` and reports through `inspectWithoutUpgrading`, both on a private copy, and writes nothing to the database: no migration, no backup, no open of the original (so no WAL switch), no `insertRun` and no `markResumed` (today's `--inspect` set `resumed = 1` and raised `run.attempt`, which telemetry stamps on every row). The output keeps today's lines (recorded base, current head, step to dispatch again, `(no changes made)`) and adds the `schema:` line. The run lock is still taken and released (a file beside the database, as today), so an inspect still refuses while another resume holds it. `CLAUDE.md:80` ("diagnostics only") stays; Task 18's docs say `--inspect` writes nothing.
16. **The loop guard also counts from a `reused-database` note** (second review m5). Spec §6.6 named only the `resumed` event; counting from the note (written by a run on a reused `--db` whose ticket exists) is a deliberate extension, now recorded in spec §6.6 as a ruling (2026-10-09).
17. **The scheme rule** (operator ruling, 2026-10-09, spec §5.1). A manifest recorded under an older `FINGERPRINT_SCHEME` counts as changed and the step reruns at the next design visit; the adopt pass adopts only steps with no manifest. `test/daemon/fingerprint-pin.test.ts` (Task 9) pins the digests of a fixed set of inputs per scheme, so a change to encoding, parsing, defaults, declared inputs or output digests fails until the scheme is bumped and a new pin added.
18. **Reads through a private copy** (operator rulings, 2026-10-09; spec §7.7). Closed. The rulings cover every read of a database that must not change it, as a class, in production and in tests; `readCopyOf` (Task 1) is the one place that does such a read, and a source guard (Task 4, `test/db/read-only-guard.test.ts`) refuses `readonly: true`, `mode=ro` and `SQLITE_OPEN_READONLY` anywhere in `src/` and `test/` except the stated exceptions. Converted: `readDatabaseState` (Task 2) and `inspectWithoutUpgrading` (Task 3) for `--inspect`; `listCheckpoints` (`checkpoints.ts:117`), `reapEffort` and `cleanImpl` (`clean.ts:38,166`) and `undoBeforeDiscard` (`interruption.ts:243`) for `ls`, `clean` and `--fresh` (Task 3); `priorRunIdAt` (`park.ts:107`, Task 2), which now says on stderr, with the caller's prefix, when it cannot read the copy it is about to overwrite; and in tests `fixtureVersion`, the fixture shape tests, the migration tests' reads, `DesignHarness.read`, and the existing tests' reads of run databases (Task 3 Step 4b: `e2e-interrupt.test.ts:170,222,242,562`, `interruption.test.ts:907`, `terminal.test.ts:358`, `signals.test.ts:152,306,330,361`, `run-pr-base.test.ts:13`, `migrate.test.ts:41`). Stated exceptions in the guard: the `migrate-upgrade.test.ts` reader that holds a read snapshot while the backup runs (the scenario under test, on a private copy), and the guard itself. The remaining opens write on purpose (`openDb` in `migrate`, `run.ts:429`, `park.ts:261`; `recordInterruption`, `interruption.ts:49`; the fixture seeder and drivers; tests that set up or relocate state on their own copies). `readCopyOf` takes the copy again when the source moved while it was copied (sizes, times, the WAL header; 3 attempts, then a clear error), and `ls` lists an effort it could not read as unreadable instead of dropping it. Observed on macOS with Bun 1.4.2: a closed WAL connection leaves its `-wal` and `-shm` in place (elsewhere SQLite may remove them); nothing here relies on either behaviour. The fixture generator converts every fixture to DELETE mode (`toDeleteMode`), and a test checks the committed files' headers. What `ls` and `clean` do with a checkpoint they cannot use (operator rulings, 2026-10-10; ENG-477 adds no new way to delete anything): a schema this Styre refuses (newer, unknown shape, older than v7) is listed as `incompatible` with the reason; a checkpoint that cannot be read (damaged, or no ticket recorded) is listed as `unreadable` with the reason. `clean <ident>` refuses both (exit 65, `EX_DATAERR`, the closest existing code: the checkpoint's data is unusable, not the invocation) and removes nothing; it names the reason, the checkpoint folder, and each worktree that looks like the run's as plain text, prints no command, and points at `runtime-parameters.md` for the removal by hand. `--purge` refuses the same way, and `clean --all` skips both. A checkpoint folder with no `run.db` stays "no styre effort" (exit 64) and is not listed, as before. Listing the worktree candidates needs the project's profile to find the target repository, as `clean` already did before this change. Names (operator rulings, 2026-10-10): an ident is one folder name; a slug may nest with `/` (`conventions.md:108-110`), each part a folder name, so `team/app` works and `team/..`, `/abs`, `a//b`, `a/./b` are refused. One file (`src/cli/checkpoint-name.ts`) checks them before any path is built from them, in `clean` (including `--all`), in `styre run` fresh and `--resume` (`parkDir` through `checkpointPath`, which also keeps the resolved path inside the state root; `loadRunProfile` for the `--slug` flag, a derived slug and the profile's slug) and in `styre setup`, which therefore never writes a slug `run` refuses. Exit 64 for a name from the command line, the repository or the tracker; 78 for a slug read from a profile file. This also closes a gap outside the ruling's wording: a fresh `styre run <ident> --fresh` whose tracker returned an ident of `..` would have reached the `rmSync` of the slug folder (`run.ts:381-407`); `parkDir` now refuses it first. Cut back (operator ruling, 2026-10-10): `listCheckpoints` reaches exactly today's folders (two levels, symbolic links followed as today), so `ls` does not list a nested slug's checkpoints and `clean --all` reaches the same folders as today, reaping fewer (it skips the two new kinds); the refusal of `clean` names what to remove as plain text and prints no shell command, and `runtime-parameters.md` describes the removal by hand. The `ls` section titles print `--slug` in their `styre run ... --fresh` hint, and `README.md`'s exit code table is brought in line. Still open, outside this plan: `styre notify --slug` builds `<config>/<slug>/config.json` unchecked (a read only).
19. Safe removal of unreadable or incompatible checkpoints is ENG-491.
20. Listing checkpoints under nested slugs in `ls` and `clean --all`, and printing the commands that remove an unusable checkpoint, moved to ENG-491 (operator ruling, 2026-10-10).
21. **An input edit at a plan review gate stop with HEAD unchanged does not take effect** (review minor m2). `retry-plan` runs `applyReviewVerdict('design:review')` in the resume transaction, which escalates again on the same findings before the walk runs, so an edit to, say, `promptVars` meant to steer the planner never reaches `design:dispatch` while the gate holds. Operator ruling (2026-10-10): the behaviour stays (it matches spec §6.4 and today's "same HEAD stays paused"); only the `inputs-changed` note's wording is corrected (Task 7: the steps are judged again when the run next walks the design steps, and a gate stop stays until the plan changes and the run resumes with `--accept-head`). Filed as ENG-493.
22. **Deliberate, beyond the spec** (operator rulings, 2026-10-10). Each was flagged by the final review (S2 to S4) and stays: `dumpPark` gains a `prefix` parameter and says on stderr when it cannot read the paused copy it is about to overwrite, where `priorRunIdAt` hid the error before (an earlier ruling to fail loudly, Task 2); `migrate()` refuses a database with tables but no `schema_meta` as an unknown shape (spec §7.1's table lists only "no `schema_meta` → create"; Task 2); and the existing `migrate-cli` test is hardened with `ownChild` and a 60 s kill timer (safety only, Task 4).
23. **`design:dispatch` and an uncommitted plan** (operator ruling, 2026-10-10, spec §5.3; review S1). When no plan for the ticket is committed at the branch head (for example `docs/plans/` is in `.gitignore`), `design:dispatch` fails at once with a `StepPrerequisiteError`: the step records attempt 1 (its one execution), but no retries are spent, and the escalation tells the operator that the plan must be committed, to remove `docs/plans/` from `.gitignore`, commit that, and resume with `--accept-head` (the commit moves the branch HEAD). A repository that ignored `docs/plans/` worked before this change (the plan lived only in the worktree); it now stops at its first design step until the plans are committed.
24. **Which refusals print commands.** Closed by operator ruling (2026-10-10): the "plain text, no commands" ruling covers `clean`'s refusals only. The resume refusals, the migration refusals (Task 2) and the `ls` section titles keep today's `styre run <ident> --fresh` hints.
25. **`styre notify --slug` stays unchecked** (operator ruling, 2026-10-10). It only reads `<config>/<slug>/config.json` and writes nothing, so the name check of the other commands is not applied to it.
26. **`--inspect` and the run lock** (operator ruling, 2026-10-10). `--inspect` keeps taking and releasing the run lock, as every resume does today: it stops an inspect from racing a live resume. So it creates and removes `run.lock` beside the database (and, like any resume, clears a stale lock a dead run left), but it never opens or changes the database. Spec §7.7 says so.
27. **A newer fingerprint scheme on a reused `--db`** (operator ruling, 2026-10-10). A fresh `styre run --db` on a database whose manifests a newer Styre recorded refuses with exit 65 and the resume's message before anything is written (Task 13, `run.ts`); without it such a run went on (past design) or failed in the walk (exit 70, in design).

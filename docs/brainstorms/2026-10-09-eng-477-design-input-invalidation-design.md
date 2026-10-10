# ENG-477: design-stage steps rerun when their recorded inputs change, with a real database upgrade path

**Date:** 2026-10-09
**Status:** rev 5, approved by the operator 2026-10-09
**Ticket:** ENG-477 (deliverable 2 of the grounded-requirements split, parent ENG-483)
**Umbrella design:** `docs/brainstorms/2026-09-24-grounded-requirements-design.md` §9, §14, §15 (branch
`feat/grounded-requirements`), with the rev 2 review findings C3, M3 and M4
**Related:** ENG-475 (the same rubric for every other stage), ENG-478 (the next deliverable), ENG-488
(`git worktree add -B` resets the branch on resume), ENG-454, styre#150

### Revision history

- **rev 1** (561a699): a declared table, input fingerprints with output digests and early cutoff, an
  `invalidate` descriptor, versioned migrations, an adopt pass for v8 runs.
- **rev 2**: an independent review found 4 critical and 13 major problems (§13). The main changes:
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
  (E7, withdrawn in rev 4, and E8) replace rev 2's test file restore and its `ctx.inputs` refactor:
  - no files are restored on the branch; a re-authored check may modify its canonical file, judged
    against the commit its step generation started from (§6.3);
  - handler reads are pinned by tests, a recording proxy and named accessors (§3);
  - reconcile units are deleted with the extract units, and `origin` is backfilled;
  - a step reset by feedback keeps its manifest, so an edit made meanwhile is still caught;
  - every loopback names the step that consumes its feedback and that step's generation;
  - the toolchain narrowing on resume never exits 69;
  - a crash rerun of `checks:dispatch` is judged against its generation's starting commit;
  - proof rules for column order and `AUTOINCREMENT`; a timestamped backup.
- **rev 4**: a third review found 2 critical and 6 major problems, five of them in the checks steps
  again. On the operator's decision (E9) the checks steps leave this ticket: they keep today's rules and
  move to ENG-475, and the pre-existing re-author identity defect found on the way is ENG-490. E7 is
  withdrawn with them. Also:
  - a resume whose narrowing would drop a required suite pauses for the operator instead (§4.1);
  - accessor reads are attributed to steps at run time (§3);
  - an interrupted attempt's carryover transcript is dropped when its step is invalidated (§6.5).
- **rev 5**: the fourth review found no critical problem and one major ambiguity: where the resume
  narrowing and its pause go, and how the unusable list reaches provision (§4.1). Text fixes for six
  minor items (§13).

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
| E1 | An edit made while a run is paused, to the profile or to a content-shaping config key, reruns the design-stage steps that read it and everything downstream of them in the table. Untouched steps stay done. The checks steps are outside the table (E9) and never rerun on an edit. |
| E2 | The ticket text is fixed for the life of a run. Resume never reads the tracker. To pick up an edited ticket, start over with `--fresh`. |
| E3 | Only config keys a step's handler reads to decide its output count. Today that is `complexityGrading`. Model choices and `onPlanDefect` do not count. |
| E4 | The scope is the design stage: `provision`, `design:dispatch`, `design:extract`, `design:size`, `design:review`. (Narrowed by E9.) |
| E5 | Approach A: each step records a fingerprint of its inputs, and a digest of its output where that output is not in the database. Dependants are judged afresh after an upstream rerun (early cutoff, as in Bazel and Salsa). |
| E6 | An edit made while a run is paused after design (implement, verify, review, merge) is recorded on resume and takes effect the next time the run is in design. The run carries on from where it paused. (2026-10-09) |
| E7 | *(Withdrawn by E9.)* No test files are restored on the branch when checks rerun. Check identity changes so a re-authored check may modify its canonical file (`<ident>_ac<N>_test.*`), not only add it. Stale helper files from an earlier generation can remain; the PR lists that as a limit. (2026-10-09) |
| E8 | The declared table is enforced by tests, not by restructuring handlers: a recording proxy over the profile, config and ticket, and named accessor functions for upstream rows that check, at run time, that the current step declares them. (2026-10-09) |
| E9 | `checks:dispatch` and `checks:classify` leave this ticket. They keep today's rules (a redesign keeps the existing acceptance tests, as now) and move to ENG-475. Their feedback loops and git-file identity rules need their own design. The re-author identity defect is ENG-490. (2026-10-09, after three review rounds) |

## 3. The declared table (`src/daemon/design-graph.ts`)

One table, in order. For each step it lists when the step applies, what Styre hands it, what it
produces and how each output is cleared. **The design-stage routing in the resolver is generated from
this table**, so a step the resolver chooses is by construction a step the table declares. After the
table's last row, the resolver continues with today's checks routing (`checks:dispatch`,
`checks:classify`, then advance to implement), unchanged (E9).

| Step | Applies when | Snapshot inputs | Upstream outputs it reads | Feedback (not fingerprinted) | Produces |
|---|---|---|---|---|---|
| `provision` | always | profile components (as narrowed, §4.1); the unusable and non-primary component lists | — | — | nothing the table tracks (§3.2) |
| `design:dispatch` | always | ticket title and description; profile slug, prompt variables, runtime variables, detected stacks, and components (read by `environmentGate`) | — | design loopback findings | the plan |
| `design:extract` | always | ticket ident and title; profile slug, prompt and runtime variables, detected stacks, components | plan | — | work units (origin `extract`); `ticket.needs_docs` |
| `design:size` | always | config `complexityGrading`; when grading is on: ticket title, profile slug and prompt variables | work units; when grading is on: plan | — | `ticket.track` |
| `design:review` | `ticket.track = 'full'` (ENG-478's D11 widens this) | ticket title and description; profile fields its prompt reads | plan; work units | — | plan findings (rows of this step's latest dispatch), read directly by the gate |
| gate | when `design:review` applies | — | plan findings | — | escalates `review:unresolved-plan` if blocking findings remain (today's resolver rule, `resolver.ts:120-127`) |

- **Exact fields come from the code.** The plan pins every field by reading each handler and its
  prompt variables function in `prompt-vars.ts`.
- **Enforced by tests (E8).**
  - In tests, the profile, config and ticket handed to each handler are wrapped in a recording proxy;
    a test runs every design step and fails if it reads a field the table does not declare for it.
  - Upstream rows are read through named accessor functions (`readWorkUnitsForDesign`,
    `readPlanFindings`, and so on). Handlers are closures in one function and share helpers
    (`environmentGate` serves several steps), so a source guard cannot attribute calls. Instead
    `advance.ts` sets the current step key in a module-level slot (steps run one at a time per
    ticket) and clears it after, and each accessor asserts that the current step declares the read; an
    undeclared read throws. The accessors are only for table steps: steps outside the table, such as
    `checks:dispatch`, keep reading the repositories directly. A source guard keeps design handlers from importing the upstream repositories directly.
  - The recording proxy has an allowlist of infrastructure fields every handler may read (for example
    the worktree path), and the test drives each handler branch that reads the profile.
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
  `environmentGate` stays a precondition that is evaluated every time, as today. It is not a
  fingerprinted input.
- **`suite-requirements` signals** from `registry.synchronize` (`handlers.ts:465-497`). No design step
  reads them.
- **The checks steps** (E9), and with them acceptance criteria and checks.
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
  snapshot input and the ticket text. The starting commit is written when it is known: at run start in
  in-place mode, right after the branch is first created in worktree mode (§4.2).
- **On a reused `--db`** (run.ts:369, :428-440), rows that already exist for the ticket text and the
  starting commit are never rewritten; the profile and config rows are rewritten as on a resume, with
  the same `inputs-changed` note.
- **On each resume**, after `recover()` and the provision reset and before the first resolver pass,
  Styre rewrites the profile and config rows from what the handlers will receive now. The ticket text
  and the starting commit are never rewritten (E2).
- **Changes are recorded** in one `note` event, reason `inputs-changed`, listing the names. If the
  ticket is past design, the note says the change takes effect the next time the run is in design
  (E6).

(Operator ruling, 2026-10-10) A run on a reused `--db` records the snapshot, and runs the adopt pass
(§7.6), for every active ticket in that database, not only its own, with the same notes: the loop
drives every ready ticket it finds (`tick` advances up to two), with this run's registry and so with
this run's inputs. The starting commit stays the run's own ticket's.

### 4.1 One profile for fresh runs and resumes

A fresh run applies `applyToolchainGate` and drops components whose toolchain is missing
(`run.ts:338-339`); the resume path returns before that line (`run.ts:298-312`). The handlers
therefore see a different profile on resume than on the fresh run: a defect today, and a false
"inputs changed" on every resume once the profile is fingerprinted.

- **Where.** Resume narrows after the `--inspect` return and after the resume transaction that consumes
  pending `human_resume` signals and sets the ticket active (`park.ts:418-422`), and before
  `driveToTerminal`. A pause written before that transaction would be consumed by it.
- **Wiring.** Resume passes the narrowing's `unusableComponents` to the registry, as a fresh run does
  (`run.ts:446`; resume does not today, `park.ts:455-463`), so provision records its `toolchain` signal
  and the narrowing reaches the PR (ENG-412, ENG-425: a narrowing is never silent). It is also the same
  list provision's snapshot input reads, so an unchanged host gives no false `inputs-changed`.
- **The whole resume order:** the resume transaction → `recover()` → the narrowing and its pause → the
  snapshot (§4) → the adopt pass (§7.6) → the registry → `driveToTerminal`. `assertInPlaceIdentity`
  still runs on the profile before narrowing, as it does today.
- Resume prints the same stderr notice of the narrowing that a fresh run prints.
- Resume applies the same narrowing. It never exits 69, so
  `runtime-parameters.md:511` ("never raised on `--resume`/`--inspect`") stays true.
- When the fresh-run gate would refuse (nothing usable, or a component whose suite is `required` is
  unusable, `preflight.ts:179-186`), resume does not narrow that component away, because that would
  silently drop the required suite's declaration and its evidence (`handlers.ts:465-495`). Instead the
  run pauses for the operator (`needs_you`, exit 75) with a message naming the component and its missing
  tools. Installing them and resuming continues the run.
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
- Lists in their meaningful order: work units by `seq`, sets sorted.
- A scheme version, starting at 1. A step recorded under another scheme is treated as unfingerprinted
  and adopted (§7.6), never compared byte for byte.

(Operator ruling, 2026-10-09) This replaces the last sentence above. A step whose manifest was recorded
under an older scheme counts as changed, so it reruns the next time the run is in design; a run past
design is unaffected until it returns to design. The adopt pass (§7.6) adopts only steps with no manifest
at all (finished under a Styre older than this change) and never adopts an older scheme's manifest again.
The scheme covers everything a recorded digest depends on: the encoding, how the profile and config are
parsed (defaults included), what each table step declares, and how each output is digested. A test pins
the digests of a fixed set of inputs (snapshot rows, units, track, plan) per scheme, so any such change
fails until the scheme number is bumped deliberately.

(Operator rulings, 2026-10-10) This amends the paragraph above for the other direction. A manifest
recorded under a NEWER scheme than this Styre's cannot be compared. Resume refuses such a run before
it changes anything, with exit 65 and "this run was recorded by a newer Styre; use that version",
instead of failing later in the walk as a defect (exit 70). A fresh run on a reused `--db` that
holds such manifests refuses too (exit 65), before anything is written: the database holds a run
recorded by a newer Styre; use that version, or point `--db` at a new database. That message names
the tickets with newer manifests and does not suggest `--fresh`, which a reused database ignores.
`--inspect` reports it.

### 5.2 What a step records

When a table step succeeds, in any stage (provision also reruns during implement, and a missing
manifest would make the next design visit reinstall it), in the same transaction as `markSucceeded` and
its `onSucceed`,
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
  - Track: `ticket.track`.
- **The plan.** When `design:dispatch` succeeds, the runner lists `docs/plans/*.md` at the branch head
  through git, keeps the files whose frontmatter `linear:` equals the ticket ident
  (`plan-frontmatter.ts:8-28`), and hashes path and content, sorted by path. A renamed or extra plan
  file changes the digest, which is conservative. The resolver never reads the worktree.

(Operator ruling, 2026-10-10) When `design:dispatch` finds no plan for the ticket committed at the
branch head (for example because `docs/plans/` is in `.gitignore`), it fails at once, without a
retry (a non retryable failure: the step records attempt 1, its one execution, but no retries are
spent), and escalates with a clear reason: the plan must be committed, so remove `docs/plans/` from
`.gitignore`, commit that, and resume with `--accept-head`. The digest of nothing would
never change, so every later plan edit would go unseen.

### 5.4 The walk

Before choosing the next design-stage step, the resolver walks the table in order:
1. Skip a step whose "applies when" is false.
2. A step that is not succeeded is the next step to run, and the walk stops there. (No design step in
   this ticket is reset by feedback without an invalidate, so a step that is not succeeded never holds
   a manifest.)
3. A succeeded step's manifest is recomputed and compared with the recorded one.
   - A match: the step is done; continue.
   - A mismatch: return `{ kind: "invalidate", stepKeys: [step], reason: { cause: "inputs",
     changed: [names] } }`.
4. A gate row that fires returns its escalation, as today.
5. Past the last row: today's checks routing (E9), then advance to implement.

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

### 6.2 Handlers that are safe to rerun

Journal gating means a crashed step reruns from the start, so every design handler's database outputs
must be written atomically. Each handler returns its rows in its result, and writes them in `onSucceed`,
inside the success transaction. Today extract inserts units one by one before `markSucceeded`
(`handlers.ts:570-585`), so a crash between the two leaves partial units, and the rerun hits
`UNIQUE (ticket_id, seq)`.

- In `onSucceed`, a step's own rows are written before any verdict reads them: `design:review`'s
  findings before `applyReviewVerdict`.

### 6.3 Files on the branch

The only design-stage output on the branch is the plan, which a rerun of `design:dispatch` revises in
place. No files are restored. (Rev 2's test file restore and rev 3's identity change left with the
checks steps, E9.)

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
  design follows from fingerprints: a redesign that changes the units now also reruns `design:size` and
  the track. The checks steps keep today's behaviour after a redesign (E9).
- **`retry-plan` only at the plan review gate.** (Ruling, 2026-10-09: required by the redesign
  change.) A plan review redesign now leaves `design:review` succeeded, with its blocking findings,
  until the review reruns, so "stage `design`, `design:review` succeeded, blocking plan findings" no
  longer means the run stopped at the gate: a budget pause in the regenerated `design:dispatch` looks
  the same, and `retry-plan` would apply the verdict again on every resume. `planReviewResume` returns
  `retry-plan` only when some escalation since the last `resumed` event is plan review's, and no design
  loopback event or `invalidated` note came after it. Plan review's escalations are the gate's
  (signature `review:unresolved-plan`) and the verdict's own (its `review:` findings signature, never
  its dispatch id alone). Unrelated escalations (the projector, the invalidate loop guard, the step
  replay guard, the resume's toolchain pause) are ignored, and that pause is not added to a ticket the
  resume already left waiting. v8 wrote the same events, so an upgraded checkpoint answers the same.
- **The checks loop** (`applyChecksVerdict`) is unchanged (E9).

### 6.5 Feedback belongs to a generation

`designFeedback` (`design-feedback.ts:18-30`) takes the latest design loopback of the whole run and never
expires, so an invalidate caused by inputs would re-send an old redesign's findings.

- A redesign applies its invalidate first, then appends its loopback event with
  `{ consumer: "design:dispatch", generation: <after the bump> }`. `routeTo` is not the consumer
  (it is `review`), so the consumer is recorded separately.
- `designFeedback` returns only the event for `design:dispatch`'s current generation. An invalidate
  caused by inputs starts a new generation with no feedback.
- **The carryover transcript.** On resume, an interrupted attempt's partial output is prepended for the
  same step key (`run-dispatch.ts:147-149`). `transcript.json` records the step's generation, and the
  carryover is prepended only while that generation is still current, so a new generation never
  receives output written under the old inputs (`--accept-head` already drops it, `park.ts:423-425`).
- **A parked step that was never finished** is not invalidated: the walk stops at it, so its generation
  does not change when an upstream step reruns first. So for a table step, `transcript.json` also records
  the step's manifest as it was when the run paused. Just before the step is dispatched again, its
  current manifest is computed. If any input differs, the carryover is dropped and a `note` event
  (reason `carryover-dropped`) names the step and the changed inputs. A transcript written before
  ENG-477 has no manifest, so it is kept, as the adopt pass keeps a step finished then (§7.6).
  (Operator ruling, 2026-10-09: partial work belongs to the inputs it was made from, like feedback.)
- The checks steps' lookups (`latestChecksReauthorAcs`, `checksFeedback`) are unchanged (E9).

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

(Ruling, 2026-10-09) The count also starts again at a `reused-database` note, which a `styre run` on a
reused `--db` writes when its ticket already exists: that path rewrites the inputs as a resume does (§4)
but appends no `resumed` event.

### 6.7 The general rule for feedback loops (for every stage)

This ticket applies it to the design stage. ENG-475 applies the same rule to the other stages.

- **Feedback is never a fingerprinted input.** Review findings, check findings and similar results routed
  backwards ride on the loopback event, not in any step's manifest. If they were fingerprinted, a round
  that returns no findings would change the input again, from some findings to none, and invalidate the
  step that was just fixed: the livelock the ticket rules out.
- **A loopback that carries feedback explicitly invalidates the step that consumes it,** with cause
  `feedback`, through the same invalidate function. That opens a new generation, and the feedback is
  tied to it (§6.5), so the rerun sees exactly that round's findings, and a later rerun caused by
  changed inputs sees none.
- **Everything downstream follows from fingerprints.** The consumer's new output (a new plan, new units,
  new code) changes its dependants' inputs, so they rerun. No loopback carries a list of later steps
  to reset.
- **A clean round invalidates nothing.** No findings means no loopback, and no fingerprinted input
  changed.

Example, for ENG-475: code review returns fixes. `codeLoopback` invalidates the affected units' implement
steps with cause `feedback`, carrying the findings. Implement's fingerprinted inputs stay the plan and its
work unit. Verify, review and merge rerun because the code at the new head is their input, not because a
list names them. When the next review is clean, nothing is invalidated.

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
rebuild's rename quotes the table name (probes, review round 1 C3). Pragmas do not expose CHECK
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

- **v8 → v9 (this ticket):** the new `workflow_step` columns;
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
  another scheme (operator ruling, 2026-10-09, §5.1: only a step with no manifest; one under an older
  scheme counts as changed and is never adopted):
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

(Operator ruling, 2026-10-09) The pass adopts in table order and stops at the first applicable step
that is not succeeded, exactly as the walk does. A succeeded step after that point cannot be adopted
against inputs that do not exist yet: it is recorded with an empty manifest `{}` and the current
scheme, so the walk invalidates it with cause `inputs` through the ordinary comparison once its
upstream reruns, and the `adopted` note lists it as "will rerun". This covers a v8 run stopped at the
plan review gate and resumed (with HEAD moved, or unchanged) and a v8 run paused during a redesign
with `complexityGrading` on; recorded v8 fixtures of each must resume after the upgrade and finish.

### 7.7 Who migrates, and who only reads

- `run` (fresh and resume) and `styre migrate` upgrade.
- `styre ls`, `styre clean`, and `--fresh`'s discard read a checkpoint without migrating it. They call
  `undoBeforeDiscard` (clean.ts:38-46, run.ts:378), which reads through the shared repository column
  lists. Once those lists grow, the read would throw on an old database, and ENG-485's in-place undo
  would be silently skipped (`interruption.ts:249-253`). These paths get their own narrow queries,
  which select only columns present since v7, and a test runs `ls`, `clean` and `--fresh` against every
  fixture.

(Operator rulings, 2026-10-10) Every `--resume --inspect` is read only, whatever the checkpoint's
version: it reads through the private copy below and never opens or changes the database (no
migration, no backup, no open of the original, no run row). It only takes and releases the run lock,
as every resume does, so it cannot race a live resume.

(Operator rulings, 2026-10-09) Every read of a database that must not change it, in production and
in tests (`--inspect`, the narrow readers of `ls`, `clean` and `--fresh`, the pause's read of the copy
it overwrites, and every test's read of a fixture or a run database) goes through one private copy
helper: the file, and its `-wal` and `-shm` files when present, copied into a temporary folder, the
copy opened, the folder removed afterwards. The original is never opened, in any journal mode. A copy
during which a source file's size, modification time or WAL header moved is taken again, up to 3
attempts, then refused with a clear error; `ls` lists such an effort as unreadable, with the reason. A
source guard refuses read only opens anywhere else, with stated exceptions. The committed fixtures are
kept in rollback journal (DELETE) mode.

(Operator ruling, 2026-10-10) A checkpoint that cannot be used only because of its schema (written by
a newer Styre, an unknown shape, older than v7) is not treated as damaged: `ls` lists it with that
reason, and `styre clean <ident>` refuses it (exit 65), pointing at the Styre that wrote it or at
removing the folder by hand.

(Operator ruling, 2026-10-10, later the same day; cut back the same day) ENG-477 adds no new way to
delete anything, and its additions to `clean` and `ls` are only what it needs. A checkpoint that
cannot be read (damaged, or no ticket recorded) is listed by `ls` with the reason, and
`styre clean <ident>` refuses it exactly as it refuses a schema it cannot use: exit 65, nothing
removed. The refusal names, as plain text, the reason, the checkpoint folder and the worktrees that
look like the run's, prints no shell command, and points at the docs, which describe the removal by
hand; for a schema it cannot use it says first that the Styre that wrote the checkpoint keeps the
paused work. `--purge` refuses the same way and `clean --all` skips both kinds. `ls` and
`clean --all` reach exactly the folders they reach today (two levels under the state folder,
symbolic links followed as today); a checkpoint folder without its `run.db` stays "no styre effort"
(exit 64), as before. Listing nested slugs and printing removal commands are ENG-491; safe removal
of such checkpoints is ENG-491 too.

(Operator ruling, 2026-10-10, on names) An ident is one folder name: not empty, not `.` or `..`, and
with no `/`, `\` or NUL. A slug may contain `/` and then nests, as `conventions.md` documents; each
part between slashes must be a folder name by the same rule, so `team/app` is accepted and `team/..`,
`/abs`, `a//b` and `a/./b` are refused. One check applies wherever a checkpoint path is built, before
it is built: `styre run` (fresh and `--resume`: the `--slug` flag, a slug derived from the
repository, the profile's own slug, and the ticket's ident), `styre clean` (including `--all`), and
`styre setup`, which therefore never writes a profile whose slug `run` would refuse. A name given on
the command line or derived from the repository exits 64; a slug read from a profile file exits 78.
As a second line of defence the resolved checkpoint path must stay inside the state folder. A run
under a nested slug works (`run`, `--resume`, `clean <ident>`), but `ls` and `clean --all` do not
list it yet (ENG-491).

## 8. Testing

Every test that involves design steps drives the real handlers through `advanceOneStep` with
`FakeAgentRunner`, and counts dispatches per step. Nothing is set up by writing step rows directly.

1. **Each input reruns exactly its dependants.** For every snapshot input: pause in design, edit,
   resume. Exactly its dependants in the table rerun, every other table step keeps its dispatch count,
   and the checks steps never rerun (E9).
2. **E6.** Pause in implement, edit, resume: nothing in design reruns, the note says so, and a later
   redesign picks up the edit.
3. **No false changes.** A resume with nothing edited reruns nothing, in both in-place and worktree
   mode, including a profile with a component whose toolchain is missing.
4. **Resume narrowing (§4.1).** A resume on a host missing an optional component's tools narrows it and
   reruns its dependants; one missing a `required` suite's tools pauses `needs_you` with exit 75 and
   drops nothing.
5. **Early cutoff.**
   - A plan-review redesign that changes the plan reruns `design:review`.
   - A redesign that changes the units reruns size and review.
   - A redesign whose plan text changes but whose units do not reruns extract and review, not size
     (when grading is off).
   - A code-review redesign re-creates and re-implements the units even when the plan is identical.
6. **No livelock.** Plan review goes from findings to none; the run finishes in a fixed number of ticks.
7. **Feedback and carryover.** After a redesign followed by a profile edit and a resume, the new
   generation of `design:dispatch` gets no stale findings and no carryover transcript.
   And a run paused in the middle of `design:review`, resumed after an edit that changes the plan,
   dispatches `design:review` without its carryover and records `carryover-dropped`; resumed with no
   edit, it keeps the carryover.
8. **Crashes.** A child process is SIGKILLed at each design step:
   - between the handler's work and the success commit;
   - right after the success commit;
   - right after an invalidate transaction.

   Resume must leave no duplicate or partial outputs, manifests that match the inputs, and no step run
   twice for the same inputs.
9. **Every output kind is cleared**, and history survives: units (reconcile units included),
   `needs_docs`, track; unit-tied plan findings are kept (detached); the step history row is written.
10. **Enforcement.** The rules of §3.1 each refuse their kind of bad table; the recording proxy test
    catches a handler reading an undeclared field; an accessor called while another step is current
    throws.
11. **The starting commit** is recorded once, in both modes, and is unchanged after resume and after
    `--accept-head`.
12. **Migrations.** Every fixture in §7.5 to v9, with the structural proof and the CHECK probes; a newer
    database, an unknown shape and v6 refused; the backup written while another reader holds a snapshot;
    a failing `foreign_key_check` aborts; a failing migration leaves the previous version; `ls`, `clean`
    and `--fresh` work on every fixture without migrating it.
13. **D9.** A v8 paused run in worktree mode resumes on the new binary; the adopt pass records manifests;
    no finished design step reruns; the run completes.
14. **The guard.** A digest made deliberately unstable escalates with `invalidate-loop:<step>`.
15. **Canonical encoding.** Key order, NFC, ids and timestamps excluded.

Each key test is shown to fail when the code it guards is broken on purpose.

## 9. Docs, in the same PR

- **`minimal-loop.md`:** §1 design routing from the table, and that the checks steps keep today's
  gating (E9); §2 the redesign rows.
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
  - the resume pause for a required suite's missing tools;
  - the table assertion's refusal.
- **`conventions.md`:** the `.bak` file next to a run's database.
- **`telemetry-export.md`:** the new `note` reasons.
- **`SECURITY.md`** and the PR: ENG-488 as the known limit for worktree mode (§4.2).
- **Both `schema.sql` copies, byte-identical.** `CLAUDE.md`'s table count goes to 19.
- **`brainstorm.md` §11:** a changelog entry.

## 10. Acceptance criteria → design

| ENG-477 criterion | Where |
|---|---|
| Changing a design input invalidates exactly its dependants, shown per input through real steps | §5.4, §8.1, §8.3, §8.5 |
| No livelock | §6.6, §8.6 |
| Crash after each design step | §6.2, §8.8 |
| Every output kind cleared on invalidate | §6.1, §8.9 |
| A v8 paused run resumes after an automatic migration and continues without rerunning finished design steps, on a real v8 database | §7.4 to §7.6, §8.12, §8.13 |
| The startup check refuses an inconsistent table | §3.1, §8.10 |
| Docs, both `schema.sql` copies, independent review before the PR | §9 |

## 11. Out of scope

- Other stages keep their reset lists (ENG-475).
- The checks steps (E9; ENG-475) and the re-author identity defect (ENG-490).
- New design steps (ENG-478 and later).
- Moving the checklist derivation to run start (ENG-478).
- Re-fetching the ticket on resume (E2).
- Fixing `git worktree add -B` (ENG-488).

## 12. Risks

- **An unstable digest** would invalidate on every pass. Mitigated by the canonical encoding tests, the
  "no false changes" tests (§8.3) and the `invalidate-loop` guard.
- **The plan is outside the database.** If a later stage edits it, the recorded digest is stale. That
  only matters when the ticket is back in design, and a redesign names `design:dispatch` explicitly.
- **Checks after a redesign or an edit.** Out of this ticket (E9), a redesign that changes the units, or a
  profile or config edit, keeps the acceptance tests written before it, as today. ENG-475 owns it.
- **The `signal` rebuild for v0.8–v0.9 checkpoints** is the first real rebuild. The backup, the
  per-migration transaction, the foreign key check and the structural proof bound the damage.
- **Profile fields with defaults change paused runs' digests.** The snapshot holds the parsed profile, so
  a release that adds a field with a default to a component, `runtimeContext` or `promptVars` (or
  changes a config default or how a field is parsed) changes the digests of every paused run, and the
  steps that read them rerun at the next design visit although nobody edited anything. Mitigated by the
  test that pins the digests of a fixed set of inputs per scheme, which fails until the release bumps
  the scheme deliberately (§5.1 ruling), so the rerun is a decision, not an accident.

## 13. Review record

- **rev 1 → rev 2**, independent review (2026-10-09), verdict revise: 4 critical, 13 major, 12 minor.
  Each finding and where rev 2 answers it:

| Finding | Answer |
|---|---|
| C1 plan-review redesign drops unit-tied findings and skips re-review | plan as an input of `design:review` and graded `design:size` (§3); plan findings detached before units are deleted (§6.1) |
| C2 checks rerun scoped to stale ACs | feedback belongs to a generation (§6.5)  *(superseded by E9 in rev 4)* |
| C3 textual schema proof fails on real databases | structural proof plus CHECK probes (§7.3) |
| C4 ordinary resumes rerun design | one profile narrowing (§4.1); environment observations out of the model (§3.2) |
| M1 edits paused after design | E6 (§2, §5.4) |
| M2 walk semantics, fast track | stop at the first step not done; "applies when" column; routing generated from the table (§3, §5.4) |
| M3 checks hard-deleted | supersede only (§6.1)  *(superseded by E9 in rev 4)* |
| M4 restore set and checks-loop change | full diff of the generation, invalidate-superseded only, through `commitWorktree` (§6.3)  *(superseded by E9 in rev 4)* |
| M5 handlers not safe to rerun | outputs written in `onSucceed` (§6.2) |
| M6 reconcile units in the digest | `work_unit.origin` (§3.2) |
| M7 checks over-fingerprint units | check owners only (§3)  *(superseded by E9 in rev 4)* |
| M8 table does not match handlers | corrected table, signals owned by step, classify clearing, `ctx.inputs` (§3, §6.1)  *(superseded by E9 in rev 4)* |
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

- **rev 3 → rev 4**, independent review (2026-10-09), verdict revise: 2 critical, 6 major, 6 minor.
  Five of the eight serious findings were in the checks steps (C1 classify invalidated by every checks
  round; M1, M2 the identity rule; M3 the arbiter re-author; M6 classify needs row ids). Answer: the
  checks steps leave this ticket (E9, ENG-475; ENG-490 for the identity defect). The rest:

| Finding | Answer |
|---|---|
| C2 resume narrowing drops a required suite | pause `needs_you` instead (§4.1) |
| M4 the source guard cannot attribute accessor calls | run-time attribution by the current step key (§3, E8) |
| M5 the carryover transcript is unscoped | dropped when the step is invalidated (§6.5) |
| Minor: stale rev 2 text | fixed (§13 reference, §9) |
| Minor: `generation_start_head` on provision unused | removed with E7 |
| Minor: the starting commit untested | §8.11 |
| Minor: compare first for failed or recovered steps | moot: only succeeded steps hold a manifest (§5.4) |
| Minor: the guard threshold after C1 | C1 left with the checks steps |
| Minor: ENG-296's declared-path fallback under E7 | E7 withdrawn; ENG-490 keeps it |

- **rev 4 → rev 5**, independent review (2026-10-09), no critical finding; one major, six minor.

| Finding | Answer |
|---|---|
| M1 where the resume narrowing and pause go, and the unusable list wiring | §4.1 |
| Minor 1 manifests recorded in any stage | §5.2 |
| Minor 2 starting commit timing | §4 |
| Minor 3 the accessor slot | §3 |
| Minor 4 the carryover mechanism | §6.5 |
| Minor 5 E1 and §8.1 wording, risk, Linear text | E1, §8.1, §12; ENG-477 and ENG-475 amended in Linear |
| Minor 6 leftover text | §5.1, §9, §13 rows marked |

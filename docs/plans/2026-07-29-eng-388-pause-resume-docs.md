# ENG-388 — Pause/Resume Docs Update & Code-Vocab Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to
> implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make styre's documentation (GitHub repo + styre.dev site) truthfully describe the shipped
unified pause/resume model and new CLI surface, after first fixing the one runtime surface that still
emits retired vocabulary (the notifier label).

**Architecture:** Code-first. Phase 0 fixes the live discrepancies (notifier labels, plus the
`run`/resume CLI output strings that still print "Parked:/Dump:" and one now-wrong resume-refused
command) + the stale `--help`/comment text in the `styre` repo, TDD where tested. Phase 1 updates the
`styre` repo docs to match code.
Phase 2 mirrors the changes to the separate `styre.dev` Astro/Starlight repo (its own worktree,
branch, and PR). Phases 0+1 land on branch `docs/eng-388-pause-resume-docs` (PR #1); Phase 2 lands on
a `styre.dev` branch (PR #2).

**Tech Stack:** Bun + TypeScript (styre), biome (lint), tsc (typecheck); Astro + Starlight
(styre.dev). Markdown docs.

## Global Constraints

The **canonical vocabulary block** below is the single source of truth every task applies. Copy
values verbatim; do not paraphrase enum values or exit numbers.

**Terminal outcomes:** `pr-ready | done | paused | abandoned`.
- `paused` carries an internal `reason`: `budget | needs_you | interrupted`.
- `abandoned` has **no producer in styre** (reserved terminal; not currently emitted by any run).
  Cleaning a run's disk state is NOT abandoning the ticket.

**Exit-code table (canonical — reproduce these exact semantics):**
- `0` — `done` / `pr-ready`
- `1` — `abandoned` (reserved; **not currently emitted by any run**)
- `64` — usage (CLI misuse)
- `65` — resume refused (branch HEAD moved without `--accept-head`, *or* concurrent-resume lock
  contention)
- `69` — toolchain missing
- `70` — internal
- `75` — **any** `paused` (every reason), **and `styre clean <ident>` on a live run**
- `78` — config

**Retired words** (`blocked | parked | escalated | no-progress`) must NOT appear as **terminal
outcomes / exit-code meanings / user-facing pause states** in any updated doc. They MAY remain,
UNCHANGED and described as internal, ONLY where they name:
- an `event_log.kind` DB enum value (`escalated`/`parked`) — internal wire name;
- the `dispatch.outcome` value `parked` — internal telemetry granularity;
- an internal routing/decision verb "escalate" (checks/review/arbiter/failure-policy, control-loop
  §8 Loopback Atlas);
- a `work_unit.status` value (`blocked`) or an external `IssueState` value (`blocked`);
- a config enum value (`onPlanDefect:"escalate"`, `notify:"escalations"`);
- append-only history (`CHANGELOG.md`, `docs/architecture/brainstorm.md`) — **do not edit these**.

**CLI surface to document** (see the brainstorm §0 for full behavior):
`styre run <ticket>` (refuses if a checkpoint exists → points at `--resume`/`--fresh`);
`styre run --resume <ident>`; `styre run <ident> --fresh`; `--accept-head`; `--inspect`; `--in-place`;
`styre ls`; `styre clean <ident>`; `styre clean --all`; `styre clean <ident> --purge`.

**`styre clean` canonical semantics** (reuse verbatim where a doc describes clean):
- `styre clean <ident>` — reap ONE effort's disk artifacts (worktree + checkpoint). **No
  ticket-status change.** Refuses a live run (**exit 75**).
- `styre clean --all` — reap only provably-finished (`pr-ready`/`done`) efforts for the current
  project; skips resumable pauses and live runs.
- `styre clean <ident> --purge` — additionally delete the local + remote branch (closes the PR).
  Opt-in, single-ident (rejects `--all --purge`, exit 64), silent when there is no branch/PR. On the
  repo's **default branch** it **skips the branch/PR deletion but still reaps disk state** (stderr
  warning, exits 0).

**`styre ls` canonical output** (three sections, in order): `Paused/resumable efforts:` (each row
followed by `    resume: styre run --resume <ident> --slug <slug>`); `Finished leftovers (reap per
project with \`styre clean --all\`):` (slug-qualified rows); `Running:`. Live efforts never appear as
reapable.

**The checkpoint IS the live location:** a run journals directly to
`~/.local/state/styre/<slug>/<ident>/run.db`; a crash leaves it there (resumable). There is **no
`--after-fix` flag** — resume always consumes the pending signal. **No merge-state / age
"staleness" heuristic.**

**Reference:** brainstorm `docs/brainstorms/2026-07-29-eng-388-pause-resume-docs-audit-design.md`;
authoritative code `src/cli/outcome.ts`, `src/cli/errors.ts`, `src/cli/ls.ts`, `src/cli/clean.ts`,
`src/cli/park.ts`, `src/cli/run.ts`.

**Gates:** styre code tasks — `bun test <file>` (TDD), plus `bun run lint`, `bun run typecheck`,
`bun run build` before commit. styre doc tasks — the file's edits + a retired-vocab grep check.
styre.dev tasks — `bun run build` (astro) green.

---

# PHASE 0 — Fix code first (styre repo, branch `docs/eng-388-pause-resume-docs`)

### Task 1: Notifier labels emit new pause vocabulary

The Slack/notifier label is derived from `event_log.kind` and rendered verbatim
(`src/integrations/adapters/slack.ts:26-27`). Today a paused run notifies with the retired
`"escalated"` / `"parked"` labels while the CLI says "Paused…". Map the event kind to a new
user-facing label. **Keep the `event_log.kind` DB enum unchanged** (internal wire name — no schema
change, no migration).

**Files:**
- Modify: `src/daemon/notify.ts` (`eventDecision`, ~L17-21)
- Test: `test/daemon/notify-sweep.test.ts` (asserts labels), `test/daemon/notify-outbox.test.ts`
  (constructs `event:"escalated"` fixtures — verify: these build a `NotificationMessage` directly and
  do not exercise `eventDecision`; they need NO change. Confirm during the task.)

**Interfaces:**
- Consumes: `EventLogRow.kind` (`"escalated" | "parked" | ...`), `NotifySeverity`.
- Produces: `eventDecision(e, policy)` returns `{ severity, label }` where for
  `kind:"escalated"` → `label:"paused — needs you"`, `kind:"parked"` → `label:"paused — out of
  budget"`. Severity stays `"high"` for both.

- [ ] **Step 1: Update the failing assertions.** In `test/daemon/notify-sweep.test.ts`, the
  `"escalated"` label is asserted in **three** places — update ALL three (change only the expected
  label string, keep the `kind:"escalated"` event fixtures and everything else):
  - **L31** `expect(evs).toEqual(["escalated"])` → `expect(evs).toEqual(["paused — needs you"])`
  - **L40** `expect(evs).toEqual(["escalated", "implement→verify", "loopback"])`
    → `expect(evs).toEqual(["paused — needs you", "implement→verify", "loopback"])`
  - **L100-104** the filter `msg.event === "escalated"` (asserted `.toBe(1)`) →
    `msg.event === "paused — needs you"`

- [ ] **Step 2: Run the test, watch it fail.**

Run: `bun test test/daemon/notify-sweep.test.ts`
Expected: FAIL — actual label is still `"escalated"` at all three assertions.

- [ ] **Step 3: Implement the mapping.** In `src/daemon/notify.ts`, change the two labels in
  `eventDecision` (keep severity `"high"`):

```ts
    case "escalated":
      return { severity: "high", label: "paused — needs you" };
    case "parked":
      return { severity: "high", label: "paused — out of budget" };
```

Update the function's doc-comment above `eventDecision`/`terminalDecision` so any prose there uses
"pause" not "escalated/parked" for the user-facing meaning (the comment may still name the
`event_log.kind` values as the internal wire names being mapped).

- [ ] **Step 4: Run tests, watch them pass.**

Run: `bun test test/daemon/notify-sweep.test.ts test/daemon/notify-outbox.test.ts test/integrations/notifier.test.ts`
Expected: PASS. Note: `notify-outbox.test.ts` and `notifier.test.ts` do NOT change — they construct
`NotificationMessage` objects directly (`event:"escalated"`) and bypass `eventDecision`, and
`notify-outbox.test.ts:44` filters on `event_log.kind === "escalated"` (the unchanged DB enum). Only
`notify-sweep.test.ts` exercises the mapping. If either other file fails, something unexpected changed —
stop and investigate rather than editing fixtures.

- [ ] **Step 5: Full gates + commit.**

Run: `bun test && bun run lint && bun run typecheck && bun run build`
Expected: all green.

```bash
git add src/daemon/notify.ts test/daemon/notify-sweep.test.ts
git commit -m "fix(notify): pause-vocabulary labels for paused-run notifications (ENG-388)"
```

---

### Task 2: Retire stale vocab from ALL live CLI output strings + help + comments

Beyond notifications, several `styre run`/resume paths still **print** retired vocab to the operator
(stderr), and one prints a now-incorrect command. Rename the user-facing wording to the canonical
pause/checkpoint vocabulary. **Vocabulary + one command-correctness fix only — do NOT change any
control flow, the `dumpPark` copy logic, or any internal `event_log.kind`/`dispatch.outcome` value.**

Mostly mechanical, but two of these strings may be asserted by tests — so this task IS test-gated:
before editing, grep `test/` for the phrases; update any asserting test alongside the code; then run
the full suite.

**Files:**
- Modify: `src/cli/run.ts` (budget-pause message L337-341; `--resume` help L102; `--db` help L101;
  comments L46-47), `src/cli/park.ts` (L126, L266, L379), `src/cli/errors.ts` (L5, L8, the `TEMPFAIL`
  member comment), `src/cli/outcome.ts` (header prose)
- Possibly modify: any `test/**` file asserting these exact strings (discovered in Step 1)

- [ ] **Step 1: Inventory test assertions on these strings.**

Run: `grep -rniE "parked:|parked again|overwriting parked|parked attempt|to start fresh|Dump:" test`
For any hit that asserts a produced string (not an internal `dispatch.outcome`/`event_log`/
`failure_bucket` value), note it — its expectation is updated in the same step it changes below.

- [ ] **Step 2: Fix `run.ts` budget-pause output (L337-341).** Rename the printed wording (keep the
  interpolated values and structure):

```ts
        console.error(
          `Paused — out of budget: ${out.park.cause}${out.park.resetAt ? ` (resets ${out.park.resetAt})` : ""}.\n` +
            `Resume with: styre run --resume ${ident} ${args.profile ? `--profile ${args.profile}` : `--slug ${slug}`}\n` +
            `Checkpoint: ${dir}`,
        );
```

- [ ] **Step 3: Fix `park.ts` output strings.**
  - **L126** `overwriting parked run ${prior} with ${currentRunId} for ${ident}` →
    `overwriting paused run ${prior} with ${currentRunId} for ${ident}`.
  - **L266** resume-refused message: `since the parked attempt` → `since the run paused`; and the
    hint `'styre run ${ticket.ident}' to start fresh` → **`'styre run ${ticket.ident} --fresh' to
    start fresh`** (a bare `styre run` now REFUSES when a checkpoint exists — `run.ts:263-268`).
  - **L379** `Parked again: ${result.park.cause}. Dump: ${dir}` →
    `Paused again — out of budget: ${result.park.cause}. Checkpoint: ${dir}`.

- [ ] **Step 4: Fix the `--help` strings in `run.ts`.**
  - **L102** `--resume`: `"Resume a paused run by ticket ident"` (was "parked run").
  - **L101** `--db`: `"DB path (default: the run's checkpoint at ~/.local/state/styre/<slug>/<ident>/run.db)"`
    (was "a fresh per-run temp DB" — stale; the checkpoint is the live location).

- [ ] **Step 5: Fix the misleading comments** (no code change):
  - `run.ts:46-47` exit-code comment → canonical semantics (`75` = any paused; `1` = abandoned reserved).
  - `errors.ts:5` "shared across all four subcommands" → "six subcommands (`clean, ls, migrate,
    notify, run, setup`)".
  - `errors.ts:8` (`OPERATIONAL` "blocked / no-progress") → "abandoned (reserved terminal; ran fine,
    no success)".
  - `errors.ts` `TEMPFAIL` comment ("parked … escalated") → "any paused run (budget / needs_you /
    interrupted); also clean-on-live".
  - `outcome.ts` header prose → remove any residual old-model phrasing.

- [ ] **Step 6: Verify no live retired vocab remains** (case-insensitive, includes `park.ts`):

Run: `grep -rniE "parked|escalated|no-progress|dump:" src/cli/run.ts src/cli/park.ts src/cli/errors.ts src/cli/outcome.ts`
Expected: the only surviving hits are comments/identifiers that explicitly reference internal wire
names (`event_log.kind`, `dispatch.outcome`, the `dumpPark`/`parkDir` function names, the
`--slug`/park-dir path helpers) — never a user-facing printed string or `description:`.

- [ ] **Step 7: Gates + commit.**

Run: `bun test && bun run lint && bun run typecheck && bun run build`
Expected: all green.

```bash
git add src/cli/run.ts src/cli/park.ts src/cli/errors.ts src/cli/outcome.ts
git commit -m "fix(cli): pause/checkpoint wording in run/resume output; --fresh in resume hint (ENG-388)"
```

---

# PHASE 1 — styre repo docs (same branch)

> Doc tasks are prose edits. Each: apply the anchored changes, run the retired-vocab grep, commit.
> No `bun test` needed for markdown-only tasks, but run
> `grep -nE "parked|escalated|no-progress|blocked" <file>` after editing and confirm every remaining
> hit is an intentional internal/wire/history reference per Global Constraints.

### Task 3: `runtime-parameters.md` — canonical CLI reference (primary target)

**Files:** Modify `docs/architecture/runtime-parameters.md`

- [ ] **Step 1: Rewrite the exit-code table (L122-146)** to exactly the canonical exit-code table in
  Global Constraints — 0/1/64/65/69/70/75/78 with those meanings. Explicitly:
  - `1` — "abandoned (reserved terminal; not currently emitted by any run)".
  - `65` — "resume refused: branch HEAD moved (without `--accept-head`) or concurrent-resume lock
    contention".
  - `75` — "any paused run (budget / needs_you / interrupted); also `styre clean <ident>` on a live
    run".
  - Remove all `parked`/`escalated`/`blocked`/`no-progress` outcome wording (L132/L134/L137/L143-146).
- [ ] **Step 2: Rewrite the `styre run` flag table (L31-44)** — fix `--resume` "parked"→"paused"
  (L42); add rows for `--fresh` ("Discard an existing checkpoint for this ticket and reconcile the
  worktree, then start over") and `--in-place`; add a note on the positional `ticket` that a fresh
  `styre run <ticket>` **refuses when a checkpoint already exists**, pointing at `--resume`/`--fresh`.
- [ ] **Step 3: Add a `styre ls` section** using the canonical `styre ls` output block.
- [ ] **Step 4: Add a `styre clean` section** using the canonical `styre clean` semantics block
  (`<ident>`, `--all`, `--purge`), including "clean ≠ abandon the ticket" and "no
  merge-state/age staleness heuristic".
- [ ] **Step 5: Fix the park→checkpoint prose (L61-71, L165)** — a run journals directly to the
  checkpoint (live location); resume via `styre run --resume`; `XDG_STATE_HOME` holds the checkpoint,
  not "park dumps".
- [ ] **Step 6: Grep-verify + commit.**

Run: `grep -nE "parked|escalated|no-progress" docs/architecture/runtime-parameters.md`
Expected: no outcome/exit-code hits remain.

```bash
git add docs/architecture/runtime-parameters.md
git commit -m "docs(runtime-parameters): pause/resume outcomes, exit codes, styre ls/clean (ENG-388)"
```

---

### Task 4: `execution-model.md` — narrative outcome model

**Files:** Modify `docs/architecture/execution-model.md`

- [ ] **Step 1:** Rewrite the outcome/interruption section (L193-212): "parks / dumps … exits 75" →
  "pauses (reason: budget | needs_you | interrupted); the checkpoint is the live journal at
  `~/.local/state/styre/<slug>/<ident>/run.db`; exit 75; resume with `styre run --resume <ident>`".
  Add `--fresh` (discard + reconcile) and mention `styre ls`/`styre clean` for listing/reaping.
- [ ] **Step 2:** Fix L141-142 "parked", L167 "escalate", L198 "parks", and the L31/L66-73 outcome
  framing → canonical vocabulary. Keep crash-resume (L83-100) — it already matches the live-checkpoint
  model; just ensure wording says "paused/interrupted".
- [ ] **Step 3: Grep-verify + commit.**

Run: `grep -nE "parked|escalated|no-progress" docs/architecture/execution-model.md`

```bash
git add docs/architecture/execution-model.md
git commit -m "docs(execution-model): pause/resume outcome narrative (ENG-388)"
```

---

### Task 5: `minimal-loop.md` — §5 inbox + budget table

**Files:** Modify `docs/architecture/minimal-loop.md`

- [ ] **Step 1:** §5 needs-you inbox (real content at **L206-230**; `--after-fix` at **L209 / L228**):
  replace the OSS block so it reads: run exits 75 and **pauses** (reason `needs_you`); resume with
  `styre run --resume <ticket> --profile <p>` (+ `--accept-head`, `--inspect`); discard + restart with
  `styre run <ticket> --fresh`. **Remove `--after-fix`** (no such flag; resume consumes the signal).
  Note the fresh-run **refuse-on-existing-checkpoint** behavior. L230 `styre abandon`→`status='abandoned'`
  may stay as the commercial-side note but frame `abandoned` as human/tracker-driven, no styre producer.
- [ ] **Step 2:** Budget/outcome tables: L61 `blocked`, L131-152 `escalated{reason}`, L189-198
  `no-progress`/escalate → canonical vocabulary (these are the terminal-emission rows → `paused`
  +reason). The routing verb "escalate" as an internal route (L53, L117) may stay if clearly internal.
- [ ] **Step 3: Grep-verify + commit.**

Run: `grep -nE "no-progress|parked|after-fix" docs/architecture/minimal-loop.md`
Expected: no `no-progress`/`parked`/`after-fix` hits.

```bash
git add docs/architecture/minimal-loop.md
git commit -m "docs(minimal-loop): unified pause/resume inbox, drop --after-fix (ENG-388)"
```

---

### Task 6: `control-loop.md` — terminal-outcome language + park lifecycle

Large file. Change ONLY the **terminal-outcome / park-lifecycle** language; leave the ~53 §8 Loopback
Atlas "escalate" **routing-verb** uses intact (internal route, not an outcome — per Global Constraints).

**Files:** Modify `docs/architecture/control-loop.md`

- [ ] **Step 1:** L109-111 route table: `'wait'→park` and the `'blocked' → structural dead-end` →
  describe as the run **pausing** (`paused`, reason `budget`/`needs_you`); the `blocked` resolver route
  now routes through `pauseTicket` (reason `needs_you`).
- [ ] **Step 2:** L446-450 "a no-progress escalation" → `paused (needs_you)`.
- [ ] **Step 3:** L666-667 and the post-escalation lifecycle L682-713: "the ticket parks
  (`status='waiting'`) … parks at exit 75 … resume/fix/abandon" → "the run **pauses**
  (`status='waiting'`, exit 75), resumable with `styre run --resume`; `--fresh` to discard". Frame the
  "fix by hand then resume" path as resume-consumes-signal (no `--after-fix`).
- [ ] **Step 4:** L755-756 dispatch outcome `parked` + `event_log.kind='parked'` — **keep**, but add
  a half-sentence that these are internal wire names distinct from the user-facing `paused` outcome.
- [ ] **Step 5: Grep-verify + commit.** Confirm remaining `escalate` hits are §8 routing-verb or
  clearly-internal; no terminal-outcome `parked`/`no-progress` remain.

Run: `grep -nE "no-progress|parks|parked" docs/architecture/control-loop.md`

```bash
git add docs/architecture/control-loop.md
git commit -m "docs(control-loop): pause/resume terminal outcomes + lifecycle (ENG-388)"
```

---

### Task 7: `conventions.md` + `build-operations.md` + `glossary.md` — checkpoint / clean vocab

**Files:** Modify `docs/architecture/conventions.md`, `docs/architecture/build-operations.md`,
`docs/architecture/glossary.md`

- [ ] **Step 1 (`conventions.md`):** Rename the §"Park dumps" section (L101-106) to "Checkpoints"; a
  run journals directly to `$XDG_STATE_HOME/styre/<slug>/<ident>/` (`run.db` + WAL sidecar +
  transcript); resume reads it back; `styre clean <ident>` / `--all` / `--purge` reap exactly this
  checkpoint dir. Fix L17/L38/L50 "park dump/dir" wording.
- [ ] **Step 2 (`build-operations.md`):** L62-64 "Park on session interruption (exit 75)" → "Pause on
  interruption/budget/needs-you (exit 75)"; the run pauses to the checkpoint and is resumed with
  `styre run --resume`; remove `--after-fix` (L77). Add `styre ls`/`styre clean` to the operator
  commands where run-modes are listed.
- [ ] **Step 3 (`glossary.md`):** Rewrite the needs-you-inbox entry (L57-66): the run **pauses**
  (reason `needs_you`), exit 75, resumable; drop "resume-after-fix". Add glossary entries for the
  terminal-outcome vocabulary (`paused`+reason, `abandoned` reserved) and for `styre ls` / `styre clean`.
- [ ] **Step 4: Grep-verify + commit.**

Run: `grep -nE "park dump|after-fix|no-progress" docs/architecture/conventions.md docs/architecture/build-operations.md docs/architecture/glossary.md`

```bash
git add docs/architecture/conventions.md docs/architecture/build-operations.md docs/architecture/glossary.md
git commit -m "docs(arch): checkpoint/pause vocabulary + styre ls/clean (ENG-388)"
```

---

### Task 8: `configuration.md` + `telemetry-export.md` — config wording + telemetry outcome set

**Files:** Modify `docs/architecture/configuration.md`, `docs/architecture/telemetry-export.md`

- [ ] **Step 1 (`configuration.md`):** L35 notify verbosity — keep the config **value**
  `"escalations"` but describe it as "notify only on pause-class events"; L161 "park dir" →
  "checkpoint dir". Leave `onPlanDefect:"escalate"` value unchanged (describe as a routing knob).
- [ ] **Step 2 (`telemetry-export.md`):** §3.4 `summary.outcome` (L176) — document the new value set
  `pr-ready | done | paused | abandoned` and the paused `reason`. For `EventKind`/`event_log.kind`
  (L74-85, L274-279) and `escalation_count`/`escalation_reasons` (L198-199): **keep the names**, add a
  one-line note that `escalated`/`parked` are internal event-kind wire names distinct from the
  user-facing `paused` outcome. Fix L41-46 "parked-then-resumed" prose to "paused-then-resumed".
- [ ] **Step 3: Grep-verify + commit.** Remaining `escalated`/`parked` hits must be the explicitly
  internal `event_log.kind` references.

Run: `grep -nE "parked|escalated" docs/architecture/configuration.md docs/architecture/telemetry-export.md`

```bash
git add docs/architecture/configuration.md docs/architecture/telemetry-export.md
git commit -m "docs(arch): telemetry outcome set + config pause wording (ENG-388)"
```

---

### Task 9: `README.md` + `CLAUDE.md` — front-door exit table + commands

**Files:** Modify `README.md`, `CLAUDE.md`

- [ ] **Step 1 (`README.md`):** Rewrite the exit-code table (L107-122) to the canonical table
  (fix L114 `1`→abandoned+reserved-note; L116/L119 park/escalated → resume-refused / any-paused).
  Enumerate the terminal outcome set `pr-ready | done | paused | abandoned` (+reason) near the
  outcomes/exit section.
- [ ] **Step 2 (`README.md`):** Commands section (L88-105): add `styre ls` and `styre clean`
  (`--all`/`--purge`) entries (canonical semantics, one-liners) and the `styre run`
  `--resume`/`--fresh`/`--accept-head`/`--inspect` flags (or a pointer to `runtime-parameters.md`).
- [ ] **Step 3 (`CLAUDE.md`):** L61 "four subcommands" → "six subcommands (`clean, ls, migrate,
  notify, run, setup`)"; L64-71 park/resume → paused(reason) + `--fresh`; add `ls`/`clean`. **Fix the
  pre-existing bug L72: `styre notify` without `--test` exits `64` (usage), not `2`.**
- [ ] **Step 4: Grep-verify + commit.**

Run: `grep -nE "parked|escalated|no-progress|exits .2." README.md CLAUDE.md`

```bash
git add README.md CLAUDE.md
git commit -m "docs: README + CLAUDE exit table, styre ls/clean, notify exit code fix (ENG-388)"
```

---

### Task 10: `projector.md` + `ticket-template.md` — light touch

**Files:** Modify `docs/architecture/projector.md`, `docs/architecture/ticket-template.md`

- [ ] **Step 1 (`projector.md`):** §7 "Failure + escalation" (L86/L120/L129-135): the persistent
  projection-failure path is described as the run **pausing** (`paused`, reason `needs_you`); keep the
  internal "escalate" routing verb where it names a route. L69 already uses `abandoned` — leave.
- [ ] **Step 2 (`ticket-template.md`):** L174-178 "escalates to a human … the most common way a
  ticket ends in a human's lap" → "pauses for a human (`paused`, reason `needs_you`)". Mechanism
  description; keep it light.
- [ ] **Step 3: Grep-verify + commit.**

Run: `grep -nE "escalat|parked" docs/architecture/projector.md docs/architecture/ticket-template.md`

```bash
git add docs/architecture/projector.md docs/architecture/ticket-template.md
git commit -m "docs(arch): pause wording in projector + ticket-template (ENG-388)"
```

---

# PHASE 2 — styre.dev site (separate repo, separate branch + PR)

> **Controller setup before Task 11:** Phase 2 runs in `/Users/rajatgoyal/code/styre.dev` (repo
> `Twinning-Labs/styre.dev`). Create a worktree/branch off its `origin/main`
> (`git -C /Users/rajatgoyal/code/styre.dev fetch origin && git -C /Users/rajatgoyal/code/styre.dev
> worktree add .claude/worktrees/eng-388 -b docs/eng-388-pause-resume origin/main`). All Phase 2
> tasks run and commit inside that worktree. Gate each with `bun run build` (astro). This produces
> PR #2. Content mirrors Phase 1; reuse the canonical blocks.

### Task 11: styre.dev `recovery.md` — major rewrite

**Files:** Modify `src/content/docs/docs/recovery.md`

- [ ] **Step 1:** Replace the Parked/Escalated/Dead-end trichotomy (L23-52, L88-101, L147-151) with:
  a run **pauses** (one state) with a `reason` (`budget | needs_you | interrupted`); **every pause is
  resumable** because the checkpoint is the live journal; `abandoned` (exit 1) is a reserved terminal
  with no styre producer (relabel the "Dead ends / Exit 1" section).
- [ ] **Step 2:** Fix the resume/restart commands: resume = `styre run --resume <ident>`; a fresh
  restart is `styre run <ident> --fresh` (a bare `styre run <ident>` now **refuses** when a checkpoint
  exists). Remove "escalated writes no dump / there is no `--resume` for an escalation" and the
  `--after-fix` advice (resume consumes the signal). Fix the state path to `<slug>/<ident>` and call
  it the live checkpoint, not a park-time dump.
- [ ] **Step 3:** Add a short "Listing & cleaning up" note cross-linking `styre ls` and `styre clean`,
  stating **clean ≠ abandon the ticket** and the clean-on-live→75 caveat.
- [ ] **Step 4: Build-gate + commit.**

Run: `bun run build`

```bash
git add src/content/docs/docs/recovery.md
git commit -m "docs(recovery): unified pause/resume model (ENG-388)"
```

---

### Task 12: styre.dev `exit-codes.md` — major rewrite

**Files:** Modify `src/content/docs/docs/exit-codes.md`

- [ ] **Step 1:** Rewrite rows to the canonical exit-code table: `0` done/pr-ready; `1` abandoned
  (reserved, not currently emitted); `65` resume refused (HEAD moved or lock contention — fix L27
  "since the run parked"); `75` **any paused** (all resumable), **and clean-on-live**. Keep
  `64/69/70/78`.
- [ ] **Step 2:** Rewrite the "Which ones matter to a scheduler" / parked-vs-escalated section (L30,
  L35-46): there is no parked/escalated split — `75` is one resumable pause state; drop
  "escalated writes no dump / `--resume` fails".
- [ ] **Step 3: Build-gate + commit.**

Run: `bun run build`

```bash
git add src/content/docs/docs/exit-codes.md
git commit -m "docs(exit-codes): unified paused/abandoned exit-code semantics (ENG-388)"
```

---

### Task 13: styre.dev `cli.md` — add ls/clean, fix run

**Files:** Modify `src/content/docs/docs/cli.md`

- [ ] **Step 1:** Fix `--resume` "parked"→"paused" (L43); correct `--db`/state-of-record to the live
  checkpoint (`~/.local/state/styre/<slug>/<ident>/run.db`, not a throwaway temp DB) (L42); bump
  "four commands" (L16) to six.
- [ ] **Step 2:** Under `styre run`, document the **refuse-on-existing-checkpoint** behavior and add
  `--fresh` (and `--in-place` if the page lists run flags).
- [ ] **Step 3:** Add `styre ls` and `styre clean` (`<ident>` / `--all` / `--purge`) sections using
  the canonical blocks.
- [ ] **Step 4: Build-gate + commit.**

Run: `bun run build`

```bash
git add src/content/docs/docs/cli.md
git commit -m "docs(cli): document styre ls/clean, run --fresh + checkpoint refusal (ENG-388)"
```

---

### Task 14: styre.dev `the-run-loop.md` + `files-and-paths.md` + `home.ts` + `configuration.md`

**Files:** Modify `src/content/docs/docs/the-run-loop.md`, `src/content/docs/docs/files-and-paths.md`,
`src/config/home.ts`, `src/content/docs/docs/configuration.md`

- [ ] **Step 1 (`the-run-loop.md`):** L105 "parks" → "pauses"; reconcile the bounded-stop table
  (L91-106) with `paused`(+reason)/`abandoned`.
- [ ] **Step 2 (`files-and-paths.md`):** L39 "a parked run's saved state" → the **live checkpoint**
  (`<slug>/<ident>/run.db`) for any run; reconcile the "throwaway per-run temp DB" claim (L42/L50) with
  live journaling; verify whether `transcript.json` is still listed (L44) and correct if needed.
- [ ] **Step 3 (`home.ts`):** L236 user-visible copy "Styre escalates to you…" → pause wording
  (e.g. "Styre pauses and hands back to you once the retries are spent…").
- [ ] **Step 4 (`configuration.md`):** Correct the "five internal states incl. blocked" wording
  (L99/L111): the internal **ticket** status enum is `active | waiting | abandoned | done`; `blocked`
  is a **work-unit**/tracker-projection state, not an internal ticket state. Keep the
  `escalations`/`escalate` config **values**; describe them accurately.
- [ ] **Step 5: Build-gate + commit.**

Run: `bun run build`

```bash
git add src/content/docs/docs/the-run-loop.md src/content/docs/docs/files-and-paths.md src/config/home.ts src/content/docs/docs/configuration.md
git commit -m "docs: run-loop, files-and-paths, landing copy, config states (ENG-388)"
```

---

## Self-review checklist (run after drafting, before execution)

- **Spec coverage:** every acceptance criterion maps to a task — retired outcomes removed (Tasks
  3-14); `ls`/`clean`/`--all`/`--purge` + `run --resume`/`--fresh`/`--inspect`/`--accept-head`
  documented (Tasks 3, 9, 13); "clean ≠ abandon" + "no staleness heuristic" stated (Tasks 3, 11);
  styre.dev updated (Phase 2); the live code discrepancy fixed first (Tasks 1-2).
- **Two-repo boundary:** Phase 0-1 = `styre` PR; Phase 2 = `styre.dev` PR (own worktree, `astro
  build` gate).
- **Do-not-touch:** `CHANGELOG.md`, `docs/architecture/brainstorm.md`, and all internal wire
  enums/config values remain unchanged.

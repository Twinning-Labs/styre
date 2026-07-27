# Unified pause/resume model — one `paused` state, one recovery path

**Date:** 2026-07-24 (rev 3.1: 2026-07-25)
**Status:** Draft — rev 3.1 (Option 2: human-driven recovery; three adversarial-review rounds folded in)
**Related:** ENG-331 (dump+resume escalated), ENG-353 (escalated outcome), ENG-332 (provision-first)

### Revision history

- **rev 1** — one `paused` state + `reason`; single resume path.
- **rev 2** — "Option A": normalize every halt by *raising a signal and leaving a re-armable step*,
  bounded by an automatic `exhausted` ceiling.
- **rev 3** — a second code-grounded review proved rev 2's mechanism unsound for the two
  dead-ends it targeted: `blocked`/`no-progress` run **no step**, so there is nothing to re-arm and
  the per-step attempt counter never climbs — the `exhausted` ceiling was unreachable and would have
  produced an unbounded resume-limbo. rev 3 adopts **Option 2 (human-driven recovery)**: all halts
  become `paused` and *always wait for a human* — matching how styre already behaves (even a failed
  step at its retry cap escalates to a person, it never auto-abandons). The mechanism is corrected:
  a **step-independent pause primitive** + a resume that **re-arms a failed step if one exists, else
  re-plans**. No automatic give-up; `abandoned` is a human/explicit decision. Worktree removal is
  **liveness-gated** (not a path heuristic), and the DB inserts are **find-or-create** (not
  `INSERT OR IGNORE`). Review-driven corrections are marked ✎.
- **rev 3.1 (this)** — a third review confirmed the load-bearing mechanisms are buildable
  (step-independent `pauseTicket`, no-step re-plan, find-or-create, failed-step re-run). Folded its
  two substantive gaps — the ticket-1/ticket-2 lock-home coupling (ticket 1 is now **prunable-only**
  and needs no lock; the lock is a ticket-2 artifact) and **WAL-sidecar teardown** on `--fresh` —
  tightened `pauseTicket` to `needs_you`-only, and fixed telemetry line cites.

---

## 1. Problem

`styre run` has six terminal outcomes (`src/daemon/run-ticket.ts:19`):
`pr-ready | done | blocked | no-progress | parked | escalated`. Four are *halts that leave
recoverable work behind*, modeled inconsistently:

- **Exit codes disagree:** `parked`/`escalated` → `75`; `blocked`/`no-progress` → `1`
  (`src/cli/outcome.ts:24-36`).
- **Persistence disagrees:** only `parked` dumps its journal to a durable location (`finishRunResult`,
  `src/cli/park.ts:58-72` → `dumpPark`, `:104-136`). A fresh run journals to a throwaway temp DB
  (`src/cli/run.ts:199-203`), so a non-`parked` halt's journal is orphaned and GC'd.
- **Worktree cleanup disagrees:** the only removal in the run flow is `released:project`
  (`src/dispatch/handlers.ts:1830-1840`); the branch-freeing cleanup lives only in the resume path
  (`src/cli/park.ts:284-308`, "Fix B"). ✎ *(one out-of-flow removal also exists in the replay/dev
  harness, `src/dispatch/replay-harness.ts:101` — noted so "only two removals" isn't over-stated.)*
- **The halts differ in *shape*** — the crux this design confronts honestly:
  - `parked`: step left `running`, ticket → `waiting`, `parked` event (`src/daemon/advance.ts:157-179`).
  - `escalated`: step left `failed`, ticket → `waiting`, `human_resume` raised
    (`src/daemon/failure-policy.ts:74-88`, `advance.ts:91-100`); a failed step is re-run by `runStep`
    (`src/engine/step-journal.ts:85`).
  - `blocked`: **no step, no signal**, ticket stays `active` — the resolver found no unit to serve
    (`src/daemon/resolver.ts:128,146,224`, returned early at `advance.ts:87-88`).
  - `no-progress`: decided a layer up in `driveToTerminal` from `tick()`'s counters
    (`src/daemon/run-ticket.ts:128-135`) — **no step at all**, no access to per-step machinery.

Because `blocked`/`no-progress` leave *no step and no signal*, they need a step-independent way to
become a legible, resumable pause (§3.2) — and their "resume" means *re-plan*, not *retry a step*.

## 2. Ground truth

Two live reproductions in `~/code/styre-events` (`git worktree list`, 2026-07-24):

```
/private/var/folders/.../styre-wt-mF4zDH/STYRE-1   dceb20b [fix/STYRE-1]   prunable
/private/var/folders/.../styre-wt-PgBHlu/STYRE-7   a7dc517 [feat/STYRE-7]  prunable
```

- **STYRE-7** escalated; no dump (`~/.local/state/styre/styre-events/` has no `STYRE-7/`). Its
  worktree survives holding `feat/STYRE-7`; re-running calls `git worktree add -B feat/STYRE-7`
  (`worktree.ts:49`) and git refuses — the branch is still used by the leftover worktree. **This is
  the "worktree already exists" error.**
- **STYRE-1** parked; dump survives only because `--db` was passed (luck). Worktree also leaked.

---

## 3. The model

**One non-terminal stop state: `paused`.** It replaces `parked`, `escalated`, `blocked`, and
`no-progress` as user-visible outcomes. Every `paused` run has a durable checkpoint, **always waits
for a human**, and is resumable. A separate terminal, **`abandoned`**, is reached only by an explicit
human decision (§3.5).

### 3.1 Guiding principle — human-driven, uniform (Option 2)

styre already embodies this: even a failed step that exhausts its retry cap **escalates to a person**
(`failure-policy.ts:72-89`) — it never unilaterally gives up. So the consistent model is: *every halt
waits for a human; the human decides when to continue and when to stop.* We add **no** automatic
"give up after N tries" — that would be a new special-case for the very outcomes we are unifying, and
it is unnecessary: resume is human-invoked and a no-change resume is a cheap, visible no-op (§3.4).

### 3.2 The reason enum + the step-independent pause primitive

| `reason` | Absorbs | Unblocker | Resume gate |
| --- | --- | --- | --- |
| `budget` | `parked` | time / credit reset | reset time reached |
| `needs_you` | `escalated`, `blocked`, `no-progress` | a human fixes, edits, or decides | `human_resume` consumed |
| `interrupted` | crash, SIGINT, power loss ✎ *(net-new — no current terminal; enabled by §6)* | nothing | none |

✎ **Three reasons, three pause entrypoints — but one `paused` checkpoint and one resume verb.** The
pause *side* is not a single code path; `reason` records which entrypoint fired:

- **`needs_you`** — a new step-independent **`pauseTicket(db, ticketId, detail)`** primitive: sets
  ticket → `waiting`, raises `human_resume` (no step reference required — the `signal` table has no
  step/dispatch column and `insertPending` needs only `ticketId`+`signalType`, `signal.ts:40-61`),
  records `detail`. Called by the step-escalate path (which *additionally* leaves its `failed` step,
  unchanged), the resolver's `blocked` branch (`advance.ts:87-88`), and `driveToTerminal`'s
  `no-progress` branch (`run-ticket.ts:128-135`) — both have `db`+`ticketId` in scope and no step.
  `pauseTicket` is the **`needs_you` mechanism only**: it must never be called for `budget`, whose
  resume gate never consumes `human_resume`, so the signal would instant-re-pause the next tick via
  `hasPendingHumanResume` (`run-ticket.ts:109`). (rev 2 wrongly routed these through the step-only
  `escalate()`, which needs a `stepKey`/`dispatchId` — `checks-gate-verdict.ts:35-53`.)
- **`budget`** — keeps the existing `ParkSignal` handler (`advance.ts:157-179`): `waiting` + a
  `parked` event, **no signal**.
- **`interrupted`** — the crash / live-location path (§6): no handler runs; the checkpoint is already
  on disk.

Reaching `waiting` (either entrypoint) is load-bearing: it removes the ticket from `v_ready_tickets`
(`schema.sql:522-530`, gated on `status='active'`), closing the latent daemon re-pick loop a
`blocked`-but-`active` ticket would otherwise sit in. ✎ *Once `blocked` routes through `pauseTicket`,
`hasPendingHumanResume` (`run-ticket.ts:109`) intercepts before the old `r.blocked` terminal branch
(`:126`), making that branch + `tick`'s `blocked` flag dead code — a cleanup for ticket 3.*

### 3.3 Resume mechanism — re-arm if there's a step, else re-plan

At resume, `reason` gates *permission only*; the mechanism is uniform:
- **consume the gate** (§3.2 table), set ticket `active`;
- **`recover()`** resets an interrupted *`running`* step → `pending` (`src/daemon/recover.ts:22-33`);
  a *`failed`* step is re-run directly by `runStep` (`step-journal.ts:85`) — ✎ `recover()` does **not**
  touch `failed` steps;
- **`driveToTerminal` continues** — if there was a failed/interrupted step it re-runs it; if there
  was **no** step (`blocked`/`no-progress`), the resolver simply re-plans against the current inputs.

So for the two dead-ends, "resume" means *re-plan from whatever the human changed*. Changed inputs →
work appears → run proceeds. Changed nothing → resolver returns `blocked` again → `pauseTicket` again
→ exit 75. That re-pause is a **cheap no-op, not a loop** (the ticket sits `waiting` between resumes;
nothing auto-resumes it).

### 3.4 The honest-note rule (carries the weight under Option 2)

With no automatic backstop, the `detail` string must state *what a resume actually requires*:
- external fix — `"needs you: composer not installed"` → fix, resume; the failed step re-runs.
- edit-then-replan — `"no next move on this plan as written"` → edit plan/code, **then** resume; the
  resolver re-plans.
- nothing actionable — see §3.5.

### 3.5 `abandoned` — human/explicit, with one honesty case

`abandoned` is an existing terminal ticket status (`schema.sql:104-105`:
`status IN ('active','waiting','abandoned','done')` — ✎ no schema change, and no new `exhausted`
value is introduced). It is reached in exactly two ways, **never** by an automatic resume counter:
1. **Explicit:** the operator runs `styre clean <ident>` (§5) on a pause they judge hopeless.
2. ✎ **Honesty-at-pause — DEFERRED (explicit-only in ENG-386).** The original idea: when styre has
   *nothing actionable to hand the human*, `pause` marks `abandoned` directly. But reliably judging
   "nothing actionable" needs the ENG-385 re-plan (both dead-ends look like "no next move" at pause
   time), so the ENG-383 build routes *both* `no-progress` cases to `paused(needs_you)` and leaves
   `abandoned` reachable only via the explicit `styre clean` route (ENG-386). The auto-honesty-abandon
   is deferred, not deleted — revisit once the resume re-plan (ENG-385) exists.

✎ *`no-progress` is two cases (`run-ticket.ts:128-135`): an **iteration-cap** (resume grants a fresh
tick budget) vs an **idle-stall** (resume re-idles). ENG-383 routes both to `paused(needs_you)` with
`detail` strings that distinguish them; neither auto-abandons (per the deferral above).*

`pr-ready` and `done` are unchanged and are **not** pauses.

---

## 4. Vocabulary & exit codes

- **Outcome enum:** `pr-ready | done | paused | abandoned` (+ internal `reason` on `paused`).
- **Exit codes** (`src/cli/errors.ts` `EXIT`, `src/cli/outcome.ts`):
  - `0` — `done` / `pr-ready`
  - `75` (TEMPFAIL) — **all** `paused`, every reason (fixes today's `blocked`/`no-progress` → `1`)
  - `1` (OPERATIONAL) — **`abandoned`** (a genuine terminal without success). ✎ This preserves the
    `1`-means-terminal / `75`-means-resumable split CI + `errorKindForExit` rely on
    (`src/cli/errors.ts:99-102`, `run.ts:39-41`); the line just moves to "terminal vs resumable."
  - `65` resume-refused (HEAD moved), `64` usage, `69` toolchain, `70` internal, `78` config —
    unchanged.
- ✎ **Telemetry is a breaking change, not a rename.** `failureBucket` hardcodes `parked →
  "parked-credits"` / `no-progress → "no-progress"` then keyword-classifies
  (`src/telemetry/analytics/properties.ts:61-76`); `outcome:"paused"` falls through every branch. The
  bucket map must be re-keyed on `reason`, and the change must also cover `runCompletedProperties`'
  `success` / `outcome` fields (`properties.ts:118,120`) and `ALLOWED_KEYS`.

---

## 5. CLI surface

Resume stays a **flag on `run`** (no new subcommand); a fresh `run` on an existing checkpoint
**refuses**.

| Command | Behavior |
| --- | --- |
| `styre run <ticket>` | Fresh run. **Refuses if a checkpoint exists**, pointing at `--resume` / `--fresh`. |
| `styre run --resume <ident>` | Resume the checkpoint (§3.3). |
| `styre run <ident> --fresh` | Discard the checkpoint + reconcile the worktree, then start over. |
| `styre run --resume <ident> --accept-head` | Resume though branch HEAD moved (exists, `park.ts:245-252`). |
| `styre run --resume <ident> --inspect` | Print resume diagnostics, no run (exists). |
| `styre ls` | List paused checkpoints: ticket, reason, age, honest-note, resume hint. *(separate)* |
| `styre clean <ident> \| --all` | Reap checkpoint + worktree; the operator's route to `abandoned`. ✎ Also reaps stale `pr-ready` worktrees (§10). *(separate)* |

No `--after-fix` flag — resume always consumes the pending signal, so it is implied (supersedes
`minimal-loop.md:183-185`).

---

## 6. Architecture: the checkpoint IS the live location

Orphaning's root cause is that the live journal and the durable checkpoint are different files,
reconciled only by a copy that only `parked` performs. Fix it at the root: **a fresh run journals
directly to `~/.local/state/styre/<slug>/<ident>/run.db`** (`parkDir`, `park.ts:75-77`) instead of a
temp DB (`run.ts:199-203`). Then the journal is always at the checkpoint (a crash leaves it there —
no signal handler), `pause` writes only a `reason`/`detail`/transcript sidecar, and `run <ticket>`
refusing = **testing whether `run.db` exists** in the checkpoint dir (not merely the dir — `styre ls`
or an empty scaffold could create the dir). `--db` override stays for tests.

✎ **WAL sidecars.** `openDb` sets `journal_mode = WAL` (`client.ts:6`), so a live-location run leaves
`run.db-wal`/`run.db-shm`; `wal_checkpoint(TRUNCATE)` runs only on graceful hand-off (`park.ts:114`),
so a crash leaves an un-checkpointed WAL. Resume is safe (a valid WAL auto-recovers on open), but
**`--fresh` must delete the whole checkpoint dir** (`run.db` + `-wal` + `-shm` + sidecar), never just
`run.db` — an orphaned `-wal` reattaching to a freshly-created `run.db` is a corruption hazard.

Two safeguards, both required (the review showed the first is not enough alone):

✎ **(a) A per-ticket run lock.** A lock/pid file in the checkpoint dir, held for the life of a run,
prevents two `styre run <same-ticket>` processes at once. This is the same liveness signal §7 needs to
reconcile worktrees safely, and it closes the concurrent-insert race the refuse-guard alone can't.
✎ *Because the lock lives in the checkpoint dir, it arrives **with live-location** — so it is a
ticket-2 artifact, and ticket 1's worktree fix must not depend on it (§7, §11).*

✎ **(b) Find-or-create inserts, not `INSERT OR IGNORE`.** `insertProject`/`insertTicket` are unguarded
plain INSERTs against UNIQUE columns (`project.ts:20`/`schema.sql:64`; `ticket.ts:41`/`schema.sql:122`)
and their `lastInsertRowid` return is load-bearing (`run-ticket.ts:150-164`). `INSERT OR IGNORE` does
**not** update `lastInsertRowid` on conflict → a stale/0 id flows downstream (worse than the crash).
So they become explicit get-or-create (`SELECT … WHERE (slug)` / `WHERE (project_id, ident)`, else
INSERT), returning the *real* id. This also surfaces — rather than masks — a genuine two-repos-same-slug
collision.

This deletes `dumpPark`'s copy machinery (`park.ts:104-136`) and the overwrite guard
(`park.ts:80-96,119-125`); the WAL checkpoint before hand-off is retained.

---

## 7. The pause/resume symmetry

```
 pause(reason, detail):                              # driveToTerminal / advance, on any halt
   1. journal already durable at checkpoint (§6); branch commits already in git
   2. pauseTicket(db, ticketId, reason, detail):     # step-independent (§3.2)
        ticket -> waiting; raise human_resume; record reason + honest detail (§3.4)
        (step-escalate path ALSO leaves its failed step; blocked/no-progress leave no step)
      -- OR, if nothing actionable (§3.5.2): mark ticket abandoned instead
   3. RETAIN the worktree (part of the checkpoint, not a leak)
   4. exit 75 "Paused (<reason>): <detail>. Resume: styre run --resume <ident>"
      (exit 1 "Abandoned (<detail>)" for the §3.5.2 case)

 resume(ident):
   1. locate checkpoint; absent -> clear error
   2. GATE (reason-dependent PERMISSION only):
        budget      -> reset time reached? else refuse (informative)
        needs_you   -> consume human_resume (markConsumed, src/db/repos/signal.ts:69)   # ✎ was :62
        interrupted -> no gate
      (all) HEAD-moved guard -> refuse unless --accept-head (park.ts:233-252)
   3. reconcileWorktree()                             # liveness-gated (below)
   4. recover() resets a RUNNING step -> pending; a FAILED step is re-run by runStep;
      a NO-STEP pause (blocked/no-progress) simply re-plans via the resolver
   5. setTicketStatus(active); driveToTerminal continues
   6. next terminal -> pause() again (cheap no-op if inputs unchanged), done, or abandoned

 --fresh(ident):
   locate -> (skip gate) -> reconcileWorktree() -> delete WHOLE checkpoint dir
            (run.db + -wal/-shm + sidecar, AFTER reconcile) -> fresh run
```

### `reconcileWorktree(...)` — liveness-gated, never a blind force-remove

Extract today's resume-only "Fix B" (`park.ts:284-308`) into one primitive (called by `--resume`,
`--fresh`, and — guarded — `ensureWorktree`). ✎ **rev 2's "styre-owned path OR prunable" gate was
unsafe:** every styre worktree root is `mkdtempSync(tmpdir(),"styre-wt-")` (`run.ts:222`, `park.ts:337`)
and the branch is deterministic `<prefix>/<ident>` (`branch.ts:3-12`), so two concurrent operations on
one ticket both produce `styre-wt-*` holders of the same branch — the path prefix proves *ownership,
not deadness*, and `git worktree remove --force` (`worktree.ts:75-77`) would destroy a **live** run's
worktree and its uncommitted work.

Correct gate — **prove staleness before removing**, in two phases matching §11 (✎ resolves the
ticket-1/ticket-2 lock-home coupling the third review flagged):
- **Ticket 1 (no lock yet) — prunable-only.** Free a holder only if git reports it **`prunable`**
  (its working dir is already gone — `git worktree list --porcelain`), then `git worktree prune`;
  removal is then unambiguously safe. This alone fixes the reported STYRE-7 leak (its worktrees are
  `prunable`, §2). Any **non-prunable** holder → **refuse** with a clear message (`styre clean`, or
  free it yourself). No live worktree is ever force-removed.
- **Ticket 2+ (lock exists) — full liveness.** A non-prunable holder whose owning process is provably
  **dead** (its checkpoint lock is stale / pid gone via `process.kill(pid, 0)` — the idiom already at
  `recover.ts:38`) is also freed; a holder that is **alive**, or **not styre-owned** (a human's own
  `git worktree add <branch>`), still → **refuse**, never force-remove.

When a holder is confirmed removable: `git worktree remove --force <holder>` + `git worktree prune` +
re-mint (`ensureWorktree`) + re-arm provision (`resetProvisionForResume`, `park.ts:149`).

✎ Both `git worktree list --porcelain` parsing (`prunable`, ticket 1) and lock-liveness
(`process.kill(pid,0)`, ticket 2) are **new** code — `worktree.ts` has neither today — so even the
prunable-only ticket 1 is more than "extract Fix B." In-place mode (`worktreePath === repoPath`) skips
removal as today (`park.ts:277-282,290`).

---

## 8. Back-compat & migration

- **Old parked dumps** (e.g. live STYRE-1) have no `reason` sidecar → default `reason = budget`.
  Verify STYRE-1 resumes under the new path.
- **Leaked worktrees from before this change** (STYRE-7, STYRE-1) hold no live lock → treated stale by
  the liveness gate → freed on first resume/`--fresh`; `styre clean` reaps the rest.
- ✎ **Telemetry migration** (§4) ships with the outcome rename, not after.
- `--after-fix`, if any caller uses it, becomes a removed flag / silent no-op.

---

## 9. Relationship to existing tickets

- **ENG-331** (Todo) — its intent (durable non-`done` checkpoint, resume an escalated dump, consume
  `human_resume`, `--inspect` from `failed`, `--db` trap) is a **subset**; its *mechanism* is
  superseded (live-location replaces dump-on-terminal; §6). Re-scope or close in favor of §11. Keep
  its two constraints: don't zero the attempt counter on resume, and don't widen `resetProvision`.
- **ENG-353** (Done) — the `escalated` word folds into `reason: needs_you`; its message work is reused.
- **ENG-332** (Done) — provision-first reduces the *frequency* of `needs_you`; orthogonal.

---

## 10. Non-goals

- ✎ **No automatic give-up / `exhausted` ceiling.** Rejected (rev 2): unreachable for `blocked`/
  `no-progress` (no step, no attempt increment — `resolver.ts:224`, `run-ticket.ts:128-135`), and a
  special-case for the outcomes we are unifying. `abandoned` is human/explicit (§3.5).
- ✎ **Automated resume is a future seam, not solved here.** If a fleet/cron ever resumes pauses
  unattended, the "resumed, re-paused identically, stop" judgment lives in the **resumer**, not the
  OSS core. Noted so it isn't mistaken for a gap.
- A `ParkCause` taxonomy raising a `ParkSignal` — rejected in ENG-331 (the throw escapes
  `advanceOneStep` uncaught, losing the checkpoint). `reason` is recorded by a graceful `pauseTicket`.
- ✎ **`pr-ready` worktree retention is unbounded** — a never-merged PR never reaches `released:project`
  (`handlers.ts:1830-1840`), leaking its worktree (the most common terminal). Retained at pause (branch
  legitimately alive for review), but **`styre clean` must reap stale `pr-ready` worktrees**
  (age/merged-state heuristic). Housekeeping-ticket scope.
- Auto-resume of `budget` pauses on a timer — the gate only *permits* resume; a human/cron invokes it.
- `--db` reuse of a populated DB (re-entry is via the checkpoint, one way).

---

## 11. Proposed ticket decomposition

1. **`reconcileWorktree` primitive — prunable-only gate (no lock).** Extract Fix B + add
   `git worktree list --porcelain` parsing to free `prunable` holders and refuse the rest (§7).
   **Directly fixes the reported STYRE-7 leak (its worktrees are `prunable`); ship first.** Needs no
   per-ticket lock — a leaked worktree has no live owner.
2. **Live-location checkpoint + per-ticket run lock + hardened refuse-guard + find-or-create inserts.**
   Journal to `parkDir` from the start; add the lock/pid in the checkpoint dir (§6a); get-or-create
   `insertProject`/`insertTicket`; `run <ticket>` refuses when `run.db` exists; `--fresh` deletes the
   whole checkpoint dir; delete `dumpPark` copy path (§6). Once the lock lands, upgrade §7's gate from
   prunable-only to full liveness. Root-causes ENG-331.
3. **`pauseTicket` primitive + route `blocked`/`no-progress` through it.** Step-independent
   `waiting`+`human_resume`+`detail` (`needs_you` only); the honest-note rule; the §3.5.2
   honesty-abandon (§3.2–3.5); retire the now-dead `r.blocked` terminal branch + `tick` `blocked`
   flag (`run-ticket.ts:126`).
4. **Outcome collapse + exit codes + telemetry.** `RunOutcome → pr-ready|done|paused|abandoned`
   (+`reason`); `paused → 75`, `abandoned → 1`; re-key telemetry on `reason` (§4). Ships **together
   with** the code that emits the new outcomes (3), not after. (Absorbs ENG-353's surface.)
5. **Unified resume gate** — one `resume()`: gate on `reason` → reconcile → re-arm-or-replan; consume
   `human_resume` for `needs_you`; `--fresh` (§3.3, §7). (Absorbs the rest of ENG-331.)
6. **Housekeeping** — `styre ls`, `styre clean` (incl. stale `pr-ready` reap). *(optional)*

Sequence: **1 → 2 → (3+4) → 5 → 6.** Ticket 1 (prunable-only) fixes the STYRE-7 leak with no lock
dependency; ticket 2 adds live-location + the per-ticket lock, which upgrades §7's gate to full
liveness; 3 and 4 land together (the outcome enum must gain its values with the code that emits them).

---

## 12. Open questions

- **`budget` resume** — block until reset time (proposed), or resume-and-immediately-re-pause?
- **§3.5.2 honesty-abandon threshold** — what precisely counts as "nothing actionable" for an
  idle-stall `no-progress`? (Proposed: no diagnosable cause *and* the resolver still yields no unit
  after a re-plan — i.e., prove it's opaque before abandoning; otherwise stay `paused`.)
- **`pr-ready` reap heuristic** — age-based, merged-state-based, or manual-only via `styre clean`?

# Unified pause/resume model — one `paused` state, one recovery path

**Date:** 2026-07-24
**Status:** Draft — rev 2 (Option A folded in; adversarial review findings incorporated)
**Related:** ENG-331 (dump+resume escalated), ENG-353 (escalated outcome), ENG-332 (provision-first)

### Revision note (rev 2)

A code-grounded adversarial review of rev 1 found that the headline model — "one `paused`, one
recovery path, `reason` is pure metadata" — did **not** hold as written: `blocked` and
`no-progress` raise no signal, leave the task `active`, and re-arm no step, so they could not share
`escalated`'s resume gate (they would re-pause on the same tick). Rev 2 adopts **Option A**: every
dead-end is *normalized at pause time* into the same waiting-for-a-human shape, which makes `reason`
genuinely metadata. All other confirmed findings (worktree force-remove hazard, telemetry break,
UNIQUE-crash reachability, `recover()` scope, `pr-ready` leak) are folded in and marked ✎.

---

## 1. Problem

`styre run` has six terminal outcomes (`src/daemon/run-ticket.ts:19`):
`pr-ready | done | blocked | no-progress | parked | escalated`. Four are *halts that leave
recoverable work behind*, but they are modeled inconsistently:

- **Exit codes disagree.** `parked`/`escalated` → `75`; `blocked`/`no-progress` → `1`
  (`src/cli/outcome.ts:24-36`).
- **Persistence disagrees.** Only `parked` dumps its journal to a durable location
  (`finishRunResult`, `src/cli/park.ts:58-72` → `dumpPark`, `:104-136`). A fresh run journals to a
  throwaway temp DB (`src/cli/run.ts:199-203`), so a non-`parked` halt's journal is orphaned and
  GC'd.
- **Worktree cleanup disagrees.** The only removal in the run flow is `released:project`
  (`src/dispatch/handlers.ts:1830-1840`); the branch-freeing cleanup lives only in the resume path
  (`src/cli/park.ts:284-308`, "Fix B"). ✎ *(one out-of-flow removal also exists in the replay/dev
  harness, `src/dispatch/replay-harness.ts:101` — not part of the run flow, noted so the "only two
  removals" claim isn't over-stated.)*
- **The halts themselves disagree in shape** — this is the crux Option A fixes:
  - `parked`: step left `running`, ticket → `waiting`, `parked` event (`src/daemon/advance.ts:157-179`).
  - `escalated`: step left `failed`, ticket → `waiting`, `human_resume` signal raised
    (`src/daemon/failure-policy.ts:75,97,120,155,245`; `src/daemon/advance.ts:91-99,181-186`).
  - `blocked`: **no state change, no signal**, ticket stays `active` (`src/daemon/loop.ts:34`,
    `src/daemon/resolver.ts:224`, returned at `advance.ts:87-88`).
  - `no-progress`: a driveToTerminal idle/iteration counter (`src/daemon/run-ticket.ts:128-135`) —
    no signal, no status change, no step mutation.

Because `blocked`/`no-progress` leave *nothing to resume against*, a naive "resume" wakes up, hits
the identical dead-end, and stops again on the same tick.

### 2. Ground truth

Two live reproductions in `~/code/styre-events` (`git worktree list`, 2026-07-24):

```
/private/var/folders/.../styre-wt-mF4zDH/STYRE-1   dceb20b [fix/STYRE-1]   prunable
/private/var/folders/.../styre-wt-PgBHlu/STYRE-7   a7dc517 [feat/STYRE-7]  prunable
```

- **STYRE-7** escalated; no dump (`~/.local/state/styre/styre-events/` has no `STYRE-7/`). Its
  worktree survives holding `feat/STYRE-7`. Re-running mints a fresh worktree root (`run.ts:222`)
  and calls `git worktree add -B feat/STYRE-7 <new>` (`worktree.ts:49`); git refuses — the branch
  is still used by the leftover worktree. **This is the "worktree already exists" error.**
- **STYRE-1** parked; dump survives at `~/.local/state/styre/styre-events/STYRE-1/run.db` (only
  because `--db` was passed — luck, not design). Its worktree is also leaked and `prunable`.

---

## 3. The model

**One non-terminal stop state: `paused`.** It replaces `parked`, `escalated`, `blocked`, and
`no-progress` as user-visible outcomes. A `paused` run has a durable checkpoint and is resumable.

### 3.1 Normalize every stop at pause time (the Option A principle)

The load-bearing rule: **before any run exits with a halt, it leaves the *same shape* behind** —

1. task marked **waiting for a human**,
2. a **note** (the `detail`, see 3.3) saying *what a resume would need*,
3. a **re-armable next step**, and
4. a **saved restart point** (the checkpoint, §6).

`escalated` already does 1–4. Option A makes the quiet quitters do the same:

- **`blocked`** (resolver has no next move) and **`no-progress`** now *raise the hand* — they set the
  task waiting and raise the `human_resume` signal, exactly as an escalation does, instead of
  returning silently (`loop.ts:34`, `resolver.ts:224`, `run-ticket.ts:128-135` change to route
  through the escalate path in `advance.ts:91-99`).

Only once every stop is normalized to this shape does `reason` become *pure metadata*: at resume
time all reasons look identical (a waiting task + a consumable gate + a re-armable step), and
`reason` changes only *whether you're allowed to continue yet*, never *how* resume works.

### 3.2 The reason enum

| `reason` | Absorbs | Unblocker | Resume gate |
| --- | --- | --- | --- |
| `budget` | `parked` | time / credit reset | reset time reached |
| `needs_you` | `escalated`, `blocked`, `no-progress` | a human fixes, edits, or decides | `human_resume` consumed |
| `interrupted` | crash, SIGINT, power loss ✎ *(net-new — no current terminal; enabled by §6, not a rename)* | nothing | none |

### 3.3 The honest-note rule

The `detail` string must state *what a resume actually requires*, so the operator never presses
resume into a wall:

- external fix — `"needs you: composer not installed"` → fix it, resume.
- edit-then-resume — `"no next move on this plan as written"` → edit the plan/code, **then** resume.
- exhausted — `"tried 3 times, same failure — needs a rethink"` → the genuine terminal (3.4).

### 3.4 The retry-budget backstop (how genuinely-hopeless stops end)

The distinction is not "resumable vs not" — it is "resume *after you change something*" vs "resume
*that changes nothing*." We do **not** add a separate no-resume stop. Instead:

- **Resume never resets the attempt tally.** The per-step attempt counter (`failure-policy.ts:70`,
  the *only* bound on repeat failures) climbs across resumes. ✎ *(This is why widening
  `resetProvision` to zero the attempt was rejected in ENG-331 — it deletes the sole backstop.)*
- **Below a hard ceiling**, a dead-end escalates → `paused (needs_you)` (waits for you).
- **At the ceiling**, it becomes **`exhausted`** — the one genuinely-terminal failure: "tried N
  times, resume won't help, this needs a real rethink." Reached automatically by spending the
  human-retry budget, not by inventing a second stop shape.

This keeps the single "everything is paused, waiting for you" model *and* gives a real end-of-line
that prevents an infinite resume→loop→wait treadmill (notably for `no-progress`'s iteration-cap
sub-case, where each resume grants a fresh tick budget — see ✎ 3.5).

### 3.5 ✎ `no-progress` is two cases

The review found `no-progress` conflates a genuinely-stuck **idle-stall** (`run-ticket.ts:128-130` —
resume re-idles, not helped by a fresh budget) with an **iteration-cap** (`run-ticket.ts:135` —
resume grants a fresh 200-tick budget and *may* help). Both normalize to `needs_you`, but the
`detail` must distinguish them (idle-stall leans toward the exhausted ceiling faster), and the
attempt tally (3.4) must gate the iteration-cap so repeated resumes can't loop forever.

`pr-ready` and `done` are unchanged and are **not** pauses.

---

## 4. Vocabulary & exit codes

- **Outcome enum:** `pr-ready | done | paused | exhausted` (+ internal `reason` on `paused`).
- **Exit codes** (`src/cli/errors.ts` `EXIT`, `src/cli/outcome.ts`):
  - `0` — `done` / `pr-ready`
  - `75` (TEMPFAIL) — **all** `paused`, every reason (fixes today's `blocked`/`no-progress` → `1`)
  - `1` (OPERATIONAL) — **`exhausted`** only (the one genuine dead-end). ✎ *This preserves the
    `1`-means-real-stop / `75`-means-resumable split that `errorKindForExit` and CI scripts rely on
    (`src/cli/errors.ts:99-102`, `run.ts:39-41`) — the split moves from "operational vs tempfail"
    to "genuinely-terminal vs resumable," which is the honest line.*
  - `65` resume-refused (HEAD moved), `64` usage, `69` toolchain, `70` internal, `78` config —
    unchanged.
- ✎ **Telemetry is a breaking change, not a rename.** `failureBucket` hardcodes
  `outcome === "parked" → "parked-credits"` and `no-progress → "no-progress"`, then keyword-classifies
  the rest (`src/telemetry/analytics/properties.ts:61-74`). Emitting `outcome:"paused"` makes every
  branch fall through. The bucket map must be re-keyed on `reason` (so `budget → "parked-credits"`
  etc. survive), and any dashboard keying on the old `outcome` string must be migrated deliberately.

---

## 5. CLI surface

Per product decision (2026-07-24): resume stays a **flag on `run`** (no new subcommand), and a
fresh `run` on an existing checkpoint **refuses**.

| Command | Behavior |
| --- | --- |
| `styre run <ticket>` | Fresh run. **Refuses if a checkpoint exists**, pointing at `--resume` / `--fresh`. |
| `styre run --resume <ident>` | Resume the checkpoint (the one recovery path, §7). |
| `styre run <ident> --fresh` | Discard the checkpoint + reconcile the worktree, then start over. |
| `styre run --resume <ident> --accept-head` | Resume though branch HEAD moved (exists today, `park.ts:245-252`). |
| `styre run --resume <ident> --inspect` | Print resume diagnostics, no run (exists today). |
| `styre ls` | List paused checkpoints: ticket, reason, age, resume hint. *(small, separate)* |
| `styre clean <ident> \| --all` | Reap checkpoint + worktree for done/abandoned/`exhausted` runs — ✎ **and stale `pr-ready` worktrees** (see §10). *(small, separate)* |

No `--after-fix` flag — resume always consumes the pending signal, so it is implied (supersedes
`minimal-loop.md:183-185`).

---

## 6. Architecture: the checkpoint IS the live location

Orphaning's root cause is that the live journal and the durable checkpoint are different files,
reconciled only by a copy that only `parked` performs. Fix it at the root: **a fresh run journals
directly to `~/.local/state/styre/<slug>/<ident>/run.db`** (`parkDir`, `park.ts:75-77`) instead of a
temp DB (`run.ts:199-203`).

Consequences: the journal is always at the checkpoint (a crash leaves it there for free — no
signal handler); `pause()` writes only a small `reason`/`detail`/transcript sidecar; `run <ticket>`
refusing = testing whether the dir exists; `--db` override stays for tests.

✎ **The refuse-guard is load-bearing and must be hardened.** `insertProject`/`insertTicket` are
unguarded plain INSERTs against UNIQUE columns (`src/db/repos/project.ts:20` / `schema.sql:64`;
`src/db/repos/ticket.ts:41` / `schema.sql:122`); the `getRun()===null` guard (`run.ts:210`) protects
only the `run` row. So a `run` that reaches `runTicket` on a populated checkpoint crashes with a
UNIQUE violation — the exact ENG-331 "--db trap." Two defenses, both required:
1. the dir-existence refuse-guard runs **before** `migrate`/`runTicket`, and
2. `insertProject`/`insertTicket` become idempotent (`INSERT OR IGNORE` / upsert), so any bypass
   (partial-crash dir, a `--fresh` that reconciles then fails to delete, a race) degrades to a
   no-op instead of a crash.

This deletes `dumpPark`'s copy machinery (`park.ts:104-136`) and the overwrite guard
(`park.ts:80-96,119-125`); the WAL checkpoint before hand-off is retained.

---

## 7. The pause/resume symmetry

`reason` touches exactly one step of resume; every other step is identical across all reasons —
*because* pause normalizes the halt shape (§3.1).

```
 pause(reason, detail):
   1. journal already durable at checkpoint (live-location, §6); branch commits already in git
   2. NORMALIZE (§3.1): task -> waiting; raise human_resume for a dead-end; leave a re-armable step
   3. write sidecar: reason, honest detail (§3.3), transcript
   4. RETAIN the worktree (part of the checkpoint, not a leak)
   5. exit 75; print "Paused (<reason>): <detail>. Resume: styre run --resume <ident>"
      (or exit 1 "Exhausted (<detail>)" when the retry budget is spent, §3.4)

 resume(ident):
   1. locate checkpoint; absent -> clear error
   2. GATE (the ONLY reason-dependent step):
        budget      -> reset time reached? else refuse (informative)
        needs_you   -> consume the human_resume signal (markConsumed, src/db/repos/signal.ts:69)  # ✎ was :62
        interrupted -> no gate
      (all reasons) HEAD-moved guard -> refuse unless --accept-head (park.ts:233-252)
   3. reconcileWorktree()   <-- shared primitive, staleness-gated (below)
   4. re-arm the step: recover() resets an interrupted *running* step -> pending
      (src/daemon/recover.ts:22-33); a *failed* step is re-run directly by runStep
      (src/engine/step-journal.ts:85) -- recover() does NOT touch failed steps  # ✎ rev1 said running/failed
   5. setTicketStatus(active); driveToTerminal continues
   6. next terminal -> pause() again, done, or exhausted

 --fresh(ident):
   1. locate checkpoint
   2. (skip gate)
   3. reconcileWorktree()
   4. delete checkpoint (AFTER reconcile succeeds); fresh run
```

### `reconcileWorktree(repoPath, branch, staleWorktreePath, newWorktreeRoot)`

Extract today's resume-only "Fix B" (`park.ts:284-308`) into one primitive, called by `--resume`,
`--fresh`, and — as a guard — `ensureWorktree`.

✎ **Staleness-gated, never a blind force-remove.** The branch is deterministic per ticket
(`<prefix>/<ident>`, `src/agent/branch.ts:3-12`); the worktree root is per-run random
(`run.ts:222`). A blind `git worktree remove --force` on *whatever holds the branch*
(`worktree.ts:75-78`) would silently destroy a legitimate holder — a real parallel run, a resume
racing a fresh run, or your own manual `git worktree add <branch>` — including uncommitted work.
So the primitive removes a holder **only if it is styre-owned and stale**: its path is under
styre's tmp worktree root (`styre-wt-*`) **or** git reports it `prunable`. A **foreign / non-stale**
holder → **refuse** with a clear message ("branch <b> is checked out at <path> by something styre
doesn't own; free it yourself or use a different ticket"), never force-remove.

Steps when the holder is confirmed stale: `git worktree remove --force <stale>` → `git worktree
prune` → re-mint via `ensureWorktree` → re-arm provision (`resetProvisionForResume`, `park.ts:149`).
`ensureWorktree` prune-and-retries on git's "already used by worktree" error **subject to the same
staleness gate**. In-place mode (`worktreePath === repoPath`) skips steps 1–2 as today
(`park.ts:277-282,290`).

---

## 8. Back-compat & migration

- **Old parked dumps** (e.g. the live STYRE-1) have no `reason` sidecar → default `reason = budget`
  (park was the only pre-change dump-writer). Verify STYRE-1 resumes under the new path.
- **Leaked worktrees from before this change** (STYRE-7, STYRE-1) are stale/`prunable`, so the
  staleness-gated `reconcileWorktree` frees them on first resume/`--fresh`; `styre clean` reaps
  the rest.
- ✎ **Telemetry migration** (§4) ships with the outcome rename, not after it.
- `--after-fix`, if any caller uses it, becomes a removed flag / silent no-op.

---

## 9. Relationship to existing tickets

- **ENG-331** (Todo) — its intent (dump-on-non-`done`-terminal, resume an escalated dump, consume
  `human_resume`, `--inspect` from `failed`, `--db` trap) is a **subset** of this model, and its
  *mechanism* is superseded (live-location replaces dump-on-terminal; §6). Re-scope or close in
  favor of §11. Its two hard-won constraints are **kept**: resume must not zero the attempt tally
  (§3.4), and don't widen `resetProvision`.
- **ENG-353** (Done) — the distinct `escalated` word folds into `reason: needs_you`; its
  terminal-message work is reused.
- **ENG-332** (Done) — provision-first reduces the *frequency* of `needs_you`; orthogonal.

---

## 10. Non-goals

- A `ParkCause` taxonomy raising a `ParkSignal` for environmental faults — rejected in ENG-331 (the
  throw escapes `advanceOneStep` uncaught, losing the checkpoint). `reason`/normalization happen in
  a graceful `pause()`, not via a signal.
- ✎ **`exhausted` is a deliberate, bounded exception to P1** ("never a dead end"). It is the *only*
  genuine terminal-failure, reached solely by spending the human-retry budget (§3.4) — chosen over
  an unbounded "waits forever" queue. Flagged for explicit sign-off.
- ✎ **`pr-ready` worktree retention is unbounded.** A PR that never merges never reaches
  `released:project` (`handlers.ts:1830-1840`), so its worktree leaks — the same class this spec
  fixes, for the *most common* terminal. Not reaped at pause (the branch is legitimately alive for
  review), but **`styre clean` must be able to reap stale `pr-ready` worktrees** (age/merged-state
  heuristic). In scope for the housekeeping ticket; out of scope for the core model.
- Auto-resume of `budget` pauses on a timer — the gate only *permits* resume; a human/cron invokes it.
- `--db` reuse of a populated DB (re-entry is via the checkpoint, one way).

---

## 11. Proposed ticket decomposition

1. **`reconcileWorktree` primitive + staleness-gated `ensureWorktree` retry** — extract Fix B, gate
   on styre-owned/`prunable` (§7). **Independently shippable; directly fixes the reported STYRE-7
   bug.** Ship first.
2. **Live-location checkpoint + hardened refuse-guard** — journal to `parkDir` from the start;
   idempotent `insertProject`/`insertTicket`; `run <ticket>` refuses on existing checkpoint;
   delete `dumpPark` copy path (§6). Root-causes ENG-331.
3. **Normalize dead-ends at pause (Option A)** — `blocked`/`no-progress` raise `human_resume` + leave
   a re-armable step; the honest-note rule; the `exhausted` terminal + no-reset-tally backstop
   (§3). This is what makes the model true.
4. **Outcome collapse + exit codes + telemetry** — `RunOutcome → pr-ready|done|paused|exhausted`
   (+`reason`); `paused → 75`, `exhausted → 1`; re-key the telemetry bucket map on `reason` (§4).
   (Absorbs ENG-353's surface.)
5. **Unified resume gate** — one `resume()` switching only on `reason`; consume `human_resume` for
   `needs_you`; `--fresh` (§7). (Absorbs the rest of ENG-331.)
6. **Housekeeping** — `styre ls`, `styre clean` (incl. stale `pr-ready` reap). *(optional)*

Sequence: **1 → 2 → 3 → 4 → 5 → 6.** (1 alone fixes the live bug; 2 unblocks the rest; 3 must land
before 4/5 or the unified gate is vacuous for two reasons.)

---

## 12. Open questions

- **`exhausted` ceiling value** — how many human-retry cycles before a dead-end becomes terminal?
  (Ties to `failure-policy.ts:70`'s existing per-step cap — reuse it, or a distinct higher ceiling?)
- **`budget` resume** — block until reset time (proposed), or resume-and-immediately-re-pause?
- **`pr-ready` reap heuristic** — age-based, merged-state-based, or manual-only via `styre clean`?

# ENG-388 — Docs update for the unified pause/resume model & new CLI surface

**Date:** 2026-07-29
**Status:** Brainstorm / documentation-impact analysis + code audit (pre-plan)
**Related:** ENG-380 epic (ENG-381–387, merged/landed); design doc
`docs/brainstorms/2026-07-24-paused-resume-model-design.md` (§3–§5, §10)

Follow-up to the ENG-380 epic: the shipped behavior and vocabulary changed, but the GitHub repo
docs and the public site (styre.dev) still describe the old model. This document audits **the code
first** (to find any runtime discrepancy that must be fixed before the docs can be made truthful),
then maps every doc that needs updating across both repos.

**Overarching principle (per the ticket owner):** audit the code, fix any discrepancy *in code*,
then update documentation to match the code — never document a state the code doesn't emit.

---

## 0. Product source of truth (what the docs must match)

Source-verified against `src/cli/outcome.ts`, `src/cli/errors.ts`, `src/cli/run.ts`, `src/cli/ls.ts`,
`src/cli/clean.ts`, `src/cli/park.ts`, `src/index.ts`, and the merged design doc.

**Outcome vocabulary** — retired `blocked | parked | escalated | no-progress`; now:
- Terminal outcomes: `pr-ready | done | paused | abandoned`.
- `paused` carries an internal `reason`: `budget | needs_you | interrupted`.
- `abandoned` has **no producer in styre** — cleaning a run's disk state is NOT abandoning the
  ticket. Deciding a ticket is dead is a human/tracker action.

**Exit codes** (verified in `errors.ts`/`outcome.ts`/`clean.ts`/`park.ts`):
- `0` done / pr-ready
- `75` (TEMPFAIL) — **any** `paused` (every reason) **and `styre clean <ident>` on a live run**
- `1` abandoned
- `65` resume-refused — the general resume-refused code: branch HEAD moved without `--accept-head`
  (`park.ts:264-266`, exit set at `:269`) *or* concurrent-resume lock contention (`park.ts:220`)
- `64` usage · `69` toolchain · `70` internal · `78` config

> ⚠️ **Ticket text is wrong on two points; docs follow the code.** (1) The ENG-388 description's
> exit-code line attributes `clean` on a live run to `65`; the code (`clean.ts:155-158`) exits `75`.
> (2) Exit `1` / `abandoned` is currently **unreachable** — `exitCodeForOutcome(abandoned)=1`
> (`outcome.ts:35-36`) is the only path to exit 1, but nothing in `run-ticket.ts` ever emits
> `abandoned`. Document exit 1 as "reserved for `abandoned`; not currently emitted by any run."

**CLI surface** (registered subcommands in `index.ts`: `run, ls, clean, migrate, notify, setup`):
- `styre run <ticket>` — fresh run; **refuses if a checkpoint (`run.db`) already exists**, pointing
  at `--resume` / `--fresh` (`run.ts:262-266`).
- `styre run --resume <ident>` — resume the checkpoint (re-arm the failed step or re-plan; consumes
  the pending `human_resume`).
- `styre run <ident> --fresh` — discard the whole checkpoint dir (run.db + -wal/-shm + sidecar) and
  reconcile the worktree, then start over.
- `styre run --resume <ident> --accept-head` — resume though branch HEAD moved (drops carryover).
- `styre run --resume <ident> --inspect` — print resume diagnostics, no run.
- `styre run --in-place` — existing flag (`run.ts:108-112`); currently undocumented in the reference.
- `styre ls` — three sections (`ls.ts`): "Paused/resumable efforts:" (each with a
  `resume: styre run --resume <ident> --slug <slug>` hint), "Finished leftovers (reap per project
  with `styre clean --all`):" (slug-qualified), and "Running:". Live efforts never shown as reapable.
- `styre clean <ident>` — reap one effort's disk artifacts (worktree + checkpoint); no ticket-status
  change; refuses a live run (**exit 75**).
- `styre clean --all` — reap only provably-finished (`pr-ready`/`done`) for the current project;
  protects resumable/live.
- `styre clean <ident> --purge` — also delete local + remote branch (closes the PR); opt-in,
  single-ident (rejects `--all --purge`, exit 64), silent when absent. On the repo's **default
  branch** it is a **soft skip**, not a hard abort: the worktree + checkpoint are still reaped
  (`reapEffort`, `clean.ts:172`), only the branch/PR deletion is skipped with a stderr warning, and
  the command still exits 0 (`clean.ts:183-193`).

**Model:** the checkpoint IS the live location — a run journals directly to
`~/.local/state/styre/<slug>/<ident>/run.db`; a crash leaves it there (resumable). No `--after-fix`
flag (resume always consumes the pending signal). No merge-state / age "staleness" heuristic.

---

## 1. Code audit — live vocabulary (fix code first)

Which runtime surfaces emit old vs new vocab:

**Correct already (emit NEW live):** CLI outcome sentences (`outcome.ts`), exit codes, and the
telemetry `outcome` property (`properties.ts:127` = `summary.outcome`). `failureBucket` is re-keyed
on `reason` (`properties.ts:71-72`); its `parked-credits`/`no-progress` strings are **fixed analytics
bucket labels**, not the outcome — leave.

**Discrepancy — FIX IN CODE (Phase 0, before docs):** (corrected after plan review — the notifier
label is NOT the only live surface; the `run`/resume CLI output strings also print retired vocab.)
- **`src/daemon/notify.ts:19,21`** — the Slack/notifier labels are `"escalated"`/`"parked"`,
  rendered verbatim by `slack.ts:26-27`. A paused run shows "Paused…" in the terminal but
  "escalated"/"parked" in Slack — a live user-facing inconsistency. Fix: map the event kind → a new
  user-facing label (`escalated`→paused/needs-you, `parked`→paused/budget); keep the `event_log.kind`
  DB enum unchanged (internal wire, no migration). Update the three label assertions in
  `test/daemon/notify-sweep.test.ts` (L31, L40, L100-104).
- **`src/cli/run.ts:337-341`** — the budget-pause path prints `"Parked: … / Resume with: … / Dump:
  <dir>"` to stderr. Rename to `"Paused — out of budget: … / Checkpoint: <dir>"`.
- **`src/cli/park.ts:126,266,379`** — `"overwriting parked run …"`, `"Parked again: … Dump: …"`, and
  the resume-refused `"since the parked attempt … 'styre run <ident>' to start fresh"`. Rename to
  pause/checkpoint wording; **and fix the command** — a bare `styre run <ident>` now REFUSES when a
  checkpoint exists, so the hint must be `styre run <ident> --fresh`.
- **`src/cli/run.ts:102` / `run.ts:101`** — `--resume` help "Resume a **parked** run" → "paused";
  `--db` help "a fresh per-run temp DB" → the durable checkpoint (the live location).

**Intentional internal names — NO code change; docs describe as wire/internal:**
- `event_log.kind` enum (`escalated`/`parked`), `dispatch.outcome:"parked"` (`run-dispatch.ts:168`),
  and the `"escalated"` routing-decision verb (checks/review/arbiter/failure-policy). The routing
  verb "escalate" stays — it names an internal route, not the terminal outcome.
- `work_unit.status:"blocked"` (`schema.sql:156`) and the external `IssueState:"blocked"`
  (`jira.ts:54`) — a work-unit state / tracker projection, a *different concept* from the retired run
  outcome. The internal **ticket** status enum is `active|waiting|abandoned|done` (no `blocked`).
- Config enums `onPlanDefect:"escalate"` and `notify:"escalations"` (`runtime-config.ts:12,39`) —
  **KEEP** (routing/action knobs, not outcomes; renaming would break users' config.json). Docs
  describe them accurately.

**Stale code comments (retired vocab, non-functional) — optional cleanup in the same edits:**
`run.ts:46-47`, `errors.ts:8` + the `TEMPFAIL` comment, `outcome.ts` header prose.

---

## 2. Repo A — `Twinning-Labs/styre` (source repo) doc impact

### 2a. UPDATE — primary targets

| File | Core work |
|---|---|
| `docs/architecture/runtime-parameters.md` | **Primary CLI reference.** Rewrite the exit-code table (L122-146) to the new outcome set + paused reasons (carry the exit-1/`abandoned`-unemitted nuance); rewrite the `styre run` flag table (L31-44) — add `--fresh` and `--in-place`, note the checkpoint-refusal on the positional. **Add new `styre ls` and `styre clean` (`<ident>`/`--all`/`--purge`) sections.** Fix `--resume` "parked" wording (L42). |
| `docs/architecture/minimal-loop.md` | §5 needs-you inbox (real `--after-fix` content at **L209 / L228**, not L183-185 as the ticket says) → `styre run --resume`/`--fresh`/`--accept-head`/`--inspect`; budget table `no-progress`/`blocked`→paused; add checkpoint-refusal. |
| `docs/architecture/control-loop.md` | L111 `'blocked'` route, L446 "no-progress escalation", L666/L707-713 park→pause lifecycle. (The ~53 loopback-verb "escalate" uses in §8 stay — routing verb, not outcome.) |
| `docs/architecture/execution-model.md` | L193-212 park→pause(reason) narrative + new commands; L31/L66-73 outcome framing. The narrative outcome-model doc. |
| `docs/architecture/conventions.md` | §"Park dumps" (L101-106) → checkpoint/pause vocabulary; natural home to state what `styre clean`/`--purge` operate on. |
| `docs/architecture/build-operations.md` | L62-64 "Park on session interruption" block → pause(reason)/exit codes; L77 `--after-fix`; add `styre ls`/`clean` to the run-modes surface. |
| `docs/architecture/glossary.md` | needs-you-inbox entry (L57-66) park/exit-75/resume-after-fix → pause(reason); add entries for the terminal-outcome vocab and `styre ls`/`clean`. |
| `docs/architecture/configuration.md` | L35 notify "escalated/parked" phrasing; L161 "park dir". Keep the config enum *values*; describe them accurately. |
| `README.md` | Exit-code table (L107-122): L114 (`1`→abandoned + not-emitted note), L116/L119 (park/escalated wording, `75`→any paused). Commands section (L88-105): add `styre ls`, `styre clean`, and `styre run` `--resume`/`--fresh`/`--accept-head`/`--inspect`. Enumerate the terminal outcome set. |
| `CLAUDE.md` | "four subcommands" (L61) → six; L64-71 park/resume → paused(reason)+abandoned; **pre-existing bug L72: "notify exits `2`" — actual usage error is `64`** (fix while here). |
| `docs/architecture/telemetry-export.md` | §3.4 `summary.outcome` value set (L176) → new enum + paused `reason`. `EventKind`/`event_log.kind` `parked`/`escalated` (L74-85, L274-279) stay as wire names — document as distinct from the user-facing outcomes. |

### 2b. UPDATE — light / optional
- `docs/architecture/projector.md` — §7 "Failure + escalation" (L86/L120/L129-135) escalate/park framing. (L69 already uses `abandoned` correctly.)
- `docs/architecture/ticket-template.md` — L174-178 "escalates to a human" → paused(needs_you). Mechanism description, optional.
- `docs/architecture/README.md` — invariants blurb (L79-80) high-level only; NO CHANGE defensible.

### 2c. NO CHANGE
- `CONTRIBUTING.md` (`--resume` example still valid), `docs/architecture/prompts.md`.
- `CHANGELOG.md` — **append-only history; do not rewrite.** Its `[0.13.0]` entry already documents the
  new surface correctly and is the reference other docs should match.
- **`docs/architecture/brainstorm.md`** — sits among the architecture docs (a naive
  `docs/architecture/*.md` vocab sweep hits it ~29×) but is a self-described "running scratchpad —
  append, don't rewrite history" (`brainstorm.md:7-8`). Treat like CHANGELOG: **do not rewrite.**
- `docs/architecture/schema.sql`, `docs/brainstorms/*`, `docs/plans/*` — historical/code artifacts.

### 2d. Additions
- A dedicated CLI/commands reference page does not exist in-repo today; `run`/`ls`/`clean` flags are
  described piecemeal. **Recommendation: grow `runtime-parameters.md` into the canonical reference**
  (least churn — it already holds the flag + exit-code tables) rather than adding a second page that
  would drift. styre.dev already carries the user-facing `cli.md`.

---

## 3. Repo B — `Twinning-Labs/styre.dev` (public site) doc impact

Astro + Starlight, source at `/Users/rajatgoyal/code/styre.dev`. **Separate repo ⇒ separate PR.**
Sidebar is inline in `astro.config.mjs` (L28-56) — only needs editing if a page is added.

### 3a. UPDATE — major rewrites
- `src/content/docs/docs/recovery.md` — built entirely on the retired Parked/Escalated/Dead-end
  trichotomy. Collapse to `paused`+`reason`; relabel dead-end→`abandoned`; fix the fresh-run command
  ("`styre run <ident>`" → "`styre run <ident> --fresh`", because a bare fresh run now refuses);
  replace "escalated writes no dump / no `--resume`" (now false — always resumable); drop
  `--after-fix`; cross-link `styre ls`/`clean` and state "clean ≠ abandon the ticket."
- `src/content/docs/docs/exit-codes.md` — rewrite the `75` row (any paused, all resumable) and the
  "parked vs escalated" section; relabel `1`→abandoned (with the "not currently emitted" note),
  `0`→done/pr-ready; also the `65` row (L27 "since the run parked"); add clean-on-live→75.

### 3b. UPDATE — substantive
- `src/content/docs/docs/cli.md` — fix `--resume` "parked" (L43); correct `--db`/live-checkpoint
  (L42); document `styre run` refuse-on-checkpoint + `--fresh`; **add `styre ls` and `styre clean`
  (`--all`/`--purge`) sections**; bump "four commands" (L16).
- `src/content/docs/docs/the-run-loop.md` — L105 `parks`; reconcile the bounded-stop table (L91-106)
  with paused/abandoned.
- `src/content/docs/docs/files-and-paths.md` — L39 "parked run's saved state" → live checkpoint;
  reconcile the "throwaway per-run temp DB" claim (L42/L50) with live journaling; verify
  `transcript.json` still present.
- `src/config/home.ts` — **user-visible** landing copy L236 "Styre escalates to you…" → pause wording.

### 3c. VERIFY then update wording
- `src/content/docs/docs/configuration.md` — "five internal states incl. blocked" (L99/L111) is
  inaccurate: the internal *ticket* status enum is `active|waiting|abandoned|done`; `blocked` is a
  *work-unit*/tracker state. The `escalations`/`escalate` config enum *values* stay (§1); describe
  accurately.

### 3d. NO CHANGE
- `index.md`, `writing-a-ticket.md`, `telemetry.md`, `install.md`, `project-setup.md`, `404.md`,
  `config/site.ts`, `index.astro`, home components. (`first-run.md` — optional touch on the exit-75
  reason list, L114-116.)

---

## 4. Resolved decisions

- **D1 — schema/telemetry enums.** The terminal outcome (`outcome.ts`) and telemetry `outcome`
  property already emit NEW vocab live. The live surfaces still emitting old vocab are the notifier
  label AND several `run`/resume CLI output strings — **all fixed in code** (§1, Phase 0).
  `event_log.kind` / `dispatch.outcome` stay as internal wire names (no rename/migration); docs
  describe them as distinct from user-facing outcomes.
- **D2 — routing verb "escalate."** Keep. It names an internal route, not the terminal outcome; retire
  it only where it named the *outcome* (now `paused(needs_you)`).
- **D3 — config enum values** (`onPlanDefect:"escalate"`, `notify:"escalations"`, `IssueState:"blocked"`).
  KEEP (config knobs / tracker projection, not run outcomes; renaming breaks user config). Docs describe
  accurately.
- **D4 — two PRs.** styre + styre.dev are separate repos; ENG-388 covers both → two PRs, styre first
  (source of truth), then mirror to styre.dev.
- **D5 — code help-strings.** Fix the one live `--help` string (`run.ts:102`); internal comments are
  optional tidy-up.
- **D6 — exit 1 / `abandoned`.** Currently unreachable (no producer). Document exit 1 as "reserved for
  the `abandoned` terminal; not currently emitted by any run" in README, `runtime-parameters.md`, and
  styre.dev `exit-codes.md` — honest and forward-compatible.

---

## 5. Execution shape (for the writing-plans step, not yet executed)

- **Phase 0 — fix code first (styre repo, TDD):** `notify.ts` label mapping (+ `notify-sweep` test);
  `run.ts:102` help string; fold in the stale retired-vocab comments while touching those files.
- **Phase 1 — styre docs to match code:** `runtime-parameters.md` (+ new `ls`/`clean` sections) → the
  outcome-narrative docs (`execution-model`, `minimal-loop`, `control-loop`) → `conventions`,
  `build-operations`, `glossary`, `configuration`, `telemetry-export` → `README`, `CLAUDE.md` → light:
  `projector`, `ticket-template`.
- **Phase 2 — styre.dev docs (separate repo, separate PR):** `recovery.md` + `exit-codes.md` (major) →
  `cli.md`, `the-run-loop.md`, `files-and-paths.md`, `home.ts` → verify `configuration.md`.
- **Gates:** styre — `bun test` / `bun run lint` / `bun run typecheck` / `bun run build` for the Phase 0
  code changes; styre.dev — `astro build`.

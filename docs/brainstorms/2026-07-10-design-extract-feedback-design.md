> ⚠️ **SUPERSEDED** (2026-07-10) by the general-class fix in `docs/brainstorms/2026-07-10-dispatch-retry-feedback-design.md` — the per-step `extractFeedback` was symptomatic; the general `runAgentDispatch` retry-feedback primitive replaces it. Kept for history.

# `design:extract` validation feedback-carry — Bug B fix

**Status:** design, awaiting independent review + operator sign-off
**Date:** 2026-07-10
**Branch/worktree:** `fix/design-over-decomposition` (off `origin/main` @ #68 `771b25b`)

---

## §0 — The bug (Bug B)

In the SMOKE=2 bench run, `darkreader-7241` escalated `blocked` at `design:extract`:

```
event: escalated — "design:extract completeness failed: unit seq 3 declares no files_to_touch
                    (every planned unit must name ≥1 file)"
```

The gold-comparison judge confirmed styre's *actual* work-unit-1 candidate was the **correct fix**
(a strict superset of the gold patch) — so styre had the right change; it blocked on a **vacuous
sibling unit**. This would have been a resolved instance.

**Root cause (confirmed on `origin/main`).** The design agent over-decomposed a 1-line regex fix
into 3 work units, one with `files_to_touch = []`. The `design:extract` handler
(`src/dispatch/handlers.ts`) calls `validateExtraction` (`extract-schema.ts:118-121`), which
rejects a zero-files unit, and the handler **throws** `design:extract completeness failed: …`. The
throw goes to the failure-policy. `design:extract` is step_type `"dispatch"` with null
`work_unit_id` (`resolver.ts:99`), so it matches none of the typed failure branches and takes the
**default retry path** (`failure-policy.ts:257-258`: `resetToPending → retry`) — re-dispatching
`design:extract` up to `DEFAULT_MAX_ATTEMPTS` (3) times, then escalating on **attempt-exhaustion**
(the top-of-function guard, `failure-policy.ts:70-86`, reason `step 'design:extract' failed`). But
`extractVars` (`prompt-vars.ts`) carries **no feedback** about the failure, so every re-dispatch
re-runs the *identical* prompt, the agent over-decomposes the same way, and all 3 blind attempts
fail identically → escalate `blocked`. (The verify-only "no-progress/identical-signature" logic at
`failure-policy.ts:146-157` lives inside the verify branch and never runs for `design:extract`.)

This is the feedback-starved-retry class the design-loop work already fixed elsewhere (PR #57's
`designFeedback` for the redesign loop; `implementFeedback`; `checksFeedback`) — but
`design:extract`'s `validateExtraction`/`validateCdotImpact` throws were never wired for it.

**Not** the completeness-module empty-*diff* fix (PR #49) — that is diff-time (a unit whose
implementation produces no diff). This is **plan-time**: `validateExtraction` rejecting a vacuous
plan before implement.

---

## §1 — The fix: make the retry productive (feedback-carry)

Operator-chosen approach (over auto-drop and prompt-nudge): **carry the validation errors into the
`design:extract` re-dispatch as feedback**, so the agent corrects the specific problem (remove the
redundant unit, or name its files) instead of blindly repeating it. Mirrors the established
`implementFeedback` (sha-keyed signal) + `designFeedback` (formatting) pattern.

- The handler, on a `validateExtraction` **or** `validateCdotImpact` failure, records a
  `ground_truth_signal` (`signalType: "extract-validation"`, `result: "fail"`, `branchHeadSha` =
  the current plan sha, `detail: { errors: string[] }`) **before** throwing.
- `extractFeedback(db, ticketId)` reads the latest `extract-validation` fail signal **at the current
  plan sha** (`getLatestForTicket(...).branch_head_sha`) and formats the errors into a corrective
  block; returns `""` when there is none (first attempt → blank slot).
- The handler passes it into `extractVars`, rendered in a new `{{extract_feedback}}` slot in
  `prompts/design-extract.md`.

**Why sha-keying is exactly right (and needs no staleness bookkeeping).** `design:extract` is
read-only (commits nothing), so every retry within one design round runs at the same plan sha (the
`design:dispatch` commit that wrote `docs/plans/<ident>.md`) — the fail signal recorded at that sha
is read across retries. A redesign loopback (review→design) re-runs `design:dispatch`, committing a
**new** plan sha, so a prior round's stale feedback lives at a different sha and is never read.
Identical to how `implementFeedback` keys on the unit's latest sha.

**Interaction with the failure-policy (this is the point).** `design:extract` takes the default
retry path (§0): up to `DEFAULT_MAX_ATTEMPTS` (3) attempts, then escalate on exhaustion — the
verify-only no-progress/signature logic does **not** apply here. Today all 3 attempts are *blind
and identical* → guaranteed escalate. With the fix, attempts **2 and 3 carry the specific error** in
`{{extract_feedback}}`, so the agent gets up to **two informed correction attempts**; a specific
error ("unit seq 3 has no files — remove it") is trivially actionable and typically fixed on the
first informed retry. If the agent *still* cannot produce a valid extraction across all 3 attempts,
escalation on exhaustion is correct (genuinely stuck). The fix converts a guaranteed-unproductive
blind-retry loop into an informed one — **no failure-policy change** (the validation gate still
runs deterministically on every attempt; feedback only informs, never relaxes).

---

## §2 — Components (4 files, all mirroring the established pattern)

1. **`src/dispatch/extract-feedback.ts`** *(new)* — `extractFeedback(db: Database, ticketId: number): string`:
   - `sha = getLatestForTicket(db, ticketId)?.branch_head_sha`; if null → `""`.
   - read `listByTicket(db, ticketId)` (rows are `ORDER BY measured_at, id` **ascending**), filter to
     `signal_type === "extract-validation"` && `result === "fail"` && `branch_head_sha === sha`, and
     take **`.at(-1)`** (the *latest* — a naive `.find()` would return attempt-1's errors and mislead
     a 3rd-attempt agent; mirrors `behavioralStillRed`). If none → `""`.
   - parse `detail.errors: string[]`; format into a block, e.g.:
     `## Prior extraction was rejected — fix before re-emitting\n\nYour previous work-unit plan
     failed these checks. Fix each, then re-emit the FULL plan:\n- <error>\n- <error>\n\nIn
     particular, if a unit has no files to change it is redundant — remove it (or merge it into the
     unit that does the work) and renumber the remaining units so their seqs are the contiguous set
     1..N with no gaps; do not over-decompose a small change.`
2. **`src/dispatch/handlers.ts`** (`design:extract` handler) — two edits:
   - Compute `const planSha = getLatestForTicket(ctx.db, ctx.ticket.id)?.branch_head_sha ?? undefined;`
     and, in **both** the `validateExtraction` and `validateCdotImpact` failure branches, call
     `insertSignal(ctx.db, { ticketId: ctx.ticket.id, signalType: "extract-validation", result: "fail", branchHeadSha: planSha, detail: { errors } })` (errors = the respective error array) **before** the existing `throw`.
   - Change `vars: extractVars(ctx.ticket, deps.profile)` → `vars: extractVars(ctx.ticket, deps.profile, extractFeedback(ctx.db, ctx.ticket.id))`.
3. **`src/dispatch/prompt-vars.ts`** — `extractVars(ticket, profile, extractFeedback = "")`: add
   `extract_feedback: extractFeedback` to the returned vars (mirrors `designVars`'s `review_feedback`).
4. **`prompts/design-extract.md`** — add a `{{extract_feedback}}` slot near the top (blank on the
   first attempt; the corrective block on a retry). It renders *before* the decomposition
   instructions so the agent addresses it first.

**Edits 3 & 4 must land together** (fail-closed coupling): `renderPrompt` returns `ok:false` on any
`{{name}}` with no key in `vars`, and `runAgentDispatch` throws `CL-PROFILE: unresolved prompt vars`
on that → if `{{extract_feedback}}` is added to the template without `extract_feedback` in
`extractVars`, *every* `design:extract` attempt throws → escalate. An empty-string value renders a
blank slot correctly.

No schema change, no resolver change, no failure-policy change.

---

## §3 — Edge cases & decisions

- **First attempt** — no `extract-validation` signal at the plan sha → `extractFeedback` returns
  `""` → the `{{extract_feedback}}` slot renders blank. No behavior change on the happy path.
- **Staleness across redesign rounds** — solved for free by sha-keying (§1). A new design round's
  fresh `design:extract` reads only signals at its own new plan sha.
- **`validateCdotImpact` failures** — the same block also throws on a CDOT-gate failure
  (`handlers.ts`); this fix records + carries those errors too (a re-dispatch informed of e.g.
  "documentation impact must be addressed" is likewise productive). Both failure branches record the
  signal.
- **Null plan sha** — if `getLatestForTicket` is null (no dispatch recorded a sha yet — shouldn't
  happen at `design:extract`, since `design:dispatch` committed the plan), `branchHeadSha` is
  `undefined` and `extractFeedback` returns `""`. Degrades to today's blind retry — never worse than
  the status quo.
- **Two informed retries before exhaustion** — `design:extract` takes the default retry path
  (§0/§1): up to `DEFAULT_MAX_ATTEMPTS` (3) attempts, escalate on exhaustion. So attempts **2 and 3**
  carry `{{extract_feedback}}` — two informed correction shots; a specific error ("unit seq 3 has no
  files") is easily fixed on the first, and genuine inability across all 3 still escalates (correct).
  We do **not** raise `DEFAULT_MAX_ATTEMPTS` or touch the failure-policy.
- **Byte-identical redesign edge (benign)** — sha-keying relies on `design:dispatch` committing a
  *new* plan sha per round; if a redesign regenerates a byte-identical `docs/plans/<ident>.md`,
  `commitWorktree` returns `changed:false` at the *same* sha, so the prior round's `extract-validation`
  signal is still readable. Harmless (an identical plan hits the same errors, so the feedback still
  applies) and also defeated by `getLatestForTicket`'s `seq DESC` — a new round's higher-seq dispatch
  is returned regardless. Noted, not guarded.
- **Signal vocabulary** — `extract-validation` is a new open-vocab `ground_truth_signal.signal_type`
  (the column has no CHECK; additive). It is read only by `extractFeedback`; no other reader keys on
  it (confirmed vocab is open in the M-series work). It never overwrites a verify signal.

---

## §4 — Testing

- **`extractFeedback` (unit, seeded DB):**
  - no signal → `""`.
  - a `fail` signal at the current plan sha with `detail.errors` → the formatted block containing the
    errors + the "remove redundant units" guidance.
  - a `fail` signal at a **different** sha (stale, prior round) → `""` (sha-scoping).
  - only reads `extract-validation` (not other signal types).
- **`design:extract` handler (real DB + FakeAgentRunner):**
  - agent emits a vacuous unit (files_to_touch=[]) → the handler records an `extract-validation` fail
    signal (with the errors) at the plan sha AND throws (existing behavior preserved).
  - a valid extraction → no `extract-validation` signal recorded, work units inserted (happy path
    unchanged).
  - `validateCdotImpact` failure → also records the signal + throws.
- **`extractVars` / prompt (unit):** `extractVars(ticket, profile, "feedback text")` puts it in
  `extract_feedback`; `renderPrompt(EXTRACT_TEMPLATE, extractVars(...))` is `ok` (no missing var)
  with and without feedback.
- **e2e (the crux — reproduces & fixes the darkreader escalate):** drive a ticket whose **attempt-1**
  `design:extract` emits a vacuous unit and whose **attempt-2** (with `{{extract_feedback}}` now
  populated) emits a valid plan → the ticket advances past `design:extract` to implement (no
  escalate); assert the attempt-2 prompt/vars actually carried the error text. And the negative: a
  FakeAgentRunner that emits the identical vacuous unit on **all three** attempts → escalates on
  **attempt-exhaustion** (`step 'design:extract' failed` / `exhausted after 3 attempts`, NOT a
  no-progress reason) — proving feedback doesn't mask a genuinely-stuck agent. (Drive the full
  `DEFAULT_MAX_ATTEMPTS` count; do not assert a no-progress escalate — that path does not govern this
  step.)
- Full suite green; lint + typecheck clean.

---

## §5 — What this is NOT

- **Not auto-drop** — we never silently drop a zero-files unit (it could be a real unit the agent
  forgot to spec; dropping risks silent under-delivery). The agent decides, informed by feedback.
- **Not a prompt-nudge-only fix** — a nudge against over-decomposition reduces the rate but doesn't
  make the retry productive; feedback-carry is the robust recovery (operator-chosen).
- **Not a failure-policy / resolver / schema change** — the existing retry→escalate machinery is
  correct; this only makes the retry *informed*.
- **Not the empty-diff completeness fix (PR #49)** — that is diff-time; this is plan-time validation.

---

## §6 — Changelog

- **2026-07-10 (v2)** — Folded independent review (no Blocker; fix confirmed implementable + resolves
  darkreader). **I-1:** corrected the failure-policy model — `design:extract` is step_type `"dispatch"`,
  takes the *default* retry path, and escalates on **attempt-exhaustion** (3 tries), NOT via the
  verify-only no-progress/identical-signature path; so the agent gets feedback on attempts **2 and 3**
  and the e2e must drive three attempts. Minors: `extractFeedback` uses `.at(-1)` (latest); template +
  vars edits land together (fail-closed); the corrective block nudges contiguous renumbering; noted the
  benign byte-identical-redesign sha edge.
- **2026-07-10 (v1)** — Initial design. Feedback-carry (operator-chosen over auto-drop / prompt-nudge),
  sha-keyed `extract-validation` signal mirroring `implementFeedback`.

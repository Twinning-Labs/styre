# Change-scoped verify — M6: MERGE projection (final milestone)

**Status:** design, awaiting independent review + operator sign-off
**Date:** 2026-07-09
**Branch/worktree:** `feat/change-scoped-verify-m6`
**Predecessors:** M1 (#59) · M2a (#62) · M2b (#63) · M3 (#64) · M4 (#65) · M5 (#66) — all merged to `main`.

---

## §0 — Context

M6 is the **final** milestone of change-scoped verify. Everything upstream computes and
records ground truth; M6 is the one-way *read* of those records onto the surface a human
sees when deciding to merge. It is **projection-only**: no new gate, no new step, no schema
change, no new agent dispatch.

**Release coupling (unchanged, restated):** the operator committed (2026-07-08) to not
releasing the feature until M6 is done. So M4's gate, M5's arbiter, and M6's projection
**co-ship by construction** — M4's gate never reaches a user without M6's MERGE projection
alongside it. This is the enforced answer to the adversarial review's "unenforced release
invariant" concern.

**The four record families M6 projects** (all already written; M6 only reads):

| Record | Milestone | Storage |
|---|---|---|
| clean-HEAD classification + disposition | M3 | `ac_check.red_class` (assertion/absence/environmental) · `ac_check.disposition` (satisfied/not-expressible) |
| post-implement flip | M4 | `ground_truth_signal` type `ac-check-post-implement` |
| gate verdict | M4 | `ground_truth_signal` type `ac-check-gate` |
| persistent-red blame | M5 | `ground_truth_signal` type `ac-check-blame` (code-wrong/check-wrong) |
| re-author disposition | M5 | `ground_truth_signal` type `ac-check-reauthor` (installed/rejected) |
| demoted advisory suite/integration | M4 | `ground_truth_signal` type `<checkType>` / `integration`, `detail.advisory:true` |

---

## §1 — Scope & non-scope

**In scope.** At `merge:pr-ensure`, enrich the PR body with a **"Change-scoped verify"**
section built from the records above. Three concerns projected:

1. **Dispositions** — the per-AC rollup (§2), one line per acceptance criterion.
2. **Advisory sweep** — the non-blocking failures that rest on the human as the regression
   net: M4-demoted whole-suite / `integration` failures + environmental checks still red
   post-implement.
3. **M5 provenance** — when (and only when) a check was re-authored because it was judged
   check-wrong.

**Surface decision (operator, 2026-07-09):** the **PR body** (`renderPrBody`), not a
separate PR comment or Linear comment. It is the single surface the merging human already
reviews; the records are frozen by the time a ticket reaches `merge`; it rides the existing
`pr_create` projection — **no new enqueue writer**.

**Provenance prominence decision (operator, 2026-07-09):** the provenance section appears
**only when a re-author actually happened**. Silent on the common clean run.

**Not in scope / explicitly NOT M6:**

- **Any gating.** M6 never blocks. Dispositions and the advisory sweep are report-only by
  construction — the hard gate is M4's `verify:checks-gate`, untouched here.
- The deferred **regression-guard** (the thing that would eventually make the advisory sweep
  blocking) — still deferred; M6 projecting the sweep is precisely the interim "rests on the
  human" surface the M4 §7 named-risk promised.
- **Linear.** PR body only. No `add_comment` writer introduced.
- No change to how records are *computed* — M6 reads M3/M4/M5 outputs verbatim.

---

## §2 — The disposition rollup (per-AC)

Dispositions are stored per **check** (`ac_check.disposition` / `.red_class`), not per AC.
The schema comment is explicit — *"the AC-level assessed-satisfied is a rollup M6 projects,
so no disposition column lives here … M6 projects the AC-level rollup."* M6 therefore
computes the rollup: walk the ticket's acceptance criteria by `seq`, group active `ac_check`
rows (`superseded_at IS NULL`) by `ac_id`, and assign each AC one label:

| Label | Symbol | Condition |
|---|---|---|
| verified | ✅ | AC has a gating check (`red_class` ∈ {assertion, absence}) that is green post-implement. Green is guaranteed at MERGE — the ticket only reaches `merge` after `verify:checks-gate` passed. |
| satisfied (pre-existing) | ✅ | check `disposition = satisfied` — green on clean HEAD, no implement needed for it. |
| not-expressible | ⚪ | check `disposition = not-expressible` — no ground-truth check could be derived; this AC rested on human code review, never on an automated gate. |
| no derived check | ➖ | the AC has **no** active `ac_check` row (never classified). Listed so the projected count always reconciles against the ticket's full AC list — nothing silently disappears. |

**Multi-check ACs.** An AC may own more than one active check. Rollup rule:

- The AC is **verified** ✅ only if *all* its gating checks are green.
- A check that is `not-expressible`, or an environmental check still red post-implement, is
  **not swallowed** — it is carried as a **caveat** into the advisory section (§3), tagged
  to its AC. The AC's headline label reflects its gating checks; the caveat records the rest.

**Green-ness source.** "Green post-implement" is read from the `ac-check-post-implement`
signal for that check at the branch HEAD sha (M4's `rerunAcChecks` writes coarse there). The
gate having passed means the assertion/absence checks are green; M6 does not recompute — it
reads.

---

## §3 — The report structure (PR body text)

A new `### Change-scoped verify` block, inserted into `renderPrBody` **before** the existing
`⚠ Untested stacks` / `Precautionary runs on unowned changes` sections (those stay exactly
where they are — no churn). Every sub-section is **omitted entirely when it has nothing to
say**; a fully clean PR shows only the "Acceptance criteria" list of ✅s.

The wording is deliberately plain — the PR body is read across teams and by people with no
knowledge of the internal vocabulary. Section headings are sentences, and every status line
carries a second line explaining what its symbol means.

```
### Change-scoped verify

For each acceptance criterion on this ticket, Styre tried to write an automated
test that fails before the change and passes after it. Here is what those checks
found.

**Acceptance criteria**

- ✅ AC-1 — <acceptance criterion text>
  Confirmed by an automated test that failed before this change and passes now.

- ✅ AC-2 — <acceptance criterion text>
  Already working before this change. An automated test found the behavior was
  already present, so this criterion needed no new code.

- ⚪ AC-3 — <acceptance criterion text>
  Could not be checked automatically — no reliable test could capture this
  criterion, so it was left to human code review instead.

- ➖ AC-4 — <acceptance criterion text>
  No automated check was created for this criterion.

**Please review before merging — these did NOT block the merge**

These are advisory signals. Styre did not treat any of them as a reason to stop,
so a human should look before merging.

- ⚠️ The full integration test run FAILED (first failing job: `backend:test`).
  This was not used as a merge gate.

- ⚠️ The backend test suite FAILED. This was not used as a merge gate.

- ⚠️ The automated check for AC-3 is still failing, but the failure looks
  environmental (for example, missing tooling or configuration) rather than
  something this change caused.

**How the automated checks changed during verification**

- The automated check for AC-2 was rewritten mid-verification because the
  original one was judged wrong — it did not actually match the criterion.
  Reason: <arbiter's reason>.
```

**Sub-section sourcing.**

- **Acceptance criteria** — present whenever the ticket has ≥1 AC. One line per AC by `seq`,
  labelled per §2. This is the dispositions surface. AC text truncated to a single line
  (see §5).
- **Please review before merging** — present only when non-empty. Sources:
  - M4-demoted advisory signals with `result = fail` and `detail.advisory = true` at the
    branch HEAD sha: signal type `integration` → "full integration test run", signal type
    `<checkType>` → "`<checkType>` test suite". Each line ends "This was not used as a merge
    gate." — verbatim the M4 §7 promise that regression safety here rests on the human.
  - Environmental checks still red post-implement (from the AC caveats in §2): "The automated
    check for AC-N is still failing, but the failure looks environmental…".
- **How the automated checks changed during verification** — present only when a re-author
  happened: for each AC where an `ac-check-blame` verdict of `check-wrong` led to an
  `ac-check-reauthor`, one line carrying the arbiter's reason. (`installed` vs `rejected` is
  read from the reauthor signal; a `rejected` re-author still surfaces here — see §5.)

**The closing line.** Today `renderPrBody` unconditionally ends with *"Verified against the
project's checks and passed independent review."* M6 makes it honest: it is kept only when
**every AC is ✅ and the advisory section is empty**; otherwise it is dropped, because a
`not-expressible` AC or an advisory failure means "verified" would overclaim.

---

## §4 — Data flow & module boundary

One new pure module, **`src/dispatch/verify-report.ts`**, split into build + render so the
DB reads and the string formatting are testable in isolation:

```ts
// build: DB → structured facts (NO strings)
export type AcLine = {
  seq: number;
  text: string;
  label: "verified" | "satisfied" | "not-expressible" | "no-check";
};
export type AdvisoryLine =
  | { kind: "suite-fail"; checkType: string; firstFailingJob?: string }
  | { kind: "integration-fail"; firstFailingJob?: string }
  | { kind: "environmental-red"; seq: number };
export type ProvenanceLine = { seq: number; reason: string };
export type VerifyReport = {
  criteria: AcLine[];
  advisory: AdvisoryLine[];
  provenance: ProvenanceLine[];
  allClean: boolean; // every AC verified/satisfied AND advisory empty → keep closing line
};
export function buildVerifyReport(db: Database, ticket: TicketRow): VerifyReport;

// render: struct → markdown block (pure; no DB)
export function renderVerifyReport(report: VerifyReport): string;
```

- `buildVerifyReport` reads: `acceptance-criterion.listByTicket` (walk by `seq`),
  `ac-check.listActiveByTicket` (group by `ac_id`), the `ac-check-post-implement` coarse per
  check at HEAD, the demoted advisory signals at HEAD, and `latestBlameAtSha` /
  `latestReauthorAtSha`. It reads existing readers only — **no new repo query needs
  inventing** beyond thin helpers if a specific projection (e.g. "advisory suite fails at
  sha") isn't already a one-liner.
- `renderVerifyReport` is pure string work over the struct — the plain-language templates
  from §3 live here.
- `renderPrBody` (`src/dispatch/handlers.ts:306`) calls both and splices the block in ahead
  of the untested-stacks section. It already has `db` + `ticket` in scope at the
  `merge:pr-ensure` call site (`handlers.ts:~1598`), so **no signature ripple** outward.

**Transaction rule.** Everything is read at `merge:pr-ensure` time, inside the existing
merge-stage transaction, and folded into the `pr_create` payload that already enqueues there.
M6 adds **no** new `projection_outbox` enqueue — it enriches the body of one that already
fires — so the projector §2 same-txn invariant ("state and intent-to-project can never
disagree") is satisfied with zero new surface.

**Isolation seam.** build (DB → struct) is exercised against a real in-memory DB with seeded
records; render (struct → text) against hand-built structs. Neither test needs the other's
half.

---

## §5 — Edge cases & decisions

- **No ACs on the ticket.** The whole `### Change-scoped verify` block is omitted (there is
  nothing change-scoped to report); the PR body is exactly as today. `buildVerifyReport`
  returns empty `criteria` → `renderVerifyReport` returns `""`.
- **No `ac_check` rows but ACs exist.** Every AC lists as `➖ no derived check`. The block
  still renders (it truthfully reports "we derived no checks"), and the closing "Verified…"
  line is dropped (nothing was verified).
- **AC text length.** Truncate each AC's text to a single line (first line / first ~120 chars,
  ellipsis if cut) so one criterion never dominates the body. Full text lives in Linear.
- **Environmental check that flipped green post-implement.** Not an advisory line — it
  behaves like a verified check for its AC (green at HEAD). Only *still-red* environmental
  checks surface as advisory.
- **`rejected` re-author.** A re-author judged `rejected` (the arbiter declined to install a
  new check) still means the original check was judged check-wrong. It surfaces under "How
  the automated checks changed", worded to reflect that no replacement was installed
  ("…was judged wrong; no replacement check could be installed"). This never reaches MERGE
  as a *block* (that path escalates earlier via M5), but if it is present in history at merge
  time it is reported honestly.
- **Idempotency.** Inherited free — the `pr_create` payload is deterministic from frozen
  records, and the projector's existing probe (does the PR already exist / body match) makes
  re-drain a no-op. M6 introduces no new idempotency surface.
- **Multiple advisory failures of the same checkType.** De-duplicate to one line per
  `checkType` (latest at HEAD), so a retried suite doesn't stack identical warnings.

---

## §6 — Testing

**`renderVerifyReport` (pure, table-driven):**
- clean run (all ✅, no advisory, no provenance) → block with only the criteria list + the
  closing "Verified…" line retained.
- mixed run (✅ + ⚪ + ➖) → correct symbols/wording; closing line dropped.
- advisory-only failures (suite fail, integration fail, environmental-red) → the "Please
  review before merging" section with the exact "not used as a merge gate" wording.
- provenance present → the re-author line with reason; and its **absence** when no re-author.
- empty report → `""`.

**`buildVerifyReport` (real DB, seeded records):**
- an AC with an assertion check green at HEAD → `verified`.
- an AC with `disposition = satisfied` → `satisfied`.
- an AC with `disposition = not-expressible` → `not-expressible`.
- an AC with no active check → `no-check`.
- a superseded check does not leak into the rollup (only `listActiveByTicket`).
- a demoted `integration` fail + a `<checkType>` fail at HEAD → two advisory lines; a
  *pass* advisory signal → no line.
- an environmental check still red → one advisory caveat tagged to its AC; the same check
  green → none.
- an `ac-check-blame = check-wrong` + `ac-check-reauthor` at HEAD → one provenance line with
  the reason; a `code-wrong` blame → no provenance line.
- `allClean` true only when every AC verified/satisfied and advisory empty.

**Integration (renderPrBody):**
- the block is spliced **above** the existing untested-stacks section, and that section is
  unchanged when present.
- a full merge-stage e2e (extend an existing merge/pr-ensure test) asserts the composed PR
  body contains the criteria list for a ticket that went through the real gate.

---

## §7 — Requirements traceability (carried M6 reqs → this design)

| Carried requirement (source) | Satisfied by |
|---|---|
| "project the dispositions … to the MERGE gate" (M4 §1, M5 §1) | §2 rollup → §3 "Acceptance criteria" |
| "`satisfied` / `not-expressible` dispositions → don't gate (M6 surfaces)" (M4 §4) | §2 labels; §1 non-scope "any gating" |
| "M6 projects the sweep to the MERGE human; until then it's write-only" (M4 §7) | §3 "Please review before merging"; each line "not used as a merge gate" |
| "project … the advisory sweep …" (M5 §1/§10) | §3 advisory section (demoted suite/integration + environmental) |
| "project … the blame record to the MERGE human gate" (M5 §1/§7) | §3 "How the automated checks changed" (provenance, when re-authored) |
| "the AC-level rollup is a rollup M6 projects" (`schema.sql` acceptance_criterion comment) | §2 computed rollup; §4 `buildVerifyReport` |
| co-release / release-invariant enforced (M4 §8, M5 §0) | §0 — M6 completes the co-shipping set |

---

## §8 — What this is NOT (guardrails for the implementer)

- Not a gate. `buildVerifyReport` must never influence control flow — it is called only from
  `renderPrBody`, whose output is a string. No caller may branch on the report.
- Not a recompute. It reads M3/M4/M5 records; it must not re-run a check, re-classify, or
  re-adjudicate.
- Not a new outbox op. It rides the existing `pr_create`. No `add_comment` / `pr_comment`
  enqueue.
- Not a Linear write. PR body only.

---

## §11 — Changelog

- **2026-07-09** — Initial M6 design. Surface = PR body (`renderPrBody`); provenance shown
  only when a re-author happened; plain-language rendering (operator-directed). Awaiting
  independent review + operator sign-off.

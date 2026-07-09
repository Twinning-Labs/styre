# Change-scoped verify — M6: MERGE projection (final milestone)

**Status:** design v2 (independent review folded), awaiting operator sign-off
**Date:** 2026-07-09
**Branch/worktree:** `feat/change-scoped-verify-m6`
**Predecessors:** M1 (#59) · M2a (#62) · M2b (#63) · M3 (#64) · M4 (#65) · M5 (#66) — all merged to `main`.

---

## §0 — Context

M6 is the **final** milestone of change-scoped verify. Everything upstream computes and
records ground truth; M6 is the one-way *read* of those records onto the surface a human
sees when deciding to merge — the **GitHub PR body**. It adds no new gate, no new step, no
schema change, and no new agent dispatch. It touches exactly one thing beyond the read:
`ensurePr` gains a body-reconcile so the report reliably reaches the human (§1, I3).

**Release coupling (unchanged, restated):** the operator committed (2026-07-08) to not
releasing the feature until M6 is done. So M4's gate, M5's arbiter, and M6's projection
**co-ship by construction** — M4's gate never reaches a user without M6's MERGE projection
alongside it. This is the enforced answer to the adversarial review's "unenforced release
invariant" concern.

**The record families M6 reads** (all already written by M3/M4/M5; M6 only reads):

| Record | Milestone | Storage |
|---|---|---|
| clean-HEAD classification + disposition | M3 | `ac_check.red_class` (assertion/absence/environmental) · `ac_check.disposition` (satisfied/not-expressible) |
| post-implement flip (coarse per check) | M4 | `ground_truth_signal` type `ac-check-post-implement` |
| gate verdict | M4 | `ground_truth_signal` type `ac-check-gate` |
| demoted advisory suite/integration | M4 | `ground_truth_signal` type `<checkType>` / `integration`, `detail.advisory:true` |
| persistent-red blame | M5 | `ground_truth_signal` type `ac-check-blame` (code-wrong/check-wrong) |
| re-author disposition | M5 | `ground_truth_signal` type `ac-check-reauthor` (installed/rejected) |

---

## §1 — Scope & non-scope

**In scope.** At `merge:pr-ensure`, enrich the PR body with a **"Change-scoped verify"**
section built from the records above, and make `ensurePr` keep that body current. Three
concerns projected:

1. **Dispositions** — the per-AC rollup (§2), one line per acceptance criterion.
2. **Advisory sweep** — the non-blocking failures that rest on the human as the regression
   net: M4-demoted whole-suite / `integration` failures/errors + environmental checks still
   red post-implement.
3. **M5 provenance** — when (and only when) a check was re-authored, plus the C1 downgrade
   for a check judged wrong and left unreplaced.

**Surface decision (operator, 2026-07-09):** the **PR body** (`renderPrBody`), not a
separate PR comment or Linear comment. It is the single surface the merging human already
reviews; the records are frozen by the time a ticket reaches `merge`.

**Body reliability — the one projector touch (operator, 2026-07-09, folds review finding I3):**
`ensurePr` today reuses an existing open PR and returns it **without updating the body**
(`src/integrations/adapters/github.ts:115`) — only the create path sends `body`. So a report
spliced into the body would appear *only* when styre creates the PR itself, and would
silently never appear on a pre-existing PR (an operator-opened draft, or a re-run against an
existing PR). M6 therefore extends `ensurePr`: when it finds an existing open PR whose body
differs from the composed one, it updates the body (`octokit.pulls.update`). "Ensure the PR"
now also ensures the body. This is the single change outside the pure read.

**Provenance prominence decision (operator, 2026-07-09):** the provenance section appears
**only when a re-author actually happened**. Silent on the common clean run.

**Not in scope / explicitly NOT M6:**

- **Any gating.** M6 never blocks. Dispositions and the advisory sweep are report-only by
  construction — the hard gate is M4's `verify:checks-gate`, untouched here.
- The deferred **regression-guard** (which would eventually make the advisory sweep
  blocking) — still deferred; M6 projecting the sweep is precisely the interim "rests on the
  human" surface the M4 §7 named-risk promised.
- **Linear.** PR body only. No `add_comment` writer introduced.
- **No new `projection_outbox` op.** M6 rides the existing `pr_create`; the only projector
  code it touches is the `ensurePr` body-reconcile above.
- No change to how records are *computed* — M6 reads M3/M4/M5 outputs verbatim.

---

## §2 — The disposition rollup (per-AC)

Dispositions are stored per **check** (`ac_check.disposition` / `.red_class`), not per AC —
*"the AC-level assessed-satisfied is a rollup M6 projects … M6 projects the AC-level rollup"*
(`schema.sql` acceptance_criterion comment). M6 computes the rollup: walk the ticket's
acceptance criteria by `seq`, group active `ac_check` rows (`superseded_at IS NULL`) by
`ac_id`, and assign each AC exactly one headline label by the **precedence** below (first
match wins). Precedence exists so mixed/multi-check ACs are deterministic and never
over-claim.

| # | Label | Symbol | Matches when (over the AC's active checks) |
|---|---|---|---|
| 1 | check judged wrong, not replaced | ⚠️ | any active check has a **`rejected`** re-author in its history — the check was ruled check-wrong and no correct replacement was installed, so its passing status may not reflect the criterion (review finding **C1**) |
| 2 | verified | ✅ | has ≥1 gating check (`red_class` ∈ {assertion, absence}) **and all gating checks are green** at HEAD |
| 3 | still red (unexpected) | ⚠️ | has a gating check that is **not** green at HEAD (defensive — should be unreachable since the gate passed; never silently shown as ✅) |
| 4 | not-expressible | ⚪ | a check with `disposition = not-expressible` — no ground-truth check could be derived; rested on human review |
| 5 | could not be checked reliably (environmental) | ⚪ | an `environmental` check (green **or** red) and no gating check — environmental checks never gate and can pass vacuously, so this is never "verified" (review finding **I1**) |
| 6 | satisfied (pre-existing) | ✅ | a check with `disposition = satisfied` — green on clean HEAD, needed no new code |
| 7 | no derived check | ➖ | no active `ac_check` row — listed so the projected count reconciles against the ticket's full AC list; nothing silently disappears |

**Green-ness source.** "Green at HEAD" is read from the newest `ac-check-post-implement`
signal for that check at the branch HEAD sha (§4). M6 never recomputes — it reads.

**`allClean`** (drives the honest closing line, §3) is true **only** when every AC is label
2 (verified) or 6 (satisfied) **and** the advisory section is empty. Labels 1, 3, 4, 5, 7 all
force `allClean = false`.

**Caveats, not swallowing.** A `not-expressible` or `environmental` or still-red check that
does **not** dominate the headline (e.g. an environmental check on an AC whose gating check
is green) is still surfaced as a **caveat** in the advisory section (§3), tagged to its AC.

---

## §3 — The report structure (PR body text)

A new `### Change-scoped verify` block, inserted into `renderPrBody` **before** the existing
`⚠ Untested stacks` / `Precautionary runs on unowned changes` sections (those stay exactly
where they are — no churn). Every sub-section is **omitted entirely when it has nothing to
say**; a fully clean PR shows only the "Acceptance criteria" list of ✅s plus the closing
line.

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

- ⚪ AC-4 — <acceptance criterion text>
  Could not be checked reliably — the automated check needs tooling or
  configuration that was not available here (an "environmental" check), so its
  result does not confirm the criterion. Please confirm by review.

- ⚠️ AC-5 — <acceptance criterion text>
  A check for this criterion was judged to not actually match it, and no correct
  replacement could be created. The criterion may show as passing without truly
  being met — please verify this one carefully by review.

- ➖ AC-6 — <acceptance criterion text>
  No automated check was created for this criterion.

**Please review before merging — these did NOT block the merge**

These are advisory signals. Styre did not treat any of them as a reason to stop,
so a human should look before merging.

- ⚠️ The full integration test run FAILED (first failing job: `backend:test`).
  This was not used as a merge gate.

- ⚠️ The `backend` test suite did not pass (result: error). This was not used as
  a merge gate.

- ⚠️ The automated check for AC-3 is still failing, but the failure looks
  environmental (for example, missing tooling or configuration) rather than
  something this change caused.

**How the automated checks changed during verification**

- The automated check for AC-2 was rewritten mid-verification because the
  original one was judged wrong — it did not actually match the criterion.
  Reason: <arbiter's reason>.

- The automated check for AC-5 was judged wrong and could not be replaced with a
  correct one. Reason: <arbiter's reason>.
```

**Sub-section sourcing.**

- **Acceptance criteria** — present whenever the ticket has ≥1 AC. One line per AC by `seq`,
  labelled per §2's precedence. This is the dispositions surface. AC text is truncated to a
  single line and **escaped** before splicing (§5 M3).
- **Please review before merging** — present only when non-empty. Sources, all
  **sha-agnostic** (latest per source — review finding I2):
  - The **latest** advisory signal per `checkType` and for `integration` whose
    `detail.advisory = true` and `result ∈ {fail, error}` (review finding M1: include
    `error`). Selection filters on `json_extract(detail_json,'$.advisory') = true` (the
    boolean), never a hard-coded type list, and never on `advisory` merely being *present*
    (the `ac-check-gate` signal also carries an `advisory` key whose value is a `number[]`,
    not `true`, and must not match). Signal type `integration` → "full integration test run";
    signal type `<checkType>` → "`<checkType>` test suite". Each line ends "This was not used
    as a merge gate." — the M4 §7 promise verbatim.
  - Environmental checks still red at HEAD (the caveats from §2): "The automated check for
    AC-N is still failing, but the failure looks environmental…".
- **How the automated checks changed during verification** — present only when a re-author
  happened. For each AC whose active/most-recent check has a re-author record:
  - `installed` → "was rewritten mid-verification because the original one was judged wrong",
    carrying the blame reason (the new check is correct-shape and RED-first-validated, so the
    AC's headline is ✅ verified).
  - `rejected` → "was judged wrong and could not be replaced", carrying the blame reason
    (this is the C1 case; the AC's headline is ⚠, label 1).

**The closing line.** Today `renderPrBody` unconditionally ends with *"Verified against the
project's checks and passed independent review."* M6 makes it honest: kept **only** when
`allClean` (every AC verified/satisfied and no advisory); otherwise dropped, because a ⚠/⚪
AC or an advisory failure means "verified" would overclaim.

---

## §4 — Data flow, readers & module boundary

One new pure module, **`src/dispatch/verify-report.ts`**, split into build + render so DB
reads and string formatting are testable in isolation:

```ts
// build: DB → structured facts (NO strings)
export type AcLabel =
  | "verified" | "satisfied" | "not-expressible"
  | "environmental" | "still-red" | "check-unreplaced" | "no-check";
export type AcLine = { seq: number; text: string; label: AcLabel };
export type AdvisoryLine =
  | { kind: "suite"; checkType: string; result: "fail" | "error"; firstFailingJob?: string }
  | { kind: "integration"; result: "fail" | "error"; firstFailingJob?: string }
  | { kind: "environmental-red"; seq: number };
export type ProvenanceLine = { seq: number; disposition: "installed" | "rejected"; reason: string };
export type VerifyReport = {
  criteria: AcLine[];
  advisory: AdvisoryLine[];
  provenance: ProvenanceLine[];
  allClean: boolean;
};
export function buildVerifyReport(db: Database, ticketId: number): VerifyReport;

// render: struct → markdown block (pure; no DB)
export function renderVerifyReport(report: VerifyReport): string;
```

`buildVerifyReport` takes **`ticketId: number`**, not a `TicketRow` — `renderPrBody`'s
`ticket` param is narrowed to `{ id; ident; title }` (`handlers.ts:306`), and every reader
keys on `ticket.id` (review finding M1). It derives the branch HEAD sha itself via
`getLatestForTicket(db, ticketId)?.branch_head_sha` (the pattern already used at
`handlers.ts:1317/1353/1393/1580`; a **null** sha — no dispatch ever completed — means no
advisory/post-implement rows and is handled, not thrown; review finding M2-feas).

**Existing readers reused:** `acceptance-criterion.listByTicket` (ORDER BY seq),
`ac-check.listActiveByTicket` (`superseded_at IS NULL`).

**New thin readers M6 must add** (all simple `SELECT … FROM ground_truth_signal` with a
`json_extract` and an `ORDER BY measured_at DESC`; the feasibility review confirmed none
exist yet — the doc no longer claims "existing readers only"):

1. `latestPostImplementForEachAcCheck(db, ticketId, sha) → { acCheckId, acId, coarse }[]` —
   newest `ac-check-post-implement` per `acCheckId` at `sha` (newest-wins; review finding
   M2-adv). Powers "verified/green" and "environmental still-red".
2. `latestAdvisorySweep(db, ticketId) → { type, result, firstFailingJob? }[]` — newest
   advisory suite/`integration` signal per type, **sha-agnostic**, filtered on
   `json_extract(detail_json,'$.advisory') = 1` (SQLite boolean-true) and `result != 'pass'`
   (review finding I2 + M1). Powers the advisory suite/integration lines.
3. `reauthorProvenanceForTicket(db, ticketId) → { acId, acCheckId, disposition, reason }[]` —
   newest `ac-check-reauthor` per `acCheckId` joined to its `ac-check-blame` `reason`,
   sha-agnostic. Powers both the provenance section **and** the C1 label-1 detection (an
   active check with a `rejected` provenance row → `check-unreplaced`).

`renderVerifyReport` is pure string work over the struct: the plain-language templates from
§3 live here.

`renderPrBody` (`handlers.ts:306`) calls both and splices the block ahead of the
untested-stacks section, and conditionally emits the closing line on `report.allClean`. It
already has `db` + `ticket` in scope at the `merge:pr-ensure` call site (`handlers.ts:1598`).

**`ensurePr` body-reconcile (I3).** `ForgePort.ensurePr` (and the github + fake-forge
adapters) gains: when an existing open PR is found and its body differs from the composed
body, update it (`octokit.pulls.update({ owner, repo, pull_number, body })`) before
returning. The fake-forge adapter records the update so tests can assert it. The composed
body must be **deterministic** (stable ordering — review finding M6) so an unchanged report
does not churn the update.

**Transaction rule.** Everything is read at `merge:pr-ensure` time inside the existing
merge-stage transaction and folded into the `pr_create` payload that already enqueues there.
M6 adds no new `projection_outbox` enqueue — it enriches an existing one — so the projector
§2 same-txn invariant holds with zero new outbox surface.

**Isolation seam.** build (DB → struct) is exercised against a real seeded in-memory DB;
render (struct → text) against hand-built structs; the ensurePr reconcile against the
fake-forge adapter. None needs another's half.

---

## §5 — Edge cases & decisions

- **No ACs on the ticket.** The whole `### Change-scoped verify` block is omitted;
  `buildVerifyReport` returns empty `criteria` → `renderVerifyReport` returns `""`; the PR
  body is exactly as today.
- **No `ac_check` rows but ACs exist.** Every AC is `➖ no derived check`; block still renders
  truthfully; closing line dropped.
- **AC text (M3 — injection safety).** Truncate to a single line (first line / ~120 chars,
  ellipsis if cut) **and escape**: strip embedded newlines, and neutralize leading markdown
  (`-`, `#`, `|`, `>`) and inline hazards (backticks, `<!-- -->`, `</details>`) so a crafted
  AC cannot break the list or inject markup into a cross-team PR body.
- **Environmental check green at HEAD.** Never `verified` (label 5 / ⚪). An environmental
  `red_class` means the check could not run on clean HEAD (missing tooling/config), so a
  green is vacuous — "confirmed by a test that failed before and passes now" would be false.
- **`rejected` re-author (C1).** Detected via reader 3: an active check with a `rejected`
  provenance row → label 1 (⚠ check-unreplaced), `allClean = false`, and a provenance line.
  This is the arbiter-verdict path (`arbiter-verdict.ts:171` — a rejected re-author loops
  back to re-code, it does **not** escalate; the wrong-shape check stays active and can be
  greened by coding to the wrong shape, reaching merge). M6 must not label it verified.
- **Idempotency / body freshness (I3).** The composed body is deterministic from frozen
  records; `ensurePr` now reconciles the body on an existing PR, so the report reliably
  appears and a re-drain with an identical body is a no-op (bodies compare equal → no update).
- **Multiple advisory failures of the same type.** Reader 2 returns one row per type (newest),
  so a retried suite does not stack duplicate warnings.
- **PR body size (M6).** GitHub caps the body at 65536 chars. A ticket with very many ACs
  could approach it; M6 renders one compact 2-line entry per AC and the advisory/provenance
  sections are bounded by the number of checks. If a future ticket is pathologically large
  this is a known ceiling (documented, not guarded) — the report degrades by GitHub
  truncation, never by a styre crash.

---

## §6 — Testing

**`renderVerifyReport` (pure, table-driven):**
- clean run (all ✅ verified/satisfied, no advisory, no provenance) → criteria list + closing
  "Verified…" line retained.
- each label renders its exact symbol + explanatory second line (verified, satisfied,
  not-expressible, environmental, still-red, check-unreplaced, no-check).
- advisory section: suite `fail`, suite `error`, integration `fail`, environmental-red → the
  "not used as a merge gate" wording; empty advisory → section omitted.
- provenance: `installed` line and `rejected` line render distinctly; no re-author → section
  omitted.
- `allClean` false whenever any AC is ⚠/⚪/➖ or advisory non-empty → closing line dropped.
- empty report (`criteria: []`) → `""`.

**`buildVerifyReport` (real seeded DB):**
- assertion check green at HEAD → `verified`; `disposition=satisfied` → `satisfied`;
  `disposition=not-expressible` → `not-expressible`; environmental (green **and** red) →
  `environmental`; no active check → `no-check`.
- an active check with a `rejected` re-author → `check-unreplaced` (label 1) even if its
  post-implement coarse is green (the C1 regression test).
- a superseded check does not leak into the rollup (only `listActiveByTicket`).
- precedence: an AC with a green gating check **plus** an environmental check → headline
  `verified`, environmental surfaced as an advisory caveat.
- advisory: a demoted `integration` fail + a `<checkType>` error, both sha-agnostic and at a
  **different** sha than HEAD, still surface (the I2 regression test); an `ac-check-gate`
  signal (whose `detail.advisory` is a `number[]`) is **not** mis-selected; a `pass` advisory
  → no line.
- `installed`/`rejected` provenance rows produce the right lines with the blame reason; a
  `code-wrong` blame with no re-author → no provenance line.

**`ensurePr` reconcile (fake-forge + adapter):**
- existing PR whose body differs → `octokit.pulls.update` called with the new body; identical
  body → no update; no existing PR → create path unchanged.

**Integration (renderPrBody + merge e2e):**
- the block splices **above** the existing untested-stacks section, which is unchanged when
  present.
- extend `test/dispatch/merge-e2e.test.ts` / `merge-handlers.test.ts`: seed
  acceptance_criterion + ac_check + ground_truth_signal rows **at `branch_head_sha="headsha123"`**
  (the seeded dispatch's sha, so the at-HEAD reads resolve — feasibility review) and assert
  the composed PR body contains the criteria list.

---

## §7 — Requirements traceability (carried M6 reqs → this design)

| Carried requirement (source) | Satisfied by |
|---|---|
| "project the dispositions … to the MERGE gate" (M4 §1, M5 §1) | §2 rollup → §3 "Acceptance criteria" |
| "`satisfied` / `not-expressible` dispositions → don't gate (M6 surfaces)" (M4 §4) | §2 labels 4/6; §1 non-scope "any gating" |
| "M6 projects the sweep to the MERGE human; until then it's write-only" (M4 §7) | §3 "Please review before merging"; each line "not used as a merge gate" |
| "project … the advisory sweep …" (M5 §1/§10) | §3 advisory section (demoted suite/integration + environmental), sha-agnostic (I2) |
| "project … the blame record to the MERGE human gate" (M5 §1/§7) | §3 "How the automated checks changed" + §2 label 1 (C1) |
| "the AC-level rollup is a rollup M6 projects" (`schema.sql`) | §2 computed rollup; §4 `buildVerifyReport` |
| co-release / release-invariant enforced (M4 §8, M5 §0) | §0 — M6 completes the co-shipping set |
| no false-green on the human surface (feature-wide invariant) | §2 labels 1/3/5 + `allClean` never over-claim (C1, I1) |

---

## §8 — What this is NOT (guardrails for the implementer)

- **Not a gate.** `buildVerifyReport` must never influence control flow — it is called only
  from `renderPrBody`, whose output is a string. No caller may branch on the report.
- **Not a recompute.** It reads M3/M4/M5 records; it must not re-run a check, re-classify, or
  re-adjudicate.
- **Not a new outbox op.** It rides the existing `pr_create`. The only projector-side change
  is the `ensurePr` body-reconcile (§1/§4). No `add_comment` / `pr_comment` enqueue.
- **Not a Linear write.** PR body only.
- **Never over-claim.** When ground truth is ambiguous (rejected re-author, environmental,
  unexpectedly-red gating check), the label is ⚠/⚪ and `allClean` is false — never ✅.

---

## §11 — Changelog

- **2026-07-09 (v2)** — Folded independent review (feasibility + adversarial, Opus,
  code-grounded). Fixes: **C1** rejected-re-author false-green → new ⚠ "check judged wrong,
  not replaced" label consulting the reauthor records; **I1** environmental checks → dedicated
  ⚪ label, never verified; **I2** advisory sweep read sha-agnostically (was "at HEAD",
  dropping suite failures after a check-only re-serve); **I3** `ensurePr` gains a
  body-reconcile so the report reliably reaches the human (operator-approved, the one
  projector touch). Minors folded: include `error` advisory, newest-wins reads, AC-text
  escaping, disposition precedence, PR-body size note + deterministic ordering, `ticketId`
  param + internal sha derivation, and honest enumeration of the three new thin readers.
- **2026-07-09 (v1)** — Initial M6 design. Surface = PR body; provenance only when a
  re-author happened; plain-language rendering (operator-directed).

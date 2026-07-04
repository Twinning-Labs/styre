# Completeness Module — Design (v3)

**Status:** v3 — **plan-layer-only**, hardened after two review rounds (a 4-reviewer v1 panel that split off the semantic AC layer, then a 2-reviewer v2 recheck that found three correctness refinements). The semantic **AC-completeness** layer remains deferred to its own follow-up (folded into the S5 review stage — §8). This is the design the implementation plan is built from.
**Branch:** `feat/completeness-module`
**Absorbs:** the advisory `scope_diff` verify check (`handlers.ts:744-761`) and (with a boundary change, not a wholesale delete) the `implement:dispatch` empty-diff postcondition (`handlers.ts:353-357`).

---

## 1. Problem

styre's `implement` stage decomposes a ticket into per-`work_unit` dispatches over a **shared per-ticket worktree**, run **strictly sequentially** (`nextActionableUnit`, `resolver.ts:38-50` — a unit is fully verified before the next is implemented). The loop checks **sufficiency-of-quality** (does the code build/test green — verify) but never **completeness** (was the declared work actually done). That gap produces two opposite failures:

- **False block (the observed bug).** An over-decomposed/redundant unit whose work a sibling already did produces an empty diff; the `implement:dispatch` empty-diff postcondition hard-fails, retries 3×, escalates. Observed live on `darkreader__darkreader-7241`: wu1's committed diff was byte-for-byte the gold fix, wu2 was vacuous — styre blocked a fully-resolved ticket that would have been its first resolved bench instance.
- **False resolve.** A unit that under-delivers (declares a file, doesn't touch it) sails through verify whenever the test suite doesn't cover the missing work.

## 2. Scope of v1 — and what it deliberately does not promise

**v1 fixes the false-block and catches the *single-unit-declared* subset of under-delivery.** It is **not** a completeness guarantee.

| # | Incomplete-work scenario | v1 plan layer |
|---|---|---|
| A1 | Redundant/over-decomposed unit → empty diff (darkreader) | ✅ `covered-by-sibling` no-op (the fix) |
| A2 | Necessary unit skipped, declared file untouched by **anyone** | ✅ `under-delivered` → loopback implement |
| A3 | Missed a declared file, **declared by exactly one unit** | ✅ caught before verify |
| A3′ | Missed/mis-did work on a declared file **also touched by another unit** | ❌ **NOT caught** — sibling touch counts as coverage at file granularity (§7) |
| A4 | Design dropped an AC — no unit declared it | ❌ plan checks itself — AC-completeness follow-up (§8) |
| A5 | A planned unit never dispatched | ✅ structurally guarded (§3.5) |
| A6 | **Vacuous planned unit** — no declared files | ✅ **rejected at the plan gate, never reaches implement** (§3.4) |
| B1–B4 | File touched but change stubbed/partial/not-wired | ❌ below file granularity — AC-completeness follow-up + verify |
| C2 | Over-reach (touched-but-undeclared) | ✅ advisory `scope_diff`, own-diff-based (§3.3) |

Two structural facts drive the design: the **plan is structured** (`work_unit.files_to_touch` etc. — a plan-anchored check is deterministic and free); and `files_to_touch` is authored by the **same design agent** that decides the work, so a plan-anchored check verifies *self-consistency* (implement matches plan), not *validity* (plan matches ticket). The validity gap (A4) is out of v1.

## 3. Design — the plan layer (deterministic, per-unit)

One module `src/dispatch/completeness.ts` (pure core + handler, same shape as `provision.ts`). It **absorbs** `scope_diff`. Its pure core takes **two** touched sets, because under- and over-delivery need opposite bases (§3.1):

```ts
reconcileScope(declared: string[], cumulativeTouched: string[], ownTouched: string[])
  : { under: string[]; over: string[] }
// under = declared − cumulativeTouched   (did ANYONE touch the declared file?)
// over  = ownTouched − declared           (did THIS unit touch a file it didn't declare?)
```

Runs as a new step `completeness:wuN`, resolver-gated between `implement:wuN` and `verify:wuN` — a mirror of the existing `provision` gate: at `resolver.ts:112-119` (the `u.status === "verifying"` branch), **after** the provision gate (`:113-115`) and **before** `nextUnrunCheck` (`:116`), keyed via `done(db, ticketId, "completeness:wu${seq}")`.

### 3.1 Two base refs (the load-bearing correctness point)

The module computes **two** diffs via `changedFilesBetween(base, head, worktree)` (`worktree.ts:62-70`):

- **`cumulativeTouched`** — base = the **lowest-seq unit's `base_sha`** (the ticket fork point). Used for `under`, so darkreader's wu2 sees wu1's changes and is `covered-by-sibling`. The min-seq unit is `listByTicket(...)[0]` (seq-ordered, `work-unit.ts:31-35`); `validateExtraction` guarantees seq-1 exists, has no deps, and codes first (`extract-schema.ts:107-115,126-132`), so its `base_sha` is stable across loopbacks (set once under `if (base_sha === null)`, `handlers.ts:337`) and is never displaced by the appended `reconcile` unit (`seq=max+1`). **Do NOT use the processed unit's own `base_sha`** — for wu2 that is HEAD-*after*-wu1, which excludes wu1's changes and re-breaks darkreader.
- **`ownTouched`** — base = the **processed unit's own `base_sha`** + `getLatestByWorkUnit(unit)` (exactly what `verify:check` uses today, `handlers.ts:505,512-514`). Used for `over` and for "own diff empty" detection.

Caveats to state, none fatal: (1) the min-seq base is fork-point *plus the design-plan commit* (`docs/plans/*.md`, `handlers.ts:192-199`) — desirable, since it excludes the plan doc from `touched`, but "fork point" is loose. (2) A re-provisioned/wiped worktree mid-ticket (`git worktree add -B`, `worktree.ts:19`) can reset the branch pointer and corrupt *any* base..head diff — pre-existing and not completeness-specific, but this design rests on it. (3) Guard against a null min-seq `base_sha` (would throw in `changedFilesBetween`).

### 3.2 Dispositions

| plan outcome | disposition | consequence |
|---|---|---|
| `under ≠ ∅` (declared file untouched by anyone) | `under-delivered` | **hard gate** → loopback `implement:wuN` + missing-files feedback (§4) |
| `under = ∅` **and** `ownTouched = ∅` (declared covered by siblings, this unit did nothing) | `covered-by-sibling` | **no-op success, advance** (the darkreader fix) |
| `under = ∅` **and** `ownTouched ≠ ∅` | `completed-by-self` | advance (no routing) |

### 3.3 Over-delivery — advisory, own-diff-based

`over = ownTouched − declared` (the unit's **own** commits vs its declared scope). Emitted as the preserved `scope_diff` advisory signal, never blocks. It **must** use `ownTouched`, not `cumulativeTouched` — a cumulative `over` would flag every prior unit's files as this unit's over-reach (the last unit would be flagged as over-reaching the whole ticket). This preserves today's `verify:check` behavior exactly. Rationale for staying advisory: real fixes routinely exceed the plan; over-delivered code is already verified by component gates + WO-5's run-all-unowned sweep; its residual risk is *validity*, the AC-completeness follow-up's job.

### 3.4 No empty tasks reach implement (the plan gate — closes A6)

A **vacuous planned unit** (no declared files, no concrete work) is a **planning defect, not an implement defect** — looping it back to implement is incoherent (no files, no instruction; the agent returns empty again → burns the retry budget → escalates a task that never had work in it). It is caught at the stage that owns it:

- **`validateExtraction` requires every planned unit to declare ≥1 `files_to_touch`** (`extract-schema.ts` — generalize the existing behavioral rules at `:117-125` to all units). A vacuous unit fails plan validation → transport-failure re-dispatch of `design/extract` → the **design agent re-plans**. Implement's precondition becomes "the unit has real declared scope," so **implement never receives an empty task.** Fail-fast, correction assigned to the responsible stage — the same "route by owning stage" principle used for the AC layer (§8).

This **replaces** the runtime empty-diff guard proposed in v2. Once no planned unit is vacuous, a unit that does nothing has declared files → `under-delivered` → a *coherent* "touch these files" loopback that converges. The old `implement:dispatch` empty-diff postcondition is therefore removed (its one real job — catching "produced literally nothing" — is now done by under-delivery on the guaranteed-non-empty declared set).

**One exemption:** the runner-created `reconcile` unit (`failure-policy.ts:140-162`) declares no files by design and is *not* agent-planned, so the plan gate doesn't touch it; with `declared = ∅` it can only be `covered-by-sibling`/`completed-by-self` and is governed by `verify:integration`, not completeness. (Also: the direct-insert fixture at `implement-allowlist.test.ts:110` is a test shape, not a production planning path.)

### 3.5 A5 — unit-terminal, already structural

A silently-skipped unit is `pending`/`verifying`, so `allUnitsVerified` (`resolver.ts:76-79`) is false and the implement→review advance never fires (control falls to `blocked`, `resolver.ts:140`). No new dispatch needed; optionally add an explicit escalation at that site if a stuck unit should escalate rather than surface as `blocked` (§10).

## 4. Loopback routing (plan layer only)

| outcome | routes to | bound | after bound |
|---|---|---|---|
| under-delivery | loopback `implement:wuN` (same unit) + missing-files feedback | per-step `maxAttempts` (3); **must replicate `isRepeatedFailure`** | **escalate** |
| covered-by-sibling / completed-by-self | advance, no routing | — | — |
| over-delivery | advisory `scope_diff` → verify | — | — |

**Honest bound (v2 correction).** There is **no** shared per-unit budget: `attempt` is per-`workflow_step` (`workflow-step.ts:103`), the escalation guard is `step.attempt >= maxAttempts` on the failing step (`failure-policy.ts:57`), and `resetToPending` does **not** clear `attempt`. So `completeness:wuN` and `verify:wuN` each carry an independent 3-attempt cap → worst case ≈ `maxAttempts × |{completeness, verify}|` (~6) implement re-dispatches in the pathological alternating-failure case. It is *bounded* (not unbounded thrash — the preserved `attempt` counter saves it), but it is **not** a single shared cap. v1 therefore:
- States the honest bound (per-step) and **requires the `completeness` branch to replicate `isRepeatedFailure`** (`failure-policy.ts:40-44,107`) — else a re-coded-but-still-under-delivering unit burns 3 attempts instead of escalating at 2.
- Adds a **dedicated `completeness` branch** in `applyFailurePolicy` (do **not** reuse `step_type: "verify"` — `latestVerifyResult`, `:29-36`, parses the check-type off the step_key and reads `ground_truth_signal` rows, so a masquerading completeness step mis-keys that lookup). The branch resets the unit + its steps to `pending` (mirror `:122-134`) and routes to implement. It must **not** fall through to the default `retry` branch (`:164-165`), which would re-run the deterministic check to the identical result 3× and escalate **without re-dispatching implement**.
- A true single per-unit cap (count unit-scoped `loopback` events — the `isUnitLoopback` pattern, `handlers.ts:111-115`) is a recommended fast-follow if the ~2× worst-case spend proves material under credit limits (§10).

## 5. Code movement & wiring

- **`validateExtraction`:** every planned unit ⇒ `files_to_touch` non-empty (`extract-schema.ts`) — closes A6 at the plan gate (§3.4). *Contract change:* a previously-valid vacuous extraction now becomes a transport-failure re-dispatch of `design/extract` (intended).
- **Remove** the `implement:dispatch` empty-diff postcondition (`handlers.ts:353-357`) — subsumed by §3.4 + under-delivery.
- **Move** `scope_diff` out of `verify:check` (`handlers.ts:744-761`) into the module, computed against the **own** diff (§3.3). Self-contained block (reads only `latestSha`, `parseFilesToTouch`, `changed`, a dedup probe, `insertSignal`) — a lift-and-shift.
- **Resolver:** gate `completeness:wuN` (mirror `provision`, §3).
- **`failure-policy`:** a dedicated `completeness` branch (§4).
- **Base refs:** two diffs (min-seq cumulative + per-unit own), §3.1.
- **Signals:** a `completeness` signal (per-unit; `under` + disposition); `scope_diff` preserved for over-delivery (own-diff-based).
- **Step catalog:** add `completeness:wuN` to `control-loop.md` + `minimal-loop.md` + the Loopback Atlas under-delivery row. Touches the *closed* catalog — same care as the `provision` addition; doc revision + independent review required. No `VERDICT_BEARING_STEPS` change (the plan layer is a deterministic runner-computed step, not an agent dispatch).

## 6. Invariants preserved

- **Ground truth over self-report.** Deterministic — facts (`files_to_touch`) vs facts (the diff). No agent judgment.
- **Durable journal / exactly-once.** The plan layer is **recomputable** (like `provision`/verify) — no exactly-once effect; safe to re-run on replay. *(This is why the AC layer was split off: a journaled agent dispatch could not be re-judged after a corrective loop without violating "a succeeded step returns its recorded result on replay" — §8.)*
- **Single transactional SoT / only the runner writes.** Signals + state changes in one transaction.
- **Capability isolation.** No new agent capabilities.

## 7. What v1 does NOT catch (honest limits)

- **Multi-unit-same-file under-delivery (A3′)** — "touched by any sibling counts" is *required* for the darkreader fix and can't be tightened at file granularity without re-breaking it. For a file declared by ≥2 units the under-delivery check is **inert**, and this covers not just "did nothing" but "did the *wrong* work": if wu2 declares `auth.ts` (already touched by wu1) but edits only unrelated `helpers.ts`, `under = ∅`, `ownTouched ≠ ∅` → `completed-by-self` → advances, and `auth.ts`'s real work is never done. Common (a feature unit + its test unit routinely share a file), so v1's false-resolve *prevention* is real but partial; its load-bearing win is the darkreader false-*block* fix plus single-unit-declared under-delivery.
- **Content-incompleteness (B1–B4)** — stubs, partial multi-site edits, not-wired code. Below file granularity.
- **Plan↔ticket gap (A4)** — a dropped AC no unit declared.

All three are the **AC-completeness follow-up's** job (§8), backstopped meanwhile by verify.

## 8. Follow-up: AC-completeness as an S5 review finding (separate design)

The semantic completeness layer is deferred and should **fold into the existing S5 review stage, not a parallel journaled step** — the standalone version broke three ways: (1) a corrective unit appended for a dropped AC runs *last*, when the cumulative diff is maximal, so the plan layer marks it `covered-by-sibling` and it no-ops — self-defeating; (2) a journaled `completeness:ticket` dispatch cannot be re-judged after a corrective loop without resetting a succeeded step, violating exactly-once; (3) advisory-after-one-attempt degrades to a false-resolve-with-a-label, near-zero gating value in the OSS-`run`/bench terminal. S5 already is an independent cold-context reviewer with citable findings, category routing (`plan-defect` → design), and an **accepted hard-block** — "AC #k unaddressed" is a new finding category there. Covers A4, A3′, and B*. Its own spec, sequenced after v1 lands.

## 9. Testing strategy (for the plan)

- **darkreader / A1:** wu2 `ownTouched=∅`, declared covered by wu1's cumulative diff ⇒ `covered-by-sibling`, advance (no block).
- **A2:** declared file untouched by anyone ⇒ `under-delivered` ⇒ loopback implement; escalate after bound.
- **A3 (single-unit-declared):** unit misses a file only it declared ⇒ `under-delivered` before verify runs.
- **A3′ (multi-unit-same-file):** wu2's declared file already touched by wu1, wu2 does unrelated work ⇒ `completed-by-self`, advances — a test that **documents the known limit** (§7).
- **A6 (vacuous unit — plan gate):** `validateExtraction` rejects a planned unit with empty `files_to_touch`; assert re-dispatch of `design/extract`, and that no such unit reaches `implement`.
- **Over-delivery base:** a multi-unit ticket where a cumulative `over` would wrongly flag a sibling's files — assert `over` uses the **own** diff (guards §3.3).
- **Base-ref regression:** a two-unit ticket where the *per-unit* base would exclude wu1 — assert `under` uses the **min-seq** base (guards §3.1).
- **Reconcile exemption:** the appended `reconcile` unit (declared=∅) is not rejected and resolves to `covered-by-sibling`/`completed-by-self`.
- **Thrash bound:** interleaved completeness↔verify loopbacks escalate at the honest per-step bound; `isRepeatedFailure` escalates a repeated identical under-delivery at 2.

## 10. Open items for the plan

- Base ref: min-seq unit `base_sha` (recommended, no schema change) vs a new `ticket.base_sha` column.
- The loopback bound: accept the honest per-step cap for v1 (with `isRepeatedFailure`) vs build a true unit-scoped `loopback`-event counter now (§4).
- Exact `completeness` signal schema + disposition enum values.
- Whether a stuck unit at A5 should escalate or remain `blocked` (§3.5).
- Update the direct-insert test fixture (`implement-allowlist.test.ts:110`) for the `files_to_touch` floor.

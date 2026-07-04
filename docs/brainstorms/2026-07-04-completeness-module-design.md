# Completeness Module — Design (v2)

**Status:** v2 — **plan-layer-only**, after a 4-reviewer code-grounded panel (adversarial / feasibility / coherence / scope-guardian) split the original v1. The semantic **AC-completeness** layer is deferred to its own follow-up design (folded into the S5 review stage — see §8), because as a standalone journaled step it was self-defeating and broke the exactly-once invariant. This doc is the plan-layer-only design that ships first.
**Branch:** `feat/completeness-module`
**Absorbs:** the `implement:dispatch` empty-diff postcondition (`handlers.ts:353-357`, *partially* — a minimal guard is retained, §3.3) and the advisory `scope_diff` verify check (`handlers.ts:744-761`).

---

## 1. Problem

styre's `implement` stage decomposes a ticket into per-`work_unit` dispatches over a **shared per-ticket worktree**, run **strictly sequentially** (`nextActionableUnit`, `resolver.ts:38-50` — a unit is fully verified before the next is implemented). The loop checks **sufficiency-of-quality** (does the code build/test green — verify) but never **completeness** (was the declared work actually done). That gap produces two opposite failures:

- **False block (the observed bug).** An over-decomposed/redundant unit whose work a sibling already did produces an empty diff; the `implement:dispatch` empty-diff postcondition hard-fails, retries 3×, escalates. Observed live on `darkreader__darkreader-7241`: wu1's committed diff was byte-for-byte the gold fix, wu2 was vacuous — styre blocked a fully-resolved ticket that would have been its first resolved bench instance.
- **False resolve.** A unit that under-delivers (declares a file, doesn't touch it) sails through verify whenever the test suite doesn't cover the missing work.

The empty-diff hard-fail is **all cost, no benefit for the redundant case**: it fires on the redundant empty diff (darkreader) yet gives *zero* protection when a *necessary* unit emits a wrong **non-empty** diff (the blind suite passes it anyway). It does, however, catch one real thing worth keeping — "the agent produced literally nothing" — which v1 preserves as a narrow guard (§3.3).

## 2. Scope of v1 — and what it deliberately does not promise

**v1 fixes the false-block and catches the *single-unit-declared* subset of under-delivery.** It is **not** a completeness guarantee. The taxonomy below marks exactly which cells v1 (the deterministic plan layer) closes; the rest are the AC-completeness follow-up's job (§8).

| # | Incomplete-work scenario | v1 plan layer |
|---|---|---|
| A1 | Redundant/over-decomposed unit → empty diff (darkreader) | ✅ `covered-by-sibling` no-op (the fix) |
| A2 | Necessary unit skipped, declared file untouched by **anyone** | ✅ `under-delivered` → loopback implement |
| A3 | Missed a declared file, **declared by exactly one unit** | ✅ caught before verify |
| A3′ | Missed a declared file **also declared/touched by another unit** | ❌ **NOT caught** — sibling touch counts as coverage at file granularity (§7). Backstopped later by AC-completeness + verify. |
| A4 | Design dropped an AC — no unit declared it | ❌ plan checks itself — AC-completeness follow-up (§8) |
| A5 | A planned unit never dispatched | ✅ cheap DAG/unit-terminal assertion (§3.4) |
| B1–B4 | File touched but change stubbed/partial/not-wired | ❌ below file granularity — AC-completeness follow-up + verify |
| C2 | Over-reach masks under-reach | ✅ forward (under) + reverse (`scope_diff`, advisory) together |

Two structural facts drive the design: the **plan is structured** (`work_unit.files_to_touch` etc. — a plan-anchored check is deterministic and free); and `files_to_touch` is authored by the **same design agent** that decides the work, so a plan-anchored check verifies *self-consistency* (implement matches plan), never *validity* (plan matches ticket). The validity gap (A4) is explicitly out of v1.

## 3. Design — the plan layer (deterministic, per-unit)

One module `src/dispatch/completeness.ts` (pure core + handler, same shape as `provision.ts`). It **absorbs** `scope_diff` and (partially) the empty-diff postcondition. Pure core:

```ts
reconcileScope(declared: string[], touched: string[]): { under: string[]; over: string[] }
// under = declared − touched   (under-delivery)
// over  = touched − declared   (over-delivery)
```

Runs as a new step `completeness:wuN`, resolver-gated between `implement:wuN` and `verify:wuN` — a byte-for-byte mirror of the existing `provision` gate: at `resolver.ts:106-121` (the `u.status === "verifying"` branch), **after** the provision gate and **before** `nextUnrunCheck`.

### 3.1 The cumulative base ref (load-bearing correctness point)

`touched` = the files in the **cumulative ticket diff**, via the existing `changedFilesBetween(baseSha, headSha, worktreePath)` (`worktree.ts:62-70`). The base ref is **not** the processed unit's `work_unit.base_sha` — that is set to HEAD-*before-that-unit's*-first-commit (`handlers.ts:337-339`), so for wu2 it would **exclude wu1's changes and re-break the darkreader `covered-by-sibling` case**. The base MUST be the **lowest-seq unit's `base_sha`** (the ticket fork point; seq-1 has no deps and codes first, guaranteed by `validateExtraction`'s strictly-earlier `depends_on` rule, `extract-schema.ts:126-132`). `head` = `getLatestForTicket(db, ticketId)?.branch_head_sha`. *(Alternative: add a `ticket.base_sha` column; §10 — recommend min-seq, no schema change.)*

### 3.2 Dispositions

| plan outcome | disposition | consequence |
|---|---|---|
| `under ≠ ∅` (declared file untouched by anyone) | `under-delivered` | **hard gate** → loopback `implement:wuN` + missing-files feedback (§4) |
| own diff empty **and** `under = ∅` (declared covered by siblings) | `covered-by-sibling` | **no-op success, advance** (the darkreader fix) |
| own diff non-empty, `under = ∅` | `completed-by-self` | advance (no routing) |
| `over ≠ ∅` (undeclared files touched) | — (a signal, not a disposition) | **advisory** `scope_diff` signal, continue to verify (never blocks) |

**Over-delivery is advisory, not a gate** (real fixes routinely exceed the plan; over-delivered code is already verified by component gates + WO-5's run-all-unowned sweep; its residual risk is *validity*, which is the AC-completeness follow-up's job). The `scope_diff` signal is preserved, now emitted here.

### 3.3 Retained empty-diff guard (do not delete the catch-all wholesale)

Deleting the empty-diff postcondition entirely opens a hole: `validateExtraction` does **not** require `files_to_touch` to be non-empty even for behavioral units, so a behavioral unit with `files_to_touch:[]` that does nothing yields `declared = ∅ ⇒ under = ∅ ⇒ covered-by-sibling ⇒ advance`, then verify falls back to a sibling's diff (`handlers.ts:513-517`) and passes — sailing through **both** gates. Today's postcondition blocks it. v1 therefore:
- **Retains a minimal intent-independent guard:** a **behavioral** unit whose own diff is empty **and** whose `files_to_touch` is empty is always `under-delivered` (block + feedback), regardless of sibling coverage.
- **Adds a `validateExtraction` floor:** a behavioral unit must declare ≥1 `files_to_touch` (`extract-schema.ts`).

### 3.4 A5 — unit-terminal assertion

A cheap deterministic check that every planned unit reached a terminal disposition (no unit silently skipped) — folded into the resolver's advance guard, not a new dispatch. (§10 to confirm placement.)

## 4. Loopback routing (plan layer only)

| outcome | routes to | bound | after bound |
|---|---|---|---|
| under-delivery | loopback `implement:wuN` (same unit) + missing-files feedback | **shared unit budget** (see below) | **escalate** |
| covered-by-sibling / completed-by-self | advance, no routing | — | — |
| over-delivery | advisory `scope_diff` signal → verify | — | — |

**Anti-thrash requirement (from the adversarial review).** Adding a completeness→implement loopback *interleaves* with the existing verify→implement loopback (`failure-policy.ts:96-136`). The cross-loop budget B2 (distinct-signature counting) is **not implemented** (`failure-policy.ts:46-48` — a later milestone), so two independent loops could ping-pong. v1 therefore routes completeness under-delivery through the **same failure-policy path as verify, sharing one bounded per-unit retry budget** spanning `{implement, verify, completeness}` for that unit — a shared hard bound (not B2's distinct-counting) that caps total loopbacks and escalates after the bound. The completeness step must **not** fall through to `failure-policy`'s default `retry` branch (`:164-165`) — that would re-run the *deterministic* check to the identical result 3× and escalate **without ever re-dispatching implement**. A `completeness` branch (or a deliberate `step_type: "verify"` reuse) is required.

## 5. Code movement & wiring (the panel's required fixes)

- **Partially delete** the empty-diff postcondition (`handlers.ts:353-357`): an empty own-diff is no longer an automatic dispatch failure, **except** the retained behavioral+empty-`files_to_touch` guard (§3.3), relocated into the module.
- **Move** `scope_diff` out of `verify:check` (`handlers.ts:744-761`) into the module (plan layer). Signal preserved.
- **Resolver:** gate `completeness:wuN` (mirror the `provision` insertion at `resolver.ts:113-115`).
- **`failure-policy`:** add a `completeness` routing branch (under-delivery → `implement:wuN`, shared unit budget) — §4. It must reset the unit to `pending` + reset its steps (mirror `:122-134`), not retry the completeness step in place.
- **`validateExtraction`:** behavioral ⇒ `files_to_touch` non-empty (`extract-schema.ts`).
- **Base ref:** min-seq unit `base_sha` for the cumulative diff (§3.1).
- **Signals:** a `completeness` ground-truth signal (per-unit; `under`/`over` + disposition); `scope_diff` preserved for over-delivery.
- **Step catalog:** add `completeness:wuN` to the S1–S10 catalog (`control-loop.md` + `minimal-loop.md`) and the Loopback Atlas (§8) row for the under-delivery route. This touches the *closed* catalog — same care as the `provision` addition; doc revision + independent review required. (No `VERDICT_BEARING_STEPS` change needed — the plan layer is a deterministic runner-computed step, not an agent dispatch.)

## 6. Invariants preserved

- **Ground truth over self-report.** The plan layer is deterministic — facts (`files_to_touch`) vs facts (the diff). No agent judgment, no self-scoring.
- **Durable journal / exactly-once.** The plan layer is **recomputable** (like `provision` / verify checks) — it carries no exactly-once effect and can safely re-run on replay. *(This is precisely why the AC layer was split off: as a journaled agent dispatch it could not be re-judged after a corrective loop without violating "a succeeded step returns its recorded result on replay" — §8.)*
- **Single transactional SoT / only the runner writes.** Signals + state changes enqueued by the runner in one transaction.
- **Capability isolation.** No new agent capabilities; the runner computes the reconciliation and performs any loopback/commit.

## 7. What v1 does NOT catch (honest limits)

- **Multi-unit-same-file under-delivery (A3′).** "Touched by any sibling counts" is *required* for the darkreader fix and cannot be tightened at file granularity without re-breaking it. For any file declared by ≥2 units, the under-delivery check is **inert** — if wu1 touches `api.ts` and wu2 (meant to add endpoint B there) does nothing, `under = ∅` → advances, and endpoint B is never written. This is common (a feature unit + its test unit routinely share a file), so v1's false-resolve *prevention* is real but partial; its load-bearing win is the darkreader false-*block* fix plus single-unit-declared under-delivery.
- **Content-incompleteness (B1–B4)** — stubs, partial multi-site edits, not-wired code. Below file granularity.
- **Plan↔ticket gap (A4)** — a dropped AC no unit declared.

All three are the **AC-completeness follow-up's** job (§8), backstopped meanwhile by verify (tests).

## 8. Follow-up: AC-completeness as an S5 review finding (separate design)

The semantic completeness layer is deferred to its own brainstorm, and should **fold into the existing S5 review stage, not a parallel journaled step** — because the standalone version broke three ways: (1) a corrective unit appended for a dropped AC runs *last*, when the cumulative diff is maximal, so the plan layer marks it `covered-by-sibling` and it no-ops — self-defeating; (2) a journaled `completeness:ticket` dispatch cannot be re-judged after a corrective loop without resetting a succeeded step, violating exactly-once; (3) advisory-after-N=1 degrades to a false-resolve-with-a-label, which has near-zero gating value in the OSS-`run`/bench terminal.

S5 already is an independent cold-context reviewer with structured citable findings, category routing (`plan-defect` → design, else → implement), and an **accepted hard-block** path (`computeBlocksShip`). "AC #k unaddressed" is a new finding category there — giving real gating, reusing accepted machinery, and running at review-time (after verify), the natural home for a semantic AC judgment. Covers A4, A3′, and B*. Its own spec (it touches the review stage + the S5 finding schema + the design/implement loopback routing) — sequenced after this v1 lands.

## 9. Testing strategy (for the plan)

- **darkreader / A1:** wu2 own-diff empty, declared files covered by wu1 ⇒ `covered-by-sibling`, advance (no block).
- **A2:** declared file untouched by anyone ⇒ `under-delivered` ⇒ loopback implement; after the shared bound ⇒ escalate.
- **A3 (single-unit-declared):** unit misses a file only it declared ⇒ `under-delivered` before verify runs.
- **A3′ (multi-unit-same-file):** wu2's declared file already touched by wu1, wu2 empty ⇒ `covered-by-sibling`, advances — a test that **documents the known limit** (§7), so a future reader can't mistake it for a bug.
- **Over-delivery:** touched ⊋ declared ⇒ advisory `scope_diff`, continues, never blocks.
- **Retained guard:** behavioral unit, `files_to_touch:[]`, empty own diff ⇒ `under-delivered` (blocked), regardless of sibling coverage.
- **`validateExtraction` floor:** a behavioral unit with empty `files_to_touch` is rejected at extract time.
- **Thrash bound:** interleaved completeness↔verify loopbacks share the unit budget and escalate after the bound (no unbounded ping-pong).
- **Empty-diff subsumption:** the deleted postcondition's old cases re-expressed against the new dispositions.
- **Base-ref regression:** a two-unit ticket where using the *per-unit* base would exclude wu1 — asserts the min-seq base is used (guards §3.1).

## 10. Open items for the plan

- Base ref: min-seq unit `base_sha` (recommended, no schema change) vs a new `ticket.base_sha` column.
- `failure-policy`: a dedicated `completeness` branch vs a deliberate `step_type: "verify"` reuse for the shared-budget loopback.
- Exact `completeness` signal schema + disposition enum values.
- Placement of the A5 unit-terminal assertion (resolver advance guard vs a discrete check).

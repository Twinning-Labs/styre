# Completeness Module — Design

**Status:** DESIGN (brainstormed 2026-07-04, operator-approved section-by-section; awaiting spec review → implementation plan)
**Branch:** `feat/completeness-module`
**Supersedes/absorbs:** the `implement:dispatch` empty-diff postcondition (`handlers.ts:353-357`) and the advisory `scope_diff` verify check (`handlers.ts:744-761`).

---

## 1. Problem

styre's `implement` stage decomposes a ticket into per-`work_unit` dispatches over a **shared per-ticket worktree**. Today the loop checks **sufficiency-of-quality** (does the code build/test/CI green — the verify stage) but never checks **completeness** (was all the declared work actually done). That gap produces two opposite failures:

- **False block.** An over-decomposed/redundant unit whose work a sibling already did produces an empty diff; the `implement:dispatch` empty-diff postcondition treats that as a hard failure, retries 3×, and escalates. Observed live: `darkreader__darkreader-7241`, where **wu1's committed diff was byte-for-byte the gold fix** and wu2 was vacuous — styre blocked a fully-resolved ticket. This would have been styre's first resolved bench instance.
- **False resolve.** A unit that silently under-delivers (touches some declared files, misses others; or the design stage drops an acceptance criterion entirely) sails through verify whenever the test suite doesn't happen to cover the missing work, and styre opens a PR for incomplete code.

The empty-diff hard-fail is **all cost, no benefit**: it fires only on the *redundant* case (empty diff), and provides *zero* protection against the dangerous case — a *necessary* unit that emits a wrong **non-empty** diff sails through the blind test suite anyway. So the current guard punishes correctness and misses the real hole.

## 2. What a completeness check can and cannot catch

A completeness scope check has two independent dials: **the anchor** (what defines "should have been done") and **the granularity** (file / symbol / AC-item). The full failure space:

| # | Incomplete-work scenario | Current behavior | Caught by scope check? |
|---|---|---|---|
| **A. A declared piece of work is entirely absent (structural)** | | | |
| A1 | Redundant/over-decomposed unit → empty diff (darkreader) | **false-BLOCK** | ✅ file — declared files already covered by siblings ⇒ redundant no-op |
| A2 | Necessary unit skipped, agent gave up → empty diff | blocks (right outcome, wrong reason) | ✅ file — declared files untouched ⇒ block, precise reason |
| A3 | Unit did partial work, missed a whole declared file | **false-RESOLVE if untested** | ✅ file — caught before verify runs |
| A4 | Design dropped an AC — **no unit ever declared it** | **false-RESOLVE** | ❌ plan anchor (plan checks itself) — needs **AC anchor** |
| A5 | A planned unit in the `depends_on` DAG never dispatched | resolver-dependent | ✅ cheap DAG/unit-terminal check |
| **B. A declared file is touched but the change is partial/fake (content)** | | | |
| B1 | Stub / `TODO` / `throw "unimplemented"` / empty body | passes if compiles + shallow tests | ❌ file is touched — needs symbol/content signal |
| B2 | Partial multi-site edit — missed some call-sites | file-level green | ❌ needs symbol/hunk granularity |
| B3 | Implemented-but-not-wired (handler added, never registered) | compiles, unit-tests green | ❌ needs symbol/integration reasoning |
| B4 | Semantically partial — right file, real change, part of intent | tests may be green | ❌ needs a semantic reviewer or targeted test |
| **C. Gate-evasion adjacent** | | | |
| C1 | Weakened/deleted tests to force green | partial existing guards | orthogonal |
| C2 | Over-reach masks under-reach (touched extra, missed a declared file) | `scope_diff` advisory (over only) | ✅ forward check + existing reverse `scope_diff` = both directions |

**Two structural facts drive the whole design:**
- The **plan is structured** (`work_unit.files_to_touch`, `verify_check_types`, `depends_on`, `behavioral`, `test_plan`) — a plan-anchored check is deterministic and free.
- The **ticket AC is *not* structured** — it lives only as prose inside `ticket.description` (there is no AC table/column). An AC-anchored check therefore needs a semantic step.
- `files_to_touch` is authored by the **same design agent** that decides the work. A plan-anchored check verifies *self-consistency* (implement matches plan), not *validity* (plan matches ticket). It closes the implement↔plan gap; it is blind to the plan↔ticket gap (A4).

## 3. Design: one module, two layers, two invocation points

All scope/completeness logic consolidates into **one module** (`src/dispatch/completeness.ts`, pure core + handler — same shape as `provision.ts`). It **absorbs** the empty-diff postcondition and `scope_diff`. Its deterministic core is a single pure function:

```ts
reconcileScope(declared: string[], touched: string[]): { under: string[]; over: string[] }
// under = declared − touched   (under-delivery)
// over  = touched − declared   (over-delivery)
```

The module runs at **two points**, each layer at its natural granularity:

```
implement:wuN ─▶ [completeness:wuN  ⟵ PLAN layer, deterministic, per-unit]  ─▶ verify:wuN ─▶ … all units …
… all units verified ─▶ [completeness:ticket  ⟵ AC layer, semantic, per-ticket] ─▶ verify:integration ─▶ review
```

### 3.1 Plan layer — `completeness:wuN` (deterministic, per-unit)

Slotted between `implement:wuN` and `verify:wuN`; the resolver gates it exactly as it now gates `provision`. It compares the unit's `files_to_touch` against the **cumulative ticket diff** (not the unit's own diff — that is what makes darkreader's wu2 a *covered no-op* rather than a false-block, while a genuinely-skipped unit still fails because nobody touched its declared files).

| plan outcome | disposition | consequence |
|---|---|---|
| `under ≠ ∅` (declared file untouched by anyone) | `under-delivered` | **hard gate** → loopback `implement:wuN` + missing-files feedback |
| own diff empty **and** declared files covered by siblings | `covered-by-sibling` | **no-op success, advance** (the darkreader fix) |
| own diff non-empty, `under = ∅` | `completed-by-self` | advance |
| `over ≠ ∅` (undeclared files touched) | — | **advisory** signal, continue to verify (never blocks) |

Dispositions (`completed-by-self` / `covered-by-sibling` / `under-delivered`) are recorded so the metric layer can see over-decomposition happening.

**Empty-diff is subsumed**: an empty own-diff is no longer a dispatch failure. It is just the degenerate case — either `covered-by-sibling` (advance) or `under-delivered` (block). The postcondition is deleted from the implement dispatch.

**Over-delivery is advisory, not a gate** (settled): real fixes routinely exceed the planner's foresight (a new import, an updated call-site, the test file). Hard-gating over-reach would be the darkreader false-block mirrored. Over-delivered code is *already verified* — component gates run the whole component's suite, and undeclared-stack files trip WO-5's run-all-unowned sweep — so over-delivery's residual risk is **validity** (does the extra work belong to the ticket), which is the AC layer's job. The `scope_diff` signal is preserved (over-delivery), now emitted here.

**File-granularity ceiling (honest limit):** checking declared-vs-cumulative at file granularity means "touched by any sibling counts," so a unit can pass on a sibling's coincidental touch of the same file, and the plan layer cannot see content-incompleteness (class B). Semantic correctness is backstopped by the AC layer and verify.

### 3.2 AC layer — `completeness:ticket` (semantic, per-ticket, confidence-scaled)

Runs once, after all units are verified, before `verify:integration`/review — because ACs are ticket-level; you cannot judge AC coverage mid-decomposition. Run by an **independent cold-context reviewer** (not the implementer — same pattern as the S5 review stage) that emits a **structured, citable finding**: for each AC, is it satisfied by some hunk of the cumulative diff; if not, **attribute the gap to the owning stage** (is there a unit whose declared scope covers this AC? → implement-gap; no unit covers it → design-gap / A4).

Its enforcement is **confidence-scaled and never a terminal hard-gate** — because a gate's strength must match the reliability of its input, and ACs may be absent, vague, or misread:

| AC input quality | behavior |
|---|---|
| absent / vague / aspirational | `ac-completeness: unverifiable` — a *known-gap* signal, **no block** (never fabricate a vacuous pass *or* fail) |
| specific + a named AC verifiably unaddressed, **confident + citable** | **corrective loopback** by owning stage (see §4), feedback = the specific AC |
| cannot cite a specific miss | advisory only, no loopback |

## 4. Loopback routing

**Route by the stage that owns the gap.** Both layers loop back to *fix*; they differ only in what non-convergence means.

| outcome | layer | routes to | bound | after bound |
|---|---|---|---|---|
| under-delivery | plan (deterministic) | loopback `implement:wuN` (same unit) + missing-files feedback | maxAttempts (3); fast-escalate on identical signature | **escalate** |
| covered-by-sibling / redundant | plan | no-op success, advance | — | — |
| over-delivery | plan | advisory signal → verify | — | — |
| AC miss owned by an existing unit | AC (judgment) | loopback `implement:wuX` + specific-AC feedback | **N = 1** | **advisory** (`untested-merge-risk`) |
| A4 — AC owned by no unit | AC | loopback **design** (incremental — §5) + specific-AC feedback | **N = 1** | **advisory** |
| AC unverifiable | AC | advisory (`ac-completeness: unverifiable`) | — | — |
| Scope-OUT violation (over-delivery into ticket's OUT list) | AC | loopback `implement:wuX` (revert OUT touch), if confident+citable | **N = 1** | advisory |

**The load-bearing asymmetry — and its real justification:** the deterministic plan layer **escalates** after exhausting attempts; the judgment AC layer **degrades to advisory** (never escalates). Not because "judgment must be humble" — once past the confidence gate, a confident miss earns a *corrective loopback*, not a shrug. The reason is narrower: **a judgment gate can be *confidently wrong*; a deterministic gate cannot.**
- Plan layer non-convergence (agent keeps not touching a declared file) is a *real stuck state* → escalate; a human must intervene.
- AC layer non-convergence (design added the unit, implement did the work, reviewer *still* says "not covered") is ambiguous — the work may be impossible, or **the reviewer may be wrong**. Escalating risks halting a *complete* ticket over a reviewer error; looping forever thrashes design↔implement. So it degrades to advisory: open the PR with the risk surfaced, and let the human MERGE gate (or, in the bench, the oracle) be the final arbiter.

Advisory is therefore **not** the response to an AC miss — it is the **circuit-breaker against a confidently-wrong reviewer**, applied only after the bounded corrective attempt.

`N = 1` corrective attempt per distinct AC miss (caps the re-implement + re-review cost) before degrading to advisory.

## 5. The cost this decision names: incremental design loopback

Confident-A4 self-healing requires that **"loop back to design" be *incremental*** — add the missing unit, preserve the completed ones. A full design reset would re-implement the entire ticket to fix one dropped AC, which is unacceptable. This machinery is **in scope for v1** (it is the price of confident-A4 self-healing).

Recommended mechanism (to confirm in the plan): **append a corrective `work_unit`** — the AC reviewer's finding directly specifies a new unit (high `seq`, `depends_on` the existing units, `files_to_touch`/`verify_check_types` for the missing AC); the resolver's `nextActionableUnit` picks it up like any other. This is simpler and less destructive than re-running `design:extract` incrementally, and it preserves all completed units by construction.

## 6. Code movement & signals

- **Delete** the empty-diff postcondition from the implement dispatch (`handlers.ts:353-357`).
- **Move** `scope_diff` out of `verify:check` (`handlers.ts:744-761`) into the module (plan layer). The `scope_diff` **signal** is preserved (over-delivery), now emitted by `completeness:wuN`.
- **Resolver** gains completeness gating at both points (mirrors the `provision` insertion in `resolver.ts`).
- **Signals:** a `completeness` ground-truth signal (per-unit; `under`/`over` detail + disposition); `ac-completeness` (`unverifiable` | `pass` | `miss`); reuse the existing `untested-merge-risk` for the AC advisory downgrade; preserve `scope_diff` for over-delivery.
- **Step catalog:** add `completeness:wuN` and `completeness:ticket` to the S1–S10 catalog in `control-loop.md` (+ minimal-loop.md), and the Loopback Atlas (§8) rows for the new routes. This touches the *closed* control-loop catalog — treat it with the same care as the `provision` step-catalog addition; the doc revision + independent review are required.

## 7. Invariants preserved

- **Ground truth over self-report.** The plan layer is deterministic (facts vs facts). The AC layer is an *independent* reviewer (cold-context), not implementer self-scoring — the one carve-out the invariant already allows; and it can never *terminally* gate, only nudge or surface.
- **Loop-not-halt.** Confident misses loop back correctively (the most loop-not-halt-aligned response). Only the deterministic layer's genuine stuck-state escalates; the judgment layer degrades to advisory.
- **Single transactional SoT / durable journal.** The plan layer is deterministic and recomputable on replay (like `provision`, a probed/recomputed step — no exactly-once effect). The AC layer is a dispatch (an agent judgment) journaled like the review step. Signals are enqueued by the runner in the same transaction as the state change.
- **Capability isolation.** No new agent capabilities; the AC reviewer reads the diff + AC (read-only), the runner performs any loopback/commit.

## 8. What this does NOT catch (honest limits)

- **Content-incompleteness (class B)** at file granularity — stubs, partial multi-site edits, not-wired code. Backstopped by the AC layer (semantic) and verify (tests), not by the plan layer. Symbol/hunk granularity is a possible future refinement, out of scope here.
- **AC-layer reach is bounded by AC quality** — absent/vague ACs yield `unverifiable`, not false confidence.
- **A confidently-wrong reviewer** — mitigated (not eliminated) by the independent cold-context reviewer, the citable-or-it-can't-gate requirement, the `N=1` bound, and the advisory (not escalate) fallback.

## 9. Testing strategy (for the plan)

Ground-truth scenarios the implementation must cover:
- **darkreader / A1:** wu2 own-diff empty, declared files covered by wu1 ⇒ `covered-by-sibling` no-op, advance (no block).
- **A2:** unit skipped, declared files untouched by anyone ⇒ `under-delivered` ⇒ loopback implement; after maxAttempts ⇒ escalate.
- **A3:** unit touches some declared files, misses one, siblings don't cover it ⇒ `under-delivered` ⇒ loopback before verify runs.
- **Over-delivery:** touched ⊋ declared ⇒ advisory `scope_diff` signal, continues to verify, never blocks.
- **AC unverifiable:** empty/vague ACs ⇒ `ac-completeness: unverifiable`, no block.
- **A4 confident:** a specific AC owned by no unit ⇒ loopback design (append corrective unit); after N=1 ⇒ advisory `untested-merge-risk`.
- **Confidently-wrong reviewer:** AC miss persists after the corrective loopback ⇒ advisory, PR opens (never escalate, never infinite loop).
- **Scope-OUT:** over-delivery into the ticket's OUT list ⇒ AC-layer loopback to revert (confident+citable) else advisory.
- **Empty-diff subsumption:** the deleted postcondition's old test cases re-expressed against the new dispositions.

## 10. Open items for the plan

- Confirm the incremental-design-loopback mechanism (append corrective unit vs incremental re-extract) — §5 recommends append.
- Exact `completeness` signal schema + disposition enum values.
- Whether the A5 DAG/unit-terminal check (all planned units reached a terminal disposition) is folded into `completeness:ticket` or kept as a cheap resolver assertion.
- The AC reviewer's structured-output contract (per-AC satisfied/attribution/evidence), modeled on `review-schema.ts`.

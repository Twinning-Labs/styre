# Dispatch retry-feedback primitive — Bug B fix (general-class)

**Status:** design, awaiting independent review + operator sign-off
**Date:** 2026-07-10
**Branch/worktree:** `fix/design-over-decomposition` (off `origin/main` @ #68 `771b25b`)
**Supersedes:** `docs/brainstorms/2026-07-10-design-extract-feedback-design.md` (the per-step
`extractFeedback` — symptomatic; replaced by this general primitive per operator steer).

---

## §0 — The bug and its class

`darkreader-7241` escalated `blocked` at `design:extract`: the design agent over-decomposed a 1-line
fix into 3 work units, one with `files_to_touch=[]`; `validateExtraction` rejected it, the handler
**threw**, and the failure-policy re-dispatched `design:extract` — **with no feedback about the
rejection**, so the agent repeated the same over-decomposition until attempt-exhaustion → escalate.
(The gold judge confirmed styre's actual work-unit-1 candidate was the correct fix; styre blocked on
the vacuous sibling.)

**This is a general class, not a darkreader one-off.** An audit of the dispatch handlers found the
same "reject → blind-retry → escalate" pattern in multiple steps whose deterministic self-check
throws and re-dispatches without carrying the reason:

| Step | Own-rejection throw (blind-retried today) |
|---|---|
| `design:extract` | `validateExtraction` / `validateCdotImpact` (`handlers.ts:405/409`) — the darkreader case |
| `design:dispatch` | postcondition "no plan for this ticket under docs/plans/" (`:377`) |
| `design:review` | "findings invalid" (`:479`) |
| `checks:dispatch` | postcondition "no valid check for AC seq …" (`:640`) |
| `checks:classify`, `design:size`, any dispatch | sidecar-malformed + future gates |

The existing per-step feedback readers (`implementFeedback`, `designFeedback`, `checksFeedback`)
carry **downstream** feedback (verify results, review findings, adjudication) into their own prompt
slots — but **none carries a step's *own* postcondition/validation/sidecar rejection**. That gap is
exactly the darkreader failure, and it recurs across the table above.

**The general fix:** carry a dispatch step's own thrown rejection into its retry, in ONE place.

---

## §1 — The primitive: prepend the prior rejection in `runAgentDispatch`

The rejection is **already captured** generically: on any dispatch-handler throw (postcondition,
validation, or sidecar — from anywhere in the handler), `runStep`'s catch calls
`markFailed(db, step.id, err)` (`step-journal.ts:119`), which persists `serializeError(err)` =
`{name, message}` JSON to `workflow_step.error_json`. `resetToPending` (`workflow-step.ts`) does
**not** clear it, so it survives into the retry. And `runStep` passes the step row (with
`error_json`) as `ctx.step` to the handler.

So the fix is a small addition to `runAgentDispatch` (the shared flow every agent-dispatch step
uses), mirroring the existing `resumeContext` carryover prepend:

```ts
let prompt = rendered.prompt;
// CL-RETRY (general retry-feedback): if a prior attempt of THIS step was rejected, prepend its
// error so the agent fixes the specific problem instead of blindly repeating it. Captured
// generically by markFailed → workflow_step.error_json (survives resetToPending, cleared on
// success — §2.2). Fixes the whole reject-then-blind-retry class; no per-step code, no prompt slot.
const priorRejection = rejectionFrom(ctx.step.error_json);
if (priorRejection !== "") {
  prompt = `${RETRY_FEEDBACK_PREFIX}\n\n${priorRejection}\n\n${RETRY_FEEDBACK_SUFFIX}\n\n${prompt}`;
}
// (the existing resumeContext carryover prepend follows, unchanged)
```

- `rejectionFrom(error_json: string | null): string` — `""` when null/malformed/empty; else the
  parsed `.message`. (Operator decision: **prepend all** prior errors — no allow/deny taxonomy. Gate
  and sidecar rejections are directly actionable; the rare infra errors — "project not found" — are
  harmless noise that escalate fast and don't retry-loop.)
- `RETRY_FEEDBACK_PREFIX` / `_SUFFIX` — step-agnostic wrapper: *"## Your previous attempt at this
  step was rejected — fix exactly the problem below and produce a corrected result; do not repeat the
  output that caused it:"* … *"(Address the rejection above before anything else.)"*. The specific,
  actionable detail lives in the message itself (e.g. `design:extract completeness failed: unit seq 3
  declares no files_to_touch …`).

**Why this is general (and why it's smaller than per-step readers).** Every agent-dispatch step
routes through `runAgentDispatch`; every dispatch throw is captured by `markFailed`. So one edit
carries **each step's own rejection** into **its** retry — `design:extract` (darkreader),
`design:dispatch`, `design:review`, `checks:dispatch`, and any future gate — with zero per-step
readers, prompt slots, or `*Vars` changes. It is **complementary** to the per-step downstream
readers (they still populate their curated slots; the primitive adds the step's own rejection on
top).

---

## §2 — Components (2 files + tests)

1. **`src/dispatch/run-dispatch.ts`** — add `RETRY_FEEDBACK_PREFIX`/`_SUFFIX` consts, a
   `rejectionFrom(error_json)` helper, and the prepend block above (before the existing
   `resumeContext` prepend). No signature change to `runAgentDispatch`.
2. **`src/db/repos/workflow-step.ts`** — `markSucceeded` also sets `error_json = NULL` (staleness
   fix): a success wipes the failure history, so a later loopback that re-runs the same `step_key`
   never prepends a pre-success rejection. (One clause added to the existing UPDATE.)

That is the entire change. Notably **removed** vs the superseded design: no `extract-feedback.ts`,
no `extractVars` param, no `{{extract_feedback}}` prompt slot, no new `extract-validation` signal.

---

## §3 — Edge cases & decisions

- **First attempt** — `ctx.step.error_json` is null (fresh `insertPending`) → `rejectionFrom` `""`
  → no prepend. Happy path byte-identical.
- **Staleness after a success (loopback re-run)** — `markSucceeded` now clears `error_json`, so a
  step that succeeded then is reset by a loopback re-runs with `error_json` null → no stale prepend.
  (Without the clear, `markSucceeded` left the old failure; this is the one staleness hole, closed.)
- **Park/resume is orthogonal** — a session-limit park does **not** `markFailed` (it's attempt-neutral,
  ENG-164: `decrementAttempt`), so it never sets `error_json`. Retry-feedback (error_json) and
  `resumeContext` (park carryover) are mutually exclusive in practice; both prepends compose harmlessly
  if they ever co-occurred.
- **Prepend-all scope** (operator-chosen) — infra errors ("project not found", "missing workUnitId")
  get prepended too. Harmless: they're rare, agent-inert, and escalate quickly without looping; no
  error taxonomy to maintain. A future actionable-only filter is a deferitable refinement.
- **Composition with per-step downstream feedback** — `implementFeedback`/`designFeedback`/`checksFeedback`
  still fill their slots in the rendered prompt; the primitive prepends the step's own rejection on
  top. The agent sees both. No conflict, no double-count (different sources).
- **Gate never relaxed / no false-pass** — the deterministic gates (`validateExtraction`, the
  postconditions, sidecar validation) still run on **every** attempt; the primitive only informs the
  prompt. An invalid output can never pass because a rejection was fed back.
- **`error_json` format** — `serializeError` always emits `{name, message}` (`workflow-step.ts:29-34`);
  `rejectionFrom` JSON-parses and returns `.message` (fails safe to `""` on any parse error).
- **`ctx.step` currency** — `runStep` passes `current = getById(step.id)` (`step-journal.ts`), which
  reflects the persisted `error_json` from the prior attempt (neither `markRunning` nor
  `resetToPending` clears it). Confirmed the read point is correct.

---

## §4 — Testing

- **`runAgentDispatch` retry-feedback (unit, real DB + FakeAgentRunner capturing `input.prompt`):**
  - a step whose `workflow_step.error_json` is set to `{"name":"Error","message":"REJECTED: unit seq 3
    has no files"}` → the agent's prompt CONTAINS the message + `RETRY_FEEDBACK_PREFIX`.
  - `error_json` null (first attempt) → the prompt does NOT contain the prefix (no prepend).
  - malformed/empty `error_json` → no prepend (fails safe).
- **`markSucceeded` clears `error_json` (unit):** set `error_json`, `markSucceeded`, read the row →
  `error_json` is null. (Guards the staleness fix.)
- **e2e (the crux — reproduces & fixes darkreader, generically):** drive a ticket to `design:extract`;
  the FakeAgentRunner emits a vacuous-unit extraction on attempt 1 (→ `validateExtraction` throws →
  `markFailed` records it), and on attempt 2 — **only if `input.prompt` now contains the prior
  rejection** — emits a valid extraction; assert the ticket advances past `design:extract` to
  implement (no escalate), proving the retry was informed by the generic primitive. And the negative:
  a runner that emits the identical vacuous unit on all 3 attempts → escalates on
  **attempt-exhaustion** (`step 'design:extract' failed`, NOT a no-progress reason). Copy the harness
  from `test/dispatch/design-extract.test.ts` (`readyForExtract` + `advanceOneStep` drive-loop +
  prompt-branching FakeAgentRunner) — NOT `run-harness.ts` (a park harness that never reaches this
  step). Place the test in `test/dispatch/`.
- **Generality spot-check (unit):** a *second* dispatch step (e.g. seed a `checks:dispatch` or
  `design:dispatch` step row with `error_json` set) → its `runAgentDispatch` prompt also carries the
  rejection — proving the primitive is not `design:extract`-specific.
- **Regression:** full suite green — existing dispatch tests have null `error_json` on first attempts,
  so no prepend, no behavior change.
- lint + typecheck clean.

---

## §5 — What this is NOT

- **Not per-step** — no `extractFeedback`/`extract-validation` signal/prompt-slot (the superseded
  design). One shared-flow primitive covers the whole class.
- **Not a replacement for the downstream readers** — `implementFeedback` et al. still carry curated
  verify/review feedback; the primitive adds the step's *own* rejection.
- **Not a failure-policy / resolver / schema change** — the retry→escalate machinery is unchanged;
  the retry is merely *informed*. (`error_json` and the whole capture path already exist.)
- **Not an error taxonomy** — prepend-all (operator-chosen); no actionable/infra classification.

---

## §6 — Changelog

- **2026-07-10** — Redirected from the per-step `extractFeedback` (symptomatic) to a general
  `runAgentDispatch` retry-feedback primitive (operator steer: "fix a general class"). Prepends a
  dispatch step's own prior rejection (`ctx.step.error_json`, already captured by `markFailed`) into
  its retry prompt, mirroring `resumeContext`; `markSucceeded` clears `error_json` for staleness.
  Operator chose prepend-all (no error taxonomy). Awaiting independent review.

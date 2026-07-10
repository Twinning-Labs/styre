# `docs:revise` handler — Bug A fix (spec'd-but-unbuilt step)

**Status:** design, awaiting independent review + operator sign-off
**Date:** 2026-07-10
**Branch/worktree:** `fix/docs-revise-handler` (off `origin/main` @ #67 `1d5f43a`)

---

## §0 — The bug

In a SMOKE=2 bench run against post-M6 `main`, `astropy-12907` passed the M1–M6
change-scoped verify gate (`ac-check-post-implement = PASS`, `ac-check-gate = PASS`,
`tox` correctly advisory) and then **crashed**:

```
ERROR advanceOneStep: no handler registered for 'docs:revise'
```

→ the styre run threw, the bench recorded `infra`, retried 2× (deterministic crash), gave up.

**Root cause (fully traced).** `docs:revise` is a **spec'd-but-unbuilt** step:
- The design agent's extraction can declare documentation impact
  (`extract-schema.ts` `cdotImpact.documentation`); `design:extract` then sets
  `ticket.needs_docs = 1` (`handlers.ts:423`, gated on `cdotImpact.documentation.applies`).
- After every unit is verified, the resolver emits a `docs:revise` step
  (`resolver.ts:213-214`, `needs_docs === 1 && !done("docs:revise")`).
- The step has a model tier (`tiers.ts:15` → `cheap`/Haiku), a tool-allowlist
  (`tool-allowlists.ts:15` → `[...READ_ONLY, "Write", "Edit"]`), a schema column
  (`needs_docs`), and a full spec in `control-loop.md:386` — but **no registered
  handler** in `buildDispatchRegistry`. So `advanceOneStep` throws.

Any ticket whose design flags documentation impact hits this. It is **pre-existing
and unrelated to M1–M6** (verify had already passed). astropy is docs-heavy, so its
design flagged documentation → the crash.

**The fix (operator-approved scope):** implement the spec'd handler (not a stub / not
ripping out the emission — see §5 Alternatives). It's small: one dispatch handler + a
prompt + a pure doc-path predicate.

---

## §1 — The spec being implemented (`control-loop.md:386`, verbatim intent)

**`docs:revise`** — ticket-level documentation sync (conditional; Haiku 4.5)
- **Guard:** verify (S4) passed **and** design (S1) set `needs_docs=true`. (Else skipped.)
- **Input:** the ticket's completed change + plan + existing docs + doc locations.
- **Output:** updated `docs/**` → the runner commits; a `dispatch` row. Content, not a payload.
- **Tools:** `Read`/`Grep`/`Glob` + `Write`/`Edit` **docs only** (cannot touch source/tests,
  so it can't invalidate S4's pass — **no re-verify needed**).
- **Failure → route:** C1 (`control-loop.md:643`) — a dispatch failure retries, then escalates.

Everything except the handler already exists. This design builds the handler and makes
the "docs-only" guarantee **structural**.

---

## §2 — Architecture & flow

A single new dispatch handler, registered in `buildDispatchRegistry`. No schema, resolver,
tier, or allowlist change.

```
all units verified + AC-check gate passed
        │  resolver: needs_docs===1 && !done("docs:revise")   (resolver.ts:213)
        ▼
   docs:revise handler
     runAgentDispatch(handlerKey:"docs:revise", template: DOCS_REVISE_TEMPLATE,
                      vars: docsVars(ticket, profile), postcondition)
       → agent (Haiku, Read/Grep/Glob + Write/Edit) reads the worktree + docs/plans/<ident>
         + existing docs, edits documentation to match the completed change
       → runner commits (commitWorktree → { sha, changed })      [existing machinery]
       → postcondition({ worktreePath, sha }):
            offenders = changedFilesAt(sha, worktreePath).filter(f => !isDocPath(f))
            offenders.length > 0  → throw  → outcome "postcondition-failed" → rethrow → C1
            offenders.length === 0 → pass  (no-op case included: 0 changes → 0 offenders)
        │  resolver: done("docs:revise")
        ▼
   advance implement → review
```

**Why this is the whole fix.** `runAgentDispatch` (`run-dispatch.ts:54-130`) already:
commits the agent's edits (`commitWorktree` → `{sha, changed}`), calls
`spec.postcondition({worktreePath, changed, sha})`, and on a throw records
`outcome: "postcondition-failed"` and rethrows — which the failure-policy handles as a
dispatch failure (C1 retry→escalate). The handler adds nothing but the template, the vars,
and the postcondition body.

**The structural guarantee (load-bearing).** The postcondition fails the step unless
**every** changed file satisfies `isDocPath`. So `docs:revise` provably cannot modify
source/tests → the already-passed verify gate stays valid → no re-verify, exactly as the
spec promises. This is ground-truth enforcement (mirrors M4 §2b's integrity gate and
`scope_diff`), not self-report — a docs step that edits source is a real anomaly and is
blocked.

**The no-op case is free.** If the agent decides nothing needs updating, it commits nothing
→ `changed = false`, `changedFilesAt` is empty → 0 offenders → pass → `{docsRevised:false}`.
The step is marked done; the resolver advances. (A docs-flagged ticket whose change needed
no doc edits is a legitimate, common outcome — never a failure.)

**Bash-less by design.** Like `review` (`[...READ_ONLY]`, prompt: *"review the finished
change… the plan under `docs/plans/`, and the codebase"*), `docs:revise` reads the committed
worktree + the plan directly. No `git diff` injection, no Bash — the plan under
`docs/plans/<ident>.md` names each unit's `files_to_touch`, so the agent has the change scope
from artifacts already present.

---

## §3 — Components (4 files)

1. **`src/dispatch/docs-paths.ts`** *(new, pure)* — the single source of truth for "what is a
   doc", shared by the postcondition (enforcement) and the prompt (guidance) so they can never
   drift:
   - `isDocPath(file: string): boolean` — true iff:
     - the path contains a `docs/` directory segment (`^docs/…` or `…/docs/…`), **or**
     - the path is repo-root (contains no `/`) **and** its basename matches, case-insensitively,
       `README*` / `CHANGELOG*` / `CONTRIBUTING*` / `mkdocs.yml`.
     Conservative / fail-closed: a `src/README.md` is **not** a doc path. This set mirrors the
     documentation signals `detect-runtime.ts` looks for (`docs/`, `README.md`, `CHANGELOG.md`,
     `mkdocs.yml`), so "allowed docs" == "what setup calls docs" without parsing the profile's
     free-form documentation-evidence string.
   - `DOC_PATHS_HINT: string` — the human-readable allowed-path list, used verbatim in the prompt.
2. **`prompts/docs-revise.md`** *(new)* — the Haiku prompt. Mirrors `review.md`'s framing: the
   change is complete and committed in the worktree; read the plan under `docs/plans/<ident>`,
   the changed code, and the existing docs; update the documentation to match. Edit **only** the
   paths in `{{doc_paths}}`. If nothing needs updating, make no changes and finish.
3. **`src/dispatch/prompt-vars.ts`** — `docsVars(ticket, profile)`: mirrors `reviewVars`
   (`ident`, `title`, `slug`, `...profile.promptVars`) + `doc_paths: DOC_PATHS_HINT`.
4. **`src/dispatch/handlers.ts`** — register `docs:revise`:
   ```ts
   registry.register("docs:revise", async (ctx: HandlerContext) => {
     const { changed } = await runAgentDispatch(
       ctx,
       depsFor(ctx, deps, deps.timeoutMs ?? DEFAULT_TIMEOUT_MS),
       {
         handlerKey: "docs:revise",
         template: DOCS_REVISE_TEMPLATE,
         vars: docsVars(ctx.ticket, deps.profile),
         postcondition: ({ worktreePath, sha }) => {
           const offenders = changedFilesAt(sha, worktreePath).filter((f) => !isDocPath(f));
           if (offenders.length > 0) {
             throw new Error(
               `docs:revise touched non-doc files (may only edit documentation): ${offenders.join(", ")}`,
             );
           }
         },
       },
     );
     return { docsRevised: changed };
   });
   ```

**Unchanged (already present):** the resolver emission, the `cheap`/Haiku tier, the
`[...READ_ONLY, "Write", "Edit"]` allowlist (capability-level; the path scope is enforced by
the postcondition, consistent with how styre enforces scope post-hoc), the `needs_docs`
column and its `design:extract` setter, and the failure-policy C1 route for a `dispatch` step.

---

## §4 — Error handling & edge cases

- **Non-doc edit** → postcondition throws → `postcondition-failed` → failure-policy retries
  (fresh dispatch); on repeated offense → escalate (C1). Honest, fail-closed — never silently
  accepts a source edit that could invalidate verify.
- **No-op** (no changes) → pass, `docsRevised:false`, step done. Not a failure.
- **Transport failure / timeout / park** → handled entirely by `runAgentDispatch`'s existing
  paths (`dispatch-failed` throw / `ParkSignal`), same as every other dispatch step.
- **Resume/replay** — a succeeded `docs:revise` step returns its journaled result and is not
  re-run (the durable step-journal contract); the resolver's `!done("docs:revise")` guard makes
  the emission idempotent.
- **Non-standard doc locations** (e.g. a project keeping docs in `documentation/`): the
  conservative predicate would reject an edit there → C1 escalate (visible), not a silent
  wrong-scope edit. Broadening the predicate from profile-declared locations is a possible
  future refinement (YAGNI now — the detector's set covers the common cases and astropy).

---

## §5 — Alternatives considered (and rejected)

- **Minimal no-op stub** (register a handler that just marks done): un-crashes, but silently
  drops the documentation sync the design intends — a reviewer at cutover would find docs never
  updated. Dishonest; defers a spec'd OSS feature behind a lie. **Rejected** (operator chose the
  real handler).
- **Stop emitting `docs:revise`** (remove `setNeedsDocs` + the resolver arm): also un-crashes and
  is arguably cleaner than a lying stub, but drops the spec'd feature and leaves `needs_docs`
  dead; reversing later means re-wiring the resolver. **Rejected.**
- **Prompt-only docs-scope** (instruct the agent to edit only docs, no check): cheaper, but the
  "can't invalidate verify" guarantee becomes self-report — a misbehaving dispatch could edit
  source and silently invalidate the passed gate. **Rejected** (contradicts ground-truth-over-
  self-report; operator chose the structural postcondition).

---

## §6 — Testing

- **`isDocPath` (pure, table-driven):** `docs/x.rst`→true, `README.md`→true, `CHANGELOG.md`→true,
  `CONTRIBUTING.md`→true, `mkdocs.yml`→true, `pkg/docs/guide.md`→true; `src/foo.py`→false,
  `test/foo_test.py`→false, `src/README.md`→false, `docsource/x.md`→false (no `docs/` segment).
- **Handler (FakeAgentRunner writing prescribed files, real DB):**
  - writes only `docs/api.md` → dispatch `clean-success`, `docsRevised:true`, resolver advances to review.
  - writes `src/foo.py` (with or without a docs file) → `postcondition-failed`; the offender is named.
  - writes nothing → `changed:false`, passes, step done.
- **Regression test (the crux — reproduces the astropy crash):** seed a ticket with
  `needs_docs=1`, all units verified + the AC-check gate passed; drive the resolver/tick — it
  reaches `review` **without** throwing `no handler registered for 'docs:revise'`, and a
  `docs:revise` dispatch row exists. Directly proves the bug is closed.
- **Full suite** green; lint + typecheck clean (run before every commit).

---

## §7 — What this is NOT

- Not a re-verify trigger — the docs-only postcondition guarantees verify stays valid.
- Not a resolver/schema/tier/allowlist change — those are already correct; only the handler was missing.
- Not a docs *quality* gate — doc quality is judged by the reviewer at cutover (`control-loop.md`:
  "no separate `docs:verify`"). This step only syncs and structurally guarantees scope.

---

## §8 — Changelog

- **2026-07-10** — Initial design. Scope = build the real spec'd handler (operator); enforcement =
  structural docs-only postcondition (operator). Awaiting independent review + sign-off.

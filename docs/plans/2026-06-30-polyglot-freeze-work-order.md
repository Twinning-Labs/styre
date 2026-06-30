# Polyglot setup + verify — freeze alignment audit & work order

**Date:** 2026-06-30 (v2 — re-scoped after the independent five-reviewer pass)
**Branch:** `feat/polyglot-setup` (M-A / M-B / M-C1 landed, no PR)
**Freezes against:** `docs/design/2026-06-30-polyglot-setup-verify-frozen-design.md`
**Purpose:** answer "does the freeze supersede the earlier brainstorms?" by auditing every delivered artifact against the frozen design, then give a single work-order list with the already-landed-and-aligned tasks marked done — **re-scoped to the "polyglot setup is DONE" line** (WO-1…WO-6 + the in-feature remainder), with everything else labeled reframe / run-loop / commercial / additive.

**Verdict up front:** the freeze **partially** supersedes the brainstorms. It *keeps* the security model (M-A), the registry architecture + machine-channel invariants (M-C1), and the deterministic detectors (M-B). It *replaces* one thing: the **routing abstraction** — "a component owns a path-glob" becomes "classify files by identity + gates/triggers + run-more-when-unsure." Everything that touches the folder-glob routing is **interim**.

---

## Part A — Status legend

- ✅ **DONE** — landed in the branch **and** aligns with the freeze. Keep as-is.
- 🟡 **INTERIM** — landed and working for current cases, but the freeze replaces the underlying mechanism. Keep running; rework under the new model. *Not "done" in the freeze sense.*
- ⬜ **TODO** — part of the frozen design, not yet built.
- ❌ **REJECTED** — explicitly do not build.
- 🔵 **OUT-OF-FEATURE** — real work, but it belongs to the run-loop, control-loop, or commercial plane — not the polyglot-setup completeness contract.

---

## Part B — Alignment audit (what's delivered vs. the freeze)

### B1. Aligned & landed (the freeze keeps these unchanged)

| Delivered | Where | Why it aligns |
|---|---|---|
| Metachar command gate (F1) | `command-safety.ts`, `discover.ts` | Freeze §12 preserves the command-injection guard. |
| Per-command trust rule + `--trust-agent-commands` (F1/A1) | `discover.ts`, `cli/setup.ts` | Freeze §7/§12: agent judgment bounded, headless default-reject. |
| `repoCommands` gating (F2) | `discover.ts` | Same gate extended to the side channel. |
| Path-traversal `..` guard (F3) | `discover-schema.ts:34`, `manifests.ts` (`isSafePath`) | Freeze §12 capability isolation; also folded into Invariant 2. |
| `verifyEnv` split scrubs `ANTHROPIC_API_KEY` (F4) | `agent-env.ts`, `run-command.ts` | Freeze §12: verify-env strips LINEAR/GITHUB/ANTHROPIC. |
| `LangDef` registry + generic engine | `lang/*.ts`, `registry.ts`, `detect-components.ts` | Freeze §9: "one registry entry per stack." |
| Leaf `manifests.ts` (breaks circular import) | `manifests.ts` | Sound module boundary. |
| Invariant 1 (command backstop, **throws**) | `runRegistry` | Freeze §4.3/§12. |
| Invariant 2 (path backstop + `safeMember`) | `runRegistry`, `manifests.ts` | Freeze §4.3/§12. |
| Behavior-preserving 5-stack migration + invariant/conformance tests | `lang/*`, `engine.test.ts` | Proven by the unchanged `detect-components.test.ts` matrix across `4c18e2d..da05dc4`. |
| Operator-confirm + `{unavailable}` "cannot ground-truth-`<k>` this stack" ladder | `resolve-commands.ts` | Freeze §9.5/§12: operator-confirm; never silently claim a missing gate ran. |

### B2. Landed but **interim** (folder-ownership — the freeze replaces the mechanism)

| Delivered | Where | The mismatch |
|---|---|---|
| **Verify routing by path-glob** — `matchesComponent`; `impactedComponents` filters by glob | `dispatch/components.ts` | This **is** "component owns a folder." **Precise failure:** a diff matching *no* component is a **loud** `no-component-matched` error (`handlers.ts:362`, throws). The genuinely-silent under-verify is the **mixed diff** — matched files make `impacted` non-empty, so *unmatched* files in the same diff ride along ungated — plus profile staleness. No run-all/global fallback exists. |
| **Path-glob emission** per LangDef — root `["**"]`, non-root `["dir/**"]`, rust collapsed globs | `lang/*.ts` | Under the freeze, paths/globs are replaced by file-identity **triggers**. Root `["**"]` is harmless (matches all); dir-globs are the interim folder model. |
| **Node co-located carve** `["src/**","static/**","package.json"]` | `lang/node.ts` | Same *class* as the rejected `scopeColocatedRoots` — a hardcoded folder carve. Narrow, not harmful for the Tauri case, but **superseded in approach** (the freeze handles co-location by file identity). |

> B2 is not "wrong" today — it passes its tests and verifies the shipped corpus. It is flagged so no one mistakes folder-glob routing for the frozen design. The rework is WO-5/WO-6.

### B3. Brainstorm-section disposition

| Brainstorm section | Disposition |
|---|---|
| Security findings F1–F4 | **Implemented & aligned** — kept verbatim. |
| M-A design v2.1 (trust rule, env split) | **Implemented & aligned.** |
| M-C registry architecture + two invariants | **Implemented & aligned** (M-C1). |
| Capability bar + bounded first-class set | **Aligned** — Ruby/PHP/`prepare` still TODO (WO-3). |
| Idiomatic multi-module (reactor→1, npm→per-member) | **Aligned in principle**; only Rust reactor + naive Node per-member landed (WO-8). |
| **Deterministic co-located root scoping** (§3) + `scopeColocatedRoots` | **Superseded in approach** — folder carve rejected (WO-9 ❌). The *problem* is real; the *solution* is replaced by file-identity. |
| "Agent narrows `["**"]`" (v1) | Already corrected in the brainstorms; the freeze keeps the correction. |
| Single-module-first / defer-collapse (M-B §5.4) | **Aligned** as interim. |

**Net:** keep the brainstorms as historical decision logs; only the co-located-scoping solution is replaced.

### B4. Design & implement across stacks — audit (sub-problem #4; from a two-tracer code read)

The polyglot work so far makes *detection* and *verify* multi-stack-aware. The **design** and **implement** phases are a separate problem, and the audit found them weakly handled:

| Phase | Multi-stack today? | Evidence |
|---|---|---|
| **Design / extract** | **Stack-blind.** Splits the ticket by agent judgment over generic example kinds; `profile.components` never reach the prompt; `kind` is free text validated against nothing stack-related; no design-time unit→component link. | `prompt-vars.ts:41-67` (components not passed; `stack:""`), `prompts/design-extract.md:11` (generic `kind` examples), `schema.sql:133` ("NOT a CHECK enum (stack-agnostic)") |
| **Implement** | **Capable but context-blind.** One dispatch per unit over a fully-writable worktree (so a unit *can* touch many stacks); Bash allowlist = union of impacted components' commands. But the prompt carries no `files_to_touch`, no sibling/`depends_on`, no contract notes, and an empty `stack`. | `resolver.ts:106` (per-unit), `worktree.ts:15-20` (whole-tree writable), `components.ts:45` (union scope), `prompt-vars.ts:69-92` + `prompts/implement.md` (minimal context) |
| **Verify** | **Multi-stack-aware.** Fans out per impacted component from the diff; ticket-scope `verify:integration`; `untested-merge-risk` for unverifiable stacks. | `handlers.ts:356-413` |

→ Fix split per operator decision: **stack-grounded decomposition = WO-13 (in-feature, DONE line); cross-stack implement coordination = Milestone M-D (first-class follow-on).**

---

## Part C — Work order (re-scoped to the DONE line)

Grouped by the frozen design (executed work §4, decisions §6–7, research §8, converged model §9). Done = landed **and** aligned.

> **"Polyglot setup is DONE" = WO-1…WO-6 + WO-13** (stack-grounded decomposition). WO-7+ and Milestone M-D are additive / reframe / follow-on / out-of-feature (see each group and Part D).

### WO-1 · Security & command pipeline (M-A) — ✅ COMPLETE
- [x] ✅ Metachar command gate (F1)
- [x] ✅ Per-command trust rule + `--trust-agent-commands` headless opt-in (F1/A1)
- [x] ✅ `repoCommands` gating (F2)
- [x] ✅ Path-traversal `..` guard + drop-empty (F3)
- [x] ✅ `verifyEnv` split — scrub `ANTHROPIC_API_KEY` from verify spawns (F4)

### WO-2 · Registry & engine (M-C1) — ✅ COMPLETE
- [x] ✅ `LangDef` registry + generic engine (`runRegistry`)
- [x] ✅ Leaf `manifests.ts` (breaks the circular import)
- [x] ✅ Invariant 1 — command backstop (throws on metachar machine command)
- [x] ✅ Invariant 2 — path backstop + `safeMember` member sanitization
- [x] ✅ Behavior-preserving migration of the 5 stacks + invariant/conformance tests

### WO-3 · Deterministic detection / first-class set
- [x] ✅ Rust detector (+ workspace collapse) — *detection done; glob emission is interim (WO-5/6)*
- [x] ✅ Node **detection** (scripts-aware) — *glob emission (root carve / per-member) is 🟡 interim (WO-5/6)*
- [x] ✅ Python detector (+ runner ladder tox → nox → `pytest.ini` → `pyproject` → `python -m pytest`) — *no `manage.py` rung; that was never built*
- [x] ✅ Go detector
- [x] ✅ JVM-Maven detector (wrapper-aware)
- [x] ✅ JVM-Gradle detector (wrapper-aware)
- [x] ✅ Extended manifest-walk `SKIP` set
- [x] ✅ Subdir-only-manifest loud warning (`unrootedManifestWarnings`)
- [ ] ⬜ **Ruby `LangDef`** (Gemfile; rspec/rake ladder) **+ its `EXTENSIONS_BY_KIND` entry** (`.rb/.rake/.gemspec`) — *M-C3, first-class set. Without the map entry, `.rb` files route path-only (the interleaving fix won't apply).*
- [ ] ⬜ **PHP `LangDef`** (composer.json; Pest-before-phpunit ladder) **+ its `EXTENSIONS_BY_KIND` entry** (`.php`) — *M-C3, first-class set.*
- [ ] ⬜ **Detect-only `prepare` command class** (install/bootstrap, stored not run) — *M-C3*

### WO-4 · Command discovery sources (freeze §9.5)
- [x] ✅ Conventions / ecosystem-default rung (hardcoded commands per LangDef)
- [x] ✅ Operator-confirm + `{unavailable}` ladder (`resolve-commands.ts`)
- [x] ✅ **Consume `AGENTS.md`** as a command source — read root AGENTS.md (symlink-safe `lstatSync`, 16 KB cap) → inject into the discovery prompt via `{{agents_md}}`; commands ride the existing M-A gate (headless value needs `--trust-agent-commands`). Commit `de4c80d` (TDD + Opus security crux + overall review). *(§13 adoption/governance number still to confirm; Phase-1 sequencing made this an independent start.)*
- [ ] ⬜ **Read the repo's CI** — scoped to **extracting test/build/lint commands from the primary non-matrix workflow**, agent-drafts → operator-confirms. *Pending the Q2 pilot (does it beat AGENTS.md+conventions in OSS?). The env-replay slice is commercial, NOT here.*
  - [ ] 🔵 *Deferred follow-ups (out of this scope):* CI matrix collapse (Q2), matrix-config selection, deploy/publish/notify filtering across CI styles (Q3).
- [ ] ⬜ **Precedence wiring:** CI > `AGENTS.md` > conventions; agent drafts → confirm → frozen

### WO-5 · File→stack classification by identity (freeze §9.1) — ✅ DONE (rung-1 + run-all safety)
*Shipped via TDD + per-task Opus crux + overall Opus review (579 green). Commits `0b941c0` (verify algorithm) · `0b1e9ea` (feedback fix) · `6384811` (identity/schema). Plan: `docs/plans/2026-06-30-wo5-file-identity-routing.md` (v3, two review rounds).*
- [x] ✅ **Extension→stack classifier** — `EXTENSIONS_BY_KIND` keyed off detected `kind`, materialized onto each component at scan; `matchesComponent` = extension-AND-path.
- [x] ✅ **Two other `Component.paths` consumers re-express for free** (implement Bash allowlist `scopedRunnersForFiles`; A1 test-file gate) — both route through `matchesComponent`.
- [x] ✅ **`ComponentSchema`/`schemaVersion` 2→3 bump** — `extensions` field materialized at scan (immune to agent kind-drift; closes the v1-blocking hole); old v2 profiles hard-rejected → re-run setup.
- [x] ✅ **Replaced folder-glob routing** with identity classification.
- [x] ✅ **Run-all safety (the WO-6 core, folded in per operator decision D2):** any unowned non-docs file → an **advisory sweep** of untouched stacks (`ran-all-unowned` signal, non-wedging) + docs-skip — kills the mixed-diff silent under-verify (the cardinal sin) without wedging on unrelated red.
- [ ] 🔵 *Manifest-association rung 2* — **additive; add when over-verify is *observed***.
- [ ] 🔵 *Import-inference rung 3 (Pants-grade)* — **deferred**; the cross-stack dep-graph depends on it.

### WO-6 · Gates + triggers + run-more-when-unsure (freeze §9.2–9.3) — **mutually prerequisite with WO-5**
- [ ] ⬜ Model the repo as **gates** (commands) + **triggers** (identity sets)
- [ ] ⬜ **Explicit global-file set** (lockfiles, root configs, CI file, base Dockerfile) → change runs **all** gates
- [ ] ⬜ **Unowned-and-not-obviously-docs → run all** (default conservative — avoid the Nx footgun)
- [ ] ⬜ **Never claim "verified" if a relevant gate couldn't run** — surface as a reported gap
- [ ] ⬜ **Cost branch (freeze §13 risk #1):** run-all is bounded but un-costed and *frequent* under the coarse classifier — measure it; over budget → run the cheap tier, **defer the expensive tier to the gap-surfaced merge, never silently narrow**
- [ ] 🟡 Retire the mixed-diff under-verify path — *current `impactedComponents` behavior*

### WO-7 · Per-verify recompute (freeze §9.4) — **reframed**
- [x] ✅ Recompute the file→gate map per verify from the diff — *largely already exists (`impactedComponents`); the OSS design is recompute, not a live graph*
- [ ] ⬜ Store the per-verify materialized snapshot in the run DB for audit/replay (small)
- [ ] 🔵 *Persist + keep-live via a tree-watcher (the Nx-daemon optimization)* — **commercial plane**, not OSS (the one-shot runner has no daemon)

### WO-8 · Multi-module
- [x] ✅ Rust reactor collapse (idiomatic → 1 component, `collapseWorkspaceGlobs`)
- [x] 🟡 Node per-member (naive `findManifests` walk — interim; no workspace-decl parse)
- [ ] 🔵 Maven/Gradle reactor parsers (→ 1; member→glob via `safeMember`) — **additive; reconcile with WO-5 file-identity first** (per-member globbing is far less central under identity)
- [ ] 🔵 `go.work` reactor — additive, same reconcile gate
- [ ] 🔵 Degrade-to-over-verify (`["**"]` workspace root) on low-confidence member parse

### WO-9 · Non-root detection & naming
- [x] 🟡 Rust/Node emit non-root dir components (folder-glob — B2 interim)
- [ ] ⬜ Python/Go/JVM non-root — *via the WO-5 file-identity model (currently warning-only)*
- [ ] 🔵 **`uniquifyNames`** pass (sound, specced in M-C2a, **unshipped**) — RETAIN; **additive, lands *with* non-root** (no consumer until dir-named components exist)
- [ ] ❌ **`scopeColocatedRoots`** (folder carve) — **REJECTED**, do not build (silent under-verify; freeze §5)

### WO-10 · Cross-stack contract gates (freeze §9.6) — **explicit-artifact-only**
- [ ] ⬜ Detect explicit contract artifacts (`.proto` / OpenAPI / Pact / GraphQL)
- [ ] ⬜ **Contract gates on artifact-in-diff** — buf / oasdiff / Pact; **missing tool degrades via the existing `{unavailable}` → `untested-merge-risk` path** (ship with WO-6's trigger→gate model)
- [ ] 🔵 *The former items 3–5 (blast-radius before dispatch, coupled-cluster = one unit, implicit-contract design-gate) are consolidated into **Milestone M-D** below — they modify the closed S1–S10 catalog and belong with the implement-context work.*

### WO-11 · Cross-stack ceiling (T2) — **plane-split**
- [x] ✅ Surface verify gaps in the PR body (untested stacks) — *largely exists via `renderPrBody` "⚠ Untested stacks" from `untested-merge-risk`*
- [ ] ⬜ Extend the PR-body gap report to the full set (untested seam / couldn't-run / skipped-for-cost) and the 3-way intent
- [x] ✅ Human decision point = the existing post-PR **MERGE** gate — *no new pre-PR block; preserves the headless OSS primitive*
- [ ] 🔵 *Hard pre-PR interactive hold (ask → skip/accept → then open)* — **commercial plane** (needs the bubble-up/inbox)

### WO-12 · Environment provisioning (T3 / Q17)
- [ ] 🔵 **OSS:** surface gap + allow skip + open PR when no env/CI/tests — *this is the `styre run` terminal behavior (run-loop milestone), overlaps WO-11*
- [ ] ❌ **Commercial-plane (out of OSS scope):** single-Dockerfile env, Repo2Run-style provisioning, snapshot-cache

### WO-13 · Stack-grounded design & extract (sub-problem #4, item 1) — ✅ DONE (advisories deferred to WO-5/M-D)
*Make the planner aware of the stacks `setup` detected. Cheap, high-leverage; the planner was stack-blind (freeze §9 item 8). Additive — no schema break. **Plan:** `docs/plans/2026-06-30-wo13-stack-grounded-decomposition.md` (v2, independently reviewed: feasibility/adversarial/scope). Shipped via TDD + crux Opus review + overall Opus review; full suite green.*
- [x] ✅ Feed `profile.components` (kind + paths + commands) into `designVars` and `extractVars` via a **new `{{detected_stacks}}` prompt block** (`prompt-vars.ts` `stackSummary` + a no-detect fallback; `prompts/design.md`, `prompts/design-extract.md`). Commits `5dc7960`, `38b9603`. *(Used a NEW placeholder, not `{{stack}}` — that slot is populated by `promptVars` and would be clobbered.)*
- [ ] 🔵 *Validate/guide `kind` + the cross-stack coupling signal → **DEFERRED to WO-5/M-D** (operator decision, post-review).* Coupling cannot be computed honestly while detectors emit whole-repo `["**"]` paths (folder-glob → ≈100% false positive, or silent misses); it becomes reliable only with **WO-5 file-identity**, and **M-D** (which already depends on WO-5) consumes it. The off-stack-kind warning is redundant given the prompt grounding above.
- *Acceptance:* on a multi-stack fixture, the `design`/`design-extract` prompts list the real detected stacks; existing prompt/render suites stay green.

### Milestone M-D · Cross-stack design & implement coordination (sub-problem #4, items 3–4) — 🔵 FOLLOW-ON, first-class, separate
*The heavier half of sub-problem #4: make implement aware of the other side of a contract, and stop splitting coupled work into mutually-blind dispatches. **Modifies the closed S1–S10 control-loop catalog** → requires its own brainstorm/spec + `control-loop.md` revision + independent review before implementation. Consolidates the former WO-10 items 3–5. **Depends on WO-13 landing first.***
- [ ] ⬜ **Attach cross-stack context to the implement prompt** — the unit's own `files_to_touch`, its `depends_on` siblings (and what they changed), and any shared contract artifact (`prompt-vars.ts:69-92`, `prompts/implement.md`; today all absent, `stack` is `""`)
- [ ] ⬜ **Coupled-cluster = one unit in one context** — don't split contract-coupled work into separate blind dispatches; regrounded on Styre's *own* contract-drift evidence (not a vendor multi-agent claim). Touches `design:extract` decomposition + the resolver (`resolver.ts`).
- [ ] ⬜ **Cross-stack coupling signal** (a unit whose files map to >1 stack) — computed on **WO-5 file-identity** (moved here from WO-13; folder-glob `["**"]` can't compute it honestly). Feeds the coupled-cluster + blast-radius items.
- [ ] ⬜ **Dependency-graph blast-radius before dispatch** — blocked on WO-5 rung-3 import-inference (no cross-language graph exists yet)
- [ ] ⬜ **Implicit-contract + no integration test → human gate at design** — changes S2; the design-time analogue of the T2 gap
- [ ] ⬜ A >context-budget coupled cluster bubbles to the human checkpoint as "too big to verify atomically"
- *Interim safety net until M-D ships:* `verify:integration` + T2 PR-body gap-surfacing — catches drift only when the repo has integration tests (else it's the T2 ceiling, freeze §13 #5).

---

## Part D — Done-vs-remaining at a glance

- **Fully landed & aligned (✅):** WO-1 (M-A security), WO-2 (M-C1 registry/engine/invariants), the 6 detectors + SKIP + warning in WO-3, the conventions rung + confirm ladder in WO-4, Rust reactor in WO-8, the per-verify recompute in WO-7, the existing PR-body gap surfacing + MERGE gate in WO-11, **WO-13's stack-grounded prompt decomposition (commits `5dc7960`, `38b9603`)**, **WO-4's AGENTS.md command source (commit `de4c80d`)**, and **WO-5's file-identity routing + run-all safety (commits `0b941c0`/`0b1e9ea`/`6384811`; TDD + per-task + overall Opus reviews)**.
- **Interim (🟡 — landed, mechanism to be replaced):** folder-glob routing (WO-5/WO-6), the Node co-located carve, the Node per-member walk.
- **In-feature, not started (⬜):** Ruby/PHP/`prepare` (WO-3); scoped CI-reading + precedence wiring (WO-4; AGENTS.md half done); **the cost refinement** (WO-6: the *named* global-file set + the T1 over-budget branch + cost measurement — the safety mechanism itself landed in WO-5); Python/Go/JVM non-root via identity (WO-9); explicit-artifact contract gates (WO-10 items 1–2).
- **Named follow-on milestone (🔵 first-class, separate):** **Milestone M-D — cross-stack design/implement coordination** (implement-time cross-stack context, coupled-cluster one-context, dependency-graph blast-radius, implicit-contract design-gate). Modifies the closed S1–S10 catalog; needs its own spec + `control-loop.md` revision + review; depends on WO-13.
- **Out-of-feature (🔵 — reframe / run-loop / commercial):** persist+watch the graph (WO-7); JVM/Go reactors (WO-8); rung-2/rung-3 classification (WO-5); the pre-PR interactive hold (WO-11); the OSS env-bubble belongs to the run-loop (WO-12).
- **Rejected (❌):** `scopeColocatedRoots` (WO-9); commercial env-provisioning (WO-12).

**The DONE line.** Polyglot setup is *complete* at **WO-1…WO-6** (security, registry, detectors, command discovery incl. AGENTS.md + scoped CI, file-identity rung-1 + the two re-expressions, gates/triggers + run-more-when-unsure) **plus WO-9's non-root via identity and WO-13's stack-grounded decomposition**. Everything from WO-7's persistence on — including **Milestone M-D** (cross-stack implement coordination) — is additive, follow-on, run-loop, control-loop, or commercial.

**The cardinal sin is now killed (WO-5, landed).** File-identity routing + the run-all advisory sweep mean an unowned file in a mixed diff can no longer ride through silently. **The single most load-bearing *remaining* item is WO-6's cost work:** the run-all sweep is un-costed and frequent in polyglot repos (freeze §13 #1) — measure it, add the over-budget branch + the named global-file set. (Also un-recorded today: a *passing/empty* sweep leaves no positive trace that an unowned file was present — a WO-6 surfacing nuance.)

---

## Part E — Prescribed sequencing (build order)

Two facts drive the order: **(1) WO-5 + WO-6 are the foundation** — they change the routing primitive (folder-glob → file-identity) *and* bump the profile schema, so all routing-touching work (more detectors, non-root, contract gates, the gap report) must be built on the new shape or it gets reworked. **(2) WO-13 → M-D is an independent track** — stack-grounded decomposition doesn't touch routing; it can run in parallel and it unblocks M-D.

Only three items have **no upstream dependency** (possible starting points): **WO-13**, **WO-4/AGENTS.md**, and **WO-5/6**. Everything else hangs off WO-5/6 or WO-13.

### Dependency graph (compact)

```
WO-13 (indep) ───────────────► Milestone M-D
WO-4 / AGENTS.md (indep)
WO-5 ⇔ WO-6 (foundation) ─────► WO-3, WO-9, WO-10(1–2), WO-11-extend, WO-8
CI-reading ── gated by the §13 pilot (a decision, not a WO dependency)
```

### Recommended linear order (single implementer)

**Phase 1 — cheap, independent wins (no dependency on the routing change):**
1. **WO-13** — stack-grounded decomposition. The 6 detectors already landed but the planner ignores them today; closes that gap cheaply and is the prerequisite for M-D.
2. **WO-4 (AGENTS.md half)** — consume `AGENTS.md`. Independent, standards-compliance. *(CI-reading stays gated behind the §13 pilot — do the pilot, then decide; don't build it blind.)*

**Phase 2 — the foundation (the load-bearing correctness fix):**
3. **WO-5 + WO-6 together** — file-identity rung-1, re-express the implement Bash allowlist + the A1 test-file gate, the `schemaVersion` bump; gates/triggers + run-more-when-unsure + the cost branch. **Start with the T1 cost spike** (measure run-all before committing the design — freeze §13 #1). Fold in WO-7's snapshot-store. Kills the mixed-diff silent under-verify.

**Phase 3 — conform breadth + contracts to the new model:**
4. **WO-3** — Ruby/PHP detectors + the `prepare` class, authored clean in the identity model (avoids folder-glob-then-rework).
5. **WO-9** — Python/Go/JVM non-root via identity + `uniquifyNames` (bundled; uniquify has no consumer until dir-named components exist).
6. **WO-10 items 1–2** — explicit-artifact contract gates (ride WO-6's trigger→gate model).
7. **WO-11 extension** — extend the PR-body gap report to the full set (untested seam / couldn't-run / skipped-for-cost); needs WO-6's gap signals.
8. **WO-8** — JVM/Go reactor parsers, *reconciled* with identity (likely shrinks to minimal/optional once classification is by identity).

**Phase 4 — the follow-on milestone (separate, first-class):**
9. **Milestone M-D** — cross-stack implement coordination. Own spec + `control-loop.md` revision + independent review; depends on WO-13.

**Not in this sequence (commercial / run-loop / additive-on-demand):** WO-7 persist+watch, WO-11 pre-PR hold, WO-12 (commercial/run-loop); WO-5 rung-2/rung-3 (add only when over-verify is observed / a repo forces it).

### Parallel-track split (if two implementers / two plans)

- **Track A — foundation:** WO-5/6 → conform breadth/contracts (WO-3, WO-9, WO-10(1–2), WO-11-ext, WO-8).
- **Track B — planner/cross-stack:** WO-13 → Milestone M-D.
- The tracks converge only when M-D wants WO-5's rung-3 import-inference for the dependency-graph blast-radius.

### The one judgment call (operator)

The order above leads with **cheap independent wins (Phase 1), then the foundation (Phase 2)** — chosen because WO-13 is days not weeks, makes the landed detection immediately useful, and unblocks the M-D track. The **correctness-first** alternative is to do **WO-5/6 immediately** (it's the actual silent-under-verify fix) and slot WO-13 + AGENTS.md alongside/after. Pick Phase-1-first for momentum + planner value; pick correctness-first if the mixed-diff under-verify risk is the more urgent concern.

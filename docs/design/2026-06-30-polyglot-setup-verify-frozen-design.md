# Polyglot `styre setup` + verify — frozen design record

**Status:** **FROZEN DIRECTION** — the converged model and the operator decisions are recorded and stable; several feasibility tensions are explicitly **OPEN / AT-RISK** and must not be read as settled (see §6 status labels and §13 "Open risks"). Revised 2026-06-30 after an independent five-reviewer, code-grounded adversarial pass (see §14 changelog).
**Date:** 2026-06-30
**Branch:** `feat/polyglot-setup` (M-A / M-B / M-C1 pushed, no PR — operator merges personally).
**Scope:** how `styre setup` learns a repo across languages/stacks, and how verify routes a diff to the right checks — for single-stack, co-located, non-root, multi-module, and cross-stack repos. Covers OSS responsibility and the OSS↔commercial-plane seam.
**Audience:** a future implementer or reviewer who needs the *whole* picture — why the abstraction changed, what every independent review caught, what the field does, and which doors are deliberately still open.

**Consolidates:**
- `docs/brainstorms/2026-06-28-polyglot-setup-language-agnostic-design.md` (v2.1 — M-A/M-B)
- `docs/brainstorms/2026-06-28-setup-verify-security-findings.md` (F1–F4)
- `docs/brainstorms/2026-06-28-setup-completeness-design.md` (v2 — M-C registry)
- `docs/plans/2026-06-29-m-c2a-engine-naming-scoping.md` (the rejected carve)
- the Q1–Q20 open-questions register, the T1–T3 operator decisions, and the four-area competitive/tooling research (all from the 2026-06-29/30 design session; transcript `e258db63`).

---

## 0. TL;DR

Styre's `run` loop is already language-agnostic. The gap was entirely in `setup` (detection) and in the *abstraction* verify uses to route a diff. We:

1. **Hardened** the discovery→verify command path (M-A: closed four live security holes F1–F4).
2. **Widened** deterministic detection from Rust/Node to +Python/Go/JVM-Maven/JVM-Gradle (M-B), then refactored the hardcoded branches into a **`LangDef` registry + a generic engine** with two machine-channel security invariants (M-C1). All shipped, all reviewed on Opus, all "ready to merge."
3. **Hit the wall of the wrong abstraction.** "A component owns a folder" silently *under-verifies* when stacks interleave inside a directory, when code is co-located at the root, or when the tree drifts after the profile is frozen. The forced-fix carve (`scopeColocatedRoots`) was designed, reviewed, and **rejected** for exactly that under-verify failure.
4. **Re-thought the whole mechanism from first principles** and **researched the competitive/tooling field** against a numbered register of open questions (Q1–Q20).

**What the field gives us and what it doesn't.** The converged model assembles the disciplined field's best practice for the *routing/safety **rule*** given a classification — Bazel/Pants attribute by file identity, Azure TIA runs all on the unknown, Nx materializes the graph, buf/oasdiff/Pact gate explicit contracts. But the genuinely hard part those tools get for free — **they read declarations the repo authored (BUILD files, import metadata, workspace manifests); Styre must work on arbitrary repos that declared nothing** — is unsolved by the field and is **Styre's own burden.** So "we're just assembling best practice" is true for the rule, *not* for the classification.

**The frozen model:** classify files to stacks **by identity, not folder**, on a depth ladder — the *frozen* rung is **coarse extension+manifest attribution (CODEOWNERS-grade)**; the Pants-grade content/import-inference rung that resolves the hard interleaving cases is **deferred**. A repo is a set of **gates** (pass/fail commands) each with a **trigger** (which file changes run it); verify runs every triggered gate and follows the field-universal safety rule **"unknown / global / ambiguous → run everything"** — bounded, but with a real and currently-unvalidated cost (§6 T1, §13). The file→gate map is **recomputed per verify from the diff** in OSS (persistence/tree-watching is a commercial optimization, *not* the OSS design). Cross-stack contracts are caught only via **explicit artifacts** (run buf/oasdiff/Pact when one is in the diff); the implicit remainder is handled by **surfacing the gap into the PR body**, with the existing post-PR **MERGE** gate as the human decision point (a *hard pre-PR interactive hold* is commercial). Styre's two candidate edges: **reading the repo's CI** to draft commands (higher repo coverage than AGENTS.md — but its high-value slice is the commercial env layer; see §6/§13) and the **dependency-aware scheduling + gap-surfacing-before-merge** backstop for the implicit-contract frontier.

**Design & implement across stacks (sub-problem #4).** This is a *different problem* from verify routing, and it is only **partially** handled today. The loop already represents multi-stack work (work units with a dependency DAG, per-unit dispatch, per-component verify, a ticket-scope integration check), but the **planner is blind to the detected stacks** and the **implementer is blind to the other side of a contract**. The freeze pulls the cheap, high-leverage fix — **feed the detected stacks into the planner** (stack-grounded decomposition) — onto the DONE line, and names the heavier **cross-stack implement coordination** (coupled-cluster one-context, implement-time cross-stack context, blast-radius) as a **separate first-class follow-on milestone (M-D)**. Full grounding + the split is §9 item 8.

---

## 1. Origin & motivation

The arc began as a **bench/testing harness** for the OSS core: pull the latest `styre` binary from Homebrew, clone high-visibility OSS repos with real high-severity issues, synthesize Linear tickets, run styre end-to-end, and review the output with independent blind reviewers, scored by language × difficulty.

Building that surfaced a blocker: **`styre setup` auto-detected only Rust and Node.** `detectComponents` had two `existsSync` branches (`Cargo.toml`, `package.json`); any other primary stack returned an empty, command-less profile → verify resolved zero commands → `error`, never `pass`. And the discovery agent could not fill the gap by design: `mergeComponents` does `scan.map(...)` and **drops agent-invented components** (`discover-schema.ts`), the TTY ladder only fills *missing* commands on *existing* components. So a polyglot harness was impossible until `setup` itself became polyglot.

That reordered the work: **make `setup` truly language/stack-agnostic first; the bench is downstream.** Critically, the operator scoped the setup feature **by its own completeness contract, not by what the bench happens to exercise** — Ruby/PHP and non-root/multi-module repos are completeness fixtures for the *feature*, not optional just because the first bench corpus wouldn't hit them. (Only C/C++ was an explicit operator deferral.)

---

## 2. Problem decomposition

The operator named the real problem as five sub-problems — the design must answer all five, not just detection:

1. **File → stack ownership.** Given a changed file, which stack(s) own it? (Extension? extension + nearby manifest? extensionless files? extensions shared across stacks — `.json`, `.yaml`, `.sql`, `.sh`?)
2. **Per-repo command discovery.** How do we learn a stack's *actual* build/test/verify commands *in this repo* (not the ecosystem default, which often doesn't run)?
3. **File diff → verify routing.** Given a diff, which checks must run?
4. **Cross-stack design & implement.** How do we design and implement a ticket that cuts across multiple stacks in a monorepo?
5. **Cross-stack verify.** How do we verify such a ticket — including the seam between stacks?

The early code answered only #1/#3, and answered them with a brittle abstraction (below). Sub-problem **#5** (cross-stack verify) is handled — verify fans out per impacted component and a ticket-scope `verify:integration` runs after all units pass. Sub-problem **#4** (cross-stack design/implement) is **only partially** handled today; it is split into an in-feature fix (stack-grounded decomposition) + a first-class follow-on milestone (cross-stack implement coordination) — see §9 item 8.

---

## 3. The mental-model evolution

**v0 — "a component owns a folder."** A component = stack kind + path-globs + commands. Verify matches a changed path to a component by glob (`impactedComponents` / `matchesComponent`, `new Bun.Glob(g).match(path)`) and runs that component's commands. Clean for a tidy monorepo; **wrong** in three common shapes:

- **Interleaving.** Python and a frontend both live under `src/`. A folder-owned component can't split a directory, so one stack's files get routed to the other's commands — or to nothing.
- **Co-location at the root.** Two stacks rooted at the repo root (SvelteKit `package.json` beside `src-tauri/Cargo.toml`) both legitimately want `["**"]`; folder-ownership has no principled carve.
- **Staleness / mixed-diff under-verify.** Note the failure is *narrower* than "any unmatched file is silently skipped": a diff that matches **no** component is already a **loud** `no-component-matched` error (`handlers.ts:362` inserts an `error` signal and throws). The genuinely-silent case is a **mixed diff** — some changed files match a component (so verify proceeds), while *other* changed files match nothing and **ride along ungated**; plus profile **staleness** (a new top-level directory added after setup routes to no component). **Silent under-verify is the cardinal sin** (it ships untested code claiming "verified"), and the mixed-diff/staleness cases are exactly where v0 commits it.

**v1 — "gates + triggers + file-identity + run-more-when-unsure."** The reframe that the research later validated wholesale:

- A repo is a set of **gates** — pass/fail commands (a test suite, a linter, a type-check, a contract check).
- Each gate has a **trigger** — the set of file changes that should run it.
- A file is classified to a stack **by its identity** (extension, then nearby manifest, then — deferred — import-inference), **not by which folder it sits in**.
- Verify runs **every triggered gate**, and when a change is **unowned, global, or ambiguous, it runs everything**. It **never claims "verified" if a relevant gate could not run** — that becomes a reported gap, not a silent green.
- The file→gate map is **recomputed per verify from the diff** (the input is a small diff, not a whole-repo walk). The classification *rules* are frozen in the profile; the map itself is derived fresh each verify. (Persisting the map and keeping it live via a watcher is an Nx-daemon-style optimization that belongs to the *commercial* plane, not the one-shot OSS runner — see §6 Q10, §9.4, §10.)

This is the model the rest of this document freezes.

---

## 4. What shipped (and what each review caught)

All three milestones followed the same loop: brainstorm → spec → **independent multi-agent code-grounded review** → revise → subagent-driven TDD → independent per-task reviews → Opus final whole-branch review → push (no PR).

### 4.1 M-A — harden the discovery→verify command path (shipped)

Four **pre-existing, live** holes on the path `setup discovery agent → profile.json → sh -c at verify` (the verify sink is `Bun.spawn(["sh","-c",command])`, full shell, no sandbox; the operator-confirm was **TTY-only**, so headless setup skipped it entirely):

| ID | Hole | Severity | Fix |
|---|---|---|---|
| **F1** | Headless agent **command injection** — agent `commands` is `z.record(string,string)`, `mergeComponents` lets agent values *override* a machine component's command, probe checks only the first token, headless has no confirm. | HIGH | Reject shell metacharacters in any agent command (all modes); headless **rejects agent command overrides** unless `--trust-agent-commands`; **per-command provenance** (provenance follows the string, not the component). |
| **F2** | Ungated **`repoCommands`** side channel — returned verbatim, never probe-filtered, executed raw at `verify:integration`. | HIGH | Same metachar ban + probe + headless-trust gate applied to `repoCommands`. |
| **F3** | `..` **path-traversal** past the anchor guard — `src/../**` starts with `s`, passes the leading-`*` check, normalizes to `**`, matches the whole tree (widens verify *and* the implement Bash allowlist). | MEDIUM | Reject any glob with a `..` path segment (agent path guard `discover-schema.ts:34` splits on `/` and checks segments; engine backstop is `isSafePath` in `manifests.ts`), normalize, and **drop** (don't crash on) a component left with zero paths. |
| **F4** | **`ANTHROPIC_API_KEY` reachable by verify-time commands** — `agentEnv` is a denylist stripping only `LINEAR_API_KEY`/`GITHUB_TOKEN`; verify runs agent-authored worktree code that can exfiltrate the key. | MED-HIGH | **Split the env policy**: `verifyEnv` = `[...AGENT_ENV_DENYLIST, "ANTHROPIC_API_KEY"]`; the agent-CLI spawn keeps `agentEnv` (which retains the key). |

Operator decision **A1**: a *narrow*, command-scoped `--trust-agent-commands` headless opt-in (NOT the rejected component-invention flag). The earlier review had killed a v1 proposal to let the agent *invent components*: YAGNI for the manifest-bearing corpus, and it keyed safety on the wrong axis (component existence vs the dangerous artifact, the command string). That decision — *"the scan anchors existence; the agent does not invent stacks"* — stays closed.

### 4.2 M-B — deterministic breadth (shipped)

Root-only (single-module, `paths:["**"]`) detectors for **Python** (runner ladder: tox → nox → `pytest.ini` → `pyproject [tool.pytest]` → `python -m pytest`), **Go**, **JVM-Maven**, **JVM-Gradle** (`./mvnw`/`./gradlew` wrapper-aware). Extended the manifest-walk `SKIP` set (`.venv`, `venv`, `.tox`, `__pycache__`, `vendor`, `.gradle`, `.mvn`, `Pods`, …) so the depth-3 walk doesn't descend into dependency trees and emit phantom components. Added `unrootedManifestWarnings` — a **loud note** when a targeted-language manifest exists only in subdirs (fails *safe*: no component, operator informed). Multi-module deferred to a loud N=1 root. *(Note: the Python ladder has no `manage.py`/Django rung — that was a brainstorm proposal that was never implemented.)*

### 4.3 M-C1 — the `LangDef` registry + engine (shipped)

Replaced the hardcoded branches with a registry + generic engine, **behavior-preserving** (proven by the unchanged `detect-components.test.ts` matrix across the M-C1 commit range `4c18e2d..da05dc4`):

```ts
interface LangDef { kind: string; detect(repoDir): Component[] }
function runRegistry(repoDir, registry): Component[]  // applies both invariants
```

Plus **two machine-channel security invariants** the old branches lacked — generalizing M-A's *agent-only* guards to the engine's own output:

- **Invariant 1 (command backstop):** every engine-emitted command passes `isCommandSafe` or **throws** (loud). Resolvers must select a *fixed* string and must not interpolate any repo-derived token. (Fixed constants like `./mvnw` are fine; the ban is on repo-derived tokens.)
- **Invariant 2 (path backstop):** every engine-emitted glob passes `isSafePath` (no absolute, no `..`, no unanchored `^*` except the lone structural `**`). `safeMember` sanitizes workspace-member strings so a `members=["*"]` declaration can't produce an always-matching component.

The leaf module `src/setup/manifests.ts` (SKIP, `findManifests`, `safeMember`, `isSafePath`) was extracted specifically to break a registry→lang→engine→registry **circular import** the feasibility review caught in the M-C1 plan.

### 4.4 Design errors the independent reviews caught (the load-bearing ones)

- **The agent cannot narrow paths (v1's #1 error).** v1 said "root component gets `["**"]`, the agent narrows it." Three reviewers proved `mergeComponents` only **unions/widens**, and M-A actively *strips* `["**"]` from agent output. → The **engine** must scope deterministically; the agent is labelling/gap-fill, never path-correctness.
- **Over-verify, never under-verify.** v1's best-effort reactor member parsing could silently miss a module. → Low-confidence parsing degrades to **one component at the workspace root** (runs everything), never to parsed-member globs.
- **Guard the machine channel.** M-A's guards were wired to agent output only; the engine bypassed them. → Invariants 1 & 2 above.
- **`prepare`/install is detect-only.** Setup detects+stores a config-aware `prepare` command but does **not** run it; running install + provisioning toolchains is the separate downstream *environment* workstream.

---

## 5. The rejected approach — `scopeColocatedRoots` (and the sound sibling)

M-C2a proposed two engine post-passes. Neither shipped. One is sound (retain); the other is the instructive failure.

**`uniquifyNames` (sound, unshipped):** guarantee unique component names — a name shared by ≥2 components is qualified `<kind>-<name>` (then `-<n>`). Pure, behavior-preserving for single-stack repos, and a prerequisite for dir-named (non-root) components, since agent-refine reconciles by name. **Retain; it lands *with* non-root detection, not before** (it has no consumer until dir-named components exist).

**`scopeColocatedRoots` (rejected):** when ≥2 stacks co-locate at the root, rescope each `["**"]` component to "the repo's top-level entries **minus** those owned by sibling components." It was designed and TDD-specced (but never committed) and **rejected by adversarial review** because it reintroduces the exact failure the whole model exists to prevent:

- **It drops a root stack's coverage of interleaved code.** Python files under `src/` (claimed by a frontend sibling) fall outside the carve → no Python gate runs on them → **silent under-verify.**
- **It is stale by construction.** A directory added after setup is owned by nobody → routes to nothing → untested merge.

The carve is "folder-ownership patched with subtraction" — still folder-ownership. That's what forced the deeper re-think (§3 v1): the fix is **classify by file identity**, not carve folders. `scopeColocatedRoots` is **rejected and should not be built**; it is recorded here as the worked example of why the abstraction had to change.

---

## 6. Open-questions register (Q1–Q20) + three deep tensions

The full register, posed during the deep re-think. **★ = load-bearing**. Status reflects this freeze — and note several are **OPEN**, not resolved.

### The three deep tensions

- **★ T1 — Safety vs. cost.** "Run more when unsure" guarantees we never ship untested code, but the broadest checks are the most expensive and verify runs many times per ticket. — **VALUES DECIDED: safety wins on collision. COST-FEASIBILITY OPEN (fulcrum risk):** the field's tools make "run-more-when-unsure" *rare* via the declarations they read; Styre imports the safety valve *without* that precision, so a weak classifier funnels the interleaving/global cases into run-all *frequently*, not rarely. Run-all is bounded (gates × per-command timeout, with the B3 wall-clock ceiling as backstop) but **un-costed** (B3 spend tracks agent $, not verify compute). The cost path must be measured and given an over-budget branch before this is truly settled (§9.3, §13).
- **★ T2 — The cross-stack ceiling.** Automated cross-stack verification can never exceed the repo's existing integration tests. — **DECIDED via plane-split (§7):** OSS surfaces the gap into the PR body and the existing **MERGE** gate is the human decision point; a *hard pre-PR interactive hold* is commercial. (The literal "block before PR" reading would break the headless OSS runner — see §9.6/§10.)
- **★ T3 — Where does styre's responsibility end?** — **DECIDED:** environment provisioning is largely commercial-plane; OSS surfaces the gap + allows skip; single-Dockerfile is the first commercial rung (§7, §10).

### Setup — learning the repo

1. **How replayable is a repo's CI, really?** — *Open scope (matrix, secrets, service containers, caches). The OSS slice is "extract the command string"; replaying the env is the commercial part (§13).*
2. **Picking one config out of a CI matrix** — *Open; deferred follow-up of the CI-reading work (§13).*
3. **Extracting just the gates** (build+test+lint) across CI styles — *Open; deferred follow-up.*
4. **★ Deterministic parse vs. agent judgment.** — **RESOLVED by best practice: deterministic-scan → bounded agent-draft → operator-confirm → frozen-into-profile; agent judgment lives at setup, never at the verify gate (§8, §9).**
5. **No-CI repos.** — *Open; SOTA is Repo2Run (commercial; number unverified — §13); OSS degrades to the gap-surfacing path.*

### Mapping files to checks

6. **The actual ownership signal?** — **RESOLVED as direction; frozen rung is COARSE: extension → nearby manifest. The content/import-inference rung that resolves shared-extension/interleaving cases is DEFERRED (§8 Q6, §9.1).**
7. **★ The unowned-but-build-affecting file.** — **RESOLVED: explicit global set → runs all gates; plus "unowned-and-not-obviously-docs → run all"; default conservative to avoid the Nx footgun (§8 Q7).** Cost interaction tracked under T1.
8. **Finding the boundary files.** — **RESOLVED on the detectable half (explicit-artifact gates); the implicit half is the industry-wide frontier → gap-surfaced at merge (§8 Q8, §9.6).**
9. **Detecting "generated."** — **RESOLVED pragmatically: SKIP vendored/generated dirs; unowned non-skip → run more. (Generated-*in-place* files — `*.pb.go`, `*_pb2.py` — are a known gap of extension classification; they currently fall to run-all. Dynamic coverage is the sound long-term answer.)**
10. **Recompute cost** of the file→check map. — **RESOLVED for OSS: recompute per verify from the diff (not a persisted live graph). Materialize-and-keep-live is a commercial optimization (§9.4).**

### Designing & implementing across stacks

11. **★ Coupled vs. independent stack work?** — **DIRECTION (not fully resolved): keep contract-coupled work one unit; split only graph-independent work. Substrate (a cross-language dependency graph) is DEFERRED — see §9.6/§13.**
12. **What's the unit of work now?** — **DIRECTION: a coupled cluster; near-term it is "the whole touched set sharing an explicit artifact" (no graph), not a transitively-computed cluster (§9.6).**
13. **Context limits.** — **DIRECTION with a named resolution: a coupled cluster that exceeds the context budget bubbles to the human checkpoint as "too big to verify atomically" rather than being silently split or partially loaded (§9.6, §13).**

### Verifying across stacks

14. **★ When to run expensive integration checks?** — **FOLDED into T1/T2: run if you can; if you can't, the human decides at the gap-surfaced merge.**
15. **Can we even run them?** — **FOLDED into T3/Q17 (commercial env layer).**
16. **★ The "couldn't run" verdict.** — **DECIDED: route through the existing `{unavailable}` → `untested-merge-risk` → PR-body gap → MERGE gate; never silently green (T2).**

### Environment provisioning

17. **★ How does a fresh worktree get toolchains and deps?** — **DECIDED: largely commercial-plane; single-Dockerfile first; OSS surfaces the gap + allows skip (T3).**
18. **Per-repo or per-run, cached or fresh, who pays?** — *Open; deferred to the commercial environment workstream (§10).*

### Rolling it all up

19. **The merge verdict.** — **FOLDED into T2: the roll-up surfaces gaps into the PR body; the MERGE gate is the decision.**
20. **Determinism of the whole artifact.** — **RESOLVED: deterministic where possible; agent judgment bounded at setup + operator-confirmed + frozen. NOTE: a routing-primitive change (folder-glob → identity) is a `ComponentSchema`/`schemaVersion` change — a deliberate, versioned seam revision, not a "no-op" (§9.1, §10).**

> The operator's own read: **T1, T3, Q17 are the fulcrum** (cost, scope, environment); **T2 is the one we can't engineer past** — we can only decide how honestly to report it. The freeze takes that seriously by leaving T1's cost question and the cross-stack substrate **open** rather than asserting closure.

---

## 7. Operator decisions (verbatim intent)

- **T1 — safety first.** When safety and cost collide, safety wins. *(This settles the values question only; the cost-feasibility of the safe default is an open risk — §6 T1, §13.)*
- **T2 — the harness never merges on its own; its job is to open a PR, and it must bubble a hard human acceptance with a 3-way signal** (OK-without-integration / harness-missed-them / stop). **Frozen realization (plane-split):** in OSS this is **surface-the-gaps-into-the-PR-body + the existing post-PR MERGE human gate** — never a synchronous pre-PR block, because the OSS `run` is the headless CI/fleet primitive with no human present. A *hard pre-PR interactive hold* (ask → skip/accept → then open) requires the commercial bubble-up/inbox and is **commercial-plane**. (This aligns with the operator's own T3 instinct that interactive infra "should be thought about in the commercial plane, not OSS.")
- **T3 — environment provisioning is a very large requirement** (Docker / k8s / Terraform / cloud; many repos ship no infra). **OSS behavior: surface the gap, allow the human to skip, then open the PR.** The simplest infra case — a single Dockerfile — **belongs in the commercial plane.**
- **Earlier AskUserQuestion decisions (M-C framing):** *capability bar + bounded first-class set + cheap extension*; multi-module *idiomatic per ecosystem* (reactor→1 component, npm→per-member); architecture = *a registry of definitions*; first-class set = the 5 done **+ Ruby + PHP**; iOS/Android deferred; C/C++ on the extension path; the agent stays *always-on refine* (M-A-gated).

Q14/Q16/Q19 collapse into one rule: **run the check if you can; if you can't, the human decides at the gap-surfaced merge, and the gap is always reported.**

---

## 8. Competitive / tooling research, mapped to the questions

Four parallel researchers swept the field against Q1–Q13/Q20: (1) repo onboarding, (2) test-impact analysis, (3) monorepo project graphs, (4) cross-package/contracts. **The model we converged on assembles the disciplined tools' best practice for the *rule*; the classification on an undeclared repo is the part the field gets for free and Styre doesn't.** Every single-study/single-vendor number below is **directional, not decision-anchoring** — the four that gate decisions are listed for confirmation in §13.

### Three headlines

1. **Identity-not-folder attribution is the proven routing principle.** Folder-containment is the common-but-broken default — **Turborepo, Rush, Lage, Moon cannot split a directory.** The tools that get it right attribute by file identity: **Bazel** (`glob(["**/*.py"])` in `srcs`), **Pants** (per-language import inference), **CODEOWNERS** (`src/*.go @team-go`, last-match-wins). **Caveat:** Bazel/Pants get this from *declarations the repo authored*; Styre's frozen rung is **coarse extension+manifest (CODEOWNERS-grade)** — the Pants-grade content rung that actually reads imports is deferred (§9.1). So the principle transfers; the *strength* of Styre's first cut is weaker than the citation implies, and the hard cases fall through to run-all.
2. **"Unknown / global / ambiguous → run everything" is the field's universal safety valve.** Azure TIA runs all on any file type outside its model; Nx/Turbo invalidate on declared globals; Lage's "unowned → all affected" is filed as a bug but is the *safe* direction. The soundest systems are **dynamic/coverage-based** (Ekstazi, SeaLights). Static graphs have a *measured* reflection blind spot (STARTS ~5.94% — directional). **But the cited tools fire this valve rarely** (declared precision); Styre fires it often (no declarations) — the cost asymmetry is the T1 risk.
3. **Reading the repo's CI is uncrowded — but the field's avoidance is defensible.** *No* mainstream agent parses CI to learn commands (Copilot, Codex, Devin, Jules, OpenHands all make a human re-express them in prose). The steelman for the field: CI is *unreplayable* (matrix, `secrets.*`, `services:` containers, OIDC, self-hosted runners) — the command string is the cheap last line; the env is the expensive 90%, and AGENTS.md exists *because* CI doesn't port. So CI-reading is a **higher-coverage command-draft source**, not an unambiguous edge (see Q2 below).

### Mapped to the question clusters

**Q2 / Q4 / Q5 / Q17 — learning commands + environment.**
- *Field:* committed prose config — **`AGENTS.md`** (reportedly an LF-governed standard, ~20k repos — *unverified, §13*), plus container/VM + setup script with **snapshot-caching** (Devin reportedly 30 min → 200 ms — *directional*). Deterministic committed config beats agent exploration ("slow and unreliable"); Devin/Factory **auto-generate a draft for human approval.**
- *styre:* deterministic-scan → bounded agent-draft → **operator-confirm** is the field's converged shape. Command sources, in priority: **read CI (higher coverage, but a command-*draft* only — its env-replay value is the commercial slice)**, **consume AGENTS.md (the standard)**, **conventions (fallback)**. No-CI repos are unsolved in products; SOTA is **Repo2Run** (ByteDance — 86% on Python repos *per a single preprint; venue/scope unverified, §13*) — commercial-plane ambition; OSS degrades to the gap-surfacing path. **Before CI-reading is built near-term, a pilot must show gate-extraction over real matrix/composite/reusable workflows beats AGENTS.md+conventions (§13).**

**Q6 — file → stack.** Classify by **identity, depth ladder**: extension-match (cheap, CODEOWNERS-grade — the **frozen** rung) → manifest association (rung 2, add when over-verify is *observed*) → import-inference (rung 3, Pants-grade — **deferred**, the cost ceiling and the only rung that earns "content-based"). Enumerated failure classes of the frozen coarse rung, **all of which currently resolve to run-all**: shared extensions in interleaved dirs (`.json`/`.yaml`/`.ts`/`.kt`); generated-in-place (`*.pb.go`, `*_pb2.py`); polyglot single files (`.vue`/`.svelte`/`.ipynb`); non-SKIP vendored trees/submodules.

**Q7 — build-affecting / global files.** Maintain an **explicit global set** (lockfiles, root configs, the CI file, base Dockerfile) → change runs **all** gates; plus "unowned-and-not-obviously-docs → run all." Exactly **Nx `sharedGlobals` + Azure TIA's fallback** — but **avoid the Nx footgun** (undeclared globals → silent misses). **We default conservative.** Cost interaction → T1.

**Q9 — generated / unowned.** SKIP vendored/generated dirs; unowned non-skip → run more. Generated-in-place is a known coarse-rung gap. Dynamic coverage (Ekstazi) is the sound later option — attractive because styre runs tests in its loop anyway.

**Q10 — cost / storage of the map.** Nx serializes the graph **and runs a daemon that watches the tree** to keep it live. **That is a cross-invocation, persistent-process optimization — incoherent for the one-shot, ephemeral-SQLite OSS `run`.** OSS therefore **recomputes per verify from the diff** (cheap; the diff is the input). Persistence/watching is a *commercial* optimization, placed with the daemon in §10.

**Q8 / Q11 / Q12 / Q13 — cross-stack.**
- *Coupling:* propagate through a dependency graph — **Nx `affected`**. Knowable only via static same-language imports or an explicit artifact. **Styre has no such graph yet (it needs rung-3 import-inference) — so the near-term cross-stack model is explicit-artifact-only, no graph.**
- *Boundaries/contracts:* only **explicit artifacts** are catchable — `.proto`+**buf**, OpenAPI+**oasdiff** (*Optic reportedly archived Jan 2026 → oasdiff dominant; unverified, §13*), **Pact**, **Apollo GraphOS**. Implicit REST-by-string: **nobody catches statically** (Postman: 60%+ of integration failures are these — *directional*).
- *Agent work:* the field reportedly converged on **single-context atomicity** (Cognition) — change all sides in one window, not multi-agent splitting. **Caveat:** Cognition's argument is about *multi-agent* fragmentation; Styre's old per-`work_unit` split is *single-agent sequential dispatch over one SoT*, so the transfer is not automatic. Ground the reversal on **Styre's own contract-drift evidence**, not the vendor position. Practical ceiling ~2,500 files (*round, unsourced — directional*); a cluster exceeding it **bubbles to the human checkpoint**, it is not silently split or partially loaded.
- *styre:* keep contract-coupled work **one unit** *for the modal small cluster* (a `.proto` + its impl + its caller); near-term cluster = the whole touched set sharing an explicit artifact (no transitive walk); **run buf/oasdiff/Pact as gates**, degrading a missing tool through the existing `{unavailable}` → `untested-merge-risk` path; implicit contract + no integration test → **gap-surfaced at merge** (T2).

**Q20 — determinism.** Deterministic given identical inputs. The non-deterministic parts are the agent-judgment ones (CI prose, boundary inference) — bounded at setup, operator-confirmed, frozen. **The seam is *not* unchanged:** moving the routing primitive from `paths` to identity changes `ComponentSchema` and bumps `schemaVersion` — a deliberate, versioned seam revision (§9.1, §10).

### What the research resolves vs. leaves open

- **Settled by best practice (adopt):** gates+triggers; the identity-not-folder routing *principle* (Q6, coarse rung); explicit-global + run-more-when-unsure (Q7); per-verify recompute (Q10); explicit-artifact contract gates (Q8); deterministic-scan→agent-draft→confirm→frozen (Q4).
- **Genuinely open / a scope call:** the **cost-feasibility of run-all** (T1); whether CI-reading beats AGENTS.md+conventions in OSS (Q2 — needs a pilot); how deep to push import-inference (rung 3); the cross-stack dependency graph (deferred substrate).
- **Styre's two candidate edges:** (1) **CI-reading** as a higher-coverage command-draft source (value pending the Q2 pilot; the env slice is commercial); (2) **gap-surfacing-before-merge** as the universal backstop for the implicit-contract frontier no product solves.

---

## 9. The frozen converged design

The model that survives the re-think, the research, and the independent review:

1. **Classification by identity, not folder.** A file maps to stack(s) via a depth ladder — **extension → nearby manifest** (the *frozen, coarse* rungs) → import-inference (*deferred*). **`Component.paths` is overloaded today**: besides verify routing it also scopes (a) the **implement agent's Bash allowlist** (`scopedRunnersForFiles` — the capability-isolation invariant) and (b) the **A1 behavioral test-file gate** (`testFilePattern` matched against component paths). Replacing folder-glob routing therefore requires re-expressing *both* under identity classification — the implement allowlist becomes "the runner commands of stacks whose identity matches `files_to_touch`," and the test-file check becomes "a test file of this stack's identity exists." This is a **`ComponentSchema`/`schemaVersion` bump and a deliberate open-core seam revision** (existing `schemaVersion: 2` profiles are already hard-rejected by `parseProfile` on mismatch, so the migration path exists).
2. **Gates + triggers.** A repo is a set of **gates** (commands) each with a **trigger** (the identity set that runs it). Verify runs every triggered gate.
3. **Run-more-when-unsure (the safety rule), with a named cost branch.** **Unknown / global / ambiguous → run everything.** An **explicit global set** (lockfiles, root configs, CI file, base Dockerfile) runs all gates; unowned-and-not-obviously-docs runs all gates. **Never claim "verified" if a relevant gate could not run** — surface the gap. Run-all is **bounded** (gates × per-command `VERIFY_TIMEOUT_MS`, B3 wall-clock ceiling as backstop) but its compute is **not** in the B3 spend metric; because the coarse classifier (1) makes run-all *frequent*, the cost must be measured, and the **over-budget branch is: run the cheap tier, defer the expensive tier to the gap-surfaced merge — never silently narrow** (§6 T1, §13).
4. **Per-verify recompute (OSS).** The file→gate map is **derived fresh each verify from the unit diff** (`impactedComponents` already does this). Classification *rules* are frozen in the profile (operator-confirmed at setup). Persisting the map + keeping it live via a tree-watcher is an Nx-daemon-style optimization that belongs to the **commercial** plane, not the one-shot OSS runner.
5. **Command discovery, three sources in priority:** **read CI** (higher coverage; a command-*draft* — value pending the Q2 pilot, env-replay slice commercial) → **consume AGENTS.md** (the standard) → **conventions** (fallback). The agent *drafts*; the **operator confirms**; the result freezes into the profile. Agent judgment never reaches the verify gate.
6. **Cross-stack — explicit-artifact-only near-term.** Detect explicit contract artifacts (`.proto`/OpenAPI/Pact/GraphQL) and run **buf/oasdiff/Pact** when one is in the diff; a missing tool degrades via the existing `{unavailable}` → `untested-merge-risk` path. The near-term coupled unit is **the whole touched set sharing an artifact** (no dependency graph — that needs deferred rung-3 import-inference, and a transitively-computed cluster is a separate control-loop milestone, not setup/verify). A coupled cluster exceeding the context budget **bubbles to the human checkpoint as "too big to verify atomically."** The implicit-contract remainder + any "couldn't run" verdict → **gap-surfaced into the PR body**; the existing **MERGE** gate is the human decision (T2). *Reground the "one unit" preference on Styre's own contract-drift evidence, not a single vendor's multi-agent position.*
7. **`uniquifyNames`** is retained (lands *with* non-root detection); **`scopeColocatedRoots` is permanently rejected** (§5).
8. **Design & implement across stacks (sub-problem #4) — partially handled; split into in-feature + follow-on.** *Grounding (current code):* the loop already represents multi-stack work — `design:extract` emits `work_units` with `kind`, a `depends_on` dependency DAG, and `verify_check_types` (`schema.sql:129-161`); implement dispatches **one agent per unit** (`resolver.ts:106`) over a **fully-writable worktree** (so a unit *can* touch multiple stacks), with the Bash allowlist scoped to the **union** of the components the unit's `files_to_touch` touch (`components.ts:45`); verify fans out per impacted component and runs a ticket-scope `verify:integration`. **But two intelligences are missing.** *(a) Design is stack-blind:* `profile.components` from `setup` are **never shown** to the design/extract agent — the `{{stack}}` slot renders empty (`prompt-vars.ts:63,88`), `kind` is free text validated against nothing stack-related ("NOT a CHECK enum (stack-agnostic)", `schema.sql:133`), and there is no design-time unit→component link (the binding is path→component, computed only later at verify). So a cross-stack split is **unguided agent discretion**. *(b) Implement is context-blind:* the implement prompt carries only a one-line title + `kind` + joined test command — **not even the unit's own `files_to_touch`**, no sibling/`depends_on` context, no shared-contract notes (`prompt-vars.ts:69-92`, `prompts/implement.md`) — so an agent on one side of a boundary is blind to the other: the exact **contract-drift** the Q11–13 research warned of. The interim safety net is `verify:integration` + the T2 gap-surfacing — which only catches drift *if the repo has integration tests*; when it doesn't, that's the T2 ceiling.
   - **IN-FEATURE (on the DONE line) — stack-grounded decomposition (item 1):** feed `profile.components` (kinds + paths + commands) into the **design + extract** prompts via a new `{{detected_stacks}}` block, so the planner uses the real detected stacks. Cheap; without it the planner ignores everything `setup` detected — the whole point of polyglot detection is wasted at the planning step. (Work order **WO-13**; plan independently reviewed.) *(The originally-bundled item 2 — validate/guide `kind` + the cross-stack coupling signal — was **deferred to WO-5/M-D** post-review: folder-glob `["**"]` detectors make coupling uncomputable until file-identity lands.)*
   - **FOLLOW-ON MILESTONE — M-D, first-class, separate — cross-stack implement coordination (items 3–4):** attach the unit's `files_to_touch` + `depends_on` siblings + the shared-contract artifact to the **implement** prompt; adopt **"coupled cluster = one unit in one context"** (don't split contract-coupled work into mutually-blind dispatches — regrounded on Styre's *own* contract-drift evidence, not a vendor's multi-agent claim); attach the **dep-graph blast-radius** before dispatch (blocked on rung-3 import-inference); **implicit-contract + no integration test → human gate at design**; a >context-budget cluster bubbles to the human checkpoint. **This modifies the closed S1–S10 control-loop catalog** → it needs its own brainstorm/spec + `control-loop.md` revision + independent review before implementation. (Work order **Milestone M-D**.)

This holds the substrate's invariants **with two seams explicitly reconciled** rather than waved through (the implement-allowlist re-expression under identity, item 1; the pre-PR-vs-MERGE gate, item 6) — see §12.

---

## 10. The OSS ↔ commercial-plane seam

T1–T3, the research, and the independent review draw the line:

- **OSS owns:** deterministic detection (the `LangDef` registry), the hardened command pipeline (M-A), file-identity classification + gates/triggers + run-more-when-unsure verify, **per-verify recompute of the file→gate map**, reading CI/AGENTS.md/conventions to *draft* commands, explicit-artifact contract gates, and **surfacing verify gaps into the PR body**. The OSS terminal is **PR-ready** (single-ticket `styre run`); an unattended run always reaches it.
- **Commercial plane owns:** **environment provisioning** (toolchains, deps, containers/k8s/Terraform; Repo2Run-style auto-provisioning; snapshot-caching), **persisting the file→gate graph and keeping it live via a watcher** (the Nx-daemon optimization), multi-ticket scheduling/K-concurrency, the persistent daemon and needs-you inbox, and the **hard pre-PR interactive hold** (ask → skip/accept → then open).
- **The seam contract is a versioned artifact, and this design revises it:** the routing-primitive move (`paths` → identity) is a **`schemaVersion` bump**, handled deliberately — not a claim that the seam is unchanged.

---

## 11. Forward plan (re-scoped to the "polyglot setup is DONE" line)

The independent review drew a tight completeness line. **"Polyglot setup is DONE" = WO-1…WO-6** (security, registry, detectors, command discovery, file-identity rung-1, gates/triggers + run-more-when-unsure). Everything else is reframe, run-loop/control-loop work, or additive:

- **In-feature, remaining:** Ruby/PHP/`prepare` (M-C3); CI-reading (scoped to command extraction, pending the Q2 pilot) + AGENTS.md; file-identity rung-1 + the Bash-allowlist/test-file re-expression; gates/triggers + run-more-when-unsure + never-claim-verified-on-gap; Python/Go/JVM non-root via the identity model; **stack-grounded design/extract decomposition — feed the detected components into the planner + validate `kind` against real stacks (WO-13, §9 item 8).**
- **Additive (lands with its trigger):** rung-2 manifest-association (when over-verify is observed); `uniquifyNames` (lands *with* non-root); Maven/Gradle/`go.work` reactor parsers (reconcile with the identity model first); explicit-artifact contract gates (ship with gates/triggers).
- **Named follow-on milestone — M-D (first-class, separate): cross-stack design/implement coordination** — implement-time cross-stack context (files/siblings/contract), coupled-cluster = one context, the transitive dependency-graph blast-radius, and the implicit-contract design-time human gate. **Touches the closed S1–S10 control-loop catalog** → its own brainstorm/spec + `control-loop.md` revision + independent review (§9 item 8, work order Milestone M-D).
- **Out of this feature (reframe / other milestones):** per-verify recompute persisted-and-kept-live (commercial); the pre-PR interactive hold (commercial); OSS env-bubble (the `run`-loop terminal behavior).
- **Rejected:** `scopeColocatedRoots`; commercial env-provisioning out of OSS scope.
- **Downstream goal (original motivation):** the **bench harness** — Multi-SWE-bench corpus, Docker-per-instance, held-out oracle, synthetic tickets, blind review, report by language × difficulty.

---

## 12. Invariants — held, with two reconciled seams

This design holds the load-bearing invariants from `CLAUDE.md`, and is explicit where a change touches one:

- **Ground truth over self-report.** Verify verdicts come from exit codes / gates. Agent judgment is confined to **setup-time drafting**, operator-confirmed and frozen — never at the verify gate.
- **Capability isolation.** `verifyEnv` strips LINEAR/GITHUB/ANTHROPIC keys from verify spawns; the worktree is the only writable surface. **Reconciled seam #1:** the implement Bash allowlist (which `Component.paths` scopes today) is re-expressed under identity classification, not dropped (§9.1).
- **Deterministic routing.** Classification rules are deterministic; the autonomy layer stays post-cutover.
- **Loop-not-halt, with the wired human gates.** **Reconciled seam #2:** T2 is realized as gap-surfacing + the existing post-PR MERGE gate (not a new pre-PR block), preserving the headless OSS primitive (§9.6, §10).
- **Over-verify, never under-verify** — the cardinal rule the re-think exists to protect (cost permitting — §6 T1).
- **The open-core seam is versioned** — and this design bumps `schemaVersion` deliberately for the routing-primitive change (§10/Q20), rather than claiming no change.

---

## 13. Open risks & confirm-before-build

The freeze is **stronger for naming these than for asserting closure it hasn't earned.**

**Open feasibility risks (must resolve before/while building):**
1. **T1 cost-feasibility (fulcrum).** Measure run-all on a real polyglot fixture at the frequency the coarse classifier triggers it; make the per-verify recompute + content-hash skip the prerequisite; implement the over-budget branch (defer expensive tier to the gap-surfaced merge) so the safe path is never silently disabled.
2. **The >ceiling coupled cluster.** "Never split" and "cap unit size" conflict above the context budget; the resolution is **bubble-to-human as "too big to verify atomically"** — implement that branch, don't leave it implicit.
3. **The seam-version change.** The routing-primitive move bumps `schemaVersion`; plan the migration of `schemaVersion: 2` profiles and the seam-contract revision.
4. **CI-reading pilot (Q2).** Before branding CI-reading an edge, pilot gate-command extraction over real matrix/composite/reusable workflows; if it needs as much agent judgment as Q4 implies, it may not beat AGENTS.md+conventions in OSS.
5. **Cross-stack contract drift at implement (sub-problem #4).** The implement agent is dispatched blind to the other side of a contract (§9 item 8); today the only backstop is `verify:integration` + T2 gap-surfacing, which fails silently when the repo has no integration tests (the T2 ceiling). The stack-grounded planner (WO-13) reduces *mis-decomposition*; the drift itself is addressed by **Milestone M-D**.

**Confirm-before-build (web-sourced numbers that gate decisions — verify independently before they calcify):**
- **AGENTS.md** "LF Agentic-AI-Foundation governance / ~20k repos" — gates the WO-4 AGENTS.md priority.
- **Repo2Run** venue / arXiv ID / corpus scope (86%) — gates the OSS↔commercial scope line.
- **The ~2,500-file ceiling** provenance — gates the coupled-cluster cap.
- **"Optic archived Jan 2026"** — gates choosing oasdiff as the OpenAPI gate.

All other cited numbers (STARTS 5.94%, Devin 30 min→200 ms, Postman 60%, OpenHands 38%/+22%) are **directional color, not decision-anchoring.**

---

## 14. Provenance & changelog

- **Shipped code (this branch):** M-A (F1–F4 + `--trust-agent-commands`), M-B (Python/Go/JVM detectors + SKIP set + `unrootedManifestWarnings`), M-C1 (`4c18e2d..da05dc4`: registry + engine + Invariants 1&2 + leaf `manifests.ts`). All pushed, no PR. (`uniquifyNames`/`scopeColocatedRoots` were specced in M-C2a but **never committed**.)
- **Source docs consolidated:** the four brainstorm/plan docs in the header.
- **Research provenance:** four `ce-web-researcher` sweeps; numbers tiered in §8/§13.
- **Numbering note:** "Q1–Q13/Q20" was the operator's shorthand because **Q14–Q17/Q19 fold into T1/T2/T3** (Q18 remains open — environment caching strategy).

**Changelog**
- *2026-06-30 (v1)* — initial freeze: consolidated M-A/M-B/M-C1, the rejected `scopeColocatedRoots`, the Q1–Q20 register + T1–T3, the four-area research, and the converged file-identity + gates/triggers design.
- *2026-06-30 (v2)* — revised after an independent five-reviewer code-grounded pass (fact-check / coherence / feasibility / scope / adversarial). Corrected one factual error (phantom Python `manage.py` rung); corrected the under-verify framing to the mixed-diff case; relabeled T1 to values-decided/cost-open and Q11–13 to direction-with-deferred-substrate; resolved T2 via the OSS/commercial plane-split (gap-surface + MERGE gate, not a pre-PR block); rewrote the live-graph to per-verify recompute for OSS; scoped cross-stack to explicit-artifact-only and moved transitive-graph/coupled-cluster to a control-loop milestone; relabeled "content-based" → coarse extension+manifest and demoted CI-reading to a pending-pilot command-draft source; added §13 open-risks + confirm-before-build; acknowledged the `schemaVersion` seam bump.
- *2026-06-30 (v3)* — answered sub-problem #4 (design/implement across stacks), grounded in a two-tracer code audit: the loop is multi-stack-capable (work-unit DAG, per-unit dispatch, per-component verify) but **design is stack-blind** (`profile.components` never reach the planner; `kind` is stack-agnostic free text) and **implement is context-blind** (no files/siblings/contract in the prompt). Per operator decision: pulled **stack-grounded decomposition (items 1–2) in-feature** onto the DONE line (WO-13), and named **cross-stack implement coordination (items 3–4) as a first-class follow-on, Milestone M-D** (modifies the closed S1–S10 catalog; needs its own spec + control-loop.md revision + review). Added §9 item 8, open-risk #5, and the WO-13/M-D work-order entries.

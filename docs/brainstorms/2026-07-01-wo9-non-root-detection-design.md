# WO-9: Non-root detection & naming — Design (v2, post independent review)

**Date:** 2026-07-01
**Branch:** `feat/polyglot-setup`
**Status:** design — brainstormed, independently reviewed (feasibility / adversarial / scope, all SHIP-WITH-FIXES), revised to v2
**Freezes against:** `docs/design/2026-06-30-polyglot-setup-verify-frozen-design.md` (§9 file-identity model); work order `docs/plans/2026-06-30-polyglot-freeze-work-order.md` (WO-9)

WO-9 closes the polyglot-setup DONE line for **Python + Go** non-root detection (JVM non-root moves to WO-8 — §3 D3) and ships `uniquifyNames`. Design-first because the naive approach — the `scopeColocatedRoots` folder-carve — was **rejected** (silent under-verify, stale-by-construction). The job: detect non-root modules *without* re-introducing folder-ownership.

## Review status (v2)

Three code-grounded reviewers, all **SHIP-WITH-FIXES**. Confirmed holding: the subdir emission is the *inverse* of the rejected carve; `dir` is scan-authoritative and **not** agent-authorable (absent from `DiscoverSchema`); the routing(identity)/execution(cwd) split has no double-apply; `uniquifyNames` lands without breaking `mergeComponents` name-matching. **Operator decision (v2): root+nested → emit the nested module now (close the vacuous pass), so detection is per-manifest (root + nested).** Seven review fixes folded in (§10).

## 1. Problem

Two gaps on the DONE line:

1. **Non-root Python/Go modules are undetected.** A repo with `services/api/go.mod` + `services/worker/go.mod` (no root `go.mod`) emits *no* Go component — only a `⚠ multi-module detection deferred` warning (`unrootedManifestWarnings`, `detect-components.ts:47`). And a **root `go.mod` + nested `services/x/go.mod`** is worse than undetected — it's a **vacuous pass** (see §2). These modules get no real gate.
2. **`uniquifyNames` is specced but unshipped.** The m-c2a plan (Task 1) has a sound, reviewed post-pass, retained when its sibling `scopeColocatedRoots` was rejected — with no consumer until dir-named components exist.

## 2. The key insight, and the vacuous pass it must also fix

**Not the rejected carve.** `scopeColocatedRoots` *subtractively carved* a root `["**"]` down to "top-level minus what siblings own" — stale-by-construction, under-verifying by omission. Non-root detection here is the **opposite**: **positive, manifest-backed identification** — a component exists *because a real `go.mod`/`pyproject.toml` is at that directory*, scoped by `paths:["<dir>/**"]` **AND** the kind's `extensions` (`matchesComponent = extMatches && pathGlob`). Nothing subtracted. This is exactly what Rust/Node already do.

**The root+nested vacuous pass (why per-manifest, not subdir-only).** The review showed that leaving a root+nested repo at N=1 root is a **vacuous pass** of the exact class the PHP/Ruby anchoring fixes just closed: a change to `services/x/foo.go` is *owned* by the root component (`.go ∈ ext` AND `"**"` matches), the root gate `go test ./...` runs — but **Go's module boundary stops `./...` from descending into the nested `go.mod`**, so the nested tests never execute and the gate passes green. A1 makes it worse (it checks a test *file exists* among owned files, not that it *ran*). **Owned ≠ verified.** So WO-9 emits a **dir-scoped component per manifest, root and nested** — the nested module gets its own gate in its own cwd, closing the vacuous pass with the mechanism WO-9 already builds.

## 3. Resolved decisions (operator)

| # | Decision | Chosen | Rejected / rationale |
|---|----------|--------|----------------------|
| D1 | **Emission** | **Per-manifest (root + nested), each dir-scoped.** `findManifests` yields every module manifest; `dir==""` → root component (`["**"]`, no `dir`); `dir!=""` → nested component (`["<dir>/**"]`, `dir=<dir>`). Behavior-preserving for single-module repos (walk finds only root). Makes Python/Go match Rust/Node. | *Subdir-only* (root present → N=1) — rejected because root+nested is then a vacuous pass (§2). *"Always ["**"]"* — imprecise, no per-module gate. |
| D2 | **Command cwd** | **`Component.dir?` field + `cwd = join(worktree, dir)`** at every per-component run site. Language-agnostic; also corrects the latent Rust/Node non-root cwd gap. | Language-native path flags (per-lang bespoke; breaks JVM; doesn't fix Rust/Node). / Defer (leaves non-root verify half-working). |
| D3 | **Languages** | **Python + Go.** JVM non-root → **WO-8**. Real reason: **Maven/Gradle modules are not self-contained** — a subdir `pom.xml` typically declares a `<parent>`/`<relativePath>` to an aggregator pom, and the build wrapper (`./mvnw`/`./gradlew`) lives at repo root; a subdir module often can't build standalone without the reactor. Go (`go.mod`) and Python (`pyproject.toml`) modules *are* self-contained. Fixing JVM properly = reactor/parent resolution = WO-8. | Python+Go+JVM (pulls WO-8's reactor work in early). |
| D4 | **Naming** | **Ship `uniquifyNames`** (m-c2a Task 1, verbatim). Now has real consumers. | — |

## 4. Architecture

### 4.1 `Component.dir?: string` (the module root)
- `ComponentSchema` gains `dir: z.string().optional()`. **Optional ⇒ no `schemaVersion` bump** (`parseProfile` rejects only v1/v2; v3 parses an extra optional field unchanged — verified). Absent ⇒ root component ⇒ cwd is the worktree root ⇒ **current behavior byte-for-byte preserved**.
- `ComponentDraft = Omit<Component,"extensions">` already includes `dir` once it's on `Component`.
- **Machine-channel backstop:** `dir` feeds a `cwd` join, so `runRegistry` validates it with `safeMember`/`isSafePath` (rejects `..`, absolute) and **throws** — same loud posture as the command backstop, placed after the `paths` filter (`detect-components.ts:25`). Defense-in-depth (`findManifests` only yields clean bounded relative paths).
- **`mergeComponents` carry:** add `...(s.dir !== undefined ? { dir: s.dir } : {})` — the field-by-field rebuild (`discover-schema.ts:37-46`, the *sole* such site) would else drop it. **`dir` is read from the scan (`s.dir`), never the agent proposal (`p.dir`)** — it is not in `DiscoverSchema`, so the agent cannot author it.

### 4.2 Per-component command cwd (all THREE run sites)
Replace `cwd: worktreePath` with `cwd: join(worktreePath, c.dir ?? "")` at **every per-component run**:
- **hard-gate run** (`handlers.ts:503`) — thread `dir` through the `toRun` list (`:453`, currently `{component, command}`).
- **advisory sweep run** (`:559`) — the swept component `c` is in scope; use its `dir`.
- **`verify:integration` per-component jobs** (`:631-664`, run at `:655`) — thread `c.dir` into the `jobs` list (`:630-636`). **This is introduced by WO-9**: a non-root `go test ./...` run at repo root errors (`cannot find main module`). The repo-root cwd is correct **only** for `repoCommands` (`:637-639`), which have no component/`dir` — keep those at worktree root.

### 4.3 Non-root detection (Python + Go) — per-manifest
Each detector emits **one component per module manifest** (mirroring Rust's `findManifests` branch):
- `findManifests(repoDir, <manifest>)` → for each result: `dir` = the manifest's directory (`""` for root). Emit `{ name, kind, dir (omitted if ""), paths: dir==="" ? ["**"] : ["<dir>/**"], commands, prepare }`.
- `name` = `dir==="" ? <kind> : dir.replace(/\//g,"-")`; `commands` = the lang ladder **evaluated in the module dir** (`pythonTestCommand(join(repoDir, dir))` so tox/nox/pytest-config is read per-module; Go: `go build ./...`/`go test ./...`, correct once cwd=`dir`).
- **Anchors:** Go = `go.mod` (a `go.mod` *is* a module boundary — definitive; the Go warning is fully retired since any `go.mod` is now detected). Python module anchor = `pyproject.toml` | `setup.py` (merge by dir, dedup) — **not** `requirements.txt` (too weak; see §4.6). **Root-component trigger asymmetry (by design):** the *root* Python component still fires on the existing 3-name check *including* `requirements.txt` (`python.ts:24`, unchanged), while *nested* modules require the 2-name anchor. So a root `requirements.txt` still yields a root `["**"]` component; a bare `services/x/requirements.txt` does not become a module.
- `extensions` are engine-materialized from `EXTENSIONS_BY_KIND[kind]` — `.py`/`.go` route by `ext AND dir-glob` to the owning module.
- **Behavior-preserving:** a normal single-module repo (root manifest, no nested) → `findManifests` returns one root entry → one `["**"]` component, exactly as today.

### 4.4 `uniquifyNames` engine post-pass
Land m-c2a Task 1 verbatim: `runRegistry` returns `uniquifyNames(out)`. Colliding names → `<kind>-<name>` (then `-<n>`); non-colliding untouched. Real consumers: a python `services-api` + a go `services-api`; two subdir modules sharing a leaf name. Runs **inside** `runRegistry` so the agent refines against already-qualified names (no `mergeComponents` name-match break — verified). **Do NOT** ship `scopeColocatedRoots` (rejected).

### 4.5 Rust/Node retrofit (the "for free" cwd fix)
Rust's `findManifests` non-root branch and Node's subdir members already emit dir-scoped components with **unscoped** commands (`cargo test`, `npm run build`) that today run at the **repo root** (wrong module — a confirmed latent bug). Set `dir` on those so §4.2's cwd runs them in-context.
- **Scope discipline:** *only* the `dir` cwd fix. Node's existing per-manifest-incl-root emission is untouched.
- **Known-not-closed:** `probeCommandExists` (`discover-schema.ts:53-67`) resolves `npm run <script>` against the **repo-root** `package.json`, ignoring `dir`. This pre-existing probe-cwd gap for non-root Node is **not** closed by WO-9 (which fixes execution cwd, not the agent-override probe). Noted so "runs in-context" isn't mistaken for fully closed.

### 4.6 Warning coherence (precise rule)
`unrootedManifestWarnings` must not silently drop coverage:
- **Go** warning is **retired** — every `go.mod` (root or nested) is now detected.
- **Python** warning becomes: warn for a subdir containing `requirements.txt` **but no sibling `pyproject.toml`/`setup.py`** (a dependency list that is not a detectable module) — so a `services/*/requirements.txt`-only repo is **loud, not silent**. A subdir with `pyproject.toml`/`setup.py` is detected (no warning).
- **JVM** (maven + gradle) warning **stays** — deferred to WO-8.

## 5. Data flow

```
runRegistry(repoDir, REGISTRY)
  ├─ per LangDef detect() → drafts   (per-manifest: dir==="" root ["**"], dir!="" nested ["<dir>/**"] + dir)
  ├─ Invariant-1 (command safety, throws) + NEW dir safety (throws)
  ├─ attach extensions from EXTENSIONS_BY_KIND[kind]
  └─ uniquifyNames(out)               (kind-qualify name collisions)

verify (handlers.ts)
  ├─ matchesComponent(c,f) = extMatches && paths.glob    (routing — dir NOT consulted)
  └─ runCommand(cmd, cwd: join(worktreePath, c.dir ?? ""))  (execution — dir applied; all 3 run sites)
```

`dir` affects **execution cwd only**; routing stays pure `ext AND path-glob`. The two are independently reasoned.

## 6. Boundaries (documented, not silent)

- **JVM non-root → WO-8** (not self-contained; §3 D3). Warning stays.
- **Over-ownership is over-verify (safe), acknowledged:** in root+nested, the root `["**"]` component *also* owns nested files (its gate runs vacuously over them) while the nested component gates them for real — net **over-verify**, not under-verify. Likewise two nested modules where `services/a/**` is a prefix of `services/a/b/**`: a file in `b` is owned by both (`Bun.Glob` `**` crosses separators); `b`'s gate exercises it, `a`'s runs vacuously over it. Both are the safe direction; A1 still fires per-component so a missing test is caught. §2's "each owns its subtree, nothing subtracted" is precise on the *subtraction* claim; ownership *overlaps* (over-verify) by design.
- **go.work / Maven reactor / Gradle settings / import-inference (rung 3)** → WO-8 / deferred.

## 7. Testing

- **Detection:** Python/Go subdir-only (2 modules, no root) → 2 dir-scoped components; **root+nested** (root `go.mod` + `services/x/go.mod`) → root `["**"]` + nested `services/x` component (both gated); single root module → one `["**"]`, unchanged.
- **cwd (all 3 sites):** assert the hard-gate, sweep, AND `verify:integration` runs pass `cwd = join(worktree, dir)` for a non-root component (and repo-root for a root component + `repoCommands`).
- **`mergeComponents` `dir` round-trip:** `dir` survives the agent-refine pass **whether or not** the agent mentions the component (reads `s.dir`, never `p.dir`) — the drop here would silently reintroduce the vacuous pass.
- **`uniquifyNames`:** m-c2a Task 1 cases + a real cross-kind collision (`python-services-api` / `go-services-api`).
- **Retrofit:** Rust/Node non-root components carry `dir`; their command cwd is the module.
- **Warning:** Go subdir-only **no longer warns** (detected); a `services/*/requirements.txt`-only repo **warns** (loud); JVM subdir-only **still warns**.
- **Safety:** a draft with `dir:"../evil"` **throws** the engine backstop.
- **Behavior-preservation:** the `test/setup/detect-components.test.ts` matrix passes **unchanged**.

## 8. Open risks for the plan

1. **`verify:integration` blast radius:** threading `dir` at `:655` touches a shared run site — the plan must keep `repoCommands` at repo-root and only per-component jobs at `dir`.
2. **Python multi-anchor merge:** `pyproject.toml` ∪ `setup.py` per dir must dedup (a module with both → one component).
3. **`findManifests` maxDepth=3:** a module at depth >3 (`a/b/c/d/go.mod`) is silently missed — bounded by the existing walk; acceptable, but the plan should state it.

## 9. Out of scope (explicit) & work-order sync

Out: reactor/workspace parsing (WO-8); JVM non-root (WO-8); import-inference (rung 3); converting Rust/Node to a different trigger; the WO-6 sweep bound; any control-loop change.

**Work-order sync (required in the same change):** split WO-9's "Python/Go/JVM non-root" bullet → **Python/Go non-root via WO-9 (this), JVM non-root → WO-8**. The polyglot-setup **DONE line** is closed by WO-9's Python/Go non-root + WO-13; **JVM non-root folds into WO-8** (the reactor milestone) — i.e. DONE does not block on JVM non-root. (Reflects the operator-signed-off D3; the work order is the contract of record and must not drift.)

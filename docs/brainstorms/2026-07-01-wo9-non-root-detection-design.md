# WO-9: Non-root detection & naming — Design

**Date:** 2026-07-01
**Branch:** `feat/polyglot-setup`
**Status:** design (brainstormed, pre-independent-review)
**Freezes against:** `docs/design/2026-06-30-polyglot-setup-verify-frozen-design.md` (§9 file-identity model); work order `docs/plans/2026-06-30-polyglot-freeze-work-order.md` (WO-9)

WO-9 is the **last item on the polyglot-setup DONE line** (WO-1…WO-6 + WO-9 non-root + WO-13). This is a design-first pass because the naive non-root approach — the `scopeColocatedRoots` folder-carve — was **rejected** by adversarial review (silent under-verify, stale-by-construction). The job here is to detect non-root modules *without* re-introducing folder-ownership.

## 1. Problem

Two gaps, both on the DONE line:

1. **Non-root Python/Go monorepos are undetected.** A repo with `services/api/go.mod` + `services/worker/go.mod` and **no root `go.mod`** emits *no* Go component — it only produces a `⚠ … multi-module detection deferred` warning (`unrootedManifestWarnings`, `detect-components.ts:47`). Same for Python subdir-only. These modules never get a verify gate.
2. **`uniquifyNames` is specced but unshipped.** The m-c2a plan (Task 1) has a sound, reviewed `uniquifyNames` engine post-pass; it was retained when its sibling `scopeColocatedRoots` was rejected. It has had **no consumer** — until dir-named non-root components exist and can collide.

## 2. The key insight (why this is not the rejected carve)

The rejected `scopeColocatedRoots` **subtractively carved** a root `["**"]` component down to "top-level entries **minus** what siblings own" — stale-by-construction (a new dir silently mis-routes) and under-verifying by omission.

Non-root detection here is the **opposite**: **positive, manifest-backed identification**. A component is emitted *because there is a real `go.mod`/`pyproject.toml` at that directory*, and it is scoped by `paths: ["<dir>/**"]` **AND** the kind's `extensions` (the WO-5 primitive `matchesComponent = extMatches && pathGlob`). Nothing is subtracted; each module owns its own subtree by identity. This is exactly what Rust/Node already do. It composes with file-identity and does **not** resurrect folder-ownership.

## 3. Resolved decisions (operator)

| # | Decision | Chosen | Rejected alternative |
|---|----------|--------|----------------------|
| D1 | **Trigger** | **Subdir-only.** Root manifest present → N=1 root (unchanged). Root manifest absent but subdir manifests present → emit per-subdir. No root/subdir overlap by construction. | "Always per-manifest incl. root" (root `["**"]` overlaps subdir components → imprecise over-verify + re-opens the carve tension). |
| D2 | **Command cwd** | **`Component.dir?` field + `cwd = join(worktree, dir)`.** Language-agnostic; plain root-detector commands run in-context; also corrects the latent Rust/Node non-root cwd gap. | Language-native path flags (`pytest services/api`, `go test ./services/api/...`) — per-lang bespoke, breaks for JVM; doesn't fix Rust/Node. / Defer scoping (leaves non-root verify half-working). |
| D3 | **Languages** | **Python + Go.** JVM non-root deferred to WO-8 (reactor-shaped: root pom/settings + root wrapper; `mvn -pl` needs the reactor). JVM warning stays. | Python+Go+JVM (takes on JVM subdir-only command-scoping fragility now = WO-8 work pulled early). |
| D4 | **Naming** | **Ship `uniquifyNames`** (m-c2a Task 1, verbatim). Now has a real consumer. | — |

## 4. Architecture

Four coordinated changes; each isolated with a well-defined interface.

### 4.1 `Component.dir?: string` (the module root)
- `ComponentSchema` gains `dir: z.string().optional()`. **Optional ⇒ no `schemaVersion` bump** (existing v3 profiles parse unchanged; same additive pattern as `prepare`). Absent/undefined ⇒ root component ⇒ cwd is the worktree root ⇒ **current behavior byte-for-byte preserved**.
- `ComponentDraft = Omit<Component,"extensions">` already includes `dir` once it's on `Component` — detectors emit it directly.
- **Machine-channel backstop:** `dir` feeds a `cwd` join, so a hostile `dir` (`..`, absolute) could escape the worktree. `runRegistry` validates `dir` with the existing Invariant-2 path check (`isSafePath`/`safeMember` from `manifests.ts`) and **throws** on failure — same loud posture as the command backstop. In practice `findManifests` only yields clean bounded relative paths, so this is defense-in-depth.
- **`mergeComponents` carry:** add `...(s.dir !== undefined ? { dir: s.dir } : {})` (the field-by-field rebuild would else drop it; mirrors the `prepare`/`extensions` carry). `dir` is scan-authoritative — the agent cannot author it (not in `DiscoverSchema`).

### 4.2 Per-component command cwd
- Verify handler: replace `cwd: worktreePath` with `cwd: join(worktreePath, c.dir ?? "")` at the **hard-gate run** (`handlers.ts:503`) and the **advisory sweep run** (`:559`). The ticket-scoped `verify:integration` run (`:655`) is repo-wide → stays worktree root.
- The `toRun` list (`handlers.ts:453`) currently carries `{component: name, command}`; extend it to carry `dir` (or the component) so the run site has the cwd. Same for the sweep loop's per-component run.

### 4.3 Non-root detection (Python + Go)
Each detector gains a branch (mirroring Rust's `findManifests` structure):
- **Root manifest present** → the current root N=1 component, unchanged.
- **Root manifest absent** → `findManifests(repoDir, <manifest>)`; per subdir manifest emit a draft:
  - `name = dir.replace(/\//g, "-")`, `kind`, **`dir`**, `paths: ["<dir>/**"]`, `prepare`, and `commands` = the lang ladder **evaluated in the module dir** (`pythonTestCommand(join(repoDir, dir))` so tox/nox/pytest-config detection reads the module; Go: `go build ./...` / `go test ./...`, correct once run with `cwd = dir`).
- **Anchors:** Go = `go.mod` (a `go.mod` *is* a module boundary — definitive). Python = `pyproject.toml` | `setup.py` — **not** `requirements.txt` alone (too weak; it appears in many non-module subdirs and would over-emit).
- `extensions` are materialized by the engine from `EXTENSIONS_BY_KIND[kind]` as today — so `.py`/`.go` in a subdir route by `ext AND dir-glob` to exactly that module.

### 4.4 `uniquifyNames` engine post-pass
- Land m-c2a Task 1 verbatim: `runRegistry` returns `uniquifyNames(out)`. Colliding names → `<kind>-<name>` (then `-<n>`); non-colliding untouched (behavior-preserving for single-stack repos). Real consumers now exist: a python `services-api` + a go `services-api`; two subdir modules sharing a leaf directory name.
- **Do NOT** ship `scopeColocatedRoots` (m-c2a Task 2) — rejected, do not resurrect.

### 4.5 Rust/Node retrofit (the "for free" cwd fix)
- Rust's `findManifests` non-root branch and Node's subdir members already emit dir-scoped components with unscoped commands (`cargo test`, `npm run build`) that today run at the **repo root** (wrong module). Set `dir` on those so §4.2's cwd makes their commands run in-context.
- **Scope discipline:** this is *only* the `dir` cwd fix. Node's existing "per-manifest incl. root" emission (root `frontend` + subdir members) is untouched interim (B2) — WO-9 does **not** convert Node/Rust to the subdir-only trigger; D1 governs Python/Go only.

### 4.6 Warning coherence
`unrootedManifestWarnings` / `TARGETED_LANG_MANIFESTS` drop **python + go** (now detected, not warned) and **keep jvm-maven + jvm-gradle** (still deferred to WO-8). A subdir-only JVM repo still surfaces the loud note.

## 5. Data flow

```
detectComponents(repoDir)
  └─ runRegistry(repoDir, REGISTRY)
       ├─ for each LangDef: detect() → ComponentDraft[]   (root N=1 OR per-subdir non-root drafts w/ dir)
       ├─ Invariant-1 (command safety, throws) + NEW: dir safety (throws)
       ├─ attach extensions from EXTENSIONS_BY_KIND[kind]
       └─ uniquifyNames(out)                              (kind-qualify name collisions)

verify:check (handlers.ts)
  ├─ matchesComponent(c, f) = extMatches(c,f) && c.paths.some(glob)   (unchanged — dir does NOT affect routing)
  └─ run command with cwd = join(worktreePath, c.dir ?? "")            (NEW — dir affects EXECUTION only)
```

`dir` affects **command execution cwd only**; file→component routing stays pure `ext AND path-glob` (WO-5). This separation keeps routing and execution independently reasoned.

## 6. Boundaries (documented, not silent)

- **JVM non-root → WO-8.** Reactor-shaped (root pom/settings + root wrapper). Warning stays until then.
- **Root manifest + nested manifests** (e.g. root `go.mod` + a nested `go.mod`; a Maven reactor root pom + module poms) → **stays N=1 root** (D1). The nested module's files are **owned** by the root component (`ext AND "**"`), so there is **no silent unowned file**; but the root gate (`go test ./...`, `mvn test`) may not deeply exercise the nested module — an **imprecision** refined by WO-8's reactor/workspace parse. Same class as the existing "root reactor = N=1 over-verify" posture; **not** a new silent-under-verify (a gate runs and the file is owned).
- **go.work / Maven reactor / Gradle settings parsing** → WO-8.
- **Import-inference (rung 3)** → deferred (freeze §9.1).
- **Python `requirements.txt`-only subdirs** are intentionally **not** emitted as modules (weak signal).

## 7. Testing

- **Detection:** Python subdir-only fixture (`services/a/pyproject.toml` + `services/b/pyproject.toml`, no root) → two components with correct `dir`/`paths`/`name`/ladder; Go subdir-only → per-subdir; **root-manifest present → N=1 unchanged** (the subdir walk does not fire).
- **cwd:** a verify test asserting a non-root component's command runs with `cwd = join(worktree, dir)` (assert the cwd passed to `runCommand`, or a fixture whose command only passes in-dir).
- **`uniquifyNames`:** the m-c2a Task 1 cases + a real cross-kind collision (python `services-api` + go `services-api` → `python-services-api` / `go-services-api`).
- **Retrofit:** Rust/Node non-root components now carry `dir`; their command cwd is the module.
- **Warning:** Python/Go subdir-only **no longer warns** (now detected); JVM subdir-only **still warns**.
- **Safety:** a draft with `dir: "../evil"` **throws** the engine backstop.
- **Behavior-preservation:** the `test/setup/detect-components.test.ts` matrix passes **unchanged** (its repos are root/single-stack).

## 8. Open risks / questions for the independent review

1. **Root+nested under-coverage (§6):** is "owned by root, gate runs but may not deeply cover" an acceptable WO-8-deferred posture, or does the frozen "ground-truth" value demand more here now? (Parallels the PHP/Ruby test-discovery fix — but there the fix was cheap; here the fix is reactor parsing = WO-8.)
2. **`dir` cwd vs relative commands:** does any existing command assume repo-root cwd in a way that breaks when a non-root component sets `dir`? (Retrofit blast radius on Rust/Node.)
3. **Python anchor set** (`pyproject.toml`|`setup.py`, excluding `requirements.txt`) — right cut, or does it miss real-world Python module shapes?
4. **`findManifests` maxDepth=3** — deep monorepos (`services/team/api/go.mod` at depth 3) are covered; deeper is silently missed (bounded by the existing walk). Acceptable?
5. **Interaction with `verify:integration`** staying repo-root while gates run per-`dir` — coherent, or a surprise?

## 9. Out of scope (explicit)

Reactor/workspace parsing (WO-8); JVM non-root; import-inference (rung 3); converting Rust/Node to the subdir-only trigger; the WO-6 sweep cost bound; any control-loop change.

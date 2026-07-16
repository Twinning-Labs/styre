# checks:dispatch — admit legitimate `styre_checks/` support files

**Status:** design, pending independent review.
**Scope:** styre core. **Type:** bug fix / reliability (checks:dispatch scope-guard robustness).
**Branch:** `fix/checks-support-files` (off `main`).
**Complements:** ENG-296 (`resolveAuthoredTestPath`), ENG-297 (`styre_checks/` path pin), ENG-300 (`styre_scratch/` sweep).

## 1. Problem

In the 2026-07-16 variance measurement (5× SMOKE=2 on the same merged commit), astropy blocked at `checks:dispatch` in run 1 with:

```
out-of-scope files (declare them as part of the change, or delete them if they are
throwaway/debug files): astropy/modeling/tests/styre_checks/__init__.py
```

The checks agent correctly wrote its RED-first test into the `styre_checks/` subdirectory (per the ENG-297 pin) **and** created the `__init__.py` package marker that Python needs for a test in a *new* subdirectory to be importable/discoverable. That marker is a **legitimate, necessary** file — but the commit scope guard (`checksScopeFor`, `src/dispatch/commit-scope.ts`) only admits a new file when it is (a) declared in the agent's sidecar (`checksAuthored[].test_file` ∪ `new_files`) or (b) a canonically-named test (`{ident}_ac<id>_test.*`, ENG-296). The `__init__.py` is neither → out-of-scope → reject → retry → the agent recreates the same correct marker → escalate.

This is a **deterministic styre bug** (a correct file rejected), and one of astropy's two remaining `checks:dispatch` failure modes (the other — a missing sidecar — is separate agent-compliance, out of scope here). It is the highest-confidence, lowest-risk item the variance data surfaced.

### Why not the obvious alternatives

- **Per-stack marker allowlist** (`__init__.py`, `conftest.py` for Python; `mod.rs` for Rust; …) — rejected: **incomplete by construction.** Python surely needs markers, Rust likely does, and several stacks have analogous needs; enumerating them means getting the known ones right and silently re-rejecting whatever the next stack needs. That is the exact "keep missing cases" trap generating this flakiness.
- **Prompt-only** ("declare your `__init__.py` in `new_files`") — the guard already admits declared files, so this *could* work, but the variance data shows agent output-compliance is precisely the flaky part (run 5's missing sidecar is the same class). A narrow deterministic code-side admission is the robust backstop; the prompt is reinforcement, not the guarantee.

## 2. The rule (deterministic, language-agnostic)

A brand-new file `P` that is **not** otherwise admitted (not declared, not a canonical `{ident}_ac<id>_test.*` name) is admitted as a **check support file** iff **all** hold:

1. **`P` sits in a `styre_checks/` directory** — the name of `P`'s immediate parent directory is exactly `styre_checks`. *This is the load-bearing safety bound:* auto-admission happens only inside the dedicated, freshly-created checks folder — never into an existing source/package directory where a stray `__init__.py` could alter real behavior.
2. **That directory holds a canonical check this dispatch is adding** — some `{ident}_ac<id>_test.*` (for an in-scope `acId`) appears in the dispatch's new-file set, in `P`'s exact directory. So the folder genuinely hosts a real check right now, not an empty loophole.
3. **`P`'s extension matches that co-located check's extension** — comparing the final dot-segment of the basename (`__init__.py` → `py` == `…_test.py` → `py`; `mod.rs` → `rs` == `…_test.rs` → `rs`; multi-dot `…_test.tests.ts` → `ts`). Blocks `.md`/`.txt`/`.log` clutter, **with zero per-stack knowledge** — a support file for a `.py` test is a `.py` file, whatever the stack.
4. **Within a per-directory cap of 2** non-canonical same-extension support files, with a deterministic tie-break (lexicographic sort of the candidates in that directory; admit the first 2). Covers Python's realistic maximum (`__init__.py` + `conftest.py`) while stopping the `styre_checks/` folder from becoming a new scratch loophole.

**Non-code fixtures** (a `.json`/`.csv` data file a check needs) do not match (3) → they keep flowing through the existing **declared-`new_files`** path, which the guard already admits. Nothing legitimate is lost; this clause only *auto-admits* the same-language structural files the agent routinely forgets to declare.

## 3. Design — components

### 3.1 `src/dispatch/check-path.ts` (pure path module) — new helper

```
isCheckSupportFile(path, addedNewPaths, ident, acIds): boolean
```
Implements rules 1–4 over normalized forward-slash paths. Needs two tiny local helpers: `dirname(p)` (everything before the last `/`) and a final-extension extractor (last dot-segment of the basename). Reuses the existing `basename` and `isCanonicalCheckPath`. Pure, no I/O — matches the file's existing character and is unit-testable in isolation.

### 3.2 `src/dispatch/commit-scope.ts` — widen the predicate, add the clause

The scope predicate is currently `(path, isNew) => boolean` and cannot see sibling files. Widen the `CommitScope` inner predicate type to `(path, isNew, newPaths) => boolean`, where `newPaths` is every brand-new file this dispatch created.

**TypeScript structural typing makes this cheap:** a function taking only `(path, isNew)` is assignable where `(path, isNew, newPaths)` is expected, so `implementScope`, `planScope`, and `docScope` compile **unchanged** — only `checksScopeFor` reads the third argument. Its predicate gains one clause:

```
(path, isNew, newPaths) =>
  !isNew
  || declared.has(normPath(path))
  || isCanonicalCheckPath(normPath(path), ident, acIds)
  || isCheckSupportFile(normPath(path), newPaths.map(normPath), ident, acIds)   // NEW
```

The unparseable-sidecar deferral (`if (!parsed.ok) return () => true`) and every existing clause are untouched.

### 3.3 `src/dispatch/run-dispatch.ts` — the one shared call site

Where offenders are computed, precompute the new-file list and pass it:

```
const inScope = spec.commitScope(result.stdout);
const newPaths = judged.filter((e) => e.isNew).map((e) => e.path);
const offenders = judged.filter((e) => !inScope(e.path, e.isNew, newPaths));
```

Both checks call sites (the main register and `reauthorCheckWrong`) funnel through `runAgentDispatch`, so both get the support-file admission for free.

## 4. What does NOT change

- The guard's reject-not-drop semantics; a non-`styre_checks/` undeclared new file is still rejected-and-retried.
- Canonical-name admission (ENG-296), the `styre_scratch/` sweep (ENG-300), the RED-first / identity / coverage post-commit checks.
- `implementScope` / `planScope` / `docScope` (compile unchanged; behavior unchanged).
- No prompt change is *required* (a `checks.md` nudge to still prefer declaring markers is optional and out of scope here).

## 5. Alternatives considered

- **Per-stack marker allowlist** — rejected (incomplete by construction; §1).
- **Prompt-only declaration** — rejected as the primary mechanism (agent-compliance is the flaky part; §1). Fine as reinforcement.
- **Admit *anything* inside `styre_checks/`** — rejected (too loose; a spree of arbitrary files would wave through). The extension + co-location + cap bounds are what make it safe.
- **Co-locate anywhere (drop the `styre_checks/`-dir requirement)** — rejected: admitting an `__init__.py` next to a flat canonical test in an *existing* package dir could alter that package's real behavior. Requiring the dedicated `styre_checks/` dir bounds the blast radius.

## 6. Testing

- **`isCheckSupportFile` (pure unit):** admits `…/styre_checks/__init__.py` when a `…/styre_checks/ENG-1_ac1_test.py` sibling is in the added set; admits a second support file (`conftest.py`); rejects when no canonical sibling in that dir; rejects a `.md`/`.txt` sibling (extension); rejects an `__init__.py` that is NOT in a `styre_checks/` dir; rejects the 3rd same-ext file (cap, with a stable tie-break); multi-dot extension (`.tests.ts`) matches.
- **`checksScopeFor` integration:** the astropy shape — undeclared `styre_checks/__init__.py` + canonical `styre_checks/…_test.py` in the added set → both in scope (no rejection); a same-dir `.py` file beyond the cap still rejected; a `.py` file in a non-`styre_checks/` dir still rejected. Unparseable-sidecar still defers.
- **`run-dispatch` wiring:** a checks dispatch that adds the canonical test **and** its `__init__.py` reaches `clean-success` and commits both — this rejects today, so it is genuinely RED-first.

## 7. Scope

**IN:** `check-path.ts` (`isCheckSupportFile` + helpers), `commit-scope.ts` (widen predicate + clause), `run-dispatch.ts` (pass `newPaths`), and the tests above.
**OUT:** the missing-sidecar failure mode (agent-compliance / loop-not-halt — separate), any prompt change, any per-stack marker knowledge, non-checks scopes.

## 8. Acceptance criteria

- [ ] `isCheckSupportFile` admits a co-located, same-extension, in-`styre_checks/` support file within the cap; rejects everything failing any of rules 1–4.
- [ ] `checksScopeFor` admits the astropy `__init__.py` shape without rejection; the guard's reject-not-drop behavior is unchanged for non-support files.
- [ ] `run-dispatch` threads the new-file set to the scope predicate; both checks call sites benefit; other scopes compile and behave unchanged.
- [ ] Full suite green; tsc + biome clean.

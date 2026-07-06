# Provision re-point — make styre's worktree the source-under-test in a ready env (completes the conda reuse)

**Status:** Design (brainstorm output). Completes the shipped **python env reuse** feature (PR #51) — the piece that makes reuse actually *fire* on astropy. Pending independent review, then plan.
**Date:** 2026-07-06
**Scope:** at **provision**, when a ready pre-built env (deps present) has the package installed but pointing at a location *other than* styre's worktree, **re-point the editable install at the worktree** (`pip install -e . --force-reinstall --no-deps`) — reusing the heavy deps while making the worktree the source-under-test. Then the shipped verify-time reuse probe passes and pytest tests the agent's actual code, fast. **Does NOT** change the verify-side reuse code (already shipped), nor build pre-warm / env-selection (still deferred).
**Builds on:**
- `docs/brainstorms/2026-07-06-python-env-reuse-prewarm-design.md` (the reuse probe + resolver — shipped).
- The existing provision source-under-test check + editable remediation (`src/dispatch/provision.ts` `SOURCE_CHECK_SCRIPT`; `src/dispatch/handlers.ts:394-485`).
- `CLAUDE.md` invariants: ground truth over self-report; capability isolation; single transactional writer; loop-not-halt.

---

## 0. Why the shipped reuse is inert on astropy

The reuse probe (verify-time) only fires when `import <pkg>` resolves to a file **under styre's worktree**. But `worktreeFor` (handlers.ts:97-109) gives two *different* directories:
- `repoPath = project.target_repo` → in the bench, **`/testbed`** — the original checkout. The conda `testbed` env's editable astropy points **here** (`pip show astropy → Editable project location: /testbed`).
- `worktreePath = join(worktreeRoot, ticket.ident)` → a **separate** per-ticket git worktree, where the agent edits code.

So `import astropy` → `/testbed` (repoPath), the probe's `absCwd` is the *worktree* (≠ `/testbed`), the probe **correctly declines** (reusing `/testbed`'s bytes would test the *original* code, not the agent's fix), reuse never fires → falls back to `tox` → times out. The reuse machinery is *correct but inert*: the pre-built env is linked to the original checkout, not styre's worktree.

---

## 1. The fix — re-point the editable at the worktree (reuse the deps)

At provision, run `<interp> -m pip install -e . --force-reinstall --no-deps` with `cwd = worktreePath`. This:
- **Reuses the heavy pre-built deps** (`--no-deps` skips numpy/scipy/pytest/… — the slow part that was timing out; they're already in the conda env).
- **Re-points the package's editable source at the worktree** (`--force-reinstall` overrides the existing `/testbed` link; `-e .` in the worktree registers the worktree as the source; for C-extension packages like astropy it also (re)builds the extensions in-place — a compile step, *not* a dep install).

After this, `import <pkg>` resolves under the worktree → the shipped verify probe passes → pytest runs the agent's code, fast. **The re-point command already exists** (`handlers.ts:464`, used today as post-editable-install remediation) — this design generalizes *when* it fires.

---

## 2. The tri-state env probe (distinguish "elsewhere" from "absent")

Today `SOURCE_CHECK_SCRIPT` (provision.ts:82) exits `0` (under worktree) or `1` (everything else — it conflates "importable but elsewhere" with "not importable"). The re-point must tell these apart. **Extend the script to a tri-state exit:**
- **`0` — WORKTREE:** `import <pkg>` resolves under the worktree → already correct, nothing to do.
- **`2` — ELSEWHERE:** resolves, but not under the worktree (`origin` exists, `relative_to(cwd)` raises) → **deps present, re-point candidate.**
- **`3` — ABSENT:** `spec is None or spec.origin is None` → no ready env; do **not** re-point (deps missing, `--no-deps` would leave it broken).

Backward-compatible: every existing consumer treats `exitCode !== 0` as "not ready" (the shipped `pythonEnvReady` and the existing provision check both do), and `2`/`3` are still non-zero — no behavior change for them. Only the new re-point logic reads `2` vs `3`.

---

## 3. The re-point action

For a python component, after `prepare`, probe the active env (§2). If **ELSEWHERE (2)** and the worktree is **editable-installable** (has `pyproject.toml`/`setup.py`/`setup.cfg` — the existing `pythonPrepare` manifest test), run:

```
<interp> -m pip install -e . --force-reinstall --no-deps      # cwd = worktreePath, under PROVISION_TIMEOUT_MS (15 min)
```

then **re-probe** → expect **WORKTREE (0)**. Budget: this runs at **provision (15-min)**, not verify (10-min) — deliberately, because for a C-extension package it recompiles extensions (minutes), which must not eat the verify budget. Pure-Python packages: near-instant.

---

## 4. When it fires (gating, precisely)

Re-point **only** when all hold:
1. component `kind === "python"`, **and**
2. the worktree is editable-installable (manifest present), **and**
3. the probe returns **ELSEWHERE (2)** — a ready env whose source is not the worktree.

Skip (no-op) when: **WORKTREE (0)** (already correct); **ABSENT (3)** (no ready env → leave to the detected `prepare` / `tox` building its own env / the deferred pre-warm); not editable-installable; or non-python. This is broader than today's gate (which fires only for `isEditablePythonPrepare` components) — a `tox`/`nox` component now qualifies, which is exactly the astropy case.

---

## 5. Idempotency, durability, failure routing

- **Probe-before-apply** (CL-3): the probe *is* the idempotency guard — a re-run that finds WORKTREE(0) does nothing. `pip install -e . --force-reinstall` is itself idempotent (re-registers the same editable). Safe under crash-resume of the durable provision step.
- **Best-effort, loop-not-halt:** if the re-point *fails* (e.g. the agent's change doesn't build), do **not** escalate. Log a provision signal (`detail: { check: "repoint", ... }`) and **fall through** — the env stays un-re-pointed, the verify probe declines, and the detected harness (`tox`) runs and surfaces the real build error via the normal verify → loopback path. (A genuine build break should route to *fix-the-code loopback*, not a provision halt.) This mirrors the existing remediation's spirit but replaces its *escalate-on-failure* with *fall-through*, because unlike the editable-prepare case, here the detected harness is a valid fallback.
- **Single writer / single ticket:** re-pointing mutates the active env's editable link (from `/testbed` to the worktree). OSS `styre run` is single-ticket and the bench env is per-container, so there is no competing consumer of that env. Document the assumption.

---

## 6. Interaction with the shipped reuse (no verify change)

This is provision-only. It makes the *already-shipped* verify-time probe (`pythonEnvReady` → `reuseAwareTestCommand`) pass, so reuse fires with no change to `reuse.ts` or the verify handlers. Layering: **provision re-point** fixes the *source location*; the shipped **`--collect-only` guard** still independently catches *missing test plugins* (if the ready env lacks a suite plugin, collect-only fails → verify falls back to the harness). The two guards compose.

---

## 7. Alternatives considered

- **Re-point the existing env (chosen).** Cheapest correct option: reuses deps, builds only the package, one command that already exists in the codebase.
- **PYTHONPATH-prepend the worktree.** Rejected: doesn't build C extensions (astropy's `.so` wouldn't exist in the worktree), and sys.path ordering is fragile (the probe itself does `del sys.path[0]`).
- **Clone the conda env, re-point the clone.** Rejected: conda env cloning is heavy/slow; needless for an ephemeral, styre-owned, single-ticket env.
- **Work in-place at `/testbed`.** Rejected: violates the capability-isolation worktree model (the worktree is the only writable surface).

---

## 8. Invariants held

- **Ground truth over self-report:** the re-point decision is a deterministic probe (exit code); correctness is re-verified by the re-probe; tests still come from the real runner against provably-worktree bytes.
- **Capability isolation:** the re-point runs runner-owned under `verifyEnv`/provision env (creds scrubbed), `-e .` bounded to the worktree, `importName` `isValidImportName`-validated before interpolation — same hardening as the existing check.
- **Loop-not-halt:** re-point failure falls through to the detected harness, never halts.
- **Single transactional writer:** provision remains a runner-executed step; any signal is runner-persisted.

---

## 9. Open questions / risks

1. **C-extension recompile cost (astropy).** `pip install -e . --force-reinstall --no-deps` rebuilds astropy's C extensions from the worktree. Estimate minutes — fits the 15-min provision budget, but the plan should measure (via the bench) and, if too slow, consider reusing the original build artifacts (out of scope for v1).
2. **`--force-reinstall` without `--no-build-isolation`.** With build isolation, pip creates a fresh build env and may pull build-time deps (setuptools/cython/extension-helpers) from the network. In an offline bench this could fail. The plan must decide whether to add `--no-build-isolation` (reuse the env's build tools) — likely yes for the astropy image, but it's a real decision, not an assumption.
3. **Re-point failure vs. a real build break.** Falling through to `tox` means a broken worktree gets a (fast) tox *build* failure → loopback. Confirm tox fails fast on a build error (it should, at the isolated-build step) rather than timing out.
4. **Env mutation persistence.** Re-pointing leaves the env pointing at the worktree for the rest of the run. Correct for single-ticket; document that multi-ticket (commercial plane) would need per-ticket env isolation.
5. **Does the re-point need to re-run after a source-only loopback?** Provision runs once; after a loopback that only edits source, the editable link still points at the worktree (unchanged), so `import` stays correct — the agent's new edits are live via the editable install. Confirm no re-provision needed (expected: none).

---

## 10. Evidence

- **The gap:** `worktreeFor` (handlers.ts:107) → `worktreePath = join(worktreeRoot, ticket.ident)` ≠ `repoPath = project.target_repo` (`/testbed`). astropy conda editable → `/testbed` (design §6 of the reuse doc).
- **The re-point command already exists:** `handlers.ts:464` `${interp} -m pip install -e . --force-reinstall --no-deps`, today gated behind `isEditablePythonInstall` (`:399-403`) — never reached by a `tox` component.
- **The probe to extend:** `SOURCE_CHECK_SCRIPT` (provision.ts:82-101) — currently `exit 0/1`; make it `0/2/3`.
- **Editable-installable test:** `pythonPrepare` (python.ts:27-29) checks `pyproject.toml`/`setup.py`/`setup.cfg`.

## 11. Changelog
- *2026-07-06 (v1)* — spec for the provision-side re-point that makes the shipped conda reuse actually fire on astropy: distinguish ELSEWHERE vs ABSENT in the source-check (tri-state exit), and generalize the existing `pip install -e . --force-reinstall --no-deps` remediation to fire for any python component with a ready-but-elsewhere env (not just editable-prepare ones), best-effort with fall-through. Named the two load-bearing decisions for the plan: C-ext recompile cost and `--no-build-isolation`.
